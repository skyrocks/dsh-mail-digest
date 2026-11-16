# dsh-mail-digest

[![CI](https://github.com/skyrocks/dsh-mail-digest/actions/workflows/ci.yml/badge.svg)](https://github.com/skyrocks/dsh-mail-digest/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-MIT-blue.svg)

A DeepSeek Harness plugin that **keeps your mailbox sorted and hands you a report each run**.

It fetches IMAP mail on a schedule, tags every message, writes a one-line summary, threads related
messages into a timeline with a summary, and turns each run into a report — opened in the right
sidebar or in your browser, announced by an in-app notice.

## The idea

The hard part of email is not reading it; it is knowing which three messages matter. A report
answers exactly three things: **what is the highlight, what needs you, and which threads moved**.
Everything else is kept as titles only, so it costs you no attention.

## What a report looks like

```
Mail digest · Work · 15:50
Contracts are wrapping up; the rest is marketing.
20 new · 3 to reply · 1 high priority

## Highlights
- Liquidated-damages clause waiting on legal: they reply Thursday

## Needs you
- Contract terms · Zhang · 11-01 17:00 · reply
  - confirm payment terms

## Thread progress
### Contract terms (5 messages, 11-01 → 11-09, +5 this run)
**Summary**: payment went from 45 to 30 days; damages clause still with legal.

## What this batch was
Promotions 15 · Work 5 · Contracts 5

## Everything else (titles only)
- 11-04 17:00 · Shop · Promotion 3
```

Each report is written three ways: `reports/<id>.json` (panel), `<id>.html` (browser), `<id>.md` (text).

## Tabs

| Tab | Contents |
| --- | --- |
| Reports | The list you land on: unread marks, one click opens the report in the right sidebar (with “Open in browser”), delete. “Run now” in the corner; account switcher when you have several mailboxes |
| Auto | Toggle plus a cadence — every N hours, or daily at HH:mm. One run covers every mailbox and writes one report per mailbox |
| Config | Mailbox list (add/remove, optionally drop its data), provider presets that fill IMAP host/port, account and app password, time window, tag suggestions |

## Install

```sh
dsh plugin --profile desktop add "link:/path/to/dsh-mail-digest"
```

Then open **Settings → Mail digest → Config**, pick your provider and paste an **app password**
(QQ, 163 and Gmail all require one instead of the login password).

## Data

Everything lives under `$DSH_HOME/mail-digest/`: `account.json` (mailboxes, tags, schedule),
`messages.json`, `threads.json`, `reports.json` and `reports/<id>.{json,html,md}`.
App passwords are **not** in these files — each mailbox has its own key
`DSH_MAIL_DIGEST_MAIL_<accountId>` in the DSH credential store.

## Safety

- Read-only mailbox access: no replies, no deletions, no read-state changes (`BODY.PEEK`).
- Passwords only ever reach the credential store.
- Deleting a report removes its three local files and returns that batch to “pending”, so the next
  run can rebuild it.

## Limits

- Attachment contents are not stored (file names only); the whole message is still read to parse it.
- Up to 500 messages per fetch, up to 3650 days back.
- Automatic runs depend on DSH's scheduler: nothing runs while the Host is down.
- Threading uses mail headers plus subject/participant fallback; unrelated topics will not merge.

## Development

```sh
npm install
npm test
```

Node 22/24 on macOS, Linux and Windows in CI. No network access is required by the tests.
