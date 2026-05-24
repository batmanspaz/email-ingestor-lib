import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { configureTelemetry, writeTelemetry, flush, _inspect, _reset } from '../lib/telemetry.js';

const ORIG_FETCH = globalThis.fetch;

describe('telemetry', () => {
  beforeEach(() => { _reset(); });
  afterEach(() => { _reset(); globalThis.fetch = ORIG_FETCH; });

  test('writeTelemetry without configure is a no-op (records queued)', () => {
    writeTelemetry({ agent: 'a', cost_usd: 0.01 });
    // Queue grows but nothing flushed
    expect(_inspect().queue_length).toBe(1);
    expect(_inspect().configured).toBe(false);
  });

  test('configureTelemetry rejects missing workerUrl', () => {
    expect(() => configureTelemetry({ token: 'x' })).toThrow();
  });

  test('configureTelemetry rejects missing token', () => {
    expect(() => configureTelemetry({ workerUrl: 'https://x' })).toThrow();
  });

  test('flush posts queued records', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200 };
    });
    configureTelemetry({ workerUrl: 'https://worker.example', token: 't' });
    writeTelemetry({ agent: 'a', cost_usd: 0.05, model: 'haiku-4.5' });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://worker.example/api/llm-calls/batch');
    expect(calls[0].body.calls).toHaveLength(1);
    expect(calls[0].body.calls[0].agent).toBe('a');
  });

  test('flush returns records to the queue on failure', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('network down'); });
    configureTelemetry({ workerUrl: 'https://worker.example', token: 't' });
    writeTelemetry({ agent: 'a', cost_usd: 0.01 });
    await flush();
    expect(_inspect().queue_length).toBe(1);
  });

  test('auto-flush triggers at 50 records', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      calls.push(JSON.parse(opts.body).calls.length);
      return { ok: true, status: 200 };
    });
    configureTelemetry({ workerUrl: 'https://worker.example', token: 't' });
    for (let i = 0; i < 50; i++) writeTelemetry({ agent: 'a', cost_usd: 0.001 });
    // The 50th write triggers an async flush.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toBe(50);
  });
});
