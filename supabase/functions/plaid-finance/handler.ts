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
// How far back a date-range import looks before the newest row it already has,
// and how long a feed may deliver nothing before a sync tops itself up by date.
// Four days, because a long weekend plus a holiday can legitimately pass with
// no business-day activity; the overlap is wider because institutions post late.
const OVERLAP_DAYS = 7;
const SILENT_DAYS_BEFORE_TOP_UP = 4;
// How long an item waits between two scheduled requests to the institution to
// re-fetch. A day, because the institution answers asynchronously and the rows
// arrive through a later sync: asking again every six hours would spend the
// add-on four times over on a bank that has not finished answering the first.
const AUTO_REFRESH_COOLDOWN_HOURS = 24;
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

export async function handlePlaidFinance(req: Request) {
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

    // Ask the institution to go and fetch again. A feed can stop delivering
    // while the item stays healthy: /accounts/get keeps answering, balances
    // keep moving and /transactions/sync returns empty pages, so every check
    // we have reports success and the missing days look like a quiet week.
    // This writes nothing, touches no row and leaves the saved cursor alone --
    // the refreshed transactions arrive through the normal sync afterwards.
    // Resetting the cursor would also recover them, but a sync from an empty
    // cursor replays the whole history, and a replayed row whose merchant name
    // or Plaid category has since drifted is rewritten by
    // plaid_project_transaction, which clears its coding. Never reach for that
    // when a refresh is what is needed.
    if (input.action === 'refresh_transactions') {
      if (!validId(input.account_id)) return json({ error: 'Account required' }, 400);
      if (!account) account = await checked(db.from('plaid_accounts').select('*')
        .eq('id', input.account_id).eq('company_entity_id', companyId).maybeSingle(), 'account_not_found');
      const connection = await loadConnection(account.connection_id);
      if (!account.source_id || connection.status === 'disconnected') {
        return json({ error: 'Map and enable the account before refreshing' }, 409);
      }
      const token = await loadToken(connection);
      // A refresh outside the sync lease cannot corrupt an in-flight cycle: it
      // adds provider-side data and the next claim reads the cursor as it is.
      await request('/transactions/refresh', { access_token: token });
      return json({ account_id: account.id, requested: true });
    }

    // Import the days a stalled feed skipped, without touching anything we
    // already hold. /transactions/sync can go quiet while the item stays
    // healthy -- balances keep refreshing, the connection stays active, every
    // run reports success -- and then the cursor is the one thing standing
    // between us and days the bank is perfectly willing to hand over.
    //
    // So this does not use the cursor at all. It reads the date range directly
    // with /transactions/get, subtracts every transaction id we already have,
    // and submits only the remainder. Each one is new, so every row takes the
    // INSERT branch of plaid_project_transaction: no existing row is compared,
    // rewritten or re-coded, and the saved cursor is handed back unchanged.
    //
    // The range is computed here, not supplied by the caller: from the newest
    // transaction we hold (minus an overlap, because institutions post late)
    // through today, never earlier than the account's permanent cutover. That
    // keeps it a single button for any company, with no date to get wrong.
    const day = (value: string, shift = 0) => new Date(Date.parse(`${value}T00:00:00.000Z`) + shift * 86_400_000).toISOString().slice(0, 10);
    const today = () => new Date().toISOString().slice(0, 10);
    // No date is written into this file. The window comes from the account's
    // own data: the newest transaction it holds, backed off by an overlap
    // because institutions post late, floored at its permanent cutover so the
    // mapping promise still holds, and ending today.
    const importWindow = async (target: any) => {
      const source = await checked(db.from('card_sources').select('authoritative_from')
        .eq('id', target.source_id).eq('company_entity_id', companyId).maybeSingle(), 'source_not_found');
      const cutover = String(source.authoritative_from || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cutover)) fail('import_start_missing', 409);
      const newest = await checked(db.from('card_transactions').select('txn_date')
        .eq('company_entity_id', companyId).eq('plaid_account_id', target.id)
        .order('txn_date', { ascending: false }).limit(1).maybeSingle()
        .then((result: any) => result.error ? result : { data: result.data ?? {}, error: null }), 'newest_transaction_unreadable');
      const held = /^\d{4}-\d{2}-\d{2}$/.test(String(newest.txn_date || '')) ? String(newest.txn_date) : null;
      // An overlap only widens what is LOOKED at. Everything already held is
      // subtracted by id before anything is written, so a wider window cannot
      // change a row -- it can only find one that is missing.
      const startDate = held && day(held, -OVERLAP_DAYS) > cutover ? day(held, -OVERLAP_DAYS) : cutover;
      return { startDate, endDate: today(), held,
        // Days since the newest transaction this account holds. Never "stale"
        // for an account that has received nothing yet: that is a new mapping
        // waiting for its first sync, not a feed that stopped.
        silentDays: held ? Math.floor((Date.parse(`${today()}T00:00:00.000Z`) - Date.parse(`${held}T00:00:00.000Z`)) / 86_400_000) : null };
    };
    // Read the window straight from the bank and import only what is missing.
    // This does not use the cursor, which is the point: /transactions/sync can
    // go quiet while the item stays healthy -- balances refresh, the connection
    // stays active, every run reports success -- and the cursor becomes the one
    // thing between us and days the bank will hand over on request.
    //
    // Every submitted row is one we do not have, so each takes the INSERT
    // branch of plaid_project_transaction. No existing row is compared,
    // rewritten or re-coded, and the saved cursor is handed back unchanged.
    // Resetting the cursor would recover the same days, but a sync from an
    // empty cursor replays the whole history, and plaid_accounting_facts counts
    // the merchant name and Plaid's category -- both of which Plaid revises --
    // so every drifted row is rewritten with its coding cleared. Never do that.
    const importMissing = async ({ target, connection, token, accounts, startDate, endDate }: any) => {
      const leaseId = crypto.randomUUID();
      const claim = await checked(db.rpc('plaid_claim_sync', { p_account_id: target.id, p_lease_id: leaseId }), 'sync_claim_failed');
      try {
        if (claim.provider_account_id !== target.provider_account_id || claim.connection_id !== connection.id) fail('sync_claim_mismatch');
        const fetched = new Map<string, any>();
        for (let offset = 0; offset < 10_000; offset += 500) {
          const page = await request('/transactions/get', {
            access_token: token, start_date: startDate, end_date: endDate,
            options: { account_ids: [target.provider_account_id], count: 500, offset,
              include_original_description: true, personal_finance_category_version: 'v2' },
          });
          if (!Array.isArray(page.transactions) || !Number.isInteger(page.total_transactions)) fail('invalid_provider_transactions');
          for (const entry of page.transactions) {
            if (!entry || entry.account_id !== target.provider_account_id
              || typeof entry.transaction_id !== 'string' || !entry.transaction_id) fail('invalid_provider_transactions');
            fetched.set(entry.transaction_id, entry);
          }
          if (page.transactions.length === 0 || fetched.size >= page.total_transactions) break;
        }
        // Read what we hold AFTER fetching, so a row that landed through a
        // normal sync in the meantime is subtracted rather than resubmitted.
        const existing = new Set<string>();
        for (let from = 0; from < 20_000; from += 1000) {
          const rows = await checked(db.from('card_transactions').select('external_transaction_id')
            .eq('company_entity_id', companyId).eq('plaid_account_id', target.id)
            .order('external_transaction_id', { ascending: true }).range(from, from + 999), 'held_transactions_unreadable');
          rows.forEach((row: any) => existing.add(row.external_transaction_id));
          if (rows.length < 1000) break;
        }
        const added = [...fetched.values()].filter((entry: any) => !existing.has(entry.transaction_id));
        if (added.length > 5_000) fail('import_window_too_large');
        // The saved cursor goes back as both expected and next, so the feed's
        // own position is exactly where it was when this started.
        const applied = added.length ? await checked(db.rpc('plaid_apply_sync', {
          p_account_id: target.id, p_lease_id: leaseId, p_expected_cursor: claim.cursor,
          p_next_cursor: claim.cursor, p_added: added, p_modified: [], p_removed: [], p_accounts: accounts,
        }), 'sync_persist_failed') : await checked(db.rpc('plaid_release_sync', {
          p_account_id: target.id, p_lease_id: leaseId, p_error_code: null,
        }).then((r: any) => r.error ? r : { data: {}, error: null }), 'sync_release_failed');
        return { start_date: startDate, end_date: endDate, examined: fetched.size, imported: added.length,
          batch_ids: applied.batch_ids ?? [], exceptions: Number.isInteger(applied.exceptions) ? applied.exceptions : 0 };
      } catch (error) {
        const release = await db.rpc('plaid_release_sync', {
          p_account_id: target.id, p_lease_id: leaseId, p_error_code: safePlaidError(error).code,
        });
        if (release.error) fail('sync_recovery_required', 503);
        throw error;
      }
    };

    if (input.action === 'backfill_missing') {
      if (!validId(input.account_id)) return json({ error: 'Account required' }, 400);
      if (!account) account = await checked(db.from('plaid_accounts').select('*')
        .eq('id', input.account_id).eq('company_entity_id', companyId).maybeSingle(), 'account_not_found');
      const connection = await loadConnection(account.connection_id);
      if (!account.source_id || connection.status !== 'active') {
        return json({ error: 'Map and reconnect the account before importing missing days' }, 409);
      }
      const { startDate, endDate } = await importWindow(account);
      if (startDate > endDate) return json({ error: 'This account has no days to import' }, 409);
      const token = await loadToken(connection);
      const accounts = await fetchAccounts(token, connection.item_id);
      if (!accounts.some((entry: any) => entry.account_id === account.provider_account_id)) fail('ACCESS_NOT_GRANTED');
      return json({ account_id: account.id, ...await importMissing({ target: account, connection, token, accounts, startDate, endDate }) });
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
        // A cursor that returns nothing, for an account that has received
        // nothing in days, is the signature of a stalled feed -- and it is
        // indistinguishable from a quiet week unless we go and look by date.
        // So look, every time, for every company: read the window from the
        // bank and import only what is missing. Insert-only, cursor untouched,
        // so this is safe to do unattended on a schedule.
        //
        // Its failure is reported, never thrown: the sync above already
        // committed, and turning a successful sync into an error would lose
        // that and make a scheduled run red for a recovery attempt.
        let topUp = null;
        if (!result.added && !result.modified && !result.removed) {
          try {
            const window = await importWindow(account);
            if (window.silentDays !== null && window.silentDays >= SILENT_DAYS_BEFORE_TOP_UP && window.startDate <= window.endDate) {
              topUp = await importMissing({ target: account, connection, token, accounts,
                startDate: window.startDate, endDate: window.endDate });
            }
          } catch (error) { topUp = { failed: safePlaidError(error).code }; }
        }
        // The cursor delivered nothing AND the date-range read found nothing
        // we did not already hold. That pair is the one signature the reads
        // above cannot fix: Plaid itself does not have the days, because the
        // institution went quiet toward PLAID. No amount of asking Plaid for
        // what it has will recover that -- only /transactions/refresh makes
        // Plaid go and ask the bank. Until now that was reachable only from a
        // button, so a feed could sit stale for days with every scheduled run
        // green and no error recorded anywhere.
        //
        // The request returns before the data does: the institution fetches
        // asynchronously and the rows arrive through the NEXT ordinary sync.
        // So this kicks the feed and ends; it never waits for transactions.
        //
        // One request per item per cooldown window, stamped on the connection
        // because /transactions/refresh refreshes the whole item -- per
        // account would fire the same refresh once per mapped account. Like
        // the top-up, its failure is reported and never thrown: the sync
        // above has committed, and a recovery attempt must not make a
        // scheduled run red.
        //
        // Two other bounds, both deliberate. Only an 'active' connection is
        // kicked: a connection in 'error' or 'login_required' is fixed by a
        // person re-authorizing it, not by asking the bank for data Plaid
        // cannot currently request. And the window is read then written rather
        // than compared and set, so two accounts on one item syncing at the
        // same moment could both pass it -- worth at most one extra request
        // per item, where a compare-and-set would report a harmless lost race
        // as a failed recovery. The scheduled runner takes one account per
        // invocation in id order, so it never races itself.
        //
        // Before the migration is applied the column does not exist, the
        // stamp write is rejected, and the request is never sent: the attempt
        // is reported as a failed recovery and the sync is untouched. So the
        // migration goes first and a deploy ahead of it only keeps today's
        // behaviour.
        let refetch = null;
        if (topUp && topUp.imported === 0 && connection.status === 'active') {
          const asked = Date.parse(connection.auto_refresh_requested_at || '');
          if (!Number.isFinite(asked) || Date.now() - asked >= AUTO_REFRESH_COOLDOWN_HOURS * 3_600_000) {
            try {
              // Stamped BEFORE the call, so a refused or lost request waits
              // out the window instead of being retried every six hours. The
              // add-on is billed per call and rate-limited by Plaid.
              await updateConnection(db, connection.id, companyId, { auto_refresh_requested_at: new Date().toISOString() });
              await request('/transactions/refresh', { access_token: token });
              refetch = { requested: true };
            } catch (error) { refetch = { failed: safePlaidError(error).code }; }
          }
        }
        return json({ ...result, ...(topUp ? { top_up: topUp } : {}), ...(refetch ? { refetch } : {}) });
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
}
