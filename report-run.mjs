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
 *   node report-run.mjs --url=... --email=... --tier=free   бесплатная ступень: 5 страниц, без задач
 *   node report-run.mjs --url=... --email=... --rivals=a.com,b.com,c.com   ступень за 29
 *   node report-run.mjs --url=... --email=... --dry-run   прогнать и не слать письмо
 *
 * Env: GOOGLE_USER, GOOGLE_APP_PASSWORD (SMTP), TG_TOKEN, TG_CHAT_ID (необязательно).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AREAS_RU, collect, draftNarrative, render, renderAgentPrompts, stillEmpty } from '@operstack/audit';
import nodemailer from 'nodemailer';
import { createHmac } from 'node:crypto';
import { button, buttonLoud, emailShell, note, offerCard, p as par, scoreTable, taskBlock } from './email-shell.mjs';

const args = process.argv.slice(2);
const val = (p, d = '') => (args.find((a) => a.startsWith(p)) || `${p}${d}`).slice(p.length);
const has = (f) => args.includes(f);

const URL_IN = val('--url=');
/** До трёх конкурентов для ступени за 29: их меряем короче, чем свой сайт. */
const RIVALS = val('--rivals=').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 3);
const RIVAL_PAGES = Number(val('--rival-pages=', '8')) || 8;
/** Столько времени даём одному конкуренту. Дальше он в сравнение просто не попадает. */
const RIVAL_BUDGET_MS = Number(val('--rival-budget=', '180')) * 1000;
const EMAIL = val('--email=');
/** Балл со страницы проверки, из ста. Приходит в заявке, здесь не считается. */
const SCORE = val('--score=') === '' ? null : Number(val('--score='));
/**
 * Ступень. free это то, что человек получает за почту после бесплатной проверки: пять страниц,
 * только замер. Список задач в неё не входит, потому что список задач это и есть товар за 9.
 */
const TIER = ['free', '9', '29'].includes(val('--tier=', '9')) ? val('--tier=', '9') : '9';
const FREE = TIER === 'free';
const LANG = val('--lang=', 'en') === 'ru' ? 'ru' : 'en';
const PAGES = Number(val('--pages=', FREE ? '5' : '20')) || (FREE ? 5 : 20);
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

/** Ключевые бинарные факты, которые в сравнении читаются лучше оценок. */
const FACTS = [
  ['llms', { en: 'Map for agents (llms.txt)', ru: 'Карта для агентов (llms.txt)' }],
  ['ai-search-access', { en: 'AI crawlers allowed in', ru: 'Роботы ИИ пущены на сайт' }],
  ['agent-card', { en: 'Agent card', ru: 'Карточка агента' }],
  ['faq-schema', { en: 'FAQ markup', ru: 'Разметка вопросов' }],
  ['answer-first', { en: 'Answer in the first paragraph', ru: 'Ответ в первом абзаце' }],
  ['thin', { en: 'Thin pages', ru: 'Тонкие страницы' }],
];

const mark = (status) => (status === 'ok' ? '+' : status === 'warn' ? '~' : status === 'bad' ? '—' : '?');

/**
 * Сравнение: вы и ваши конкуренты в одной таблице.
 *
 * Простым языком: знать, что у вас плохо, полезно наполовину. Полезнее знать, хуже ли вы тех
 * конкретных, с кем вас сравнивает покупатель. Плюс значит проверка пройдена, тильда спорно,
 * тире провалено, вопрос не измеряли.
 */
