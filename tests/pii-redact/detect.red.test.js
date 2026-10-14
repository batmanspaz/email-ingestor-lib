// P0 RED — pure detector/masker contract (detectPii / maskText). Synthetic values only.
// Expected at the end of Phase 0: every test fails with E_NOT_IMPLEMENTED (Phase 1 makes them pass).
import { describe, it, expect } from 'vitest';
import { detectPii, maskText } from '../../pii-redact.js';

const kinds = (text) => detectPii(text).map((f) => f.kind);

describe('SSN / ITIN (keep last 4)', () => {
  const ssnCases = [
    ['dashed', 'SSN: 123-45-6789', 'SSN: XXX-XX-6789'],
    ['spaced', 'SSN 123 45 6789', 'SSN XXX-XX-6789'],
    ['en dash', 'SSN 123–45–6789', 'SSN XXX-XX-6789'],
    ['em dash', 'SSN 123—45—6789', 'SSN XXX-XX-6789'],
    ['non-breaking hyphen', 'SSN 123‑45‑6789', 'SSN XXX-XX-6789'],
    ['NBSP separators', 'SSN 123 45 6789', 'SSN XXX-XX-6789'],
    ['wrapped across a line break', 'SSN 123-45-\n6789 end', 'SSN XXX-XX-6789 end'],
    ['no label needed when formatted', 'taxpayer 123-45-6789 filed', 'taxpayer XXX-XX-6789 filed'],
    ['unseparated with SSN label', 'SSN: 234567890', 'SSN: XXX-XX-7890'],
    ['unseparated with long label', 'Social Security Number: 234567890', 'Social Security Number: XXX-XX-7890'],
    ['unseparated with SSN/ITIN label', 'SSN/ITIN 234567890', 'SSN/ITIN XXX-XX-7890'],
    ['unseparated with TIN label', 'TIN: 234567890', 'TIN: XXX-XX-7890'],
  ];
  for (const [name, input, want] of ssnCases) {
    it(`masks ${name}`, () => {
      const r = maskText(input);
      expect(r.text).toBe(want);
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0].kind).toBe('ssn');
      expect(r.counts.ssn).toBe(1);
    });
  }

  it('classifies a 9xx-7x/8x ITIN as itin and keeps the last 4', () => {
    const r = maskText('Dependent ITIN 912-78-1234');
    expect(r.text).toBe('Dependent ITIN XXX-XX-1234');
    expect(r.findings[0].kind).toBe('itin');
    expect(r.counts.ssn).toBe(1); // itin rolls up into ssn
  });

  it('masks every SSN in a string and counts them', () => {
    const r = maskText('A 123-45-6789 and B 987-65-4320');
    expect(r.text).toBe('A XXX-XX-6789 and B XXX-XX-4320');
    expect(r.counts.ssn).toBe(2);
  });

  it('leaves already-masked forms alone', () => {
    for (const s of ['SSN XXX-XX-6789', 'SSN ***-**-6789', 'SSN xxx-xx-6789', 'SSN ending in 6789']) {
      expect(detectPii(s), s).toEqual([]);
      expect(maskText(s).text).toBe(s);
    }
  });

  it('is idempotent', () => {
    const once = maskText('SSN 123-45-6789 / DOB: 01/02/1980 / Routing number: 021000021').text;
    expect(maskText(once).findings).toEqual([]);
    expect(maskText(once).text).toBe(once);
  });

  it('never returns the matched digits in a finding (positions + mask only)', () => {
    const f = detectPii('SSN 123-45-6789')[0];
    expect(JSON.stringify(f)).not.toContain('123');
    expect(JSON.stringify(f)).not.toContain('45-67');
    expect(f.start).toBe(4);
    expect(f.end).toBe(15);
  });
});

