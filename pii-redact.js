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

/**
 * Hard resource limits (R2, Sonnet C3/M9, Opus H10). Anything over a limit is HELD 'too_large' — never processed
 * partially, never hangs. Tests inject smaller limits via opts.limits.
 */
export const LIMITS = Object.freeze({
  maxBytes: 100 * 1024 * 1024,
  maxPages: 500,
  maxImagePixels: 100_000_000,
  maxZipEntries: 1000,
  maxZipUncompressedBytes: 500 * 1024 * 1024,
  maxZipRatio: 100,
  maxZipDepth: 3,
  engineTimeoutMs: 120_000,
});

/**
 * Every type the producers can EXTRACT text from must be sanitizable (R2, Opus D4/D5/C8): the sanitizer's supported
 * set is a superset of the extractors' set. Anything else that carries a PII pattern in ANY decoding (latin1, UTF-8,
 * UTF-16LE/BE) is HELD 'unsupported'.
 */
export const SANITIZABLE_EXTENSIONS = Object.freeze([
  '.pdf', '.jpg', '.jpeg', '.png', '.tiff', '.tif', '.heic',
  '.txt', '.csv', '.log', '.json', '.xml', '.html', '.htm', '.md', '.eml',
  '.docx', '.xlsx', '.rtf',
  '.zip', '.pages', '.numbers', '.key',
]);

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
 * Make a file or archive-member NAME safe to show/store (R2, Sonnet C2, Opus D14/H11): names are content — the
 * producers put them in the envelope subject (-> tier-2 LLM), manifests, archive and vault paths, logs.
 * Masks every PII pattern maskText would (SSN -> XXX-XX-1234 etc.), strips path separators / '..' / control
 * characters, keeps the extension. Pure.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFilename(name) { // eslint-disable-line no-unused-vars
  throw notImplemented('sanitizeFilename');
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
 * Redact one document held in memory. Supports every SANITIZABLE_EXTENSIONS type: PDF (text layer + local OCR of
 * EVERY page and every embedded image), images (local OCR + pixel blackout, EXIF stripped), txt/csv/html/md/json/
 * xml/log/eml (any of UTF-8/UTF-16/latin1), docx/xlsx (EVERY part), rtf, and zip (every member + member NAMES,
 * nested; one held member holds the whole zip).
 * R2 contract additions (red-team fold-in):
 *  - PDF output is written with garbage=4, deflate, clean, NEVER incremental; one revision, no orphan objects.
 *  - 'clean' (identical bytes) only if the independent verifier's broad net finds nothing on ANY surface of the
 *    INPUT, raw file bytes included — otherwise the file is rewritten ('redacted') or held.
 *  - AcroForm fields carrying PII are DELETED (value, /DV, appearance stream), not blanked.
 *  - R3 (Fable C1): image pixels are changed IN PLACE in the image XObject (same pixel dimensions), never covered
 *    by a drawn rectangle; /Thumb thumbnails are dropped; hidden-OCG / soft-mask / tiny images and embedded
 *    binaries (images, PDFs) are redacted recursively or the file is held. Image files lose EXIF/XMP/PNG-text and
 *    embedded thumbnails; every frame of a multi-frame image is redacted.
 *  - R3 (Fable L2): ALL local OCR goes through deps.ocr (default: tesseract CLI wrapper) — the seam is real.
 *  - Output is byte-deterministic (fixed /ID, no ModDate) so content-addressed envelope ids do not duplicate.
 *  - Temp files live in a 0700 dir under os.tmpdir() and are removed on every exit path.
 *  - Engine stderr / exceptions never surface matched values (only reason codes).
 * @param {Buffer} buffer
 * @param {{filename:string, mode?:'off'|'shadow'|'enforce', deps?:object, limits?:object}} opts
 *   deps.ocr(png:Buffer)=>Promise<string>  LOCAL ocr (default tesseract). NEVER a remote model.
 *   deps.verify(buffer, {filename})=>Promise<{ok:boolean,residual:object[]}>  override for tests
 *   deps.detect(text)=>Finding[]  TEST-ONLY override of the narrow detector; the verifier must NOT use it
 *   deps.engineCmd: string[]  TEST-ONLY argv replacing the python engine; deps.engineTimeoutMs
 *   deps.now()=>string
 *   limits: partial override of LIMITS
 * @returns {Promise<RedactResult>}
 */
export async function redactBuffer(buffer, opts) { // eslint-disable-line no-unused-vars
  throw notImplemented('redactBuffer');
}

/**
 * Verify a redacted output: re-extract every surface (text layer, raw streams, metadata, XMP, form fields,
 * annotations, bookmarks, embedded files) AND locally OCR rendered pages; report any unmasked pattern.
 * R3 (Fable C1/M4/M5): also EVERY image XObject at native resolution (incl. /Thumb, SMask, hidden-OCG, Form-XObject
 * images; residual surface 'image_xobject') and every embedded / FileAttachment payload inspected as a FILE by type
 * (residual 'embedded_file'). A uniform fill in a label's value window counts as a located MASKED value.
 * R2 (Sonnet C4, Opus D1/D3): a DELIBERATELY BROADER, fail-closed net than detectPii — NFKC + Unicode-digit
 * folding, zero-width/soft-hyphen stripped, any 9-digit or 3-2-4 run in any script, partial masks (5-8 digits of an
 * SSN) — over raw file bytes + every decoded object/stream (filebytes, objects) as well as the visible surfaces;
 * OCRs EVERY page with two different local OCR setups; any page where an SSN/TIN LABEL is found but no value
 * (masked or unmasked) is located in its window -> residual {kind:'ssn', surface:'ocr_label_without_value'}.
 * @returns {Promise<{ok:boolean, residual:{kind:string, surface:string}[]}>}
 */
export async function verifyRedacted(buffer, opts) { // eslint-disable-line no-unused-vars
  throw notImplemented('verifyRedacted');
}

/**
 * The argv used to spawn the python engine (R3, Fable M3). The no-network guarantee must not depend on python flags:
 * either the command is wrapped in a deny-network sandbox (`sandbox-exec -p '(version 1)(allow default)(deny network*)'`)
 * or it is a plain `python3 <redact_pdf.py> ...` WITHOUT -I/-E/-S (those disable sitecustomize and so the test guard).
 * @param {string[]} args  engine CLI args
 * @returns {string[]} argv
 */
export function engineCommand(args) { // eslint-disable-line no-unused-vars
  throw notImplemented('engineCommand');
}

/**
 * Copy an original into the vault: <vaultDir>/<yyyy>/<sha256>-<safeName>, dirs 0700, file 0600, sha256 verified
 * after the copy. Never overwrites. Does NOT delete the source (the caller owns the move).
 * R2 (Sonnet H7, Opus H19/D12): safeName = sanitizeFilename(name); modes are explicit (independent of umask);
 * the vault ROOT is 0700 (an existing group/world-readable root is refused); the realpath of vaultDir must not be
 * inside iCloud (~/Library/Mobile Documents, ~/Library/CloudStorage, iCloud Desktop & Documents); no symlink
 * anywhere under the vault root.
 * @returns {Promise<{vaultPath:string, sha256:string}>}
 */
export async function vaultOriginal(inPath, opts) { // eslint-disable-line no-unused-vars
  throw notImplemented('vaultOriginal');
}

/**
 * File-level wrapper used by the producers: reads inPath, runs redactBuffer, and on 'redacted' also writes the
 * derivative to outDir as <name>-REDACTED<ext>, vaults the original, and writes the sidecar report next to the
 * vault file (<sha256>.redaction-report.json, 0600). inPath itself is never modified.
 * R2: <name> is sanitizeFilename(basename); the derivative is written only AFTER verification passed (no unverified
 * candidate ever exists in outDir); a vault failure -> held 'vault_failed' with nothing left in outDir.
 * opts.deps / opts.limits are passed through to redactBuffer.
 * @returns {Promise<{outcome:string, reason?:string, outPath?:string, vaultPath?:string, reportPath?:string, report:object}>}
 */
export async function redactFile(inPath, opts) { // eslint-disable-line no-unused-vars
  throw notImplemented('redactFile');
}

/**
 * Health + analytics reporter shared by both producers (Telemetry & Health Standard / Rule 13).
 * telemetry = { track(event:string, props:object):void, heartbeat(h:{module,status,ttl_seconds,checks,mode}):void }
 * beginRun() -> fileResult(result) per file -> endRun() ALWAYS (even with zero files / after an error).
 * R2 (Opus D15/M7, Sonnet M7): opts {telemetry, mode, enforceSince?, now?}. The heartbeat carries `mode`; after
 * enforceSince, any mode other than 'enforce' is `degraded` (check id 'mode_regressed') — a lost env var must not
 * silently revert to sending raw text. Checks include 'files_seen' (0 is a valid, distinguishable value).
 * endRun is idempotent (one heartbeat per run). Error NAMES are allow-listed to built-in Error class names.
 * Nothing emitted ever carries a sha256, filename or private digit.
 * @returns {{beginRun():void, fileResult(r:RedactResult):void, endRun(opts?:{error?:Error}):void}}
 */
export function createRedactionReporter(opts) { // eslint-disable-line no-unused-vars
  throw notImplemented('createRedactionReporter');
}
