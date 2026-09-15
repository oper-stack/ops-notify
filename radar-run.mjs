#!/usr/bin/env node
/**
 * Радар веток: где прямо сейчас есть разговор, в который нам уместно зайти.
 *
 * Простым языком. Ловим два разных случая, и это две разные продажи.
 *
 *   «спрашивают про нас»  Человек уже знает про llms.txt, роботов ИИ и цитирование и что-то
 *                         спрашивает. Отвечаем по существу, ссылку даём последней.
 *   «только что собрал»   Человек выложил сайт, сделанный быстро и часто через нейросеть, и
 *                         радуется запуску. Он не знает, что помощники его сайт не видят. Это
 *                         и есть тот случай, который в ленте попадается чаще всего.
 *
 * Для второго случая мы тут же прогоняем его сайт нашей же бесплатной проверкой и кладём балл
 * в сводку. Тогда заходить в ветку можно с фактом, а не с рекламой: «у вас 41 из 100, слабое
 * место такое-то». Проверка своя и стоит ноль.
 *
 * Отвечает человек. Скрипт не публикует ничего и не может: на площадки мы заходим руками.
 *
 * Все источники бесплатные и ни один не просит ни ключа, ни аккаунта. Проверено 15.09.2026 в том
 * числе с серверов GitHub, потому что Bluesky и Reddit отдают 403 и оттуда тоже.
 *
 *   Mastodon   открытая лента по тегу, любой сервер. Тут живут #vibecoding и #buildinpublic.
 *   Hacker News поиск Algolia. Тут спрашивают про llms.txt по существу.
 *   Lemmy      открытый поиск по сообществам.
 *   Habr       поиск лентой, русский язык.
 *
 * Threads в коде остался, но по умолчанию выключен: он платный, 0,008 $ за запись.
 *
 *   node radar-run.mjs             один проход по расписанию
 *   node radar-run.mjs --dry-run   найти и показать, ничего не писать и не запоминать
 *
 * Env: TG_TOKEN, TG_CHAT_ID, SHEETS_SA_EMAIL, SHEETS_SA_KEY, FREE_CHECKS_SHEET_ID.
 * Платный источник: APIFY_TOKEN и RADAR_SOURCE=all.
 * Ручки: RADAR_SOURCE, RADAR_GROUP, RADAR_MAX_CHECKS, RADAR_BUDGET_STOP.
 */
import { VISIBILITY_DEFAULTS, checkVisibility } from '@operstack/audit';
import { appendRows, ensureSheet, readRows } from './sheets.mjs';

const env = (k, d = '') => String(process.env[k] ?? d).trim();
const DRY = process.argv.includes('--dry-run');
const log = (...a) => console.log(...a);

const SHEET = 'Радар';
const HEADER = ['Найдено', 'Площадка', 'id поста', 'Автор', 'Ссылка', 'Оценка', 'Слова', 'Отправлено'];
/** Что берём в этот проход. Платный Threads включается только явным `all`. */
const SOURCE = env('RADAR_SOURCE', 'free').toLowerCase();
/** Сколько чужих сайтов прогоняем своей проверкой за проход. Своё, бесплатное, но не мгновенное. */
const MAX_CHECKS = Number(env('RADAR_MAX_CHECKS', '3')) || 3;
/** Порог расхода Apify, если платный источник всё же включили. */
const BUDGET_STOP = Number(env('RADAR_BUDGET_STOP', '4.8')) || 4.8;

/* --------------------------- что ищем --------------------------- */

/** Теги Mastodon. Чередуются по часам: за проход берём одну пачку, чтобы проход был быстрый. */
const TAG_GROUPS = [
  ['vibecoding', 'buildinpublic', 'indiehackers'],
  ['llms', 'aiseo', 'seo'],
  ['webdev', 'launched', 'showyourwork'],
  ['vibecoding', 'saas', 'sideproject'],
];
/** Сервера Mastodon: лента по тегу у каждого своя, поэтому берём несколько. */
const MASTODON_HOSTS = ['mastodon.social', 'fosstodon.org', 'hachyderm.io'];
const HN_QUERIES = ['llms.txt', 'AI search visibility', 'cited by ChatGPT', 'answer engine optimization'];
const LEMMY_QUERIES = ['llms.txt', 'vibecoding', 'AI crawler', 'built with AI'];
const HABR_QUERIES = ['llms.txt', 'нейросети выдача сайт', 'продвижение в нейросетях', 'ИИ поиск сайт'];

