/**
 * env.js — SOC 2-isolated env loader.
 *
 * Loads from (in priority order, later overrides earlier):
 *   1. process.env (lowest — system defaults)
 *   2. ~/claude/shared/config/master.env (shared keys: Anthropic, Gmail, CF)
 *   3. <entity>.env if CARMA_ENTITY is set (per-entity overrides)
 *   4. ./.env relative to caller's cwd (project local)
 *
 * SOC 2 §10 — only declared `requires` and `optional` keys are returned. Other
 * env vars are not exposed, so an agent can't accidentally read a sibling
 * agent's secret.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadEnv({ requires = [], optional = [], entity = null } = {}) {
  const home = homedir();
  const masterPath = join(home, 'claude/shared/config/master.env');
  const entityName = entity || process.env.CARMA_ENTITY;
  const entityPath = entityName ? join(home, `claude/shared/config/${entityName}.env`) : null;
  const localPath = join(process.cwd(), '.env');

  const layered = {
    ...process.env,
    ...parseEnvFile(masterPath),
    ...(entityPath ? parseEnvFile(entityPath) : {}),
    ...parseEnvFile(localPath),
  };

  const out = {};
  const missing = [];
  for (const key of requires) {
    if (layered[key] == null || layered[key] === '') {
      missing.push(key);
    } else {
      out[key] = layered[key];
    }
  }
  for (const key of optional) {
    if (layered[key] != null && layered[key] !== '') out[key] = layered[key];
  }

  if (missing.length > 0) {
    throw new Error(`[carma-sdk/env] Missing required env: ${missing.join(', ')}`);
  }
  return out;
}
