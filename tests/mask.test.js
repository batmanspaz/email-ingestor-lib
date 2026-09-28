/**
 * Unit tests for mask.js — PII masking helpers for log sinks (SOC 2).
 *
 * mask.js was the only module in this library without a test file
 * (tasks.db #1327) despite being the one module specifically responsible for
 * keeping PII (email addresses, sender identities, free-text subjects/
 * snippets) out of persistent logs and telemetry. Coverage here is
 * deliberately heavier than a typical utility module: every exported
 * function gets positive cases, boundary/type cases, idempotency (masking
 * already-masked output must not produce garbage or re-leak), embedding
 * inside larger strings, and both false-positive (masking something that
 * isn't really PII — safe direction) and false-negative (missing real PII —
 * the direction that matters) risks.
 *
 * NOTE ON SCOPE: mask.js only implements email-specific masking
 * (maskEmail/maskFrom) plus a generic free-text redactor (redact). It does
 * NOT pattern-match phone numbers, SSNs, or account numbers — those are
 * expected to flow through redact(), which opaquely replaces ANY string
 * with a length marker regardless of content. Tests below confirm that
 * property explicitly (see "redact() as the catch-all for non-email PII").
 */

import { describe, it, expect } from 'vitest';
import { maskEmail, maskFrom, redact } from '../mask.js';

