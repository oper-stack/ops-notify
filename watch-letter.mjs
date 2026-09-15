/**
 * Письма-срезы: что сдвинулось у вас и у конкурентов с прошлого замера.
 *
 * Два вида. Еженедельный срез для ступени «Против конкурентов» (четыре письма, раз в неделю) и
 * перепроверка через 90 дней для аудита. Оба письма про одно: те же замеры тем же кодом, и
 * разница с тем, что было, названа числом. Ни одного слова «примерно» и ни одной цифры, которой
 * нет в замере: если сайт не ответил, так и пишем, и в разницу это не идёт.
 */
import { button, emailShell, note, p as par } from './email-shell.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Знак и число: +6, −3, без изменений. */
const delta = (now, was, lang) => {
  if (now === null || was === null || now === undefined || was === undefined) return lang === 'ru' ? 'не измерено' : 'not measured';
  const d = now - was;
  if (d === 0) return lang === 'ru' ? 'без изменений' : 'no change';
  return (d > 0 ? '+' : '−') + Math.abs(d);
};

const fmtScore = (n, lang) => (n === null || n === undefined ? (lang === 'ru' ? 'нет ответа' : 'no answer') : String(n));

/**
 * @param {object} o
 * @param {'ru'|'en'} o.lang
 * @param {'rivals-weekly'|'audit-90'} o.kind
 * @param {number} o.week  номер среза: 1..4 для еженедельных, 1 для перепроверки через 90 дней
 * @param {{host:string, was:number|null, now:number|null}} o.site
 * @param {{host:string, was:number|null, now:number|null}[]} o.rivals
 * @param {string|null} o.unsubUrl
 */
