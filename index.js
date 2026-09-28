/**
 * email-ingestor-lib — Shared library for per-entity email ingestors
 *
 * Exports:
 *   GmailClient  — OAuth2 Gmail API client (refresh-token based); readOnly:true
 *     makes every Gmail write throw ReadOnlyAccountError (readonly-guard.js)
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
export {
  ReadOnlyAccountError, ReadOnlyScopeError, TokenFileInvalidError, guardGmailApi, READ_VERBS, READONLY_SCOPE, setReadOnlyDenialSink,
  TokenFileMissingError, RefreshTokenMissingError, OAuthClientFileError, PER_ACCOUNT_TOKEN_ERROR_CODES,
  MAX_TIMEOUT_MS, MAX_ECHOED_SCOPES, MAX_ECHOED_SCOPE_LEN, MAX_ACCOUNT_LABEL_LEN, safeScopeList, safeAccountLabel,
} from './readonly-guard.js';
export { createLogger } from './log.js';
export { maskEmail, maskFrom, redact } from './mask.js';
export { shouldRunSluiceProducer, resolveSluiceGate, computeSluiceGateCheck } from './sluice-flag.js';
export {
  computeProducerStatus, reportProducerHealth, trackProducerRun,
  computeTruncationCheck, computeHistoryExpiredCheck, computeStallCheck, computeQuarantineCheck,
  producerHealthStats, producerRunStats,
} from './producer-health.js';
export { computeQueueDepthCheck, DEPTH_WARN_THRESHOLD, AGE_WARN_MS, AGE_FAIL_MS } from './queue-depth.js';
export { createLocalFileTransport } from './sluice-local-transport.js';
