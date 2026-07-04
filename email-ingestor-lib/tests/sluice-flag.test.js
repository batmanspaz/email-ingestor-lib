/**
 * sluice-flag.js — shared SLUICE_INTAKE resolver for every entity's producer.
 * TEST-FIRST, red before impl.
 *
 * Finding (2026-07-04, Sluice entity-cutover plan, Phase 1): SLUICE_INTAKE is
 * currently read as a bare boolean (`process.env.SLUICE_INTAKE === '1'`)
 * independently in each entity's own index.js. Since master.env is shared
 * across every entity's ingestor process, the instant a second entity's
 * producer exists and checks that same bare boolean, setting SLUICE_INTAKE=1
 * to cut personal over would ALSO switch on any other entity's producer that
 * happens to already be merged — with no way to stage a controlled,
 * single-entity rollout. This mirrors the comma-list convention SLUICE_OWN_POLL
 * already uses (see intake/src/lib/own-poll.js's shouldSkipOwnPoll).
 */

import { describe, it, expect } from 'vitest';
import { shouldRunSluiceProducer } from '../sluice-flag.js';

describe('shouldRunSluiceProducer', () => {
  it('is off by default (unset)', () => {
    expect(shouldRunSluiceProducer('personal', {})).toBe(false);
  });

  it('is off for "0"', () => {
    expect(shouldRunSluiceProducer('personal', { SLUICE_INTAKE: '0' })).toBe(false);
  });

  it('back-compat: SLUICE_INTAKE=1 means "personal only" (today\'s live behavior)', () => {
    expect(shouldRunSluiceProducer('personal', { SLUICE_INTAKE: '1' })).toBe(true);
    expect(shouldRunSluiceProducer('collagesoup', { SLUICE_INTAKE: '1' })).toBe(false);
    expect(shouldRunSluiceProducer('perfectcity', { SLUICE_INTAKE: '1' })).toBe(false);
  });

  it('a comma-list enables exactly the listed entities', () => {
    const env = { SLUICE_INTAKE: 'personal,collagesoup' };
    expect(shouldRunSluiceProducer('personal', env)).toBe(true);
    expect(shouldRunSluiceProducer('collagesoup', env)).toBe(true);
    expect(shouldRunSluiceProducer('perfectcity', env)).toBe(false);
  });

  it('trims whitespace around comma-list entries', () => {
    const env = { SLUICE_INTAKE: 'personal, collagesoup ,  perfectcity' };
    expect(shouldRunSluiceProducer('perfectcity', env)).toBe(true);
  });

  it('returns false when entityId is missing', () => {
    expect(shouldRunSluiceProducer(undefined, { SLUICE_INTAKE: '1' })).toBe(false);
  });

  it('defaults to process.env when no env arg is given', () => {
    const prev = process.env.SLUICE_INTAKE;
    process.env.SLUICE_INTAKE = 'personal';
    try {
      expect(shouldRunSluiceProducer('personal')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SLUICE_INTAKE;
      else process.env.SLUICE_INTAKE = prev;
    }
  });
});
