# ops-notify

One place where every sale, order, payout, review and account alert from every platform ends up: the Telegram chat "Operstack leads".

## How it works

1. Every platform account (Paddle, Lemon Squeezy, Whop, Upwork, Fiverr, Product Hunt, Apify, npm, Udemy, Etsy, and the next thirty) is registered with, or forwards its mail to, one mailbox: **billing@oper-stack.com** (alias of info@). Nothing to integrate per platform: they all send email.
2. `notify-mail.mjs` runs every ten minutes from GitHub Actions. It reads the mailbox over IMAP, picks messages from known platform senders or addressed to billing@/accounts@/support@, skips newsletters, posts a one-line note per message to Telegram, and labels the message `OpsNotified` so it is never posted twice. Maxim reading the inbox first does not matter: the label, not the read flag, is the memory.
3. `digest.mjs` runs once a day at 09:00 Argentina: npm downloads per package, GitHub stars per repository, storefront and demo reachability, our own AI visibility score.
4. Platforms with webhooks (Paddle today, Lemon Squeezy and Whop next) also post richer notes from the site's fulfilment routes; the mail note is the safety net that never depends on our code being deployed.

## Setup

Repository secrets: `GOOGLE_USER`, `GOOGLE_APP_PASSWORD` (a Workspace app password), `TG_TOKEN`, `TG_CHAT_ID`. `GITHUB_TOKEN` is provided by Actions.

Run by hand: `node notify-mail.mjs --dry-run` lists what would be posted. `node digest.mjs --dry-run` prints the digest.

## Adding a platform

Register the platform with billing@oper-stack.com. If its mail comes from a domain not in `PLATFORMS`, add one line there. That is the whole integration.

## Later: the dashboard

When there are enough events, the same script can append each note to a Notion database (one row per event: platform, type, amount, link) and the dashboard is a Notion view. Until then the Telegram chat is the dashboard, and the daily digest is the report.

## Проверка своих продуктов

Раз в сутки, в 06:00 UTC, мы прогоняем то, что продаём, на своём же сайте: ставим свежий
`@operstack/audit` с npm и собираем аудит oper-stack.com, запускаем актор проверки видимости в
Apify и ждём настоящего результата, открываем обе страницы оплаты в Whop и смотрим, видны ли товар,
цена и кнопка. Если что-то сломалось, приходит сообщение в Telegram. Если всё работает, не приходит
ничего: ежедневное «всё хорошо» перестают читать на третий день.

Телеметрии из чужих прогонов у нас нет и не будет. Актор публичный, его запускают посторонние люди
на своих сайтах, и слать нам их адреса значило бы собирать чужие данные под видом мониторинга.
Поэтому мы проверяем себя на себе.

```
APIFY_TOKEN=... TG_TOKEN=... TG_CHAT_ID=... node product-smoke.mjs --dry-run
```

## Радар веток

`radar-run.mjs` ищет свежие обсуждения, где спрашивают то, на что у нас есть ответ, и присылает
в Telegram ссылку, суть и черновик ответа. Он ничего не публикует: на площадки мы заходим руками.

Два источника, и они разные по цене.

| Источник | Цена | Язык | Как часто |
|---|---|---|---|
| Hacker News | бесплатно, ключ не нужен | английский | каждый час, :17 |
| Threads | 0,008 $ за запись через Apify | русский и английский | 7 и 16 UTC |

Про деньги. Весь тариф Apify это 5 $ в месяц и он общий со всей остальной работой. Перед каждым
платным заходом скрипт читает настоящий остаток в `/users/me/usage/monthly` и отказывается, если
порог `RADAR_BUDGET_STOP` пройден, о чём сообщает в Telegram один раз. Поле `usageUsd` из
`/users/me` для этого не годится: пока трата покрыта бесплатным кредитом, оно показывает ноль.

Сколько тут вообще есть работы. Замер 15.09.2026 по шести запросам: за двое суток ноль подходящих
веток, за неделю единицы. Тема даёт единицы обсуждений в неделю, а не в час, поэтому тишина в
Telegram это нормальная работа радара, а не поломка.

```bash
node radar-run.mjs --dry-run                  # бесплатный источник, ничего не отправляя
RADAR_SOURCE=all node radar-run.mjs --dry-run # вместе с платным
```
