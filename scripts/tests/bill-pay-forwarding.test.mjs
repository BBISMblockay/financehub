import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveBillPayDestination } from '../../supabase/functions/payment-request-forward-melio/destination.mjs';

test('each tenant sends to its own configured provider and inbox', () => {
  assert.deepEqual(resolveBillPayDestination({ bill_pay_provider: 'bill', bill_pay_forward_email: 'ap@bill.com' }),
    { provider: 'bill', email: 'ap@bill.com' });
  assert.deepEqual(resolveBillPayDestination({ bill_pay_provider: 'melio', bill_pay_forward_email: 'inbox@melio.com' }),
    { provider: 'melio', email: 'inbox@melio.com' });
});

test('an unconfigured or half-configured company resolves to nothing, for every company alike', () => {
  // The legacy per-company Melio fallback is gone (2026-11-13), so there is no
  // company and no argument that can produce a destination the company's own
  // settings do not name. Extra arguments are ignored rather than honoured --
  // a caller still passing the old entity key and secret gets null.
  assert.equal(resolveBillPayDestination(null), null);
  assert.equal(resolveBillPayDestination(null, 'baseballism', 'old@melio.com'), null);
  assert.equal(resolveBillPayDestination({}), null);
  assert.equal(resolveBillPayDestination({ bill_pay_provider: 'bill', bill_pay_forward_email: null }), null);
  assert.equal(resolveBillPayDestination({ bill_pay_provider: null, bill_pay_forward_email: 'ap@bill.com' }), null);
  // A blank-but-present email is not an inbox.
  assert.equal(resolveBillPayDestination({ bill_pay_provider: 'melio', bill_pay_forward_email: '   ' }), null);
  // And an unknown provider cannot smuggle one through.
  assert.equal(resolveBillPayDestination({ bill_pay_provider: 'other', bill_pay_forward_email: 'ap@x.com' }), null);
});

test('the function no longer reads the entities table or the legacy secret', async () => {
  const source = await readFile(new URL('../../supabase/functions/payment-request-forward-melio/index.ts', import.meta.url), 'utf8');
  // Code, not prose: the comment that records the removal names entity_key.
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /MELIO_FORWARD_EMAIL/);
  assert.doesNotMatch(code, /entity_key/);
  assert.doesNotMatch(code, /from\('entities'\)/);
  // One argument now: the company's own settings.
  assert.match(code, /resolveBillPayDestination\(settings\)/);
});

test('function reads the request as the caller before privileged attachment access', async () => {
  const source = await readFile(new URL('../../supabase/functions/payment-request-forward-melio/index.ts', import.meta.url), 'utf8');
  assert.match(source, /callerClient\s*\.from\('payment_requests'\)/);
  assert.doesNotMatch(source, /db\s*\.from\('payment_requests'\)\s*\.select\('\*'\)/);
});
