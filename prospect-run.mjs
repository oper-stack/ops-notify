#!/usr/bin/env node
/**
 * Список сайтов на входе, таблица «кому писать первым» письмом на выходе.
 *
 * Простым языком. Покупатель курса вставил на сайте список своих кандидатов и нажал кнопку. Здесь
 * этот список отрабатывается: каждый сайт читается так, как его читает поисковый робот, и всё
 * сводится в одну таблицу, где сверху тот, у кого хуже всего, и рядом фраза, которой можно открыть
 * письмо. Человек при этом ничего не устанавливал и терминала не открывал.
 *
 * Технически: prospect из @operstack/audit, потом письмо с двумя вложениями. Ничего не сохраняется:
 * чужие адреса нам не нужны после того, как письмо ушло.
 *
 *   node prospect-run.mjs --list=sites.txt --email=buyer@example.com --lang=en
 *   node prospect-run.mjs --json='{"email":"...","sites":[...]}' --dry-run
 *
 * Env: GOOGLE_USER, GOOGLE_APP_PASSWORD, TG_TOKEN, TG_CHAT_ID.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const arg = (k, d = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const job = arg('json')
  ? JSON.parse(arg('json'))
  : { email: arg('email'), lang: arg('lang', 'en'), sites: null };

if (!job.email) { console.error('нужен --email или --json с почтой'); process.exit(2); }

const dir = mkdtempSync(join(tmpdir(), 'operstack-prospect-'));
/** Сборщик из node_modules этого репозитория, а не из сети: версия должна быть та, что в замке. */
const AUDIT_BIN = fileURLToPath(new URL('./node_modules/@operstack/audit/bin/audit.mjs', import.meta.url));
const listPath = join(dir, 'clients.txt');

if (job.sites) {
  writeFileSync(listPath, job.sites.map((s) => `${s.url}${s.name ? `, ${s.name}` : ''}`).join('\n'));
} else if (arg('list')) {
  writeFileSync(listPath, readFileSync(arg('list'), 'utf8'));
} else {
  console.error('нужен --list или sites в --json'); process.exit(2);
}

const count = readFileSync(listPath, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
console.error(`сайтов в заявке: ${count}, для ${job.email}`);

// Зовём тот сборщик, который стоит в этом репозитории и на который написаны тесты.
// `npx --yes @operstack/audit` тянул из сети «самую свежую» версию: покупатель получал файлы
// от кода, которого здесь никто не запускал, и лишний раз ждал скачивания.
const run = spawnSync(process.execPath, [AUDIT_BIN, 'prospect', listPath,
  '--out', join(dir, 'prospects'), '--lang', job.lang === 'ru' ? 'ru' : 'en'],
  { encoding: 'utf8', cwd: dir, timeout: 20 * 60 * 1000 });
console.error(run.stderr?.split('\n').slice(-4).join('\n') || '');

const csv = join(dir, 'prospects.csv');
const md = join(dir, 'prospects.md');
if (!existsSync(csv)) {
  console.error('прогон не дал таблицы:', run.stdout || run.error?.message || 'причина неизвестна');
  await notify(`❌ Разведка для ${job.email} не дала таблицы. Прогнать вручную.`);
  process.exit(1);
}
// Инструмент печатает для себя и называет полные пути к файлам во временной папке. В письме
// покупателю это мусор, поэтому от строки берётся только та часть, которая про сайты.
const raw = (run.stdout || '').trim().split('\n').pop() || '';
const summary = (raw.match(/\d+ site\(s\) to write to[^\n]*/) || [`${count} site(s) checked`])[0];

const ru = job.lang === 'ru';
const text = ru
  ? ['Ваша таблица готова.', '', summary, '',
     'В приложении два файла. Таблица в CSV открывается в Excel и в Google Таблицах, та же таблица в виде текста читается прямо в письме на телефоне.',
     '', 'Сверху те, у кого хуже всего. Последняя колонка это фраза, которой можно открыть письмо владельцу: она взята из проверки, которая что-то измерила, а не придумана.',
     '', 'Прежде чем писать, откройте сайт сами и убедитесь. Мы читаем то, что видно снаружи, и ошибиться можем.',
     '', 'Вопросы: support@oper-stack.com'].join('\n')
  : ['Your table is ready.', '', summary, '',
     'Two files attached. The CSV opens in Excel and Google Sheets; the same table as text reads fine on a phone.',
     '', 'Weakest sites at the top. The last column is a sentence you can open an email with: it comes from a check that measured something rather than from an opinion.',
     '', 'Before you send anything, open the site and confirm it yourself. We read what is visible from outside, and we can be wrong.',
     '', 'Questions: support@oper-stack.com'].join('\n');

if (has('dry-run')) {
  console.log(text);
  console.log('\n(сухой прогон, письмо не отправлено). Файлы:', csv, md);
  process.exit(0);
}

const transport = nodemailer.createTransport({
  host: 'smtp.gmail.com', port: 465, secure: true,
  auth: { user: process.env.GOOGLE_USER, pass: process.env.GOOGLE_APP_PASSWORD },
  pool: false, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
});
try {
  await transport.sendMail({
    from: `OperStack <${process.env.GOOGLE_USER}>`,
    to: job.email,
    replyTo: 'support@oper-stack.com',
    subject: ru ? 'Кому писать первым: ваша таблица' : 'Who to write to first: your table',
    text,
    attachments: [
      { filename: 'prospects.csv', path: csv },
      { filename: 'prospects.md', path: md },
    ],
  });
  console.error('письмо отправлено:', job.email);
  await notify(`📋 Разведка: ${summary}, отправлено на ${job.email}`);
} finally {
  transport.close();
  rmSync(dir, { recursive: true, force: true });
}

async function notify(message) {
  const token = process.env.TG_TOKEN;
  const chat = process.env.TG_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: message }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* уведомление не должно валить работу */ }
}
