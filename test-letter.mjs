#!/usr/bin/env node
/**
 * Письмо обязано называть ту же цифру, что страница проверки и первая страница отчёта.
 *
 * 14 сентября 2026 один сайт за один день получил 46 на странице, 61 в письме и шесть областей
 * из шестидесяти в приложенном PDF. Читатель делает единственный вывод: цифры выдуманы.
 * Здесь держится то, чтобы это не повторилось, и держится со стороны письма: в пакете свои
 * тесты, но именно письмо в тот раз и разошлось.
 *
 *   node test-letter.mjs              проверить
 *   node test-letter.mjs --preview    заодно положить письма в файлы, чтобы посмотреть глазами
 */
import { writeFileSync } from 'node:fs';
import { overallSummary } from '@operstack/audit';
import { buildLetter } from './report-run.mjs';

let bad = 0;
const ok = (n, c) => { if (c) console.log(`ok   ${n}`); else { bad++; console.error(`FAIL ${n}`); } };
const PREVIEW = process.argv.includes('--preview');

const AREAS = [
  { id: 'access', label: 'Can AI crawlers read it', score: 18, max: 25 },
  { id: 'index', label: 'Is there a map for agents (llms.txt)', score: 5, max: 15 },
  { id: 'entity', label: 'Is the entity clear (schema)', score: 12, max: 20 },
  { id: 'content', label: 'Is there something to quote', score: 20, max: 25 },
  { id: 'trust', label: 'Can it be dated and trusted', score: 8, max: 15 },
];
const OVERALL = {
  score: 63, grade: 'B', areas: AREAS, source: 'visibility:reused',
  measuredAt: '2026-09-14T20:00:00.000Z', basis: { pages: 4, sitemapRead: true, sitemapUnchecked: false },
};
const SCORES = { 'Technical SEO': 7, 'Content and on-page': 6, 'AEO and GEO': 4, 'Off-page and trust': null, 'Conversion and UX': 5, 'Structured data': 8 };
// Задача приходит из генератора уже на языке отчёта, поэтому и здесь она своя на каждый язык:
// иначе проверка «чужого языка нет» ловила бы сам этот образец, а не письмо.
const TASK = {
  ru: { now: 'На сайте нет llms.txt.', task: 'Положить llms.txt в корень.', verify: 'Открыть /llms.txt и увидеть список разделов.', rule: 'Правило: один файл, обычный текст.' },
  en: { now: 'The site has no llms.txt.', task: 'Put llms.txt at the root.', verify: 'Open /llms.txt and see the list of sections.', rule: 'Rule: one file, plain text.' },
};

const letter = (lang, free, head = overallSummary(OVERALL, { lang })) =>
  buildLetter({ host: 'example.com', lang, scores: SCORES, comparison: null, free, head, firstTask: free ? TASK[lang] : null });

for (const lang of ['ru', 'en']) {
  for (const free of [true, false]) {
    const tag = `${lang}/${free ? 'бесплатная' : 'платная'}`;
    const { text, html } = letter(lang, free);
    const head = overallSummary(OVERALL, { lang });

    // Главное: цифра в письме это цифра отчёта, и она одна на всё письмо.
    ok(`${tag}: балл назван`, text.includes(`${head.score}`) && html.includes(`>${head.score}<`));
    const hundreds = [...text.matchAll(/(\d{2,3}) (?:из|of) 100/g)].map((m) => Number(m[1]));
    ok(`${tag}: другого балла из ста в письме нет`, hundreds.length > 0 && hundreds.every((n) => n === head.score));

    // Пять областей складываются в заголовок руками: читатель может проверить.
    ok(`${tag}: пять областей на месте`, head.areas.every((a) => text.includes(`${a.label}: ${a.score} / ${a.max}`)));
    ok(`${tag}: они дают в сумме заголовок`, head.areas.reduce((s, a) => s + a.score, 0) === head.score);

    // Подпись под баллом это подпись из пакета, слово в слово.
    ok(`${tag}: подпись про происхождение балла`, text.includes(head.note));
    ok(`${tag}: сказано про разброс в пункт-другой`, lang === 'ru' ? /на пункт-другой/.test(text) : /a point or two/.test(text));

    // Шесть областей это второе измерение, и в письме это сказано словами.
    if (!free) {
      ok(`${tag}: шесть областей под своим подзаголовком`, text.indexOf(head.secondMeasure) < text.indexOf('Technical SEO'));
      ok(`${tag}: сказано, что складывать их с заголовком не надо`, text.includes(head.secondMeasureFoot));
      ok(`${tag}: непонятая область названа словами, а не нулём`, lang === 'ru' ? /не измерялось/.test(html) : /not measured/.test(html));
    } else {
      ok(`${tag}: шести областей в бесплатном письме нет`, !text.includes('Technical SEO'));
    }

    // Чужой язык в письме читается как небрежность и бьёт по доверию сильнее, чем кажется.
    ok(`${tag}: чужого языка нет`, lang === 'ru' ? !/point or two|of 100|not measured/.test(text) : !/[А-Яа-яЁё]/.test(text));

    if (PREVIEW) { const f = `/tmp/operstack-letter-${lang}-${free ? 'free' : 'paid'}.html`; writeFileSync(f, html); console.log(`     → ${f}`); }
  }
}

// Балла может не быть: движок отказывается мерить закрытые адреса. Тогда письмо не называет
// цифру вовсе. Подставить ноль значило бы сказать покупателю неправду про его сайт.
{
  const { text, html } = letter('ru', true, null);
  ok('без балла письмо не называет цифру', !/из 100/.test(text) && !/из 100/.test(html));
  ok('и всё равно доходит целиком', text.includes('Отчёт во вложении') && html.includes('OperStack'));
}

// Старая заявка принесла одну цифру без разбивки: письмо всё равно должно быть честным.
{
  const head = overallSummary({ score: 47, grade: 'C', areas: [], source: 'visibility:reused' }, { lang: 'ru' });
  const { text } = letter('ru', true, head);
  ok('старая заявка: цифра названа', /47 из 100/.test(text));
  ok('старая заявка: областей не выдумываем', !/\/ 25/.test(text));
}

if (bad) { console.error(`\n${bad} тест(ов) упало`); process.exit(1); }
console.log('\nписьмо и отчёт несут один балл');