describe('maskEmail', () => {
  it('masks a normal address to first-char + ***@domain', () => {
    expect(maskEmail('paul.steinberg@gmail.com')).toBe('p***@gmail.com');
  });

  it('preserves the domain exactly, including subdomains', () => {
    expect(maskEmail('bob@mail.example.co.uk')).toBe('b***@mail.example.co.uk');
  });

  it('masks a single-character local part', () => {
    expect(maskEmail('a@b.com')).toBe('a***@b.com');
  });

  it('does not alter case', () => {
    expect(maskEmail('PAUL@GMAIL.COM')).toBe('P***@GMAIL.COM');
  });

  it('masks a plus-tagged address (local part fully replaced regardless of content)', () => {
    expect(maskEmail('paul+billing@gmail.com')).toBe('p***@gmail.com');
  });

  // --- null / undefined / non-string passthrough ---

  it('returns undefined unchanged', () => {
    expect(maskEmail(undefined)).toBeUndefined();
  });

  it('returns null unchanged', () => {
    expect(maskEmail(null)).toBeNull();
  });

  it('returns empty string unchanged (falsy short-circuit)', () => {
    expect(maskEmail('')).toBe('');
  });

  it('returns a non-string value (number) unchanged', () => {
    expect(maskEmail(12345)).toBe(12345);
  });

  it('returns a non-string value (object) unchanged', () => {
    const obj = { email: 'paul@gmail.com' };
    expect(maskEmail(obj)).toBe(obj);
  });

  it('returns a non-string value (array) unchanged', () => {
    const arr = ['paul@gmail.com'];
    expect(maskEmail(arr)).toBe(arr);
  });

  it('returns false unchanged (falsy short-circuit)', () => {
    expect(maskEmail(false)).toBe(false);
  });

  // --- edge cases specific to a PII masker ---

  it('redacts a string with no "@" (fail closed: not one clean address, tasks.db #1345)', () => {
    expect(maskEmail('not-an-email')).toBe('[redacted]');
  });

  it('redacts a string starting with "@" (no local part; not one clean address)', () => {
    expect(maskEmail('@nodomain.com')).toBe('[redacted]');
  });

  it('idempotency: masking an already-masked address twice is a no-op', () => {
    const once = maskEmail('paul.steinberg@gmail.com');
    const twice = maskEmail(once);
    expect(twice).toBe(once);
    expect(twice).toBe('p***@gmail.com');
  });

  it('redacts a malformed address with a second "@" instead of leaking the tail (tasks.db #1345)', () => {
    expect(maskEmail('a@b@c.com')).toBe('[redacted]');
  });

  // --- tasks.db #1345: maskEmail must fail closed on anything but ONE clean address ---

  describe('fail-closed on anything other than a single clean address', () => {
    it('redacts a comma-separated list (previously leaked every address after the first)', () => {
      const out = maskEmail('a@b.com, c@d.com');
      expect(out).toBe('[redacted]');
      expect(out).not.toContain('c@d.com');
    });

    it('redacts a display name on its own', () => {
      expect(maskEmail('Paul Steinberg')).toBe('[redacted]');
    });

    it('redacts a display-name-wrapped address (name is PII too)', () => {
      const out = maskEmail('"Paul Steinberg" <paul.steinberg@gmail.com>');
      expect(out).toBe('[redacted]');
      expect(out).not.toContain('Steinberg');
    });

    it('redacts leading/trailing whitespace around an address (input must be exactly one address)', () => {
      expect(maskEmail(' paul@gmail.com')).toBe('[redacted]');
      expect(maskEmail('paul@gmail.com ')).toBe('[redacted]');
    });

    it('redacts an address followed by a newline and a second address', () => {
      expect(maskEmail('a@b.com\nc@d.com')).toBe('[redacted]');
    });

    it('redacts a domain with no TLD, consistent with maskFrom', () => {
      expect(maskEmail('user@localhost')).toBe('[redacted]');
    });

    it('still passes an already-masked address through unchanged (idempotent)', () => {
      expect(maskEmail('p***@gmail.com')).toBe('p***@gmail.com');
    });

    it('redacts a masked prefix followed by a real address (no anchor bypass)', () => {
      const out = maskEmail('p***@gmail.com, real.person@example.com');
      expect(out).toBe('[redacted]');
      expect(out).not.toContain('real.person');
    });
  });

  describe('input length cap (boundary)', () => {
    // 1000 chars total: 'a'*N + '@example.com' (12 chars)
    const atLen = (n) => 'a'.repeat(n - 12) + '@example.com';

    it('an otherwise-valid address of exactly 1000 chars is still masked', () => {
      const input = atLen(1000);
      expect(input.length).toBe(1000);
      expect(maskEmail(input)).toBe('a***@example.com');
    });

    it('the same shape at 1001 chars is redacted (pins > vs >=, and the maskEmail cap itself)', () => {
      const input = atLen(1001);
      expect(input.length).toBe(1001);
      expect(maskEmail(input)).toBe('[redacted]');
    });

    it('60k chars returns redacted', () => {
      expect(maskEmail('a'.repeat(60_000))).toBe('[redacted]');
    });
  });

  it('already-masked short-circuit only accepts a first char maskEmail could produce (no control chars)', () => {
    expect(maskEmail('\u0000***@gmail.com')).toBe('[redacted]');
    expect(maskEmail('\t***@gmail.com')).toBe('[redacted]');
    expect(maskEmail('xx p***@gmail.com')).toBe('[redacted]');
  });
});

