#!/usr/bin/env node
/**
 * Цепочка писем после бесплатной проверки.
 *
 * Простым языком. Человек оставил почту на oper-stack.com и получил список находок и PDF.
 * Дальше мы пишем ему ещё несколько раз по расписанию: через сутки, через три дня, через
 * неделю, через две и через месяц. Этот скрипт смотрит в таблицу, считает, сколько дней
 * прошло, и отправляет то письмо, которое пора.
 *
 * Что он НЕ делает:
 *   не пишет тем, кто отписался;
 *   не отправляет одно и то же письмо дважды, даже если запустить его десять раз подряд;
 *   не отправляет письмо про цену 19, пока скрытый тариф не заведён: обещать цену,
 *   которой нет, нельзя, и человек в этом случае просто получает следующее письмо;
 *   не догоняет пропущенное: если человек появился в таблице неделю назад, а скрипт не
 *   работал, ему уйдёт письмо этой недели, а не все четыре подряд.
 *
 * Память это сама таблица: колонка «Письма» хранит номера уже отправленных, колонка
 * «Отписан» ставится страницей отписки. Отдельной базы нет намеренно.
 *
 *   node sequence-run.mjs              разобрать очередь и отправить
 *   node sequence-run.mjs --dry-run    показать, кому и что ушло бы, ничего не отправлять
 *   node sequence-run.mjs --limit=5    не больше пяти писем за прогон
 *
 * Env: GOOGLE_USER, GOOGLE_APP_PASSWORD, KIT_DOWNLOAD_SECRET,
 *      SHEETS_SA_EMAIL, SHEETS_SA_KEY, FREE_CHECKS_SHEET_ID,
 *      WHOP_CHECKOUT_RIVALS_19 (необязательно; нет значения, значит письмо 2 не уходит),
 *      TG_TOKEN, TG_CHAT_ID (необязательно).
 */
import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import { letter2, letter3, letter4Agency, letter4Owner, letter5, letter6 } from './sequence.mjs';
import * as RU from './sequence.ru.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) || '--limit=200').slice(8)) || 200;
const env = (k, d = '') => String(process.env[k] ?? d).trim();
const log = (...a) => console.log(...a);

const SHEET = 'С почтой';
const SITE = 'https://oper-stack.com';

/* ------------------------------ таблица ------------------------------ */

import { sheetsToken } from './sheets.mjs';

async function readRows() {
  const token = await sheetsToken();
  const id = env('FREE_CHECKS_SHEET_ID');
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`${SHEET}!A2:N`)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`не прочитал таблицу: ${res.status}`);
  return ((await res.json()).values ?? []).map((r, i) => ({
    row: i + 2,
    date: String(r[0] ?? ''),
    lang: String(r[1] ?? '').trim().toLowerCase() === 'ru' ? 'ru' : 'en',
    host: String(r[2] ?? ''),
    score: String(r[3] ?? ''),
    email: String(r[5] ?? '').trim().toLowerCase(),
    letters: String(r[12] ?? ''),
    unsubscribed: String(r[13] ?? '').trim().toLowerCase() === 'да',
  }));
}

/** Отмечаем номер письма во ВСЕХ строках этого адреса: человек мог проверить пять сайтов. */
async function markSent(rows, n) {
  const token = await sheetsToken();
  const id = env('FREE_CHECKS_SHEET_ID');
  const data = rows.map((r) => {
    const have = r.letters.split(',').map((s) => s.trim()).filter(Boolean);
    if (!have.includes(String(n))) have.push(String(n));
    return { range: `${SHEET}!M${r.row}`, values: [[have.sort().join(',')]] };
  });
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
  if (!res.ok) throw new Error(`не отметил отправку: ${res.status}`);
}

/* ------------------------------ почта ------------------------------ */

