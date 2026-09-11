#!/usr/bin/env node
/**
 * Sales inbox to Telegram. Reads the OperStack mailbox over IMAP, finds new messages from sales and
 * account platforms (or addressed to billing@ / accounts@), posts a one-line note per message to
 * Telegram, and labels the message OpsNotified so it is never posted twice. Runs every ten minutes
 * from GitHub Actions; safe to run by hand.
 *
 *   GOOGLE_USER=info@oper-stack.com GOOGLE_APP_PASSWORD=... TG_TOKEN=... TG_CHAT_ID=... node notify-mail.mjs
 *   node notify-mail.mjs --dry-run      lists what would be posted, posts nothing, labels nothing
 *   node notify-mail.mjs --bootstrap    labels everything matching without posting: run once before enabling the schedule
 */
import { ImapFlow } from 'imapflow';

const dry = process.argv.includes('--dry-run');
const bootstrap = process.argv.includes('--bootstrap');
const env = (k, d = '') => (process.env[k] || d).trim();
const USER = env('GOOGLE_USER'); const PASS = env('GOOGLE_APP_PASSWORD');
const TG_TOKEN = env('TG_TOKEN'); const TG_CHAT = env('TG_CHAT_ID');
const LABEL = env('OPS_LABEL', 'OpsNotified');
const LOOKBACK_DAYS = Number(env('OPS_LOOKBACK_DAYS', '3'));
const OWN_ADDRESSES = ['billing@oper-stack.com', 'accounts@oper-stack.com', 'support@oper-stack.com'];

/** Platform catalogue: sender domain fragments and a label. Add a line per new platform. */
const PLATFORMS = [
  ['paddle.com', 'Paddle', '💳'], ['lemonsqueezy.com', 'Lemon Squeezy', '💳'], ['whop.com', 'Whop', '💳'], ['gumroad.com', 'Gumroad', '💳'],
  ['stripe.com', 'Stripe', '💳'], ['paypal.com', 'PayPal', '💳'], ['payoneer.com', 'Payoneer', '🏦'],
  ['dodopayments.com', 'Dodo Payments', '💳'], ['polar.sh', 'Polar', '💳'], ['creem.io', 'Creem', '💳'],
  ['upwork.com', 'Upwork', '🧑‍💻'], ['fiverr.com', 'Fiverr', '🧑‍💻'],
  ['producthunt.com', 'Product Hunt', '🚀'], ['apify.com', 'Apify', '🤖'], ['npmjs.com', 'npm', '📦'], ['github.com', 'GitHub', '🐙'],
  ['udemy.com', 'Udemy', '🎓'], ['etsy.com', 'Etsy', '🛍'], ['notion.so', 'Notion', '📓'], ['poe.com', 'Poe', '🤖'],
  ['vercel.com', 'Vercel', '▲'], ['cloudflare.com', 'Cloudflare', '☁️'], ['google.com', 'Google', 'G'],
];
/** Subjects that are noise even from a platform sender. */
const NOISE = /newsletter|digest|weekly|tips|webinar|community update|what's new|product update|unsubscribe|survey|feedback request/i;
/** Subjects that always matter, whoever sends them. */
const HOT = /order|purchase|payment|paid|invoice|receipt|refund|chargeback|dispute|payout|licen[cs]e|new contract|hired|proposal|offer|review|comment|upvote|approved|rejected|verification|verify|suspended|action required/i;

function classify(from, to, subject) {
  const fromAddr = (from?.[0]?.address || '').toLowerCase();
  const toAddrs = (to || []).map((t) => (t.address || '').toLowerCase());
  const platform = PLATFORMS.find(([frag]) => fromAddr.endsWith(frag) || fromAddr.includes('@' + frag) || fromAddr.includes('.' + frag));
  const toOwn = toAddrs.some((a) => OWN_ADDRESSES.includes(a));
  if (NOISE.test(subject) && !HOT.test(subject)) return null;
  if (platform) return { label: platform[1], icon: platform[2], hot: HOT.test(subject) };
  if (toOwn) return { label: fromAddr.split('@')[1] || 'mail', icon: '✉️', hot: HOT.test(subject) };
  return null;
}

async function telegram(text) {
  if (dry) { console.log('[dry] ' + text); return; }
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }) });
  if (!r.ok) throw new Error(`telegram ${r.status}: ${await r.text()}`);
}

async function main() {
  if (!USER || !PASS) throw new Error('GOOGLE_USER and GOOGLE_APP_PASSWORD are required');
  if (!dry && !bootstrap && (!TG_TOKEN || !TG_CHAT)) throw new Error('TG_TOKEN and TG_CHAT_ID are required');
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: USER, pass: PASS }, logger: false });
  await client.connect();
  try {
    // The label is a Gmail folder; create it once.
    const boxes = await client.list();
    if (!boxes.some((b) => b.path === LABEL)) { if (!dry) await client.mailboxCreate(LABEL); }
    const lock = await client.getMailboxLock('INBOX');
    let posted = 0, seen = 0, matched = [];
    try {
      // Collect first, act after: issuing another IMAP command while a fetch stream is open deadlocks.
      const uids = await client.search({ gmailRaw: `in:inbox newer_than:${LOOKBACK_DAYS}d -label:${LABEL}` }, { uid: true });
      if (uids && uids.length) {
        for await (const msg of client.fetch(uids, { uid: true, envelope: true, internalDate: true }, { uid: true })) {
          seen++;
          const { from, to, subject } = msg.envelope;
          const c = classify(from, to, subject || '');
          if (!c) continue;
          matched.push({ uid: msg.uid, c, subject: subject || '(no subject)', internalDate: msg.internalDate, from });
        }
      }
      for (const m of matched) {
        const when = new Date(m.internalDate).toLocaleString('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour12: false });
        const sender = m.from?.[0]?.name ? `${m.from[0].name} <${m.from[0].address}>` : m.from?.[0]?.address || 'unknown';
        if (!bootstrap) { await telegram(`${m.c.icon} ${m.c.label}${m.c.hot ? ' · action' : ''}: ${m.subject}\nfrom ${sender}\n${when} (AR)`); posted++; }
      }
      if (!dry && matched.length) await client.messageCopy(matched.map((m) => m.uid), LABEL, { uid: true });
    } finally { lock.release(); }
    console.log(`checked ${seen} message(s), matched ${matched.length}, posted ${posted}${dry ? ' (dry run)' : ''}${bootstrap ? ' (bootstrap: labelled only)' : ''}`);
  } finally { await client.logout(); }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
