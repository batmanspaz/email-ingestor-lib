# email-ingestor-lib

Shared library for per-entity Gmail email ingestors. Provides OAuth2 Gmail client,
incremental polling via history API, cross-entity forwarding, and JSONL logging.

## Usage

Each entity ingestor (carma, collagesoup, perfectcity, personal) imports from this lib:

```js
import { GmailClient, poll, checkAndForward, createLogger } from '../../../shared/email-ingestor-lib/index.js';
```

## Modules

- **gmail.js** — Re-exports `GmailClient` from `~/claude/shared/lib/gmail.js`
- **poll.js** — Incremental poll loop using Gmail history API, dedupes by Message-ID
- **forward.js** — Apply per-entity forward rules, forward misrouted emails
- **log.js** — Append-only JSONL logger per entity

## Auth

All 7 Gmail accounts use OAuth2 refresh tokens stored in `~/claude/shared/config/master.env`.
No interactive auth flow needed — tokens auto-refresh.
