// tasks.db #2536 (2026-10-26, lane L-IS) — TEST-FIRST.
//
// Rule 12 / dev-rules §7: app models resolve through the one shared
// haiku/sonnet/opus alias map, never raw model ids scattered per call site.
// ocr.js hardcoded 'claude-haiku-4-5-20251001' at both SDK call sites
// (ocrImagePdf and ocrImage; Fable review 2026-10-26).
//
// The data authority is @hx/model-config (shared/harness/packages/model-config).
// This repo cannot depend on it (private TS workspace package in a separate
// repo), so the lib mirrors the three aliases in ONE module (models.js) and a
// drift test checks that mirror against model-config whenever a harness
// checkout is on disk (pc-server). CI has no harness checkout; there the
// drift test is skipped (CI === 'true' only; it FAILS elsewhere) and the other assertions still run.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    constructor() {
      this.messages = { create: mockCreate, stream: (...args) => ({ finalMessage: () => mockCreate(...args) }) };
    }
  }
  return { default: MockAnthropic };
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OCR_SRC = readFileSync(join(ROOT, 'ocr.js'), 'utf8');
const MODEL_CONFIG = process.env.MODEL_CONFIG_SRC
  || join(homedir(), 'developer/shared/harness/packages/model-config/src/index.ts');

const okResponse = () => ({
  content: [{ type: 'text', text: JSON.stringify({ raw_text: 'Receipt total $1.00', document_type: 'receipt', signals: [] }) }],
  usage: { input_tokens: 10, output_tokens: 10 },
});
const tracker = () => ({ isCapReached: () => false, record: () => 0 });

beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockResolvedValue(okResponse());
});

describe('#2536 ocr.js resolves its model through the alias map', () => {
  it('ocr.js contains no raw Claude model id literal', () => {
    expect(OCR_SRC).not.toMatch(/['"`]claude-[a-z0-9.-]+['"`]/);
  });

  it('models.js is the one mirror: haiku/sonnet/opus, and an unknown alias throws', async () => {
    const { MODEL_ALIASES, resolveModelAlias } = await import('../models.js');
    expect(Object.keys(MODEL_ALIASES).sort()).toEqual(['haiku', 'opus', 'sonnet']);
    expect(resolveModelAlias('haiku')).toBe(MODEL_ALIASES.haiku);
    expect(() => resolveModelAlias('claude-haiku-4-5-20251001')).toThrow(/unknown model alias/);
    expect(() => resolveModelAlias(undefined)).toThrow(/unknown model alias/);
  });

  it('OCR_MODEL is the haiku alias, resolved', async () => {
    const { OCR_MODEL, OCR_MODEL_ALIAS } = await import('../ocr.js');
    const { MODEL_ALIASES } = await import('../models.js');
    expect(OCR_MODEL_ALIAS).toBe('haiku');
    expect(OCR_MODEL).toBe(MODEL_ALIASES.haiku);
  });

  it('both SDK call sites (ocrImagePdf, ocrImage) send the resolved haiku model', async () => {
    const { ocrImagePdf, ocrImage } = await import('../ocr.js');
    const { MODEL_ALIASES } = await import('../models.js');
    await ocrImagePdf(Buffer.from('%PDF-1.4 tiny'), 'a.pdf', { costTracker: tracker() });
    await ocrImage(Buffer.from([0xff, 0xd8, 0xff]), 'a.jpg', '.jpg', { costTracker: tracker() });
    expect(mockCreate).toHaveBeenCalledTimes(2);
    for (const [req] of mockCreate.mock.calls) expect(req.model).toBe(MODEL_ALIASES.haiku);
  });

  // Fails loud off CI (#2572): skips ONLY when CI === 'true' (exact string compare, same as intake #2570).
  it.skipIf(process.env.CI === 'true')('mirror matches @hx/model-config ALIASES (drift check; fails off CI without a harness checkout)', async () => {
    expect(
      existsSync(MODEL_CONFIG),
      `model-config source not found at ${MODEL_CONFIG}. Skips only when CI==='true'; ` +
      'check out batmanspaz/harness at ~/developer/shared/harness or set MODEL_CONFIG_SRC.',
    ).toBe(true);
    const { ALIASES } = await import(/* @vite-ignore */ MODEL_CONFIG);
    const { MODEL_ALIASES } = await import('../models.js');
    for (const alias of ['haiku', 'sonnet', 'opus']) expect(MODEL_ALIASES[alias]).toBe(ALIASES[alias]);
    const { OCR_MODEL } = await import('../ocr.js');
    expect(OCR_MODEL).toBe(ALIASES.haiku);
  });
});
