import { describe, test, expect } from 'vitest';
import { costUsd, resolveModel, estimateTokens, CACHE_FLOOR_TOKENS, PRICING } from '../lib/cost.js';

describe('resolveModel', () => {
  test('passes pinned IDs through', () => {
    expect(resolveModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
  });

  test('maps haiku-4.5 alias to pinned id', () => {
    expect(resolveModel('haiku-4.5')).toBe('claude-haiku-4-5-20251001');
  });

  test('maps shorthand sonnet to sonnet-4.6', () => {
    expect(resolveModel('sonnet')).toBe('claude-sonnet-4-6');
  });

  test('returns null for null input', () => {
    expect(resolveModel(null)).toBe(null);
  });

  test('returns unknown input unchanged so unknown models flow through to Anthropic for their error message', () => {
    expect(resolveModel('claude-foo')).toBe('claude-foo');
  });
});

describe('costUsd', () => {
  test('haiku 4.5 — 1M input + 1M output = $1 + $5', () => {
    const cost = costUsd('claude-haiku-4-5-20251001', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(6.00, 4);
  });

  test('cache read cost is 1/10th of input cost (haiku)', () => {
    const cost = costUsd('haiku-4.5', { cache_read_input_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.10, 4);
  });

  test('batched calls get 50% discount', () => {
    const a = costUsd('haiku-4.5', { input_tokens: 1_000_000 });
    const b = costUsd('haiku-4.5', { input_tokens: 1_000_000 }, { batched: true });
    expect(b).toBeCloseTo(a / 2, 4);
  });

  test('unknown model returns 0 (caller should detect)', () => {
    expect(costUsd('not-a-real-model', { input_tokens: 1_000_000 })).toBe(0);
  });

  test('rounds to 4 decimal places', () => {
    const cost = costUsd('haiku-4.5', { input_tokens: 1 });
    expect(cost.toString().split('.')[1]?.length || 0).toBeLessThanOrEqual(4);
  });
});

describe('estimateTokens', () => {
  test('rough 4 char per token estimate', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(4000))).toBe(1000);
  });

  test('empty string is 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
  });

  test('cache floor is 1024', () => {
    expect(CACHE_FLOOR_TOKENS).toBe(1024);
  });
});

describe('PRICING table sanity', () => {
  test('every model has input, cache_write, cache_read, output', () => {
    for (const [name, p] of Object.entries(PRICING)) {
      expect(p.input).toBeGreaterThan(0);
      expect(p.cache_write).toBeGreaterThan(0);
      expect(p.cache_read).toBeGreaterThan(0);
      expect(p.output).toBeGreaterThan(0);
      // cache_read should always be cheapest per million tokens
      expect(p.cache_read, `${name} cache_read should be <= input`).toBeLessThan(p.input);
    }
  });
});
