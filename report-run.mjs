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
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AREAS_RU, collect, draftNarrative, firstFixParts, overallSummary, render, renderAgentPrompts, stillEmpty } from '@operstack/audit';
import nodemailer from 'nodemailer';
import { createHmac } from 'node:crypto';
import { areaTable, button, buttonLoud, emailShell, headline, note, offerCard, p as par, scoreTable, taskBlock } from './email-shell.mjs';
import { isOwnTest } from './own-test.mjs';

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
 * Результат проверки, который человек уже видел на странице, целиком и в base64url.
 * Отдаём его сборщику, чтобы он не мерил второй раз: два честных замера живого сайта
 * расходятся на пару баллов, и в письме оказалось бы не то число, что на экране.
 */
const VISIBILITY = (() => {
  const raw = val('--visibility=');
  if (!raw) return null;
  try { return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return null; }
})();
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

/** Оценка словом по баллу. Пороги те же, что в движке видимости: иначе старая заявка,
 *  где приехала одна цифра, получила бы не ту оценку, что новая. */
const gradeOf = (n) => (n >= 80 ? 'A' : n >= 65 ? 'B' : n >= 45 ? 'C' : n >= 25 ? 'D' : 'E');

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
    subject: (host, free, rivals) => (free ? `Your first fix: ${host}` : rivals ? `Your rival comparison: ${host}` : `Your OperStack fix list: ${host}`),
    greeting: 'Your fix list is attached, with the measurement behind it as a PDF.',
    greetingFree: 'Here is the one fix that moves your score most, written so you can hand it to whoever runs your site. Your score and its five areas are what you saw on the page; they are repeated below so this letter stands on its own.',
    measuredFree: 'It is measured, not written by a person: every number comes from your live pages, and where something could not be measured the report says so and why.',
    firstFixHead: 'The fix that moves your score most',
    firstFixBody: 'Copy it whole and hand it to whoever looks after your site, or paste it into ChatGPT, Claude or Cursor. Keep the Now and How to check lines: without them nobody knows where to start or when it is done.',
    moreHead: 'Want every problem, not just the first one?',
    moreBody: 'The site fix list reads up to twenty pages instead of five and turns every finding into a task you can hand to anyone.',
    moreCta: 'The site fix list, 9 USD',
    offerWas: '29 USD',
    offerNow: '19 USD',
    offerEyebrow: '24 hours only',
    offerTitle: 'You and three rivals, watched for a month',
    offerPoints: [
      'Everything in the 9 USD fix list, on your own site',
      'The same measurement on up to three rivals, in one table beside yours',
      'You see, in one table, exactly where each rival is ahead of you and where you are ahead',
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
    snapshotsNext: 'For the next four weeks a snapshot follows once a week: your score and your rivals\' then and now, and how the gap moved. The first one comes in a week.',
    rivalsNote: 'Plus means the check passes, tilde means it needs attention, a dash means it fails, a question mark means it was not measured. The JavaScript measurement is run on your site only: it needs a real browser and would triple the time on four sites.',
    sign: 'OperStack · info@oper-stack.com',
  },
  ru: {
    subject: (host, free, rivals) => (free ? `Ваша первая правка: ${host}` : rivals ? `Сравнение с конкурентами: ${host}` : `Список правок OperStack: ${host}`),
    greeting: 'Список правок во вложении, рядом замер, из которого он собран, в PDF.',
    greetingFree: 'Вот правка, которая сильнее всего двигает балл, написанная так, чтобы её можно было отдать тому, кто ведёт сайт. Балл и пять областей те же, что вы видели на странице; они повторены ниже, чтобы письмо читалось само по себе.',
    measuredFree: 'Всё это измерено, а не написано человеком: каждая цифра снята с ваших живых страниц, а там, где измерить не вышло, так и написано и сказано почему.',
    firstFixHead: 'Правка, которая сильнее всего двигает балл',
    firstFixBody: 'Скопируйте её целиком и отдайте тому, кто ведёт вам сайт, или вставьте в ChatGPT, Claude или Cursor. Строки «Сейчас» и «Как проверить» не выбрасывайте: без них исполнитель не поймёт, откуда начинать и чем закончить.',
    moreHead: 'Хотите все проблемы, а не только первую?',
    moreBody: 'Список задач читает до двадцати страниц вместо пяти и превращает каждую находку в задачу, которую можно отдать кому угодно.',
    moreCta: 'Список задач, 800 ₽',
    offerWas: '2 500 ₽',
    offerNow: '1 500 ₽',
    offerEyebrow: 'Только сутки',
    offerTitle: 'Вы и три конкурента, месяц наблюдения',
    offerPoints: [
      'Всё из списка правок за 800 ₽, по вашему сайту',
      'Те же замеры по трём конкурентам, в одной таблице рядом с вами',
      'В одной таблице видно, где именно каждый конкурент вас обходит, а где обходите вы',
      'Разовая оплата, подписки не остаётся, отменять нечего',
    ],
    offerCta: 'Забрать за 1 500 ₽',
    offerFoot: 'Счёт придёт письмом сразу, оплата переводом. Через сутки ссылка снова станет стоить 2 500, и вернуть её нельзя. Одно предложение на один адрес.',
    nextStepFree: '',
    whatIsIt:
      'Он измерен, а не написан человеком: каждая цифра снята с ваших живых страниц, а там, где измерить не удалось, так и написано и сказано почему.',
    nextStep:
      'Если нужно, чтобы каждую находку прочитал человек и написал, что она значит для вашего бизнеса, это аудит за 12 500 ₽: https://oper-stack.ru/produkty/seo-audit/. Если нужно, чтобы работу сделали за вас, это пакет Fix: https://oper-stack.ru/produkty/fix/.',
    rivalsHead: 'Вы и ваши конкуренты',
    snapshotsNext: 'Дальше четыре недели, раз в неделю, придёт срез: ваш балл и баллы конкурентов тогда и сейчас, и как изменился разрыв. Первый через неделю.',
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
  // На английском ссылка ведёт на скрытый тариф Whop, и без него предложения быть не может.
  // На русском кассы нет вовсе: ссылка ведёт на обычное оформление заказа, а скидку
  // подтверждает подпись, поэтому никакой переменной здесь не нужно.
  const plan = env('WHOP_CHECKOUT_RIVALS_19');
  if (!secret || (lang !== 'ru' && !plan)) return null;
  const claims = { email: String(email).trim().toLowerCase(), exp: Math.floor(Date.now() / 1000) + 24 * 3600 };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const site = lang === 'ru' ? 'https://oper-stack.ru' : 'https://oper-stack.com';
  return `${site}/api/offer/?t=${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/*
 * Что несёт бесплатное письмо, с 16.09.2026.
 *
 * Раньше оно несло ту же самую правку, которую человек уже прочитал на странице целиком. То есть
 * мы просили почту за то, что только что отдали. Теперь письмо несёт ВТОРУЮ правку и названия
 * всех остальных находок. Как чинить каждую из остальных, остаётся в списке правок за деньги:
 * эту границу двигать нельзя, иначе бесплатное письмо съедает платный товар.
 */
export function buildLetter({ host, lang, scores, comparison, free = false, head = null, offerUrl = null, unsubUrl = null, firstTask = null, secondTask = null, restNames = [] }) {
  const t = COPY[lang];
  const ru = lang === 'ru';
  const greeting = free ? t.greetingFree : t.greeting;
  const nextStep = free ? t.nextStepFree : t.nextStep;
  const rows = Object.entries(scores || {})
    .map(([area, v]) => `${lang === 'ru' ? (AREAS_RU[area] || area) : area}: ${v ?? (lang === 'ru' ? 'не измерено' : 'not measured')}`)
    .join('\n');
  const site = `https://oper-stack.${lang === 'ru' ? 'ru' : 'com'}`;
  // Заголовок, подпись под ним и пять его областей: ровно то, что стоит на первой странице
  // отчёта, и теми же словами. Текст приходит готовым из пакета, здесь его не сочиняют.
  const headText = head
    ? [`${head.label}: ${head.score} ${ru ? 'из 100' : 'of 100'} (${head.grade}).`,
       head.note, '',
       ...head.areas.map((x) => `  ${x.label}: ${x.score === null ? head.notMeasured : `${x.score} / ${x.max}`}`), '']
    : [];
  const text = free
    ? [greeting, '',
       ...headText,
       t.measuredFree, '',
       ...(firstTask
         ? [t.firstFixHead, '', t.firstFixBody, '',
            `${lang === 'ru' ? 'Сейчас' : 'Now'}: ${firstTask.now}`, '',
            `${lang === 'ru' ? 'Задача' : 'Task'}: ${firstTask.task}`, '',
            `${lang === 'ru' ? 'Как проверить' : 'How to check'}: ${firstTask.verify}`, '',
            firstTask.rule, '']
         : []),
       ...(secondTask
         ? [lang === 'ru' ? 'Вторая по важности правка' : 'The second fix by weight', '',
            `${lang === 'ru' ? 'Сейчас' : 'Now'}: ${secondTask.now}`, '',
            `${lang === 'ru' ? 'Задача' : 'Task'}: ${secondTask.task}`, '',
            `${lang === 'ru' ? 'Как проверить' : 'How to check'}: ${secondTask.verify}`, '',
            secondTask.rule, '']
         : []),
       ...(restNames.length
         ? [lang === 'ru' ? `Что ещё нашлось на сайте, всего ${restNames.length}:` : `What else the check found, ${restNames.length} in all:`,
            ...restNames.map((x) => `  - ${x}`),
            '',
            lang === 'ru'
              ? 'Что именно поменять по каждой из них и как проверить, расписано в списке правок по всему сайту.'
              : 'What to change for each of them, and how to check it, is written out in the full site fix list.',
            '']
         : []),
       `${t.moreHead} ${t.moreBody}`,
       `${t.moreCta}: ${site}/${lang === 'ru' ? 'produkty' : 'products'}/site-report/`,
       ...(offerUrl
         ? ['', t.offerTitle, ...t.offerPoints.map((x) => `  - ${x}`), '',
            `${t.offerWas} -> ${t.offerNow}. ${t.offerFoot}`, offerUrl]
         : []),
       '', t.sign,
       ...(unsubUrl ? [`${lang === 'ru' ? 'Не нужны письма? Одно нажатие, и мы перестанем' : 'Not interested? One click and we stop'}: ${unsubUrl}`] : [])]
        .join('\n')
    : [greeting, '',
       ...headText,
       ...(head ? [head.secondMeasure, ''] : []),
       rows, '',
       ...(head ? [head.secondMeasureFoot, ''] : []),
       ...(comparison ? [t.rivalsHead, '', comparison.text, '', t.rivalsNote, '', t.snapshotsNext, ''] : []),
       t.whatIsIt, '', nextStep, '', t.sign].join('\n');
  // Заголовок двумя строками: домен не должен рваться посередине.
  const heading = ru
    ? [comparison ? 'Вы и ваши конкуренты' : 'Ваш список правок', host]
    : [comparison ? 'You and your rivals' : 'Your fix list for', host];
  const areaRows = Object.entries(scores || {}).map(([area, v]) => [
    ru ? (AREAS_RU[area] || area) : area,
    typeof v === 'number' ? v : null,
  ]);
  const html = emailShell({
    site: lang,
    unsubUrl,
    preheader: free
      ? (ru ? 'Ваша первая правка и балл сайта' : 'Your first fix and your site score')
      : (ru ? 'Список правок и замер во вложении' : 'Your fix list and the measurement are attached'),
    heading,
    blocks: free
      ? [
          par(greeting),
          // Ради этой цифры человек и оставлял почту. Она же стоит на первой странице отчёта,
          // и под ней те же пять областей, которые в сумме её дают.
          ...(head ? [headline({ host, ...head })] : []),
          ...(head && head.areas.length ? [areaTable(head.areas, head.notMeasured)] : []),
          note(t.measuredFree),
          ...(firstTask
            ? [`<p style="margin:22px 0 10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#14181C">${t.firstFixHead}</p>`,
               par(t.firstFixBody),
               taskBlock(firstTask, lang)]
            : []),
          ...(secondTask
            ? [par(`<strong>${lang === 'ru' ? 'Вторая по важности правка' : 'The second fix by weight'}</strong>`),
               taskBlock(secondTask, lang)]
            : []),
          ...(restNames.length
            ? [par(`<strong>${lang === 'ru' ? `Что ещё нашлось на сайте, всего ${restNames.length}` : `What else the check found, ${restNames.length} in all`}</strong>`),
               `<ul style="margin:8px 0 14px;padding-left:20px;font-size:15px;line-height:1.6">${restNames.map((x) => `<li>${String(x).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</li>`).join('')}</ul>`,
               note(lang === 'ru'
                 ? 'Что именно поменять по каждой из них и как проверить, расписано в списке правок по всему сайту.'
                 : 'What to change for each of them, and how to check it, is written out in the full site fix list.')]
            : []),
          '<hr style="border:0;border-top:1px solid #CFC8BA;margin:24px 0">',
          par(`<strong>${t.moreHead}</strong> ${t.moreBody}`),
          button(`${site}/${lang === 'ru' ? 'produkty' : 'products'}/site-report/`, `${t.moreCta} →`, 'quiet'),
          ...(offerUrl
            ? [offerCard({
                eyebrow: t.offerEyebrow,
                title: t.offerTitle,
                points: t.offerPoints,
                was: t.offerWas,
                now: t.offerNow,
                href: offerUrl,
                cta: `${t.offerCta} →`,
                footnote: t.offerFoot,
              })]
            : []),
        ]
      : [
          par(greeting),
          ...(head ? [headline({ host, ...head })] : []),
          ...(head && head.areas.length ? [areaTable(head.areas, head.notMeasured)] : []),
          ...(head ? [`<p style="margin:22px 0 10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#14181C">${head.secondMeasure}</p>`] : []),
          scoreTable(areaRows, lang),
          ...(head ? [note(head.secondMeasureFoot)] : []),
          ...(comparison
            ? [`<p style="margin:22px 0 10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#14181C">${t.rivalsHead}</p>`,
               `<div style="overflow-x:auto">${comparison.html}</div>`,
               note(t.rivalsNote),
               par(t.snapshotsNext)]
            : []),
          par(t.whatIsIt),
          par(nextStep),
        ],
  });
  // Пометки «free» в теме больше нет: это единственное письмо, которое человек получает
  // после проверки, и слово «бесплатный» в теме обесценивает то, что внутри.
  return { subject: t.subject(host, free, Boolean(comparison)), text, html };
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
      // Заголовка List-Unsubscribe-Post здесь намеренно нет: он обещает отписку в одно нажатие,
      // а почтовая служба шлёт на неё POST без заголовка Origin, и встроенная защита Astro такой
      // запрос отклоняет с кодом 403 (проверено на живом 14.09.2026). Обещать то, что вернёт
      // ошибку, хуже, чем не обещать: кнопка и так работает, просто открывает страницу.
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
    const raw = await collect(site, {
      pages: PAGES, lang: LANG, rendered: true, log: (m) => log(`  ${m}`),
      ...(VISIBILITY ? { visibility: VISIBILITY } : {}),
    });
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
    let secondTask = null;
    let restNames = [];
    if (FREE) {
      /*
       * Та же правка, что человек видел на экране, теми же словами и подписями.
       *
       * Раньше письмо собирало её из своего прогона аудита, и получалось два разных замера в
       * одном письме: строка балла говорила «прочитано 3 страницы», а правка внутри «на 5 страниц
       * выборки». Теперь правка берётся из того же результата проверки, что уехал на страницу,
       * через firstFixParts из пакета. Если находки нет сопоставления, письмо честно падает на
       * старый путь, а не остаётся без правки.
       */
      const fromPage = VISIBILITY && Array.isArray(VISIBILITY.fixes) ? firstFixParts(VISIBILITY.fixes[0], { lang: LANG }) : null;
      if (fromPage) firstTask = fromPage;
      else {
        const one = renderAgentPrompts(audit, { lang: LANG, limit: 1 });
        firstTask = one && one.trim() ? oneTaskParts(one, LANG) : null;
      }
      /*
       * Вторая правка и список остальных. Берём из того же результата, что уехал на страницу,
       * иначе письмо и экран снова разойдутся. Названия остальных находок это их собственный
       * текст, укороченный: полный текст с объяснением живёт в платном списке.
       */
      if (VISIBILITY && Array.isArray(VISIBILITY.fixes) && VISIBILITY.fixes[1]) {
        secondTask = firstFixParts(VISIBILITY.fixes[1], { lang: LANG });
      }
      if (VISIBILITY && Array.isArray(VISIBILITY.areas)) {
        const all = VISIBILITY.areas.flatMap((a) => (a.findings || []).filter((f) => f.level === 'fail' || f.level === 'warn'));
        const shown = new Set([VISIBILITY.fixes?.[0]?.id, VISIBILITY.fixes?.[1]?.id].filter(Boolean));
        restNames = all
          .filter((f) => !shown.has(f.id))
          .map((f) => String(f.text || '').split(/(?<=[.!?])\s/)[0].trim())
          .filter(Boolean);
      }
      log(firstTask ? '  первая задача разобрана в письмо' : '  первой задачи нет: проваленных проверок не нашлось');
      log(`  вторая задача: ${secondTask ? 'есть' : 'нет'}, остальных находок: ${restNames.length}`);
    }

    /**
     * Заголовок письма собирает пакет, той же функцией, которой его печатает первая страница PDF.
     * Считать балл здесь своим вызовом нельзя: с версии 0.17 балл в отчёте это балл видимости, а
     * не взвешенная сумма шести областей, и собственный расчёт снова развёл бы письмо с вложением.
     *
     * Балла может не быть вовсе: движок отказывается мерить закрытые и приватные адреса. Тогда
     * письмо просто не называет цифру, а не подставляет ноль. Старая заявка, пролежавшая в ящике
     * с цифрой вместо результата, тоже обслуживается: из неё собирается тот же блок, только без
     * разбивки по областям, которой в ней нет.
     */
    let head = overallSummary(audit.overall, { lang: LANG });
    if (!head && Number.isFinite(SCORE)) head = overallSummary({ score: SCORE, grade: gradeOf(SCORE), areas: [], source: 'visibility:reused' }, { lang: LANG });
    log(`  общий балл: ${head ? head.score : 'не посчитан'} из 100 (${audit.overall?.source ?? 'источник неизвестен'})`);

    const unsubUrl = FREE ? unsubUrlFor(EMAIL, LANG) : null;
    const letter = buildLetter({
      host, lang: LANG, scores: audit.scores, comparison, free: FREE, secondTask, restNames,
      head,
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
    // Бесплатная ступень с 15.09.2026 без PDF: он первая платная вещь. За почту уходит балл и
    // одна правка словами, а форму остального человек видел на странице размытым списком.
    const attachments = FREE ? [] : [{ filename: path.basename(result.pdf), content: pdf, contentType: 'application/pdf' }];
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
      // Сухой прогон это и есть сверка втроём. Раньше она делалась глазами по трём разным
      // экранам, и именно так разошлись 46, 61 и шесть из шестидесяти. Теперь три числа
      // печатаются рядом одной строкой, и расхождение видно сразу.
      const printed = (await readFile(htmlPath, 'utf8')).match(/overall-num[^"]*">(\d+)/);
      const three = { движок: VISIBILITY?.score ?? null, отчёт: printed ? Number(printed[1]) : null, письмо: head ? head.score : null };
      const same = new Set(Object.values(three).filter((v) => v !== null)).size <= 1;
      log(`  [сухой прогон] балл: движок ${three.движок ?? '—'} | отчёт ${three.отчёт ?? '—'} | письмо ${three.письмо ?? '—'} ${same ? '✓ сходится' : '✗ РАСХОЖДЕНИЕ'}`);
      log(`  [сухой прогон] письмо «${letter.subject}» для ${EMAIL} не отправлено, вложений: ${attachments.length}`);
      log('\n' + letter.text);
      if (!same) process.exitCode = 1;
      return;
    }

    await send({ to: EMAIL, ...letter, attachments, unsubUrl });
    log(`  письмо отправлено: ${EMAIL} (вложений: ${attachments.length})`);

    /*
     * Ступень «Против конкурентов» продолжается четырьмя срезами раз в неделю. Запись в таблицу
     * наблюдения делается здесь, в момент отправки отчёта, с баллами на этот день: от них потом
     * считается разница. Не записали, значит человек не получит того, за что заплатил, поэтому
     * провал записи это тревога в Telegram, а не тихий лог.
     */
    if (TIER === '29') {
      try {
        const { register } = await import('./watch-run.mjs');
        const baseline = { site: head ? head.score : null, rivals: Object.fromEntries(rivals.map((r) => [String(r.meta?.host || '').replace(/^www\./, ''), Number.isFinite(r.overall?.score) ? r.overall.score : null])) };
        await register({ kind: 'rivals-weekly', email: EMAIL, url: site, lang: LANG, rivals: rivals.map((r) => r.meta?.url || '').filter(Boolean), baseline });
        log('  наблюдение: записано, первый срез через неделю');
      } catch (e) {
        log(`  наблюдение НЕ записано: ${e.message}`);
        await notifyTelegram(`⚠️ Отчёт за 29 для ${EMAIL} ушёл, но запись на еженедельные срезы не удалась: ${e.message}. Записать руками: node watch-run.mjs --register --kind=rivals-weekly --email=${EMAIL} --url=${site} --lang=${LANG}`);
      }
    }
    // Успех молчит, если отчёт ушёл на наш собственный проверочный адрес: это прогон, не продажа.
    if (isOwnTest(EMAIL)) log(`  в Telegram не пишем: ${EMAIL} это наш проверочный адрес`);
    else await notifyTelegram(`📄 ${FREE ? 'Бесплатный отчёт' : 'Отчёт'} отправлен: ${host}${rivals.length ? ` и ${rivals.length} конкурент(ов)` : ''} → ${EMAIL}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// Файл заодно и модуль: тест письма импортирует buildLetter и не должен запускать прогон.
// Вызов остаётся ровно для запуска из очереди, где файл открывают как программу.
const RUN_AS_PROGRAM = process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (RUN_AS_PROGRAM) main().catch(async (e) => {
  console.error(e.message);
  // Покупатель заплатил. Если что-то сломалось, об этом должен узнать человек, а не логи.
  await notifyTelegram(`⚠️ Отчёт «${TIER}» НЕ отправлен: ${URL_IN} → ${EMAIL}. Причина: ${e.message}. ${TIER === 'free' ? 'Это бесплатная ступень, денег не брали.' : 'Сделать руками.'}`);
  process.exit(1);
});
