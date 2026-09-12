// The only QBO journal write path. Approval RPCs freeze an exact payload;
// this function claims it durably, posts it, and recovers ambiguous outcomes
// by deterministic DocNumber before any retry can reach Intuit.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  buildApprovedPayload,
  classifyPostHttpStatus,
  compareJournalEntry,
  makeDocNumber,
  qboQueryForDocNumber,
} from './posting-core.mjs';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const configuredEnv = () =>
  Deno.env.get('QBO_ENVIRONMENT') === 'production' ? 'production' : 'sandbox';
const CLIENT_ID = () => Deno.env.get('QBO_CLIENT_ID') ?? '';
const CLIENT_SECRET = () => Deno.env.get('QBO_CLIENT_SECRET') ?? '';
const apiBase = (env: string) => env === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';
const TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});
const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);

async function checkedUpdate(query: any, label: string) {
  const { data, error } = await query.select('id').maybeSingle();
  if (error) throw new Error(`${label}: ${error.message}`);
  if (!data?.id) throw new Error(`${label}: row_not_updated`);
  return data;
}

async function ensureAccessToken(supabase: any, conn: any): Promise<string> {
  const expiresAt = conn.token_expires_at ? Date.parse(conn.token_expires_at) : 0;
  if (conn.access_token && expiresAt - Date.now() > 60_000) return conn.access_token;
  if (!CLIENT_ID() || !CLIENT_SECRET()) throw new Error('QBO client credentials not configured');
  if (!conn.refresh_token) throw new Error('no_refresh_token_reconnect_required');
  if (conn.refresh_token_expires_at && Date.parse(conn.refresh_token_expires_at) < Date.now()) {
    throw new Error('refresh_token_expired_reconnect_required');
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${CLIENT_ID()}:${CLIENT_SECRET()}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: conn.refresh_token,
    }).toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`token_refresh_failed_${res.status}: ${detail.slice(0, 240)}`);
  }
  const token = await res.json();
  if (!token.access_token) throw new Error('token_refresh_returned_no_access_token');
  const now = Date.now();
  await checkedUpdate(supabase.from('quickbooks_connections').update({
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? conn.refresh_token,
    token_expires_at: new Date(now + Number(token.expires_in ?? 3600) * 1000).toISOString(),
    refresh_token_expires_at: new Date(
      now + Number(token.x_refresh_token_expires_in ?? 8726400) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', conn.id), 'token_persist_failed');
  return token.access_token;
}

async function readJournal(conn: any, token: string, id: string) {
  const res = await fetch(
    `${apiBase(conn.environment)}/v3/company/${conn.realm_id}/journalentry/${id}?minorversion=75`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  );
  if (!res.ok) return null;
  const body = await res.json();
  return body?.JournalEntry ?? null;
}

async function findByDocNumber(conn: any, token: string, docNumber: string) {
  const query = encodeURIComponent(qboQueryForDocNumber(docNumber));
  const res = await fetch(
    `${apiBase(conn.environment)}/v3/company/${conn.realm_id}/query?query=${query}&minorversion=75`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`recovery_query_failed_${res.status}`);
  const body = await res.json();
  const found = body?.QueryResponse?.JournalEntry;
  if (!found) return [];
  return Array.isArray(found) ? found : [found];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const authHeader = req.headers.get('Authorization') ?? '';
  const { data: { user }, error: authErr } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', ''));
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

  const input = await req.json().catch(() => ({}));
  const { batch_id, adjustment_id, recovery_action, recovery_note } = input;
  if ((!batch_id && !adjustment_id) || (batch_id && adjustment_id)) {
    return json({ error: 'Pass exactly one of batch_id or adjustment_id' }, 400);
  }
  if (recovery_action && recovery_action !== 'confirm_not_posted') {
    return json({ error: 'Unsupported recovery_action' }, 400);
  }
  if (recovery_action && String(recovery_note || '').trim().length < 10) {
    return json({ error: 'A specific recovery note is required' }, 400);
  }

  const asCaller = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } });
  const { data: canManage, error: permissionError } =
    await asCaller.rpc('can_manage_journal_entries');
  if (permissionError || canManage !== true) {
    return json({ error: 'Finance access required to post' }, 403);
  }
  const { data: profile, error: profileError } = await supabase.from('profiles')
    .select('active_company_id, is_active').eq('id', user.id).maybeSingle();
  if (profileError || !profile?.active_company_id || profile.is_active === false) {
    return json({ error: 'No active company' }, 403);
  }
  const companyId = profile.active_company_id;

  let parent: any;
  let parentTable: string;
  let parentId: string;
  if (batch_id) {
    const result = await supabase.from('card_import_batches')
      .select('id, status, source_id, approval_version, approval_snapshot, approval_hash, qbo_connection_id')
      .eq('id', batch_id).eq('company_entity_id', companyId).maybeSingle();
    if (result.error) return json({ error: `Could not load batch: ${result.error.message}` }, 500);
    parent = result.data; parentTable = 'card_import_batches'; parentId = batch_id;
    if (!parent) return json({ error: 'Batch not found' }, 404);
    const { data: source, error: sourceError } = await supabase.from('card_sources')
      .select('posting_enabled, qbo_connection_id').eq('id', parent.source_id)
      .eq('company_entity_id', companyId).maybeSingle();
    if (sourceError || !source) return json({ error: 'Card source not found' }, 404);
    if (!source.posting_enabled) {
      return json({ error: 'Posting is disabled for this card source' }, 409);
    }
    if (source.qbo_connection_id !== parent.qbo_connection_id) {
      return json({ error: 'Card source connection changed; reopen and approve the batch again' }, 409);
    }
  } else {
    const result = await supabase.from('journal_adjustments')
      .select('id, status, accounting_source, accounting_source_ref, approval_version, approval_snapshot, approval_hash, qbo_connection_id')
      .eq('id', adjustment_id).eq('company_entity_id', companyId).maybeSingle();
    if (result.error) {
      return json({ error: `Could not load adjustment: ${result.error.message}` }, 500);
    }
    parent = result.data; parentTable = 'journal_adjustments'; parentId = adjustment_id;
    if (!parent) return json({ error: 'Adjustment not found' }, 404);
  }

  if (parent.status === 'posted') return json({ error: 'This entry is already posted' }, 409);
  if (parent.status !== 'approved') {
    return json({ error: `Entry must be approved before posting (it is ${parent.status})` }, 409);
  }
  const snapshot = parent.approval_snapshot;
  if (!snapshot || !parent.approval_hash || !parent.qbo_connection_id) {
    return json({ error: 'This approval predates the posting controls; reopen and approve it again' }, 409);
  }
  const { data: calculatedHash, error: hashError } = await supabase
    .rpc('finance_approval_snapshot_hash', { p_snapshot: snapshot });
  if (hashError || calculatedHash !== parent.approval_hash) {
    return json({ error: 'Approved content changed after approval; reopen and approve it again' }, 409);
  }
  if (snapshot.qbo_connection_id !== parent.qbo_connection_id) {
    return json({ error: 'Approval snapshot connection does not match the approved entry' }, 409);
  }
  if (batch_id && (snapshot.source !== 'card_import' || snapshot.source_ref !== batch_id)) {
    return json({ error: 'Approval snapshot does not belong to this card batch' }, 409);
  }
  if (adjustment_id && (snapshot.source !== parent.accounting_source
      || snapshot.source_ref !== parent.accounting_source_ref)) {
    return json({ error: 'Approval snapshot does not belong to this adjustment source' }, 409);
  }

  const { data: conn, error: connError } = await supabase.from('quickbooks_connections')
    .select('id, realm_id, environment, is_active, access_token, refresh_token, token_expires_at, refresh_token_expires_at')
    .eq('id', parent.qbo_connection_id).eq('company_entity_id', companyId).maybeSingle();
  if (connError || !conn || !conn.is_active) {
    return json({ error: 'Approved QuickBooks connection is not active' }, 409);
  }
  if (conn.environment !== configuredEnv()) {
    return json({
      error: `environment_mismatch: connection is ${conn.environment}, function is ${configuredEnv()}`,
    }, 409);
  }

  const source = String(snapshot.source);
  const sourceRef = String(snapshot.source_ref);
  const docNumber = makeDocNumber(parent.approval_hash);
  let payload: any;
  try { payload = buildApprovedPayload(snapshot, docNumber); }
  catch (error) { return json({ error: errorText(error) }, 409); }

  let token: string;
  try { token = await ensureAccessToken(supabase, conn); }
  catch (error) { return json({ error: errorText(error) }, 502); }

  const activeClaim = async () => {
    const { data, error } = await supabase.from('quickbooks_journal_postings')
      .select('*').eq('company_entity_id', companyId)
      .eq('source', source).eq('source_ref', sourceRef)
      .in('status', ['submitting', 'unknown', 'posted'])
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(`posting_claim_load_failed: ${error.message}`);
    return data;
  };

  const finalize = async (
    claim: any, created: any, intuitTid: string | null, note: string | null = null,
  ) => {
    const readback = await readJournal(conn, token, String(created.Id)).catch(() => null);
    const matches = readback ? compareJournalEntry(payload, readback) : null;
    await checkedUpdate(supabase.from('quickbooks_journal_postings').update({
      status: 'posted', qbo_journal_entry_id: String(created.Id),
      qbo_doc_number: created.DocNumber ?? docNumber, readback,
      readback_matches: matches, intuit_tid: intuitTid,
      confirmed_at: new Date().toISOString(), posted_at: new Date().toISOString(),
      posted_by: user.id, error_message: null, recovery_note: note,
    }).eq('id', claim.id), 'posting_confirmation_persist_failed');
    try {
      await checkedUpdate(supabase.from(parentTable).update({
        status: 'posted', posting_id: claim.id, updated_at: new Date().toISOString(),
      }).eq('id', parentId).eq('status', 'approved').eq('approval_hash', parent.approval_hash),
      'posted_parent_persist_failed');
    } catch (error) {
      await supabase.from('quickbooks_journal_postings').update({
        recovery_note: `QBO confirmed; parent repair required: ${errorText(error)}`.slice(0, 500),
      }).eq('id', claim.id);
      throw error;
    }
    return json({
      ok: true, recovered: Boolean(note), qbo_journal_entry_id: String(created.Id),
      doc_number: created.DocNumber ?? docNumber, line_count: payload.Line.length,
      readback_matches: matches,
      warning: matches === false
        ? 'The entry exists in QuickBooks, but its lines differ from the approved snapshot.'
        : matches === null
        ? 'The entry exists in QuickBooks, but readback could not be completed.'
        : undefined,
    });
  };

  let claim: any;
  try { claim = await activeClaim(); }
  catch (error) { return json({ error: errorText(error) }, 500); }

  if (claim) {
    if (claim.connection_id !== conn.id) {
      return json({
        error: 'An active posting for this source is bound to a different QBO connection',
      }, 409);
    }
    if (claim.payload_hash !== parent.approval_hash) {
      return json({ error: 'An active posting exists for a different approval version' }, 409);
    }
    try {
      if (claim.qbo_journal_entry_id) {
        const existing = await readJournal(conn, token, claim.qbo_journal_entry_id);
        if (existing) {
          return await finalize(claim, existing, claim.intuit_tid,
            'Recovered by stored QuickBooks journal entry id.');
        }
      }
      const found = await findByDocNumber(conn, token, docNumber);
      if (found.length === 1) {
        return await finalize(claim, found[0], claim.intuit_tid,
          'Recovered by deterministic DocNumber after an ambiguous outcome.');
      }
      if (found.length > 1) {
        await checkedUpdate(supabase.from('quickbooks_journal_postings').update({
          status: 'unknown', last_attempt_at: new Date().toISOString(),
          attempt_count: Number(claim.attempt_count || 0) + 1,
          recovery_note: `Recovery found ${found.length} entries with DocNumber ${docNumber}; manual QBO review required.`,
        }).eq('id', claim.id), 'ambiguous_recovery_persist_failed');
        return json({
          error: 'Multiple QuickBooks entries share the recovery DocNumber; manual review required',
          code: 'UNKNOWN_OUTCOME',
        }, 409);
      }
      if (recovery_action !== 'confirm_not_posted') {
        await checkedUpdate(supabase.from('quickbooks_journal_postings').update({
          status: 'unknown', last_attempt_at: new Date().toISOString(),
          attempt_count: Number(claim.attempt_count || 0) + 1,
          recovery_note: `No entry found for ${docNumber}; do not retry until absence is verified in QBO.`,
        }).eq('id', claim.id), 'unknown_recovery_persist_failed');
        return json({
          error: 'Prior outcome is unknown. No matching QBO entry was found; verify it is absent, then use the recovery confirmation.',
          code: 'UNKNOWN_OUTCOME', can_confirm_absent: true, doc_number: docNumber,
        }, 409);
      }
      await checkedUpdate(supabase.from('quickbooks_journal_postings').update({
        status: 'failed', last_attempt_at: new Date().toISOString(),
        attempt_count: Number(claim.attempt_count || 0) + 1,
        recovery_note: `User confirmed absent after QBO lookup: ${String(recovery_note).trim()}`.slice(0, 500),
      }).eq('id', claim.id).in('status', ['submitting', 'unknown']), 'recovery_release_failed');
      claim = null;
    } catch (error) {
      return json({ error: errorText(error), code: 'UNKNOWN_OUTCOME' }, 502);
    }
  }

  const requestKey =
    `${source}:${sourceRef}:v${parent.approval_version}:${parent.approval_hash}`;
  const { data: newClaim, error: claimError } =
    await supabase.from('quickbooks_journal_postings').insert({
      company_entity_id: companyId, connection_id: conn.id, source, source_ref: sourceRef,
      period_start: snapshot.period_start, period_end: snapshot.period_end,
      memo: payload.PrivateNote, payload, status: 'submitting', request_key: requestKey,
      payload_hash: parent.approval_hash, attempt_count: 1,
      last_attempt_at: new Date().toISOString(), created_by: user.id, posted_by: user.id,
    }).select('*').single();
  if (claimError) {
    if ((claimError as any).code === '23505') {
      return json({
        error: 'Another posting attempt already owns this entry; retry to recover it',
        code: 'UNKNOWN_OUTCOME',
      }, 409);
    }
    return json({ error: `Could not claim the entry: ${claimError.message}` }, 500);
  }
  claim = newClaim;

  let response: Response;
  try {
    response = await fetch(
      `${apiBase(conn.environment)}/v3/company/${conn.realm_id}/journalentry?minorversion=75`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
  } catch (error) {
    const message = `network_outcome_unknown: ${errorText(error)}`;
    try {
      await checkedUpdate(supabase.from('quickbooks_journal_postings').update({
        status: 'unknown', error_message: message.slice(0, 500),
        recovery_note: `Retry will search QBO for ${docNumber} before any new post.`,
      }).eq('id', claim.id), 'unknown_outcome_persist_failed');
    } catch (persistError) {
      return json({
        error: `${message}; ${errorText(persistError)}`, code: 'UNKNOWN_OUTCOME',
      }, 502);
    }
    return json({ error: message, code: 'UNKNOWN_OUTCOME', doc_number: docNumber }, 502);
  }

  const intuitTid = response.headers.get('intuit_tid');
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const status = classifyPostHttpStatus(response.status);
    const message = `post_failed_${response.status}: ${detail.slice(0, 400)}`;
    try {
      await checkedUpdate(supabase.from('quickbooks_journal_postings').update({
        status, intuit_tid: intuitTid, error_message: message.slice(0, 500),
        recovery_note: status === 'unknown'
          ? `Retry will search QBO for ${docNumber} before any new post.` : null,
      }).eq('id', claim.id), 'post_failure_persist_failed');
    } catch (persistError) {
      return json({
        error: `${message}; ${errorText(persistError)}`,
        code: status === 'unknown' ? 'UNKNOWN_OUTCOME' : undefined,
      }, 502);
    }
    return json({
      error: message, code: status === 'unknown' ? 'UNKNOWN_OUTCOME' : undefined,
      doc_number: docNumber,
    }, 502);
  }

  let created: any;
  try { created = (await response.json())?.JournalEntry; }
  catch { created = null; }
  if (!created?.Id) {
    const message = 'QuickBooks response had no journal entry id; outcome is unknown';
    try {
      await checkedUpdate(supabase.from('quickbooks_journal_postings').update({
        status: 'unknown', intuit_tid: intuitTid, error_message: message,
        recovery_note: `Retry will search QBO for ${docNumber} before any new post.`,
      }).eq('id', claim.id), 'missing_id_outcome_persist_failed');
    } catch (persistError) {
      return json({
        error: `${message}; ${errorText(persistError)}`, code: 'UNKNOWN_OUTCOME',
      }, 502);
    }
    return json({ error: message, code: 'UNKNOWN_OUTCOME', doc_number: docNumber }, 502);
  }

  try { return await finalize(claim, created, intuitTid); }
  catch (error) {
    return json({
      error: `QuickBooks confirmed ${created.Id}, but local persistence failed: ${errorText(error)}`,
      code: 'LOCAL_PERSISTENCE_FAILURE', qbo_journal_entry_id: String(created.Id),
      doc_number: created.DocNumber ?? docNumber,
    }, 500);
  }
});
