/**
 * models.js — the one place this library names Claude model ids
 * (tasks.db #2536; dev-rules.md Rule 12 / §7).
 *
 * Call sites resolve an alias (haiku / sonnet / opus), never a raw id. The
 * data authority for alias -> id is @hx/model-config
 * (~/developer/shared/harness/packages/model-config); @paul/anthropic-gateway
 * mirrors it. Neither is a dependency of this library: model-config is a
 * private TypeScript workspace package in another repo, and this lib is
 * consumed by the personal / perfectcity / collagesoup ingestors and intake
 * through a pinned git SHA. So the three aliases are mirrored by hand here
 * (same approach as collagesoup's packages/adapters/src/vision.ts), and
 * tests/ocr-model-alias-2536.test.js checks this mirror against model-config
 * whenever a harness checkout is on disk. On a model change: update
 * model-config first, then this map, then bump the lib SHA in consumers.
 */

export const MODEL_ALIASES = Object.freeze({
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
});

/** Resolve an alias to its pinned model id. Throws on anything else, including a raw id. */
export function resolveModelAlias(alias) {
  const id = Object.hasOwn(MODEL_ALIASES, alias) ? MODEL_ALIASES[alias] : undefined;
  if (!id) throw new Error(`unknown model alias: ${String(alias)}`);
  return id;
}
