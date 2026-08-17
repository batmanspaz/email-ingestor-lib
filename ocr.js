/**
 * ocr.js — Haiku-vision OCR for image-only PDFs and images.
 * Sends a document/image to Claude Haiku and extracts structured data for any
 * document type. Shared across entity producers (the legacy intake document
 * processor, Sluice document-drop producers).
 *
 * Cost-capping and logging are the CALLER's responsibility, injected via an
 * optional options param — this module has no opinion on where cost state
 * lives or how errors get logged, so it stays a portable dependency with no
 * ties to any one repo's infra (moved 2026-07-05 out of intake's
 * src/processors/ocr-vision.js, which hard-imported that repo's own
 * utils/llm-cost.js + utils/logger.js; those stayed in intake since
 * llm-cost.js has 8+ other consumers there unrelated to OCR).
 */

import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB
// Real production bug (2026-07-05): a dense multi-page expense report hit the
// old 2048-token cap mid-generation, truncating the response inside the
// raw_text string value. Bumped generously — verbatim extraction of a
// multi-page document plus every structured field easily exceeds 2048 tokens.
// 32000, not 8192: measured against a real 78-page scan at ~1,067 output
// tokens/page, a 15-page extract truncates at 16k — and truncation destroys
// the structured fields outright (parseOcrResponse can only salvage partial
// raw_text, leaving document_type/date/amount null). max_tokens is a ceiling,
// not a target, so headroom is free unless used. Haiku 4.5 caps at 64k output.
const MAX_OUTPUT_TOKENS = 32000;
// Real incident (2026-08-16): a 78-page, 59MB scanner batch sat unprocessed
// forever — MAX_FILE_SIZE rejected it outright with no retry. Classification
// only needs the first pages, not the whole document, so an oversized PDF gets
// exactly one retry on just its first N pages before giving up for real.
// 20 pages ≈ 21k output tokens, comfortably inside MAX_OUTPUT_TOKENS; the
// splitter steps this down further when the pages themselves are too large.
const OVERSIZED_PDF_PAGE_LIMIT = 20;
let client = null;

function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const NOOP_COST_TRACKER = { isCapReached: () => false, record: () => 0 };
const NOOP_LOG = { info() {}, warn() {}, error() {} };

/**
 * Default pdfSplitter: shells out to `gs` (Ghostscript) to extract the first
 * `lastPage` pages of an oversized PDF into a small buffer, and (best-effort,
 * via `pdfinfo`) the real total page count. Never throws — any failure
 * (binary missing, corrupt PDF, etc.) returns null so the caller falls back
 * to today's "too large, skip" behavior exactly as before this existed.
 * Injectable via opts.pdfSplitter specifically so unit tests never shell out
 * to a real process — same posture as document-drop-producer.js's injected
 * ocr/pdfParse deps.
 */
function defaultPdfSplitter(buffer, { firstPage = 1, lastPage, maxBytes }) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'ocr-split-'));
    const inPath = join(dir, 'in.pdf');
    writeFileSync(inPath, buffer);

    let totalPages = null;
    try {
      const info = execFileSync('pdfinfo', [inPath], { stdio: 'pipe' }).toString();
      const m = info.match(/^Pages:\s*(\d+)/m);
      if (m) totalPages = parseInt(m[1], 10);
    } catch { /* best-effort only — a trimmed buffer is still usable without a total */ }

    // Page count and byte size are independent limits: a text PDF fits 20 pages
    // in a few MB, while a 600dpi scan runs ~0.8MB/page and blows the cap around
    // 35. Rather than guess a single safe page count for every document, step
    // down until the extract actually fits — measured, not assumed.
    // A window past the end of the document has nothing to extract. Say so rather
    // than handing back an empty PDF that reads as "successfully extracted nothing".
    if (totalPages != null && firstPage > totalPages) return null;

    for (const pages of [lastPage, 12, 8, 5, 3].filter((p, i, a) => p <= lastPage && a.indexOf(p) === i)) {
      const outPath = join(dir, `out-${pages}.pdf`);
      const last = firstPage + pages - 1;
      execFileSync('gs', [
        '-sDEVICE=pdfwrite', '-dNOPAUSE', '-dBATCH', '-dQUIET',
        `-dFirstPage=${firstPage}`, `-dLastPage=${last}`,
        `-sOutputFile=${outPath}`, inPath,
      ], { stdio: 'pipe' });
      const trimmed = readFileSync(outPath);
      if (trimmed.length <= maxBytes) {
        // Clamp to what actually exists: asking for 20 pages starting at 61 of a
        // 78-page document yields 18, and reporting 20 would misstate coverage.
        const available = totalPages != null ? Math.max(0, totalPages - firstPage + 1) : pages;
        return { buffer: trimmed, totalPages, firstPage, pagesExtracted: Math.min(pages, available) };
      }
    }
    return null; // even the smallest extract is over the cap — caller falls back to skipping
  } catch {
    return null;
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmpdir cleanup is best-effort */ } }
  }
}

