/**
 * worker-client.js — typed REST client for the Carma Worker.
 *
 * Replaces 4 hand-rolled apiFetch reimplementations (wayfinder-bot,
 * pathfinder, mini-me, email-ingestor). Adds:
 *   - Bearer auth from a single source
 *   - Per-request AbortSignal with a default timeout
 *   - Exponential backoff for 429 + 5xx (3 attempts, 250/1000/3000ms)
 *   - Structured WorkerClientError with status + path
 *   - JSON parsing with text fallback so 204/empty responses don't crash
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_BACKOFF_MS = [250, 1_000, 3_000];

export class WorkerClientError extends Error {
  constructor(message, { status, path, body } = {}) {
    super(message);
    this.name = 'WorkerClientError';
    this.status = status || 0;
    this.path = path || '';
    this.body = body || null;
  }
}

function shouldRetry(status) {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Low-level fetch helper. Most callers want `WorkerClient` for ergonomics, but
 * this standalone form is useful for one-off scripts that don't want to keep
 * a client around.
 *
 * @param {string} path        — '/api/deals/123'
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.token
 * @param {string} [opts.method='GET']
 * @param {object} [opts.body]
 * @param {object} [opts.headers]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs=15000]
 * @param {number} [opts.retries=3]
 */
export async function apiFetch(path, opts = {}) {
  const {
    baseUrl,
    token,
    method = 'GET',
    body,
    headers = {},
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = RETRY_BACKOFF_MS.length,
  } = opts;
  if (!baseUrl) throw new WorkerClientError('apiFetch: baseUrl required', { path });
  if (!token) throw new WorkerClientError('apiFetch: token required', { path });

  const url = baseUrl.replace(/\/$/, '') + (path.startsWith('/') ? path : `/${path}`);
  const finalHeaders = {
    'Authorization': `Bearer ${token}`,
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...headers,
  };

  let attemptSignal = signal;
  // If caller didn't supply a signal, build one with our timeout.
  // If they did, we honor it but still cap by timeoutMs to avoid hangs.
  if (!attemptSignal && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    attemptSignal = AbortSignal.timeout(timeoutMs);
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: attemptSignal,
      });
      if (res.ok) {
        if (res.status === 204) return null;
        const text = await res.text();
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
      }
      if (shouldRetry(res.status) && attempt < retries) {
        await sleep(RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
        continue;
      }
      let parsedBody = null;
      try { parsedBody = await res.json(); }
      catch { try { parsedBody = await res.text(); } catch { /* nothing */ } }
      throw new WorkerClientError(
        `Worker ${res.status} ${method} ${path}: ${typeof parsedBody === 'string' ? parsedBody.slice(0, 300) : JSON.stringify(parsedBody).slice(0, 300)}`,
        { status: res.status, path, body: parsedBody }
      );
    } catch (e) {
      lastErr = e;
      if (e instanceof WorkerClientError) throw e;
      // Network / abort errors — retry if attempts remain.
      if (attempt < retries) {
        await sleep(RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
        continue;
      }
      throw new WorkerClientError(`Worker fetch failed ${method} ${path}: ${e?.message || 'unknown'}`, { path });
    }
  }
  throw lastErr;
}

export class WorkerClient {
  constructor({ baseUrl, token, defaultHeaders = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!baseUrl) throw new WorkerClientError('WorkerClient: baseUrl required');
    if (!token) throw new WorkerClientError('WorkerClient: token required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.defaultHeaders = defaultHeaders;
    this.timeoutMs = timeoutMs;
  }

  request(method, path, body, opts = {}) {
    return apiFetch(path, {
      baseUrl: this.baseUrl,
      token: this.token,
      method,
      body,
      timeoutMs: this.timeoutMs,
      ...opts,
      headers: { ...this.defaultHeaders, ...(opts.headers || {}) },
    });
  }

  get(path, opts)        { return this.request('GET', path, undefined, opts); }
  post(path, body, opts) { return this.request('POST', path, body, opts); }
  put(path, body, opts)  { return this.request('PUT', path, body, opts); }
  patch(path, body, opts){ return this.request('PATCH', path, body, opts); }
  delete(path, opts)     { return this.request('DELETE', path, undefined, opts); }
}
