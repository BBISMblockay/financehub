import test from 'node:test';
import assert from 'node:assert/strict';
import {
  plaidApiBase, safePlaidError, encryptToken, decryptToken, buildLinkTokenRequest,
  normalizeTransaction, inferAccountingTreatment, collectTransactionSync, createLinkState, verifyLinkState,
} from '../../supabase/functions/plaid-finance/plaid-core.mjs';

const transaction = (overrides = {}) => ({
  transaction_id: 'tx-1', account_id: 'account-1', amount: 19.99,
  pending: false, pending_transaction_id: null, date: '2026-09-12',
  authorized_date: '2026-09-11', iso_currency_code: 'USD', unofficial_currency_code: null,
  name: 'CORNER SHOP', merchant_name: 'Corner Shop',
  personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE' },
  ...overrides,
});
const page = (overrides = {}) => ({ added: [], modified: [], removed: [], next_cursor: 'next', has_more: false, ...overrides });
const options = { accessToken: 'secret-test-token', accountId: 'account-1', cursor: null };
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const context = { companyId: 'company-1', itemId: 'item-1', environment: 'sandbox' };

test('API hosts require an explicit supported environment', () => {
  assert.equal(plaidApiBase('sandbox'), 'https://sandbox.plaid.com');
  assert.equal(plaidApiBase('production'), 'https://production.plaid.com');
  for (const value of [null, '', undefined, 'development', 'production.evil.test', 'https://production.plaid.com']) {
    assert.throws(() => plaidApiBase(value), /invalid_environment/);
  }
});

test('error redaction never forwards provider text or arbitrary codes', () => {
  const sensitive = 'access-production-DO-NOT-LEAK';
  assert.deepEqual(safePlaidError({ code: 'ITEM_LOGIN_REQUIRED', message: sensitive }), {
    code: 'ITEM_LOGIN_REQUIRED', message: 'Reconnect this bank connection to continue syncing.',
  });
  for (const error of [new Error(sensitive), { code: sensitive, message: sensitive }, sensitive, null]) {
    assert.equal(JSON.stringify(safePlaidError(error)).includes(sensitive), false);
    assert.equal(safePlaidError(error).code, 'PLAID_REQUEST_FAILED');
  }
});

test('AES-GCM roundtrip binds company, item and environment and uses random IVs', async () => {
  const first = await encryptToken('access-sandbox-fixture', key, context);
  const second = await encryptToken('access-sandbox-fixture', key, context);
  assert.equal(first.v, 1);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(JSON.stringify(first).includes('access-sandbox-fixture'), false);
  assert.equal(await decryptToken(first, key, context), 'access-sandbox-fixture');
  for (const foreign of [{ ...context, companyId: 'company-2' }, { ...context, itemId: 'item-2' }, { ...context, environment: 'production' }]) {
    await assert.rejects(decryptToken(first, key, foreign), /token_decryption_failed/);
  }
  const altered = { ...first, ciphertext: (first.ciphertext[0] === 'A' ? 'B' : 'A') + first.ciphertext.slice(1) };
  await assert.rejects(decryptToken(altered, key, context), /token_decryption_failed/);
});

test('token key, context, version and envelope validation fail closed', async () => {
  for (const invalidKey of ['', 'not-base64', btoa('short')]) {
    await assert.rejects(encryptToken('test', invalidKey, context), /invalid_encryption_key/);
  }
  await assert.rejects(encryptToken('test', key, { ...context, companyId: '' }), /invalid_token_context/);
  await assert.rejects(encryptToken('', key, context), /invalid_access_token/);
  for (const invalid of [null, { v: 2 }, { v: 1, iv: btoa('short'), ciphertext: 'bad' }]) {
    await assert.rejects(decryptToken(invalid, key, context), /token_decryption_failed/);
  }
});

test('new Link and update mode have distinct request contracts', () => {
  const config = { userId: 'user-1', companyId: 'company-1', redirectUri: 'https://silo.example/v2/card-coding.html' };
  const initial = buildLinkTokenRequest(config);
  assert.deepEqual(initial.products, ['transactions']);
  assert.equal(initial.transactions.days_requested, 90);
  assert.deepEqual(initial.country_codes, ['US']);
  assert.equal(initial.user.client_user_id, 'company-1:user-1');
  assert.deepEqual(Object.keys(initial.account_filters).sort(), ['credit', 'depository']);
  const update = buildLinkTokenRequest({ ...config, accessToken: 'server-only-token' });
  assert.equal(update.access_token, 'server-only-token');
  assert.equal('products' in update, false);
  assert.equal('transactions' in update, false);
  assert.equal('account_filters' in update, false);
  assert.equal(update.redirect_uri, config.redirectUri);
  for (const redirectUri of ['http://silo.example/callback', 'https://silo.example/callback?a=b', 'https://silo.example/callback#x', 'https://user:pass@silo.example/callback']) {
    assert.throws(() => buildLinkTokenRequest({ ...config, redirectUri }), /invalid_redirect_uri/);
  }
  for (const daysRequested of [0, 731, 12.5, '90']) {
    assert.throws(() => buildLinkTokenRequest({ ...config, daysRequested }), /invalid_history_days/);
  }
});