const UNIVERSAL_PROMPT = `Extract all text from this document verbatim. Then classify the document type and extract all relevant structured fields.

Return ONLY valid JSON (no markdown, no explanation):
{
  "raw_text": "complete verbatim text extracted from the document",
  "document_type": one of: "receipt" | "invoice" | "collection_notice" | "medical_bill" | "medical_statement" | "eob" | "legal_document" | "contract" | "correspondence_letter" | "contact_card" | "business_card" | "financial_statement" | "bank_statement" | "tax_document" | "insurance_document" | "government_document" | "form" | "other",
  "sender_name": "name of the person or organization that sent this document, or null",
  "sender_address": "sender full mailing address, or null",
  "sender_phone": "sender phone number, or null",
  "sender_email": "sender email address, or null",
  "recipient_name": "name of the person this is addressed to, or null",
  "recipient_address": "recipient mailing address, or null",
  "date": "document date as YYYY-MM-DD, or null",
  "reference_number": "account number, claim number, case number, invoice number, or any other reference ID, or null",
  "amount_owed": total dollar amount currently owed as a number or null,
  "amount_paid": dollar amount already paid as a number or null,
  "due_date": "payment deadline as YYYY-MM-DD, or null",
  "service_date": "date of service (medical or legal) as YYYY-MM-DD, or null",
  "creditor_name": "original creditor name for collection notices, or null",
  "collection_agency": "name of the collection agency if this is a collection notice, or null",
  "patient_name": "patient name for medical documents, or null",
  "provider_name": "healthcare provider or legal provider name, or null",
  "legal_deadline": "any legal response deadline as YYYY-MM-DD, or null",
  "is_collection_notice": true or false,
  "is_medical": true or false,
  "is_legal": true or false,
  "is_receipt": true or false,
  "requires_response": true if there is a deadline or action required, false otherwise,
  "urgency": "high" | "medium" | "low",
  "signals": array of applicable strings from: ["task", "contact", "deal", "receipt", "calendar", "medical", "legal", "financial", "collection"],
  "summary": "2-3 sentence plain-English summary of what this document is and what action, if any, is required",
  "vendor": "vendor or store name for receipts/invoices, or null",
  "amount": total transaction amount as a number for receipts/invoices or null,
  "currency": "USD" or other currency code,
  "line_items": [{"description": "item description", "amount": 0.00}] or [],
  "statement_period": "the statement's covered period as free text (e.g. 'April 1-30, 2026'), for financial_statement/bank_statement documents only, or null",
  "beginning_value": "for financial_statement/bank_statement documents: the account's total value/balance at the START of the statement period, as a number, or null",
  "ending_value": "for financial_statement/bank_statement documents: the account's total value/balance at the END of the statement period, as a number, or null",
  "period_gain_loss": "for financial_statement/bank_statement documents: the net gain or loss over the period if explicitly stated (may be negative), as a number, or null",
  "account_last_four": "the last 4 digits of the account number, if shown, or null"
}

All fields not applicable to this document type should be null (or [] for arrays).`;

