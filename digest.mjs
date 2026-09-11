#!/usr/bin/env node
/**
 * Daily digest to Telegram: what the free products did yesterday. npm downloads per package, GitHub
 * stars and forks per repository, and the demo and storefront reachability. Runs once a day from
 * GitHub Actions at 09:00 Argentina. Add a line to PACKAGES or REPOS when a product ships.
 *
 *   TG_TOKEN=... TG_CHAT_ID=... node digest.mjs [--dry-run]
 */
const dry = process.argv.includes('--dry-run');
const env = (k, d = '') => (process.env[k] || d).trim();
const PACKAGES = ['@operstack/gates', '@operstack/audit'];
const REPOS = ['oper-stack/gates', 'oper-stack/astro-starter', 'oper-stack/claude-plugins', 'oper-stack/audit-generator'];
const URLS = ['https://oper-stack.com/products/', 'https://demo.oper-stack.com/', 'https://oper-stack.com/api/ai-visibility/?url=https://oper-stack.com'];

async function json(url, headers = {}) { const r = await fetch(url, { headers }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }

async function main() {
  const lines = ['📊 OperStack daily digest'];
  for (const p of PACKAGES) {
    // The downloads API answers 404 until a package has its first recorded download; that is a zero, not an error.
    try {
      const d = await json(`https://api.npmjs.org/downloads/point/last-day/${p}`).catch(() => ({ downloads: 0 }));
      const w = await json(`https://api.npmjs.org/downloads/point/last-week/${p}`).catch(() => ({ downloads: 0 }));
      lines.push(`📦 ${p}: ${d.downloads} yesterday, ${w.downloads} this week`);
    } catch (e) { lines.push(`📦 ${p}: npm stats unavailable (${e.message.slice(0, 60)})`); }
  }
  const gh = env('GH_TOKEN') ? { Authorization: `Bearer ${env('GH_TOKEN')}` } : {};
  for (const r of REPOS) {
    try { const d = await json(`https://api.github.com/repos/${r}`, { ...gh, 'User-Agent': 'operstack-digest' }); lines.push(`🐙 ${r}: ${d.stargazers_count} stars, ${d.forks_count} forks, ${d.open_issues_count} open issues`); }
    catch (e) { lines.push(`🐙 ${r}: unavailable (${e.message.slice(0, 60)})`); }
  }
  for (const u of URLS) {
    try { const t0 = Date.now(); const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); let extra = ''; if (u.includes('ai-visibility')) { const j = await r.json(); extra = ` · own score ${j.score} (${j.grade})`; } lines.push(`${r.ok ? '✅' : '⚠️'} ${new URL(u).host}${new URL(u).pathname}: ${r.status} in ${Date.now() - t0} ms${extra}`); }
    catch (e) { lines.push(`⚠️ ${u}: ${e.message.slice(0, 60)}`); }
  }
  const text = lines.join('\n');
  if (dry) { console.log(text); return; }
  const r = await fetch(`https://api.telegram.org/bot${env('TG_TOKEN')}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env('TG_CHAT_ID'), text, disable_web_page_preview: true }) });
  if (!r.ok) throw new Error(`telegram ${r.status}`);
  console.log('digest posted');
}
main().catch((e) => { console.error(e.message); process.exit(1); });
