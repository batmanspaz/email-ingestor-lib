/**
 * email-ingestor-lib — Shared library for per-entity email ingestors
 *
 * Exports:
 *   GmailClient  — OAuth2 Gmail API client (refresh-token based)
 *   poll         — incremental poll loop using Gmail history API
 *   checkAndForward — apply forward rules and forward misrouted emails
 *   createLogger — entity-specific JSONL logger
 *   shouldRunSluiceProducer / resolveSluiceGate / computeSluiceGateCheck —
 *     INTAKE_ENTITIES comma-list intake gate (reads deprecated SLUICE_INTAKE
 *     with a warning); emits the `intake.gate` check reporting a disabled
 *     producer as warn/0, never green — NOT yet wired by any consumer
 *   computeProducerStatus / reportProducerHealth / trackProducerRun —
 *     Sluice producer health + analytics contract (dev-rules.md Sec28)
 *   createLocalFileTransport — @perfectcity/telemetry local-jsonl stand-in
 *     transport, until the central ingest Worker is deployed
 */

export { GmailClient } from './gmail.js';
export { poll } from './poll.js';
export { checkAndForward } from './forward.js';
export { createLogger } from './log.js';
export { maskEmail, maskFrom, redact } from './mask.js';
export { shouldRunSluiceProducer, resolveSluiceGate, computeSluiceGateCheck } from './sluice-flag.js';
export {
  computeProducerStatus, reportProducerHealth, trackProducerRun,
  computeTruncationCheck, computeHistoryExpiredCheck, computeStallCheck, computeQuarantineCheck,
} from './producer-health.js';
export { computeQueueDepthCheck, DEPTH_WARN_THRESHOLD, AGE_WARN_MS, AGE_FAIL_MS } from './queue-depth.js';
export { createLocalFileTransport } from './sluice-local-transport.js';