// Minimal JSON string unescaping for a partially-recovered (unterminated)
// string value — recoverPartialRawText below extracts a raw_text value that
// JSON.parse never got to see, so its escape sequences need manual decoding.
function unescapeJsonString(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

// Best-effort recovery of just the raw_text field's value from a response
// that failed full JSON.parse — most commonly because the model's output was
// cut off mid-generation (hit max_tokens) before the JSON object closed.
// Tolerant of an unterminated (missing closing quote) string value: matches
// as far as it can before hitting an unescaped quote or the end of input.
// Returns the recovered string, or null if no raw_text field is found at all.
function recoverPartialRawText(text) {
  const m = text.match(/"raw_text"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!m) return null;
  return unescapeJsonString(m[1]);
}

/**
 * Parse the raw Haiku response text into a structured result object.
 * Maintains backward compatibility: always populates rawText, structured (for receipts).
 *
 * Three-tier fallback when the response isn't valid JSON (most commonly a
 * dense document truncating mid-generation at max_tokens):
 *   1. Full JSON.parse succeeds → structured + parsed fields all populated.
 *   2. JSON.parse fails, but a raw_text field value is still recoverable
 *      (even unterminated) → salvage just that, no structured/parsed data.
 *   3. Nothing resembling raw_text is found at all → last resort, the whole
 *      raw response text (this is the "the model just rambled" case, not
 *      the truncation case — genuinely no extracted text to salvage).
 */
function parseOcrResponse(text, filename, log, { truncated = false } = {}) {
  const truncNote = truncated ? ' (response truncated at max_tokens)' : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const rawText = parsed.raw_text || text;
      const structured = parsed.is_receipt ? {
        vendor: parsed.vendor || parsed.sender_name,
        amount: parsed.amount || parsed.amount_owed,
        currency: parsed.currency || 'USD',
        date: parsed.date,
        line_items: parsed.line_items || [],
      } : null;
      return { rawText, structured, parsed };
    } catch (err) {
      log.warn(`OCR JSON parse failed for ${filename}${truncNote}: ${err.message}`);
    }
  } else {
    log.warn(`OCR response not valid JSON for ${filename}${truncNote}, attempting partial recovery`);
  }

  const partial = recoverPartialRawText(text);
  if (partial) {
    log.warn(`OCR: recovered partial raw_text for ${filename} from an incomplete/malformed response (${partial.length} chars)`);
    return { rawText: partial, structured: null, parsed: null };
  }

  log.warn(`OCR: no raw_text recoverable for ${filename}, using full raw response as text`);
  return { rawText: text, structured: null, parsed: null };
}

/**
 * OCR a PDF buffer using Claude Haiku vision.
 * @param {Buffer} pdfBuffer - Raw PDF bytes
 * @param {string} filename - Original filename (for logging)
 * @param {object} [opts] - { costTracker: {isCapReached, record}, log: {info,warn,error} }
 * @returns {Promise<object|null>} Result with rawText, structured, parsed, usage, cost
 */
// ── extraction-result contract v1 ───────────────────────────────────────────
// contracts/extraction-result.v1.schema.json. Ships inside this package, so every
// consumer validates against ONE copy rather than four hand-synchronised ones.
//
// Failures used to be a bare `null` for five genuinely different causes, so a
// caller could not tell "too big" from "cost cap" from "the API fell over" — the
// root cause behind 766 documents that failed silently and invisibly.
//
// ⚠️ A failure object is TRUTHY. Consumers must check `.ok`, never truthiness.
// intake #155 and personal-email-ingestor #24 shipped that check FIRST, before
// this file began emitting the new shape.

/** Strip anything path- or filename-shaped: `detail` reaches logs and telemetry. */
function safeDetail(message) {
  if (!message) return undefined;
  return String(message).replace(/\/\S+/g, '<path>').slice(0, 200);
}

const fail = (failureReason, detail) => ({
  ok: false,
  failureReason,
  ...(safeDetail(detail) ? { detail: safeDetail(detail) } : {}),
});

/**
 * Every success carries all four completeness fields, always.
 *
 * They used to be spread conditionally, so on the common path they were ABSENT
 * rather than false — and `undefined` is not "complete", it is "this extractor
 * declined to say". Consumers doing `if (result.ocrPartial)` read that as a clean
 * document. The image path omitted them entirely (F7).
 *
 * `truncated` counts as partial: hitting max_tokens means the document was not
 * fully read, which is the same fact as a page split, arrived at differently (F6).
 */
function success({ rawText, structured, parsed, usage, cost, pagesStart = 1, pagesExtracted, pagesTotal, truncated }) {
  const split = pagesExtracted != null;
  // Still partial if pages remain beyond this window — a continuation pass that
  // reads 21..40 of 78 has recovered a lot and is still not the whole document.
  const moreAfter = split && pagesTotal != null && (pagesStart + pagesExtracted - 1) < pagesTotal;
  return {
    ok: true,
    rawText,
    structured,
    parsed,
    usage,
    cost,
    ocrPartial: Boolean(moreAfter || (split && pagesTotal == null) || truncated),
    ocrPagesStart: pagesStart,
    ocrPagesExtracted: split ? pagesExtracted : null,
    ocrPagesTotal: split ? (pagesTotal ?? null) : null,
    ocrTruncated: Boolean(truncated),
  };
}

