#!/usr/bin/env node
/**
 * Уборка служебной почты из «Входящих».
 *
 * Простым языком: пока воронку собирают и проверяют, ящик info@oper-stack.com шлёт письма сам
 * себе: отчёты на выдуманные адреса, лицензионные ключи, письма «остался один шаг». Настоящая
 * почта, за которой владелец ящика следит (Whop, Payoneer, GitHub, коды подтверждения), тонет
 * в этом потоке. Здесь такие письма уходят под отдельный ярлык, из «Входящих» пропадают, но
 * никуда не удаляются: открыл ярлык и всё на месте.
 *
 * Под уборку попадает письмо, которое пришло с нашего адреса И адресовано только нашим же
 * адресам. Настоящему покупателю письмо уходит на его почту, под это правило оно не попадает
 * никогда. Русский сайт кладёт копию каждого своего письма в info@, но копия это второй адрес
 * рядом с адресом покупателя, а не единственный, поэтому она тоже остаётся на месте.
 *
 * Плюс узкий список квитанций от служб: письмо пришло со стороны, но сообщает о том, что мы
 * сделали сами, и решения не требует. Сейчас это «Successfully published» от npm. Письма про
 * вход, токены и безопасность от того же отправителя остаются во «Входящих».
 *
 * Чего правило не трогает, кроме этого:
 *   - заявки очередей (в теле «REPORT-RUN v1» или «PROSPECT-RUN v1»): их читают report-watch.mjs
 *     и prospect-watch, и убрать их отсюда значило бы оставить покупателя без отчёта;
 *   - уведомления о заказах с русского сайта («Заказ OS-…»): это настоящие деньги, они приходят
 *     с нашего адреса на наш же и внешне неотличимы от проверочных;
 *   - письма про счета, оплату и коды подтверждения, кто бы их ни прислал;
 *   - письма моложе GRACE минут: если заявку всё же не узнали, у очереди остаётся время.
 *
 * Адрес с плюсом (info+test@oper-stack.com) считается проверочным всегда и уезжает без разбора:
 * туда ничего настоящего не приходит. Им и надо пользоваться в проверках.
 *
 *   node tidy-tests.mjs             убрать
 *   node tidy-tests.mjs --dry-run   показать, что убралось бы, и ничего не трогать
 *
 * Env: GOOGLE_USER, GOOGLE_APP_PASSWORD, TEST_LABEL, TIDY_GRACE_MINUTES.
 */
import { ImapFlow } from 'imapflow';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const env = (k, d = '') => (process.env[k] || d).trim();

const USER = env('GOOGLE_USER');
const PASS = env('GOOGLE_APP_PASSWORD');
const LABEL = env('TEST_LABEL', 'Служебные');
/** Запас времени очередям: они просыпаются раз в пять минут. */
const GRACE_MIN = Number(env('TIDY_GRACE_MINUTES', '20'));

/** Наши адреса. Письмо уезжает под ярлык, только если ВСЕ получатели отсюда. */
const OWN = ['info@oper-stack.com', 'billing@oper-stack.com', 'accounts@oper-stack.com', 'support@oper-stack.com'];

/**
 * Темы, которые нельзя убирать никогда. Каждая строка это настоящее дело, а не проверка:
 * заявка очереди отчётов, заявка очереди прогонов по списку сайтов, заказ с русского сайта.
 * Список расширять при каждом новом письме, которое сайт шлёт нам самим.
 */
const KEEP_SUBJECT = [/^Report request:/i, /^Prospect run:/i, /^Заказ OS-/i];
/** Подписи очередей в теле: второй заслон на случай, если тема письма однажды изменится. */
const KEEP_BODY = /REPORT-RUN v1|PROSPECT-RUN v1/;
/**
 * Квитанции служб: письмо приходит со стороны, но сообщает о том, что мы сделали сами, и
 * решения не требует. Список узкий и по отправителю: у npm это «Successfully published», а
 * письма про вход, токены и безопасность от того же отправителя остаются во «Входящих».
 * Расширять по одной строке и только там, где письмо ничего не спрашивает.
 */
const RECEIPTS = [
  { from: 'npmjs.com', subject: /^Successfully published /i },
];

/** Деньги и подтверждения остаются во «Входящих», кто бы их ни прислал. */
const KEEP_MONEY = /счёт|счет|оплат|платёж|платеж|invoice|payment|payout|receipt|refund|chargeback|verification|verify|код подтверждения/i;

