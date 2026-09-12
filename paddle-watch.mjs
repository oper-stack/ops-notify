#!/usr/bin/env node
/**
 * Ждём, когда Paddle откроет приём оплаты.
 *
 * Пока аккаунт не прошёл проверку, любая попытка создать чек-аут отвечает
 * transaction_checkout_not_enabled. Это единственный честный признак: письмо может уйти на другой
 * ящик, а галочка в кабинете ничего не говорит коду. Поэтому раз в несколько часов пробуем создать
 * черновик сделки и смотрим на ответ.
 *
 * Удавшийся черновик никого не списывает, но висел бы мусором в кабинете, поэтому мы его сразу
 * отменяем. Сообщение в Telegram уходит один раз: состояние хранится в state/paddle.json и
 * коммитится обратно в репозиторий, иначе о хорошей новости сообщали бы каждые четыре часа.
 *
 *   PADDLE_API_KEY=... TG_TOKEN=... TG_CHAT_ID=... node paddle-watch.mjs [--dry-run]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(ROOT, 'state', 'paddle.json');
const DRY = process.argv.includes('--dry-run');
const env = (k) => (process.env[k] || '').trim();
const API = env('PADDLE_API_BASE') || 'https://api.paddle.com';

const PRICES = {
  'аудит, 149 USD': 'pri_01m28kwpaqtq74gngmp8nb5nac',
  'Site Kit, 79 USD': 'pri_01m26w56d41kt9kq0y1mcxwmnv',
};

async function paddle(method, url, body) {
  const r = await fetch(`${API}${url}`, {
    method,
    headers: { Authorization: `Bearer ${env('PADDLE_API_KEY')}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function tell(text) {
  if (DRY) { console.log('[сухой прогон] в Telegram ушло бы:\n' + text); return; }
  const r = await fetch(`https://api.telegram.org/bot${env('TG_TOKEN')}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env('TG_CHAT_ID'), text, disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram ответил ${r.status}: ${await r.text()}`);
}

async function readState() {
  try { return JSON.parse(await readFile(STATE, 'utf8')); } catch { return { open: false, told: false, checks: 0 }; }
}

const main = async () => {
  if (!env('PADDLE_API_KEY')) throw new Error('нет PADDLE_API_KEY');
  const state = await readState();
  const priceId = Object.values(PRICES)[0];

  const probe = await paddle('POST', '/transactions', { items: [{ price_id: priceId, quantity: 1 }] });
  const code = probe.json?.error?.code || '';
  const open = !code;

  if (open) {
    // Черновик создан. Он никого не списал, но пусть не мозолит глаза в кабинете.
    const id = probe.json?.data?.id;
    if (id) {
      const cancel = await paddle('PATCH', `/transactions/${id}`, { status: 'canceled' });
      console.log(`черновик ${id}: ${cancel.status === 200 ? 'отменён' : 'отменить не вышло, статус ' + cancel.status}`);
    }
  }

  console.log(open ? 'оплата открыта' : `оплата закрыта: ${code}`);
  state.checks = (state.checks || 0) + 1;
  state.lastCheck = new Date().toISOString();
  state.lastCode = code || null;

  if (open && !state.told) {
    await tell([
      'Paddle открыл приём оплаты.',
      '',
      'Проверка аккаунта пройдена, чек-аут создаётся без ошибки.',
      'Осталось включить кнопки: две переменные на Vercel, PUBLIC_PADDLE_PRICE_AUDIT и PUBLIC_PADDLE_PRICE_SITE_KIT, и деплой.',
      '',
      'Что появится сразу: ' + Object.keys(PRICES).join(', ') + '.',
      'Fix и Foundation остаются на согласовании списка, у них кнопки нет намеренно.',
    ].join('\n'));
    state.told = true;
    state.openedAt = new Date().toISOString();
  }
  if (!open && state.told) {
    // Оплату могут и выключить обратно. Об этом надо знать сразу, а не от покупателя.
    await tell(`Paddle снова не принимает оплату: ${code}. Кнопки на сайте надо погасить.`);
    state.told = false;
  }
  state.open = open;

  if (!DRY) {
    await mkdir(path.dirname(STATE), { recursive: true });
    await writeFile(STATE, JSON.stringify(state, null, 2) + '\n', 'utf8');
  }
};

main().catch((e) => { console.error(e.message); process.exit(1); });