export function buildWatchLetter({ lang = 'en', kind = 'rivals-weekly', week = 1, site, rivals = [], unsubUrl = null }) {
  const ru = lang === 'ru';
  const host = String(site?.host || '').trim() || (ru ? 'ваш сайт' : 'your site');
  const weekly = kind === 'rivals-weekly';

  const fix30 = kind === 'fix-30';
  const subject = weekly
    ? (ru ? `Срез ${week} из 4: ${host} и конкуренты` : `Snapshot ${week} of 4: ${host} and rivals`)
    : fix30
      ? (ru ? `30 дней после правок: что сдвинулось на ${host}` : `30 days after the fixes: what moved on ${host}`)
      : (ru ? `90 дней спустя: что сдвинулось на ${host}` : `90 days on: what moved on ${host}`);

  const lead = weekly
    ? (ru
      ? `Тот же замер, тем же кодом, что и в отчёте. Ниже ваш балл тогда и сейчас, и то же по каждому конкуренту.`
      : `The same measurement by the same code as in your report. Below is your score then and now, and the same for each rival.`)
    : fix30
      ? (ru
        ? `Прошло тридцать дней с правок. Мы перемерили сайт тем же кодом и с теми же настройками. Ниже что было до правок, что стало, и держится ли результат.`
        : `Thirty days since the fixes. We measured the site again by the same code with the same settings. Below is what it was before the fixes, what it is now, and whether the result holds.`)
      : (ru
        ? `Прошло девяносто дней с аудита. Мы перемерили сайт тем же кодом и с теми же настройками. Ниже что было, что стало и что из найденного тогда закрыто.`
        : `Ninety days since the audit. We measured the site again by the same code with the same settings. Below is what it was, what it is, and what from back then is closed.`);

  const rows = [{ host, was: site?.was ?? null, now: site?.now ?? null, you: true }, ...rivals.map((r) => ({ host: r.host, was: r.was ?? null, now: r.now ?? null, you: false }))];

  const textRows = rows.map((r) => `  ${r.host}${r.you ? (ru ? ' (вы)' : ' (you)') : ''}: ${fmtScore(r.was, lang)} → ${fmtScore(r.now, lang)} (${delta(r.now, r.was, lang)})`);

  // Разрыв с лучшим конкурентом: единственная цифра, ради которой это письмо открывают.
  const measured = rivals.filter((r) => r.now !== null && r.now !== undefined);
  const best = measured.length ? measured.reduce((a, b) => (b.now > a.now ? b : a)) : null;
  let gapLine = '';
  if (best && site?.now !== null && site?.now !== undefined) {
    const gap = site.now - best.now;
    const gapWas = (site.was !== null && site.was !== undefined && best.was !== null && best.was !== undefined) ? site.was - best.was : null;
    // Движение разрыва словами, которые совпадают с положением: отстаёте, значит «сократили
    // отставание» или «отстали ещё», впереди, значит «оторвались» или «отрыв сократился».
    // Прежняя фраза «разрыв в вашу пользу вырос» у отстающего читалась как насмешка.
    let trend = '';
    if (gapWas !== null && gap !== gapWas) {
      const moved = Math.abs(gap - gapWas);
      if (gap < 0) trend = gap > gapWas ? (ru ? `, за неделю вы сократили отставание на ${moved}` : `, you closed ${moved} of that this week`) : (ru ? `, за неделю отстали ещё на ${moved}` : `, and fell ${moved} further behind this week`);
      else trend = gap > gapWas ? (ru ? `, за неделю оторвались ещё на ${moved}` : `, and pulled ${moved} further ahead this week`) : (ru ? `, за неделю отрыв сократился на ${moved}` : `, though the lead shrank by ${moved} this week`);
    } else if (gapWas !== null) trend = ru ? ', как и неделю назад' : ', as a week ago';
    gapLine = gap >= 0
      ? (ru ? `Вы впереди сильнейшего из них (${best.host}) на ${gap}${trend}.` : `You lead the strongest of them (${best.host}) by ${gap}${trend}.`)
      : (ru ? `Сильнейший из них (${best.host}) впереди вас на ${Math.abs(gap)}${trend}.` : `The strongest of them (${best.host}) leads you by ${Math.abs(gap)}${trend}.`);
  }

  const unanswered = rows.filter((r) => r.now === null || r.now === undefined).map((r) => r.host);
  const unansweredLine = unanswered.length
    ? (ru ? `Не ответили в этот раз: ${unanswered.join(', ')}. В разницу это не идёт, ничего не выдумываем.` : `Did not answer this time: ${unanswered.join(', ')}. That is left out of the comparison, nothing is invented.`)
    : '';

  const closing = weekly
    ? (week < 4
      ? (ru ? `Следующий срез через неделю. Всего их четыре.` : `The next snapshot comes in a week. There are four in all.`)
      : (ru ? `Это последний из четырёх срезов. Дальше мы не пишем, пока вы сами не закажете новый.` : `This is the last of the four snapshots. We do not write again unless you order another.`))
    : (ru ? `Это разовая перепроверка, других писем не будет.` : `This is a one-off re-check; there will be no further letters.`);

  const text = [lead, '', ...textRows, '', gapLine, unansweredLine, '', closing, '', 'OperStack · info@oper-stack.com',
    ...(unsubUrl ? [`${ru ? 'Не нужны письма? Одно нажатие' : 'Not interested? One click'}: ${unsubUrl}`] : [])]
    .filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');

  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;border-collapse:collapse">
    <tr><th align="left" style="padding:8px 10px;border-bottom:2px solid #CFC8BA;font-size:13px;color:#5A6470;font-weight:500">${ru ? 'Сайт' : 'Site'}</th><th align="right" style="padding:8px 10px;border-bottom:2px solid #CFC8BA;font-size:13px;color:#5A6470;font-weight:500">${ru ? 'Было' : 'Was'}</th><th align="right" style="padding:8px 10px;border-bottom:2px solid #CFC8BA;font-size:13px;color:#5A6470;font-weight:500">${ru ? 'Стало' : 'Now'}</th><th align="right" style="padding:8px 10px;border-bottom:2px solid #CFC8BA;font-size:13px;color:#5A6470;font-weight:500">${ru ? 'Разница' : 'Change'}</th></tr>
    ${rows.map((r) => `<tr><td style="padding:9px 10px;border-bottom:1px solid #E7E2D8;font-size:15px;color:#14181C">${esc(r.host)}${r.you ? ` <span style="font-size:12px;color:#1A8A7D">${ru ? 'вы' : 'you'}</span>` : ''}</td><td align="right" style="padding:9px 10px;border-bottom:1px solid #E7E2D8;font-size:15px;color:#5A6470">${esc(fmtScore(r.was, lang))}</td><td align="right" style="padding:9px 10px;border-bottom:1px solid #E7E2D8;font-size:15px;font-weight:700;color:#14181C">${esc(fmtScore(r.now, lang))}</td><td align="right" style="padding:9px 10px;border-bottom:1px solid #E7E2D8;font-size:15px;color:${(r.now ?? 0) - (r.was ?? 0) > 0 ? '#1A8A7D' : (r.now ?? 0) - (r.was ?? 0) < 0 ? '#B4462F' : '#5A6470'}">${esc(delta(r.now, r.was, lang))}</td></tr>`).join('')}
  </table>`;

  const html = emailShell({
    site: lang,
    unsubUrl,
    preheader: subject,
    heading: weekly ? [ru ? `Срез ${week} из 4` : `Snapshot ${week} of 4`, host] : fix30 ? [ru ? '30 дней после правок' : '30 days after the fixes', host] : [ru ? '90 дней спустя' : '90 days on', host],
    blocks: [par(lead), table, ...(gapLine ? [par(`<strong>${esc(gapLine)}</strong>`)] : []), ...(unansweredLine ? [note(esc(unansweredLine))] : []), note(esc(closing))],
  });

  return { subject, text, html };
}
