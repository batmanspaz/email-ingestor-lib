// GREEN (R2): declared contract constants of pii-redact.js. These are interface data, not behaviour — behaviour is
// RED in the *.red.test.js suites.
import { describe, it, expect } from 'vitest';
import { LIMITS, SANITIZABLE_EXTENSIONS, HELD_REASONS } from '../../pii-redact.js';

// Mirrors personal/email-ingestor document-drop-producer.js IMAGE_EXT_RE + TEXT_EXT_RE + '.md' + '.pdf' +
// lib/office-extract.js OFFICE_READERS + container-extract.js CONTAINER_EXT_RE (2026-10-14). [Opus D4/D5/C8]
const PRODUCER_EXTRACTS = ['.pdf', '.jpg', '.jpeg', '.png', '.tiff', '.heic', '.txt', '.csv', '.log', '.json', '.xml', '.html', '.md',
  '.docx', '.doc', '.rtf', '.xls', '.xlsx', '.zip', '.pages', '.numbers', '.key'];

describe('pii-redact contract constants', () => {
  it('[Opus D4/C8] every extractable type is sanitizable except legacy .doc/.xls, which are always held:unsupported', () => {
    expect(PRODUCER_EXTRACTS.filter((e) => !SANITIZABLE_EXTENSIONS.includes(e)).sort()).toEqual(['.doc', '.xls']);
    expect(HELD_REASONS).toContain('unsupported');
  });
  it('[Sonnet M9] declared default limits are finite and sane; too_large is a held reason', () => {
    expect(LIMITS.maxPages).toBeGreaterThan(50);
    expect(LIMITS.maxZipRatio).toBeGreaterThan(1);
    expect(LIMITS.engineTimeoutMs).toBeLessThanOrEqual(10 * 60_000);
    expect(HELD_REASONS).toContain('too_large');
  });
});
