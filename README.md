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
     googleapis internals (`context`, `_options`, `auth`) are not exposed. Each argument is copied
     once — every caller property is read exactly once, in a single pass, into a fresh null-prototype
     object of allowlisted keys and validated primitive values — and googleapis receives ONLY that
     copy, so a Proxy or getter that changes after the check (TOCTOU) cannot smuggle a
     url/method/header/body. A readOnly client is built from its own `new GoogleApis()` instance, so
     `google.options({ adapter, params })` on the shared singleton does not change its requests.
  2. **Non-writable flag** — `client.readOnly` and `client._gmail` are non-writable, non-configurable;
     the OAuth2 client is a private `#oauth2` field. `poll()` never batch-archives a readOnly client and
     `checkAndForward()` declines to forward from one.
  3. **Scope check** — `fromTokenFile({ readOnly: true })` fails closed (`ReadOnlyScopeError`,
     `code: 'READ_ONLY_SCOPE_MISMATCH'`) unless the token file's `scopes` are exactly ONE entry,
     `https://www.googleapis.com/auth/gmail.readonly` (a duplicated entry fails too). The `scope`
     Google returns in the token response of every refresh (the first one included) is verified the
     same way, and a response that is wider or does not state its scope is refused before any Gmail
     request is made. Per-account: a caller can skip just that account.
     A token file that is not valid JSON throws `TokenFileInvalidError` naming only the masked address
     — never the parser's message, which can quote a bare token value.
     Offending scope strings echoed into a `ReadOnlyScopeError` (message and `unexpectedScopes`) are
     capped — at most `MAX_ECHOED_SCOPES`, each cut to `MAX_ECHOED_SCOPE_LEN`, odd characters replaced
     with `?` — since they come from a file or from Google, not from this code.

  **`fromTokenFile()` error codes** — every one names only the masked address and never a path:

  | code | class | scope |
  |---|---|---|
  | `TOKEN_FILE_MISSING` | `TokenFileMissingError` | one account |
  | `TOKEN_FILE_INVALID` | `TokenFileInvalidError` | one account |
  | `REFRESH_TOKEN_MISSING` | `RefreshTokenMissingError` | one account |
  | `READ_ONLY_SCOPE_MISMATCH` | `ReadOnlyScopeError` | one account |
  | `OAUTH_CLIENT_FILE_INVALID` | `OAuthClientFileError` | **shared** — every account without its own OAuth client |

  `PER_ACCOUNT_TOKEN_ERROR_CODES` lists the four per-account codes a multi-account runtime may skip
  while the others continue; the shared client-file failure is deliberately not in it.

  Per-call `timeout` must be a finite number in `[0, MAX_TIMEOUT_MS]` (the setTimeout ceiling). A
  `signal` must be an AbortSignal, and googleapis receives a fresh `AbortSignal.any([signal])`, never
  the caller's object (Node's brand check does not reject a Proxy around a real signal).
  4. **Read-only token (the real backstop)** — a `gmail.readonly`-only refresh token is refused by Google
     for every write, whatever code runs in the process. Layers 1-3 keep honest code honest and fail
     loudly; they cannot contain code that already holds a broader token, which is why layer 3 refuses
     to load one.

  Denials are logged (address masked) to the console and, if `setReadOnlyDenialSink()` is wired to the
  entity logger's `readOnlyDenial()`, to the durable JSONL log (a sink that throws produces one
  console warning, not silence).

  **Not writable-by-default-safe:** `GmailClient.fromTokenFile(addr, entity)` called without
  `{ readOnly: true }` builds a WRITABLE client (other callers depend on it). A protected mailbox
  must always pass the option.

  **Out of scope:** the guard cannot contain code in the same process that patches
  `OAuth2Client.prototype.request` (or google-auth-library / gaxios internals) — a shared class the
  read-only client necessarily uses. Only the read-only token (layer 4) stops that, which is why it is
  the backstop and why layer 3 refuses to build a client from any wider token.

## Auth

All 7 Gmail accounts use OAuth2 refresh tokens stored in `~/claude/shared/config/master.env`.
No interactive auth flow needed — tokens auto-refresh.
