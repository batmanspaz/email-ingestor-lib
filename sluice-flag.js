/**
 * sluice-flag.js — shared SLUICE_INTAKE resolver for every entity's producer.
 *
 * Mirrors intake's own SLUICE_OWN_POLL/shouldSkipOwnPoll comma-list
 * convention (see intake/src/lib/own-poll.js) so a second entity's producer
 * can be staged independently of personal's already-live one, instead of
 * both reading the same shared master.env boolean.
 *
 *   SLUICE_INTAKE=1            → back-compat: personal only (today's live flag)
 *   SLUICE_INTAKE=a,b,c        → enable exactly the listed entity ids
 */
export function shouldRunSluiceProducer(entityId, env = process.env) {
  const v = env.SLUICE_INTAKE;
  if (!v || !entityId) return false;
  if (v === '1') return entityId === 'personal';
  return v
    .split(',')
    .map((s) => s.trim())
    .includes(entityId);
}
