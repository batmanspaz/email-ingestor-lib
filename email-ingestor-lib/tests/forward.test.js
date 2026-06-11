/**
 * Unit tests for forward.js — checkAndForward()
 *
 * checkAndForward() is pure routing logic: it checks message subject/from/snippet
 * against rule patterns and forwards via client.forwardEmail() on first match.
 * No real Gmail API needed — client is fully mocked.
 */

import { describe, it, expect, vi } from 'vitest';
import { checkAndForward, compilePattern } from '../forward.js';

function makeMessage({ subject = '', from = '', snippet = '', id = 'msg-001' } = {}) {
  return {
    id,
    snippet,
    payload: {
      headers: [
        { name: 'Subject', value: subject },
        { name: 'From', value: from },
      ],
    },
  };
}

const mockClient = (resolvedValue = { ok: true }) => ({
  forwardEmail: vi.fn().mockResolvedValue(resolvedValue),
});

describe('checkAndForward — no match', () => {
  it('returns {forwarded: false} when rules is empty', async () => {
    const result = await checkAndForward(makeMessage({ subject: 'Hello' }), mockClient(), []);
    expect(result).toEqual({ forwarded: false });
  });

  it('returns {forwarded: false} when no rule pattern matches', async () => {
    const client = mockClient();
    const rules = [{ patterns: ['receipt', 'confirm'], target: 'other@example.com', label: 'receipts' }];
    const result = await checkAndForward(makeMessage({ subject: 'Invoice #123' }), client, rules);
    expect(result).toEqual({ forwarded: false });
    expect(client.forwardEmail).not.toHaveBeenCalled();
  });
});

describe('checkAndForward — match in subject', () => {
  it('forwards and returns target + rule when subject matches', async () => {
    const client = mockClient();
    const rules = [{ patterns: ['receipt'], target: 'finance@example.com', label: 'receipt-rule' }];
    const result = await checkAndForward(
      makeMessage({ subject: 'Your Receipt #456', id: 'msg-002' }), client, rules
    );
    expect(result).toEqual({ forwarded: true, target: 'finance@example.com', rule: 'receipt-rule' });
    expect(client.forwardEmail).toHaveBeenCalledWith('msg-002', 'finance@example.com');
  });
});

describe('checkAndForward — match in from/snippet', () => {
  it('matches pattern in from field', async () => {
    const client = mockClient();
    const rules = [{ patterns: ['shopify'], target: 'shop@example.com', label: 'shopify' }];
    const result = await checkAndForward(
      makeMessage({ subject: 'Hello', from: 'noreply@shopify.com' }), client, rules
    );
    expect(result.forwarded).toBe(true);
    expect(result.target).toBe('shop@example.com');
  });

  it('matches pattern in snippet', async () => {
    const client = mockClient();
    const rules = [{ patterns: ['shipped'], target: 'track@example.com', label: 'shipping' }];
    const result = await checkAndForward(
      makeMessage({ subject: 'Update', from: 'store@co.com', snippet: 'Your order has shipped' }),
      client, rules
    );
    expect(result.forwarded).toBe(true);
  });
});

describe('checkAndForward — case insensitivity', () => {
  it('matches case-insensitively in subject', async () => {
    const client = mockClient();
    const rules = [{ patterns: ['receipt'], target: 'f@example.com', label: 'r' }];
    const result = await checkAndForward(
      makeMessage({ subject: 'RECEIPT FOR YOUR ORDER' }), client, rules
    );
    expect(result.forwarded).toBe(true);
  });

  it('matches case-insensitively in from', async () => {
    const client = mockClient();
    const rules = [{ patterns: ['SHOPIFY'], target: 'f@example.com', label: 'r' }];
    const result = await checkAndForward(
      makeMessage({ from: 'noreply@shopify.com' }), client, rules
    );
    expect(result.forwarded).toBe(true);
  });
});

