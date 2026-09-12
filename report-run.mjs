#!/usr/bin/env node
/**
 * Отчёт за 9 долларов: один прогон по сайту покупателя, PDF письмом.
 *
 * Простым языком. Бесплатная проверка открывает одну страницу и задаёт один вопрос. Здесь
 * открывается весь сайт, до двадцати страниц, и по каждой считается то же самое, что в платном
 * аудите: что видит поисковый робот, сколько текста пропадает без скриптов, что может процитировать
 * ИИ и какие файлы ищут на домене программы-агенты. Никто этот отчёт глазами не читает: цифры
 * измерены, текст собран из измерений. Разбор человеком это аудит за 149.
 *
 * Технически: collect → draftNarrative → render --pdf, письмо с вложением, сообщение в Telegram.
 * Ничего не сохраняется: адрес сайта покупателя нам не нужен после того, как письмо ушло.
 *
 *   node report-run.mjs --url=https://example.com --email=buyer@example.com --lang=en
 *   node report-run.mjs --url=... --email=... --dry-run   прогнать и не слать письмо
 *
 * Env: GOOGLE_USER, GOOGLE_APP_PASSWORD (SMTP), TG_TOKEN, TG_CHAT_ID (необязательно).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collect, draftNarrative, render, stillEmpty } from '@operstack/audit';
import nodemailer from 'nodemailer';

const args = process.argv.slice(2);
const val = (p, d = '') => (args.find((a) => a.startsWith(p)) || `${p}${d}`).slice(p.length);
const has = (f) => args.includes(f);

const URL_IN = val('--url=');
const EMAIL = val('--email=');
const LANG = val('--lang=', 'en') === 'ru' ? 'ru' : 'en';
const PAGES = Number(val('--pages=', '20')) || 20;
const DRY = has('--dry-run');

const env = (k, d = '') => (process.env[k] || d).trim();
const log = (...a) => console.log(...a);

/** Адрес покупателя приходит из формы. Принимаем только http(s) и только настоящий хост. */
function normaliseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('нет --url');
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  const u = new URL(withScheme);
  if (!/^https?:$/.test(u.protocol)) throw new Error('адрес должен быть http или https');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) throw new Error(`это не похоже на домен: ${u.hostname}`);
  if (/^(localhost|127\.|10\.|192\.168\.|0\.)/i.test(u.hostname)) throw new Error('внутренние адреса не проверяем');
  return u.origin + (u.pathname === '/' ? '/' : u.pathname);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function notifyTelegram(text) {
  const token = env('TG_TOKEN');
  const chat = env('TG_CHAT_ID');
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) { console.error('telegram:', e.message); }
}

const COPY = {
  en: {
    subject: (host) => `Your OperStack report: ${host}`,
    greeting: 'Your report is attached as a PDF.',
    whatIsIt:
      'It is measured, not written by a person: every number in it comes from your live pages, and where something could not be measured the report says so and why.',
    nextStep:
      'If you want a person to read every finding and write what it means for your business, that is the 149 USD audit at https://oper-stack.com/products/seo-audit/. If you want the work done, Fix at 249 USD closes the checks that need no subject knowledge of your market.',
    sign: 'OperStack · info@oper-stack.com',
  },
  ru: {
    subject: (host) => `Отчёт OperStack: ${host}`,
    greeting: 'Отчёт во вложении, PDF.',
    whatIsIt:
      'Он измерен, а не написан человеком: каждая цифра снята с ваших живых страниц, а там, где измерить не удалось, так и написано и сказано почему.',
    nextStep:
      'Если нужно, чтобы каждую находку прочитал человек и написал, что она значит для вашего бизнеса, это аудит за 149 долларов: https://oper-stack.com/products/seo-audit/. Если нужно, чтобы работу сделали за вас, пакет Fix за 249 закрывает то, что не требует знания вашего рынка.',
    sign: 'OperStack · info@oper-stack.com',
  },
};

function buildLetter({ host, lang, scores }) {
  const t = COPY[lang];
  const rows = Object.entries(scores || {})
    .map(([area, v]) => `${area}: ${v ?? (lang === 'ru' ? 'не измерено' : 'not measured')}`)
    .join('\n');
  const text = [t.greeting, '', rows, '', t.whatIsIt, '', t.nextStep, '', t.sign].join('\n');
  const html = [
    `<p>${t.greeting}</p>`,
    `<pre style="font:14px ui-monospace,monospace;background:#f6f7f9;padding:12px;border-radius:6px">${rows.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`,
    `<p>${t.whatIsIt}</p>`,
    `<p>${t.nextStep}</p>`,
    `<p style="color:#666">${t.sign}</p>`,
  ].join('\n');
  return { subject: t.subject(host), text, html };
}

async function send({ to, subject, text, html, attachment }) {
  const user = env('GOOGLE_USER');
  const pass = env('GOOGLE_APP_PASSWORD');
  if (!user || !pass) throw new Error('нет GOOGLE_USER или GOOGLE_APP_PASSWORD');
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true, pool: false,
    auth: { user, pass },
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000,
  });
  try {
    await transport.sendMail({ from: `OperStack <${user}>`, to, subject, text, html, attachments: attachment ? [attachment] : [] });
  } finally { transport.close(); }
}

async function main() {
  const site = normaliseUrl(URL_IN);
  if (!EMAIL_RE.test(EMAIL)) throw new Error(`это не похоже на адрес почты: ${EMAIL}`);
  const host = new URL(site).host;
  log(`отчёт для ${EMAIL}: ${site} (${PAGES} страниц, ${LANG})`);

  const work = await mkdtemp(path.join(tmpdir(), 'operstack-report-'));
  try {
    const raw = await collect(site, { pages: PAGES, lang: LANG, rendered: true, log: (m) => log(`  ${m}`) });
    // draftNarrative возвращает копию и ничего не меняет на месте: работаем с тем, что вернули,
    // иначе в PDF уедет пустой шаблон с фигурными скобками вместо текста.
    const audit = draftNarrative(raw, { lang: LANG });

    const left = stillEmpty(audit);
    if (left.length) throw new Error(`черновик не заполнил ${left.length} полей (${left.slice(0, 5).join(', ')}): отчёт с заготовками покупателю не отдаём`);

    const htmlPath = path.join(work, `operstack-${host.replace(/[^a-z0-9.-]/gi, '_')}.html`);
    const result = await render(audit, { out: htmlPath, pdf: true });
    if (!result.pdf) throw new Error('Chrome не напечатал PDF: без него отчёт не отдаём');

    const letter = buildLetter({ host, lang: LANG, scores: audit.scores });
    const pdf = await readFile(result.pdf);
    log(`  PDF готов: ${(pdf.length / 1024).toFixed(0)} КБ`);

    if (DRY) { log(`  [сухой прогон] письмо «${letter.subject}» для ${EMAIL} не отправлено`); return; }

    await send({ to: EMAIL, ...letter, attachment: { filename: path.basename(result.pdf), content: pdf, contentType: 'application/pdf' } });
    log(`  письмо отправлено: ${EMAIL}`);
    await notifyTelegram(`📄 Отчёт за 9 отправлен: ${host} → ${EMAIL}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch(async (e) => {
  console.error(e.message);
  // Покупатель заплатил. Если что-то сломалось, об этом должен узнать человек, а не логи.
  await notifyTelegram(`⚠️ Отчёт за 9 НЕ отправлен: ${URL_IN} → ${EMAIL}. Причина: ${e.message}. Сделать руками.`);
  process.exit(1);
});
