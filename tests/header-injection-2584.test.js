/**
 * tasks.db #2584 — createDraft (and sendEmail, same pattern) pasted to/cc/bcc/subject/inReplyTo/references
 * straight into RFC 5322 header lines. A CR/LF (or another line-breaking control char) in any of them ends
 * the header line early: it can inject headers (Bcc) or end the header block and turn the rest into body.
 * Live callers: intake scripts/draft-reply.js:349 calls createDraft (relative import of the shared checkout);
 * forwardEmail is called from shared/forward.js:55 and collagesoup/src/accounts.js:143.
 *
 * Contract:
 *  - free-text headers (Subject, In-Reply-To, References): line-breaking chars are collapsed to a space.
 *  - recipient headers (To, Cc, Bcc): a line-breaking char is REJECTED (throws, nothing is sent/drafted).
 *    Stripping is not enough there: "a@b\r\nBcc: evil@x" -> "a@b Bcc: evil@x" still names the attacker's
 *    address on the recipient line, which a lenient parser can deliver to.
 *  - line-breaking chars = CR, LF, NUL, VT, FF, NEL (U+0085), LS (U+2028), PS (U+2029).
 *  - forwardEmail's forwarded_to returns the sanitized address it actually used, not the raw input.
 */
import { describe, it, expect, vi } from 'vitest';
import { GmailClient, sanitizeHeaderValue } from '../gmail.js';
import * as lib from '../index.js';

const ME = 'me@example.com';
const decodeB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');

function headerBlock(raw) {
  // Split ONLY on the CRLF the builder itself emits; any other break char is a defect we want visible.
  return raw.split('\r\n\r\n')[0].split('\r\n');
}

function makeClient() {
  const client = new GmailClient({ account: ME, refreshToken: 'rt_fake', clientId: 'cid_fake', clientSecret: 'cs_fake' });
  const draftsCreate = vi.fn().mockResolvedValue({ data: { id: 'd1', message: { threadId: 't1' } } });
  const send = vi.fn().mockResolvedValue({ data: { id: 's1' } });
  client._gmail = { users: { drafts: { create: draftsCreate }, messages: { send } } };
  return { client, draftsCreate, send };
}

async function draftRaw(opts) {
  const { client, draftsCreate } = makeClient();
  await client.createDraft({ to: 'r@example.com', subject: 'S', body: 'B', ...opts });
  return decodeB64url(draftsCreate.mock.calls[0][0].requestBody.message.raw);
}

async function sendRaw(opts) {
  const { client, send } = makeClient();
  await client.sendEmail({ to: 'r@example.com', subject: 'S', body: 'B', ...opts });
  return decodeB64url(send.mock.calls[0][0].requestBody.raw);
}

const BREAKS = {
  CRLF: '\r\n', 'bare LF': '\n', 'bare CR': '\r', NUL: '\0', VT: '\v', FF: '\f',
  NEL: '\u0085', LS: '\u2028', PS: '\u2029',
};
const BAD = /[\r\n\0\v\f\u0085\u2028\u2029]/;

describe('#2584 createDraft free-text headers: line breaks collapse, no injection', () => {
  for (const field of ['subject', 'inReplyTo', 'references']) {
    for (const [name, sep] of Object.entries(BREAKS)) {
      it(`${name} in ${field}`, async () => {
        const raw = await draftRaw({ [field]: `<x@y>${sep}Bcc: evil@attacker.example${sep}${sep}injected body` });
        const head = headerBlock(raw);
        expect(head.some((l) => /^bcc:/i.test(l))).toBe(false);
        for (const l of head) expect(l).not.toMatch(BAD);
        // header block still ends with our own Content-Type/MIME-Version, i.e. it was not cut short
        expect(head).toContain('MIME-Version: 1.0');
        expect(raw.split('\r\n\r\n').slice(1).join('\r\n\r\n')).toBe('B');
      });
    }
  }

  it('keeps the visible text of a sanitized subject', async () => {
    const raw = await draftRaw({ subject: 'Invoice\r\n42' });
    expect(headerBlock(raw)).toContain('Subject: Invoice 42');
  });
});

// Found while writing the tests above: `lines.filter(Boolean)` also dropped the '' header/body separator,
// so the body was glued onto the header block — a body line "Bcc: x" WAS a header. Both builders.
describe('#2584 the blank header/body separator survives (body cannot become headers)', () => {
  const body = 'Bcc: evil@attacker.example\r\nhello';
  it('createDraft', async () => {
    const raw = await draftRaw({ body });
    expect(headerBlock(raw).some((l) => /^bcc:/i.test(l))).toBe(false);
    expect(raw.endsWith(`MIME-Version: 1.0\r\n\r\n${body}`)).toBe(true);
  });
  it('sendEmail', async () => {
    const raw = await sendRaw({ body });
    expect(headerBlock(raw).some((l) => /^bcc:/i.test(l))).toBe(false);
    expect(raw.endsWith(`\r\n\r\n${body}`)).toBe(true);
  });
});

