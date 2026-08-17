// Phase 0 of contract-v1.1 — the extraction-result contract.
// Plan: ~/claude/intake/CONTRACT-V1.1-PLAN.md
//
// THESE TESTS ARE EXPECTED TO FAIL until the Phase-1 implementation lands. They are
// the specification, written first, per dev-rules §28.4. Do not "fix" them by
// loosening the schema — the schema is the agreed target shape.
//
// Why this contract exists at all: ocr.js's return shape has always been implicit,
// unversioned and unvalidated. That is precisely how PR #35 (2026-08-15) could add
// ocrPartial/ocrPagesExtracted/ocrPagesTotal to the PDF path while two of the three
// consumers silently dropped all three, with no test or schema noticing. And it is
// why a document that failed to extract could return a bare `null` for five
// genuinely different reasons — the root cause behind 766 unusable documents that
// nobody could see (2026-08-16 session).
//
// Unlike intake-contract.v1.schema.json, which is hand-copied into four repos and
// has already drifted, this schema ships inside the package every consumer already
// depends on. One copy, imported — not four, synchronised by hope.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    constructor() {
      this.messages = {
        create: mockCreate,
        stream: (...args) => ({ finalMessage: () => mockCreate(...args) }),
      };
    }
  }
  return { default: MockAnthropic };
});

const { ocrImagePdf, ocrImage } = await import('../ocr.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(
  fs.readFileSync(path.join(root, 'contracts/extraction-result.v1.schema.json'), 'utf8'),
);
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);

const explain = (v) => (v.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
const assertValid = (result) => {
  expect(result, 'extractor returned null/undefined — the contract has no such member').not.toBeNull();
  expect(validate(result), `schema: ${explain(validate)}\ngot: ${JSON.stringify(result)}`).toBe(true);
};

function costTracker(capReached = false) {
  return { isCapReached: vi.fn(() => capReached), record: vi.fn(() => 0.0012) };
}
const reply = (obj, stop_reason = 'end_turn') => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  usage: { input_tokens: 100, output_tokens: 50 },
  stop_reason,
});
const DOC = { raw_text: 'ACME INVOICE\nTotal: $10.00', document_type: 'invoice', is_receipt: false };
const opts = (extra = {}) => ({ apiKey: 'test', costTracker: costTracker(), log: { info() {}, warn() {}, error() {} }, ...extra });

beforeEach(() => { mockCreate.mockReset(); });

describe('extraction-result contract v1 — success shape', () => {
  it('a clean PDF extraction is schema-valid and reports itself complete', async () => {
    mockCreate.mockResolvedValue(reply(DOC));
    const res = await ocrImagePdf(Buffer.from('%PDF-1.4 tiny'), 'invoice.pdf', opts());
    assertValid(res);
    expect(res.ok).toBe(true);
    expect(res.ocrPartial).toBe(false);
    expect(res.ocrTruncated).toBe(false);
  });

  it('an IMAGE extraction carries the same fields as a PDF one (F7)', async () => {
    // ocr.js:392 returns { rawText, structured, parsed, usage, cost } with no page
    // fields at all, so a caller cannot tell "this image was complete" from "this
    // path never reports completeness". Asymmetric contracts get dropped silently.
    mockCreate.mockResolvedValue(reply(DOC));
    const res = await ocrImage(Buffer.from('fakejpeg'), 'scan.jpg', 'jpg', opts());
    assertValid(res);
    expect(res.ocrPartial).toBe(false);
    expect(res).toHaveProperty('ocrPagesExtracted');
    expect(res).toHaveProperty('ocrTruncated');
  });

  it('ocrPartial is ALWAYS present, never conditionally spread', async () => {
    // Today the three page fields are spread only `if (pagesExtracted != null)`, so
    // on the common path they are absent rather than false. `undefined` is not
    // "complete" — it is "this extractor declined to say", and every consumer that
    // does `if (result.ocrPartial)` reads that as a clean document.
    mockCreate.mockResolvedValue(reply(DOC));
    const res = await ocrImagePdf(Buffer.from('%PDF-1.4 tiny'), 'a.pdf', opts());
    expect(Object.keys(res)).toContain('ocrPartial');
    expect(typeof res.ocrPartial).toBe('boolean');
  });

  it('a truncated response reports itself partial (F6)', async () => {
    // ocr.js already computes `truncated = stop_reason === 'max_tokens'` and spends
    // it on a log-message suffix. A caller sees a long rawText and a document_type,
    // so ocr_confidence lands at 80 and document.js's reprocess gate
    // (raw_text_len < 50 || confidence < 60) will never nominate it again. The
    // truncation becomes permanent and invisible.
    mockCreate.mockResolvedValue(reply(DOC, 'max_tokens'));
    const res = await ocrImagePdf(Buffer.from('%PDF-1.4 tiny'), 'long.pdf', opts());
    assertValid(res);
    expect(res.ocrTruncated).toBe(true);
    expect(res.ocrPartial).toBe(true); // truncated is a KIND of partial
  });

  it('a page-split extraction reports which pages it actually read', async () => {
    mockCreate.mockResolvedValue(reply(DOC));
    const res = await ocrImagePdf(Buffer.from('x'.repeat(40 * 1024 * 1024)), 'huge.pdf', opts({
      pdfSplitter: () => ({ buffer: Buffer.from('%PDF-1.4 split'), totalPages: 78, pagesExtracted: 20 }),
    }));
    assertValid(res);
    expect(res.ocrPartial).toBe(true);
    expect(res.ocrPagesExtracted).toBe(20);
    expect(res.ocrPagesTotal).toBe(78);
  });

  it('an unknown page total is null, and does NOT imply a complete read', async () => {
    // pdfinfo is best-effort (ocr.js:69-72) and may leave totalPages null. A
    // consumer must not read null as "no pages missing".
    mockCreate.mockResolvedValue(reply(DOC));
    const res = await ocrImagePdf(Buffer.from('x'.repeat(40 * 1024 * 1024)), 'huge.pdf', opts({
      pdfSplitter: () => ({ buffer: Buffer.from('%PDF-1.4 split'), totalPages: null, pagesExtracted: 20 }),
    }));
    assertValid(res);
    expect(res.ocrPagesTotal).toBeNull();
    expect(res.ocrPartial).toBe(true);
  });
});

