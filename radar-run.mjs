#!/usr/bin/env node
/**
 * Радар веток: где прямо сейчас спрашивают то, на что у нас есть ответ.
 *
 * Простым языком. В сети каждый час кто-то спрашивает «почему меня не видно в ChatGPT»,
 * «что за llms.txt», «каким инструментом мерить видимость». Такая ветка живёт несколько часов,
 * и попасть в неё надо рано. Радар ищет свежие вопросы, отбрасывает то, что уже показывал, и
 * присылает в Telegram: ссылку, о чём там речь и готовый черновик ответа.
 *
 * Отвечает человек. Скрипт не публикует ничего и не может: на площадки мы заходим руками. Так
 * решено осознанно, потому что площадки считают автопостинг ссылок спамом, а в примере, с
 * которого всё началось, сработала не ссылка, а уместный ответ живого человека.
 *
 * Два источника, и они очень разные по цене.
 *
 *   Hacker News  бесплатно, без ключа, английский. Публичный поиск Algolia. Именно там наш
 *                покупатель: люди сами спрашивают про llms.txt и блокировку ИИ-роботов.
 *                Гоняем каждый час, платить не за что.
 *   Threads      платно, 0,008 $ за запись, русский и английский. Поиск идёт через актор Apify.
 *                Тариф у нас бесплатный, 5 $ в месяц на всё, и этот лимит общий с другими
 *                ветками работы. Поэтому Threads запускается редко и только пока есть остаток.
 *
 * Про остаток. Раньше здесь читалось поле usageUsd из /users/me, и оно всегда равно нулю:
 * бесплатные 5 $ идут не как трата, а как кредит. Настоящий расход живёт в /users/me/usage/monthly,
 * и 15.09.2026 он показал 4,42 $ из 5 при нулях в старом поле. Читать только этот адрес.
 *
 *   node radar-run.mjs             один проход по расписанию
 *   node radar-run.mjs --dry-run   найти и показать, ничего не писать и не запоминать
 *
 * Env: APIFY_TOKEN, TG_TOKEN, TG_CHAT_ID, SHEETS_SA_EMAIL, SHEETS_SA_KEY, FREE_CHECKS_SHEET_ID.
 * Ручки: RADAR_SOURCE=hn|threads|all, RADAR_GROUP=0..5, RADAR_MAX_ITEMS, RADAR_BUDGET_STOP.
 */
import { appendRows, ensureSheet, readRows } from './sheets.mjs';

const env = (k, d = '') => String(process.env[k] ?? d).trim();
const DRY = process.argv.includes('--dry-run');
const log = (...a) => console.log(...a);

const ACTOR = 'watcher.data~search-threads-by-keywords';
const SHEET = 'Радар';
const HEADER = ['Найдено', 'Площадка', 'id поста', 'Автор', 'Ссылка', 'Оценка', 'Слова', 'Отправлено'];

/** Сколько записей просим у Threads за проход. Каждая стоит 0,008 $, отсюда и цена. */
const PER_RUN = Number(env('RADAR_MAX_ITEMS', '3')) || 3;
/**
 * Выше этой суммы Threads не запускается. 5 $ это весь бесплатный тариф Apify на месяц, и он
 * общий с остальной работой, поэтому порог стоит с запасом, а не впритык.
 */
const BUDGET_STOP = Number(env('RADAR_BUDGET_STOP', '4.8')) || 4.8;
/** Какие источники трогаем в этом проходе. По умолчанию только бесплатный. */
const SOURCE = env('RADAR_SOURCE', 'hn').toLowerCase();
/** Окно поиска по Hacker News. Неделя: тема даёт единицы веток в неделю, повторы режет дедуп. */
const HN_HOURS = Number(env('RADAR_HN_HOURS', '168')) || 168;

/*
 * Группы слов для Threads. Чередуются по часам, чтобы за проход платить за одну выборку.
 * Внутри группы слова подобраны под просьбу о совете, а не под тему вообще: «ai seo» приводит
 * рекламу, «what ai seo tool do you use» приводит человека, которому можно ответить.
 */
