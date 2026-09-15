#!/usr/bin/env node
/**
 * Наблюдение: срок, письмо, устойчивость к пустому.
 *
 * До 15.09.2026 еженедельные срезы обещались, но не существовали. Теперь существуют, и здесь
 * держится три вещи: срок считается правильно и пропущенное не догоняется пачкой; письмо
 * называет разницу числом и не выдумывает балл там, где сайт не ответил; ни одно сочетание
 * пустых полей не даёт «null» или «undefined» в тексте, который читает покупатель.
 */
import { dueSnapshot, SCHEDULE } from './watch-run.mjs';
import { buildWatchLetter } from './watch-letter.mjs';

let bad = 0;
const ok = (n, c) => { if (c) console.log(`ok   ${n}`); else { bad++; console.error(`FAIL ${n}`); } };
const is = (n, a, b) => ok(`${n} (ждали ${JSON.stringify(b)}, вышло ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));

const day = 86400000;
const t0 = Date.parse('2026-09-15T10:00:00Z');
const reg = '2026-09-15 10:00:00';

// ---- срок
is('день 0: ничего не подошло', dueSnapshot('rivals-weekly', reg, '', t0), null);
is('день 6: ещё рано', dueSnapshot('rivals-weekly', reg, '', t0 + 6 * day), null);
is('день 7: первый срез', dueSnapshot('rivals-weekly', reg, '', t0 + 7 * day), 1);
is('день 7, первый уже ушёл: ничего', dueSnapshot('rivals-weekly', reg, '1', t0 + 7 * day), null);
is('день 14: второй', dueSnapshot('rivals-weekly', reg, '1', t0 + 14 * day), 2);
is('день 30, скрипт не работал: только четвёртый, не пачка', dueSnapshot('rivals-weekly', reg, '1,2', t0 + 30 * day), 4);
is('день 40, все четыре ушли: ничего', dueSnapshot('rivals-weekly', reg, '1,2,3,4', t0 + 40 * day), null);
is('аудит: день 89 рано', dueSnapshot('audit-90', reg, '', t0 + 89 * day), null);
is('аудит: день 90 срез', dueSnapshot('audit-90', reg, '', t0 + 90 * day), 1);
is('аудит: отправлен, повтора нет', dueSnapshot('audit-90', reg, '1', t0 + 120 * day), null);
is('неизвестный вид: ничего', dueSnapshot('что-то', reg, '', t0 + 90 * day), null);
is('непонятная дата: ничего', dueSnapshot('rivals-weekly', 'вчера', '', t0 + 90 * day), null);
is('расписание еженедельных из четырёх', SCHEDULE['rivals-weekly'].length, 4);

// ---- письмо: разница числом, направление словом
{
  const L = buildWatchLetter({ lang: 'ru', kind: 'rivals-weekly', week: 2,
    site: { host: 'example.ru', was: 40, now: 46 },
    rivals: [{ host: 'a.ru', was: 51, now: 51 }, { host: 'b.ru', was: 30, now: 27 }],
    unsubUrl: 'https://oper-stack.ru/api/unsubscribe/?t=x' });
  ok('тема называет номер среза', /Срез 2 из 4/.test(L.subject));
  ok('ваш рост назван числом', /example\.ru \(вы\): 40 → 46 \(\+6\)/.test(L.text));
  ok('без изменений названо словами', /a\.ru: 51 → 51 \(без изменений\)/.test(L.text));
  ok('падение конкурента со знаком минус', /b\.ru: 30 → 27 \(−3\)/.test(L.text));
  ok('разрыв с сильнейшим назван', /Сильнейший из них \(a\.ru\) впереди вас на 5/.test(L.text));
  ok('и сказано, куда он сдвинулся, словами отстающего', /за неделю вы сократили отставание на 6/.test(L.text));
  const ahead = buildWatchLetter({ lang: 'ru', kind: 'rivals-weekly', week: 3, site: { host: 'x.ru', was: 60, now: 70 }, rivals: [{ host: 'r.ru', was: 55, now: 58 }] });
  ok('впереди и оторвались: так и сказано', /Вы впереди сильнейшего из них \(r\.ru\) на 12, за неделю оторвались ещё на 7/.test(ahead.text));
  const same = buildWatchLetter({ lang: 'en', kind: 'rivals-weekly', week: 2, site: { host: 'x.com', was: 50, now: 52 }, rivals: [{ host: 'r.com', was: 60, now: 62 }] });
  ok('разрыв не изменился: сказано по-английски', /leads you by 10, as a week ago/.test(same.text));
  ok('сказано, что дальше', /Следующий срез через неделю/.test(L.text));
  ok('отписка в тексте', /unsubscribe/.test(L.text));
  ok('чужого языка нет', !/[A-Za-z]{5}/.test(L.text.replace(/https?:\/\/\S+|example\.ru|a\.ru|b\.ru|OperStack|info@oper-stack\.com/g, '')));
  ok('null и undefined в письмо не попали', !/null|undefined|NaN/.test(L.text + L.html));
}

// ---- последний срез и перепроверка через 90 дней
{
  const last = buildWatchLetter({ lang: 'en', kind: 'rivals-weekly', week: 4, site: { host: 'example.com', was: 40, now: 52 }, rivals: [] });
  ok('четвёртый срез говорит, что он последний', /last of the four/.test(last.text));
  const audit = buildWatchLetter({ lang: 'en', kind: 'audit-90', week: 1, site: { host: 'example.com', was: 21, now: 47 }, rivals: [] });
  ok('перепроверка через 90 дней названа', /90 days on/.test(audit.subject));
  ok('и объявлена разовой', /one-off/.test(audit.text));
  ok('в английском нет кириллицы', !/[А-Яа-яЁё]/.test(last.text + audit.text));
}

// ---- сайт не ответил: не выдумываем
{
  const L = buildWatchLetter({ lang: 'ru', kind: 'rivals-weekly', week: 1, site: { host: 'example.ru', was: 40, now: null }, rivals: [{ host: 'a.ru', was: 50, now: 55 }] });
  ok('нет ответа названо словами', /example\.ru \(вы\): 40 → нет ответа \(не измерено\)/.test(L.text));
  ok('не ответившие перечислены', /Не ответили в этот раз: example\.ru/.test(L.text));
  ok('разрыв не считается от несуществующего числа', !/впереди вас на|Вы впереди/.test(L.text));
}

// ---- перебор пустых полей: ни одной поломки
{
  const vals = [null, undefined, 0, 46, ''];
  let combos = 0; let broken = 0;
  for (const lang of ['ru', 'en']) for (const kind of ['rivals-weekly', 'audit-90']) for (const was of vals) for (const now of vals) for (const host of ['x.ru', '', undefined]) {
    combos++;
    const L = buildWatchLetter({ lang, kind, week: 1, site: { host, was, now }, rivals: [{ host: 'r.ru', was, now }] });
    if (/null|undefined|NaN/.test(L.subject + L.text + L.html)) { broken++; console.error(`  мусор: ${lang}/${kind} host=${JSON.stringify(host)} was=${JSON.stringify(was)} now=${JSON.stringify(now)}`); }
  }
  ok(`${combos} сочетаний пустых полей без мусора в письме`, broken === 0);
}

if (bad) { console.error(`\n${bad} тест(ов) упало`); process.exit(1); }
console.log('\nнаблюдение: срок и письмо в порядке');
