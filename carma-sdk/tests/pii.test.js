import { describe, test, expect } from 'vitest';
import { maskEmail, maskName, maskPhone, scrubText } from '../pii.js';

describe('maskEmail', () => {
  test('keeps first char + domain', () => {
    expect(maskEmail('paul@gocarma.com')).toBe('p***@gocarma.com');
  });

  test('handles malformed inputs safely', () => {
    expect(maskEmail('no-at-sign')).toBe('[EMAIL]');
    expect(maskEmail('')).toBe('[EMAIL]');
    expect(maskEmail(null)).toBe('[EMAIL]');
    expect(maskEmail(undefined)).toBe('[EMAIL]');
  });
});

describe('maskName / maskPhone', () => {
  test('always [NAME] / [PHONE] for valid inputs', () => {
    expect(maskName('Paul Steinberg')).toBe('[NAME]');
    expect(maskPhone('415-555-1212')).toBe('[PHONE]');
  });

  test('handles missing inputs', () => {
    expect(maskName('')).toBe('[NAME]');
    expect(maskPhone(null)).toBe('[PHONE]');
  });
});

describe('scrubText', () => {
  test('masks emails in free text', () => {
    expect(scrubText('contact paul@gocarma.com or lawrence@gocarma.com')).toBe(
      'contact p***@gocarma.com or l***@gocarma.com'
    );
  });

  test('masks phone numbers', () => {
    expect(scrubText('call 415-555-1212 or (415) 555-1212')).toBe('call [PHONE] or [PHONE]');
  });

  test('masks SSNs', () => {
    expect(scrubText('SSN 123-45-6789')).toBe('SSN [SSN]');
  });

  test('passes through null/undefined unchanged', () => {
    expect(scrubText(null)).toBe(null);
    expect(scrubText(undefined)).toBe(undefined);
  });
});
