import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  callClaude,
  GatewayError,
  killSwitch,
  clearKillSwitch,
  _reset as _gatewayReset,
} from '../anthropic-gateway.js';
import { configureGateway } from '../anthropic-gateway.js';
import { _seed, _reset as _capsReset } from '../lib/caps.js';
import { _reset as _telReset, _inspect as _telInspect } from '../lib/telemetry.js';

const ORIG_FETCH = globalThis.fetch;
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';

function mockOk(body) {
  return async () => ({ ok: true, status: 200, text: async () => '', json: async () => body });
}

beforeEach(() => {
  _gatewayReset();
  _capsReset();
  _telReset();
  configureGateway({
    apiKey: 'test-anthropic-key',
    workerUrl: 'https://worker.example',
    workerToken: 'test-worker-token',
  });
});

afterEach(() => {
  _gatewayReset();
  _capsReset();
  _telReset();
  globalThis.fetch = ORIG_FETCH;
});

describe('callClaude — input validation', () => {
  test('requires agent', async () => {
    await expect(callClaude({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(/agent is required/);
  });

  test('requires non-empty messages', async () => {
    await expect(callClaude({ agent: 'x', messages: [] }))
      .rejects.toThrow(/messages/);
  });
});

describe('callClaude — happy path', () => {
  test('returns content + usage + cost + cache_hit', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url === ANTHROPIC) {
        return {
          ok: true, status: 200, text: async () => '',
          json: async () => ({
            content: [{ type: 'text', text: 'hello world' }],
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
            stop_reason: 'end_turn',
            model: 'claude-haiku-4-5-20251001',
          }),
        };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    });
    const r = await callClaude({
      agent: 'unit-test',
      model: 'haiku-4.5',
      system: 'short prompt',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.content[0].text).toBe('hello world');
    expect(r.cache_hit).toBe(true);
    expect(r.cost_usd).toBeGreaterThan(0);
    expect(r.model_used).toBe('claude-haiku-4-5-20251001');
    expect(r.gateway_request_id).toBeTruthy();
  });

  test('forwards tools and temperature into the request body', async () => {
    let sentBody = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      if (url === ANTHROPIC) {
        sentBody = JSON.parse(opts.body);
        return {
          ok: true, status: 200, text: async () => '',
          json: async () => ({ content: [], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }),
        };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    });
    await callClaude({
      agent: 'unit-test',
      model: 'haiku-4.5',
      system: 'short',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 't', description: '', input_schema: { type: 'object' } }],
      temperature: 0.7,
    });
    expect(sentBody.tools).toHaveLength(1);
    expect(sentBody.temperature).toBe(0.7);
  });
});

describe('callClaude — caching', () => {
  test('cache=auto wraps a >=1024 token system prompt in ephemeral cache_control', async () => {
    let sent = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      if (url === ANTHROPIC) {
        sent = JSON.parse(opts.body);
        return {
          ok: true, status: 200, text: async () => '',
          json: async () => ({ content: [], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }),
        };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    });
    const longPrompt = 'a'.repeat(5000);  // ~1250 tokens
    await callClaude({
      agent: 'unit-test',
      model: 'haiku-4.5',
      system: longPrompt,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(Array.isArray(sent.system)).toBe(true);
    expect(sent.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('cache=off leaves the system prompt as a plain string', async () => {
    let sent = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      if (url === ANTHROPIC) {
        sent = JSON.parse(opts.body);
        return {
          ok: true, status: 200, text: async () => '',
          json: async () => ({ content: [], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }),
        };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    });
    const longPrompt = 'a'.repeat(5000);
    await callClaude({
      agent: 'unit-test',
      model: 'haiku-4.5',
      system: longPrompt,
      cache: 'off',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(sent.system).toBe(longPrompt);
  });

  test('cache=auto leaves a SHORT system prompt unwrapped (below floor)', async () => {
    let sent = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      if (url === ANTHROPIC) {
        sent = JSON.parse(opts.body);
        return {
          ok: true, status: 200, text: async () => '',
          json: async () => ({ content: [], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }),
        };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    });
    await callClaude({
      agent: 'unit-test',
      model: 'haiku-4.5',
      system: 'tiny prompt',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(sent.system).toBe('tiny prompt');
  });
});

describe('callClaude — caps + kill switch', () => {
  test('throws GatewayError(KILL_SWITCH) when /tmp marker exists', async () => {
    killSwitch('killed-agent');
    try {
      await expect(callClaude({
        agent: 'killed-agent',
        model: 'haiku-4.5',
        messages: [{ role: 'user', content: 'hi' }],
      })).rejects.toMatchObject({ code: 'KILL_SWITCH' });
    } finally {
      clearKillSwitch('killed-agent');
    }
  });

  test('throws GatewayError(CAP_EXCEEDED) when spend >= cap', async () => {
    _seed({
      caps: [{ agent: 'over', cap_usd: 0.50 }],
      spend: [{ agent: 'over', spend_usd: 0.50 }],
    });
    await expect(callClaude({
      agent: 'over',
      model: 'haiku-4.5',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toMatchObject({ code: 'CAP_EXCEEDED' });
  });
});

describe('callClaude — error mapping', () => {
  test('401 maps to AUTH', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 401, text: async () => 'unauthorized',
    }));
    await expect(callClaude({
      agent: 'unit-test',
      model: 'haiku-4.5',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toMatchObject({ code: 'AUTH' });
  });

  test('429 retries then throws RATE_LIMIT', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return { ok: false, status: 429, text: async () => 'rate limit' };
    });
    await expect(callClaude({
      agent: 'unit-test',
      model: 'haiku-4.5',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(calls).toBeGreaterThanOrEqual(2);
  }, 30000);

  test('GatewayError carries code, status, and message', () => {
    const e = new GatewayError('CAP_EXCEEDED', 'over budget', { status: 402 });
    expect(e.code).toBe('CAP_EXCEEDED');
    expect(e.status).toBe(402);
    expect(e.name).toBe('GatewayError');
    expect(e.message).toBe('over budget');
  });
});

describe('callClaude — telemetry', () => {
  test('successful call queues one telemetry record', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url === ANTHROPIC) {
        return {
          ok: true, status: 200, text: async () => '',
          json: async () => ({
            content: [], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn',
          }),
        };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    });
    await callClaude({
      agent: 'telem-test',
      model: 'haiku-4.5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(_telInspect().queue_length).toBeGreaterThanOrEqual(1);
  });
});