const GROUPS = [
  { lang: 'en', weight: 3, keywords: ['llms.txt', 'ai visibility'] },
  { lang: 'ru', weight: 3, keywords: ['llms.txt', 'цитирование нейросетями'] },
  { lang: 'en', weight: 3, keywords: ['show up in chatgpt', 'get cited by chatgpt'] },
  { lang: 'ru', weight: 3, keywords: ['как попасть в ответы нейросетей', 'сайт в выдаче нейросети'] },
  { lang: 'en', weight: 2, keywords: ['ai seo tool', 'answer engine optimization'] },
  { lang: 'ru', weight: 2, keywords: ['оптимизация под нейросети', 'продвижение сайта в нейросетях'] },
];

/** Запросы к Hacker News. Английские: русского там нет. Тоже чередуются, но это ничего не стоит. */
const HN_QUERIES = [
  'llms.txt',
  'AI search visibility',
  'cited by ChatGPT',
  'answer engine optimization',
  'AI crawler blocked robots.txt',
  'generative engine optimization',
];

/** Просьба о совете: именно она превращает ветку в лида, а не упоминание темы. */
const ASKING = /\?|recommend|suggest|which|what (do|are|tool)|anyone (know|use)|looking for|help me|посовет|подскаж|кто.{0,12}(знает|польз)|ищу|какие|что использ|скидывай/i;
/** Реклама и раздачи: в такие ветки мы не лезем. */
const NOISE = /free trial|discount|promo code|giveaway|dm me|link in bio|подпишись|розыгрыш|скидка|бесплатно раздаю/i;
/*
 * Тема. Без этого сита радар приносил смм-фрилансеров: поиск по фразе «продвижение в нейросетях»
 * отдаёт всё, где есть слово «продвижение». Пост обязан говорить о том, в чём мы правда полезны:
 * видимость сайта для ответных систем, файлы, которые они читают, и цитирование.
 */
const TOPIC = /llms\.?txt|robots\.?txt|chatgpt|perplexity|claude|gemini|copilot|ai search|ai seo|answer engine|generative engine|\bgeo\b|cite|citation|crawler|schema|нейросет|ии.?поиск|ассистент|цитир|индексац|видимость сайта|поисков\w* робот/i;
/** Кто ищет исполнителя, а не решение: их ветки не наши. */
const HIRING = /ищу (смм|smm|специалист|подрядчик|таргет)|hiring|for hire|available for work|ведение (инстаграм|соцсет)|мои услуги/i;

const clean = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Код поста из числового id: тем же способом, что у Instagram, иначе ссылку не собрать. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function postUrl(id, author) {
  try {
    let n = BigInt(String(id)); let s = '';
    while (n > 0n) { s = ALPHABET[Number(n % 64n)] + s; n /= 64n; }
    return `https://www.threads.com/@${author}/post/${s}`;
  } catch { return `https://www.threads.com/@${author}`; }
}

/** Насколько ветка живая: отклики важнее лайков, свежесть важнее всего. */
export function score({ replies = 0, likes = 0, createdAt = 0, text = '' }, weight = 1) {
  const hours = Math.max(0.5, (Date.now() / 1000 - Number(createdAt)) / 3600);
  const heat = (Number(replies) * 3 + Number(likes)) / hours;
  const asks = ASKING.test(String(text)) ? 2 : 0;
  return Math.round((heat + asks) * weight * 10) / 10;
}

/** Черновик ответа: сначала польза, потом кто мы, ссылка одна и последней. */
export function draft(text, lang) {
  const ru = lang === 'ru';
  const t = String(text || '').toLowerCase();
  const about = /llms|robots|crawler|индекс|робот/.test(t) ? 'files' : /chatgpt|perplexity|claude|нейросет|ассистент/.test(t) ? 'visibility' : 'tools';
  if (ru) {
    const start = {
      files: 'Первое, что стоит открыть, это ваш-сайт.ру/robots.txt: одна строка Disallow там закрывает сразу всех роботов ответных систем, и дальше уже неважно, что написано на страницах.',
      visibility: 'Попасть в ответ помощника решают пять вещей: пускает ли сайт роботов, есть ли llms.txt, называет ли разметка ваш вид деятельности, есть ли короткий абзац, который можно процитировать, и есть ли даты с источниками.',
      tools: 'Из бесплатного: посмотрите robots.txt на предмет запретов для OAI-SearchBot и ChatGPT-User, это самая частая причина невидимости, и проверяется за минуту.',
    }[about];
    return `${start}\n\nМы сделали бесплатную проверку, которая меряет всё это разом и даёт балл из 100 без регистрации, это наш инструмент: https://oper-stack.ru/ai-visibility/`;
  }
  const start = {
    files: 'First thing to open is yoursite.com/robots.txt: one Disallow line there closes the answer-engine fetchers, and after that nothing on the pages matters.',
    visibility: 'Five things decide whether an assistant can quote you: crawler access, a map at /llms.txt, markup that names what you actually do, a short quotable opening paragraph, and dates with named sources.',
    tools: 'Free first step: check robots.txt for Disallow lines naming OAI-SearchBot and ChatGPT-User. That is the most common reason a site is invisible and it takes a minute.',
  }[about];
  return `${start}\n\nWe built a free check that measures all of it at once and gives a score out of 100 with no signup, our own tool: https://oper-stack.com/ai-visibility/`;
}

