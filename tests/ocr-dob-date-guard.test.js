// tasks.db #1407: receipt OCR picked a date of birth (and other non-document
// dates) as the document's date on medical paperwork — e.g. the account
// holder's DOB printed on a CVS vaccination history became receipt_date
// 1963-12-30. The regex producer (~/claude/shared/lib/receipt_processor.py
// parse_date) was fixed in 5041143/#1606; this is the LLM producer every live
// ingestor (intake document-drop, email ingestors) goes through. payload.date
// from here lands in receipts.receipt_date via intake's ledger-db connector.
//
// Two layers, both tested: the prompt tells the model what `date` is NOT, and a
// deterministic guard rejects a `date` the model returned anyway when the OCR
// text shows that exact date only next to a birth-date label.

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

function makeApiResponse(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 2000, output_tokens: 300 },
  };
}

function medicalDoc(overrides) {
  return {
    raw_text: '',
    document_type: 'medical_bill',
    sender_name: 'CVS Pharmacy',
    date: null,
    service_date: null,
    due_date: null,
    is_medical: true,
    is_receipt: true,
    vendor: 'CVS Pharmacy',
    amount: 25.0,
    currency: 'USD',
    line_items: [],
    ...overrides,
  };
}

describe('ocr date guard — never use a date of birth as the document date (#1407)', () => {
  let ocrImagePdf;
  let ocrImage;
  let guardDocumentDates;

  beforeEach(async () => {
    mockCreate.mockReset();
    vi.resetModules();
    const mod = await import('../ocr.js');
    ocrImagePdf = mod.ocrImagePdf;
    ocrImage = mod.ocrImage;
    guardDocumentDates = mod.guardDocumentDates;
  });

  async function run(payload) {
    mockCreate.mockResolvedValue(makeApiResponse(payload));
    return ocrImagePdf(Buffer.from('fake-pdf'), 'scan.pdf');
  }

  it('the prompt tells the model the document date is never a date of birth', async () => {
    await run(medicalDoc({ raw_text: 'x' }));
    const prompt = JSON.stringify(mockCreate.mock.calls[0][0]);
    expect(prompt).toMatch(/date of birth/i);
    expect(prompt).toMatch(/service/i);
  });

  it('DOB + service date: a model-returned DOB is replaced by the service date', async () => {
    const r = await run(medicalDoc({
      raw_text: 'CVS Pharmacy\nPatient: Paul S\nDOB: 12/30/1963\nDate of Service: 08/30/2024\nCopay $25.00',
      date: '1963-12-30',
      service_date: '2024-08-30',
    }));
    expect(r.ok).toBe(true);
    expect(r.parsed.date).toBe('2024-08-30');
    expect(r.structured.date).toBe('2024-08-30');
    expect(r.parsed.date_guard).toEqual({ reason: 'date_of_birth', rejected_fields: ['date'], replaced_with: 'service_date' });
  });

  it('DOB only (vaccination history): the DOB is dropped to null, never kept', async () => {
    const r = await run(medicalDoc({
      raw_text: 'CVS Pharmacy Vaccination History\nName: Paul S   Date of Birth: 12/30/1963\nInfluenza  administered',
      date: '1963-12-30',
      is_receipt: false,
    }));
    expect(r.parsed.date).toBeNull();
    expect(r.parsed.date_guard).toEqual({ reason: 'date_of_birth', rejected_fields: ['date'], replaced_with: null });
  });

  it('date_guard never carries the rejected DOB value (PII — parsed is persisted by consumers)', async () => {
    const r = await run(medicalDoc({ raw_text: 'DOB: 12/30/1963\nvaccine record', date: '1963-12-30' }));
    expect(JSON.stringify(r.parsed.date_guard)).not.toContain('1963');
  });

  it('a service_date that is itself the DOB is also dropped; the one labelled document date is used', async () => {
    const r = await run(medicalDoc({
      raw_text: 'Patient DOB 04/08/2016\nStatement Date: 03/15/2025',
      date: '2016-04-08',
      service_date: '2016-04-08',
    }));
    expect(r.parsed.service_date).toBeNull();
    expect(r.parsed.date).toBe('2025-03-15');
    expect(r.parsed.date_guard).toEqual({ reason: 'date_of_birth', rejected_fields: ['service_date', 'date'], replaced_with: 'labelled_document_date' });
  });

  it('with two different labelled document dates there is no single fallback: null, not a guess', async () => {
    const r = await run(medicalDoc({
      raw_text: 'DOB 04/08/2016\nStatement Date: 03/15/2025\nDate of Service: 02/01/2025',
      date: '2016-04-08',
    }));
    expect(r.parsed.date).toBeNull();
  });

  it('a rejected service_date is recorded even when date itself survives', async () => {
    const r = await run(medicalDoc({
      raw_text: 'DOB: 12/30/1963\nStatement Date: 02/11/2025',
      date: '2025-02-11',
      service_date: '1963-12-30',
    }));
    expect(r.parsed.date).toBe('2025-02-11');
    expect(r.parsed.service_date).toBeNull();
    expect(r.parsed.date_guard).toEqual({ reason: 'date_of_birth', rejected_fields: ['service_date'], replaced_with: null });
  });

  it('a right-aligned form field (label far left of the date, >40 chars of spaces) is still caught', async () => {
    const r = await run(medicalDoc({ raw_text: `Date of Birth:${' '.repeat(50)}12/30/1963\nflu shot`, date: '1963-12-30' }));
    expect(r.parsed.date).toBeNull();
  });

  it('a newborn visit whose document date is labelled only "Date:" keeps that date', async () => {
    const r = await run(medicalDoc({ raw_text: 'Date: 03/15/2025\nDOB: 03/15/2025', date: '2025-03-15' }));
    expect(r.parsed.date).toBe('2025-03-15');
  });

  it('"Birth Date:" is still a birth label even though it ends in "Date:"', async () => {
    const r = await run(medicalDoc({ raw_text: 'Birth Date: 12/30/1963\nimmunization record', date: '1963-12-30' }));
    expect(r.parsed.date).toBeNull();
  });

  it.each([
    ['D.O.B.: 12/30/1963', '1963-12-30'],
    ['Birthdate 1963-12-30', '1963-12-30'],
    ['Born on December 30, 1963', '1963-12-30'],
    ['DOB (MM/DD/YYYY): 04/08/2016', '2016-04-08'],
    ['Date of Birth | 04/08/2016', '2016-04-08'],
    ['DOB: 12/30/63', '1963-12-30'],
    ['Paul S 04/08/2016 (age 10)', '2016-04-08'],
  ])('recognises the birth-date form %j', async (line, iso) => {
    const r = await run(medicalDoc({ raw_text: `Clinic\n${line}\nThank you`, date: iso }));
    expect(r.parsed.date).toBeNull();
  });

  it('keeps a date that appears next to a DOB label AND elsewhere as the labelled document date', async () => {
    // A newborn visit: DOB and date of service are the same day.
    const r = await run(medicalDoc({
      raw_text: 'DOB: 03/15/2025\nDate of Service: 03/15/2025',
      date: '2025-03-15',
    }));
    expect(r.parsed.date).toBe('2025-03-15');
    expect(r.parsed.date_guard).toBeUndefined();
  });

  it('does not touch an ordinary receipt date (no birth label anywhere)', async () => {
    const r = await run(medicalDoc({
      raw_text: 'COSTCO\nDate: 01/15/2026\nTotal $142.33',
      date: '2026-01-15',
      is_medical: false,
    }));
    expect(r.parsed.date).toBe('2026-01-15');
    expect(r.structured.date).toBe('2026-01-15');
    expect(r.parsed.date_guard).toBeUndefined();
  });

  it('a lab "Age: 45" after a collection date is not a birth marker', async () => {
    const r = await run(medicalDoc({
      raw_text: 'Quest Diagnostics\nCollected 03/15/2025 Age: 45',
      date: '2025-03-15',
    }));
    expect(r.parsed.date).toBe('2025-03-15');
  });

  it('a DOB elsewhere on the page does not reject a different document date', async () => {
    const r = await run(medicalDoc({
      raw_text: 'DOB: 12/30/1963\nStatement Date: 02/11/2025',
      date: '2025-02-11',
    }));
    expect(r.parsed.date).toBe('2025-02-11');
  });

  it('ocrImage applies the same guard', async () => {
    mockCreate.mockResolvedValue(makeApiResponse(medicalDoc({
      raw_text: 'DOB: 12/30/1963\nvaccine record',
      date: '1963-12-30',
    })));
    const r = await ocrImage(Buffer.from('img'), 'scan.jpg', 'jpg');
    expect(r.parsed.date).toBeNull();
  });

  it('guardDocumentDates is exported and a no-op for null/garbage input', () => {
    expect(typeof guardDocumentDates).toBe('function');
    expect(() => guardDocumentDates(null, 'x')).not.toThrow();
    const p = { date: 'not-a-date' };
    guardDocumentDates(p, 'DOB: not-a-date');
    expect(p.date).toBe('not-a-date');
  });
});