describe('maskFrom', () => {
  it('drops the display name and masks the embedded address', () => {
    expect(maskFrom('"Paul Steinberg" <paul.steinberg@gmail.com>')).toBe('p***@gmail.com');
  });

  it('masks a bare address with no display name', () => {
    expect(maskFrom('paul@gmail.com')).toBe('p***@gmail.com');
  });

  it('redacts entirely when no parseable address is present', () => {
    expect(maskFrom('Paul Steinberg')).toBe('[redacted]');
  });

  it('redacts entirely for a domain with no TLD (e.g. localhost) — safe over-redaction, not a leak', () => {
    expect(maskFrom('user@localhost')).toBe('[redacted]');
  });

  it('never returns the raw display name or raw local part', () => {
    const raw = maskFrom('"Paul Steinberg" <paul.steinberg@gmail.com>');
    expect(raw).not.toContain('Paul Steinberg');
    expect(raw).not.toContain('paul.steinberg');
  });

  it('with two embedded addresses, masks only the first and drops the rest (no leak of the second)', () => {
    const out = maskFrom('a@b.com, c@d.com');
    expect(out).toBe('a***@b.com');
    expect(out).not.toContain('c@d.com');
    expect(out).not.toContain('d.com');
  });

  // --- ALREADY_MASKED_RE anchor regression (tasks.db #1345) ---
  //
  // The idempotency short-circuit must stay anchored (^...$). If a future edit
  // loosens it, a real trailing address could ride through behind a masked
  // prefix while the rest of the suite stays green. These pin the anchor.
  describe('already-masked short-circuit stays anchored', () => {
    it('masked prefix + trailing REAL address: the real one is masked, never passed through', () => {
      const out = maskFrom('p***@gmail.com, real.person@example.com');
      expect(out).not.toContain('real.person');
      expect(out).toBe('r***@example.com');
    });

    it('masked address followed by junk and a real address does not short-circuit', () => {
      const out = maskFrom('p***@gmail.com real.person@example.com');
      expect(out).not.toContain('real.person');
    });

    it('display-name-wrapped masked form is NOT treated as already-masked (name is dropped)', () => {
      const out = maskFrom('"Paul Steinberg" <p***@gmail.com>');
      expect(out).toBe('[redacted]');
      expect(out).not.toContain('Steinberg');
    });

    it('leading whitespace before a masked address is not treated as already-masked', () => {
      expect(maskFrom(' p***@gmail.com')).toBe('[redacted]');
    });

    it('trailing whitespace after a masked address is not treated as already-masked', () => {
      expect(maskFrom('p***@gmail.com ')).toBe('[redacted]');
    });

    it('a masked address with a real address on the next line does not short-circuit', () => {
      const out = maskFrom('p***@gmail.com\nreal.person@example.com');
      expect(out).not.toContain('real.person');
    });

    it('a clean masked address still short-circuits unchanged', () => {
      expect(maskFrom('p***@gmail.com')).toBe('p***@gmail.com');
    });

    it('a control character in the masked first-char slot is not passed through', () => {
      expect(maskFrom('\t***@x.com')).toBe('[redacted]');
      expect(maskFrom('\u0000***@x.com')).toBe('[redacted]');
    });
  });

  // --- input-length cap (tasks.db #1345): EMAIL_RE is quadratic on long crafted input ---

  describe('input length cap', () => {
    it('60k chars of crafted input returns fast and fully redacted', () => {
      const t = Date.now();
      const out = maskFrom('a'.repeat(60_000));
      expect(out).toBe('[redacted]');
      expect(Date.now() - t).toBeLessThan(250);
    });

    it('60k chars ending in a real address does not leak it', () => {
      const out = maskFrom('a.'.repeat(30_000) + ' real.person@example.com');
      expect(out).toBe('[redacted]');
    });

    it('boundary: a 1000-char From header is masked; 1001 is redacted', () => {
      const pad = (n) => 'x'.repeat(n - ' <paul@gmail.com>'.length) + ' <paul@gmail.com>';
      expect(pad(1000).length).toBe(1000);
      expect(maskFrom(pad(1000))).toBe('p***@gmail.com');
      expect(maskFrom(pad(1001))).toBe('[redacted]');
    });

    it('an ordinary long-ish From header (well under the cap) is still masked normally', () => {
      const name = 'N'.repeat(200);
      expect(maskFrom(`"${name}" <paul@gmail.com>`)).toBe('p***@gmail.com');
    });
  });

  // --- null / undefined / non-string passthrough ---

  it('returns undefined unchanged', () => {
    expect(maskFrom(undefined)).toBeUndefined();
  });

  it('returns null unchanged', () => {
    expect(maskFrom(null)).toBeNull();
  });

  it('returns empty string unchanged (falsy short-circuit)', () => {
    expect(maskFrom('')).toBe('');
  });

  it('returns a non-string value unchanged', () => {
    const obj = { from: 'paul@gmail.com' };
    expect(maskFrom(obj)).toBe(obj);
  });

  // --- idempotency (this caught a real bug — see mask.js fix + report) ---

  it('idempotency: masking an already-masked From value twice is a no-op', () => {
    const once = maskFrom('"Paul Steinberg" <paul.steinberg@gmail.com>');
    expect(once).toBe('p***@gmail.com');

    const twice = maskFrom(once);
    expect(twice).toBe(once);
    expect(twice).toBe('p***@gmail.com');
  });

  it('idempotency holds for repeated re-masking (3rd pass stable too)', () => {
    const once = maskFrom('paul@gmail.com');
    const twice = maskFrom(once);
    const thrice = maskFrom(twice);
    expect(thrice).toBe(once);
  });
});