/**
 * Сколько Apify списал за текущий расчётный период. Поле usageUsd из /users/me тут не годится:
 * оно показывает ноль, пока трата покрывается бесплатным кредитом, то есть ровно в нашем случае.
 */
export async function apifySpend(token) {
  const r = await fetch(`https://api.apify.com/v2/users/me/usage/monthly?token=${token}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Apify не отдал расход: ${r.status}`);
  const d = (await r.json())?.data || {};
  const spent = Number(d.totalUsageCreditsUsdBeforeVolumeDiscount || 0);
  const until = String(d?.usageCycle?.endAt || '').slice(0, 10);
  return { spent, until };
}

/*
 * Hacker News: публичный поиск Algolia, ключ не нужен, ограничений по частоте для нас нет.
 * Окно тут неделя, а не сутки, и это не ошибка. Замер 15.09.2026: по нашим шести запросам за
 * последние двое суток нашлось ноль подходящих веток, а за неделю несколько штук. Тема даёт
 * единицы обсуждений в неделю, а не в час. Повторов не будет: каждый id мы показываем один раз,
 * так что широкое окно это просто страховка, чтобы не пропустить ветку между проходами.
 */
async function searchHackerNews(query, hours = HN_HOURS) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=(story,comment)&numericFilters=created_at_i>${since}&hitsPerPage=30`;
  const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`Hacker News ответил ${r.status}`);
  const hits = (await r.json())?.hits || [];
  return hits.map((h) => ({
    source: 'hn',
    lang: 'en',
    id: String(h.objectID),
    author: h.author || '',
    text: clean(h.title || h.comment_text || h.story_title || ''),
    replies: Number(h.num_comments || 0),
    likes: Number(h.points || 0),
    createdAt: Number(h.created_at_i || 0),
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
  }));
}

/** Threads: платный актор Apify, 0,008 $ за запись. */
async function searchThreads(keywords, token, limit) {
  const r = await fetch(`https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${token}&maxItems=${limit}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keywords, maxItems: limit }), signal: AbortSignal.timeout(300000),
  });
  if (!r.ok) throw new Error(`Apify ответил ${r.status}`);
  const items = await r.json();
  return (Array.isArray(items) ? items : []).filter((p) => p && p.id && !p.is_repost).map((p) => ({
    source: 'threads',
    id: String(p.id),
    author: p.author || '',
    text: clean(p.text),
    replies: Number(p.reply_count || 0),
    likes: Number(p.like_count || 0),
    createdAt: Number(p.created_at || 0),
    url: postUrl(p.id, p.author),
  }));
}

/*
 * Общее сито: тема обязательна, дальше нужен признак живой ветки, и без рекламы и найма.
 * Признаком считаем вопрос, отклики или очки: у комментария Hacker News своих откликов нет,
 * и по одному только числу ответов он всегда отсеивался бы.
 */
export function keep(p, maxHours = 168) {
  const t = p.text || '';
  if (!t || NOISE.test(t) || HIRING.test(t)) return false;
  if (!TOPIC.test(t)) return false;
  if (!(ASKING.test(t) || Number(p.replies) >= 5 || Number(p.likes) >= 5)) return false;
  return (Date.now() / 1000 - Number(p.createdAt)) < maxHours * 3600;
}

