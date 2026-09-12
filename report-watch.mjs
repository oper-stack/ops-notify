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
  const m = /REPORT-RUN v1 ([A-Za-z0-9_-]+)\s+([A-Za-z0-9_-]+)/.exec(flat);
  if (!m) return null;
  const [, payload, sig] = m;
  const expected = createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { bad: 'подпись не сходится' };
  let data;
  try { data = JSON.parse(b64urlDecode(payload)); } catch { return { bad: 'payload не разбирается' }; }
  if (!data.url || !data.email) return { bad: 'в заявке нет адреса сайта или почты' };
  const rivals = Array.isArray(data.rivals) ? data.rivals.map(String).filter(Boolean).slice(0, 3) : [];
  return { url: String(data.url), email: String(data.email), lang: data.lang === 'ru' ? 'ru' : 'en', tier: data.tier === '29' ? '29' : '9', rivals };
}

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

/** Сам прогон отдан отдельному процессу: падение одной заявки не уносит очередь. */
function runReport({ url, email, lang, rivals }) {
  const args = [resolve(ROOT, 'report-run.mjs'), `--url=${url}`, `--email=${email}`, `--lang=${lang}`];
  if (rivals && rivals.length) args.push(`--rivals=${rivals.join(',')}`);
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
  try {
    const boxes = await client.list();
    if (!boxes.some((b) => b.path === LABEL) && !DRY && !LIST) await client.mailboxCreate(LABEL);

    // Ищем во «Всей почте», а не во «Входящих»: заявку шлёт наш же сайт с нашего же адреса, и
    // Gmail такое письмо может положить только в отправленные. Во «Всей почте» оно есть всегда.
    const allMail = boxes.find((b) => b.specialUse === '\\All')?.path || 'INBOX';
    const lock = await client.getMailboxLock(allMail);
    try {
      // Сначала собираем, потом действуем: команда во время открытого потока fetch вешает соединение.
      const uids = await client.search({ gmailRaw: `newer_than:${LOOKBACK_DAYS}d "REPORT-RUN v1" -label:${LABEL}` }, { uid: true });
      if (uids && uids.length) {
        for await (const msg of client.fetch(uids, { uid: true, envelope: true, source: true }, { uid: true })) {
          queue.push({ uid: msg.uid, subject: msg.envelope?.subject || '', body: msg.source ? msg.source.toString('utf8') : '' });
        }
      }
    } finally { lock.release(); }

    if (!queue.length && !TIDY) { console.log(`очередь пуста (искали в ${allMail})`); return; }
    if (queue.length) console.log(`в очереди: ${queue.length}`);

    let done = 0; let failed = 0;
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
        failed++; continue;
      }
      console.log(`  ${job.tier} USD · ${job.url}${job.rivals.length ? ` против ${job.rivals.join(', ')}` : ''} → ${job.email} (${job.lang})`);
      if (LIST || DRY) continue;

      const ok = runReport(job);
      if (ok) done++; else failed++;
      // Помечаем в любом случае: при провале уже ушло сообщение в Telegram, и повторять
      // автоматически нельзя, иначе покупатель получит пять писем об одной ошибке.
      // В «Всей почте» перенос равносилен навешиванию ярлыка: он и нужен, чтобы поиск
      // с -label больше эту заявку не возвращал.
      await client.messageFlagsAdd(String(item.uid), ['\\Seen'], { uid: true }).catch(() => {});
      await client.messageCopy(String(item.uid), LABEL, { uid: true }).catch(() => {});
    }

    // Убираем отработанные заявки из «Входящих». Ярлык мы уже повесили; здесь письмо уходит
    // из инбокса, чтобы служебная переписка не копилась на глазах у владельца ящика.
    if (!DRY && !LIST) try {
      const inbox = await client.getMailboxLock('INBOX');
      try {
        const done_uids = await client.search({ gmailRaw: `in:inbox "REPORT-RUN v1" label:${LABEL}` }, { uid: true });
        if (done_uids && done_uids.length) {
          await client.messageMove(done_uids, LABEL, { uid: true });
          console.log(`убрано из входящих: ${done_uids.length}`);
        }
      } finally { inbox.release(); }
    } catch (e) { console.error(`не удалось убрать из входящих: ${e.message}`); }

    if (queue.length > MAX_PER_RUN) console.log(`осталось на следующий прогон: ${queue.length - MAX_PER_RUN}`);
    console.log(`готово: отправлено ${done}, ошибок ${failed}`);
    if (failed) process.exitCode = 1;
  } finally {
    await client.logout().catch(() => {});
  }
}

main().catch(async (e) => {
  console.error(e.message);
  await telegram(`⚠️ Очередь отчётов не отработала: ${e.message}`);
  process.exit(1);
});