describe('checkAndForward — rule ordering', () => {
  it('stops at first matching rule (does not evaluate later rules)', async () => {
    const client = mockClient();
    const rules = [
      { patterns: ['receipt'], target: 'first@example.com', label: 'first' },
      { patterns: ['invoice'], target: 'second@example.com', label: 'second' },
    ];
    const result = await checkAndForward(
      makeMessage({ subject: 'receipt invoice' }), client, rules
    );
    expect(result.rule).toBe('first');
    expect(result.target).toBe('first@example.com');
    expect(client.forwardEmail).toHaveBeenCalledTimes(1);
  });

  it('matches any pattern in rule.patterns (OR logic)', async () => {
    const client = mockClient();
    const rules = [{ patterns: ['receipt', 'invoice'], target: 'finance@example.com', label: 'finance' }];
    const result = await checkAndForward(
      makeMessage({ subject: 'Invoice #789' }), client, rules
    );
    expect(result.forwarded).toBe(true);
    expect(result.rule).toBe('finance');
  });
});

describe('checkAndForward — whole-word matching', () => {
  const rucRule = [{ patterns: ['ruc'], target: 'carma@example.com', label: 'carma' }];

  it('does NOT match a pattern embedded inside a longer word', async () => {
    const client = mockClient();
    for (const subject of ['Truck delivery update', 'Read the instructions', 'A crucial fix']) {
      const result = await checkAndForward(makeMessage({ subject }), client, rucRule);
      expect(result, subject).toEqual({ forwarded: false });
    }
    expect(client.forwardEmail).not.toHaveBeenCalled();
  });

  it('still matches the pattern as a standalone word', async () => {
    const result = await checkAndForward(
      makeMessage({ subject: 'RUC pilot program update' }), mockClient(), rucRule
    );
    expect(result.forwarded).toBe(true);
  });

  it('treats punctuation as a word boundary (emails, brackets, slashes)', async () => {
    const rules = [{ patterns: ['hntb'], target: 'c@example.com', label: 'c' }];
    const result = await checkAndForward(
      makeMessage({ from: 'Jane Doe <jane@hntb.com>' }), mockClient(), rules
    );
    expect(result.forwarded).toBe(true);
  });
});

describe('compilePattern — literal patterns, not regexes', () => {
  it('escapes regex special characters', () => {
    expect(compilePattern('perfectcity.com').test('from perfectcity.com')).toBe(true);
    expect(compilePattern('perfectcity.com').test('perfectcityXcom')).toBe(false);
  });

  it('anchors boundaries only at word-character edges', () => {
    expect(compilePattern('perfect city').test('the perfect city plan')).toBe(true);
    expect(compilePattern('ruc').test('truck')).toBe(false);
    expect(compilePattern('ruc').test('(RUC)')).toBe(true);
  });
});

describe('checkAndForward — dryRun', () => {
  it('does NOT call forwardEmail when a rule matches in dry-run', async () => {
    const client = mockClient();
    const rules = [{ patterns: ['receipt'], target: 'finance@example.com', label: 'receipt-rule' }];
    const result = await checkAndForward(
      makeMessage({ subject: 'Your Receipt #456', id: 'msg-dry' }), client, rules, { dryRun: true }
    );
    expect(client.forwardEmail).not.toHaveBeenCalled();
    expect(result).toEqual({
      forwarded: true,
      target: 'finance@example.com',
      rule: 'receipt-rule',
      dryRun: true,
    });
  });

  it('returns {forwarded: false} on no match in dry-run', async () => {
    const client = mockClient();
    const rules = [{ patterns: ['receipt'], target: 'f@example.com', label: 'r' }];
    const result = await checkAndForward(
      makeMessage({ subject: 'Hello' }), client, rules, { dryRun: true }
    );
    expect(result).toEqual({ forwarded: false });
    expect(client.forwardEmail).not.toHaveBeenCalled();
  });
});

describe('checkAndForward — missing message fields', () => {
  it('handles message with no payload headers gracefully', async () => {
    const client = mockClient();
    const rules = [{ patterns: ['test'], target: 't@example.com', label: 't' }];
    const msg = { id: 'msg-empty', snippet: '' };
    // Should not throw — just no match
    const result = await checkAndForward(msg, client, rules);
    expect(result).toEqual({ forwarded: false });
  });
});
