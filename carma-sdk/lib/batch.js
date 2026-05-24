/**
 * batch.js — Anthropic Message Batches API wrapper.
 *
 * The batch API gives 50% off the per-token rate in exchange for asynchronous
 * processing (results within 24h, usually minutes). Used for cron workloads
 * where latency doesn't matter (email-ingestor backfills, pathfinder nightly).
 *
 * Reference: https://docs.anthropic.com/en/api/creating-message-batches
 */

const BATCHES_ENDPOINT = 'https://api.anthropic.com/v1/messages/batches';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'message-batches-2024-09-24';

function headers(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': ANTHROPIC_BETA,
    'Content-Type': 'application/json',
  };
}

export async function createBatch({ apiKey, requests, signal }) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error('createBatch: requests must be a non-empty array');
  }
  // Anthropic format: { requests: [{ custom_id, params }] }
  const formatted = requests.map((r) => {
    if (!r.custom_id) throw new Error('createBatch: every request needs custom_id');
    const { custom_id, ...params } = r;
    return { custom_id, params };
  });
  const res = await fetch(BATCHES_ENDPOINT, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ requests: formatted }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic batch create ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();  // { id, processing_status, request_counts, ... }
}

export async function getBatch({ apiKey, batchId, signal }) {
  const res = await fetch(`${BATCHES_ENDPOINT}/${batchId}`, {
    method: 'GET',
    headers: headers(apiKey),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic batch get ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

/**
 * Stream JSONL results — Anthropic returns one JSON object per line via results_url.
 */
export async function getBatchResults({ apiKey, resultsUrl, signal }) {
  const res = await fetch(resultsUrl, {
    method: 'GET',
    headers: headers(apiKey),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic batch results ${res.status}: ${body.slice(0, 500)}`);
  }
  const text = await res.text();
  const lines = text.split('\n').filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

/**
 * Poll until the batch finishes or maxWaitMs elapses.
 */
export async function pollBatch({ apiKey, batchId, pollIntervalMs = 30_000, maxWaitMs = 7_200_000, signal }) {
  const start = Date.now();
  while (true) {
    const state = await getBatch({ apiKey, batchId, signal });
    if (state.processing_status === 'ended') return state;
    if (state.processing_status === 'canceled' || state.processing_status === 'expired') {
      throw new Error(`Batch ${batchId} finished with status ${state.processing_status}`);
    }
    if (Date.now() - start > maxWaitMs) {
      throw new Error(`Batch ${batchId} timed out after ${maxWaitMs}ms (status=${state.processing_status})`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}
