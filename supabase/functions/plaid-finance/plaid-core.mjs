// Provider protocol helpers shared by the Edge Function and executable tests.
// No Supabase credentials, accounting writes, or Node-only dependencies live here.
const encoder = new TextEncoder();
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

export function plaidApiBase(environment) {
  if (environment === 'sandbox') return 'https://sandbox.plaid.com';
  if (environment === 'production') return 'https://production.plaid.com';
  return fail('invalid_environment');
}

const safeErrors = new Map([
  ['ITEM_LOGIN_REQUIRED', 'Reconnect this bank connection to continue syncing.'],
  ['INVALID_ACCESS_TOKEN', 'Reconnect this bank connection to continue syncing.'],
  ['ACCESS_NOT_GRANTED', 'Reconnect this bank connection and grant access to transactions.'],
  ['ITEM_NOT_SUPPORTED', 'This bank connection does not support transaction syncing.'],
  ['INVALID_PRODUCT', 'Transactions is not enabled for this Plaid configuration.'],
  ['PRODUCT_NOT_READY', 'The bank is still preparing transactions. Sync again shortly.'],
  ['RATE_LIMIT_EXCEEDED', 'The bank connector is temporarily rate limited. Try again later.'],
  ['INSTITUTION_DOWN', 'The bank is temporarily unavailable. Try again later.'],
  ['INSTITUTION_NOT_RESPONDING', 'The bank is temporarily unavailable. Try again later.'],
  ['NO_ACCOUNTS', 'No supported bank or card accounts were shared.'],
  ['INVALID_LINK_TOKEN', 'The connection session expired. Start connecting again.'],
  ['INVALID_PUBLIC_TOKEN', 'The connection session expired. Start connecting again.'],
  ['TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 'Transactions changed while syncing. Try again shortly.'],
]);

// Provider error_message/display_message and arbitrary Error.message can contain
// financial data or credentials. Only this fixed allowlist reaches responses.
export function safePlaidError(error) {
  const code = error?.code ?? error?.error_code;
  return safeErrors.has(code)
    ? { code, message: safeErrors.get(code) }
    : { code: 'PLAID_REQUEST_FAILED', message: 'The bank connector could not complete this request. Try again or reconnect.' };
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
function fromBase64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid_base64');
  }
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (toBase64(bytes) !== value) throw new Error('invalid_base64');
  return bytes;
}

async function tokenKey(keyBase64, usage) {
  let bytes;
  try { bytes = fromBase64(keyBase64); } catch { return fail('invalid_encryption_key'); }
  if (bytes.byteLength !== 32) return fail('invalid_encryption_key');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [usage]);
}

function tokenContext({ companyId, itemId, environment } = {}) {
  if (!identifier(companyId) || !identifier(itemId) || !['sandbox', 'production'].includes(environment)) {
    return fail('invalid_token_context');
  }
  // JSON array avoids delimiter ambiguity when identifiers contain punctuation.
  return encoder.encode(JSON.stringify(['silo-plaid-token-v1', companyId, itemId, environment]));
}

/** Encrypt a server-only access token into a JSONB-safe versioned envelope. */
export async function encryptToken(token, keyBase64, context) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return fail('invalid_access_token');
  const key = await tokenKey(keyBase64, 'encrypt');
  const additionalData = tokenContext(context);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, key, encoder.encode(token));
  return { v: 1, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

/** A changed company/item/environment cannot decrypt another connection's token. */
export async function decryptToken(envelope, keyBase64, context) {
  const key = await tokenKey(keyBase64, 'decrypt');
  const additionalData = tokenContext(context);
  try {
    if (envelope?.v !== 1 || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 22000) throw new Error('envelope');
    const iv = fromBase64(envelope.iv);
    const ciphertext = fromBase64(envelope.ciphertext);
    if (iv.byteLength !== 12 || ciphertext.byteLength <= 16) throw new Error('envelope');
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, key, ciphertext);
    const token = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    if (!token || token.length > 4096) throw new Error('token');
    return token;
  } catch { return fail('token_decryption_failed'); }
}

const toBase64Url = (bytes) => toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function fromBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_base64url');
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = fromBase64(base64 + '='.repeat((4 - base64.length % 4) % 4));
  if (toBase64Url(bytes) !== value) throw new Error('invalid_base64url');
  return bytes;
}

