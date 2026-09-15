#!/usr/bin/env node
/**
 * Проверка собственных продуктов: работают ли они сегодня.
 *
 * Зачем. Если наш инструмент сломается у покупателя, мы узнаем об этом из отзыва, то есть поздно и
 * дорого. Обычный способ узнавать раньше это телеметрия из продукта, но актор публичный и запускают
 * его чужие люди на своих сайтах: слать их адреса нам это не мониторинг, а сбор чужих данных. Здесь
 * сделано иначе: мы сами, на своём сайте, раз в сутки прогоняем то, что продаём, и шумим, если
 * сломалось. Чужого в этой проверке нет ни байта.
 *
 * Что прогоняется:
 *   1. npm-пакет аудита на своём сайте: собрались ли проверки и есть ли оценки.
 *   2. Актор проверки видимости в Apify: дошёл ли прогон до SUCCEEDED и вернул ли строку с баллом.
 *   3. Страницы оплаты в Whop: отдаются ли и виден ли на них товар с ценой.
 *
 *   APIFY_TOKEN=... TG_TOKEN=... TG_CHAT_ID=... node product-smoke.mjs [--dry-run]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const env = (k) => (process.env[k] || '').trim();
const DRY = process.argv.includes('--dry-run');
const SITE = 'https://oper-stack.com';

async function tell(text) {
  if (DRY) { console.log(`[сухой прогон] в Telegram:\n${text}`); return; }
  const token = env('TG_TOKEN'); const chat = env('TG_CHAT_ID');
  if (!token || !chat) { console.log('нет TG_TOKEN или TG_CHAT_ID, сообщение не отправлено'); return; }
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  if (!r.ok) console.error(`Telegram ответил ${r.status}: ${await r.text()}`);
}

/** Пакет аудита: ставим свежий с npm и прогоняем по своему сайту. */
async function checkAuditPackage() {
  const { stdout } = await run('npx', ['--yes', '@operstack/audit@latest', 'collect', SITE, '--pages', '5', '--no-rendered', '--out', '/tmp/smoke-audit.json'], { timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
  const { default: audit } = await import('/tmp/smoke-audit.json', { with: { type: 'json' } });
  const checks = (audit.checks || []).length;
  const scored = Object.values(audit.scores || {}).filter((v) => typeof v === 'number').length;
  if (checks < 20) throw new Error(`собрано только ${checks} проверок, обычно больше сорока`);
  if (scored < 4) throw new Error(`посчитано только ${scored} областей из шести`);
  return `${checks} проверок, ${scored} областей с оценкой${/wrote/.test(stdout) ? '' : ''}`;
}

/**
 * Настоящий браузер: работает ли стадия, которой мы меряем слепоту к скриптам.
 *
 * Зачем отдельно. Обычная проверка идёт с `--no-rendered`, то есть браузер в ней не участвует.
 * А именно эта стадия 14.09.2026 оказалась сломанной сразу двумя способами: она могла висеть
 * бесконечно, и она могла принять собственную страницу ошибки Chrome за версию сайта покупателя
 * и написать в платном отчёте выдуманную находку. Оба случая молчаливые: отчёт всё равно уходит,
 * просто с неправдой или с опозданием на сорок минут.
 *
 * Здесь мы открываем в браузере свою же главную страницу и требуем узнать в ней свой текст.
 * Пусто, ошибка или молчание значит, что стадия не работает, и об этом надо узнать от себя, а не
 * от покупателя.
 */
async function checkRealBrowser() {
  const { renderedDom, isBrowserErrorPage } = await import('@operstack/audit/rendered');
  const started = Date.now();
  const dom = await renderedDom(SITE, { timeoutMs: 45000 });
  const took = ((Date.now() - started) / 1000).toFixed(1);
  if (!dom) throw new Error(`браузер не отдал разметку за ${took} с: проверка слепоты к скриптам сейчас ничего не меряет`);
  if (isBrowserErrorPage(dom)) throw new Error('браузер отдал свою страницу ошибки вместо сайта: находки по скриптам были бы выдуманными');
  if (!/OperStack/i.test(dom)) throw new Error('в разметке нет нашего же названия: браузер открыл не то');
  return `${(dom.length / 1024).toFixed(0)} КБ разметки за ${took} с`;
}

/** Актор в Apify: настоящий прогон на своём сайте. */
async function checkActor() {
  const token = env('APIFY_TOKEN');
  if (!token) throw new Error('нет APIFY_TOKEN');
  const start = await fetch(`https://api.apify.com/v2/acts/operstack~ai-visibility-check/runs?token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: [SITE], samplePages: 3, htmlReport: false }),
  }).then((r) => r.json());
  const id = start?.data?.id;
  if (!id) throw new Error(`прогон не запустился: ${JSON.stringify(start).slice(0, 200)}`);
  let status = 'READY';
  for (let i = 0; i < 60 && status !== 'SUCCEEDED' && status !== 'FAILED' && status !== 'ABORTED'; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    status = (await fetch(`https://api.apify.com/v2/actor-runs/${id}?token=${token}`).then((r) => r.json()))?.data?.status || status;
  }
  if (status !== 'SUCCEEDED') throw new Error(`прогон закончился статусом ${status}`);
  const items = await fetch(`https://api.apify.com/v2/actor-runs/${id}/dataset/items?token=${token}`).then((r) => r.json());
  const score = items?.[0]?.score;
  if (typeof score !== 'number') throw new Error('прогон прошёл, но балла в ответе нет');
  return `балл ${score} из 100`;
}

/** Страницы оплаты: покупатель должен увидеть товар и цену, а не пустую страницу. */
async function checkCheckoutPages() {
  const pages = [
    ['Site Kit', 'https://whop.com/oper-stack/operstack-site-kit', '$79'],
    ['аудит', 'https://whop.com/oper-stack/seo-aeo-and-geo-audit', '$149'],
  ];
  const broken = [];
  for (const [name, url, price] of pages) {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; OperStackSmoke/1.0)' } });
    const html = res.ok ? await res.text() : '';
    if (!res.ok) { broken.push(`${name}: страница отвечает ${res.status}`); continue; }
    if (!html.includes(price)) broken.push(`${name}: на странице нет цены ${price}`);
    else if (!/Buy now/i.test(html)) broken.push(`${name}: на странице нет кнопки покупки`);
  }
  if (broken.length) throw new Error(broken.join('; '));
  return 'обе страницы отдают товар, цену и кнопку';
}

const main = async () => {
  const jobs = [
    ['пакет аудита', checkAuditPackage],
    ['настоящий браузер', checkRealBrowser],
    ['актор видимости', checkActor],
    ['страницы оплаты', checkCheckoutPages],
  ];
  const ok = []; const bad = [];
  for (const [name, fn] of jobs) {
    try { const detail = await fn(); ok.push(`${name}: ${detail}`); console.log(`ok   ${name}: ${detail}`); }
    catch (e) { bad.push(`${name}: ${e.message}`); console.error(`СЛОМАНО ${name}: ${e.message}`); }
  }
  if (bad.length) {
    await tell(['Продукт сломан, проверка на своём сайте не прошла.', '', ...bad.map((b) => `• ${b}`), '', 'Работает: ' + (ok.length ? ok.join('; ') : 'ничего')].join('\n'));
    process.exitCode = 1;
  } else {
    console.log('\nвсё работает, сообщение не отправляется: шуметь в Telegram каждый день незачем');
  }
};

main().catch(async (e) => { console.error(e); await tell(`Проверка продуктов сама упала: ${e.message}`); process.exit(1); });
