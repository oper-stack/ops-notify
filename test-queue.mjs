#!/usr/bin/env node
/**
 * Что очередь берёт в работу, а что отказывается брать.
 *
 * Здесь две вещи. Первая: заявка со списком сайтов после оплаты курса должна доезжать. Она
 * приходила в ящик с самого начала, а читать её было некому: очередь искала только заявки на
 * отчёт. Человек вставлял список, видел «готово» и не получал ничего.
 *
 * Вторая: подпись. Без неё кто угодно письмом заставил бы нас гонять аудиты и слать файлы на
 * любой адрес. Подделка должна отклоняться, а не выполняться.
 */
import { createHmac } from 'node:crypto';

process.env.KIT_DOWNLOAD_SECRET = 'секрет-для-проверки';
const { __parseJobForTests: parseJob } = await import('./report-watch.mjs');

let bad = 0;
const ok = (n, c) => { if (c) console.log(`ok   ${n}`); else { bad++; console.error(`FAIL ${n}`); } };
const is = (n, a, b) => ok(`${n} (ждали ${JSON.stringify(b)}, вышло ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));

/** Собираем письмо ровно так, как его собирает сайт. */
const body = (kind, job, secret = 'секрет-для-проверки') => {
  const payload = Buffer.from(JSON.stringify(job)).toString('base64url');
  return `${kind}-RUN v1 ${payload} ${createHmac('sha256', secret).update(payload).digest('base64url')}\n\nСлужебная заявка.`;
};

// ---- заявка со списком сайтов
{
  const job = { email: 'buyer@example.com', lang: 'ru', sites: [{ url: 'https://a.com/', name: 'A' }, { url: 'https://b.com/', name: 'B' }] };
  const got = parseJob(body('PROSPECT', job));
  is('список: вид заявки распознан', got.kind, 'prospect');
  is('список: почта на месте', got.email, 'buyer@example.com');
  is('список: сайты на месте', got.sites.length, 2);
  is('список: язык на месте', got.lang, 'ru');

  ok('список без сайтов не берётся', parseJob(body('PROSPECT', { email: 'x@y.com', sites: [] })).bad);
  ok('список без почты не берётся', parseJob(body('PROSPECT', { sites: [{ url: 'https://a.com/' }] })).bad);
  ok('чужая подпись на списке отклонена', parseJob(body('PROSPECT', job, 'чужой-секрет')).bad === 'подпись не сходится');

  // Оформление агентского плана едет вместе с заявкой и не должно теряться по дороге.
  const branded = parseJob(body('PROSPECT', { ...job, brand: { by: 'Агентство', color: '#1A8A7D', logo: 'https://a.com/logo.png' } }));
  is('оформление доезжает', branded.brand.by, 'Агентство');
}

// ---- заявка на отчёт: не сломалась от того, что рядом появилась вторая
{
  const job = { url: 'https://example.com/', email: 'buyer@example.com', lang: 'en', tier: 'free', visibility: { score: 46, areas: [] } };
  const got = parseJob(body('REPORT', job));
  is('отчёт: вид заявки распознан', got.kind, 'report');
  is('отчёт: адрес на месте', got.url, 'https://example.com/');
  is('отчёт: ступень на месте', got.tier, 'free');
  is('отчёт: результат проверки доезжает целиком', got.visibility.score, 46);
  ok('чужая подпись на отчёте отклонена', parseJob(body('REPORT', job, 'чужой-секрет')).bad === 'подпись не сходится');
  ok('письмо без заявки не заявка', parseJob('обычное письмо от человека') === null);
}

if (bad) { console.error(`\n${bad} тест(ов) упало`); process.exit(1); }
console.log('\nочередь берёт оба вида заявок и отклоняет подделки');