/** info+test@oper-stack.com и info@oper-stack.com это один ящик: для сравнения метка отбрасывается. */
const bare = (addr) => String(addr || '').toLowerCase().replace(/\+[^@]*@/, '@');
const isOwn = (addr) => OWN.includes(bare(addr));
const isTagged = (addr) => /\+[^@]*@/.test(String(addr || '')) && isOwn(addr);

async function main() {
  if (!USER || !PASS) throw new Error('нужны GOOGLE_USER и GOOGLE_APP_PASSWORD');
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: USER, pass: PASS }, logger: false });
  await client.connect();
  try {
    const boxes = await client.list();
    if (!boxes.some((b) => b.path === LABEL)) {
      if (DRY) console.log(`ярлыка «${LABEL}» ещё нет, был бы создан`);
      else { await client.mailboxCreate(LABEL); console.log(`ярлык создан: ${LABEL}`); }
    }

    const lock = await client.getMailboxLock('INBOX');
    const move = [];
    try {
      const fromUs = [...OWN.map((a) => `from:${a}`), ...RECEIPTS.map((r) => `from:${r.from}`)].join(' OR ');
      const candidates = (await client.search({ gmailRaw: `in:inbox (${fromUs})` }, { uid: true })) || [];
      if (!candidates.length) { console.log('во «Входящих» служебных писем нет'); return; }
      // Заявки очередей вытаскиваем отдельным поиском по телу: так их не потерять, даже если
      // тема письма однажды изменится.
      const queued = new Set((await client.search({ gmailRaw: `in:inbox (${KEEP_BODY.source.split('|').map((s) => `"${s}"`).join(' OR ')})` }, { uid: true })) || []);

      const cutoff = Date.now() - GRACE_MIN * 60 * 1000;
      // Сначала собираем, потом действуем: команда во время открытого потока fetch вешает соединение.
      for await (const msg of client.fetch(candidates, { uid: true, envelope: true, internalDate: true }, { uid: true })) {
        const subject = msg.envelope?.subject || '(без темы)';
        const from = (msg.envelope?.from?.[0]?.address || '').toLowerCase();
        // Квитанция службы: отправитель чужой, поэтому правило «все получатели наши» к ней не
        // применяется. Зато тема должна совпасть точно, иначе письмо остаётся на месте.
        if (RECEIPTS.some((r) => from.includes(r.from) && r.subject.test(subject))) {
          if (!KEEP_MONEY.test(subject)) move.push({ uid: msg.uid, subject });
          continue;
        }
        // Дальше идёт правило «с нашего адреса на наш же». Отправитель обязан быть нашим:
        // без этой строки письма служб, попавшие в поиск ради квитанций, уезжали бы под ярлык
        // по одному признаку «адресовано нам», включая коды входа и уведомления о токенах.
        if (!isOwn(from)) continue;
        const to = [...(msg.envelope?.to || []), ...(msg.envelope?.cc || [])].map((t) => t.address || '');
        if (!to.length || !to.every(isOwn)) continue;
        // Адрес с меткой это всегда проверка: ни темы разбирать, ни выдерживать запас не нужно.
        // Запас существует ради очередей, а на info+test@ заявки не приходят по определению.
        //
        // Достаточно одного адреса с меткой среди наших: письма о выдаче товара уходят покупателю
        // и в копию на accounts@, и если проверочный адрес стоит рядом с нашим, это всё равно
        // проверка. Настоящий покупатель рядом с info+test@ не окажется никогда.
        if (!to.some(isTagged)) {
          if (new Date(msg.internalDate).getTime() > cutoff) continue;
          if (queued.has(msg.uid)) continue;
          if (KEEP_SUBJECT.some((re) => re.test(subject)) || KEEP_MONEY.test(subject)) continue;
        }
        move.push({ uid: msg.uid, subject });
      }
    } finally { lock.release(); }

    for (const m of move) console.log(`  ${DRY ? 'убралось бы' : 'убрано'}: ${m.subject}`);
    if (move.length && !DRY) {
      const inbox = await client.getMailboxLock('INBOX');
      try {
        const uids = move.map((m) => m.uid);
        await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true }).catch(() => {});
        await client.messageMove(uids, LABEL, { uid: true });
      } finally { inbox.release(); }
    }
    console.log(`готово: под ярлык «${LABEL}» ${DRY ? 'уехало бы' : 'уехало'} ${move.length}`);
  } finally { await client.logout(); }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
