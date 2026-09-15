#!/usr/bin/env node
/**
 * Живая сверка всей воронки на настоящем сайте: страница, письмо, отчёт.
 *
 * Простым языком: проходим ровно то, что проходит человек. Сначала меряем сайт так, как это
 * делает бесплатная проверка на странице. Потом кладём этот результат в заявку, как его кладёт
 * сайт. Потом даём заявку очереди и смотрим, что она напишет в письме и что напечатает в отчёте.
 * Три числа должны совпасть. Если не совпали, значит воронка снова врёт, и это видно здесь, а не
 * у покупателя.
 *
 *   node verify-funnel.mjs https://example.com            один язык
 *   node verify-funnel.mjs https://example.com --both     и русский, и английский
 *
 * Это единственная честная проверка: свои сайты быстрые и отвечают всегда, на них сходится
 * что угодно. Брать чужой и небыстрый.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VISIBILITY_DEFAULTS, checkVisibility } from '@operstack/audit';

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
if (!url) { console.error('нужен адрес: node verify-funnel.mjs https://example.com'); process.exit(2); }
const langs = args.includes('--both') ? ['en', 'ru'] : [args.includes('--ru') ? 'ru' : 'en'];
/** Столько ждём один прогон. Без потолка проверка на медленном чужом сайте висит молча, и
 *  «ещё идёт» становится неотличимо от «повисло». */
const BUDGET_MS = Number((args.find((a) => a.startsWith('--budget=')) || '--budget=25').slice(9)) * 60 * 1000;

let bad = 0;
for (const lang of langs) {
  console.log(`\n=== ${url} [${lang}] ===`);
  // Шаг первый: страница. Те же параметры, что у бесплатной проверки, иначе сверять нечего.
  const page = await checkVisibility(url, { ...VISIBILITY_DEFAULTS, lang });
  if (!page.ok) { console.error(`  страница не смогла померить: ${page.error || 'причина не названа'}`); bad++; continue; }
  console.log(`  страница: ${page.score} (${page.grade})`);

  // Шаг второй: заявка. Сайт кладёт в неё результат целиком, а не одну цифру.
  const packed = Buffer.from(JSON.stringify(page)).toString('base64url');

  // Шаг третий: очередь. Сухой прогон печатает три числа рядом и возвращает ненулевой код,
  // если они разошлись.
  const r = spawnSync(process.execPath, [resolve(ROOT, 'report-run.mjs'),
    `--url=${url}`, '--email=info+test@oper-stack.com', `--lang=${lang}`, '--tier=free',
    `--visibility=${packed}`, '--dry-run'], { encoding: 'utf8', env: process.env, timeout: BUDGET_MS });
  const line = (r.stdout || '').split('\n').find((l) => l.includes('[сухой прогон] балл:'));
  console.log(`  ${line ? line.trim() : 'очередь не напечатала строку сверки'}`);
  if (r.error && r.error.code === 'ETIMEDOUT') {
    bad++;
    console.error(`  очередь не уложилась в ${BUDGET_MS / 60000} минут: это не расхождение, это медленный сайт`);
  } else if (r.status !== 0 || !line || !line.includes('✓')) {
    bad++;
    console.error((r.stderr || '').trim().split('\n').slice(-3).join('\n'));
  }
}

console.log(bad ? `\n${bad} расхождений` : '\nстраница, письмо и отчёт несут один балл');
process.exit(bad ? 1 : 0);
