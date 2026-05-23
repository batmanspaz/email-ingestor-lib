import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerClient, apiFetch, WorkerClientError } from '../worker-client.js';

const ORIG_FETCH = globalThis.fetch;

afterEach(() => { globalThis.fetch = ORIG_FETCH; });

describe('apiFetch', () => {
  test('requires baseUrl + token', async () => {
    await expect(apiFetch('/api/x')).rejects.toBeInstanceOf(WorkerClientError);
  });

  test('GET returns parsed JSON body', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 1 }),
    }));
    const r = await apiFetch('/api/deals/1', { baseUrl: 'https://w', token: 't' });
    expect(r).toEqual({ id: 1 });
  });

  test('POST sends JSON-stringified body and Content-Type header', async () => {
    let captured = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      captured = { url, opts };
      return { ok: true, status: 200, text: async () => '{}' };
    });
    await apiFetch('/api/deals', {
      baseUrl: 'https://w/',
      token: 't',
      method: 'POST',
      body: { name: 'x' },
    });
    expect(captured.url).toBe('https://w/api/deals');
    expect(captured.opts.headers['Content-Type']).toBe('application/json');
    expect(captured.opts.headers['Authorization']).toBe('Bearer t');
    expect(JSON.parse(captured.opts.body)).toEqual({ name: 'x' });
  });

  test('204 returns null', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 204,
      text: async () => '',
    }));
    const r = await apiFetch('/api/x', { baseUrl: 'https://w', token: 't' });
    expect(r).toBe(null);
  });

  test('retries on 500 then succeeds', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n++;
      if (n < 2) {
        return { ok: false, status: 500, text: async () => 'down', json: async () => ({ error: 'down' }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    });
    const r = await apiFetch('/api/x', { baseUrl: 'https://w', token: 't', retries: 3 });
    expect(r).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  test('does NOT retry on 404', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n++;
      return { ok: false, status: 404, text: async () => 'nope', json: async () => ({ error: 'nope' }) };
    });
    await expect(apiFetch('/api/x', { baseUrl: 'https://w', token: 't' }))
      .rejects.toMatchObject({ status: 404 });
    expect(n).toBe(1);
  });

  test('throws WorkerClientError on persistent failure', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'down',
      json: async () => ({ error: 'down' }),
    }));
    await expect(apiFetch('/api/x', { baseUrl: 'https://w', token: 't', retries: 0 }))
      .rejects.toBeInstanceOf(WorkerClientError);
  });
});

describe('WorkerClient', () => {
  test('constructor requires baseUrl + token', () => {
    expect(() => new WorkerClient()).toThrow();
    expect(() => new WorkerClient({ baseUrl: 'https://w' })).toThrow();
  });

  test('get/post/put/patch/delete delegate to apiFetch', async () => {
    const seen = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      seen.push({ url, method: opts.method });
      return { ok: true, status: 200, text: async () => '{}' };
    });
    const c = new WorkerClient({ baseUrl: 'https://w', token: 't' });
    await c.get('/a');
    await c.post('/b', { x: 1 });
    await c.put('/c', { x: 1 });
    await c.patch('/d', { x: 1 });
    await c.delete('/e');
    expect(seen.map((s) => s.method)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  });

  test('honors default headers', async () => {
    let captured = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      captured = opts.headers;
      return { ok: true, status: 200, text: async () => '{}' };
    });
    const c = new WorkerClient({
      baseUrl: 'https://w',
      token: 't',
      defaultHeaders: { 'X-Carma-User': 'paul@gocarma.com' },
    });
    await c.get('/a');
    expect(captured['X-Carma-User']).toBe('paul@gocarma.com');
  });
});
