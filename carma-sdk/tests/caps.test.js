import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import {
  killSwitch,
  clearKillSwitch,
  isKilled,
  killSwitchPath,
  checkCap,
  recordSpend,
  getCachedCap,
  getCachedSpend,
  _seed,
  _reset,
} from '../lib/caps.js';

describe('kill switch', () => {
  const AGENT = 'test-agent-caps';
  afterEach(() => { clearKillSwitch(AGENT); _reset(); });

  test('isKilled is false when no marker file exists', () => {
    expect(isKilled(AGENT)).toBe(false);
  });

  test('killSwitch creates the marker file', () => {
    killSwitch(AGENT);
    expect(isKilled(AGENT)).toBe(true);
    expect(existsSync(killSwitchPath(AGENT))).toBe(true);
  });

  test('clearKillSwitch removes the marker file', () => {
    killSwitch(AGENT);
    clearKillSwitch(AGENT);
    expect(isKilled(AGENT)).toBe(false);
  });

  test('clearKillSwitch is safe to call when no marker exists', () => {
    expect(() => clearKillSwitch(AGENT)).not.toThrow();
  });
});

describe('checkCap', () => {
  beforeEach(() => { _reset(); });
  afterEach(() => { _reset(); });

  test('returns ok when no cap is registered', () => {
    const r = checkCap('unregistered');
    expect(r.ok).toBe(true);
  });

  test('returns CAP_EXCEEDED when spend >= cap', () => {
    _seed({
      caps: [{ agent: 'a', cap_usd: 1.00 }],
      spend: [{ agent: 'a', spend_usd: 1.00 }],
    });
    const r = checkCap('a');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CAP_EXCEEDED');
  });

  test('returns CAP_NEAR when spend > 90% of cap', () => {
    _seed({
      caps: [{ agent: 'a', cap_usd: 1.00 }],
      spend: [{ agent: 'a', spend_usd: 0.95 }],
    });
    const r = checkCap('a');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CAP_NEAR');
  });

  test('returns ok when well below cap', () => {
    _seed({
      caps: [{ agent: 'a', cap_usd: 1.00 }],
      spend: [{ agent: 'a', spend_usd: 0.05 }],
    });
    const r = checkCap('a');
    expect(r.ok).toBe(true);
  });

  test('honors kill switch over cap calculation', () => {
    _seed({
      caps: [{ agent: 'kill-me', cap_usd: 10.00 }],
      spend: [{ agent: 'kill-me', spend_usd: 0 }],
    });
    killSwitch('kill-me');
    try {
      const r = checkCap('kill-me');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('KILL_SWITCH');
    } finally {
      clearKillSwitch('kill-me');
    }
  });

  test('disabled cap returns ok regardless of spend', () => {
    _seed({
      caps: [{ agent: 'a', cap_usd: 1.00, enabled: false }],
      spend: [{ agent: 'a', spend_usd: 99.00 }],
    });
    const r = checkCap('a');
    expect(r.ok).toBe(true);
  });
});

describe('recordSpend', () => {
  beforeEach(() => { _reset(); });
  afterEach(() => { _reset(); });

  test('accumulates spend across calls', () => {
    _seed({ caps: [{ agent: 'a', cap_usd: 5.00 }], spend: [{ agent: 'a', spend_usd: 0 }] });
    recordSpend('a', 0.10);
    recordSpend('a', 0.20);
    expect(getCachedSpend('a').spend_usd).toBeCloseTo(0.30, 6);
    expect(getCachedSpend('a').calls).toBe(2);
  });

  test('initializes a new agent on first record', () => {
    recordSpend('new-agent', 0.05);
    expect(getCachedSpend('new-agent').spend_usd).toBeCloseTo(0.05, 6);
    expect(getCachedSpend('new-agent').calls).toBe(1);
  });

  test('ignores non-numeric deltas', () => {
    recordSpend('a', 0.10);
    recordSpend('a', 'nope');
    expect(getCachedSpend('a').spend_usd).toBeCloseTo(0.10, 6);
  });
});
