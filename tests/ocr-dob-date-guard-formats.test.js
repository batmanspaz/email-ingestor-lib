// tasks.db #1407 follow-up: guardDocumentDates (the live LLM-OCR producer's
// DOB backstop) only recognised a birth date it could scan in M/D/Y, ISO or
// "Mon D, YYYY" form. A medical document that prints the DOB in a format the
// scanner does not read (dotted "12.30.1963", day-first "30/12/1963",
// ordinal "December 30th, 1963", "30-Dec-1963") failed OPEN: the model's
// DOB-as-document-date was kept. The Python enricher guard
// (~/claude/shared/lib/receipt_enricher.py guard_document_date, review rounds
// 2026-10-07/-11) already covers these with wider scanners plus a
// format-independent backstop: a pre-2010 date that is never document-labelled,
// in a text that contains a birth word, is refused. This brings the JS guard
// to parity. Fixtures are synthetic; no real patient data.

import { describe, it, expect } from 'vitest';
import { guardDocumentDates } from '../ocr.js';

function guard(rawText, fields) {
  return guardDocumentDates({ ...fields }, rawText);
}

// A representative pharmacy immunization-history page.
const IMMUNIZATION = (dobLine, extra = '') => [
  'PHARMACY #0000',
  'IMMUNIZATION HISTORY',
  'Patient: TEST PATIENT',
  dobLine,
  'Vaccine            Lot      Admin',
  'Influenza          AB123    Pharmacist',
  extra,
].join('\n');

describe('guardDocumentDates — DOB formats the scanner used to miss (#1407)', () => {
  it('dotted DOB "12.30.1963" is rejected', () => {
    const p = guard(IMMUNIZATION('DOB: 12.30.1963'), { date: '1963-12-30' });
    expect(p.date).toBeNull();
    expect(p.date_guard).toEqual({ reason: 'date_of_birth', rejected_fields: ['date'], replaced_with: null });
  });

  it('day-first DOB "30/12/1963" is rejected (backstop: pre-2010, birth word, never document-labelled)', () => {
    const p = guard(IMMUNIZATION('Date of Birth: 30/12/1963'), { date: '1963-12-30' });
    expect(p.date).toBeNull();
    expect(p.date_guard.rejected_fields).toEqual(['date']);
  });

  it('day-first DOB with a labelled service date falls back to the service date', () => {
    const p = guard(
      IMMUNIZATION('Date of Birth: 30/12/1963', 'Date of Service: 03/15/2025'),
      { date: '1963-12-30' },
    );
    expect(p.date).toBe('2025-03-15');
    expect(p.date_guard.replaced_with).toBe('labelled_document_date');
  });

  it('ordinal DOB "Born on December 30th, 1963" is rejected', () => {
    const p = guard(IMMUNIZATION('Born on December 30th, 1963'), { date: '1963-12-30' });
    expect(p.date).toBeNull();
  });

  it('"DOB: 30-Dec-1963" is rejected', () => {
    const p = guard(IMMUNIZATION('DOB: 30-Dec-1963'), { date: '1963-12-30' });
    expect(p.date).toBeNull();
  });

  it('compact "DOB: 19631230" is rejected by the backstop', () => {
    const p = guard(IMMUNIZATION('DOB: 19631230'), { date: '1963-12-30' });
    expect(p.date).toBeNull();
  });

  it('a service_date that is an unreadable-format DOB is dropped too', () => {
    const p = guard(IMMUNIZATION('D.O.B. 30.12.1963'), { date: null, service_date: '1963-12-30' });
    expect(p.service_date).toBeNull();
    expect(p.date_guard.rejected_fields).toEqual(['service_date']);
  });

  it('dotted DOB and dotted labelled service date: DOB replaced by the service date', () => {
    const p = guard(
      IMMUNIZATION('DOB: 12.30.1963', 'Date of Service: 03.15.2025'),
      { date: '1963-12-30' },
    );
    expect(p.date).toBe('2025-03-15');
  });

  it('the rejected value is never recorded in date_guard (PII)', () => {
    const p = guard(IMMUNIZATION('Date of Birth: 30/12/1963'), { date: '1963-12-30' });
    expect(JSON.stringify(p.date_guard)).not.toMatch(/1963/);
  });
});

describe('guardDocumentDates — the backstop does not over-reject', () => {
  it('a pre-2010 date in a text with no birth word is kept (old estate/legal documents)', () => {
    const p = guard('LAST WILL AND TESTAMENT\nExecuted this 12th day of June\nRecorded 06/12/2002', { date: '2002-06-12' });
    expect(p.date).toBe('2002-06-12');
    expect(p.date_guard).toBeUndefined();
  });

  it('a pre-2010 date that is document-labelled is kept even with a DOB on the page', () => {
    const p = guard('DOB: 30/12/1963\nStatement Date: 06/01/2009', { date: '2009-06-01' });
    expect(p.date).toBe('2009-06-01');
    expect(p.date_guard).toBeUndefined();
  });

  it('a plausible (2010+) unlabelled date with a birth word on the page is kept', () => {
    const p = guard('Date of Birth: 30/12/1963\nAdministered 03/15/2025', { date: '2025-03-15' });
    expect(p.date).toBe('2025-03-15');
    expect(p.date_guard).toBeUndefined();
  });

  it('dotted ordinary receipt date with no birth label is untouched', () => {
    const p = guard('Receipt\nTotal 12.50\nDate 03.15.2025', { date: '2025-03-15' });
    expect(p.date).toBe('2025-03-15');
    expect(p.date_guard).toBeUndefined();
  });
});
