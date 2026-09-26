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
- **readonly-guard.js** — Enforced read-only accounts, for any mailbox that must never be modified by
  ingestion (e.g. emilee.stone@collagesoup.com). `new GmailClient({ ..., readOnly: true })` or
  `GmailClient.fromTokenFile(addr, entity, { readOnly: true })`. Defence in depth, four layers:
  1. **Proxy** — the raw googleapis client is wrapped so ONLY `get` / `list` / `getProfile` go through;
     every other call (modify, batchModify, trash, send, drafts, labels, settings, watch, and any method
     added later) throws `ReadOnlyAccountError` (`code: 'READ_ONLY_ACCOUNT'`). Per-call `params` and
     `options` are allowlisted too (googleapis lets a caller override `url`/`method` via options), and
     googleapis internals (`context`, `_options`, `auth`) are not exposed.
  2. **Non-writable flag** — `client.readOnly` and `client._gmail` are non-writable, non-configurable;
     the OAuth2 client is a private `#oauth2` field. `poll()` never batch-archives a readOnly client and
     `checkAndForward()` declines to forward from one.
  3. **Scope check** — `fromTokenFile({ readOnly: true })` fails closed (`ReadOnlyScopeError`,
     `code: 'READ_ONLY_SCOPE_MISMATCH'`) unless the token file's `scopes` are exactly
     `https://www.googleapis.com/auth/gmail.readonly`. Per-account: a caller can skip just that account.
  4. **Read-only token (the real backstop)** — a `gmail.readonly`-only refresh token is refused by Google
     for every write, whatever code runs in the process. Layers 1-3 keep honest code honest and fail
     loudly; they cannot contain code that already holds a broader token, which is why layer 3 refuses
     to load one.

  Denials are logged (address masked) to the console and, if `setReadOnlyDenialSink()` is wired to the
  entity logger's `readOnlyDenial()`, to the durable JSONL log.

## Auth

All 7 Gmail accounts use OAuth2 refresh tokens stored in `~/claude/shared/config/master.env`.
No interactive auth flow needed — tokens auto-refresh.
