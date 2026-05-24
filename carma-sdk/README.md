# @carma/sdk

Shared SDK for Carma agents. One Anthropic gateway, one Worker client, one PII scrubber, one env loader.

## Why

The audit (2026-05-22) found 12 hand-rolled Anthropic call sites, 4 different `apiFetch` reimplementations, 5 ad-hoc env loaders, and 4 PII scrubber copies. This package consolidates all of that behind a small, stable interface so callers stop drifting.

## Public surface

```js
import {
  callClaude,
  callClaudeBatch,
  GatewayError,
  getDailySpend,
  killSwitch,
  refreshCaps,
  apiFetch,
  WorkerClient,
  loadEnv,
  maskEmail, maskName, maskPhone, scrubText,
} from '@carma/sdk';
```

## Anthropic gateway

```js
const result = await callClaude({
  agent:    'wayfinder-bot',        // REQUIRED — telemetry + cap key
  model:    'claude-haiku-4-5-20251001',
  system,                            // string OR array of blocks
  messages,
  tools,                             // optional
  max_tokens: 1024,
  temperature: 0,
  cache: 'auto',                     // 'auto' (default) | 'force' | 'off'
  signal: AbortSignal.timeout(30000),
  metadata: { user_id, deal_id, request_id },
});
// { content, usage, cost_usd, cached, cache_hit, model_used, latency_ms, gateway_request_id, stop_reason }
```

`cache: 'auto'` wraps the system prompt with `cache_control: { type: 'ephemeral' }` when it's >= 1024 tokens (rough heuristic: 4 chars per token).

### Errors

`GatewayError` codes: `KILL_SWITCH | CAP_EXCEEDED | RATE_LIMIT | TIMEOUT | API_ERROR | AUTH`.

```js
try { await callClaude({...}); }
catch (e) {
  if (e instanceof GatewayError && e.code === 'CAP_EXCEEDED') return safeFallback();
  throw e;
}
```

## Caps + kill switch

Three-layer enforcement:

1. **Kill switch** — `touch /tmp/anthropic-killswitch-<agent>` immediately blocks that agent.
2. **In-memory cache** — refreshed every 30s from D1 `v_llm_spend_today`.
3. **D1 verify** — within 10% of cap, re-query before allowing the call.

```js
killSwitch('mini-me');        // creates /tmp marker
await refreshCaps();          // pull fresh caps + spend from D1
const s = await getDailySpend('pathfinder-strategy');
```

## Worker client

```js
const client = new WorkerClient({
  baseUrl: env.CARMA_WORKER_URL,
  token: env.CARMA_API_TOKEN,
});
const deal = await client.get('/api/deals/123');
const updated = await client.put('/api/deals/123', { stage: 'committed' });
```

Or the standalone helper:

```js
const deal = await apiFetch('/api/deals/123', { baseUrl, token });
```

## Env

```js
const env = loadEnv({ requires: ['ANTHROPIC_API_KEY', 'CARMA_API_TOKEN'] });
// Throws if any required key is missing.
// Walks .env, master.env, then process.env, in that order.
// SOC 2 §10 — never inspect keys outside the declared list.
```

## Telemetry

Every `callClaude` writes one row to D1 `llm_calls` via the async batched writer (5s or 50 records). Callers don't see it.