async function linkStateKey(keyBase64) {
  let bytes;
  try { bytes = fromBase64(keyBase64); } catch { return fail('invalid_encryption_key'); }
  if (bytes.byteLength !== 32) return fail('invalid_encryption_key');
  const root = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  // Purpose separation: the AES encryption key is never directly reused as the
  // Link-state MAC key, and the derived key is never returned or persisted.
  const derived = await crypto.subtle.sign('HMAC', root, encoder.encode('silo-plaid-link-state-key-v1'));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Bind a Link operation to its initiating user/company without exposing tokens.
 * @param {{userId: string|null, companyId: string, connectionId?: string|null, expiresAt: string|number, daysRequested?: number|null}} options
 * @param {string} keyBase64
 */
export async function createLinkState({ userId, companyId, connectionId = null, expiresAt, daysRequested = null }, keyBase64) {
  const expiration = typeof expiresAt === 'string' ? Date.parse(expiresAt) : expiresAt;
  const now = Date.now();
  if (!identifier(userId) || !identifier(companyId) || (connectionId !== null && !identifier(connectionId)) || !Number.isSafeInteger(expiration) || expiration <= now || expiration > now + 4 * 60 * 60 * 1000 + 5000) return fail('invalid_link_state');
  const key = await linkStateKey(keyBase64);
  if (daysRequested !== null && (!Number.isInteger(daysRequested) || daysRequested < 1 || daysRequested > 730)) return fail('invalid_link_state');
  const payload = toBase64Url(encoder.encode(JSON.stringify({ v: 1, userId, companyId, connectionId, expiresAt: expiration, daysRequested })));
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`silo-plaid-link-state-v1.${payload}`));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Verify before exchanging or repairing; never trust a browser's company id. */
export async function verifyLinkState(token, keyBase64, { userId, companyId, now = Date.now() }) {
  const key = await linkStateKey(keyBase64);
  try {
    if (typeof token !== 'string' || token.length > 4096 || !identifier(userId) || !identifier(companyId) || !Number.isFinite(now)) throw new Error('state');
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error('state');
    const signature = fromBase64Url(parts[1]);
    if (signature.byteLength !== 32 || !await crypto.subtle.verify('HMAC', key, signature, encoder.encode(`silo-plaid-link-state-v1.${parts[0]}`))) throw new Error('signature');
    const claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(parts[0])));
    if (claims.v !== 1 || claims.userId !== userId || claims.companyId !== companyId || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= now || (claims.connectionId !== null && !identifier(claims.connectionId))) throw new Error('claims');
    return { userId: claims.userId, companyId: claims.companyId, connectionId: claims.connectionId, expiresAt: claims.expiresAt,
      ...(claims.daysRequested != null ? { daysRequested: claims.daysRequested } : {}) };
  } catch { return fail('invalid_link_state'); }
}

/** New connections initialize Transactions; ordinary update mode never does. */
export function buildLinkTokenRequest({ userId, companyId, redirectUri, clientName = 'Silo', accessToken, daysRequested = 90 }) {
  if (!identifier(userId) || !identifier(companyId) || `${companyId}:${userId}`.length > 255) return fail('invalid_link_user');
  if (typeof clientName !== 'string' || !clientName.trim() || clientName.length > 30) return fail('invalid_client_name');
  let redirect;
  try { redirect = new URL(redirectUri); } catch { return fail('invalid_redirect_uri'); }
  if (redirect.protocol !== 'https:' || redirect.search || redirect.hash || redirect.username || redirect.password) return fail('invalid_redirect_uri');
  const request = {
    user: { client_user_id: `${companyId}:${userId}` }, client_name: clientName,
    country_codes: ['US'], language: 'en', redirect_uri: redirect.href,
  };
  if (accessToken !== undefined) {
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 4096) return fail('invalid_access_token');
    return { ...request, access_token: accessToken };
  }
  if (!Number.isInteger(daysRequested) || daysRequested < 1 || daysRequested > 730) return fail('invalid_history_days');
  return {
    ...request, products: ['transactions'], transactions: { days_requested: daysRequested },
    account_filters: {
      depository: { account_subtypes: ['checking', 'savings', 'money market', 'cash management'] },
      credit: { account_subtypes: ['credit card'] },
    },
  };
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Validate provider data before passing it into the atomic ledger/cursor RPC. */
export function normalizeTransaction(raw, expectedAccountId) {
  if (!raw || !identifier(expectedAccountId) || raw.account_id !== expectedAccountId) return fail('transaction_account_mismatch');
  if (!identifier(raw.transaction_id)) return fail('invalid_transaction_id');
  if (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount) || Math.abs(raw.amount) >= 1e12) return fail('invalid_transaction_amount');
  const cents = Math.round(raw.amount * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(raw.amount - cents / 100) > Number.EPSILON * Math.max(1, Math.abs(raw.amount)) * 2) {
    return fail('invalid_transaction_amount');
  }
  if (raw.iso_currency_code !== 'USD' || raw.unofficial_currency_code != null) return fail('unsupported_transaction_currency');
  if (typeof raw.pending !== 'boolean') return fail('invalid_transaction_state');
  if (!validDate(raw.date) || (raw.authorized_date != null && !validDate(raw.authorized_date))) return fail('invalid_transaction_date');
  if (raw.pending_transaction_id != null && !identifier(raw.pending_transaction_id)) return fail('invalid_pending_transaction_id');
  if (typeof raw.name !== 'string' || !raw.name || raw.name.length > 4096 || (raw.merchant_name != null && typeof raw.merchant_name !== 'string')) return fail('invalid_transaction_description');
  return {
    transaction_id: raw.transaction_id, account_id: raw.account_id,
    pending_transaction_id: raw.pending_transaction_id ?? null, pending: raw.pending,
    date: raw.date, authorized_date: raw.authorized_date ?? null,
    amount: cents / 100, amount_cents: cents, iso_currency_code: 'USD',
    merchant_name: raw.merchant_name || null, description: raw.original_description || raw.name,
    provider_status: raw.pending ? 'pending' : 'posted', raw: structuredClone(raw),
  };
}

