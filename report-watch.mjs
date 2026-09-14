#!/usr/bin/env node
/**
 * Очередь отчётов за 9 долларов, сделанная из почтового ящика.
 *
 * Простым языком: покупатель оплатил, ввёл адрес своего сайта в форме на oper-stack.com, и сайт
 * прислал нам служебное письмо с этой заявкой. Здесь мы такие письма читаем и по каждому делаем
 * отчёт. Никакой базы данных и никакого хранилища чужих адресов: заявка живёт ровно до того
 * момента, как отчёт ушёл, а письмо помечается ярлыком, чтобы не сделать одно и то же дважды.
 *
 * Технически: IMAP по тому же ящику, что читает notify-mail.mjs. Тема письма подписана общим
 * секретом (KIT_DOWNLOAD_SECRET), поэтому подделать заявку со стороны нельзя: мы не станем гонять
 * бесплатные аудиты и слать PDF на произвольные адреса по чужой просьбе.
 *
 *   node report-watch.mjs             прочитать очередь и выполнить
 *   node report-watch.mjs --dry-run   показать очередь, ничего не делать и не помечать
 *   node report-watch.mjs --list      только показать, что в очереди
 *   node report-watch.mjs --tidy      только убрать отработанные заявки из «Входящих»
 *
 * Env: GOOGLE_USER, GOOGLE_APP_PASSWORD, KIT_DOWNLOAD_SECRET, TG_TOKEN, TG_CHAT_ID.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { button, emailShell, note, p as par } from './email-shell.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIST = args.includes('--list');
/** Только убрать отработанные заявки из «Входящих», ничего не выполняя. */
const TIDY = args.includes('--tidy');

const env = (k, d = '') => (process.env[k] || d).trim();
const USER = env('GOOGLE_USER');
const PASS = env('GOOGLE_APP_PASSWORD');
const SECRET = env('KIT_DOWNLOAD_SECRET');
const LABEL = env('REPORT_LABEL', 'ReportDone');
/** Ярлык «одну попытку уже потратили». Он и есть счётчик: второго провала заявка не переживёт. */
const RETRY_LABEL = env('REPORT_RETRY_LABEL', 'ReportRetry');
const LOOKBACK_DAYS = Number(env('REPORT_LOOKBACK_DAYS', '3'));
/** Больше этого за один прогон не берём: работа идёт в GitHub Actions с ограничением по времени. */
const MAX_PER_RUN = Number(env('REPORT_MAX_PER_RUN', '3'));

const b64urlDecode = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

/** Первая строка тела: REPORT-RUN v1 <payload> <подпись>. Подпись считается по самому payload.
 *  В теме её больше нет намеренно: сто символов base64 в списке писем это мусор на экране
 *  у того, кто открывает ящик. */
