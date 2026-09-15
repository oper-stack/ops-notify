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
  ok('и всё равно доходит целиком', text.includes('Вот правка') && html.includes('OperStack'));
}

// Старая заявка принесла одну цифру без разбивки: письмо всё равно должно быть честным.
{
  const head = overallSummary({ score: 47, grade: 'C', areas: [], source: 'visibility:reused' }, { lang: 'ru' });
  const { text, html } = letter('ru', true, head);
  ok('старая заявка: цифра названа', /47 из 100/.test(text));
  ok('старая заявка: областей не выдумываем', !/\/ 25/.test(text));
  // Пустая таблица в письме выглядит как поломка вёрстки, а не как «данных нет».
  ok('старая заявка: пустой таблицы в письме нет', !/<table[^>]*>\s*<\/table>/.test(html) && !/border-bottom:1px solid[^>]*"><\/td>/.test(html));
}

// ---- область без балла: в письме слово, а не «null / 25» и не ноль
//
// С 0.19.0 движок не выдумывает оценку за непрочитанный robots.txt: область идёт без балла, а
// итог считается по остальным. Письмо обязано напечатать это словами на языке письма.
{
  const areasNull = AREAS.map((a) => (a.id === 'access' ? { ...a, score: null, measured: false } : a));
  const head = { ...overallSummary({ ...OVERALL, areas: areasNull, score: 60 }, { lang: 'ru' }), areas: areasNull.map((a) => ({ ...a, label: a.label })), notMeasured: 'не измерялось' };
  const { text, html } = buildLetter({ host: 'example.com', lang: 'ru', scores: SCORES, comparison: null, free: true, head, firstTask: TASK.ru });
  ok('область без балла названа словом в тексте', /Can AI crawlers read it: не измерялось/.test(text));
  ok('и в разметке', /не измерялось<\/td>/.test(html));
  ok('ни null, ни undefined в письмо не попали', !/null|undefined/.test(text) && !/null|undefined/.test(html));
  ok('остальные области напечатаны числом', /Is there something to quote: 20 \/ 25/.test(text));
}

// ---- бесплатное письмо: без PDF, и тема про правку, а не про отчёт
{
  const { subject, text } = letter('ru', true);
  ok('тема бесплатного письма про правку', /^Ваша первая правка: /.test(subject));
  ok('бесплатное письмо не обещает вложение', !/во вложении|attached/i.test(text));
  const en = letter('en', true);
  ok('английская тема про правку', /^Your first fix: /.test(en.subject));
  ok('платное письмо по-прежнему называется отчётом', /^Отчёт OperStack: /.test(letter('ru', false).subject));
}

// ---- цепочка писем после бесплатной проверки
//
// Цифру в цепочке берут из таблицы, а её строку могли поправить руками или запись могла не
// дойти. «Вчера example.com набрал  из 100» в холодном письме читается как небрежность, и
// второй раз человек не откроет. Поэтому без цифры предложение строится иначе, а не ломается.
{
  const EN = await import('./sequence.mjs');
  const RU = await import('./sequence.ru.mjs');
  const opts = { host: 'example.com', offerUrl: 'https://oper-stack.com/api/offer/?t=x', unsubUrl: 'https://oper-stack.com/api/unsubscribe/?t=x' };

  for (const [lang, M] of [['en', EN], ['ru', RU]]) {
    for (const [name, make] of [['2', M.letter2], ['4', M.letter4Owner], ['5', M.letter5]]) {
      const withScore = make({ ...opts, score: '46' });
      ok(`цепочка ${lang}/${name}: балл назван`, /46/.test(withScore.text) && /46/.test(withScore.html));

      for (const empty of ['', ' ', undefined, null, 'не измерено']) {
        const out = make({ ...opts, score: empty });
        const broken = /(набрал|scored)\s+(из 100|of 100)|\s(из|of) 100/.test(out.text)
          || /undefined|null|NaN/.test(out.text) || /undefined|null|NaN/.test(out.html);
        ok(`цепочка ${lang}/${name}: без балла предложение целое (${JSON.stringify(empty)})`, !broken);
        ok(`цепочка ${lang}/${name}: сайт всё равно назван (${JSON.stringify(empty)})`, out.text.includes('example.com'));
      }
    }
  }
}

// ---- сплошной перебор: ни одно сочетание пустых полей не ломает предложение
//
// Столбцы в таблице правятся руками и могут сдвинуться. До 15.09.2026 пустой адрес давал
// «Вчера null набрал 46 из 100» в холодном письме. Перебираем адрес и балл во всех состояниях,
// в каких они приходят из таблицы, по всем письмам и обоим языкам.
{
  const EN2 = await import('./sequence.mjs');
  const RU2 = await import('./sequence.ru.mjs');
  const hosts = ['example.com', '', ' ', undefined, null];
  const scores = ['46', '0', '', ' ', undefined, null, 'не измерено'];
  let combos = 0; let broken = 0;
  for (const [lang, M] of [['en', EN2], ['ru', RU2]]) {
    for (const [name, make] of [['2', M.letter2], ['3', M.letter3], ['4', M.letter4Owner], ['5', M.letter5], ['6', M.letter6]]) {
      for (const host of hosts) {
        for (const score of scores) {
          combos += 1;
          const o = make({ host, score, offerUrl: 'https://oper-stack.com/api/offer/?t=x', unsubUrl: 'https://oper-stack.com/api/unsubscribe/?t=x' });
          const all = `${o.subject}\n${o.text}\n${o.html}`;
          if (/undefined|null|NaN/.test(all)) { broken += 1; console.error(`  ${lang}/${name}: мусор в тексте при host=${JSON.stringify(host)}, score=${JSON.stringify(score)}`); continue; }
          if (/(набрал|scored)\s+(из|of) 100/.test(all)) { broken += 1; console.error(`  ${lang}/${name}: дыра вместо балла`); continue; }
          if (/(Вчера|Yesterday)\s{2,}/.test(all) || />\s*<\/strong>/.test(all)) { broken += 1; console.error(`  ${lang}/${name}: дыра вместо адреса`); continue; }
          if (!/example\.com|ваш сайт|your site/.test(all)) { broken += 1; console.error(`  ${lang}/${name}: сайт не назван никак`); }
        }
      }
    }
  }
  ok(`${combos} сочетаний пустых полей, ни одного сломанного предложения`, broken === 0);
  ok('перебрано не меньше полусотни сочетаний', combos >= 50);
}

// ---- ступень за 29: обещание четырёх срезов стоит в письме теми же словами, что на сайте.
// Срезы построены 15.09.2026 (watch-run.mjs), и обещание вернулось в тексты только после этого.
{
  const cmp = { text: 'a.com 40 | b.com 50', html: '<table><tr><td>a.com</td></tr></table>' };
  for (const lang of ['ru', 'en']) {
    const L = buildLetter({ host: 'example.com', lang, scores: SCORES, comparison: cmp, free: false, head: null, firstTask: null });
    const line = lang === 'ru' ? /четыре недели, раз в неделю, придёт срез/ : /four weeks a snapshot follows once a week/;
    ok(`${lang}: письмо за 29 обещает четыре среза`, line.test(L.text) && line.test(L.html));
    ok(`${lang}: и говорит, когда первый`, (lang === 'ru' ? /Первый через неделю/ : /first one comes in a week/).test(L.text));
    const nine = buildLetter({ host: 'example.com', lang, scores: SCORES, comparison: null, free: false, head: null, firstTask: null });
    ok(`${lang}: письмо за 9 срезов не обещает`, !line.test(nine.text) && !line.test(nine.html));
  }
}

if (bad) { console.error(`\n${bad} тест(ов) упало`); process.exit(1); }
console.log('\nписьмо и отчёт несут один балл');
