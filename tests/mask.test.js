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

  it('returns a string with no "@" unchanged (nothing to mask)', () => {
    expect(maskEmail('not-an-email')).toBe('not-an-email');
  });

  it('returns a string starting with "@" unchanged (no local part to redact)', () => {
    // atIdx === 0 fails the `atIdx < 1` guard the same way "no @" does.
    // Documents current behavior: there is no local-part character to keep,
    // so the whole (already address-less) string passes through.
    expect(maskEmail('@nodomain.com')).toBe('@nodomain.com');
  });

  it('idempotency: masking an already-masked address twice is a no-op', () => {
    const once = maskEmail('paul.steinberg@gmail.com');
    const twice = maskEmail(once);
    expect(twice).toBe(once);
    expect(twice).toBe('p***@gmail.com');
  });

  it('handles a local part containing a second "@" by splitting on the first one', () => {
    // Documents current (first-@-wins) behavior rather than asserting an
    // "ideal" parse — this input isn't a valid single address to begin with.
    expect(maskEmail('a@b@c.com')).toBe('a***@b@c.com');
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
