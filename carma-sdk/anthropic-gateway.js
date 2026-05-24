/**
 * anthropic-gateway.js — single ingress for every Carma LLM call.
 *
 * Replaces 12 hand-rolled call sites + drifted retry logic + ad-hoc stats with:
 *   - cache: 'auto' (default) wraps system prompts ≥1024 tokens with ephemeral cache_control
 *   - 3-layer cap enforcement (kill switch + in-mem cache + D1 verify)
 *   - exponential backoff for 429/5xx (3 attempts, 500ms/2s/8s)
 *   - timeout via AbortSignal (caller can also pass their own signal)
 *   - async telemetry write to D1 llm_calls (5s flush)
 *
 * Public surface in §10.2 of the 2026-05-22 architecture review.
 */
import { costUsd, resolveModel, estimateTokens, CACHE_FLOOR_TOKENS } from './lib/cost.js';
import {
  checkCap,
  recordSpend,
  killSwitch as _killSwitch,
  clearKillSwitch as _clearKillSwitch,
  refreshCaps as _refreshCaps,
  configureCaps,
  getCachedCap,
  getCachedSpend,
} from './lib/caps.js';
import { configureTelemetry, writeTelemetry } from './lib/telemetry.js';
import { createBatch, pollBatch, getBatchResults } from './lib/batch.js';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const RETRY_BACKOFF_MS = [500, 2_000, 8_000];

let _config = null;
let _configured = false;

export class GatewayError extends Error {
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;         // KILL_SWITCH | CAP_EXCEEDED | RATE_LIMIT | TIMEOUT | API_ERROR | AUTH
    this.status = opts.status || null;
    this.retryable = opts.retryable || false;
    if (opts.cause) this.cause = opts.cause;
  }
}

/**
 * Configure once at process start. Idempotent.
 *
 * @param {object} opts
 * @param {string} opts.apiKey       — Anthropic API key
 * @param {string} opts.workerUrl    — Carma Worker base URL (for caps + telemetry)
 * @param {string} opts.workerToken  — Bearer for the Worker
 * @param {string} [opts.defaultModel]  — fallback model when caller omits it
 */
export function configureGateway({ apiKey, workerUrl, workerToken, defaultModel = 'claude-haiku-4-5-20251001' } = {}) {
  if (!apiKey) throw new Error('configureGateway: apiKey required');
  if (!workerUrl) throw new Error('configureGateway: workerUrl required');
  if (!workerToken) throw new Error('configureGateway: workerToken required');
  _config = { apiKey, workerUrl, workerToken, defaultModel };
  configureCaps({ workerUrl, token: workerToken });
  configureTelemetry({ workerUrl, token: workerToken });
  _configured = true;
  // Best-effort initial refresh — don't block on it.
  void _refreshCaps().catch(() => {});
}

function ensureConfigured() {
  if (_configured) return;
  // Auto-configure from env when not explicitly configured. Keeps simple callers
  // (CLI scripts, REPL) working without a configureGateway() call.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const workerUrl = process.env.CARMA_WORKER_URL || 'https://carma-pipeline-worker.conductor-paul.workers.dev';
  const workerToken = process.env.CARMA_API_TOKEN;
  if (!apiKey || !workerToken) {
    throw new GatewayError(
      'AUTH',
      'Gateway not configured — call configureGateway({ apiKey, workerUrl, workerToken }) or set ANTHROPIC_API_KEY + CARMA_API_TOKEN.'
    );
  }
  configureGateway({ apiKey, workerUrl, workerToken });
}

// ---------------------------------------------------------------- cache shaping

/**
 * Wrap a system prompt with cache_control when it's worth caching.
 *
 * @param {string | array} system
 * @param {'auto' | 'force' | 'off'} mode
 * @returns {array} system blocks (always array form when caching, else passthrough)
 */