describe('extraction-result contract v1 — failure shape (F5)', () => {
  // Every one of these returns a bare `null` today. Five different causes, one
  // indistinguishable value, no way for a health check to count them or for a human
  // to ask "what could this pipeline not read?".

  it('reports cost_cap rather than vanishing', async () => {
    const res = await ocrImagePdf(Buffer.from('%PDF-1.4'), 'x.pdf', opts({ costTracker: costTracker(true) }));
    assertValid(res);
    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe('cost_cap');
  });

  it('reports image_too_large rather than vanishing', async () => {
    const res = await ocrImage(Buffer.from('x'.repeat(40 * 1024 * 1024)), 'big.jpg', 'jpg', opts());
    assertValid(res);
    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe('image_too_large');
  });

  it('reports split_unavailable when an oversized PDF cannot be split', async () => {
    const res = await ocrImagePdf(Buffer.from('x'.repeat(40 * 1024 * 1024)), 'huge.pdf', opts({
      pdfSplitter: () => null, // gs/pdfinfo missing or failed
    }));
    assertValid(res);
    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe('split_unavailable');
  });

  it('reports api_error rather than vanishing', async () => {
    mockCreate.mockRejectedValue(new Error('529 overloaded'));
    const res = await ocrImagePdf(Buffer.from('%PDF-1.4 tiny'), 'x.pdf', opts());
    assertValid(res);
    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe('api_error');
  });

  it('never leaks file contents or a path into `detail`', async () => {
    // detail reaches logs and telemetry. PII-free is a Phase-0 invariant, not a
    // nicety (telemetry-health-standard.md §75).
    mockCreate.mockRejectedValue(new Error('failed reading /Users/server/claude/shared/secret-doc.pdf'));
    const res = await ocrImagePdf(Buffer.from('%PDF-1.4 tiny'), 'x.pdf', opts());
    assertValid(res);
    if (res.detail) {
      expect(res.detail).not.toMatch(/\/Users\//);
      expect(res.detail).not.toMatch(/secret-doc/);
    }
  });
});

describe('extraction-result contract v1 — the migration hazard', () => {
  it('a failure is distinguishable by .ok, because truthiness no longer works', async () => {
    // THE trap in this whole change. Today every consumer does `if (!result)`.
    // A failure OBJECT is truthy, so an un-updated consumer would read a failure as
    // a success and write an empty document as though it extracted fine. Consumers
    // must learn `.ok` BEFORE ocr.js starts returning these — the same
    // consumer-before-producer ordering the envelope contract forces.
    const res = await ocrImagePdf(Buffer.from('%PDF'), 'x.pdf', opts({ costTracker: costTracker(true) }));
    expect(Boolean(res)).toBe(true);   // truthy...
    expect(res.ok).toBe(false);        // ...but NOT a success
  });
});
