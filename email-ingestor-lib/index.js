/**
 * email-ingestor-lib — Shared library for per-entity email ingestors
 *
 * Exports:
 *   GmailClient  — OAuth2 Gmail API client (refresh-token based)
 *   poll         — incremental poll loop using Gmail history API
 *   checkAndForward — apply forward rules and forward misrouted emails
 *   createLogger — entity-specific JSONL logger
 */

export { GmailClient } from './gmail.js';
export { poll } from './poll.js';
export { checkAndForward } from './forward.js';
export { createLogger } from './log.js';
