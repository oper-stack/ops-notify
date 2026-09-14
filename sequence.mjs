/**
 * Тексты писем после бесплатного отчёта.
 *
 * Простым языком: человек оставил почту, получил список находок и PDF. Дальше мы пишем ему
 * ещё несколько раз. Каждое письмо должно нести пользу само по себе, даже если человек
 * ничего не купит, иначе это просто спам с логотипом.
 *
 * Все цифры про агентства взяты из открытых обзоров рынка 2026 года. Мы нигде не пишем
 * «то же самое, что агентство, только дешевле»: это неправда, агентство добавляет человека,
 * который читает находки. Пишем честнее: замер лучше делает машина, а чтение находок
 * человеком у нас стоит 149.
 */

import { button, emailShell } from './email-shell.mjs';

const SITE = 'https://oper-stack.com';
const MCP = 'https://oper-stack.com/api/mcp/';

/**
 * Врезка про наш адрес для ИИ-помощников.
 *
 * Почему её нет в первом письме. Первое письмо открывают почти все, и у него одна работа:
 * отдать обещанное и сделать предложение. Это самое дорогое внимание, которое у нас есть, и
 * тратить его на бесплатную вещь, которая не приносит денег, нельзя.
 *
 * Почему она стоит в третьем и в письме агентству. Третье письмо про пользу без продажи, и
 * это ровно такая польза. А агентству сравнение чужих сайтов одной фразой это его работа, и
 * врезка стоит рядом с подпиской за 39, которая эту же работу делает под их брендом.
 *
 * Настоящая задача этой штуки в воронке не привести человека, а удержать: это единственное
 * наше, чем пользуются много раз и без нас. Поэтому она внизу писем, а не наверху.
 */
function mcpBlockText(lines) {
  return ['', 'One more thing, free and unrelated to anything you buy.', '',
    ...lines, '',
    `Paste this into the settings of Claude, ChatGPT or Cursor once: ${MCP}`,
    'Nothing to install, no account, no payment. The trailing slash matters.',
    `Setup for each program, step by step: ${SITE}/mcp/`];
}
function mcpBlockHtml(lead) {
  return `<div style="margin:26px 0 0;padding:18px 20px;background:#E9F1EF;border-radius:10px">
    <p style="margin:0 0 10px;font-size:15px;line-height:1.5;color:#14181C"><strong>One more thing, free and unrelated to anything you buy.</strong> ${lead}</p>
    <p style="margin:0 0 10px;font-size:15px;line-height:1.5;color:#14181C">Paste <code style="background:#fff;padding:2px 6px;border-radius:4px;font-size:14px">${MCP}</code> into the settings of Claude, ChatGPT or Cursor once. Nothing to install, no account, no payment. The trailing slash matters.</p>
    <p style="margin:0;font-size:14px;line-height:1.5;color:#5A6470"><a href="${SITE}/mcp/" style="color:#1A8A7D">Setup for each program, step by step</a></p>
  </div>`;
}

/** Обёртка письма: тело плюс подпись и отписка. Отписка обязана быть в каждом письме. */
/**
 * Абзацы в письмах написаны обычными тегами, а почта своих стилей не имеет: без этого
 * текст показался бы шрифтом с засечками по умолчанию. Поэтому голым <p> и <ul> здесь
 * проставляется тот же вид, что у остальных писем. Теги, у которых стиль уже есть,
 * не трогаем: это врезки, которые оформлены по-своему.
 */