const purchaseCategories = new Set([
  'ENTERTAINMENT', 'FOOD_AND_DRINK', 'GENERAL_MERCHANDISE', 'GENERAL_SERVICES',
  'HOME_IMPROVEMENT', 'MEDICAL', 'PERSONAL_CARE', 'RENT_AND_UTILITIES', 'TRANSPORTATION', 'TRAVEL',
]);

/** A provider category is a suggestion, never an approval or a QBO account. */
export function inferAccountingTreatment(raw, accountType) {
  if (accountType !== 'credit' || !raw?.merchant_name || !Number.isFinite(raw.amount) || raw.amount === 0) return 'unknown';
  if (!purchaseCategories.has(raw.personal_finance_category?.primary)) return 'unknown';
  return raw.amount > 0 ? 'purchase' : 'refund';
}

/**
 * Collect a complete independent account stream; caller commits rows and cursor
 * together. No intermediate cursor leaves this function. On mutation, abandon
 * the entire cycle and restart from its original committed cursor.
 * request(path, body) returns parsed Plaid JSON and throws an Error with .code.
 * @typedef {{transaction_id: string, account_id: string, [key: string]: unknown}} SyncTransaction
 * @typedef {{added: SyncTransaction[], modified: SyncTransaction[], removed: SyncTransaction[], next_cursor: string|null}} SyncResult
 * @param {{request: Function, accessToken: string, accountId: string, cursor?: string|null, maxPages?: number, maxRestarts?: number, maxUpdates?: number}} options
 * @returns {Promise<SyncResult>}
 */
export async function collectTransactionSync({ request, accessToken, accountId, cursor = null, maxPages = 50, maxRestarts = 2, maxUpdates = 25000 }) {
  if (typeof request !== 'function' || typeof accessToken !== 'string' || !accessToken || !identifier(accountId)) return fail('invalid_sync_input');
  if (cursor !== null && (!identifier(cursor) || cursor === 'now')) return fail('invalid_sync_cursor');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000 || !Number.isInteger(maxRestarts) || maxRestarts < 0 || maxRestarts > 5 || !Number.isInteger(maxUpdates) || maxUpdates < 1 || maxUpdates > 100000) return fail('invalid_sync_limits');
  for (let restart = 0; restart <= maxRestarts; restart++) {
    let currentCursor = cursor;
    /** @type {SyncResult} */
    const result = { added: [], modified: [], removed: [], next_cursor: cursor };
    const seenCursors = new Set(cursor === null ? [] : [cursor]);
    try {
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
        const response = await request('/transactions/sync', {
          access_token: accessToken, ...(currentCursor === null ? {} : { cursor: currentCursor }),
          count: 500, options: { account_id: accountId, include_original_description: true, personal_finance_category_version: 'v2' },
        });
        if (!response || !Array.isArray(response.added) || !Array.isArray(response.modified) || !Array.isArray(response.removed) || typeof response.has_more !== 'boolean' || !identifier(response.next_cursor) || response.next_cursor === 'now') return fail('invalid_sync_page');
        for (const tx of [...response.added, ...response.modified, ...response.removed]) {
          if (!tx || tx.account_id !== accountId || !identifier(tx.transaction_id)) return fail('sync_account_mismatch');
        }
        const count = response.added.length + response.modified.length + response.removed.length;
        if (seenCursors.has(response.next_cursor) && (response.has_more || count > 0 || response.next_cursor !== currentCursor)) return fail('sync_cursor_not_advancing');
        result.added.push(...response.added);
        result.modified.push(...response.modified);
        result.removed.push(...response.removed);
        if (result.added.length + result.modified.length + result.removed.length > maxUpdates) return fail('sync_update_limit');
        result.next_cursor = response.next_cursor;
        if (!response.has_more) return result;
        seenCursors.add(response.next_cursor);
        currentCursor = response.next_cursor;
      }
      return fail('sync_page_limit');
    } catch (error) {
      if (error?.code !== 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') throw error;
      if (restart === maxRestarts) return fail('sync_restart_limit');
    }
  }
  return fail('sync_restart_limit');
}
