/**
 * telemetry.js — async batched writer for llm_calls.
 *
 * Pushes records onto an in-process queue; flushes every 5s or when the queue
 * reaches 50 records. SIGTERM/SIGINT handlers flush before exit.
 *
 * Best-effort retry: on flush failure the batch goes back to the queue head,
 * but the queue is bounded at 10,000 records — beyond that the oldest half is
 * dropped to protect the host process. We'd rather lose telemetry than crash
 * an agent under load.
 */

const QUEUE_CAP = 10_000;
const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_BATCH_SIZE = 50;
const FETCH_TIMEOUT_MS = 10_000;

let _queue = [];
let _config = null;       // { workerUrl, token }
let _interval = null;
let _signalsBound = false;
let _flushing = false;
let _droppedTotal = 0;

export function configureTelemetry({ workerUrl, token } = {}) {
  if (!workerUrl) throw new Error('telemetry: workerUrl required');
  if (!token) throw new Error('telemetry: token required');
  _config = { workerUrl: workerUrl.replace(/\/$/, ''), token };
  startFlushLoop();
}

function startFlushLoop() {
  if (_interval) return;
  _interval = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
  if (typeof _interval.unref === 'function') _interval.unref();
  if (!_signalsBound && typeof process !== 'undefined' && typeof process.on === 'function') {
    process.on('SIGTERM', () => { void flush(); });
    process.on('SIGINT', () => { void flush(); });
    process.on('beforeExit', () => { void flush(); });
    _signalsBound = true;
  }
}

export function writeTelemetry(record) {
  if (!record) return;
  _queue.push({ ts: record.ts || new Date().toISOString(), ...record });
  if (_queue.length >= QUEUE_CAP) {
    const drop = Math.floor(QUEUE_CAP / 2);
    _queue.splice(0, drop);
    _droppedTotal += drop;
    if ((_droppedTotal / drop) % 10 === 1) {
      console.warn(`[carma-sdk/telemetry] queue overflow — dropped ${_droppedTotal} records total`);
    }
  }
  if (_queue.length >= FLUSH_BATCH_SIZE) void flush();
}

export async function flush() {
  if (_flushing) return;
  if (_queue.length === 0) return;
  if (!_config) return;

  _flushing = true;
  const batch = _queue.splice(0, _queue.length);
  try {
    const res = await fetch(`${_config.workerUrl}/api/llm-calls/batch`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${_config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ calls: batch }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`telemetry POST ${res.status}`);
  } catch (e) {
    _queue.unshift(...batch);
    if (_queue.length > QUEUE_CAP) {
      const overflow = _queue.length - Math.floor(QUEUE_CAP / 2);
      _queue.splice(Math.floor(QUEUE_CAP / 2), overflow);
      _droppedTotal += overflow;
    }
    console.warn(`[carma-sdk/telemetry] flush failed: ${e?.message || 'unknown'} — ${_queue.length} queued`);
  } finally {
    _flushing = false;
  }
}

/** Test-only: snapshot internal state without exporting `_queue` directly. */
export function _inspect() {
  return {
    queue_length: _queue.length,
    dropped_total: _droppedTotal,
    configured: _config !== null,
  };
}

/** Test-only: reset module state between tests. */
export function _reset() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  _queue = [];
  _config = null;
  _flushing = false;
  _droppedTotal = 0;
}