/*
 * Наша тема напрямую. Сито тут нарочно узкое и составное. Первая версия ловила любое слово
 * вроде claude или chatgpt, и 15.09.2026 притащила японский пост «сделал приложение на Claude
 * Code»: тема ИИ есть, нашей темы нет. Поэтому одного упоминания помощника мало, рядом должно
 * стоять слово про видимость, чтение сайта роботом или цитирование.
 */
const TOPIC = new RegExp([
  'llms\\.?txt', 'robots\\.?txt', 'ai crawler', 'answer engine', 'generative engine',
  'ai seo', 'ai visibility', 'ai search (results?|visibility|optimi)',
  '(cited|quoted|indexed|ranked|appear|show up|showing up|visible) [^.]{0,30}(chatgpt|perplexity|gemini|copilot|ai (search|answers?|assistants?)|llms?)',
  '(chatgpt|perplexity|gemini|copilot)[^.]{0,30}(cite|quote|index|crawl|read my|find my|see my)',
  'нейросет\\w*[^.]{0,30}(выдач|ответ|цитир|виден|видимост|не вид|читa?ет)',
  '(цитир|видимост|индексац)\\w*[^.]{0,30}нейросет',
  'продвижени\\w*[^.]{0,20}(в )?нейросет', 'ии.?поиск',
].join('|'), 'i');
/** Только что собрал и выложил: наш второй, более частый случай. */
const SHIPPED = /vibe.?cod|build(ing)? in public|buildinpublic|just (launched|shipped|built|deployed)|launch(ed|ing) (my|our)|shipped (my|our)|my new (site|website|app|landing)|went live|ship it|indie ?hacker|side ?project|собрал сайт|запустил сайт|выкатил|мой новый сайт/i;
/*
 * Первое лицо. Для случая «только что собрал» это главная проверка: нам нужен автор сайта, а не
 * пересказ чужой новости. 15.09.2026 без неё в сводку попал бот-агрегатор, который просто носит
 * ссылки с Lobsters, и его «сайтом» оказалась случайная ссылка из чужой статьи.
 */
