/**
 * cost.js — Anthropic token-to-USD math.
 *
 * Pricing table is the public Anthropic price list (input / cache_write / cache_read / output)
 * in USD per million tokens. Keep aliases mapped to their pinned model IDs so callers can
 * pass either 'sonnet-4-5' or 'claude-sonnet-4-5-20250929' interchangeably.
 *
 * Last reviewed: 2026-05-22.
 */

// USD per million tokens.
const PRICING = {
  // Opus 4.7
  'claude-opus-4-7':              { input: 15.00, cache_write: 18.75, cache_read: 1.50,  output: 75.00 },
  // Opus 4.6
  'claude-opus-4-6':              { input: 15.00, cache_write: 18.75, cache_read: 1.50,  output: 75.00 },
  // Sonnet 4.6
  'claude-sonnet-4-6':            { input: 3.00,  cache_write: 3.75,  cache_read: 0.30,  output: 15.00 },
  // Sonnet 4.5 (pinned)
  'claude-sonnet-4-5-20250929':   { input: 3.00,  cache_write: 3.75,  cache_read: 0.30,  output: 15.00 },
  // Haiku 4.5 (pinned)
  'claude-haiku-4-5-20251001':    { input: 1.00,  cache_write: 1.25,  cache_read: 0.10,  output: 5.00 },
  // Haiku 3.5 (legacy)
  'claude-3-5-haiku-20241022':    { input: 0.80,  cache_write: 1.00,  cache_read: 0.08,  output: 4.00 },
};

const ALIASES = {
  'opus-4-7':     'claude-opus-4-7',
  'opus-4.7':     'claude-opus-4-7',
  'opus-4-6':     'claude-opus-4-6',
  'opus-4.6':     'claude-opus-4-6',
  'sonnet-4-6':   'claude-sonnet-4-6',
  'sonnet-4.6':   'claude-sonnet-4-6',
  'sonnet-4-5':   'claude-sonnet-4-5-20250929',
  'sonnet-4.5':   'claude-sonnet-4-5-20250929',
  'haiku-4-5':    'claude-haiku-4-5-20251001',
  'haiku-4.5':    'claude-haiku-4-5-20251001',
  'haiku':        'claude-haiku-4-5-20251001',
  'sonnet':       'claude-sonnet-4-6',
  'opus':         'claude-opus-4-7',
};

export function resolveModel(modelOrAlias) {
  if (!modelOrAlias) return null;
  if (PRICING[modelOrAlias]) return modelOrAlias;
  return ALIASES[modelOrAlias] || modelOrAlias;
}

/**
 * Compute USD cost for a single call from Anthropic usage data.
 *
 * @param {string} model — pinned or alias
 * @param {object} usage — { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens }
 * @param {object} [opts] — { batched: bool }  // batch API is 50% off
 * @returns {number} cost in USD (4 decimal places)
 */
export function costUsd(model, usage, opts = {}) {
  const resolved = resolveModel(model);
  const p = PRICING[resolved];
  if (!p) return 0;

  const input = usage.input_tokens || 0;
  const cw = usage.cache_creation_input_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0;
  const out = usage.output_tokens || 0;

  let cost =
    (input * p.input + cw * p.cache_write + cr * p.cache_read + out * p.output) / 1_000_000;

  if (opts.batched) cost *= 0.5;

  return Math.round(cost * 10000) / 10000;
}

/** Rough token estimate: 1 token ≈ 4 characters of English text. */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export const CACHE_FLOOR_TOKENS = 1024;

export { PRICING, ALIASES };
