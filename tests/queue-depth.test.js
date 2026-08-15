/**
 * queue-depth.test.js — TEST-FIRST (red before impl) for the queue.depth
 * health check born from the 2026-08-02 consumer outage: producers archived
 * mail out of Gmail into <SLUICE_DIR>/inbox for TEN DAYS while nothing
 * consumed it, and the harness-bound health report stayed green because only
 * producer_run was checked. HOUSE RULE this encodes: an unconfigured or
 * stalled dependency must degrade a health check, never report green.
 *
 * Thresholds under test (see queue-depth.js for the volume reasoning):
 *   pass — depth <= DEPTH_WARN_THRESHOLD and oldest < AGE_WARN_MS
 *   warn — depth >  DEPTH_WARN_THRESHOLD or  oldest > AGE_WARN_MS (6h)
 *   fail — oldest > AGE_FAIL_MS (24h), or inbox dir missing/unreadable
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeQueueDepthCheck,
  DEPTH_WARN_THRESHOLD,
  AGE_WARN_MS,
  AGE_FAIL_MS,
} from '../queue-depth.js';

let base;

function makeInbox(envelopes) {
  const inbox = path.join(base, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  for (const { id, mtime } of envelopes) {
    const dir = path.join(inbox, id);
    fs.mkdirSync(dir);
    if (mtime) fs.utimesSync(dir, mtime, mtime);
  }
  return inbox;
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-depth-'));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('computeQueueDepthCheck', () => {
  it('passes on an empty inbox', () => {
    const inbox = makeInbox([]);
    const check = computeQueueDepthCheck({ inboxDir: inbox });
    expect(check.id).toBe('queue.depth');
    expect(check.status).toBe('pass');
    expect(check.metric).toBe(0);
  });

  it('warns when depth exceeds the threshold even if every envelope is fresh', () => {
    const now = new Date('2026-08-02T12:00:00Z');
    const fresh = new Date(now.getTime() - 60_000);
    const envelopes = Array.from({ length: DEPTH_WARN_THRESHOLD + 1 }, (_, i) => ({
      id: `env-${i}`,
      mtime: fresh,
    }));
    const check = computeQueueDepthCheck({ inboxDir: makeInbox(envelopes), now });
    expect(check.status).toBe('warn');
    expect(check.metric).toBe(DEPTH_WARN_THRESHOLD + 1);
  });

  it('warns when the oldest envelope is older than the 6h age threshold', () => {
    const now = new Date('2026-08-02T12:00:00Z');
    const sevenHoursAgo = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const inbox = makeInbox([
      { id: 'old', mtime: sevenHoursAgo },
      { id: 'fresh-1', mtime: now },
      { id: 'fresh-2', mtime: now },
    ]);
    const check = computeQueueDepthCheck({ inboxDir: inbox, now });
    expect(check.status).toBe('warn');
  });

  it('fails when the oldest envelope is older than the 24h age threshold', () => {
    const now = new Date('2026-08-02T12:00:00Z');
    const dayPlusAgo = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    const inbox = makeInbox([{ id: 'stale', mtime: dayPlusAgo }]);
    const check = computeQueueDepthCheck({ inboxDir: inbox, now });
    expect(check.status).toBe('fail');
  });

  // THE REGRESSION TEST — today's real outage state, reconstructed. 1,349
  // envelopes, oldest dated 2026-07-24 08:00, checked on 2026-08-02. The old
  // health report said status:"ok" through all ten days of this. This check
  // must say fail.
  it('fails on the reconstructed 2026-08-02 outage state (1,349 envelopes, oldest 2026-07-24)', () => {
    const now = new Date('2026-08-02T18:00:00-07:00');
    const outageStart = new Date('2026-07-24T08:00:03-07:00');
    const envelopes = Array.from({ length: 1349 }, (_, i) => ({
      id: `outage-${i}`,
      // spread mtimes across the ten days, oldest first
      mtime: new Date(Math.min(outageStart.getTime() + i * 10 * 60 * 1000, now.getTime() - 1000)),
    }));
    const check = computeQueueDepthCheck({ inboxDir: makeInbox(envelopes), now });
    expect(check.status).toBe('fail');
    expect(check.metric).toBe(1349);
  });

  it('fails (does not crash, does not pass) when the inbox dir is missing entirely', () => {
    const check = computeQueueDepthCheck({ inboxDir: path.join(base, 'does-not-exist', 'inbox') });
    expect(check.status).toBe('fail');
    // strict HealthCheckSchema: metric is a number or absent — never null
    expect(check.metric).toBeUndefined();
  });

  it('fails when inboxDir is not configured at all (null/undefined)', () => {
    expect(computeQueueDepthCheck({ inboxDir: null }).status).toBe('fail');
    expect(computeQueueDepthCheck({}).status).toBe('fail');
  });

  it('ignores the producers\' .tmp staging dir when counting depth', () => {
    const inbox = makeInbox([{ id: 'real', mtime: new Date() }]);
    fs.mkdirSync(path.join(inbox, '.tmp'));
    const check = computeQueueDepthCheck({ inboxDir: inbox });
    expect(check.metric).toBe(1);
  });
});