function parseJob(body) {
  // Почта режет длинные строки: в quoted-printable перенос выглядит как «=» и конец строки.
  // Без склейки подпись рвётся пополам и не сходится ни с чем.
  const flat = String(body || '').replace(/=\r?\n/g, '').replace(/\r\n/g, '\n');
  const m = /(REPORT|PROSPECT)-RUN v1 ([A-Za-z0-9_-]+)\s+([A-Za-z0-9_-]+)/.exec(flat);
  if (!m) return null;
  const [, kindRaw, payload, sig] = m;
  const kind = kindRaw === 'PROSPECT' ? 'prospect' : 'report';
  const expected = createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { bad: 'подпись не сходится' };
  let data;
  try { data = JSON.parse(b64urlDecode(payload)); } catch { return { bad: 'payload не разбирается' }; }

  /**
   * Заявка со списком сайтов: её ставит страница /prospects/ после оплаты курса.
   *
   * Эти письма приходили в ящик с самого начала, и уборка их бережно не трогала, а читать их
   * было некому: очередь искала только «REPORT-RUN v1». Покупатель вставлял список, видел
   * «готово» и не получал ничего.
   */
  if (kind === 'prospect') {
    const sites = Array.isArray(data.sites)
      ? data.sites.map((x) => ({ url: String(x.url || ''), name: String(x.name || '') })).filter((x) => x.url)
      : [];
    if (!data.email || !sites.length) return { bad: 'в заявке на список нет почты или сайтов' };
    return { kind, email: String(data.email), lang: data.lang === 'ru' ? 'ru' : 'en', sites, brand: data.brand || null };
  }

  if (!data.url || !data.email) return { bad: 'в заявке нет адреса сайта или почты' };
  const rivals = Array.isArray(data.rivals) ? data.rivals.map(String).filter(Boolean).slice(0, 3) : [];
  // free это выдача за почту после бесплатной проверки: пять страниц и без списка задач.
  const tier = ['free', '29', '9'].includes(String(data.tier)) ? String(data.tier) : '9';
  // Балл со страницы проверки, если заявка его принесла: письмо должно называть ту же цифру,
  // которую человек только что видел своими глазами.
  const score = Number.isFinite(Number(data.score)) ? Number(data.score) : null;
  // Результат проверки со страницы едет целиком и передаётся отчёту как есть: мерить второй раз
  // нельзя, два честных замера живого сайта расходятся на пару баллов.
  const visibility = data.visibility && typeof data.visibility === 'object' ? data.visibility : null;
  return { kind, url: String(data.url), email: String(data.email), lang: data.lang === 'ru' ? 'ru' : 'en', tier, rivals, score, visibility };
}

export { parseJob as __parseJobForTests };

async function telegram(text) {
  const token = env('TG_TOKEN'); const chat = env('TG_CHAT_ID');
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) { console.error('telegram:', e.message); }
}

/**
 * Письмо человеку, когда отчёт сделать не удалось.
 *
 * Простым языком: он оставил почту и ждёт. Если мы промолчим, для него это выглядит так, что
 * бесплатный продукт просто не работает, и второй раз он не придёт. Поэтому вместо тишины
 * уходит короткое письмо: что случилось, почему так бывает и что делать дальше.
 *
 * Никаких сроков и обещаний перезвонить здесь нет и быть не должно: мы не знаем, когда до
 * этого дойдут руки. Обещаем только то, что уже правда: проверка на странице бесплатна и
 * открыта, а написать нам можно.
 *
 * Уходит один раз, после второй неудачной попытки, чтобы человек не получил два письма об
 * одной поломке.
 */