export async function ocrImagePdf(pdfBuffer, filename, opts = {}) {
  const costTracker = opts.costTracker || NOOP_COST_TRACKER;
  const log = opts.log || NOOP_LOG;
  const splitPdf = opts.pdfSplitter || defaultPdfSplitter;

  // startPage lets a caller CONTINUE a partial read (pages 21..40) instead of
  // retrying it (pages 1..20 again, identically, for the same money).
  const startPage = opts.startPage || 1;
  let buffer = pdfBuffer;
  let pagesStart = 1;
  let pagesExtracted = null;
  let pagesTotal = null;

  // A continuation is a split by definition — the window is not the whole file, so
  // it must go through the splitter even when the buffer would fit under the cap.
  if (buffer.length > MAX_FILE_SIZE || startPage > 1) {
    // Promise.resolve(...) rather than assuming splitPdf itself returns a
    // promise — the default implementation is sync (execFileSync), and
    // opts.pdfSplitter is a public injectable interface callers may implement
    // either way.
    const split = await Promise.resolve(
      splitPdf(buffer, { firstPage: startPage, lastPage: OVERSIZED_PDF_PAGE_LIMIT, maxBytes: MAX_FILE_SIZE }),
    ).catch(() => null);
    if (split && split.buffer && split.buffer.length > 0 && split.buffer.length <= MAX_FILE_SIZE) {
      buffer = split.buffer;
      // Trust the splitter's own count over the requested ceiling — it steps
      // pages down to fit the size cap, so the two routinely differ.
      pagesExtracted = split.pagesExtracted ?? OVERSIZED_PDF_PAGE_LIMIT;
      pagesTotal = split.totalPages ?? null;
      pagesStart = split.firstPage ?? startPage;
      log.warn(`PDF too large for OCR (${(pdfBuffer.length / 1024 / 1024).toFixed(1)}MB > 30MB) — retrying with first ${pagesExtracted}${pagesTotal ? ` of ${pagesTotal}` : ''} pages only: ${filename}`);
    } else {
      log.warn(`PDF too large for OCR: ${filename} (${(pdfBuffer.length / 1024 / 1024).toFixed(1)}MB > 30MB) — page-split fallback unavailable or still too large`);
      // Distinct from file_too_large: the file IS too large, but what actually
      // blocked us is that gs/pdfinfo could not produce a smaller extract.
      return fail('split_unavailable');
    }
  }

  if (costTracker.isCapReached()) {
    log.warn(`Daily cost cap reached — skipping OCR for ${filename}`);
    // Recoverable tomorrow — the caller can and should retry. That is exactly
    // what a bare null could never say.
    return fail('cost_cap');
  }

  try {
    const anthropic = getClient();
    // .stream(...).finalMessage() rather than .create(): above ~16k max_tokens
    // the SDK refuses a non-streaming call outright ("Streaming is required for
    // operations that may take longer than 10 minutes"), and a 20-page scan
    // measured 122s at 16k. Same response shape either way — only the transport
    // changes, so every caller and the parse path below are unaffected.
    const response = await anthropic.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: MAX_OUTPUT_TOKENS,
      // No cache_control here -- and DO NOT add one just because UNIVERSAL_PROMPT
      // grows, without also reordering the content array. This was gotten
      // wrong once already (2026-08-09): the original version of this comment
      // said caching would be "silently ignored" because the prompt alone
      // measures ~946 tokens (exact-tokenizer count, corrected from an
      // earlier ~850 char/4 estimate), under Haiku 4.5's 4096 floor. That's
      // true for the prompt ALONE, but caching is a PREFIX match, and the
      // document block comes FIRST below -- a cache_control breakpoint here
      // would cover document+prompt together, and a dense multi-page PDF
      // routinely pushes that combined prefix past 4096 on its own (measured:
      // a trivial 5KB single-page PDF is already ~2519 tokens). So a
      // cache_control WOULD be honored by the API -- and would be actively
      // WASTEFUL, since the document differs every call (paying the 1.25x
      // cache-write premium for a cache that's read zero times). The real
      // blocker is block order (document before prompt), not prompt size.
      // Fixing this for real would mean moving UNIVERSAL_PROMPT to a separate
      // `system` param ahead of the per-call document, THEN caching that.
      // Watch item: UNIVERSAL_PROMPT itself grew 28% in one commit (e42b4e4,
      // ~740->946 tokens) and already exceeds Opus 5/Fable 5's 512-token
      // floor -- if this ever moves off Haiku, re-measure before assuming
      // nothing changed.
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: buffer.toString('base64'),
            },
          },
          {
            type: 'text',
            text: UNIVERSAL_PROMPT,
          },
        ],
      }],
    }).finalMessage();

    const usage = response.usage || {};
    const cost = costTracker.record(usage);
    log.info(`OCR cost: $${(cost || 0).toFixed(4)} — ${filename}`);

    const text = response.content[0]?.text || '';
    const truncated = response.stop_reason === 'max_tokens';
    const { rawText, structured, parsed } = parseOcrResponse(text, filename, log, { truncated });

    return success({ rawText, structured, parsed, usage, cost, pagesStart, pagesExtracted, pagesTotal, truncated });
  } catch (err) {
    log.error(`OCR failed for ${filename}`, { error: err.message });
    return fail('api_error', err.message);
  }
}

