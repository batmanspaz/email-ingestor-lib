// tasks.db #1407 — PR #76 review round (Sonnet+Opus+Fable). Synthetic fixtures only.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { guardDocumentDates, MIN_PLAUSIBLE_YEAR } from '../ocr.js';

const guard = (raw, fields) => guardDocumentDates({ ...fields }, raw);

describe('pre-2010 backstop boundary', () => {
  const raw = 'Patient DOB\nSome line';
  it('2009-12-31 with a DOB word is refused (pre_floor_birth_word)', () => {
    const p = guard(raw, { date: '2009-12-31' });
    expect(p.date).toBeNull();
    expect(p.date_guard).toEqual({ reason: 'pre_floor_birth_word', rejected_fields: ['date'], replaced_with: null });
  });
  it('2010-01-01 is kept by the backstop', () => {
    const p = guard(raw, { date: '2010-01-01' });
    expect(p.date).toBe('2010-01-01');
    expect(p.date_guard).toBeUndefined();
  });
});

describe('backstop no longer nulls legitimate old dates', () => {
  it('2008 receipt with a "Birthday Banner" line keeps its date', () => {
    const p = guard('PARTY STORE\nBirthday Banner 4.99\nDate: 06/01/2008\nTotal 4.99', { date: '2008-06-01' });
    expect(p.date).toBe('2008-06-01');
    expect(p.date_guard).toBeUndefined();
  });
  it('2005 record with Patient DOB keeps the "Date:"-labelled document date', () => {
    const raw = 'Patient DOB: 01/01/1980\nDate: 03/04/2005\nVisit summary';
    const p = guard(raw, { date: '2005-03-04' });
    expect(p.date).toBe('2005-03-04');
    expect(p.date_guard).toBeUndefined();
  });
  it('"Date:"-labelled day-first value is also protected', () => {
    const raw = 'Patient DOB: 01/01/1980\nDate: 25/03/2005';
    const p = guard(raw, { date: '2005-03-25' });
    expect(p.date).toBe('2005-03-25');
  });
  it('"newborn" and "born" are not birth words', () => {
    const p = guard('Newborn supplies\nBorn Free toys\n06/01/2008', { date: '2008-06-01' });
    expect(p.date).toBe('2008-06-01');
  });
});

describe('scanLabelledDates rejects independent of the backstop (post-floor DOBs)', () => {
  it.each([
    ['DOB: 12.30.2015', '2015-12-30'],
    ['DOB: December 30th, 2015', '2015-12-30'],
    ['DOB: 30-Dec-2015', '2015-12-30'],
    ['DOB: 2015-12-30', '2015-12-30'],
  ])('%s', (line, iso) => {
    const p = guard(`Patient\n${line}\nVaccine`, { date: iso });
    expect(p.date).toBeNull();
    expect(p.date_guard.reason).toBe('date_of_birth');
  });
  it('day-first DOB "30/12/2015" is rejected', () => {
    const p = guard('DOB: 30/12/2015', { date: '2015-12-30' });
    expect(p.date).toBeNull();
    expect(p.date_guard.reason).toBe('date_of_birth');
  });
  it('ambiguous "05/06/2015" blocks the d/m reading 2015-06-05', () => {
    const p = guard('DOB: 05/06/2015', { date: '2015-06-05' });
    expect(p.date).toBeNull();
  });
  it('2-digit year "DOB: 12/30/63"', () => {
    const p = guard('DOB: 12/30/63', { date: '1963-12-30' });
    expect(p.date).toBeNull();
  });
  it('leap-day DOB 02/29/2012', () => {
    const p = guard('DOB: 02/29/2012', { date: '2012-02-29' });
    expect(p.date).toBeNull();
  });
});

describe('MIN_PLAUSIBLE_YEAR parity with Python date_labels', () => {
  it('is 2010', () => expect(MIN_PLAUSIBLE_YEAR).toBe(2010));
  const py = `${homedir()}/claude/shared/lib/date_labels.py`;
  it.skipIf(!existsSync(py))('matches date_labels.MIN_PLAUSIBLE_YEAR', () => {
    const m = /^MIN_PLAUSIBLE_YEAR\s*=\s*(\d+)/m.exec(readFileSync(py, 'utf8'));
    expect(+m[1]).toBe(MIN_PLAUSIBLE_YEAR);
  });
});