async function sendFailureNote({ email, url, lang, kind = 'report', sites = [] }) {
  const user = env('GOOGLE_USER'); const pass = env('GOOGLE_APP_PASSWORD');
  if (!user || !pass) return false;
  let host = url;
  try { host = new URL(url).host; } catch { /* оставляем как есть */ }
  const ru = lang === 'ru';
  const site = ru ? 'https://oper-stack.ru' : 'https://oper-stack.com';
  // У заявки со списком нет одного адреса, и письмо про «отчёт по undefined» было бы хуже
  // молчания. Здесь своя формулировка и своё обещание: список человек уже оплатил.
  const t = kind === 'prospect'
    ? (ru
      ? {
          subject: `Не получилось собрать таблицу по ${sites.length} сайтам`,
          heading: ['Не получилось собрать таблицу', `${sites.length} сайтов`],
          lead: `Вы прислали список из <strong>${sites.length}</strong> сайтов, и мы обещали таблицу. Её не будет, и честнее сказать об этом, чем молчать.`,
          why: 'Сборщик не смог дочитать список до конца. Чаще всего так бывает, когда часть сайтов отвечает слишком долго или закрыта для обращений извне.',
          what: 'Напишите нам на info@oper-stack.com, и мы прогоним список руками. Присылать его заново не нужно, он у нас есть.',
          again: 'Оплаченное никуда не девается: таблицу вы получите.',
          cta: 'Написать нам',
        }
      : {
          subject: `We could not build the table for your ${sites.length} sites`,
          heading: ['We could not build the table for', `${sites.length} sites`],
          lead: `You sent a list of <strong>${sites.length}</strong> sites and we promised a table. There will be no table, and saying so is better than silence.`,
          why: 'Our collector could not read the list through. Usually that means some of those sites answer too slowly or are closed to outside requests.',
          what: 'Write to info@oper-stack.com and we will run the list by hand. No need to send it again, we have it.',
          again: 'What you paid for is not lost: you will get the table.',
          cta: 'Write to us',
        })
    : ru
    ? {
        subject: `Не получилось собрать отчёт по ${host}`,
        heading: ['Не получилось собрать отчёт', host],
        lead: `Вы оставили почту, чтобы получить отчёт по <strong>${host}</strong>, и мы обещали письмо. Отчёта не будет, и честнее сказать об этом, чем молчать.`,
        why: 'Сборщику не удалось открыть ни одной страницы вашего сайта. Чаще всего так бывает, когда сайт отвечает слишком долго, отдаёт очень тяжёлые страницы или закрыт для обращений извне. Проверка на странице читает одну страницу и поэтому прошла, а отчёт читает пять и до них не добрался.',
        what: 'Напишите нам на info@oper-stack.com, и мы прогоним его руками. Адрес сайта указывать не нужно, он у нас есть.',
        again: 'Проверка остаётся бесплатной и открытой, её можно прогнать ещё раз в любой момент.',
        cta: 'Открыть проверку',
      }
    : {
        subject: `We could not build the report for ${host}`,
        heading: ['We could not build the report for', host],
        lead: `You left your email for a report on <strong>${host}</strong>, and we promised one. There will be no report, and saying so is better than silence.`,
        why: 'Our collector could not open a single page of your site. Usually that means the site answers too slowly, serves very heavy pages, or is closed to outside requests. The check on the page reads one page and went through; the report reads five and never got to them.',
        what: 'Write to info@oper-stack.com and we will run it by hand. No need to give the address again, we have it.',
        again: 'The check itself stays free and open, and you can run it again whenever you like.',
        cta: 'Open the check',
      };
  const html = emailShell({
    site: ru ? 'ru' : 'en',
    preheader: t.subject,
    heading: t.heading,
    blocks: [par(t.lead), par(t.why), par(`<strong>${t.what}</strong>`),
      button(kind === 'prospect' ? 'mailto:info@oper-stack.com' : `${site}/ai-visibility/`, `${t.cta} →`, 'quiet'), note(t.again)],
  });
  const text = [t.lead.replace(/<[^>]+>/g, ''), '', t.why, '', t.what, '', t.again, '',
    kind === 'prospect' ? 'info@oper-stack.com' : `${site}/ai-visibility/`].join('\n');
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true, pool: false,
    auth: { user, pass }, connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000,
  });
  try {
    await transport.sendMail({ from: `OperStack <${user}>`, to: email, subject: t.subject, text, html });
    return true;
  } catch (e) {
    console.error(`  письмо о неудаче не ушло: ${e.message}`);
    return false;
  } finally { transport.close(); }
}