const EXT_TO_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.tiff': 'image/tiff',
  '.heic': 'image/heic',
};

/**
 * OCR an image buffer (JPG/PNG) using Claude Haiku vision.
 * @param {Buffer} imageBuffer - Raw image bytes
 * @param {string} filename - Original filename
 * @param {string} ext - File extension (e.g. '.jpg')
 * @param {object} [opts] - { costTracker: {isCapReached, record}, log: {info,warn,error} }
 * @returns {Promise<object|null>} Result with rawText, structured, parsed, usage, cost
 */
export async function ocrImage(imageBuffer, filename, ext, opts = {}) {
  const costTracker = opts.costTracker || NOOP_COST_TRACKER;
  const log = opts.log || NOOP_LOG;

  if (imageBuffer.length > MAX_FILE_SIZE) {
    log.warn(`Image too large for OCR: ${filename} (${(imageBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
    // Unlike a PDF there is no page-split escape hatch for an image — this one
    // never becomes recoverable on its own.
    return fail('image_too_large');
  }

  if (costTracker.isCapReached()) {
    log.warn(`Daily cost cap reached — skipping OCR for ${filename}`);
    return fail('cost_cap');
  }

  const mediaType = EXT_TO_MIME[ext.toLowerCase()] || 'image/jpeg';

  try {
    const anthropic = getClient();
    // .stream(...).finalMessage() rather than .create(): above ~16k max_tokens
    // the SDK refuses a non-streaming call outright ("Streaming is required for
    // operations that may take longer than 10 minutes"), and a 20-page scan
    // measured 122s at 16k. Same response shape either way — only the transport
    // changes, so every caller and the parse path below are unaffected.
    const response = await anthropic.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: MAX_OUTPUT_TOKENS,
      // Same UNIVERSAL_PROMPT, same reasoning as ocrImagePdf above: ~850
      // tokens is under Haiku 4.5's real 4096-token cache minimum, so no
      // cache_control here either (audited 2026-08-09).
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: imageBuffer.toString('base64'),
            },
          },
          {
            type: 'text',
            text: UNIVERSAL_PROMPT,
          },
        ],
      }],
    }).finalMessage();

    const usage = response.usage || {};
    const cost = costTracker.record(usage);
    log.info(`Image OCR cost: $${(cost || 0).toFixed(4)} — ${filename}`);

    const text = response.content[0]?.text || '';
    const truncated = response.stop_reason === 'max_tokens';
    const { rawText, structured, parsed } = parseOcrResponse(text, filename, log, { truncated });

    // pagesExtracted/pagesTotal are structurally null for an image — but the
    // FIELDS are present, so a consumer can tell "one page, complete" from
    // "this path never reports completeness" (F7).
    return success({ rawText, structured, parsed, usage, cost, pagesStart: 1, pagesExtracted: null, pagesTotal: null, truncated });
  } catch (err) {
    log.error(`Image OCR failed for ${filename}`, { error: err.message });
    return fail('api_error', err.message);
  }
}
