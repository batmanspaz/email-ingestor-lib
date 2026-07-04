/**
 * email-ingestor-lib — Shared library for per-entity email ingestors
 *
 * Exports:
 *   GmailClient  — OAuth2 Gmail API client (refresh-token based)
 *   poll         — incremental poll loop using Gmail history API
 *   checkAndForward — apply forward rules and forward misrouted emails
 *   createLogger — entity-specific JSONL logger
 *   shouldRunSluiceProducer — SLUICE_INTAKE comma-list resolver
 *   computeProducerStatus / reportProducerHealth / trackProducerRun —
 *     Sluice producer health + analytics contract (dev-rules.md Sec28)
 */

export { GmailClient } from './gmail.js';
export { poll } from './poll.js';
export { checkAndForward } from './forward.js';
export { createLogger } from './log.js';
export { maskEmail, maskFrom, redact } from './mask.js';
export { shouldRunSluiceProducer } from './sluice-flag.js';
export { computeProducerStatus, reportProducerHealth, trackProducerRun } from './producer-health.js';