function buildComparison(mine, rivals, lang) {
  const ru = lang === 'ru';
  const all = [{ host: mine.meta.host, audit: mine, you: true }, ...rivals.map((r) => ({ host: r.meta.host, audit: r, you: false }))];
  const areas = Object.keys(mine.scores || {});
  const head = ['', ...all.map((x) => (x.you ? `${x.host} ${ru ? '(вы)' : '(you)'}` : x.host))];
  const rows = [];
  for (const area of areas) {
    rows.push([ru ? (AREAS_RU[area] || area) : area, ...all.map((x) => {
      const v = x.audit.scores?.[area];
      return typeof v === 'number' ? `${v}/10` : (ru ? 'не мерили' : 'not measured');
    })]);
  }
  for (const [id, label] of FACTS) {
    rows.push([ru ? label.ru : label.en, ...all.map((x) => mark((x.audit.checks || []).find((c) => c.id === id)?.status))]);
  }
  const width = head.map((_, i) => Math.max(...[head, ...rows].map((r) => String(r[i] ?? '').length)));
  const line = (r) => r.map((cell, i) => String(cell ?? '').padEnd(width[i])).join('  ').trimEnd();
  const text = [line(head), width.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = ['<table style="border-collapse:collapse;font:14px ui-sans-serif,system-ui,sans-serif">',
    `<tr>${head.map((h, i) => `<th style="text-align:${i ? 'center' : 'left'};padding:6px 12px;border-bottom:2px solid #ddd">${esc(h)}</th>`).join('')}</tr>`,
    ...rows.map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${i ? 'center' : 'left'};padding:6px 12px;border-bottom:1px solid #eee">${esc(c)}</td>`).join('')}</tr>`),
    '</table>'].join('\n');
  return { text, html };
}

const COPY = {
  en: {
    subject: (host) => `Your OperStack report: ${host}`,
    greeting: 'Your report is attached as a PDF.',
    greetingFree: 'Your report is attached as a PDF: everything this check found on your site, area by area. The one fix that moves your score most is in this email, below. Open the report, then come back here.',
    measuredFree: 'It is measured, not written by a person: every number comes from your live pages, and where something could not be measured the report says so and why.',
    firstFixHead: 'The fix that moves your score most',
    firstFixBody: 'Copy it whole and hand it to whoever looks after your site, or paste it into ChatGPT, Claude or Cursor. Keep the Now and How to check lines: without them nobody knows where to start or when it is done.',
    moreHead: 'Want every problem, not just the first one?',
    moreBody: 'The site fix list reads up to twenty pages instead of five and turns every finding into a task you can hand to anyone.',
    moreCta: 'The site fix list, 9 USD',
    offerEyebrow: '24 hours only',
    offerTitle: 'You and three rivals, watched for a month',
    offerPoints: [
      'Everything in the 9 USD report, on your own site',
      'The same measurement on up to three rivals, in one table beside yours',
      'Four weekly re-checks of your site, by email',
      'You see what your fixes actually moved, and what they did not',
      'One payment, no subscription, nothing to cancel',
    ],
    offerCta: 'Take it at 19 USD',
    offerFoot: 'After 24 hours this link costs 29 again, and it does not come back. One offer per address.',
    nextStepFree: '',
    whatIsIt:
      'It is measured, not written by a person: every number in it comes from your live pages, and where something could not be measured the report says so and why.',
    nextStep:
      'If you want a person to read every finding and write what it means for your business, that is the 149 USD audit at https://oper-stack.com/products/seo-audit/. If you want the work done, Fix at 249 USD closes the checks that need no subject knowledge of your market.',
    rivalsHead: 'You and your rivals',
    rivalsNote: 'Plus means the check passes, tilde means it needs attention, a dash means it fails, a question mark means it was not measured. The JavaScript measurement is run on your site only: it needs a real browser and would triple the time on four sites.',
    sign: 'OperStack · info@oper-stack.com',
  },
  ru: {
    subject: (host) => `Отчёт OperStack: ${host}`,
    greeting: 'Отчёт во вложении, PDF.',
    greetingFree: 'Отчёт во вложении, PDF: всё, что проверка нашла на вашем сайте, по областям. Правка, которая сильнее всего двигает балл, ниже в этом письме. Откройте отчёт, посмотрите и возвращайтесь сюда.',
    measuredFree: 'Отчёт измерен, а не написан человеком: каждая цифра снята с ваших живых страниц, а там, где измерить не вышло, так и написано и сказано почему.',
    firstFixHead: 'Правка, которая сильнее всего двигает балл',
    firstFixBody: 'Скопируйте её целиком и отдайте тому, кто ведёт вам сайт, или вставьте в ChatGPT, Claude или Cursor. Строки «Сейчас» и «Как проверить» не выбрасывайте: без них исполнитель не поймёт, откуда начинать и чем закончить.',
    moreHead: 'Хотите все проблемы, а не только первую?',
    moreBody: 'Список задач читает до двадцати страниц вместо пяти и превращает каждую находку в задачу, которую можно отдать кому угодно.',
    moreCta: 'Список задач, 800 ₽',
    offerEyebrow: '',
    offerTitle: '',
    offerPoints: [],
    offerCta: '',
    offerFoot: '',
    nextStepFree: '',
    whatIsIt:
      'Он измерен, а не написан человеком: каждая цифра снята с ваших живых страниц, а там, где измерить не удалось, так и написано и сказано почему.',
    nextStep:
      'Если нужно, чтобы каждую находку прочитал человек и написал, что она значит для вашего бизнеса, это аудит за 12 500 ₽: https://oper-stack.ru/produkty/seo-audit/. Если нужно, чтобы работу сделали за вас, это пакет Fix: https://oper-stack.ru/produkty/fix/.',
    rivalsHead: 'Вы и ваши конкуренты',
    rivalsNote: 'Плюс значит проверка пройдена, тильда спорно, тире провалено, вопрос не измеряли. Замер по скриптам делается только по вашему сайту: для него нужен настоящий браузер, и на четырёх сайтах это утроило бы время.',
    sign: 'OperStack · info@oper-stack.com',
  },
};

/**
 * Одна задача из готового текста в оформленный блок письма.
 *
 * Зачем разбирать: генератор отдаёт markdown, потому что его задумывали как файл. Но задача
 * короткая, меньше тысячи знаков, и вторым вложением она только мешает: человеку нужно её
 * скопировать и вставить в помощника, а из письма это делается одним движением, из файла нет.
 *
 * Если разметка когда-нибудь изменится и разобрать не выйдет, возвращаем null, и письмо
 * просто уходит без блока. Ломать доставку отчёта из-за оформления нельзя.
 */
function oneTaskParts(markdown, lang) {
  const L = lang === 'ru'
    ? { now: 'Сейчас', task: 'Задача', verify: 'Как проверить', rule: 'Правило:' }
    : { now: 'Now', task: 'Task', verify: 'How to check', rule: 'Rule:' };
  const grab = (label) => {
    const m = markdown.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\n|$)`));
    return m ? m[1].trim().replace(/\s+/g, ' ') : '';
  };
  const now = grab(L.now);
  const task = grab(L.task);
  const verify = grab(L.verify);
  if (!now || !task) return null;
  const ruleLine = markdown.split('\n').find((l) => l.trim().startsWith(L.rule));
  return { now, task, verify, rule: ruleLine ? ruleLine.trim() : '' };
}

/** Отписка: та же подпись, что у сайта, поэтому ссылка сходится с его страницей. */
function unsubUrlFor(email, lang) {
  const secret = env('KIT_DOWNLOAD_SECRET');
  if (!secret) return null;
  const body = Buffer.from(String(email).trim().toLowerCase(), 'utf8').toString('base64url');
  // Отписка живёт на том же сайте, что и письмо: подпись общая, а уводить русского
  // человека на английскую страницу незачем.
  const site = lang === 'ru' ? 'https://oper-stack.ru' : 'https://oper-stack.com';
  return `${site}/api/unsubscribe/?t=${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

function offerUrlFor(email, lang) {
  const secret = env('KIT_DOWNLOAD_SECRET');
  const plan = env('WHOP_CHECKOUT_RIVALS_19');
  if (!secret || !plan || lang === 'ru') return null;
  const claims = { email: String(email).trim().toLowerCase(), exp: Math.floor(Date.now() / 1000) + 24 * 3600 };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `https://oper-stack.com/api/offer/?t=${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

function buildLetter({ host, lang, scores, comparison, free = false, score = null, offerUrl = null, unsubUrl = null, firstTask = null }) {
  const t = COPY[lang];
  const ru = lang === 'ru';
  const greeting = free ? t.greetingFree : t.greeting;
  const nextStep = free ? t.nextStepFree : t.nextStep;
  const rows = Object.entries(scores || {})
    .map(([area, v]) => `${lang === 'ru' ? (AREAS_RU[area] || area) : area}: ${v ?? (lang === 'ru' ? 'не измерено' : 'not measured')}`)
    .join('\n');
  const site = `https://oper-stack.${lang === 'ru' ? 'ru' : 'com'}`;
  const text = free
    ? [greeting, '',
       ...(typeof score === 'number' ? [`${lang === 'ru' ? 'Итог' : 'The score'}: ${score} ${lang === 'ru' ? 'из 100' : 'of 100'}.`, ''] : []),
       t.measuredFree, '',
       ...(firstTask
         ? [t.firstFixHead, '', t.firstFixBody, '',
            `${lang === 'ru' ? 'Сейчас' : 'Now'}: ${firstTask.now}`, '',
            `${lang === 'ru' ? 'Что сделать' : 'What to do'}: ${firstTask.task}`, '',
            `${lang === 'ru' ? 'Как проверить' : 'How to check'}: ${firstTask.verify}`, '',
            firstTask.rule, '']
         : []),
       `${t.moreHead} ${t.moreBody}`,
       `${t.moreCta}: ${site}/${lang === 'ru' ? 'produkty' : 'products'}/site-report/`,
       ...(offerUrl
         ? ['', t.offerTitle, ...t.offerPoints.map((x) => `  - ${x}`), '',
            `29 USD -> 19 USD. ${t.offerFoot}`, offerUrl]
         : []),
       '', t.sign,
       ...(unsubUrl ? [`${lang === 'ru' ? 'Не нужны письма? Одно нажатие, и мы перестанем' : 'Not interested? One click and we stop'}: ${unsubUrl}`] : [])]
        .join('\n')
    : [greeting, '', rows, '',
       ...(comparison ? [t.rivalsHead, '', comparison.text, '', t.rivalsNote, ''] : []),
       t.whatIsIt, '', nextStep, '', t.sign].join('\n');
  // Заголовок двумя строками: домен не должен рваться посередине.
  const heading = ru
    ? ['Ваш отчёт по сайту', host]
    : ['Your report for', host];
  const areaRows = Object.entries(scores || {}).map(([area, v]) => [
    ru ? (AREAS_RU[area] || area) : area,
    typeof v === 'number' ? v : null,
  ]);
  const html = emailShell({
    site: lang,
    unsubUrl,
    preheader: free
      ? (ru ? 'Отчёт во вложении: что нашли и с чего начинать' : 'Your report is attached: what we found and where to start')
      : (ru ? 'Отчёт и список задач во вложении' : 'Your report and task list are attached'),
    heading,
    blocks: free
      ? [
          par(greeting),
          // Балл одной строкой: ради этой цифры человек и оставлял почту, а подробности в файле.
          ...(typeof score === 'number'
            ? [`<p style="margin:0 0 18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:19px;line-height:1.45;color:#14181C">${ru ? 'Итог' : 'The score'}: <strong style="color:#1A8A7D;font-size:24px">${score}</strong> ${ru ? 'из 100' : 'of 100'}.</p>`]
            : []),
          note(t.measuredFree),
          ...(firstTask
            ? [`<p style="margin:22px 0 10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#14181C">${t.firstFixHead}</p>`,
               par(t.firstFixBody),
               taskBlock(firstTask)]
            : []),
          '<hr style="border:0;border-top:1px solid #CFC8BA;margin:24px 0">',
          par(`<strong>${t.moreHead}</strong> ${t.moreBody}`),
          button(`${site}/${lang === 'ru' ? 'produkty' : 'products'}/site-report/`, `${t.moreCta} →`, 'quiet'),
          ...(offerUrl
            ? [offerCard({
                eyebrow: t.offerEyebrow,
                title: t.offerTitle,
                points: t.offerPoints,
                was: '29 USD',
                now: '19 USD',
                href: offerUrl,
                cta: `${t.offerCta} →`,
                footnote: t.offerFoot,
              })]
            : []),
        ]
      : [
          par(greeting),
          scoreTable(areaRows),
          ...(comparison
            ? [`<p style="margin:22px 0 10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#14181C">${t.rivalsHead}</p>`,
               `<div style="overflow-x:auto">${comparison.html}</div>`,
               note(t.rivalsNote)]
            : []),
          par(t.whatIsIt),
          par(nextStep),
        ],
  });
  // Пометки «free» в теме больше нет: это единственное письмо, которое человек получает
  // после проверки, и слово «бесплатный» в теме обесценивает то, что внутри.
  return { subject: t.subject(host), text, html };
}

async function send({ to, subject, text, html, attachments = [], unsubUrl = null }) {
  const user = env('GOOGLE_USER');
  const pass = env('GOOGLE_APP_PASSWORD');
  if (!user || !pass) throw new Error('нет GOOGLE_USER или GOOGLE_APP_PASSWORD');
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true, pool: false,
    auth: { user, pass },
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000,
  });
  try {
    await transport.sendMail({
      from: `OperStack <${user}>`, to, subject, text, html, attachments,
      // Почтовые программы показывают свою кнопку «отписаться», и это снижает жалобы на спам.
      // Mail.ru и Яндекс смотрят на этот заголовок отдельно от ссылки внутри письма.
      ...(unsubUrl ? { list: { unsubscribe: { url: unsubUrl, comment: 'Unsubscribe' } } } : {}),
    });
  } finally { transport.close(); }
}

async function main() {
  const site = normaliseUrl(URL_IN);
  if (!EMAIL_RE.test(EMAIL)) throw new Error(`это не похоже на адрес почты: ${EMAIL}`);
  const host = new URL(site).host;
  log(`отчёт «${TIER}» для ${EMAIL}: ${site} (${PAGES} страниц, ${LANG})`);

  const work = await mkdtemp(path.join(tmpdir(), 'operstack-report-'));
  try {
    const raw = await collect(site, { pages: PAGES, lang: LANG, rendered: true, log: (m) => log(`  ${m}`) });
    // draftNarrative возвращает копию и ничего не меняет на месте: работаем с тем, что вернули,
    // иначе в PDF уедет пустой шаблон с фигурными скобками вместо текста.
    const audit = draftNarrative(raw, { lang: LANG });

    // Сайт, который не ответил, мерить нечем. Отдать за это отчёт значило бы взять деньги за
    // страницу выдуманных находок: чаще всего человек просто опечатался в адресе.
    if (raw.meta?.reachable === false) {
      throw new Error(`сайт ${site} не ответил: отчёта по нему быть не может, проверьте адрес`);
    }
    const readable = (raw.sample || []).filter((p) => p.title !== undefined).length;
    if (!readable) {
      throw new Error(`с ${site} не удалось прочитать ни одной страницы: отчёт был бы пустым`);
    }

    const left = stillEmpty(audit);
    if (left.length) throw new Error(`черновик не заполнил ${left.length} полей (${left.slice(0, 5).join(', ')}): отчёт с заготовками покупателю не отдаём`);

    const htmlPath = path.join(work, `operstack-${host.replace(/[^a-z0-9.-]/gi, '_')}.html`);
    const result = await render(audit, { out: htmlPath, pdf: true });
    if (!result.pdf) throw new Error('Chrome не напечатал PDF: без него отчёт не отдаём');

    // Конкуренты: меряем короче и без браузера. Провал по одному конкуренту не должен уносить
    // отчёт целиком: покупатель платил за свой сайт, сравнение это добавка.
    const rivals = [];
    for (const raw of RIVALS) {
      let rivalUrl;
      try { rivalUrl = normaliseUrl(raw); } catch (e) { log(`  конкурент ${raw} пропущен: ${e.message}`); continue; }
      try {
        log(`  конкурент ${rivalUrl}`);
        // Своё время у каждого конкурента. Один медленный чужой сайт не должен задержать отчёт,
        // за который заплатили: сравнение это добавка, а не то, ради чего покупали.
        rivals.push(await Promise.race([
          collect(rivalUrl, { pages: RIVAL_PAGES, lang: LANG, rendered: false, log: () => {} }),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`не ответил за ${RIVAL_BUDGET_MS / 1000} с`)), RIVAL_BUDGET_MS)),
        ]));
      } catch (e) { log(`  конкурент ${rivalUrl} не прочитался: ${e.message}`); }
    }
    const comparison = rivals.length ? buildComparison(audit, rivals, LANG) : null;
    if (comparison) log(`  сравнение готово: вы и ${rivals.length}`);

    // Одна задача на бесплатной ступени уезжает в тело письма, а не вторым файлом: она
    // короткая, и её нужно копировать, а из вложения это лишнее движение.
    let firstTask = null;
    if (FREE) {
      const one = renderAgentPrompts(audit, { lang: LANG, limit: 1 });
      firstTask = one && one.trim() ? oneTaskParts(one, LANG) : null;
      log(firstTask ? '  первая задача разобрана в письмо' : '  первой задачи нет: проваленных проверок не нашлось');
    }

    const unsubUrl = FREE ? unsubUrlFor(EMAIL, LANG) : null;
    const letter = buildLetter({
      host, lang: LANG, scores: audit.scores, comparison, free: FREE,
      score: Number.isFinite(SCORE) ? SCORE : null,
      offerUrl: FREE ? offerUrlFor(EMAIL, LANG) : null,
      unsubUrl,
      firstTask,
    });
    const pdf = await readFile(result.pdf);
    log(`  PDF готов: ${(pdf.length / 1024).toFixed(0)} КБ`);

    /**
     * Список задач: по одной на каждую найденную проблему, обычными словами.
     *
     * Это главное, за что платят 9 долларов, и до сих пор он не отправлялся вообще. Страница
     * подтверждения обещала покупателю два файла, «список задач и замер, из которого они выросли»,
     * а уходил один. Функция для него в @operstack/audit есть и экспортируется, её просто никто
     * не звал. В бесплатную ступень задачи не входят: иначе за 9 платить не за что.
     */
    const attachments = [{ filename: path.basename(result.pdf), content: pdf, contentType: 'application/pdf' }];
    if (!FREE) {
      const tasks = renderAgentPrompts(audit, { lang: LANG });
      if (tasks && tasks.trim()) {
        attachments.push({
          filename: `what-to-fix-${host.replace(/[^a-z0-9.-]/gi, '_')}.md`,
          content: Buffer.from(tasks, 'utf8'),
          contentType: 'text/markdown; charset=utf-8',
        });
        log(`  список задач готов: ${(tasks.length / 1024).toFixed(1)} КБ`);
      } else {
        log('  список задач пуст: на сайте нет проваленных проверок');
      }
    }

    if (DRY) {
      log(`  [сухой прогон] письмо «${letter.subject}» для ${EMAIL} не отправлено`);
      log('\n' + letter.text);
      return;
    }

    await send({ to: EMAIL, ...letter, attachments, unsubUrl });
    log(`  письмо отправлено: ${EMAIL} (вложений: ${attachments.length})`);
    await notifyTelegram(`📄 ${FREE ? 'Бесплатный отчёт' : 'Отчёт'} отправлен: ${host}${rivals.length ? ` и ${rivals.length} конкурент(ов)` : ''} → ${EMAIL}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch(async (e) => {
  console.error(e.message);
  // Покупатель заплатил. Если что-то сломалось, об этом должен узнать человек, а не логи.
  await notifyTelegram(`⚠️ Отчёт «${TIER}» НЕ отправлен: ${URL_IN} → ${EMAIL}. Причина: ${e.message}. ${TIER === 'free' ? 'Это бесплатная ступень, денег не брали.' : 'Сделать руками.'}`);
  process.exit(1);
});
