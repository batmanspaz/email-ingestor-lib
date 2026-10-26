/**
 * tasks.db #2546 (MEDIUM, Opus review of lib #87) — forwardEmail pasted Subject/From/To unescaped.
 * A CRLF in the original Subject could push the Auto-Submitted / X-Intake-Forwarded markers out of the
 * header block (into the body) or inject extra headers (Bcc). Fix: strip CR/LF from subject, from and
 * toAddress, and emit the marker lines FIRST so no later header value can displace them.
 */
import { describe, it, expect, vi } from 'vitest';
import { GmailClient } from '../gmail.js';

const ME = 'me@example.com';
const decodeB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');

function topHeaders(raw) {
  const head = raw.split(/\r?\n\r?\n/)[0];
  return head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).map(line => {
    const i = line.indexOf(':');
    return { name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
  });
}

async function forward({ subject, from, to }) {
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
  const raw = decodeB64url(send.mock.calls[0][0].requestBody.raw);
  return { raw, headers: topHeaders(raw) };
}

describe('#2546 forwardEmail header-injection hardening', () => {
  it('CRLF in Subject cannot inject a Bcc header or displace the markers', async () => {
    const { headers } = await forward({
      subject: 'Hi\r\nBcc: evil@attacker.example\r\n\r\nX-Intake-Forwarded: 0',
      from: 'Vendor <v@vendor.example>', to: 'shop@entity.example',
    });
    const names = headers.map(h => h.name.toLowerCase());
    expect(names).not.toContain('bcc');
    expect(headers.filter(h => h.name === 'X-Intake-Forwarded').map(h => h.value)).toEqual(['1']);
    expect(headers.filter(h => h.name === 'Auto-Submitted').map(h => h.value)).toEqual(['auto-forwarded']);
  });

  it('CRLF in From (original) and in toAddress cannot inject headers', async () => {
    const { headers } = await forward({
      subject: 'ok', from: 'a@b.example\r\nCc: evil@attacker.example', to: 'shop@entity.example\r\nBcc: evil@attacker.example',
    });
    const names = headers.map(h => h.name.toLowerCase());
    expect(names).not.toContain('bcc');
    expect(names).not.toContain('cc');
  });

  it('marker lines come BEFORE Subject (and every caller-influenced header)', async () => {
    const { headers } = await forward({ subject: 'plain', from: 'v@vendor.example', to: 'shop@entity.example' });
    const names = headers.map(h => h.name);
    expect(names[0]).toBe('Auto-Submitted');
    expect(names[1]).toBe('X-Intake-Forwarded');
    expect(names.indexOf('X-Intake-Forwarded')).toBeLessThan(names.indexOf('Subject'));
  });
});