const FIRST_PERSON = /\b(i|i'?ve|i'?m|my|we|we'?ve|our)\b|\b(я|мой|моё|моя|мы|наш|нашу|наше)\b/i;
/** Аккаунты, которые только носят чужие ссылки. Свой сайт они не выкладывают. */
const FEED_BOTS = /^(lobsters|curatedhackernews|hackaday|inautilo|hackernews|newsbot|rss)/i;

/** Просьба о совете: поднимает оценку, но не обязательна. */
const ASKING = /\?|recommend|suggest|which|what (do|are|tool)|anyone (know|use)|looking for|feedback|посовет|подскаж|ищу|какие|что использ/i;
/** Реклама, раздачи и найм: туда не лезем. */
const NOISE = /free trial|discount|promo code|giveaway|dm me|link in bio|crypto|airdrop|подпишись|розыгрыш|бесплатно раздаю/i;
const HIRING = /hiring|for hire|available for work|ищу (смм|smm|специалист|подрядчик|таргет)|мои услуги/i;

/** Ссылки, которые не являются «его сайтом»: платформы, соцсети, хранилища кода. */
const NOT_A_SITE = /(^|\.)(mastodon\.\w+|fosstodon\.org|hachyderm\.io|lemmy\.\w+|programming\.dev|news\.ycombinator\.com|habr\.com|github\.com|gitlab\.com|x\.com|twitter\.com|t\.co|threads\.(net|com)|bsky\.app|youtube\.com|youtu\.be|medium\.com|linkedin\.com|reddit\.com|producthunt\.com|figma\.com|notion\.so|substack\.com|devpost\.com|itch\.io|gumroad\.com|patreon\.com|ko-fi\.com|apps\.apple\.com|play\.google\.com|npmjs\.com|codeberg\.org|sourcehut\.org|sr\.ht)$/i;

const clean = (s) => String(s || '')
  .replace(/<br\s*\/?>/gi, ' ').replace(/<\/p>/gi, ' ').replace(/<[^>]*>/g, ' ')
  .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>')
  .replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** Все адреса из разметки поста. Из очищенного текста их брать нельзя, см. siteFrom. */
export function linksFrom(html) {
  return [...String(html || '').matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

/*
 * Адрес его собственного сайта, если он там есть.
 *
 * Ссылки приходят отдельным списком, а не из текста, и это важно. Mastodon рисует адрес двумя
 * кусками разметки, чтобы показать его коротко, и после вырезания тегов от «https://www.site.ru»
 * остаётся «https://www. site.ru» с пробелом посередине. 15.09.2026 из-за этого не прошёл ни один
 * пост про свежий запуск: адрес был, а разобрать его не получалось.
 */
export function siteFrom(text, links = [], post = {}) {
  // Сервер, с которого человек пишет, его сайтом не является: flipboard.social это не продукт.
  const own = new Set();
  for (const src of [post.url, post.author?.includes('@') ? `https://${post.author.split('@').pop()}` : '']) {
    try { if (src) own.add(new URL(src).hostname.replace(/^www\./, '')); } catch { /* пропускаем */ }
  }
  const candidates = [...links, ...(String(text || '').match(/https?:\/\/[^\s"'<>)\]]+/g) || [])];
  for (const raw of candidates) {
    try {
      const u = new URL(raw);
      const host = u.hostname.replace(/^www\./, '');
      if (NOT_A_SITE.test(host) || own.has(host)) continue;
      if (!host.includes('.')) continue;
      // Сервера федерации: узнаются и по хвосту, и по первому слову в имени. social.nlnet.nl
      // это тоже Mastodon, а не чей-то продукт, поэтому одного хвоста мало.
      if (/\.(social|town|zone|cafe|club)$/i.test(host)) continue;
      if (/^(social|mastodon|mas|toot|fediverse|pleroma|misskey|m)\./i.test(host)) continue;
      return `${u.protocol}//${u.hostname}`;
    } catch { /* мусорная ссылка, пропускаем */ }
  }
  return '';
}

/*
 * Ключ, по которому пост считается тем же самым. Местный id не годится: одна и та же запись
 * приходит с трёх серверов Mastodon под тремя разными id, и 15.09.2026 сводка вышла из одного
 * поста, повторённого трижды. Общий у них канонический адрес, по нему и сверяем.
 */
export function dedupeKey(p) {
  try {
    const u = new URL(p.url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`;
  } catch { return p.id; }
}

/** Насколько ветка живая: отклики важнее лайков, свежесть важнее всего. */
export function score({ replies = 0, likes = 0, createdAt = 0, text = '' }, weight = 1) {
  const hours = Math.max(0.5, (Date.now() / 1000 - Number(createdAt)) / 3600);
  const heat = (Number(replies) * 3 + Number(likes)) / hours;
  const asks = ASKING.test(String(text)) ? 2 : 0;
  return Math.round((heat + asks) * weight * 10) / 10;
}

/* --------------------------- источники --------------------------- */

const getJson = async (url, ms = 25000) => {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'operstack-radar/1.0' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${new URL(url).hostname} ответил ${r.status}`);
  return r.json();
};
const secs = (iso) => Math.floor(new Date(iso).getTime() / 1000) || 0;

async function fromMastodon(tags) {
  const out = [];
  for (const host of MASTODON_HOSTS) {
    for (const tag of tags) {
      try {
        const posts = await getJson(`https://${host}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=30`);
        for (const p of posts || []) {
          if (p.reblog) continue;
          // Отвечаем мы только по-русски и по-английски. Пост на японском это не наша ветка.
          if (p.language && !['ru', 'en'].includes(p.language)) continue;
          out.push({
            source: 'mastodon', lang: p.language === 'ru' ? 'ru' : 'en',
            id: `mastodon:${p.id}`, author: p.account?.acct || '', text: clean(p.content),
            replies: Number(p.replies_count || 0), likes: Number(p.favourites_count || 0) + Number(p.reblogs_count || 0),
            createdAt: secs(p.created_at), url: p.url || p.uri || '', words: `#${tag}`,
            links: [...linksFrom(p.content), ...(p.card?.url ? [p.card.url] : [])],
          });
        }
      } catch (e) { log(`  mastodon ${host}/${tag}: ${e.message}`); }
    }
  }
  return out;
}

async function fromHackerNews(query, hours = 168) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const d = await getJson(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=(story,comment)&numericFilters=created_at_i%3E${since}&hitsPerPage=30`);
  return (d.hits || []).map((h) => ({
    source: 'hn', lang: 'en', id: `hn:${h.objectID}`, author: h.author || '',
    text: clean(h.title || h.comment_text || ''), replies: Number(h.num_comments || 0),
    likes: Number(h.points || 0), createdAt: Number(h.created_at_i || 0),
    url: `https://news.ycombinator.com/item?id=${h.objectID}`, words: query,
  }));
}

async function fromLemmy(query) {
  const d = await getJson(`https://lemmy.world/api/v3/search?q=${encodeURIComponent(query)}&type_=Posts&sort=New&limit=20`);
  return (d.posts || []).map((x) => ({
    source: 'lemmy', lang: 'en', id: `lemmy:${x.post?.id}`, author: x.creator?.name || '',
    text: clean(`${x.post?.name || ''} ${x.post?.body || ''} ${x.post?.url || ''}`),
    replies: Number(x.counts?.comments || 0), likes: Number(x.counts?.score || 0),
    createdAt: secs(x.post?.published), url: x.post?.ap_id || '', words: query,
  }));
}

async function fromHabr(query) {
  const r = await fetch(`https://habr.com/ru/rss/search/?q=${encodeURIComponent(query)}&target_type=posts&order=date`, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`habr ответил ${r.status}`);
  const xml = await r.text();
  return (xml.match(/<item>([\s\S]*?)<\/item>/g) || []).map((it) => {
    const pick = (t) => (it.match(new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`)) || [])[1] || '';
    const link = pick('link');
    return {
      source: 'habr', lang: 'ru', id: `habr:${link.split('/').filter(Boolean).pop() || link}`,
      author: clean(pick('dc:creator')), text: clean(`${pick('title')} ${pick('description')}`),
      replies: 0, likes: 0, createdAt: Math.floor(new Date(pick('pubDate')).getTime() / 1000) || 0,
      url: link, words: query,
    };
  });
}

async function fromThreads(keywords, token, limit) {
  const r = await fetch(`https://api.apify.com/v2/acts/watcher.data~search-threads-by-keywords/run-sync-get-dataset-items?token=${token}&maxItems=${limit}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keywords, maxItems: limit }), signal: AbortSignal.timeout(300000),
  });
  if (!r.ok) throw new Error(`Apify ответил ${r.status}`);
  const items = await r.json();
  return (Array.isArray(items) ? items : []).filter((p) => p?.id && !p.is_repost).map((p) => ({
    source: 'threads', lang: 'en', id: `threads:${p.id}`, author: p.author || '', text: clean(p.text),
    replies: Number(p.reply_count || 0), likes: Number(p.like_count || 0),
    createdAt: Number(p.created_at || 0), url: `https://www.threads.com/@${p.author}`, words: keywords.join(' | '),
  }));
}

/**
 * Настоящий расход Apify. Поле usageUsd из /users/me тут не годится: оно показывает ноль, пока
 * трата покрыта бесплатным кредитом, то есть ровно в нашем случае.
 */
export async function apifySpend(token) {
  const d = (await getJson(`https://api.apify.com/v2/users/me/usage/monthly?token=${token}`, 20000))?.data || {};
  return { spent: Number(d.totalUsageCreditsUsdBeforeVolumeDiscount || 0), until: String(d?.usageCycle?.endAt || '').slice(0, 10) };
}

/* --------------------------- отбор и ответ --------------------------- */

/** Что это за случай: наша тема, свежий запуск с сайтом, или мимо. */
export function classify(p) {
  const t = p.text || '';
  if (!t || NOISE.test(t) || HIRING.test(t)) return null;
  if (FEED_BOTS.test(String(p.author || ''))) return null;
  // Лента живёт часами, статьи днями. Заходить в ленту через неделю уже поздно и неуместно.
  const maxHours = p.source === 'mastodon' || p.source === 'threads' ? 48 : 168;
  if ((Date.now() / 1000 - Number(p.createdAt)) > maxHours * 3600) return null;
  if (TOPIC.test(t)) return 'topic';
  // Запуск без ссылки на сайт нам бесполезен: проверять нечего и говорить не о чем.
  // И это должен быть его сайт, поэтому требуем первого лица.
  if (SHIPPED.test(t) && FIRST_PERSON.test(t) && siteFrom(t, p.links, p)) return 'shipped';
  return null;
}

/** Черновик ответа. Сначала польза, потом кто мы, ссылка одна и последней. */
export function draft(p, check) {
  const ru = p.lang === 'ru';
  const site = ru ? 'https://oper-stack.ru/ai-visibility/' : 'https://oper-stack.com/ai-visibility/';
  if (p.kind === 'shipped') {
    const weak = check?.ok ? (check.areas || []).filter((a) => a.score != null).sort((a, b) => a.score / a.max - b.score / b.max)[0] : null;
    if (ru) {
      const fact = check?.ok
        ? `Прогнал ваш сайт нашей бесплатной проверкой: ${check.score} из 100, слабее всего «${weak?.label || ''}».`
        : 'Проверить это можно за минуту и бесплатно.';
      return `Поздравляю с запуском. Одна вещь, которая теряется, когда сайт собран быстро: помощники вроде ChatGPT и Perplexity часто такой сайт просто не читают, и в их ответах его нет. Решают три файла и один абзац, а не переделка дизайна.\n\n${fact} Инструмент наш, регистрации не просит: ${site}`;
    }
    const fact = check?.ok
      ? `I ran it through our free check: ${check.score} out of 100, weakest area is "${weak?.label || ''}".`
      : 'It takes a minute to check and costs nothing.';
    return `Congrats on shipping. One thing that gets lost when a site goes up fast: assistants like ChatGPT and Perplexity often cannot read it at all, so it never shows up in their answers. It comes down to three files and one paragraph, not a redesign.\n\n${fact} The tool is ours and asks for no signup: ${site}`;
  }
  const t = (p.text || '').toLowerCase();
  const about = /llms|robots|crawler|индекс|робот/.test(t) ? 'files' : /chatgpt|perplexity|claude|нейросет|ассистент/.test(t) ? 'visibility' : 'tools';
  if (ru) {
    const start = {
      files: 'Первое, что стоит открыть, это ваш-сайт.ру/robots.txt: одна строка Disallow там закрывает сразу всех роботов ответных систем, и дальше уже неважно, что написано на страницах.',
      visibility: 'Попасть в ответ помощника решают пять вещей: пускает ли сайт роботов, есть ли llms.txt, называет ли разметка ваш вид деятельности, есть ли короткий абзац, который можно процитировать, и есть ли даты с источниками.',
      tools: 'Из бесплатного: посмотрите robots.txt на предмет запретов для OAI-SearchBot и ChatGPT-User, это самая частая причина невидимости, и проверяется за минуту.',
    }[about];
    return `${start}\n\nМы сделали бесплатную проверку, которая меряет всё это разом и даёт балл из 100 без регистрации, это наш инструмент: ${site}`;
  }
  const start = {
    files: 'First thing to open is yoursite.com/robots.txt: one Disallow line there closes the answer-engine fetchers, and after that nothing on the pages matters.',
    visibility: 'Five things decide whether an assistant can quote you: crawler access, a map at /llms.txt, markup that names what you actually do, a short quotable opening paragraph, and dates with named sources.',
    tools: 'Free first step: check robots.txt for Disallow lines naming OAI-SearchBot and ChatGPT-User. That is the most common reason a site is invisible and it takes a minute.',
  }[about];
  return `${start}\n\nWe built a free check that measures all of it at once and gives a score out of 100 with no signup, our own tool: ${site}`;
}

async function telegram(text) {
  const token = env('TG_TOKEN'); const chat = env('TG_CHAT_ID');
  if (DRY || !token || !chat) { log(`\n[в Telegram ушло бы]\n${text}`); return; }
  for (const chunk of String(text).match(/[\s\S]{1,3900}/g) || []) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: chunk, disable_web_page_preview: true }), signal: AbortSignal.timeout(15000),
    }).catch((e) => console.error('telegram:', e.message));
  }
}

/* --------------------------- проход --------------------------- */

async function main() {
  const forced = Number(env('RADAR_GROUP', '-1'));
  const pick = forced >= 0 ? forced : new Date().getUTCHours();
  const found = [];
  const notes = [];

  const gather = async (name, fn) => {
    try { const r = await fn(); log(`  ${name}: ${r.length}`); found.push(...r); }
    catch (e) { log(`  ${name}: ${e.message}`); }
  };

  log('бесплатные источники:');
  await gather('mastodon', () => fromMastodon(TAG_GROUPS[pick % TAG_GROUPS.length]));
  await gather('hacker news', () => fromHackerNews(HN_QUERIES[pick % HN_QUERIES.length]));
  await gather('lemmy', () => fromLemmy(LEMMY_QUERIES[pick % LEMMY_QUERIES.length]));
  await gather('habr', () => fromHabr(HABR_QUERIES[pick % HABR_QUERIES.length]));

  if (SOURCE === 'all' || SOURCE === 'threads') {
    const token = env('APIFY_TOKEN');
    if (!token) notes.push('Threads пропущен: нет APIFY_TOKEN.');
    else {
      const { spent, until } = await apifySpend(token);
      if (spent + 0.024 > BUDGET_STOP) notes.push(`Threads остановлен: на Apify $${spent.toFixed(2)} из 5, порог $${BUDGET_STOP}, до ${until}.`);
      else await gather('threads (платно)', () => fromThreads(['llms.txt', 'ai visibility'], token, 3));
    }
  }

  let seen = new Set();
  if (!DRY) {
    await ensureSheet(SHEET, HEADER);
    seen = new Set((await readRows(`${SHEET}!C2:C`)).map((r) => String(r[0] || '').trim()));
  }

  const byKey = new Map();
  for (const p of found) { const k = dedupeKey(p); if (!byKey.has(k)) byKey.set(k, p); }
  const fresh = [...byKey.values()]
    .filter((p) => p.id && !seen.has(p.id) && !seen.has(dedupeKey(p)))
    .map((p) => ({ ...p, kind: classify(p) }))
    .filter((p) => p.kind)
    .map((p) => ({ ...p, site: siteFrom(p.text, p.links, p), _score: score(p) + (p.kind === 'shipped' ? 3 : 0) }))
    .sort((a, b) => b._score - a._score);

  log(`после отсева осталось: ${fresh.length} из ${found.length}`);
  if (!fresh.length) {
    for (const n of notes) log(n);
    if (notes.length) await telegram(`🛑 Радар веток: ${notes.join(' ')}`);
    log('показывать нечего');
    return;
  }

  /*
   * Кого показывать первым. Среди свежих запусков берём не самый шумный пост, а самый слабый
   * сайт: человеку с баллом 84 наша проверка ничего не откроет, а человеку с 30 открывает всё.
   * Поэтому сначала меряем несколько кандидатов своей же бесплатной проверкой, а потом сортируем
   * по баллу снизу вверх. Проверка своя, стоит ноль, ограничиваем только ради времени прохода.
   */
  const shipped = fresh.filter((p) => p.kind === 'shipped');
  const topical = fresh.filter((p) => p.kind === 'topic');
  for (const p of shipped.slice(0, MAX_CHECKS)) {
    try {
      p.check = await checkVisibility(p.site, { ...VISIBILITY_DEFAULTS, lang: p.lang === 'ru' ? 'ru' : 'en' });
      log(`  проверил ${p.site}: ${p.check?.ok ? `${p.check.score} из 100` : 'прочитать не удалось'}`);
    } catch (e) { log(`  проверка ${p.site} не вышла: ${e.message}`); }
  }
  const measured = shipped.filter((p) => p.check?.ok).sort((a, b) => a.check.score - b.check.score);
  const top = [...measured, ...topical, ...shipped.filter((p) => !p.check?.ok)].slice(0, 3);

  const lines = ['🔎 Радар веток.', ''];
  for (const p of top) {
    const hours = Math.max(1, Math.round((Date.now() / 1000 - Number(p.createdAt)) / 3600));
    const kind = p.kind === 'shipped' ? 'только что выложил сайт' : 'спрашивает по нашей теме';
    lines.push(`• ${p.source}, @${p.author}, ${hours} ч назад, ${kind}, оценка ${p._score}`);
    lines.push(p.text.slice(0, 220));
    if (p.site) lines.push(`его сайт: ${p.site}${p.check?.ok ? ` — ${p.check.score} из 100` : ''}`);
    lines.push(p.url);
    lines.push('', 'Черновик ответа:', draft(p, p.check), '');
  }
  if (notes.length) lines.push(notes.join(' '), '');
  lines.push('Отвечаете вы сами: одна ветка, один ответ, сначала польза и сразу честно, что инструмент наш.');
  await telegram(lines.join('\n'));

  if (!DRY) {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await appendRows(SHEET, top.map((p) => [now, p.source, dedupeKey(p), p.author, p.url, String(p._score), p.words, 'да']));
  }
  log(`отправлено в Telegram: ${top.length}`);
}

const RUN_AS_PROGRAM = process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname;
if (RUN_AS_PROGRAM) main().catch(async (e) => { console.error(e.message); await telegram(`⚠️ Радар веток упал: ${e.message}`); process.exit(1); });