async function telegram(text) {
  const token = env('TG_TOKEN'); const chat = env('TG_CHAT_ID');
  if (DRY || !token || !chat) { log(`\n[в Telegram ушло бы]\n${text}`); return; }
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(15000),
  }).catch((e) => console.error('telegram:', e.message));
}

async function main() {
  const hour = new Date().getUTCHours();
  const forced = Number(env('RADAR_GROUP', '-1'));
  const pick = forced >= 0 ? forced : hour;
  const found = [];
  const notes = [];

  if (SOURCE === 'hn' || SOURCE === 'all') {
    const q = HN_QUERIES[pick % HN_QUERIES.length];
    log(`Hacker News, запрос: ${q}`);
    const hits = await searchHackerNews(q);
    log(`  получено ${hits.length}, бесплатно`);
    found.push(...hits.map((p) => ({ ...p, words: q, weight: 3 })));
  }

  if (SOURCE === 'threads' || SOURCE === 'all') {
    const token = env('APIFY_TOKEN');
    if (!token) {
      notes.push('Threads пропущен: нет APIFY_TOKEN.');
    } else {
      const { spent, until } = await apifySpend(token);
      const cost = PER_RUN * 0.008;
      log(`Apify: потрачено $${spent.toFixed(2)} из 5 до ${until}, проход стоит $${cost.toFixed(3)}`);
      if (spent + cost > BUDGET_STOP) {
        notes.push(`Threads остановлен: на Apify $${spent.toFixed(2)} из 5, порог $${BUDGET_STOP}. Возобновится после ${until} или после пополнения.`);
        log(`  пропуск: порог $${BUDGET_STOP}`);
      } else {
        const group = GROUPS[pick % GROUPS.length];
        log(`Threads, группа: ${group.lang}, слова: ${group.keywords.join(' | ')}`);
        const hits = await searchThreads(group.keywords, token, PER_RUN);
        log(`  получено ${hits.length} (около $${(hits.length * 0.008).toFixed(3)})`);
        found.push(...hits.map((p) => ({ ...p, lang: group.lang, words: group.keywords.join(' | '), weight: group.weight })));
      }
    }
  }

  let seen = new Set();
  if (!DRY) {
    await ensureSheet(SHEET, HEADER);
    const rows = await readRows(`${SHEET}!C2:C`);
    seen = new Set(rows.map((r) => String(r[0] || '').trim()));
  }

  const fresh = found
    .filter((p) => !seen.has(p.id))
    .filter((p) => keep(p, p.source === 'threads' ? 48 : HN_HOURS))
    .map((p) => ({ ...p, _score: score(p, p.weight) }))
    .sort((a, b) => b._score - a._score);

  log(`после отсева осталось: ${fresh.length} из ${found.length}`);
  const top = fresh.slice(0, 3);

  if (!top.length) {
    log('показывать нечего');
    for (const n of notes) log(n);
    // Про остановку по деньгам сказать надо, тишина тут читается как «всё работает».
    if (notes.length) await telegram(`🛑 Радар веток: ${notes.join(' ')}`);
    return;
  }

  const lines = ['🔎 Радар веток.', ''];
  for (const p of top) {
    const hours = Math.max(1, Math.round((Date.now() / 1000 - Number(p.createdAt)) / 3600));
    const where = p.source === 'hn' ? 'Hacker News' : 'Threads';
    lines.push(`• ${where}, @${p.author}, ${hours} ч назад, откликов ${p.replies}, очков ${p.likes}, оценка ${p._score}`);
    lines.push(p.text.slice(0, 220));
    lines.push(p.url);
    lines.push('');
    lines.push('Черновик ответа:');
    lines.push(draft(p.text, p.lang));
    lines.push('');
  }
  if (notes.length) lines.push(notes.join(' '), '');
  lines.push('Отвечаете вы сами: одна ветка, один ответ, сначала польза и сразу честно, что инструмент наш.');
  await telegram(lines.join('\n'));

  if (!DRY) {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await appendRows(SHEET, top.map((p) => [now, p.source, p.id, p.author, p.url, String(p._score), p.words, 'да']));
  }
  log(`отправлено в Telegram: ${top.length}`);
}

const RUN_AS_PROGRAM = process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname;
if (RUN_AS_PROGRAM) main().catch(async (e) => { console.error(e.message); await telegram(`⚠️ Радар веток упал: ${e.message}`); process.exit(1); });
