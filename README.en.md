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

## Requirements

| Item | Requirement |
| --- | --- |
| DSH | `>=0.2.2-rc.2 <0.3.0` (see `engines.dsh`) |
| Node | `>=18` (the plugin runs inside DSH, so DSH's own runtime is what counts) |
| Network | IMAP reachable: 993 with TLS by default; 143 with SSL turned off also works |
| Mailbox | The inbox folder is fixed to `INBOX`; you need an **app password**, not your web login password |

## Install

```sh
dsh plugin --profile desktop add "link:/path/to/dsh-mail-digest"
```

Then open **Settings → Mail digest → Config**, pick your provider and paste an **app password**
(QQ, 163 and Gmail all require one instead of the login password).

## Usage

1. Add a mailbox in Config and press **Test connection**.
2. Press **Run now** on the Reports tab: fetch → tag and summarise → thread → report. A notice pops up when it lands.
3. You can also just say “digest my mail” in a conversation.
4. For automatic runs, open the Auto tab and pick *every N hours* or *daily at HH:mm*; DSH then shows a
   “Mail digest” scheduled task under Settings → Schedules.

## Tools

| Tool | Purpose |
| --- | --- |
| `mail_status` | Mailboxes (`accountId`), tags, auto toggle, counters |
| `mail_fetch` | Fetch once (all mailboxes when `accountId` is omitted; de-dupes, rebuilds threads, keeps old summaries) |
| `mail_inbox` | List un-filed messages with a body excerpt and their thread |
| `mail_read` | Read one message in full |
| `mail_thread` | Read a whole thread's timeline (required before writing a summary) |
| `mail_file` | Write back tags / summary / priority / needs-reply |
| `mail_thread_summary` | Write a thread's “so far” summary |
| `mail_report` | Produce a report for one mailbox (`overview` and `focus` optional) |
| `mail_reports` | List / read / delete reports |

## FAQ

**Where do I get the app password?** In the webmail settings, never your login password: QQ → Settings →
Account → enable IMAP/SMTP → generate an authorisation code; 163/126 → Settings → POP3/SMTP/IMAP →
enable IMAP → client authorisation password; Gmail → enable 2-step verification, then use an app password.

**“Test connection” fails?** Check, in order: IMAP (not POP3/SMTP) is enabled on the account; host and
port/SSL are right (993 + SSL, or 143 with SSL off); the app password has no stray spaces and was not
just reset (resetting invalidates the old one immediately).

**Only a few messages are fetched?** Two caps live in Config: 30-day window and 100 messages per fetch by
default (up to 3650 days / 500 messages). Only `INBOX` is read — archive folders are not included.

**Why no report this run?** No new messages (every Message-ID was seen) means no report and no notice;
the previous report stays unread.

**Several mailboxes?** Any number, each with its own app password. One automatic run covers all of them and
writes one report per mailbox. Threads are isolated per mailbox, so the same subject arriving twice stays separate.

**Moving to another machine?** Copy the whole `$DSH_HOME/mail-digest/` directory (messages, threads,
reports), then re-enter the app passwords — they live in the DSH credential store, not in these files.

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