describe('bank account / routing (label-anchored)', () => {
  it('redacts a routing number that passes the ABA checksum', () => {
    const r = maskText('Routing number: 021000021');
    expect(r.text).toBe('Routing number: [REDACTED-ROUTING]');
    expect(r.findings[0].kind).toBe('routing');
    expect(r.counts.bank).toBe(1);
  });
  it('still redacts a labeled 9-digit routing that FAILS the checksum (fail toward privacy) as a bank_account', () => {
    const r = maskText('RTN 123456780');
    expect(r.findings[0].kind).toBe('bank_account');
    expect(r.text).not.toContain('123456780');
  });
  for (const [input, token] of [
    ['Account number: 555019283746', 'Account number: [REDACTED-BANK]'],
    ['Acct # 55501928', 'Acct # [REDACTED-BANK]'],
    ['DAN 555019283746', 'DAN [REDACTED-BANK]'],
  ]) {
    it(`redacts ${input}`, () => {
      const r = maskText(input);
      expect(r.text).toBe(token);
      expect(r.counts.bank).toBe(1);
    });
  }
  it('does NOT redact last-4 phrases or a valid-checksum number with no label', () => {
    for (const s of ['Account ending in 9012', 'Account number: ****9012', 'ref 021000021 shipped', 'Routing: see page 3']) {
      expect(detectPii(s), s).toEqual([]);
    }
  });
});

describe('date of birth (label-anchored)', () => {
  for (const s of ['Date of birth: 01/02/1980', 'DOB 1980-01-02', 'DOB: 1/2/80', 'Born: January 2, 1980']) {
    it(`redacts ${s}`, () => {
      const r = maskText(s);
      expect(r.text).toMatch(/\[REDACTED-DOB\]/);
      expect(r.text).not.toMatch(/1980|\/80/);
      expect(r.counts.dob).toBe(1);
    });
  }
  it('does NOT redact unlabeled dates or filing dates', () => {
    for (const s of ['Date: 01/02/1980', 'Filing date 04/15/2026', 'Signed 2026-10-15']) expect(detectPii(s), s).toEqual([]);
  });
});

describe('e-file PIN and prior-year AGI (label-anchored)', () => {
  it('redacts the self-select PIN', () => {
    const r = maskText('Self-select PIN: 31415');
    expect(r.text).toBe('Self-select PIN: [REDACTED-PIN]');
    expect(r.counts.pin).toBe(1);
  });
  for (const s of ['Prior year AGI: $78,901', 'PY AGI 78901', 'Last year adjusted gross income 78,901']) {
    it(`redacts ${s}`, () => {
      const r = maskText(s);
      expect(r.text).toMatch(/\[REDACTED-AGI\]/);
      expect(r.text).not.toMatch(/78,?901/);
      expect(r.counts.pin).toBe(1);
    });
  }
  it("does NOT redact the current-year AGI printed on the return itself (so returns stay readable)", () => {
    expect(detectPii('Adjusted gross income (line 11) 64,210')).toEqual([]);
  });
});

describe("driver's license / state ID (label-anchored)", () => {
  for (const s of ['Driver license no: D1234567', 'DL# D1234567', 'State ID number 12345678']) {
    it(`redacts ${s}`, () => {
      const r = maskText(s);
      expect(r.text).toMatch(/\[REDACTED-ID\]/);
      expect(r.text).not.toMatch(/D1234567|12345678/);
      expect(r.counts.id).toBe(1);
    });
  }
  it('does NOT redact generic IDs', () => {
    for (const s of ['License plate 7ABC123', 'ID: 12345', 'Order ID 998877']) expect(detectPii(s), s).toEqual([]);
  });
});

describe('negative controls (must be left exactly as-is)', () => {
  const negatives = [
    'Invoice number 246813579 is not an SSN',
    'Order #246813579 shipped',
    'Phone (415) 555-0134',
    'Call 415-555-0134 today',
    'EIN 98-7654321',
    'Total tax $2,468,013.57',
    'Filing date 04/15/2026',
    'Zip 94105-1234',
    'Tracking 1Z999AA10123456784',
    'PO 123-45-678',
    'Page 123 of 456',
    'Date 2026-10-15',
  ];
  for (const s of negatives) {
    it(`leaves "${s}" untouched`, () => {
      expect(detectPii(s)).toEqual([]);
      expect(maskText(s).text).toBe(s);
    });
  }
});

describe('counts shape', () => {
  it('rolls up into {ssn, bank, dob, pin, id}', () => {
    const r = maskText('SSN 123-45-6789 Routing number: 021000021 Account number: 555019283746 DOB 01/02/1980 PIN: 31415 DL# D1234567');
    expect(r.counts).toEqual({ ssn: 1, bank: 2, dob: 1, pin: 1, id: 1 });
  });
  it('detectPii kinds are drawn from the declared set', () => {
    expect(kinds('SSN 123-45-6789 DOB 01/02/1980')).toEqual(['ssn', 'dob']);
  });
});
