#!/usr/bin/env node
/**
 * Наблюдение: еженедельные срезы для ступени «Против конкурентов» и перепроверка через 90 дней
 * для аудита.
 *
 * Простым языком. Человек купил сравнение с конкурентами. В день отправки отчёта его сайт и его
 * конкуренты записываются в таблицу вместе с баллами. Дальше этот скрипт раз в день смотрит,
 * у кого подошёл срок: через 7, 14, 21 и 28 дней для еженедельных срезов, через 90 дней для
 * аудита. Кому подошёл, тому перемеряем сайт и конкурентов тем же кодом, что на странице проверки,
 * и шлём письмо: было, стало, разница. Отправленное помечается в таблице, поэтому одно и то же
 * письмо не уйдёт дважды, сколько раз скрипт ни запусти.
 *
 * До 15.09.2026 эти срезы обещались в письмах и на страницах, а в коде их не было вовсе. Теперь
 * есть, и обещать их снова можно только после того, как этот файл отработал на живой записи.
 *
 *   node watch-run.mjs                 разобрать таблицу и отправить, что подошло
 *   node watch-run.mjs --dry-run       показать, кому и что ушло бы, ничего не слать
 *   node watch-run.mjs --register --kind=rivals-weekly --email=... --url=... --lang=ru --rivals=a.com,b.com
 *                                      записать новую строку (это же делает очередь после отчёта за 29)
 *   node watch-run.mjs --register --kind=audit-90 --email=... --url=... --lang=en
 *   node watch-run.mjs --register --kind=fix-30 --email=... --url=... --lang=ru      после выдачи пакета Fix
 *
 * Память это лист «Наблюдение» той же таблицы, что у цепочки писем. Столбцы:
 *   A дата записи · B вид · C почта · D язык · E сайт · F конкуренты через запятую
 *   G баллы при записи (JSON: сайт и конкуренты) · H отправленные срезы (1,2,3,4)
 *   I отписан (да) · J последний балл (JSON)
 *
 * Env: GOOGLE_USER, GOOGLE_APP_PASSWORD, SHEETS_SA_EMAIL, SHEETS_SA_KEY, FREE_CHECKS_SHEET_ID,
 *      KIT_DOWNLOAD_SECRET (для ссылки отписки), TG_TOKEN, TG_CHAT_ID (необязательно).
 */
import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import { VISIBILITY_DEFAULTS, checkVisibility } from '@operstack/audit';
import { appendRows, ensureSheet, readRows, updateCells } from './sheets.mjs';
import { buildWatchLetter } from './watch-letter.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (p, d = '') => (args.find((a) => a.startsWith(p)) || `${p}${d}`).slice(p.length);
const DRY = has('--dry-run');
const env = (k, d = '') => String(process.env[k] ?? d).trim();
const log = (...a) => console.log(...a);

export const SHEET = 'Наблюдение';
export const HEADER = ['Дата', 'Вид', 'Почта', 'Язык', 'Сайт', 'Конкуренты', 'Баллы при записи', 'Отправлено', 'Отписан', 'Последний балл'];

/** Дни, через которые уходит каждый срез, по виду записи. */
export const SCHEDULE = { 'rivals-weekly': [7, 14, 21, 28], 'audit-90': [90], 'fix-30': [30] };

const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return String(u); } };

async function telegram(text) {
  const token = env('TG_TOKEN'); const chat = env('TG_CHAT_ID');
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(8000),
    });
  } catch (e) { console.error('telegram:', e.message); }
}

