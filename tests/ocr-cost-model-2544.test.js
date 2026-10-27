// tasks.db #2544 (2026-10-27, lane L-LB) — TEST-FIRST.
//
// Opus review of lib #86: both OCR call sites called costTracker.record(usage)
// without the model, so a consumer's cost tracker could only price OCR at one
// hardcoded rate. When the haiku alias moves (model-config already lists a
// haiku with very different prices), OCR spend would be mispriced silently.
//
// Contract: record(usage, model) — the second argument is the resolved model id
// that was actually sent to the API (OCR_MODEL), for BOTH ocrImagePdf and
// ocrImage. Trackers that ignore the second argument keep working unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    constructor() {
      this.messages = { create: mockCreate, stream: (...args) => ({ finalMessage: () => mockCreate(...args) }) };
    }
  }
  return { default: MockAnthropic };
});

const USAGE = { input_tokens: 1234, output_tokens: 56 };
const okResponse = () => ({
  content: [{ type: 'text', text: JSON.stringify({ raw_text: 'Receipt total $1.00', document_type: 'receipt', signals: [] }) }],
  usage: { ...USAGE },
});
const tracker = () => ({ isCapReached: vi.fn(() => false), record: vi.fn(() => 0.01) });

beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockResolvedValue(okResponse());
});

describe('#2544 OCR cost tracking passes the model to record(usage, model)', () => {
  it('ocrImagePdf calls record(usage, OCR_MODEL)', async () => {
    const { ocrImagePdf, OCR_MODEL } = await import('../ocr.js');
    const costTracker = tracker();
    await ocrImagePdf(Buffer.from('%PDF-1.4 tiny'), 'a.pdf', { costTracker });
    expect(costTracker.record).toHaveBeenCalledTimes(1);
    expect(costTracker.record).toHaveBeenCalledWith(USAGE, OCR_MODEL);
  });

  it('ocrImage calls record(usage, OCR_MODEL)', async () => {
    const { ocrImage, OCR_MODEL } = await import('../ocr.js');
    const costTracker = tracker();
    await ocrImage(Buffer.from([0xff, 0xd8, 0xff]), 'a.jpg', '.jpg', { costTracker });
    expect(costTracker.record).toHaveBeenCalledTimes(1);
    expect(costTracker.record).toHaveBeenCalledWith(USAGE, OCR_MODEL);
  });

  it('the model passed to record is the same model sent to the API', async () => {
    const { ocrImagePdf, ocrImage } = await import('../ocr.js');
    const costTracker = tracker();
    await ocrImagePdf(Buffer.from('%PDF-1.4 tiny'), 'a.pdf', { costTracker });
    await ocrImage(Buffer.from([0xff, 0xd8, 0xff]), 'a.jpg', '.jpg', { costTracker });
    const sent = mockCreate.mock.calls.map(([req]) => req.model);
    const recorded = costTracker.record.mock.calls.map(([, model]) => model);
    expect(recorded).toEqual(sent);
    for (const m of recorded) expect(typeof m === 'string' && m.length > 0).toBe(true);
  });

  it('a legacy one-argument tracker still works (second arg is ignored)', async () => {
    const { ocrImagePdf } = await import('../ocr.js');
    const legacy = { isCapReached: () => false, record: (usage) => (usage.input_tokens || 0) * 0.000001 };
    const r = await ocrImagePdf(Buffer.from('%PDF-1.4 tiny'), 'a.pdf', { costTracker: legacy });
    expect(r.cost).toBeCloseTo(0.001234, 6);
  });
});
