/**
 * pii-redact.js — PII redaction for documents entering Intake. **PHASE 0 STUB.**
 *
 * Every export below throws E_NOT_IMPLEMENTED on purpose: Phase 0 of the PII-redaction plan
 * (~/claude/shared/plans/2026-10-15-intake-pii-redaction-plan.md) is the RED test contract only.
 * The signatures, result shapes and event schemas here ARE the contract — see
 * ~/claude/shared/plans/2026-10-15-intake-pii-redaction-P0-spec.md. The tests in
 * tests/pii-redact/*.red.test.js fail until Phase 1 (engine + detectors) lands.
 *
 * Decisions (Paul, 2026-10-15): SSN/ITIN keep last 4 (XXX-XX-1234); also redact bank account +
 * routing numbers, date of birth, e-file PIN / prior-year AGI, driver's-license / state-ID numbers;
 * originals go to a local vault outside Intake; every document with an SSN pattern is in scope;
 * anything that cannot be redacted AND verified is HELD.
 */

export const PII_KINDS = ['ssn', 'itin', 'bank_account', 'routing', 'dob', 'efile_pin', 'agi', 'dl_id'];
/** Roll-up keys used in events/reports: ssn (ssn+itin), bank (account+routing), dob, pin (efile_pin+agi), id (dl_id). */
export const COUNT_KEYS = ['ssn', 'bank', 'dob', 'pin', 'id'];
export const MODES = ['off', 'shadow', 'enforce'];
export const REPORT_SCHEMA = 'pii-redaction-report/v1';
export const HELD_REASONS = [
  'encrypted', 'corrupt', 'corrupt_member', 'verify_failed', 'ocr_unavailable', 'unsupported', 'too_large', 'engine_error', 'vault_failed',
];

function notImplemented(name) {
  const e = new Error(`pii-redact: ${name} not implemented (Phase 0 RED stub)`);
  e.code = 'E_NOT_IMPLEMENTED';
  return e;
}

/** @typedef {{kind:string,start:number,end:number,length:number,mask:string}} Finding */
/** @typedef {{ssn:number,bank:number,dob:number,pin:number,id:number}} Counts */

/**
 * Pure detector. Finds private numbers in plain text.
 * @param {string} text
 * @param {{labelWindow?:number}} [opts]
 * @returns {Finding[]}
 */
export function detectPii(text, opts) { // eslint-disable-line no-unused-vars
  throw notImplemented('detectPii');
}

/**
 * Pure masker. SSN/ITIN -> XXX-XX-<last4>; bank_account -> [REDACTED-BANK]; routing -> [REDACTED-ROUTING];
 * dob -> [REDACTED-DOB]; efile_pin -> [REDACTED-PIN]; agi -> [REDACTED-AGI]; dl_id -> [REDACTED-ID].
 * Idempotent: maskText(maskText(x).text).findings is empty.
 * @returns {{text:string, findings:Finding[], counts:Counts}}
 */
export function maskText(text, opts) { // eslint-disable-line no-unused-vars
  throw notImplemented('maskText');
}

/**
 * @typedef {object} RedactResult
 * @property {'clean'|'redacted'|'detected'|'held'} outcome
 *   clean    - nothing found (or mode 'off'); buffer is the INPUT bytes, identical
 *   redacted - enforce mode; buffer is the redacted derivative
 *   detected - shadow mode found PII; buffer is the ORIGINAL, unchanged
 *   held     - could not redact AND verify; NO buffer; caller must not ingest/archive/send anywhere
 * @property {Buffer} [buffer]
 * @property {string} [reason]  one of HELD_REASONS for held; 'mode_off' for off
 * @property {object} report    RedactionReport v1 (see spec) — contains no private digits and no filename
 */

/**
 * Redact one document held in memory. Supports PDF (text layer + local OCR for image-only pages), txt/csv/html,
 * docx, and zip (every member sanitized; one held member holds the whole zip).
 * @param {Buffer} buffer
 * @param {{filename:string, mode?:'off'|'shadow'|'enforce', deps?:object}} opts
 *   deps.ocr(png:Buffer)=>Promise<string>  LOCAL ocr (default tesseract). NEVER a remote model.
 *   deps.verify(buffer, {filename})=>Promise<{ok:boolean,residual:object[]}>  override for tests
 *   deps.now()=>string
 * @returns {Promise<RedactResult>}
 */
export async function redactBuffer(buffer, opts) { // eslint-disable-line no-unused-vars
  throw notImplemented('redactBuffer');
}

/**
 * Verify a redacted output: re-extract every surface (text layer, raw streams, metadata, XMP, form fields,
 * annotations, bookmarks, embedded files) AND locally OCR rendered pages; report any unmasked pattern.
 * @returns {Promise<{ok:boolean, residual:{kind:string, surface:string}[]}>}
 */
export async function verifyRedacted(buffer, opts) { // eslint-disable-line no-unused-vars
  throw notImplemented('verifyRedacted');
}

/**
 * Copy an original into the vault: <vaultDir>/<yyyy>/<sha256>-<safeName>, dirs 0700, file 0600, sha256 verified
 * after the copy. Never overwrites. Does NOT delete the source (the caller owns the move).
 * @returns {Promise<{vaultPath:string, sha256:string}>}
 */
export async function vaultOriginal(inPath, opts) { // eslint-disable-line no-unused-vars
  throw notImplemented('vaultOriginal');
}

/**
 * File-level wrapper used by the producers: reads inPath, runs redactBuffer, and on 'redacted' also writes the
 * derivative to outDir as <name>-REDACTED<ext>, vaults the original, and writes the sidecar report next to the
 * vault file (<sha256>.redaction-report.json, 0600). inPath itself is never modified.
 * @returns {Promise<{outcome:string, reason?:string, outPath?:string, vaultPath?:string, reportPath?:string, report:object}>}
 */
export async function redactFile(inPath, opts) { // eslint-disable-line no-unused-vars
  throw notImplemented('redactFile');
}

/**
 * Health + analytics reporter shared by both producers (Telemetry & Health Standard / Rule 13).
 * telemetry = { track(event:string, props:object):void, heartbeat(h:{module,status,ttl_seconds,checks}):void }
 * beginRun() -> fileResult(result) per file -> endRun() ALWAYS (even with zero files / after an error).
 * @returns {{beginRun():void, fileResult(r:RedactResult):void, endRun(opts?:{error?:Error}):void}}
 */
export function createRedactionReporter(opts) { // eslint-disable-line no-unused-vars
  throw notImplemented('createRedactionReporter');
}