test('signed Link state authenticates user, company, connection and expiry', async () => {
  const now = Date.now();
  const claims = { userId: 'user-1', companyId: 'company-1', connectionId: 'connection-1', expiresAt: now + 60000 };
  const token = await createLinkState(claims, key);
  assert.deepEqual(await verifyLinkState(token, key, { userId: claims.userId, companyId: claims.companyId, now }), claims);
  const initial = await createLinkState({ ...claims, connectionId: undefined, expiresAt: new Date(claims.expiresAt).toISOString() }, key);
  assert.equal((await verifyLinkState(initial, key, { ...claims, now })).connectionId, null);
  for (const expected of [{ userId: 'other-user', companyId: claims.companyId, now },
    { userId: claims.userId, companyId: 'other-company', now }, { ...claims, now: claims.expiresAt }]) {
    await assert.rejects(verifyLinkState(token, key, expected), /invalid_link_state/);
  }
  const [payload, signature] = token.split('.');
  const replacement = btoa(JSON.stringify({ v: 1, ...claims, connectionId: 'another-connection' })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  await assert.rejects(verifyLinkState(`${replacement}.${signature}`, key, { ...claims, now }), /invalid_link_state/);
  await assert.rejects(verifyLinkState(`${payload}.${signature.slice(0, -3)}AAA`, key, { ...claims, now }), /invalid_link_state/);
  const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
  await assert.rejects(verifyLinkState(token, otherKey, { ...claims, now }), /invalid_link_state/);
  for (const malformed of ['', 'plain', `${payload}.`, `.${signature}`, `${token}.extra`]) {
    await assert.rejects(verifyLinkState(malformed, key, { ...claims, now }), /invalid_link_state/);
  }
});

test('Link state cannot be issued with invalid identities or unbounded expiry', async () => {
  const claims = { userId: 'user-1', companyId: 'company-1', expiresAt: Date.now() + 60000 };
  for (const overrides of [{ userId: '' }, { companyId: null }, { connectionId: '' }, { expiresAt: 'nope' }, { expiresAt: Date.now() - 1000 }, { expiresAt: Date.now() + 86400000 }]) {
    await assert.rejects(createLinkState({ ...claims, ...overrides }, key), /invalid_link_state/);
  }
});

test('transaction normalization preserves sign, settled date and pending linkage', () => {
  const raw = transaction();
  const normalized = normalizeTransaction(raw, 'account-1');
  assert.equal(normalized.amount, 19.99);
  assert.equal(normalized.amount_cents, 1999);
  assert.equal(normalized.date, '2026-09-12');
  assert.equal(normalized.provider_status, 'posted');
  assert.deepEqual(normalized.raw, raw);
  assert.equal(normalizeTransaction(transaction({ amount: -35, pending: true, pending_transaction_id: 'older' }), 'account-1').amount_cents, -3500);
  assert.equal(normalizeTransaction(transaction({ pending: true }), 'account-1').provider_status, 'pending');
  assert.equal(normalizeTransaction(transaction({ amount: 35.00 }), 'account-1').amount, 35);
});

test('malformed transactions, foreign accounts and unsupported currencies are rejected', () => {
  for (const overrides of [
    { account_id: 'other-account' }, { transaction_id: '' }, { amount: NaN }, { amount: Infinity },
    { amount: '12.50' }, { amount: 0.001 }, { amount: 1e12 }, { pending: 'false' },
    { date: '2026-02-30' }, { date: '2026-9-1' }, { authorized_date: 'nope' },
    { iso_currency_code: 'EUR' }, { iso_currency_code: null }, { unofficial_currency_code: 'BTC' },
  ]) assert.throws(() => normalizeTransaction(transaction(overrides), 'account-1'));
});

test('accounting inference is conservative and never assumes bank deposits or transfers are expenses', () => {
  assert.equal(inferAccountingTreatment(transaction(), 'credit'), 'purchase');
  assert.equal(inferAccountingTreatment(transaction({ amount: -19.99 }), 'credit'), 'refund');
  for (const type of ['depository', 'bank', 'loan', undefined]) {
    assert.equal(inferAccountingTreatment(transaction(), type), 'unknown');
  }
  for (const overrides of [{ amount: 0 }, { merchant_name: null }, { personal_finance_category: null },
    { personal_finance_category: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } },
    { personal_finance_category: { primary: 'TRANSFER_IN', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER' } },
  ]) assert.equal(inferAccountingTreatment(transaction(overrides), 'credit'), 'unknown');
});

test('sync follows pages on one account stream without mutating the caller cursor', async () => {
  const calls = [];
  const request = async (path, body) => {
    calls.push({ path, body });
    return calls.length === 1
      ? page({ added: [transaction()], next_cursor: 'page-1', has_more: true })
      : page({ removed: [{ account_id: 'account-1', transaction_id: 'pending-1' }], next_cursor: 'page-2' });
  };
  const result = await collectTransactionSync({ ...options, request });
  assert.equal(result.added.length, 1);
  assert.equal(result.removed.length, 1);
  assert.equal(result.next_cursor, 'page-2');
  assert.equal(options.cursor, null);
  assert.equal('cursor' in calls[0].body, false);
  assert.equal(calls[1].body.cursor, 'page-1');
  assert.ok(calls.every(({ path, body }) => path === '/transactions/sync' && body.options.account_id === 'account-1' && body.count === 500));
});

test('pagination mutation restarts original cursor and discards the entire abandoned result', async () => {
  const cursors = [];
  const request = async (_path, body) => {
    cursors.push(body.cursor);
    if (cursors.length === 1) return page({ added: [transaction({ transaction_id: 'abandoned' })], next_cursor: 'intermediate', has_more: true });
    if (cursors.length === 2) throw Object.assign(new Error('provider detail'), { code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' });
    return page({ added: [transaction({ transaction_id: 'committed' })], next_cursor: 'final' });
  };
  const result = await collectTransactionSync({ ...options, cursor: 'original', request });
  assert.deepEqual(cursors, ['original', 'intermediate', 'original']);
  assert.deepEqual(result.added.map((tx) => tx.transaction_id), ['committed']);
});

test('mutation retry, page and update limits are bounded', async () => {
  let requests = 0;
  await assert.rejects(collectTransactionSync({ ...options, maxRestarts: 2, request: async () => {
    requests++;
    throw Object.assign(new Error('retry'), { code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' });
  } }), /sync_restart_limit/);
  assert.equal(requests, 3);
  requests = 0;
  await assert.rejects(collectTransactionSync({ ...options, maxPages: 2, request: async () => page({ next_cursor: `cursor-${++requests}`, has_more: true }) }), /sync_page_limit/);
  assert.equal(requests, 2);
  await assert.rejects(collectTransactionSync({ ...options, maxUpdates: 1, request: async () => page({ added: [transaction(), transaction({ transaction_id: 'tx-2' })] }) }), /sync_update_limit/);
});

test('sync rejects invalid inputs before issuing any provider request', async () => {
  let calls = 0;
  for (const overrides of [{ cursor: 'now' }, { cursor: 123 }, { accountId: '' }, { accessToken: '' }, { maxPages: 0 }, { maxRestarts: 20 }]) {
    await assert.rejects(collectTransactionSync({ ...options, ...overrides, request: async () => { calls++; return page(); } }));
  }
  assert.equal(calls, 0);
});

test('malformed and nonadvancing sync pages cannot appear successful', async () => {
  for (const response of [null, {}, page({ added: null }), page({ modified: {} }), page({ removed: null }),
    page({ has_more: 'false' }), page({ next_cursor: null }), page({ next_cursor: '' }),
    page({ next_cursor: 'now' }), page({ added: [transaction({ account_id: 'foreign' })] }),
    page({ removed: [{ account_id: 'foreign', transaction_id: 'tx' }] }),
    page({ removed: [{ account_id: 'account-1' }] }),
  ]) await assert.rejects(collectTransactionSync({ ...options, request: async () => response }));
  await assert.rejects(collectTransactionSync({ ...options, cursor: 'same', request: async () => page({ next_cursor: 'same', has_more: true }) }), /sync_cursor_not_advancing/);
  const unchanged = await collectTransactionSync({ ...options, cursor: 'same', request: async () => page({ next_cursor: 'same' }) });
  assert.equal(unchanged.next_cursor, 'same');
});

test('errors outside pagination mutation abort without implicit retries', async () => {
  let calls = 0;
  const error = Object.assign(new Error('secret provider response'), { code: 'ITEM_LOGIN_REQUIRED' });
  await assert.rejects(collectTransactionSync({ ...options, request: async () => { calls++; throw error; } }), (actual) => actual === error);
  assert.equal(calls, 1);
});
