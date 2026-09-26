import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveBillPayDestination } from '../../supabase/functions/payment-request-forward-melio/destination.mjs';

test('each tenant sends to its own configured provider and inbox', () => {
  assert.deepEqual(resolveBillPayDestination({ bill_pay_provider: 'bill', bill_pay_forward_email: 'ap@bill.com' }, 'other', 'old@melio.com'),
    { provider: 'bill', email: 'ap@bill.com' });
  assert.deepEqual(resolveBillPayDestination({ bill_pay_provider: 'melio', bill_pay_forward_email: 'inbox@melio.com' }, 'baseballism', 'old@melio.com'),
    { provider: 'melio', email: 'inbox@melio.com' });
});

test('legacy Melio secret is available only to Baseballism and never overrides an incomplete setting', () => {
  assert.equal(resolveBillPayDestination(null, 'other', 'old@melio.com'), null);
  assert.deepEqual(resolveBillPayDestination(null, 'baseballism', 'old@melio.com'),
    { provider: 'melio', email: 'old@melio.com' });
  assert.equal(resolveBillPayDestination({ bill_pay_provider: 'bill', bill_pay_forward_email: null }, 'baseballism', 'old@melio.com'), null);
});

test('function reads the request as the caller before privileged attachment access', async () => {
  const source = await readFile(new URL('../../supabase/functions/payment-request-forward-melio/index.ts', import.meta.url), 'utf8');
  assert.match(source, /callerClient\s*\.from\('payment_requests'\)/);
  assert.doesNotMatch(source, /db\s*\.from\('payment_requests'\)\s*\.select\('\*'\)/);
});