function maybeAddCacheControl(system, mode) {
  if (mode === 'off') return system;
  if (Array.isArray(system)) {
    // Already shaped. If `mode === 'force'`, make sure at least the first text block has cache_control.
    if (mode === 'force') {
      return system.map((b, i) => {
        if (i === 0 && b && b.type === 'text' && !b.cache_control) {
          return { ...b, cache_control: { type: 'ephemeral' } };
        }
        return b;
      });
    }
    return system;
  }
  if (typeof system !== 'string') return system;
  const tokens = estimateTokens(system);
  if (mode === 'auto' && tokens < CACHE_FLOOR_TOKENS) return system;
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

// ---------------------------------------------------------------- retry

function isRetryable(status) {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

async function fetchWithRetry(url, init) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      const body = await res.text().catch(() => '');
      if (isRetryable(res.status) && attempt < RETRY_BACKOFF_MS.length) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      const code = res.status === 401 || res.status === 403 ? 'AUTH'
                 : res.status === 429 ? 'RATE_LIMIT'
                 : 'API_ERROR';
      throw new GatewayError(code, `Anthropic ${res.status}: ${body.slice(0, 500)}`, { status: res.status });
    } catch (e) {
      lastErr = e;
      if (e instanceof GatewayError) throw e;
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        throw new GatewayError('TIMEOUT', 'Anthropic request timed out', { cause: e });
      }
      if (attempt < RETRY_BACKOFF_MS.length) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      throw new GatewayError('API_ERROR', e?.message || 'fetch failed', { cause: e });
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- single call

/**
 * @param {object} opts
 * @param {string} opts.agent          — REQUIRED telemetry + cap key
 * @param {string} opts.model
 * @param {string|array} opts.system
 * @param {array} opts.messages
 * @param {array} [opts.tools]
 * @param {number} [opts.max_tokens]
 * @param {number} [opts.temperature]
 * @param {'auto' | 'force' | 'off'} [opts.cache='auto']
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.metadata]     — { user_id, deal_id, request_id }
 */
export async function callClaude({
  agent,
  model,
  system,
  messages,
  tools,
  max_tokens = 1024,
  temperature,
  cache = 'auto',
  signal,
  metadata = {},
} = {}) {
  if (!agent) throw new GatewayError('API_ERROR', 'callClaude: agent is required');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new GatewayError('API_ERROR', 'callClaude: messages must be a non-empty array');
  }
  ensureConfigured();
  const cfg = _config;
  const resolved = resolveModel(model || cfg.defaultModel);
  const gatewayRequestId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `gw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  // -------- caps --------
  let capCheck = checkCap(agent);
  if (capCheck.code === 'CAP_NEAR') {
    // Re-verify against D1 to avoid letting a borderline call through.
    await _refreshCaps();
    capCheck = checkCap(agent);
  }
  if (!capCheck.ok && (capCheck.code === 'KILL_SWITCH' || capCheck.code === 'CAP_EXCEEDED')) {
    writeTelemetry({
      agent, model: resolved,
      input_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, output_tokens: 0,
      cost_usd: 0, cached: 0, cache_hit: 0, batched: 0,
      status: capCheck.code === 'KILL_SWITCH' ? 'kill_switch' : 'cap_exceeded',
      error_class: capCheck.code.toLowerCase(),
      gateway_request_id: gatewayRequestId,
      request_id: metadata.request_id || null,
      user_id: metadata.user_id || null,
      deal_id: metadata.deal_id || null,
    });
    throw new GatewayError(
      capCheck.code,
      `agent=${agent} ${capCheck.code === 'KILL_SWITCH' ? 'killed' : `spend=$${capCheck.spend.toFixed(4)} cap=$${capCheck.cap.toFixed(2)}`}`
    );
  }

  // -------- shape body --------
  const shapedSystem = maybeAddCacheControl(system, cache);
  const body = {
    model: resolved,
    max_tokens,
    messages,
  };
  if (shapedSystem !== undefined && shapedSystem !== null) body.system = shapedSystem;
  if (tools && tools.length > 0) body.tools = tools;
  if (typeof temperature === 'number') body.temperature = temperature;

  const start = Date.now();
  let res;
  try {
    res = await fetchWithRetry(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    const code = e instanceof GatewayError ? e.code : 'API_ERROR';
    writeTelemetry({
      agent, model: resolved,
      input_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, output_tokens: 0,
      cost_usd: 0, cached: cache === 'auto' || cache === 'force' ? 1 : 0, cache_hit: 0, batched: 0,
      status: 'error',
      error_class: code.toLowerCase(),
      latency_ms: Date.now() - start,
      gateway_request_id: gatewayRequestId,
      request_id: metadata.request_id || null,
      user_id: metadata.user_id || null,
      deal_id: metadata.deal_id || null,
    });
    throw e;
  }

  const data = await res.json();
  const latency = Date.now() - start;

  const usage = data.usage || {};
  const cacheHit = (usage.cache_read_input_tokens || 0) > 0;
  const cost = costUsd(resolved, usage, { batched: false });

  recordSpend(agent, cost);
  writeTelemetry({
    agent,
    model: resolved,
    input_tokens: usage.input_tokens || 0,
    cache_read_tokens: usage.cache_read_input_tokens || 0,
    cache_creation_tokens: usage.cache_creation_input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cost_usd: cost,
    cached: (cache === 'auto' || cache === 'force') && Array.isArray(shapedSystem) ? 1 : 0,
    cache_hit: cacheHit ? 1 : 0,
    batched: 0,
    status: 'ok',
    stop_reason: data.stop_reason || null,
    latency_ms: latency,
    gateway_request_id: gatewayRequestId,
    request_id: metadata.request_id || null,
    user_id: metadata.user_id || null,
    deal_id: metadata.deal_id || null,
  });

  return {
    content: data.content || [],
    usage,
    cost_usd: cost,
    cached: (cache === 'auto' || cache === 'force') && Array.isArray(shapedSystem),
    cache_hit: cacheHit,
    model_used: data.model || resolved,
    latency_ms: latency,
    gateway_request_id: gatewayRequestId,
    stop_reason: data.stop_reason || null,
  };
}

// ---------------------------------------------------------------- batch

/**
 * Submit a batch and wait for it to finish. Returns a unified results array.
 *
 * Note: callers pay 50% of normal price. Telemetry records each individual
 * sub-call with `batched=1`.
 */
export async function callClaudeBatch({
  agent,
  requests,
  pollIntervalMs = 30_000,
  maxWaitMs = 7_200_000,
  signal,
} = {}) {
  if (!agent) throw new GatewayError('API_ERROR', 'callClaudeBatch: agent is required');
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new GatewayError('API_ERROR', 'callClaudeBatch: requests required');
  }
  ensureConfigured();
  const cfg = _config;

  // Cap check up front — refuse to submit a batch if the agent is already over.
  const cap = checkCap(agent);
  if (!cap.ok && cap.code === 'KILL_SWITCH') {
    throw new GatewayError('KILL_SWITCH', `agent=${agent} killed`);
  }
  if (!cap.ok && cap.code === 'CAP_EXCEEDED') {
    throw new GatewayError('CAP_EXCEEDED', `agent=${agent} over cap`);
  }

  const submission = await createBatch({
    apiKey: cfg.apiKey,
    requests: requests.map((r) => ({
      custom_id: r.custom_id,
      model: resolveModel(r.model || cfg.defaultModel),
      max_tokens: r.max_tokens || 1024,
      system: r.system,
      messages: r.messages,
      ...(r.tools ? { tools: r.tools } : {}),
      ...(typeof r.temperature === 'number' ? { temperature: r.temperature } : {}),
    })),
    signal,
  });

  const final = await pollBatch({
    apiKey: cfg.apiKey,
    batchId: submission.id,
    pollIntervalMs,
    maxWaitMs,
    signal,
  });

  const results = await getBatchResults({
    apiKey: cfg.apiKey,
    resultsUrl: final.results_url,
    signal,
  });

  // Each line: { custom_id, result: { type, message } } | { custom_id, result: { type: 'errored', error } }
  const out = [];
  let totalCost = 0;
  for (const line of results) {
    if (line.result?.type === 'succeeded') {
      const msg = line.result.message;
      const usage = msg.usage || {};
      const model = msg.model || cfg.defaultModel;
      const cost = costUsd(model, usage, { batched: true });
      totalCost += cost;
      writeTelemetry({
        agent, model,
        input_tokens: usage.input_tokens || 0,
        cache_read_tokens: usage.cache_read_input_tokens || 0,
        cache_creation_tokens: usage.cache_creation_input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cost_usd: cost, cached: 0, cache_hit: 0, batched: 1,
        batch_id: submission.id,
        status: 'ok',
        stop_reason: msg.stop_reason || null,
        gateway_request_id: line.custom_id,
        request_id: line.custom_id,
      });
      out.push({
        custom_id: line.custom_id,
        content: msg.content || [],
        usage,
        cost_usd: cost,
        stop_reason: msg.stop_reason || null,
      });
    } else {
      writeTelemetry({
        agent, model: cfg.defaultModel,
        input_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, output_tokens: 0,
        cost_usd: 0, cached: 0, cache_hit: 0, batched: 1,
        batch_id: submission.id,
        status: 'error',
        error_class: line.result?.error?.type || 'batch_error',
        gateway_request_id: line.custom_id,
        request_id: line.custom_id,
      });
      out.push({
        custom_id: line.custom_id,
        error: line.result?.error || { type: 'unknown' },
      });
    }
  }
  recordSpend(agent, totalCost);

  return { batch_id: submission.id, results: out };
}

// ---------------------------------------------------------------- introspection

/**
 * GET /api/llm/cost for one agent. Always hits D1 (no cache) — use for
 * dashboards and the cap-near re-verify path.
 */
export async function getDailySpend(agent) {
  ensureConfigured();
  const cfg = _config;
  const url = `${cfg.workerUrl}/api/llm/cost?agent=${encodeURIComponent(agent)}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${cfg.workerToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new GatewayError('API_ERROR', `getDailySpend ${res.status}`);
  const data = await res.json();
  const today = (data.spend || []).find((s) => s.agent === agent) || { spend_usd: 0, calls: 0, input_tokens: 0, cache_read_tokens: 0, output_tokens: 0 };
  const capRow = (data.caps || []).find((c) => c.agent === agent) || { daily_cap_usd: 0 };
  return {
    agent,
    date: new Date().toISOString().slice(0, 10),
    calls: today.calls,
    input_tokens: today.input_tokens,
    cached_tokens: today.cache_read_tokens,
    output_tokens: today.output_tokens,
    spend_usd: today.spend_usd,
    cap_usd: capRow.daily_cap_usd,
    remaining_usd: Math.max(0, (capRow.daily_cap_usd || 0) - (today.spend_usd || 0)),
  };
}

export function killSwitch(agent)       { return _killSwitch(agent); }
export function clearKillSwitch(agent)  { return _clearKillSwitch(agent); }
export function refreshCaps()           { return _refreshCaps(); }

/** Test-only — reset module-level state. */
export function _reset() {
  _config = null;
  _configured = false;
}