async function send({ to, subject, text, html, lang = 'en' }) {
  const user = env('GOOGLE_USER');
  const pass = env('GOOGLE_APP_PASSWORD');
  if (!user || !pass) throw new Error('нет GOOGLE_USER или GOOGLE_APP_PASSWORD');
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true, pool: false,
    auth: { user, pass }, connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000,
  });
  try {
    await transport.sendMail({
      from: `OperStack <${user}>`, to, subject, text, html,
      // Почтовые программы показывают свою кнопку «отписаться», и это снижает жалобы на спам.
      // Заголовка List-Unsubscribe-Post здесь намеренно нет: он обещает отписку в одно нажатие,
      // а почтовая служба шлёт на неё POST без заголовка Origin, и встроенная защита Astro такой
      // запрос отклоняет с кодом 403 (проверено на живом 14.09.2026). Обещать то, что вернёт
      // ошибку, хуже, чем не обещать: кнопка и так работает, просто открывает страницу.
      list: { unsubscribe: { url: unsubUrl(to, lang), comment: 'Unsubscribe' } },
    });
  } finally { transport.close(); }
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

/* ------------------------------ ссылки ------------------------------ */

const secret = () => {
  const s = env('KIT_DOWNLOAD_SECRET');
  if (!s) throw new Error('нет KIT_DOWNLOAD_SECRET: без него не выписать ссылки');
  return s;
};

function unsubUrl(email, lang = 'en') {
  const body = Buffer.from(email.trim().toLowerCase(), 'utf8').toString('base64url');
  // Отписка живёт на том же сайте, что и письмо: подпись общая, а уводить русского
  // человека на английскую страницу незачем.
  const site = lang === 'ru' ? 'https://oper-stack.ru' : SITE;
  return `${site}/api/unsubscribe/?t=${body}.${createHmac('sha256', secret()).update(body).digest('base64url')}`;
}

/** Ссылка на срочную цену. Живёт четыре часа: письмо уходит за четыре часа до конца суток. */
function offerUrl(email, lang = 'en') {
  const claims = { email: email.trim().toLowerCase(), exp: Math.floor(Date.now() / 1000) + 4 * 3600 };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const site = lang === 'ru' ? 'https://oper-stack.ru' : SITE;
  return `${site}/api/offer/?t=${body}.${createHmac('sha256', secret()).update(body).digest('base64url')}`;
}

/* ------------------------------ расписание ------------------------------ */

/**
 * Какое письмо пора. Возвращаем номер или null.
 *
 * Окна намеренно широкие: скрипт может не запуститься вовремя, и человек не должен из-за
 * этого остаться без письма. Но пропущенное не догоняем: одно письмо за прогон.
 */
function due(hours, sent, offerLive) {
  const has = (n) => sent.includes(String(n));
  if (offerLive && hours >= 20 && hours < 48 && !has(2)) return 2;
  if (hours >= 72 && hours < 144 && !has(3)) return 3;
  if (hours >= 168 && hours < 288 && !has(4)) return 4;
  if (hours >= 336 && hours < 600 && !has(5)) return 5;
  if (hours >= 720 && !has(6)) return 6;
  return null;
}

function build(n, person) {
  const unsub = unsubUrl(person.email, person.lang);
  const { host, score, sites, lang } = person;
  // Русскому человеку пишем по-русски. Цены, ссылки и сравнение с агентством в русских
  // письмах свои: рынок другой, и рубли в переводе английского письма выглядели бы враньём.
  if (lang === 'ru') {
    if (n === 2) return RU.letter2({ host, score, offerUrl: offerUrl(person.email, 'ru'), unsubUrl: unsub });
    if (n === 3) return RU.letter3({ host, unsubUrl: unsub });
    if (n === 4) return sites > 1 ? RU.letter4Agency({ sites, unsubUrl: unsub }) : RU.letter4Owner({ host, score, unsubUrl: unsub });
    if (n === 5) return RU.letter5({ host, score, unsubUrl: unsub });
    if (n === 6) return RU.letter6({ host, unsubUrl: unsub });
    throw new Error(`нет русского письма номер ${n}`);
  }
  if (n === 2) return letter2({ host, score, offerUrl: offerUrl(person.email), unsubUrl: unsub });
  if (n === 3) return letter3({ host, unsubUrl: unsub });
  if (n === 4) return sites > 1 ? letter4Agency({ sites, unsubUrl: unsub }) : letter4Owner({ host, score, unsubUrl: unsub });
  if (n === 5) return letter5({ host, score, unsubUrl: unsub });
  if (n === 6) return letter6({ host, unsubUrl: unsub });
  throw new Error(`нет письма номер ${n}`);
}

