// P0 RED — pure detector/masker contract (detectPii / maskText). Synthetic values only.
// Expected at the end of Phase 0: every test fails with E_NOT_IMPLEMENTED (Phase 1 makes them pass).
import { describe, it, expect } from 'vitest';
import { detectPii, maskText, sanitizeFilename } from '../../pii-redact.js';
import { textLeaks, normalizeForCheck } from './support/harness.mjs';

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

// ---------------------------------------------------------------------------------------------------------------
// ROUND 2 (red-team fold-in, 2026-10-14). IDs map to review-verdicts/{sonnet,opus}-redact-p0.md.
// ---------------------------------------------------------------------------------------------------------------

describe('[Sonnet C5, Opus H4] Unicode / obfuscated SSNs are found and masked (checked after NFKC + digit folding)', () => {
  const variants = [
    ['fullwidth digits', 'SSN \uff11\uff12\uff13-\uff14\uff15-\uff16\uff17\uff18\uff19'],
    ['fullwidth hyphen U+FF0D', 'SSN 123\uff0d45\uff0d6789'],
    ['small hyphen U+FE63', 'SSN 123\ufe6345\ufe636789'],
    ['Arabic-Indic digits', 'SSN \u0661\u0662\u0663-\u0664\u0665-\u0666\u0667\u0668\u0669'],
    ['Devanagari digits', 'SSN \u0967\u0968\u0969-\u096a\u096b-\u096c\u096d\u096e\u096f'],
    ['zero-width space', 'SSN 123\u200b-45-6789'],
    ['zero-width joiner', 'SSN 123-\u200d45-6789'],
    ['soft hyphens as separators', 'SSN 123\u00ad45\u00ad6789'],
    ['minus sign U+2212', 'SSN 123\u221245\u22126789'],
    ['hyphen U+2010', 'SSN 123\u201045\u20106789'],
    ['figure dash U+2012', 'SSN 123\u201245\u20126789'],
    ['middle dot (what base-14 fonts emit for an en dash)', 'SSN 123\u00b745\u00b76789'],
    ['letter-spaced', 'SSN 1 2 3 - 4 5 - 6 7 8 9'],
  ];
  for (const [name, input] of variants) {
    it(`masks ${name}; no full or partial SSN left; last 4 kept as ASCII`, () => {
      const r = maskText(input);
      expect(r.counts.ssn).toBe(1);
      expect(textLeaks(r.text, ['ssn1'])).toEqual([]);
      expect(normalizeForCheck(r.text)).toContain('XXX-XX-6789');
    });
  }

  it('never reveals MORE than the last 4: a labelled SSN embedded in a longer digit token is masked whole', () => {
    const r = maskText('SSN 1123-45-67890');
    expect(textLeaks(r.text, ['ssn1'])).toEqual([]);
    expect(r.counts.ssn).toBe(1);
  });

  it('an already-masked SSN next to an unmasked one: only the unmasked one counts and changes', () => {
    const r = maskText('SSN XXX-XX-6789 and 987-65-4320');
    expect(r.text).toBe('SSN XXX-XX-6789 and XXX-XX-4320');
    expect(r.counts.ssn).toBe(1);
  });
});