describe('#2584 createDraft recipient headers: line breaks are rejected', () => {
  for (const field of ['to', 'cc']) {
    for (const [name, sep] of Object.entries(BREAKS)) {
      it(`${name} in ${field} (string) throws and creates no draft`, async () => {
        const { client, draftsCreate } = makeClient();
        await expect(client.createDraft({
          to: 'r@example.com', subject: 'S', body: 'B', [field]: `ok@example.com${sep}Bcc: evil@attacker.example`,
        })).rejects.toThrow(new RegExp(field, 'i'));
        expect(draftsCreate).not.toHaveBeenCalled();
      });
    }
    it(`line break inside one element of a ${field} array throws`, async () => {
      const { client, draftsCreate } = makeClient();
      await expect(client.createDraft({
        to: 'r@example.com', subject: 'S', body: 'B', [field]: ['a@example.com', 'b@example.com\nBcc: evil@attacker.example'],
      })).rejects.toThrow(new RegExp(field, 'i'));
      expect(draftsCreate).not.toHaveBeenCalled();
    });
  }

  it('the error does not echo the raw value (no attacker text in logs)', async () => {
    const { client } = makeClient();
    const err = await client.createDraft({ to: 'a@example.com\r\nBcc: evil@attacker.example', subject: 'S', body: 'B' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain('evil@attacker.example');
  });

  it('clean recipients still work (string and array)', async () => {
    const raw = await draftRaw({ to: ['a@example.com', 'B <b@example.com>'], cc: 'c@example.com' });
    const head = headerBlock(raw);
    expect(head).toContain('To: a@example.com, B <b@example.com>');
    expect(head).toContain('Cc: c@example.com');
  });
});

describe('#2584 sendEmail has the same hardening', () => {
  it('CRLF in subject cannot inject a Bcc header', async () => {
    const raw = await sendRaw({ subject: 'Hi\r\nBcc: evil@attacker.example' });
    expect(headerBlock(raw).some((l) => /^bcc:/i.test(l))).toBe(false);
  });
  for (const field of ['to', 'cc', 'bcc']) {
    it(`line break in ${field} throws and sends nothing`, async () => {
      const { client, send } = makeClient();
      await expect(client.sendEmail({
        to: 'r@example.com', subject: 'S', body: 'B', [field]: `ok@example.com\nBcc: evil@attacker.example`,
      })).rejects.toThrow(new RegExp(field, 'i'));
      expect(send).not.toHaveBeenCalled();
    });
  }
});

describe('#2584 forwardEmail emits a sanitized To line', () => {
  it('the To header actually sent (not just the return value) has no line break', async () => {
    const client = new GmailClient({ account: ME, refreshToken: 'rt_fake', clientId: 'cid_fake', clientSecret: 'cs_fake' });
    const send = vi.fn().mockResolvedValue({ data: { id: 'fwd-1' } });
    client._gmail = { users: { messages: {
      get: vi.fn().mockImplementation(async ({ format }) => (format === 'raw'
        ? { data: { raw: Buffer.from('From: x\r\n\r\nbody').toString('base64') } }
        : { data: { id: 'in-1', snippet: 's', payload: { headers: [{ name: 'Subject', value: 's' }] } } })),
      send,
    } } };
    await client.forwardEmail('in-1', 'shop@entity.example\r\nBcc: evil@attacker.example');
    const raw = decodeB64url(send.mock.calls[0][0].requestBody.raw);
    const head = headerBlock(raw);
    expect(head.some((l) => /^bcc:/i.test(l))).toBe(false);
    const toLines = head.filter((l) => /^to:/i.test(l));
    expect(toLines).toHaveLength(1);
    expect(toLines[0]).not.toMatch(BAD);
  });
});

describe('#2584 forwardEmail returns the address it actually used', () => {
  it('forwarded_to is the sanitized address, not the raw input', async () => {
    const client = new GmailClient({ account: ME, refreshToken: 'rt_fake', clientId: 'cid_fake', clientSecret: 'cs_fake' });
    client._gmail = { users: { messages: {
      get: vi.fn().mockImplementation(async ({ format }) => (format === 'raw'
        ? { data: { raw: Buffer.from('From: x\r\n\r\nbody').toString('base64') } }
        : { data: { id: 'in-1', snippet: 's', payload: { headers: [{ name: 'Subject', value: 's' }] } } })),
      send: vi.fn().mockResolvedValue({ data: { id: 'fwd-1' } }),
    } } };
    const res = await client.forwardEmail('in-1', 'shop@entity.example\r\n');
    expect(res.forwarded_to).not.toMatch(BAD);
    expect(res.forwarded_to).toBe('shop@entity.example');
  });
});

describe('#2584 one exported helper replaces the local oneLine lambdas', () => {
  it('sanitizeHeaderValue collapses every line-breaking char run to one space', () => {
    expect(sanitizeHeaderValue('a\r\nb\nc\rd\0e\vf\fg\u0085h\u2028i\u2029j')).toBe('a b c d e f g h i j');
    expect(sanitizeHeaderValue(null)).toBe('');
    expect(sanitizeHeaderValue(undefined)).toBe('');
    expect(sanitizeHeaderValue(42)).toBe('42');
  });
  it('is re-exported from the package entry point', () => {
    expect(lib.sanitizeHeaderValue).toBe(sanitizeHeaderValue);
  });
});
