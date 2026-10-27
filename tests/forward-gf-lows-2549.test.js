/**
 * tasks.db #2549 (Opus review of lib #88): (1) the #2546 tests only used CRLF — add bare CR and bare LF
 * for the header paths (Subject, To) and a body-level check for From (From appears only in the forwarded
 * body block, so a top-header check cannot catch it); (2) the MIME boundary was `boundary_${Date.now()}`
 * (guessable, collides within a ms) — must be unique per message.
 */
import { describe, it, expect, vi } from 'vitest';
import { GmailClient } from '../gmail.js';

const ME = 'me@example.com';
const decodeB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
const lines = (raw) => raw.split(/\r\n|\r|\n/);

async function forward({ subject = 'ok', from = 'v@vendor.example', to = 'shop@entity.example' } = {}) {
  const client = new GmailClient({ account: ME, refreshToken: 'rt_fake', clientId: 'cid_fake', clientSecret: 'cs_fake' });
  const send = vi.fn().mockResolvedValue({ data: { id: 'fwd-1' } });
  client._gmail = { users: { messages: {
    get: vi.fn().mockImplementation(async ({ format }) => (format === 'raw'
      ? { data: { raw: Buffer.from('From: x\r\n\r\nbody').toString('base64') } }
      : { data: { id: 'in-1', snippet: 's', payload: { headers: [
        { name: 'Subject', value: subject }, { name: 'From', value: from },
      ] } } })),
    send,
  } } };
  await client.forwardEmail('in-1', to);
  return decodeB64url(send.mock.calls[0][0].requestBody.raw);
}

const SEPS = { 'bare LF': '\n', 'bare CR': '\r' };

describe('#2549 bare CR / bare LF cannot inject headers', () => {
  for (const [name, sep] of Object.entries(SEPS)) {
    it(`${name} in Subject`, async () => {
      const raw = await forward({ subject: `Hi${sep}Bcc: evil@attacker.example` });
      expect(lines(raw).some((l) => /^Bcc:/i.test(l))).toBe(false);
    });
    it(`${name} in toAddress`, async () => {
      const raw = await forward({ to: `shop@entity.example${sep}Bcc: evil@attacker.example` });
      expect(lines(raw).some((l) => /^Bcc:/i.test(l))).toBe(false);
    });
    it(`${name} in original From (body block, not top headers)`, async () => {
      const raw = await forward({ from: `a@b.example${sep}Cc: evil@attacker.example` });
      expect(lines(raw).some((l) => /^Cc:/i.test(l))).toBe(false);
    });
  }
});

describe('#2549 MIME boundary is unique and unguessable', () => {
  const boundaryOf = (raw) => raw.match(/boundary="([^"]+)"/)[1];
  it('two forwards in the same millisecond get different boundaries', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T10:00:00Z'));
    try {
      const a = boundaryOf(await forward());
      const b = boundaryOf(await forward());
      expect(a).not.toBe(b);
    } finally { vi.useRealTimers(); }
  });
  it('boundary is not derived from the clock', async () => {
    const b = boundaryOf(await forward());
    expect(b).not.toMatch(/^boundary_\d+$/);
    expect(b.length).toBeGreaterThanOrEqual(24);
    expect(b).toMatch(/^[A-Za-z0-9_=-]+$/);
  });
});