describe('[Opus M9, Sonnet M3/M4] EIN stays visible, prior-year AGI / e-file PINs are redacted (decided phrasings)', () => {
  for (const s of [
    'Adjusted gross income 64,210',
    'AGI 64,210',
    'Line 1 Adjusted gross income 64,210', // Form 8879 line 1 = THIS year's AGI: visible per decision (PENDING PAUL item 1)
    "PAYER'S TIN 98-7654321",
    'Employer identification number 98-7654321',
    'FEIN 98-7654321',
    "b Employer's ID number 98-7654321",
    'Prior year tax paid 78,901', // a different prior-year quantity: bounds false positives
  ]) {
    it(`leaves "${s}" untouched`, () => {
      expect(detectPii(s)).toEqual([]);
      expect(maskText(s).text).toBe(s);
    });
  }

  it('an EIN right after an SSN keeps its digits (label-window bleed must not mask it)', () => {
    const r = maskText('SSN 123-45-6789 EIN 98-7654321');
    expect(r.text).toBe('SSN XXX-XX-6789 EIN 98-7654321');
  });

  it("documented fail-toward-privacy: an UNSEPARATED 9-digit value after any TIN label is masked even when it is a payer's EIN", () => {
    const r = maskText("PAYER'S TIN 987654321");
    expect(r.text).not.toContain('987654321');
    expect(r.counts.ssn).toBe(1);
  });

  for (const s of [
    'Enter your prior-year AGI\n78,901',
    "Last year's AGI: 78,901",
    'Prior year AGI   $ 78 901',
    'Prior year AGI\t|\t78,901',
  ]) {
    it(`redacts prior-year AGI phrased as ${JSON.stringify(s)}`, () => {
      const r = maskText(s);
      expect(r.text).toMatch(/\[REDACTED-AGI\]/);
      expect(r.text.replace(/\D/g, '')).not.toContain('78901');
      expect(r.counts.pin).toBe(1);
    });
  }

  for (const s of ['Self-Select PIN 31415', 'Practitioner PIN 31415', 'Taxpayer PIN: 31415', 'IP PIN 314159', 'Identity Protection PIN 314159']) {
    it(`redacts the e-file signature PIN in ${JSON.stringify(s)}`, () => {
      const r = maskText(s);
      expect(r.text).toMatch(/\[REDACTED-PIN\]/);
      expect(r.text).not.toMatch(/31415/);
      expect(r.counts.pin).toBe(1);
    });
  }
});

describe('[Sonnet M5] labels in other layouts, and the label window', () => {
  for (const [s, kind] of [
    ['Routing number\n021000021', 'routing'],
    ['ROUTING NUMBER: 021000021', 'routing'],
    ['Acct. No. 55501928', 'bank_account'],
    ['Account #: 55501928', 'bank_account'],
    ['A/C 55501928', 'bank_account'],
    ['Date of Birth\n01/02/1980', 'dob'],
  ]) {
    it(`finds ${kind} in ${JSON.stringify(s)}`, () => {
      expect(detectPii(s).map((f) => f.kind)).toEqual([kind]);
    });
  }
  it('a value far outside the default label window (200 chars away) is NOT redacted', () => {
    expect(detectPii(`Routing number: see the attached letter.${' '.repeat(10)}${'filler '.repeat(28)} 021000021`)).toEqual([]);
  });
  it('labelWindow option bounds the search (just outside: no; just inside: yes)', () => {
    const text = `Account number: ${'.'.repeat(30)} 55501928`;
    expect(detectPii(text, { labelWindow: 20 })).toEqual([]);
    expect(detectPii(text, { labelWindow: 60 }).map((f) => f.kind)).toEqual(['bank_account']);
  });
});

describe('[Sonnet C2, Opus D14/H11] sanitizeFilename (names are content: subject, manifest, archive, vault, logs)', () => {
  it('masks an SSN in a file name and keeps the extension', () => {
    expect(sanitizeFilename('W2 123-45-6789.pdf')).toBe('W2 XXX-XX-6789.pdf');
  });
  it('masks an unseparated labelled SSN', () => {
    const out = sanitizeFilename('SSN123456789.txt');
    expect(textLeaks(out, ['ssn1'])).toEqual([]);
    expect(out.endsWith('.txt')).toBe(true);
  });
  it('masks Unicode-digit SSNs in names', () => {
    expect(textLeaks(sanitizeFilename('SSN \uff11\uff12\uff13-\uff14\uff15-\uff16\uff17\uff18\uff19.pdf'), ['ssn1'])).toEqual([]);
  });
  it('neutralises path traversal and control characters', () => {
    for (const n of ['../../etc/passwd', '..\\..\\x.pdf', 'a/b/c.pdf', 'a\u0000b\nc.pdf']) {
      const out = sanitizeFilename(n);
      expect(out, n).not.toMatch(/[\/\\\u0000-\u001f]|(^|[^.])\.\.([^.]|$)/);
      expect(out.length, n).toBeGreaterThan(0);
    }
  });
  it('leaves ordinary names alone (names/years are not redacted per decision)', () => {
    for (const n of ['Jane Q Tester 2025 Return.pdf', 'Form 1040 2025.pdf', 'invoice-246813579.pdf']) expect(sanitizeFilename(n)).toBe(n);
  });
});
