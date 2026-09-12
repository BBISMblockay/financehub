// Plaid reads feed the existing Silo ledger. Approval and QBO posting remain
// separate human actions in Card Coding and quickbooks-post-journal.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0';
import {
  plaidApiBase, safePlaidError, encryptToken, decryptToken,
  buildLinkTokenRequest, collectTransactionSync, createLinkState, verifyLinkState,
} from './plaid-core.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const env = (name: string) => Deno.env.get(name) ?? '';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json' },
});
const fail = (code: string, status = 502) => { throw Object.assign(new Error(code), { code, status }); };
const validId = (id: unknown) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
async function checked(result: any, code: string) {
  const { data, error } = await result;
  if (error || data === null || data === undefined) {
    // Only a PostgreSQL rejection proves this RPC rolled back. A transport
    // error or absent response can still have a transaction running remotely.
    throw Object.assign(new Error(code), { code, status: 502,
      databaseRejected: Boolean(error && /^[0-9A-Z]{5}$/.test(error.code ?? '')) });
  }
  return data;
}
async function updateConnection(db: any, id: string, companyId: string, values: any) {
  return checked(db.from('plaid_connections').update(values)
    .eq('id', id).eq('company_entity_id', companyId).select('id').maybeSingle(), 'connection_persist_failed');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const authorization = req.headers.get('Authorization') ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!bearer) return json({ error: 'Unauthorized' }, 401);
  const input = await req.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: 'Invalid request' }, 400);
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
  const serviceRequest = Boolean(env('SUPABASE_SERVICE_ROLE_KEY')) && bearer === env('SUPABASE_SERVICE_ROLE_KEY');
  let companyId: string;
  let userId: string | null = null;
  let account: any;
  try {
    if (serviceRequest) {
      if (input.action !== 'sync_background' || env('PLAID_BACKGROUND_SYNC_ENABLED') !== 'true') {
        return json({ error: 'Background syncing is disabled or action is not allowed' }, 403);
      }
      if (!validId(input.account_id)) return json({ error: 'Account required' }, 400);
      account = await checked(db.from('plaid_accounts').select('*').eq('id', input.account_id).maybeSingle(), 'account_not_found');
      companyId = account.company_entity_id;
    } else {
      if (input.action === 'sync_background') return json({ error: 'Service access required' }, 403);
      const { data: { user }, error } = await db.auth.getUser(bearer);
      if (error || !user) return json({ error: 'Unauthorized' }, 401);
      userId = user.id;
      const caller = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
        global: { headers: { Authorization: authorization } },
      });
      // One database snapshot binds the finance permission to its company. Two
      // separate reads can authorize A and then act on B during a company switch.
      const context = await caller.rpc('plaid_finance_context');
      if (context.error || !validId(context.data)) return json({ error: 'Finance access required for an active company' }, 403);
      companyId = context.data;
    }

    const environment = env('PLAID_ENVIRONMENT');
    const key = env('PLAID_TOKEN_ENCRYPTION_KEY');
    if (!env('PLAID_CLIENT_ID') || !env('PLAID_SECRET') || !key || !['sandbox', 'production'].includes(environment)) {
      return json({ error: 'Bank feeds have not been configured', code: 'not_configured' }, 503);
    }
    const started = Date.now();
    const request = async (path: string, body: any) => {
      if (Date.now() - started > 115_000) fail('sync_time_budget_exceeded');
      let response;
      try {
        response = await fetch(`${plaidApiBase(environment)}${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Plaid-Version': '2020-09-14' },
          body: JSON.stringify({ ...body, client_id: env('PLAID_CLIENT_ID'), secret: env('PLAID_SECRET') }),
          signal: AbortSignal.timeout(20_000), redirect: 'error',
        });
      } catch { return fail('provider_unavailable'); }
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.error_code) fail(result?.error_code || 'invalid_provider_response');
      return result;
    };
    const loadConnection = async (id: string) => {
      if (!validId(id)) fail('connection_not_found', 404);
      const connection = await checked(db.from('plaid_connections').select('*')
        .eq('id', id).eq('company_entity_id', companyId).maybeSingle(), 'connection_not_found');
      if (connection.environment !== environment) fail('environment_mismatch', 409);
      return connection;
    };
    const loadToken = async (connection: any) => {
      const secret = await checked(db.from('plaid_connection_secrets').select('token_ciphertext')
        .eq('connection_id', connection.id).eq('company_entity_id', companyId).maybeSingle(), 'token_not_found');
      return decryptToken(secret.token_ciphertext, key, { companyId, itemId: connection.item_id, environment });
    };
    const register = async (itemId: string, ciphertext: any, accounts: any[], institutionName: string) => {
      const result = await checked(db.rpc('plaid_register_connection', {
        p_company_id: companyId, p_item_id: itemId, p_environment: environment,
        p_institution_name: institutionName, p_token_ciphertext: ciphertext,
        p_accounts: accounts, p_actor_user_id: userId,
      }), 'connection_persist_failed');
      if (!result.connection_id) fail('connection_persist_failed');
      return result;
    };
    const fetchAccounts = async (token: string, itemId: string) => {
      const result = await request('/accounts/get', { access_token: token });
      if (result.item?.item_id !== itemId || !Array.isArray(result.accounts)) fail('invalid_provider_accounts');
      return result.accounts;
    };

    if (input.action === 'link_token') {
      const connection = input.connection_id ? await loadConnection(input.connection_id) : null;
      const token = connection ? await loadToken(connection) : undefined;
      const result = await request('/link/token/create', buildLinkTokenRequest({
        userId, companyId, accessToken: token, redirectUri: env('PLAID_REDIRECT_URI'),
        daysRequested: Number(env('PLAID_DAYS_REQUESTED') || 90),
      }));
      if (typeof result.link_token !== 'string' || !Number.isFinite(Date.parse(result.expiration))) fail('invalid_link_response');
      const linkState = await createLinkState({ userId, companyId, connectionId: connection?.id ?? null,
        expiresAt: result.expiration, daysRequested: connection ? null : Number(env('PLAID_DAYS_REQUESTED') || 90) }, key);
      return json({ link_token: result.link_token, link_state: linkState, environment, expires_at: result.expiration });
    }

    if (input.action === 'exchange') {
      const state = await verifyLinkState(input.link_state, key, { userId, companyId });
      if (state.connectionId || typeof input.public_token !== 'string' || input.public_token.length > 4096) {
        return json({ error: 'Invalid connection session' }, 400);
      }
      const exchanged = await request('/item/public_token/exchange', { public_token: input.public_token });
      if (typeof exchanged.item_id !== 'string' || !exchanged.item_id || typeof exchanged.access_token !== 'string') fail('invalid_exchange_response');
      const ciphertext = await encryptToken(exchanged.access_token, key, { companyId, itemId: exchanged.item_id, environment });
      const institutionName = typeof input.institution_name === 'string' ? input.institution_name.trim().slice(0, 160) : 'Bank connection';
      // Persist credentials first: accounts/get may fail after the one-use public
      // token has been exchanged. Refresh accounts can resume without reconnecting.
      let saved;
      try { saved = await register(exchanged.item_id, ciphertext, [], institutionName); }
      catch (firstSaveError: any) {
        // A lost database response may follow a committed registration. Read the
        // exact item before deciding it failed; never delete a possibly saved item.
        const existing = await db.from('plaid_connections').select('id')
          .eq('company_entity_id', companyId).eq('item_id', exchanged.item_id)
          .eq('environment', environment).maybeSingle();
        if (existing.data?.id && !existing.error) saved = { connection_id: existing.data.id };
        else {
          // Idempotent item registration can recover a transient persistence
          // failure while the exchanged credential is still in memory.
          try { saved = await register(exchanged.item_id, ciphertext, [], institutionName); }
          catch (secondSaveError: any) {
            const confirmed = await db.from('plaid_connections').select('id')
              .eq('company_entity_id', companyId).eq('item_id', exchanged.item_id)
              .eq('environment', environment).maybeSingle();
            if (!confirmed.error && confirmed.data?.id) saved = { connection_id: confirmed.data.id };
            else if (!confirmed.error && firstSaveError?.databaseRejected && secondSaveError?.databaseRejected) {
              try {
                await request('/item/remove', { access_token: exchanged.access_token });
                return json({ error: 'Connection could not be saved and was revoked. Start connecting again.', code: 'connection_save_failed' }, 503);
              } catch {
                return json({ error: 'Connection save and revocation could not be confirmed. Check this connection in Plaid before reconnecting.', code: 'connection_cleanup_unknown' }, 503);
              }
            } else {
              return json({ error: 'Connection save could not be confirmed. Reload Bank feeds before connecting again.',
                code: 'connection_save_unknown' }, 503);
            }
          }
        }
      }
      try {
        // Only signed initialization metadata may describe this Item's window.
        if (state.daysRequested != null) await updateConnection(db, saved.connection_id, companyId,
          { history_days_requested: state.daysRequested });
        const accounts = await fetchAccounts(exchanged.access_token, exchanged.item_id);
        await register(exchanged.item_id, ciphertext, accounts, institutionName);
        return json(saved);
      } catch {
        return json({ ...saved, account_refresh_required: true });
      }
    }

    if (input.action === 'refresh_accounts') {
      const connection = await loadConnection(input.connection_id);
      if (input.resume === true) {
        const state = await verifyLinkState(input.link_state, key, { userId, companyId });
        if (state.connectionId !== connection.id) return json({ error: 'Invalid repair session' }, 400);
      } else if (connection.status === 'disconnected') return json({ error: 'Use Resume syncing to reconnect this feed' }, 409);
      const token = await loadToken(connection);
      const accounts = await fetchAccounts(token, connection.item_id);
      const ciphertext = await encryptToken(token, key, { companyId, itemId: connection.item_id, environment });
      if (input.resume === true && connection.status === 'disconnected') {
        await checked(db.from('plaid_connections').update({ status: 'active', last_error_code: null })
          .eq('id', connection.id).eq('company_entity_id', companyId)
          .eq('updated_at', connection.updated_at).select('id').maybeSingle(), 'connection_changed_during_repair');
      }
      return json(await register(connection.item_id, ciphertext, accounts, connection.institution_name));
    }
    if (input.action === 'history_preview') {
      if (!validId(input.account_id)) return json({ error: 'Choose an account to preview its history.' }, 400);
      const previewAccount = await checked(db.from('plaid_accounts').select('*')
        .eq('id', input.account_id).eq('company_entity_id', companyId).maybeSingle(), 'account_not_found');
      if (Date.parse(previewAccount.sync_lease_expires_at || '') > Date.now()) return json({ error: 'A sync is running. Wait for it to finish and retry the history preview, or acknowledge unknown history when mapping.' }, 409);
      const connection = await loadConnection(previewAccount.connection_id);
      if (connection.status !== 'active') return json({ error: 'Reconnect this account before previewing history.' }, 409);
      const token = await loadToken(connection);
      // Independent read from the beginning; NEVER commit this preview cursor.
      // Fold modifications/removals so the date describes the returned live set.
      const changes = await collectTransactionSync({ request, accessToken: token,
        accountId: previewAccount.provider_account_id, cursor: null, maxUpdates: 20_000 });
      const rows = new Map();
      for (const row of [...changes.added, ...changes.modified]) rows.set(row.transaction_id, row);
      for (const row of changes.removed) rows.delete(row.transaction_id);
      const dates = [...rows.values()].map((row: any) => row.date).filter((date: any) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
      return json({ account_id: previewAccount.id, earliest_date: dates[0] || null,
        latest_date: dates.at(-1) || null, returned_count: rows.size,
        history_days_requested: connection.history_days_requested ?? null,
        checked_at: new Date().toISOString() });
    }
    if (input.action === 'disconnect') {
      const connection = await loadConnection(input.connection_id);
      await updateConnection(db, connection.id, companyId, { status: 'disconnected', last_error_code: null });
      return json({ paused: true });
    }

    if (input.action === 'sync' || input.action === 'sync_background') {
      if (!validId(input.account_id)) return json({ error: 'Account required' }, 400);
      if (!account) account = await checked(db.from('plaid_accounts').select('*')
        .eq('id', input.account_id).eq('company_entity_id', companyId).maybeSingle(), 'account_not_found');
      const connection = await loadConnection(account.connection_id);
      if (!account.source_id || connection.status === 'disconnected') return json({ error: 'Map and enable the account before syncing' }, 409);
      if (serviceRequest && connection.status !== 'active') return json({ error: 'Connection needs attention' }, 409);
      const leaseId = crypto.randomUUID();
      const claim = await checked(db.rpc('plaid_claim_sync', { p_account_id: account.id, p_lease_id: leaseId }), 'sync_claim_failed');
      try {
        if (claim.provider_account_id !== account.provider_account_id || claim.connection_id !== connection.id) fail('sync_claim_mismatch');
        const token = await loadToken(connection);
        const accounts = await fetchAccounts(token, connection.item_id);
        if (!accounts.some((entry: any) => entry.account_id === account.provider_account_id)) fail('ACCESS_NOT_GRANTED');
        const changes = await collectTransactionSync({ request, accessToken: token,
          accountId: account.provider_account_id, cursor: claim.cursor, maxUpdates: 20_000 });
        const result = await checked(db.rpc('plaid_apply_sync', {
          p_account_id: account.id, p_lease_id: leaseId, p_expected_cursor: claim.cursor,
          p_next_cursor: changes.next_cursor, p_added: changes.added, p_modified: changes.modified,
          p_removed: changes.removed, p_accounts: accounts,
        }), 'sync_persist_failed');
        return json(result);
      } catch (error) {
        const safe = safePlaidError(error);
        const release = await db.rpc('plaid_release_sync', {
          p_account_id: account.id, p_lease_id: leaseId, p_error_code: safe.code,
        });
        if (release.error) return json({ error: 'Sync could not be confirmed. Wait five minutes, then retry; the saved cursor will be reused.', code: 'sync_recovery_required' }, 503);
        throw error;
      }
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (error: any) {
    const safe = safePlaidError(error);
    return json({ error: safe.message, code: safe.code }, Number(error?.status) || 502);
  }
});