/** Список сайтов: тот же приём, свой скрипт. Он сам соберёт таблицу и отправит два файла. */
function runProspect({ email, lang, sites, brand }) {
  const job = { email, lang, sites, ...(brand ? { brand } : {}) };
  const r = spawnSync(process.execPath, [resolve(ROOT, 'prospect-run.mjs'), `--json=${JSON.stringify(job)}`], {
    cwd: ROOT, encoding: 'utf8', timeout: 20 * 60 * 1000, env: process.env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  return r.status === 0;
}

/** Сам прогон отдан отдельному процессу: падение одной заявки не уносит очередь. */
function runReport({ url, email, lang, rivals, tier, score, visibility }) {
  const args = [resolve(ROOT, 'report-run.mjs'), `--url=${url}`, `--email=${email}`, `--lang=${lang}`, `--tier=${tier}`];
  if (score !== null && score !== undefined) args.push(`--score=${score}`);
  // Объект едет одной строкой в base64url: так он переживает и разбор аргументов, и кавычки.
  if (visibility) args.push(`--visibility=${Buffer.from(JSON.stringify(visibility)).toString('base64url')}`);
  // Конкуренты есть только у ступени за 29. На бесплатной их не бывает по определению.
  if (tier !== 'free' && rivals && rivals.length) args.push(`--rivals=${rivals.join(',')}`);
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT, encoding: 'utf8', timeout: 20 * 60 * 1000, env: process.env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  return r.status === 0;
}

async function main() {
  if (!USER || !PASS) throw new Error('нужны GOOGLE_USER и GOOGLE_APP_PASSWORD');
  if (!SECRET) throw new Error('нужен KIT_DOWNLOAD_SECRET: без него заявку не отличить от подделки');

  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: USER, pass: PASS }, logger: false });
  await client.connect();
  const queue = [];
  let retried = new Set();
  try {
    const boxes = await client.list();
    if (!boxes.some((b) => b.path === LABEL) && !DRY && !LIST) await client.mailboxCreate(LABEL);
    if (!boxes.some((b) => b.path === RETRY_LABEL) && !DRY && !LIST) await client.mailboxCreate(RETRY_LABEL);

    // Ищем во «Всей почте», а не во «Входящих»: заявку шлёт наш же сайт с нашего же адреса, и
    // Gmail такое письмо может положить только в отправленные. Во «Всей почте» оно есть всегда.
    const allMail = boxes.find((b) => b.specialUse === '\\All')?.path || 'INBOX';
    const lock = await client.getMailboxLock(allMail);
    try {
      // Сначала собираем, потом действуем: команда во время открытого потока fetch вешает соединение.
      const uids = await client.search({ gmailRaw: `newer_than:${LOOKBACK_DAYS}d ("REPORT-RUN v1" OR "PROSPECT-RUN v1") -label:${LABEL}` }, { uid: true });
      // Кому одна попытка уже досталась. Список снимаем до фетча: команда во время открытого
      // потока вешает соединение.
      retried = new Set((await client.search({ gmailRaw: `newer_than:${LOOKBACK_DAYS}d ("REPORT-RUN v1" OR "PROSPECT-RUN v1") label:${RETRY_LABEL}` }, { uid: true })) || []);
      if (uids && uids.length) {
        for await (const msg of client.fetch(uids, { uid: true, envelope: true, source: true }, { uid: true })) {
          queue.push({ uid: msg.uid, subject: msg.envelope?.subject || '', body: msg.source ? msg.source.toString('utf8') : '' });
        }
      }
    } finally { lock.release(); }

    if (!queue.length && !TIDY) { console.log(`очередь пуста (искали в ${allMail})`); return; }
    if (queue.length) console.log(`в очереди: ${queue.length}`);

    let done = 0; let failed = 0; let refused = 0;
    /**
     * Список из двадцати сайтов это до двадцати минут работы, а всему заданию в GitHub отведено
     * сорок пять. Два списка подряд не влезают, и задание убили бы посередине. Берём один за
     * прогон: очередь просыпается каждые пять минут, второй уедет следующим.
     */
    let prospectsDone = 0;
    for (const item of TIDY ? [] : queue.slice(0, MAX_PER_RUN)) {
      const job = parseJob(item.body);
      if (!job) { console.log(`  пропуск uid ${item.uid}: подписи в письме нет`); continue; }
      if (job.bad) {
        console.error(`  заявка uid ${item.uid} отклонена: ${job.bad}`);
        // Осмотр очереди не должен будить человека: сообщение уходит только при настоящем прогоне.
        if (!DRY && !LIST) {
          await telegram(`⚠️ Заявка на отчёт отклонена: ${job.bad}. Письмо в ящике, uid ${item.uid}.`);
          await client.messageCopy(String(item.uid), LABEL, { uid: true }).catch(() => {});
        }
        // Отклонённая подделка это система, которая сработала, а не поломка. Красный прогон на
        // каждое чужое письмо приучил бы не смотреть на красное вообще.
        refused++; continue;
      }
      if (job.kind === 'prospect' && prospectsDone >= 1) {
        console.log(`  список для ${job.email} ждёт следующего прогона: за один берём один`);
        continue;
      }
      console.log(job.kind === 'prospect'
        ? `  список · сайтов ${job.sites.length} → ${job.email} (${job.lang})`
        : `  ${job.tier === 'free' ? 'бесплатно' : `${job.tier} USD`} · ${job.url}${job.rivals.length ? ` против ${job.rivals.join(', ')}` : ''} → ${job.email} (${job.lang})`);
      if (LIST || DRY) continue;

      if (job.kind === 'prospect') prospectsDone++;
      const ok = job.kind === 'prospect' ? runProspect(job) : runReport(job);
      // В «Всей почте» перенос равносилен навешиванию ярлыка: он и нужен, чтобы поиск с -label
      // больше эту заявку не возвращал.
      const close = async () => {
        await client.messageFlagsAdd(String(item.uid), ['\\Seen'], { uid: true }).catch(() => {});
        await client.messageCopy(String(item.uid), LABEL, { uid: true }).catch(() => {});
      };
      if (ok) { done++; await close(); continue; }
      failed++;
      // Почта отказывает и по временным причинам: Gmail отвечает 451 «попробуйте позже», и
      // заявка, закрытая на таком ответе, оставляет покупателя без отчёта навсегда. Даём ровно
      // одну вторую попытку через пять минут, на следующем прогоне очереди. Ровно одну, иначе
      // на сломанной заявке человек получит пять писем об одной ошибке.
      if (retried.has(item.uid)) {
        // Молчание здесь и есть самая дорогая поломка: человек оставил почту и решит, что
        // бесплатный продукт не работает. Говорим ему правду, а Максиму пишем в Telegram.
        const told = await sendFailureNote(job);
        const what = job.kind === 'prospect' ? `Таблица по ${job.sites.length} сайтам` : `Отчёт по ${job.url}`;
        await telegram(`❌ ${what} для ${job.email} не ушла(ёл) и со второй попытки. ${told ? 'Человеку написали, что не вышло.' : 'СКАЗАТЬ ЧЕЛОВЕКУ НЕ УДАЛОСЬ.'}`);
        await close();
      } else {
        await telegram(`⚠️ ${job.kind === 'prospect' ? `Таблица по ${job.sites.length} сайтам` : `Отчёт по ${job.url}`} для ${job.email} не ушла(ёл). Повторим через пять минут.`);
        await client.messageCopy(String(item.uid), RETRY_LABEL, { uid: true }).catch(() => {});
      }
    }

    // Убираем отработанные заявки из «Входящих». Ярлык мы уже повесили; здесь письмо уходит
    // из инбокса, чтобы служебная переписка не копилась на глазах у владельца ящика.
    if (!DRY && !LIST) try {
      const inbox = await client.getMailboxLock('INBOX');
      try {
        const done_uids = await client.search({ gmailRaw: `in:inbox ("REPORT-RUN v1" OR "PROSPECT-RUN v1") label:${LABEL}` }, { uid: true });
        if (done_uids && done_uids.length) {
          await client.messageMove(done_uids, LABEL, { uid: true });
          console.log(`убрано из входящих: ${done_uids.length}`);
        }
      } finally { inbox.release(); }
    } catch (e) { console.error(`не удалось убрать из входящих: ${e.message}`); }

    if (queue.length > MAX_PER_RUN) console.log(`осталось на следующий прогон: ${queue.length - MAX_PER_RUN}`);
    console.log(`готово: отправлено ${done}, отклонено ${refused}, ошибок ${failed}`);
    if (failed) process.exitCode = 1;
  } finally {
    await client.logout().catch(() => {});
  }
}

// Файл заодно и модуль: тест разбора заявок импортирует parseJob и не должен лезть в почту.
const RUN_AS_PROGRAM = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (RUN_AS_PROGRAM) main().catch(async (e) => {
  console.error(e.message);
  await telegram(`⚠️ Очередь отчётов не отработала: ${e.message}`);
  process.exit(1);
});
