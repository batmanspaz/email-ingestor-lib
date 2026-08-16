// Relocated from ~/developer/intake/tests/ocr-vision.test.js (Track A follow-on:
// add drop-folder document ingestion to Sluice). Same behavior, adapted for the
// portable shared-lib version: cost-capping and logging are injected via an
// optional options param instead of hard-imported from intake's utils/*.js —
// this module has no ties to any one repo's cost-cap or logging infra.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    constructor() {
      this.messages = { create: mockCreate };
    }
  }
  return { default: MockAnthropic };
});

function makeCostTracker(capReached = false) {
  return {
    isCapReached: vi.fn(() => capReached),
    record: vi.fn((usage) => (usage.input_tokens || 0) * 0.0000008 + (usage.output_tokens || 0) * 0.000004),
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const RECEIPT_RESPONSE = {
  raw_text: 'COSTCO WHOLESALE\nDate: 01/15/2026\nTotal: $142.33',
  document_type: 'receipt',
  sender_name: 'Costco Wholesale',
  sender_address: null,
  sender_phone: null,
  sender_email: null,
  recipient_name: null,
  recipient_address: null,
  date: '2026-01-15',
  reference_number: null,
  amount_owed: null,
  amount_paid: null,
  due_date: null,
  service_date: null,
  creditor_name: null,
  collection_agency: null,
  patient_name: null,
  provider_name: null,
  legal_deadline: null,
  is_collection_notice: false,
  is_medical: false,
  is_legal: false,
  is_receipt: true,
  requires_response: false,
  urgency: 'low',
  signals: ['receipt'],
  summary: 'Costco Wholesale receipt dated January 15, 2026 for $142.33. No action required.',
  vendor: 'Costco Wholesale',
  amount: 142.33,
  currency: 'USD',
  line_items: [{ description: 'Groceries', amount: 142.33 }],
};

const COLLECTION_NOTICE_RESPONSE = {
  raw_text: 'TSI — Transworld Systems Inc.\nAccount: 8675309\nAmount Due: $1,247.00\nOriginal Creditor: Cedars-Sinai Medical Center\nDue: 2026-02-15',
  document_type: 'collection_notice',
  sender_name: 'Transworld Systems Inc.',
  sender_address: '507 Prudential Road, Horsham PA 19044',
  sender_phone: '800-555-0100',
  sender_email: null,
  recipient_name: 'Paul Steinberg',
  recipient_address: null,
  date: '2026-01-01',
  reference_number: '8675309',
  amount_owed: 1247.00,
  amount_paid: null,
  due_date: '2026-02-15',
  service_date: '2025-09-10',
  creditor_name: 'Cedars-Sinai Medical Center',
  collection_agency: 'Transworld Systems Inc.',
  patient_name: 'Paul Steinberg',
  provider_name: 'Cedars-Sinai Medical Center',
  legal_deadline: null,
  is_collection_notice: true,
  is_medical: true,
  is_legal: false,
  is_receipt: false,
  requires_response: true,
  urgency: 'high',
  signals: ['task', 'collection', 'medical', 'financial'],
  summary: 'Collection notice from Transworld Systems Inc. (TSI) for $1,247 owed to original creditor Cedars-Sinai Medical Center. Payment due February 15, 2026.',
  vendor: null,
  amount: null,
  currency: 'USD',
  line_items: [],
};

// Plan 1 Phase 3 (Sluice, 2026-07-13): a bank/investment account statement
// has no single "amount owed/paid" — it's a periodic balance snapshot. The
// prompt previously had no fields for this at all (confirmed by reading it
// directly before this change), so a real Schwab statement would extract
// nothing useful even with is_receipt correctly false. Additive only —
// every existing field/behavior above is unchanged.
const STATEMENT_RESPONSE = {
  raw_text: 'CHARLES SCHWAB\nIRA Account Statement\nApril 1-30, 2026\nBeginning Value: $196,667.35\nEnding Value: $212,493.63',
  document_type: 'financial_statement',
  sender_name: 'Charles Schwab & Co Inc',
  sender_address: null,
  sender_phone: null,
  sender_email: null,
  recipient_name: 'Paul Steinberg',
  recipient_address: null,
  date: '2026-04-30',
  reference_number: '...8814',
  amount_owed: null,
  amount_paid: null,
  due_date: null,
  service_date: null,
  creditor_name: null,
  collection_agency: null,
  patient_name: null,
  provider_name: null,
  legal_deadline: null,
  is_collection_notice: false,
  is_medical: false,
  is_legal: false,
  is_receipt: false,
  requires_response: false,
  urgency: 'low',
  signals: ['financial'],
  summary: 'Charles Schwab IRA account statement for April 2026.',
  vendor: null,
  amount: null,
  currency: 'USD',
  line_items: [],
  statement_period: 'April 1-30, 2026',
  beginning_value: 196667.35,
  ending_value: 212493.63,
  period_gain_loss: 15826.28,
  account_last_four: '8814',
};

function makeApiResponse(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 2000, output_tokens: 300 },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ocr (shared email-ingestor-lib)', () => {
  let ocrImagePdf;
  let ocrImage;

  beforeEach(async () => {
    mockCreate.mockReset();
    vi.resetModules();
    const mod = await import('../ocr.js');
    ocrImagePdf = mod.ocrImagePdf;
    ocrImage = mod.ocrImage;
  });

  // ── Guard conditions ─────────────────────────────────────────────────────

  it('returns null for oversized PDFs when no page-split fallback is available (real-world: gs missing)', async () => {
    const bigBuffer = Buffer.alloc(31 * 1024 * 1024);
    // Explicit stub keeps this test hermetic (no real `gs` process spawned) and
    // documents the "split unavailable" case — see the dedicated pdfSplitter
    // tests below for the "split succeeds" / "split still too big" cases.
    const result = await ocrImagePdf(bigBuffer, 'huge.pdf', { pdfSplitter: async () => null });
    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // ── Oversized-PDF page-split fallback (2026-08-16) ───────────────────────
  // Real incident: a 78-page, 59MB scanner batch (a single multi-page drop,
  // not a dense single page) sat unprocessed forever — MAX_FILE_SIZE rejected
  // it outright with no retry. Classification only needs the first few pages,
  // so an injected pdfSplitter (default impl shells out to `gs`) gets one
  // retry on just the first OVERSIZED_PDF_PAGE_LIMIT pages before giving up.

  it('retries with the first pages via the injected pdfSplitter when the trimmed buffer fits under the cap', async () => {
    const bigBuffer = Buffer.alloc(59 * 1024 * 1024);
    const trimmed = Buffer.from('trimmed-first-pages-pdf');
    const pdfSplitter = vi.fn(async () => ({ buffer: trimmed, totalPages: 78 }));
    mockCreate.mockResolvedValue(makeApiResponse(RECEIPT_RESPONSE));

    const result = await ocrImagePdf(bigBuffer, 'scan.pdf', { pdfSplitter });

    expect(pdfSplitter).toHaveBeenCalledOnce();
    expect(pdfSplitter.mock.calls[0][0]).toBe(bigBuffer);
    expect(mockCreate).toHaveBeenCalledOnce();
    const sentPdf = mockCreate.mock.calls[0][0].messages[0].content.find(c => c.type === 'document');
    expect(sentPdf.source.data).toBe(trimmed.toString('base64'));
    expect(result).not.toBeNull();
    expect(result.ocrPartial).toBe(true);
    expect(result.ocrPagesExtracted).toBe(3);
    expect(result.ocrPagesTotal).toBe(78);
  });

  it('reports totalPages as extracted-page-count when the splitter cannot determine the real total', async () => {
    const bigBuffer = Buffer.alloc(59 * 1024 * 1024);
    const pdfSplitter = vi.fn(async () => ({ buffer: Buffer.from('trimmed'), totalPages: null }));
    mockCreate.mockResolvedValue(makeApiResponse(RECEIPT_RESPONSE));

    const result = await ocrImagePdf(bigBuffer, 'scan.pdf', { pdfSplitter });
    expect(result.ocrPagesTotal).toBeNull();
    expect(result.ocrPagesExtracted).toBe(3);
  });

  it('falls back to null when the split buffer is still over the cap (dense first pages) — never calls the API', async () => {
    const bigBuffer = Buffer.alloc(59 * 1024 * 1024);
    const stillTooBig = Buffer.alloc(31 * 1024 * 1024);
    const pdfSplitter = vi.fn(async () => ({ buffer: stillTooBig, totalPages: 2 }));

    const result = await ocrImagePdf(bigBuffer, 'dense.pdf', { pdfSplitter });
    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('falls back to null when the splitter throws (e.g. gs not installed) — never propagates the error', async () => {
    const bigBuffer = Buffer.alloc(59 * 1024 * 1024);
    const pdfSplitter = vi.fn(async () => { throw new Error('spawn gs ENOENT'); });

    const result = await ocrImagePdf(bigBuffer, 'scan.pdf', { pdfSplitter });
    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('the real default (sync, non-injected) splitter never throws when `gs` is missing — falls back to null', async () => {
    // No pdfSplitter injected: exercises the actual default implementation
    // (shells out to `gs`), which is synchronous — a real bug (missing
    // Promise.resolve at the call site) slipped past every other test here
    // because they all injected an `async () => ...` mock; caught by a live
    // run against a real file, not by this suite, before this test existed.
    // PATH is scrubbed (not garbage input — real Ghostscript recovers from
    // malformed PDF bytes and can still emit trivial output, which isn't the
    // scenario this test is for) to force a genuine ENOENT, deterministically
    // reproducing "gs not installed" without depending on gs's own error-
    // recovery behavior.
    const realPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const bigBuffer = Buffer.alloc(31 * 1024 * 1024);
      const result = await ocrImagePdf(bigBuffer, 'huge.pdf');
      expect(result).toBeNull();
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      process.env.PATH = realPath;
    }
  });

  it('never invokes the splitter for a PDF already under the size cap', async () => {
    mockCreate.mockResolvedValue(makeApiResponse(RECEIPT_RESPONSE));
    const pdfSplitter = vi.fn();
    const result = await ocrImagePdf(Buffer.from('small-pdf'), 'small.pdf', { pdfSplitter });
    expect(pdfSplitter).not.toHaveBeenCalled();
    expect(result.ocrPartial).toBeUndefined();
  });

  it('returns null when the injected cost tracker reports the cap reached', async () => {
    const costTracker = makeCostTracker(true);
    const result = await ocrImagePdf(Buffer.from('fake-pdf'), 'test.pdf', { costTracker });
    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('defaults to no cost cap when no tracker is injected', async () => {
    mockCreate.mockResolvedValue(makeApiResponse(RECEIPT_RESPONSE));
    const result = await ocrImagePdf(Buffer.from('fake-pdf'), 'test.pdf');
    expect(result).not.toBeNull();
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it('handles API errors gracefully', async () => {
    mockCreate.mockRejectedValue(new Error('Rate limited'));
    const result = await ocrImagePdf(Buffer.from('fake-pdf'), 'error.pdf');
    expect(result).toBeNull();
  });

  it('handles malformed JSON gracefully', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Here is the extracted text from the document but I forgot JSON' }],
      usage: { input_tokens: 1000, output_tokens: 100 },
    });
    const result = await ocrImagePdf(Buffer.from('fake-pdf'), 'bad.pdf');
    expect(result).not.toBeNull();
    expect(result.rawText).toContain('extracted text');
    expect(result.structured).toBeNull();
    expect(result.parsed).toBeNull();
  });

  // ── Truncation recovery ──────────────────────────────────────────────────
  // Real production bug (2026-07-05): a dense multi-page expense report hit
  // max_tokens mid-generation, cutting the response off inside the raw_text
  // string value with no closing quote/braces at all. JSON.parse threw, and
  // the old fallback returned the ENTIRE raw API response (including the
  // ```json fence) as rawText — polluting body_text/classification with JSON
  // noise instead of the actual extracted document text.

  it('requests a generous max_tokens budget so dense documents do not truncate', async () => {
    mockCreate.mockResolvedValue(makeApiResponse(RECEIPT_RESPONSE));
    await ocrImagePdf(Buffer.from('fake-pdf'), 'receipt.pdf');
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.max_tokens).toBeGreaterThanOrEqual(8192);
  });

  it('recovers the partial raw_text when the response is truncated mid-string (no closing quote/braces)', async () => {
    // Real shape: valid JSON prefix, cut off mid raw_text value, nothing closed.
    const truncatedText = '```json\n{\n  "raw_text": "6/21/26, 12:23 PM   PerfectCity Expense Report\\n\\nPeriod: '
      + 'January 1 – April 30, 2026 | Employee: Paul Steinberg';
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: truncatedText }],
      usage: { input_tokens: 5000, output_tokens: 2048 },
      stop_reason: 'max_tokens',
    });
    const result = await ocrImagePdf(Buffer.from('fake-pdf'), 'expense-report.pdf');
    expect(result).not.toBeNull();
    expect(result.rawText).toContain('PerfectCity Expense Report');
    expect(result.rawText).toContain('Paul Steinberg');
    expect(result.rawText).not.toContain('```json');
    expect(result.rawText).not.toContain('"raw_text"');
    // Recovered text is unescaped (real newlines, not literal backslash-n)
    expect(result.rawText).toContain('\n\n');
    expect(result.structured).toBeNull();
    expect(result.parsed).toBeNull();
  });

  it('recovers partial raw_text even when the field value contains an escaped quote', async () => {
    const truncatedText = '{\n  "raw_text": "Invoice for \\"Acme Corp\\" — line item';
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: truncatedText }],
      usage: { input_tokens: 1000, output_tokens: 2048 },
      stop_reason: 'max_tokens',
    });
    const result = await ocrImagePdf(Buffer.from('fake-pdf'), 'invoice.pdf');
    expect(result.rawText).toBe('Invoice for "Acme Corp" — line item');
  });

  it('still falls back to the full raw response when no raw_text field can be recovered at all', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'The model just rambled with no JSON structure whatsoever, partial or otherwise.' }],
      usage: { input_tokens: 500, output_tokens: 2048 },
      stop_reason: 'max_tokens',
    });
    const result = await ocrImagePdf(Buffer.from('fake-pdf'), 'garbled.pdf');
    expect(result.rawText).toContain('rambled with no JSON structure');
  });

  // ── Prompt coverage ──────────────────────────────────────────────────────

  it('sends the universal prompt containing all required field names', async () => {
    mockCreate.mockResolvedValue(makeApiResponse(RECEIPT_RESPONSE));
    await ocrImagePdf(Buffer.from('fake-pdf'), 'receipt.pdf');
    expect(mockCreate).toHaveBeenCalledOnce();

    const callArgs = mockCreate.mock.calls[0][0];
    const promptText = callArgs.messages[0].content.find(c => c.type === 'text').text;

    expect(promptText).toContain('document_type');
    const requiredFields = [
      'sender_name', 'sender_address', 'sender_phone', 'sender_email',
      'recipient_name', 'reference_number', 'amount_owed', 'amount_paid',
      'due_date', 'service_date', 'creditor_name', 'collection_agency',
      'patient_name', 'provider_name', 'legal_deadline',
      'is_collection_notice', 'is_medical', 'is_legal', 'is_receipt',
      'requires_response', 'urgency', 'signals', 'summary', 'line_items',
    ];
    for (const field of requiredFields) {
      expect(promptText, `prompt missing field: ${field}`).toContain(field);
    }
    expect(promptText).toContain('collection_notice');
    expect(promptText).toContain('medical_bill');
    expect(promptText).toContain('eob');
    expect(promptText).toContain('legal_document');
    // Plan 1 Phase 3: statement-specific fields, additive.
    for (const field of ['statement_period', 'beginning_value', 'ending_value', 'period_gain_loss', 'account_last_four']) {
      expect(promptText, `prompt missing field: ${field}`).toContain(field);
    }
    expect(promptText).toContain('financial_statement');
    expect(promptText).toContain('bank_statement');
  });

  // ── Statement parsing (Plan 1 Phase 3) ───────────────────────────────────

  it('parses a bank/investment statement — beginning/ending value and period gain, structured stays null (not a receipt)', async () => {
    mockCreate.mockResolvedValue(makeApiResponse(STATEMENT_RESPONSE));
    const result = await ocrImagePdf(Buffer.from('fake-pdf'), 'schwab-statement.pdf');

    expect(result).not.toBeNull();
    expect(result.rawText).toContain('CHARLES SCHWAB');
    expect(result.structured).toBeNull(); // is_receipt is false — not receipt-shaped
    const p = result.parsed;
    expect(p.document_type).toBe('financial_statement');
    expect(p.beginning_value).toBe(196667.35);
    expect(p.ending_value).toBe(212493.63);
    expect(p.period_gain_loss).toBe(15826.28);
    expect(p.statement_period).toBe('April 1-30, 2026');
    expect(p.account_last_four).toBe('8814');
    expect(p.sender_name).toBe('Charles Schwab & Co Inc');
  });

  it('a non-statement document simply has null/undefined statement fields — no crash, no spurious values', async () => {
    mockCreate.mockResolvedValue(makeApiResponse(RECEIPT_RESPONSE));
    const result = await ocrImagePdf(Buffer.from('fake-pdf'), 'receipt.pdf');
    expect(result.parsed.beginning_value ?? null).toBeNull();
    expect(result.parsed.ending_value ?? null).toBeNull();
  });

  // ── Receipt parsing ──────────────────────────────────────────────────────

  it('extracts structured receipt data and backward-compat fields', async () => {
    const costTracker = makeCostTracker();
    mockCreate.mockResolvedValue(makeApiResponse(RECEIPT_RESPONSE));
    const result = await ocrImagePdf(Buffer.from('fake-pdf'), 'receipt.pdf', { costTracker });

    expect(result).not.toBeNull();
    expect(result.rawText).toContain('COSTCO');
    expect(result.structured).not.toBeNull();
    expect(result.structured.vendor).toBe('Costco Wholesale');
    expect(result.structured.amount).toBe(142.33);
    expect(result.structured.date).toBe('2026-01-15');
    expect(result.structured.currency).toBe('USD');
    expect(result.structured.line_items).toHaveLength(1);
    expect(result.parsed.document_type).toBe('receipt');
    expect(result.parsed.is_receipt).toBe(true);
    expect(result.parsed.urgency).toBe('low');
    expect(result.parsed.signals).toContain('receipt');
    expect(result.cost).toBeGreaterThan(0);
    expect(costTracker.record).toHaveBeenCalledWith({ input_tokens: 2000, output_tokens: 300 });
  });

  // ── Collection notice parsing ─────────────────────────────────────────────

  it('correctly parses a collection notice — all new fields present', async () => {
    mockCreate.mockResolvedValue(makeApiResponse(COLLECTION_NOTICE_RESPONSE));
    const result = await ocrImagePdf(Buffer.from('fake-pdf'), 'tsi-notice.pdf');

    expect(result).not.toBeNull();
    expect(result.rawText).toContain('TSI');
    expect(result.structured).toBeNull();
    const p = result.parsed;
    expect(p.document_type).toBe('collection_notice');
    expect(p.is_collection_notice).toBe(true);
    expect(p.is_medical).toBe(true);
    expect(p.is_legal).toBe(false);
    expect(p.requires_response).toBe(true);
    expect(p.urgency).toBe('high');
    expect(p.sender_name).toBe('Transworld Systems Inc.');
    expect(p.creditor_name).toBe('Cedars-Sinai Medical Center');
    expect(p.collection_agency).toBe('Transworld Systems Inc.');
    expect(p.amount_owed).toBe(1247.00);
    expect(p.due_date).toBe('2026-02-15');
    expect(p.reference_number).toBe('8675309');
    expect(p.signals).toContain('collection');
    expect(p.signals).toContain('task');
    expect(p.signals).toContain('medical');
    expect(p.summary).toContain('TSI');
  });

  // ── Non-receipt, non-critical document ───────────────────────────────────

  it('returns null structured for non-receipt documents', async () => {
    mockCreate.mockResolvedValue(makeApiResponse({
      raw_text: 'Meeting notes from Tuesday standup',
      document_type: 'other',
      is_receipt: false,
      is_collection_notice: false,
      is_medical: false,
      is_legal: false,
      requires_response: false,
      urgency: 'low',
      signals: [],
      summary: 'Internal meeting notes.',
      vendor: null, amount: null, currency: 'USD', line_items: [],
      sender_name: null, date: null, reference_number: null,
      amount_owed: null, amount_paid: null, due_date: null,
      service_date: null, creditor_name: null, collection_agency: null,
      patient_name: null, provider_name: null, legal_deadline: null,
      sender_address: null, sender_phone: null, sender_email: null,
      recipient_name: null, recipient_address: null,
    }));
    const result = await ocrImagePdf(Buffer.from('fake-pdf'), 'notes.pdf');
    expect(result).not.toBeNull();
    expect(result.rawText).toContain('Meeting notes');
    expect(result.structured).toBeNull();
    expect(result.parsed.document_type).toBe('other');
    expect(result.parsed.urgency).toBe('low');
  });

  // ── Cost calculation (via injected tracker) ──────────────────────────────

  it('returns the cost value produced by the injected cost tracker', async () => {
    const costTracker = makeCostTracker();
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"raw_text":"test","document_type":"other","is_receipt":false}' }],
      usage: { input_tokens: 10000, output_tokens: 500 },
    });
    const result = await ocrImagePdf(Buffer.from('fake-pdf'), 'cost.pdf', { costTracker });
    // 10000 * 0.0000008 + 500 * 0.000004 = 0.008 + 0.002 = 0.01
    expect(result.cost).toBeCloseTo(0.01, 4);
  });

  // ── ocrImage (image files) ───────────────────────────────────────────────

  it('ocrImage also uses the universal prompt and returns parsed', async () => {
    mockCreate.mockResolvedValue(makeApiResponse(RECEIPT_RESPONSE));
    const result = await ocrImage(Buffer.from('fake-image'), 'photo.jpg', '.jpg');
    expect(result).not.toBeNull();
    expect(result.parsed.document_type).toBe('receipt');
    expect(result.structured).not.toBeNull();
    expect(result.structured.vendor).toBe('Costco Wholesale');
  });

  it('ocrImage returns null when the injected cost tracker reports the cap reached', async () => {
    const costTracker = makeCostTracker(true);
    const result = await ocrImage(Buffer.from('fake-image'), 'photo.jpg', '.jpg', { costTracker });
    expect(result).toBeNull();
  });
});