const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const dress = (html) => String(html)
  .replace(/<p>/g, `<p style="margin:0 0 16px;font-family:${FONT_STACK};font-size:16px;line-height:1.55;color:#14181C">`)
  // Абзацу, у которого стиль уже есть, но шрифт не назван, дописываем шрифт: иначе почта
  // рисует его своим по умолчанию, с засечками, и он выпадает из письма.
  .replace(/<p style="(?![^"]*font-family)([^"]*)"/g, `<p style="font-family:${FONT_STACK};line-height:1.5;$1"`)
  .replace(/<ul>/g, `<ul style="margin:0 0 16px;padding-left:20px;font-family:${FONT_STACK};font-size:16px;line-height:1.55;color:#14181C">`)
  .replace(/<li>/g, '<li style="margin:6px 0">')
  // Ссылка без своего стиля станет синей и подчёркнутой, как в почте по умолчанию, и выпадет
  // из письма. Кнопки и ссылки во врезках свой стиль уже имеют, их не трогаем.
  .replace(/<a href="(?![^"]*")/g, '<a href="')
  .replace(/<a (href="[^"]*")(?![^>]*style=)/g, '<a $1 style="color:#1A8A7D"');

function wrap({ subject, bodyText, bodyHtml, unsubUrl, heading, preheader }) {
  const text = [...bodyText, '', 'OperStack · info@oper-stack.com', `Not interested? One click and we stop: ${unsubUrl}`].join('\n');
  // Заголовок письма по умолчанию совпадает с темой: дублировать её незачем, а расходиться
  // с ней нельзя, иначе человек открывает письмо и видит не то, что обещал список писем.
  const html = emailShell({
    site: 'en',
    preheader: preheader || subject,
    heading: heading || subject,
    blocks: bodyHtml.map(dress),
    unsubUrl,
  });
  return { subject, text, html };
}

const btn = (href, label) => button(href, label);

/**
 * Письмо 2. Сутки на полный отчёт за 19 вместо 29.
 *
 * Уходит только если скрытый тариф за 19 действительно заведён: обещать цену, которой нет,
 * нельзя. Пока тарифа нет, письмо просто не отправляется, и человек сразу получает третье.
 */
export function letter2({ host, score, offerUrl, unsubUrl }) {
  return wrap({
    subject: 'Four hours left on the 19',
    bodyText: [
      `Yesterday ${host} scored ${score} of 100, and we sent you everything the check found.`,
      '',
      'The full report is the next step: the same measurement on up to three rivals in one table beside yours, and a re-check of your site every week for a month, so you can see what your fixes actually moved.',
      '',
      'It is 29 USD. For four more hours it is 19, and then this link goes back to 29 and does not come back.',
      '',
      `Take it at 19: ${offerUrl}`,
      '',
      'For scale: an agency that watches AI visibility for you charges 2,000 to 15,000 USD a month, on a contract you have to end. This is once, for a month, and there is nothing to cancel.',
    ],
    bodyHtml: [
      `<p>Yesterday <strong>${host}</strong> scored <strong>${score} of 100</strong>, and we sent you everything the check found.</p>`,
      '<p>The full report is the next step: the same measurement on up to three rivals in one table beside yours, and a re-check of your site every week for a month, so you can see what your fixes actually moved.</p>',
      '<p>It is 29 USD. <strong>For four more hours it is 19</strong>, and then this link goes back to 29 and does not come back.</p>',
      btn(offerUrl, 'Take the full report at 19 USD →'),
      '<p style="color:#666;font-size:14px">For scale: an agency that watches AI visibility for you charges 2,000 to 15,000 USD a month, on a contract you have to end. This is once, for a month, and there is nothing to cancel.</p>',
    ],
    unsubUrl,
  });
}

/**
 * Письмо 3. Польза без продажи: что такое ответ в первом абзаце.
 *
 * Это самая частая причина, по которой ИИ не цитирует страницу, и объяснить её можно за
 * минуту. Отдаём даром то, что другие продают на девятой странице аудита за 2000 долларов.
 */
export function letter3({ host, unsubUrl }) {
  return wrap({
    subject: 'Why nobody quotes a page that buries its answer',
    bodyText: [
      'One thing worth knowing, whether or not you ever buy anything from us.',
      '',
      'When ChatGPT, Perplexity or Google AI decides what to quote, it does not read your page the way a person does. It takes the opening. If your first paragraph is a welcome, a mission statement or a paragraph about how long you have been in business, that is what gets weighed, and it answers nobody question.',
      '',
      'What works: twenty to ninety words at the top that answer the question the page is about, with one real figure and the source next to it. Then your normal page.',
      '',
      `How to check it on ${host} in a minute: open any page that matters, read only the first paragraph, and ask whether a stranger would get a usable answer from it alone. If not, that page is invisible to an answer engine no matter how good the rest is.`,
      '',
      `This is the kind of thing an agency writes on page nine of a 2,000 USD audit. We would rather you just knew it.`,
      '',
      `Every problem we found on your site, turned into a task you can hand to anyone: ${SITE}/products/site-report/ (9 USD)`,
      ...mcpBlockText([
        'If you already use Claude, ChatGPT or Cursor, they can run this check for you inside the window you work in.',
        'You just write in plain words: look at my site, compare me with these three, how many AI visits did I get this month.',
      ]),
    ],
    bodyHtml: [
      '<p>One thing worth knowing, whether or not you ever buy anything from us.</p>',
      '<p>When ChatGPT, Perplexity or Google AI decides what to quote, it does not read your page the way a person does. <strong>It takes the opening.</strong> If your first paragraph is a welcome, a mission statement or a note about how long you have been in business, that is what gets weighed, and it answers nobody’s question.</p>',
      '<p>What works: twenty to ninety words at the top that answer the question the page is about, with one real figure and the source next to it. Then your normal page.</p>',
      `<p><strong>How to check it on ${host} in a minute:</strong> open any page that matters, read only the first paragraph, and ask whether a stranger would get a usable answer from it alone. If not, that page is invisible to an answer engine no matter how good the rest is.</p>`,
      '<p style="color:#666;font-size:14px">This is the kind of thing an agency writes on page nine of a 2,000 USD audit. We would rather you just knew it.</p>',
      `<p>Every problem we found on your site, turned into a task you can hand to anyone: <a href="${SITE}/products/site-report/">the site fix list</a>, 9 USD.</p>`,
      mcpBlockHtml('If you already use Claude, ChatGPT or Cursor, they can run this check inside the window you work in. You write in plain words: look at my site, compare me with these three, how many AI visits did I get this month.'),
    ],
    unsubUrl,
  });
}

/** Письмо 4 для агентства: у этой почты несколько разных сайтов. */
export function letter4Agency({ sites, unsubUrl }) {
  return wrap({
    subject: `You checked ${sites} sites with us. Here is what that looks like under your logo`,
    bodyText: [
      `You have run ${sites} different sites through our check. So you are not auditing your own site. You are auditing someone else’s, and billing for it.`,
      '',
      'A technical audit is quoted at 2,000 to 7,500 USD and an AI visibility audit at 1,000 to 5,000. You know that better than we do, because it is your invoice. You also know that most of the work behind it is measuring, and measuring is the part you would rather not do by hand.',
      '',
      'The agency plan produces the measured report with your logo on the cover, your colour through the document and your agency named as the author. No cap on sites, reports or clients, and no share of what you charge them. 39 USD a month.',
      '',
      `See it: ${SITE}/products/agency/`,
      ...mcpBlockText([
        'And since you check other people sites all day: Claude, ChatGPT and Cursor can do it for you, in conversation.',
        'Compare these four client sites on the same scale. Which of them blocks AI crawlers. Did the llms.txt links survive the redesign.',
      ]),
    ],
    bodyHtml: [
      `<p>You have run <strong>${sites} different sites</strong> through our check. So you are not auditing your own site. You are auditing someone else’s, and billing for it.</p>`,
      '<p>A technical audit is quoted at 2,000 to 7,500 USD and an AI visibility audit at 1,000 to 5,000. You know that better than we do, because it is your invoice. You also know that most of the work behind it is measuring, and measuring is the part you would rather not do by hand.</p>',
      '<p>The agency plan produces the measured report with <strong>your logo on the cover</strong>, your colour through the document and your agency named as the author. No cap on sites, reports or clients, and no share of what you charge them. <strong>39 USD a month.</strong></p>',
      btn(`${SITE}/products/agency/`, 'See the agency plan →'),
      mcpBlockHtml('And since you check other people’s sites all day: Claude, ChatGPT and Cursor can do it for you, in conversation. «Compare these four client sites on the same scale.» «Which of them blocks AI crawlers.» «Did the llms.txt links survive the redesign.»'),
    ],
    unsubUrl,
  });
}

/** Письмо 4 для владельца сайта: одна проверка, свой сайт. */
export function letter4Owner({ host, score, unsubUrl }) {
  return wrap({
    subject: 'Your numbers, read by a person',
    bodyText: [
      `Everything you have had from us so far was measured by a machine: ${host} scored ${score} of 100, and here is the list.`,
      '',
      'What a machine cannot do is tell you what those numbers mean for your business, and in what order to close them. A page that fails three checks but brings you no buyers is not the place to start.',
      '',
      'That is the audit: a person reads every finding on your site and writes what it means for you and what to do first. 149 USD for the first ten, then 249, and it lands in one to three working days, five at most.',
      '',
      'Agencies sell this as a one-off at 3,000 to 15,000 USD, or fold it into a retainer from 2,000 a month. The difference is not the person. It is that the measuring behind it was already done, by the same tool you have been using for free.',
      '',
      `Book it: ${SITE}/products/seo-audit/`,
    ],
    bodyHtml: [
      `<p>Everything you have had from us so far was measured by a machine: <strong>${host}</strong> scored <strong>${score} of 100</strong>, and here is the list.</p>`,
      '<p>What a machine cannot do is tell you what those numbers mean for your business, and in what order to close them. A page that fails three checks but brings you no buyers is not the place to start.</p>',
      '<p>That is the audit: a person reads every finding on your site and writes what it means for you and what to do first. <strong>149 USD</strong> for the first ten, then 249, and it lands in one to three working days, five at most.</p>',
      '<p style="color:#666;font-size:14px">Agencies sell this as a one-off at 3,000 to 15,000 USD, or fold it into a retainer from 2,000 a month. The difference is not the person. It is that the measuring behind it was already done, by the same tool you have been using for free.</p>',
      btn(`${SITE}/products/seo-audit/`, 'Book the audit, 149 USD →'),
    ],
    unsubUrl,
  });
}

/** Письмо 5. Две недели спустя: прогнать проверку снова и увидеть сдвиг. */
export function letter5({ host, score, unsubUrl }) {
  return wrap({
    subject: `Two weeks on: has ${host} moved?`,
    bodyText: [
      `Two weeks ago ${host} scored ${score} of 100.`,
      '',
      'Run the check again and see. It takes ten seconds and costs nothing, and it is the only honest way to know whether anything you changed actually landed.',
      '',
      `${SITE}/ai-visibility/`,
      '',
      'If the number has not moved, that is worth knowing too. Scores do not drift upward on their own: robots.txt, llms.txt, schema and opening paragraphs stay exactly as they were until somebody changes them.',
      '',
      `If you want to watch it properly rather than remember to check: the full report puts you beside three rivals and re-checks you every week for a month. 29 USD, no subscription: ${SITE}/products/rival-watch/`,
    ],
    bodyHtml: [
      `<p>Two weeks ago <strong>${host}</strong> scored <strong>${score} of 100</strong>.</p>`,
      '<p>Run the check again and see. It takes ten seconds and costs nothing, and it is the only honest way to know whether anything you changed actually landed.</p>',
      btn(`${SITE}/ai-visibility/`, 'Run the check again →'),
      '<p>If the number has not moved, that is worth knowing too. Scores do not drift upward on their own: robots.txt, llms.txt, schema and opening paragraphs stay exactly as they were until somebody changes them.</p>',
      `<p style="color:#666;font-size:14px">If you want to watch it properly rather than remember to check: <a href="${SITE}/products/rival-watch/">the full report</a> puts you beside three rivals and re-checks you every week for a month. 29 USD, no subscription.</p>`,
    ],
    unsubUrl,
  });
}

/** Письмо 6. Месяц спустя, и на этом цепочка заканчивается. */
export function letter6({ host, unsubUrl }) {
  return wrap({
    subject: `${host}, a month later`,
    bodyText: [
      'This is the last of these. After it we stop writing unless you run another check or ask us something.',
      '',
      `A month is enough time for things to change on a site without anyone noticing: a plugin update rewrites robots.txt, a redesign drops the schema, a new section ships with no opening paragraph. The check is free and always will be: ${SITE}/ai-visibility/`,
      '',
      'If you ever want a person to look at it instead of a machine, that is the audit at 149 USD. If you look after other people sites, the agency plan puts your own logo on the report for 39 a month. Both are on the site, and neither needs an account.',
      '',
      'Thanks for trying it.',
      ...mcpBlockText([
        'The one thing worth keeping after these letters stop: our check works inside Claude, ChatGPT and Cursor.',
        'Then you never have to remember to come back here at all.',
      ]),
    ],
    bodyHtml: [
      '<p>This is the last of these. After it we stop writing unless you run another check or ask us something.</p>',
      `<p>A month is enough time for things to change on a site without anyone noticing: a plugin update rewrites robots.txt, a redesign drops the schema, a new section ships with no opening paragraph. <a href="${SITE}/ai-visibility/">The check</a> is free and always will be.</p>`,
      `<p>If you ever want a person to look at it instead of a machine, that is <a href="${SITE}/products/seo-audit/">the audit</a> at 149 USD. If you look after other people’s sites, <a href="${SITE}/products/agency/">the agency plan</a> puts your own logo on the report for 39 a month. Both are on the site, and neither needs an account.</p>`,
      '<p>Thanks for trying it.</p>',
      mcpBlockHtml('The one thing worth keeping after these letters stop: our check works inside Claude, ChatGPT and Cursor, so you never have to remember to come back here at all.'),
    ],
    unsubUrl,
  });
}
