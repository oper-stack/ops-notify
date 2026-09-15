/**
 * Таблица Google как память очереди: одна на цепочку писем и на наблюдение за сайтами.
 *
 * Простым языком: у нас нет базы данных, и заводить её ради двух списков людей незачем. Таблица
 * видна Максиму глазами, правится руками и переживает любые переезды кода. Здесь лежит всё,
 * что нужно, чтобы её читать и в неё писать: токен, чтение диапазона, дописывание строк,
 * точечная правка ячеек и создание листа, если его ещё нет.
 *
 * Env: SHEETS_SA_EMAIL, SHEETS_SA_KEY (ключ сервисного аккаунта, переносы как \n),
 *      FREE_CHECKS_SHEET_ID (сама таблица).
 */
import { createSign } from 'node:crypto';

const env = (k, d = '') => String(process.env[k] ?? d).trim();
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

let cachedToken = null;
export async function sheetsToken() {
  if (cachedToken && Date.now() < cachedToken.until) return cachedToken.value;
  const iss = env('SHEETS_SA_EMAIL');
  const key = env('SHEETS_SA_KEY').replace(/\\n/g, '\n');
  if (!iss || !key) throw new Error('нет SHEETS_SA_EMAIL или SHEETS_SA_KEY');
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({ iss, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).end().sign(key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${claim}.${sig}`,
  });
  if (!res.ok) throw new Error(`Google не выдал токен: ${res.status}`);
  const body = await res.json();
  cachedToken = { value: body.access_token, until: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 };
  return cachedToken.value;
}

const sheetId = () => {
  const id = env('FREE_CHECKS_SHEET_ID');
  if (!id) throw new Error('нет FREE_CHECKS_SHEET_ID');
  return id;
};

const call = async (path, init = {}) => {
  const token = await sheetsToken();
  const res = await fetch(`${API}/${sheetId()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`таблица ответила ${res.status} на ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

/** Все строки диапазона, например `Наблюдение!A2:M`. Пустая таблица даёт пустой список. */
export async function readRows(range) {
  const body = await call(`/values/${encodeURIComponent(range)}`);
  return body.values ?? [];
}

/** Дописать строки в конец листа. `rows` это список списков ячеек. */
export async function appendRows(sheet, rows) {
  if (!rows.length) return;
  await call(`/values/${encodeURIComponent(`${sheet}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST', body: JSON.stringify({ values: rows }),
  });
}

/** Точечно записать ячейки: `[{ range: 'Наблюдение!K5', values: [['1,2']] }]`. */
export async function updateCells(data) {
  if (!data.length) return;
  await call('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data }) });
}

/**
 * Убедиться, что лист есть, и завести его с шапкой, если нет.
 *
 * Зачем: лист «Наблюдение» появился позже таблицы, и заводить его руками в браузере значит
 * зависеть от того, вспомнит ли кто-то об этом перед первой продажей. Первый же прогон создаёт
 * лист сам, и с этой минуты запись покупателя есть куда положить.
 */
export async function ensureSheet(sheet, header) {
  const meta = await call('?fields=sheets.properties.title');
  const titles = (meta.sheets || []).map((s) => s.properties.title);
  if (titles.includes(sheet)) return false;
  await call(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheet } } }] }) });
  if (header && header.length) await appendRows(sheet, [header]);
  return true;
}

/** Буква столбца по номеру с нуля: 0 это A, 12 это M. */
export const col = (i) => String.fromCharCode(65 + i);