/* ------------------------------ прогон ------------------------------ */

async function main() {
  const offerLive = Boolean(env('WHOP_CHECKOUT_RIVALS_19'));
  if (!offerLive) log('тариф за 19 не заведён: английское письмо 2 пропускаем, русское уходит как обычно');

  const rows = await readRows();
  // Один человек это одна почта, даже если он проверил пять сайтов. Берём его первый прогон
  // как точку отсчёта и самый свежий сайт как тот, про который с ним разговариваем.
  const people = new Map();
  for (const r of rows) {
    if (!r.email) continue;
    const p = people.get(r.email) ?? { email: r.email, rows: [], sites: new Set(), first: r.date, host: r.host, score: r.score, lang: r.lang, letters: '', unsubscribed: false };
    p.rows.push(r);
    if (r.host) p.sites.add(r.host);
    if (r.date && r.date < p.first) p.first = r.date;
    // Язык берём из самого свежего прогона: человек мог начать на одном сайте, а вернуться на другой.
    if (r.date && r.date >= (p.lastDate ?? '')) { p.lastDate = r.date; p.host = r.host || p.host; p.score = r.score || p.score; p.lang = r.lang; }
    if (r.letters) p.letters = r.letters;
    if (r.unsubscribed) p.unsubscribed = true;
    people.set(r.email, p);
  }

  const now = Date.now();
  let sentCount = 0;
  for (const p of people.values()) {
    if (sentCount >= LIMIT) { log(`достигнут предел ${LIMIT} писем за прогон`); break; }
    if (p.unsubscribed) continue;
    const started = Date.parse(`${p.first.replace(' ', 'T')}Z`);
    if (!Number.isFinite(started)) { log(`${p.email}: непонятная дата «${p.first}», пропускаю`); continue; }
    const hours = (now - started) / 3600000;
    const sent = p.letters.split(',').map((s) => s.trim()).filter(Boolean);
    // Письма про цену со скидкой на русском нет: там нет мгновенной кассы, заказ идёт счётом.
    // На английском письмо 2 живёт только если заведён скрытый тариф Whop. На русском кассы
    // нет вовсе: скидку подтверждает подпись, поэтому письмо уходит всегда.
    const n = due(hours, sent, p.lang === 'ru' ? true : offerLive);
    if (!n) continue;

    const person = { email: p.email, host: p.host, score: p.score, sites: p.sites.size, lang: p.lang };
    const mail = build(n, person);
    if (DRY) {
      log(`[сухой прогон] ${p.email}: письмо ${n} «${mail.subject}» (${hours.toFixed(0)} ч, сайтов ${person.sites}, язык ${person.lang})`);
      continue;
    }
    try {
      await send({ to: p.email, ...mail, lang: p.lang });
      await markSent(p.rows, n);
      sentCount += 1;
      log(`${p.email}: письмо ${n} отправлено («${mail.subject}»)`);
    } catch (e) {
      log(`${p.email}: письмо ${n} НЕ отправлено: ${e.message}`);
      await telegram(`⚠️ Письмо ${n} не ушло на ${p.email}: ${e.message}`);
    }
  }

  log(`готово: людей в таблице ${people.size}, отправлено ${sentCount}`);
  if (sentCount) await telegram(`✉️ Цепочка: отправлено ${sentCount} писем`);
}

main().catch(async (e) => {
  console.error(e.message);
  await telegram(`⚠️ Цепочка писем упала: ${e.message}`);
  process.exit(1);
});
