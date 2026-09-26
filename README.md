# email-ingestor-lib

Shared library for per-entity Gmail email ingestors. Provides OAuth2 Gmail client,
incremental polling via history API, cross-entity forwarding, and JSONL logging.

## Usage

Each entity ingestor (collagesoup, perfectcity, personal) imports from this lib:

```js
import { GmailClient, poll, checkAndForward, createLogger } from '../../../shared/email-ingestor-lib/index.js';
```

## Modules

- **gmail.js** — Re-exports `GmailClient` from `~/claude/shared/lib/gmail.js`
- **poll.js** — Incremental poll loop using Gmail history API, dedupes by Message-ID
- **forward.js** — Apply per-entity forward rules, forward misrouted emails
- **log.js** — Append-only JSONL logger per entity
- **readonly-guard.js** — Enforced read-only accounts. `new GmailClient({ ..., readOnly: true })` or
  `GmailClient.fromTokenFile(addr, entity, { readOnly: true })` wraps the raw googleapis client so ONLY
  `get` / `list` / `getProfile` calls go through; every other Gmail call (modify, batchModify, trash,
  send, drafts, labels, settings, watch, and any method added later) throws `ReadOnlyAccountError`
  (`code: 'READ_ONLY_ACCOUNT'`) and is logged with the address masked. `poll()` never batch-archives a
  readOnly client and `checkAndForward()` declines to forward from one. Use it for any mailbox that must
  never be modified by ingestion (e.g. emilee.stone@collagesoup.com).

## Auth

All 7 Gmail accounts use OAuth2 refresh tokens stored in `~/claude/shared/config/master.env`.
No interactive auth flow needed — tokens auto-refresh.