describe('redact', () => {
  it('replaces a subject line with a non-identifying length marker', () => {
    expect(redact('Wire transfer confirmation 88231')).toBe('[redacted:32]');
  });

  it('returns empty string for empty input (not "[redacted:0]")', () => {
    expect(redact('')).toBe('');
  });

  it('returns null unchanged', () => {
    expect(redact(null)).toBeNull();
  });

  it('returns undefined unchanged', () => {
    expect(redact(undefined)).toBeUndefined();
  });

  it('returns a non-string value (number) unchanged', () => {
    expect(redact(12345)).toBe(12345);
  });

  it('returns a non-string value (object) unchanged', () => {
    const obj = { snippet: 'hi' };
    expect(redact(obj)).toBe(obj);
  });

  it('never contains the raw source text, regardless of content', () => {
    const raw = 'Your routing number is 021000021 and the balance is $5,000';
    const out = redact(raw);
    expect(out).not.toContain('021000021');
    expect(out).not.toContain('5,000');
    expect(out).toBe(`[redacted:${raw.length}]`);
  });

  describe('redact() as the catch-all for non-email PII (SSN / phone / account numbers)', () => {
    // mask.js has no SSN/phone/account-number regex at all — these categories
    // are protected by fully opaque redaction (length marker only), never by
    // pattern-matching, so there is no regex to miss and no format to leak.
    it('opaquely redacts a string containing an SSN-shaped pattern', () => {
      const out = redact('SSN on file: 123-45-6789');
      expect(out).not.toContain('123-45-6789');
      expect(out).not.toMatch(/\d{3}-\d{2}-\d{4}/);
    });

    it('opaquely redacts a string containing a phone number in any format', () => {
      for (const phone of ['(555) 123-4567', '555-123-4567', '+1 555 123 4567', '5551234567']) {
        const out = redact(`Call me at ${phone}`);
        expect(out).not.toContain(phone);
        expect(out).toMatch(/^\[redacted:\d+\]$/);
      }
    });

    it('opaquely redacts a string containing an account/routing number', () => {
      const out = redact('Account 000123456789, routing 021000021');
      expect(out).not.toContain('000123456789');
      expect(out).not.toContain('021000021');
    });
  });

  it('is a pure function of length: two different strings of equal length produce identical output', () => {
    // This is expected/by-design (the marker intentionally carries no
    // content), not a bug — documented so a future change notices the
    // property shifts.
    expect(redact('abcde')).toBe(redact('12345'));
  });

  it('re-redacting its own output changes the marker (length of the marker itself), but stabilizes after one more pass', () => {
    // redact() has no "already redacted" detection (unlike the maskFrom fix
    // above) — documented as a known, non-security quirk: the marker string
    // itself has a fixed length once formed, so from the 2nd re-application
    // onward the output no longer changes. No PII is ever at risk here since
    // the function only ever emits a length integer, never content.
    const once = redact('Wire transfer confirmation 88231'); // '[redacted:32]' (13 chars)
    const twice = redact(once);                              // length of a 13-char string
    const thrice = redact(twice);
    expect(twice).toBe('[redacted:13]');
    expect(thrice).toBe(twice);
  });
});