/** Отписка: та же подпись, что у сайта, поэтому ссылка сходится с его страницей. */
function unsubUrlFor(email, lang) {
  const secret = env('KIT_DOWNLOAD_SECRET');
  if (!secret) return null;
  const body = Buffer.from(String(email).trim().toLowerCase(), 'utf8').toString('base64url');
  const site = lang === 'ru' ? 'https://oper-stack.ru' : 'https://oper-stack.com';
  return `${site}/api/unsubscribe/?t=${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/** Один замер: балл или null, если сайт не ответил. Тем же кодом и с теми же настройками, что страница. */
async function measure(url, lang) {
  try {
    const v = await checkVisibility(url, { ...VISIBILITY_DEFAULTS, lang });
    return v.ok && Number.isFinite(v.score) ? v.score : null;
  } catch { return null; }
}

/**
 * Какой срез подошёл по сроку и ещё не отправлен.
 *
 * Не догоняем пропущенное: если скрипт не работал две недели, уйдёт срез этой недели, а не два
 * подряд. Человек ждал одно письмо в неделю, а не пачку.
 */
export function dueSnapshot(kind, registeredAt, sent, now = Date.now()) {
  const days = SCHEDULE[kind];
  if (!days) return null;
  const started = Date.parse(`${String(registeredAt).replace(' ', 'T')}Z`);
  if (!Number.isFinite(started)) return null;
  const passed = (now - started) / 86400000;
  const sentSet = new Set(String(sent || '').split(',').map((s) => s.trim()).filter(Boolean));
  let due = null;
  days.forEach((d, i) => { if (passed >= d && !sentSet.has(String(i + 1))) due = i + 1; });
  return due;
}

/** Записать новую строку наблюдения. Баллы при записи это JSON вида { site: 46, rivals: { 'a.com': 51 } }. */
export async function register({ kind, email, url, lang = 'en', rivals = [], baseline = null }) {
  if (!SCHEDULE[kind]) throw new Error(`неизвестный вид наблюдения: ${kind}`);
  if (!email || !url) throw new Error('нужны почта и адрес сайта');
  await ensureSheet(SHEET, HEADER);
  await appendRows(SHEET, [[stamp(), kind, String(email).trim().toLowerCase(), lang === 'ru' ? 'ru' : 'en', url, rivals.join(','), baseline ? JSON.stringify(baseline) : '', '', '', '']]);
}

async function send({ to, subject, text, html, lang, unsubUrl }) {
  const user = env('GOOGLE_USER'); const pass = env('GOOGLE_APP_PASSWORD');
  if (!user || !pass) throw new Error('нужны GOOGLE_USER и GOOGLE_APP_PASSWORD');
  const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
  try {
    await transport.sendMail({
      from: `OperStack <${user}>`, to, subject, text, html,
      headers: unsubUrl ? { 'List-Unsubscribe': `<${unsubUrl}>` } : {},
    });
  } finally { transport.close(); }
}

async function main() {
  if (has('--register')) {
    const rivals = val('--rivals=').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 3);
    await register({ kind: val('--kind=', 'rivals-weekly'), email: val('--email='), url: val('--url='), lang: val('--lang=', 'en'), rivals });
    log('записано');
    return;
  }
  // Запись из задания в GitHub одной строкой JSON: ключи таблицы есть только там, и без этого
  // пути весь круг «записали, подошёл срок, отправили» нельзя проверить на живом.
  const reg = env('WATCH_REGISTER');
  if (reg) {
    const j = JSON.parse(reg);
    await register({ kind: j.kind || 'rivals-weekly', email: j.email, url: j.url, lang: j.lang || 'en', rivals: (j.rivals || []).slice(0, 3), baseline: j.baseline || null });
    if (j.registeredAt) {
      // Проверочная запись с датой в прошлом, чтобы срок подошёл сразу: только для приёмки.
      const rows = await readRows(`${SHEET}!A2:A`);
      await updateCells([{ range: `${SHEET}!A${rows.length + 1}`, values: [[String(j.registeredAt)]] }]);
    }
    log(`записано из задания: ${j.email} ${j.url}`);
    return;
  }

  await ensureSheet(SHEET, HEADER);
  const rows = await readRows(`${SHEET}!A2:J`);
  if (!rows.length) { log('в наблюдении никого'); return; }
  log(`записей в наблюдении: ${rows.length}`);

  let sentCount = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNo = i + 2;
    const [registeredAt, kind, email, langRaw, url, rivalsRaw, baselineRaw, sent, unsub] = r;
    const lang = String(langRaw || '').trim().toLowerCase() === 'ru' ? 'ru' : 'en';
    if (String(unsub || '').trim().toLowerCase() === 'да') continue;
    const due = dueSnapshot(kind, registeredAt, sent);
    if (!due) continue;

    let baseline = {};
    try { baseline = JSON.parse(baselineRaw || '{}'); } catch { baseline = {}; }
    const rivals = String(rivalsRaw || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 3);

    log(`${email}: срез ${due} (${kind}) по ${url}${rivals.length ? ` и ${rivals.join(', ')}` : ''}`);
    if (DRY) { log(`  [сухой прогон] письмо не отправлено`); continue; }

    const siteNow = await measure(url, lang);
    const rivalRows = [];
    for (const rv of rivals) rivalRows.push({ host: hostOf(rv), was: baseline.rivals?.[hostOf(rv)] ?? null, now: await measure(rv, lang) });

    const letter = buildWatchLetter({
      lang, kind, week: due,
      site: { host: hostOf(url), was: baseline.site ?? null, now: siteNow },
      rivals: rivalRows,
      unsubUrl: unsubUrlFor(email, lang),
    });

    try {
      await send({ to: email, ...letter, lang, unsubUrl: unsubUrlFor(email, lang) });
      const have = String(sent || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!have.includes(String(due))) have.push(String(due));
      const last = { site: siteNow, rivals: Object.fromEntries(rivalRows.map((x) => [x.host, x.now])), at: stamp() };
      await updateCells([
        { range: `${SHEET}!H${rowNo}`, values: [[have.sort().join(',')]] },
        { range: `${SHEET}!J${rowNo}`, values: [[JSON.stringify(last)]] },
      ]);
      sentCount += 1;
      log(`  отправлено: «${letter.subject}»`);
    } catch (e) {
      log(`  НЕ отправлено: ${e.message}`);
      await telegram(`⚠️ Срез ${due} для ${email} (${url}) не ушёл: ${e.message}`);
    }
  }
  log(`готово: отправлено ${sentCount}`);
  if (sentCount) await telegram(`📈 Наблюдение: отправлено ${sentCount} срез(ов)`);
}

const RUN_AS_PROGRAM = process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname;
if (RUN_AS_PROGRAM) main().catch(async (e) => { console.error(e.message); await telegram(`⚠️ Наблюдение не отработало: ${e.message}`); process.exit(1); });
