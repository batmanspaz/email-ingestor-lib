/**
 * caps.js — three-layer cap enforcement.
 *
 *   1. Kill switch     — existsSync('/tmp/anthropic-killswitch-<agent>')
 *   2. In-memory cache — refreshed every 30s from D1
 *   3. D1 verify       — when spend > 90% of cap, re-query before allowing
 *
 * The cache is intentionally permissive between refreshes: we'd rather let one
 * extra $0.01 call through than block on a network round-trip for every call.
 * The 90% re-verify path catches the actual cap boundary.
 */
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REFRESH_INTERVAL_MS = 30_000;

let _capsCache = new Map();       // agent → { cap_usd, soft_warn_pct, enabled }
let _spendCache = new Map();      // agent → { spend_usd, calls, errors }
let _lastRefresh = 0;
let _refreshing = null;
let _config = null;               // { workerUrl, token, refreshInterval }
let _interval = null;

export function configureCaps({ workerUrl, token, refreshInterval = REFRESH_INTERVAL_MS } = {}) {
  if (!workerUrl) throw new Error('caps: workerUrl required');
  if (!token) throw new Error('caps: token required');
  _config = { workerUrl: workerUrl.replace(/\/$/, ''), token, refreshInterval };
  if (_interval) clearInterval(_interval);
  _interval = setInterval(() => { void refreshCaps().catch(() => {}); }, _config.refreshInterval);
  if (typeof _interval.unref === 'function') _interval.unref();
}

export function killSwitchPath(agent) {
  return join(tmpdir(), `anthropic-killswitch-${agent}`);
}

export function isKilled(agent) {
  return existsSync(killSwitchPath(agent));
}

/**
 * Touch /tmp/anthropic-killswitch-<agent>. The next call from that agent will
 * throw GatewayError(KILL_SWITCH).
 */
export function killSwitch(agent) {
  writeFileSync(killSwitchPath(agent), new Date().toISOString());
}

export function clearKillSwitch(agent) {
  try { unlinkSync(killSwitchPath(agent)); }
  catch { /* not present — fine */ }
}

export async function refreshCaps() {
  if (!_config) return;
  if (_refreshing) return _refreshing;
  _refreshing = (async () => {
    try {
      const res = await fetch(`${_config.workerUrl}/api/llm/cost`, {
        headers: { 'Authorization': `Bearer ${_config.token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`refreshCaps ${res.status}`);
      const data = await res.json();
      // data.caps: [{ agent, daily_cap_usd, soft_warn_pct, enabled }]
      // data.spend: [{ agent, spend_usd, calls, errors }]
      const caps = new Map();
      const spend = new Map();
      for (const c of (data.caps || [])) {
        caps.set(c.agent, {
          cap_usd: Number(c.daily_cap_usd) || 0,
          soft_warn_pct: Number(c.soft_warn_pct) || 80,
          enabled: c.enabled !== 0 && c.enabled !== false,
        });
      }
      for (const s of (data.spend || [])) {
        spend.set(s.agent, {
          spend_usd: Number(s.spend_usd) || 0,
          calls: Number(s.calls) || 0,
          errors: Number(s.errors) || 0,
        });
      }
      _capsCache = caps;
      _spendCache = spend;
      _lastRefresh = Date.now();
    } catch (e) {
      console.warn(`[carma-sdk/caps] refresh failed: ${e?.message || 'unknown'}`);
    }
  })();
  try { await _refreshing; }
  finally { _refreshing = null; }
}

export function getCachedCap(agent) {
  return _capsCache.get(agent) || null;
}

export function getCachedSpend(agent) {
  return _spendCache.get(agent) || { spend_usd: 0, calls: 0, errors: 0 };
}

/**
 * @returns {{ ok: true } | { ok: false, code: 'KILL_SWITCH' | 'CAP_EXCEEDED' | 'CAP_NEAR', cap: number, spend: number }}
 *
 * Three-layer check. The caller is responsible for re-verifying via D1 when
 * code === 'CAP_NEAR'. If we're past the soft warning but below the hard cap
 * we return CAP_NEAR — the gateway can then call getDailySpend() to confirm.
 */
export function checkCap(agent) {
  if (isKilled(agent)) {
    return { ok: false, code: 'KILL_SWITCH', cap: 0, spend: 0 };
  }
  const cap = _capsCache.get(agent);
  if (!cap || !cap.enabled) {
    return { ok: true, code: null, cap: cap?.cap_usd || 0, spend: 0 };
  }
  const s = _spendCache.get(agent);
  const spend = s?.spend_usd || 0;
  if (spend >= cap.cap_usd) {
    return { ok: false, code: 'CAP_EXCEEDED', cap: cap.cap_usd, spend };
  }
  if (spend > cap.cap_usd * 0.9) {
    return { ok: false, code: 'CAP_NEAR', cap: cap.cap_usd, spend };
  }
  return { ok: true, code: null, cap: cap.cap_usd, spend };
}

/** Update local cache after a successful call so two consecutive calls under
 *  contention don't both pass the cap check using stale spend. */
export function recordSpend(agent, deltaUsd) {
  const cur = _spendCache.get(agent) || { spend_usd: 0, calls: 0, errors: 0 };
  _spendCache.set(agent, {
    spend_usd: cur.spend_usd + (Number(deltaUsd) || 0),
    calls: cur.calls + 1,
    errors: cur.errors,
  });
}

export function _reset() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  _capsCache = new Map();
  _spendCache = new Map();
  _config = null;
  _lastRefresh = 0;
  _refreshing = null;
}

export function _seed({ caps = [], spend = [] } = {}) {
  for (const c of caps) {
    _capsCache.set(c.agent, {
      cap_usd: c.cap_usd ?? c.daily_cap_usd ?? 0,
      soft_warn_pct: c.soft_warn_pct ?? 80,
      enabled: c.enabled !== false && c.enabled !== 0,
    });
  }
  for (const s of spend) {
    _spendCache.set(s.agent, {
      spend_usd: s.spend_usd || 0,
      calls: s.calls || 0,
      errors: s.errors || 0,
    });
  }
}
