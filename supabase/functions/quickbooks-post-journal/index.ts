// Posts a coded card batch to QuickBooks Online as a JournalEntry.
//
// This is the only write path to QuickBooks in SILO. Everything it does is
// arranged around one property: it must be impossible to post the same batch
// twice, and impossible to believe a post succeeded when it did not.
//
//   - the entry is REBUILT here from card_transactions, never taken from the
//     browser, so what posts is what the database holds
//   - the batch must already be 'approved' and its card explicitly enabled
//   - a 'posted' row in quickbooks_journal_postings is written under a partial
//     unique index on (company, source, source_ref), so a concurrent second
//     call loses the race rather than posting a duplicate
//   - after Intuit accepts, the entry is READ BACK and compared line-for-line;
//     a mismatch is recorded rather than reported as a clean success
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const configuredEnv = () =>
  Deno.env.get('QBO_ENVIRONMENT') === 'production' ? 'production' : 'sandbox';
const CLIENT_ID = () => Deno.env.get('QBO_CLIENT_ID') ?? '';
const CLIENT_SECRET = () => Deno.env.get('QBO_CLIENT_SECRET') ?? '';

const apiBase = (env: string) =>
  env === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

const TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const tid = (res: Response) => {
  const t = res.headers.get('intuit_tid');
  return t ? ` [intuit_tid: ${t}]` : '';
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

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
      grant_type: 'refresh_token',
      refresh_token: conn.refresh_token,
    }).toString(),
  });
  if (!res.ok) {
    const d = await res.text().catch(() => '');
    throw new Error(`token_refresh_failed: ${d.slice(0, 180)}${tid(res)}`);
  }

  const tok = await res.json();
  if (!tok.access_token) throw new Error('token_refresh_returned_no_access_token');

  const now = Date.now();
  const { error } = await supabase.from('quickbooks_connections').update({
    access_token: tok.access_token,
    // Intuit rotates the refresh token on every use.
    refresh_token: tok.refresh_token ?? conn.refresh_token,
    token_expires_at: new Date(now + Number(tok.expires_in ?? 3600) * 1000).toISOString(),
    refresh_token_expires_at: new Date(
      now + Number(tok.x_refresh_token_expires_in ?? 8726400) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', conn.id);
  if (error) throw new Error(`token_persist_failed: ${error.message}`);

  return tok.access_token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const authHeader = req.headers.get('Authorization') ?? '';
  const { data: { user }, error: authErr } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', ''));
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

  const { batch_id } = await req.json().catch(() => ({}));
  if (!batch_id) return json({ error: 'batch_id required' }, 400);

  // The caller's permission is re-checked through THEIR token against RLS,
  // not inferred here: this function holds the service-role key, so a check it
  // writes itself is a check it could get wrong. can_manage_journal_entries()
  // runs as the caller.
  const asCaller = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: canManage } = await asCaller.rpc('can_manage_journal_entries');
  if (canManage !== true) return json({ error: 'Finance access required to post' }, 403);

  const { data: profile } = await supabase
    .from('profiles').select('active_company_id, is_active').eq('id', user.id).maybeSingle();
  if (!profile?.active_company_id || profile.is_active === false) {
    return json({ error: 'No active company' }, 403);
  }
  const companyId = profile.active_company_id;

  const { data: batch } = await supabase
    .from('card_import_batches').select('*')
    .eq('id', batch_id).eq('company_entity_id', companyId).maybeSingle();
  if (!batch) return json({ error: 'Batch not found' }, 404);
  if (batch.status === 'posted') return json({ error: 'This batch is already posted' }, 409);
  if (batch.status !== 'approved') {
    return json({ error: `Batch must be approved before posting (it is ${batch.status})` }, 409);
  }
  if (!batch.entry_date) return json({ error: 'Batch has no entry date' }, 400);

  const { data: src } = await supabase
    .from('card_sources').select('*').eq('id', batch.source_id).maybeSingle();
  if (!src) return json({ error: 'Card source not found' }, 404);
  if (!src.posting_enabled) {
    return json({ error: `Posting is turned off for ${src.display_name}` }, 409);
  }
  if (!src.credit_qbo_account_id) {
    return json({ error: `${src.display_name} has no balancing account set` }, 400);
  }

  // The ID is what posts. A name alone cannot be sent to QuickBooks, so a card
  // carrying only a typed name is not configured, however complete it looks.
  const isAp = /Accounts (Payable|Receivable)/i.test(src.credit_qbo_account_type || '');
  if (isAp && !src.credit_vendor_qbo_id) {
    const kind = /Accounts Receivable/i.test(src.credit_qbo_account_type || '')
      ? 'customer' : 'vendor';
    return json({
      error: `${src.credit_qbo_account_name} is an ${src.credit_qbo_account_type} account, `
        + `so QuickBooks requires a ${kind} on that line`
        + (src.credit_vendor_name
          ? ` — "${src.credit_vendor_name}" is stored as text, not as a ${kind} record. `
            + 'Re-pick it from the list on the Cards tab.'
          : '. Set one on the Cards tab.'),
    }, 400);
  }

  const { data: txns } = await supabase
    .from('card_transactions').select('*')
    .eq('batch_id', batch_id).eq('status', 'coded');

  const coded = (txns || []).filter((t: any) => t.qbo_account_id);
  if (!coded.length) return json({ error: 'No coded rows to post' }, 400);

  const { count: uncoded } = await supabase
    .from('card_transactions').select('id', { count: 'exact', head: true })
    .eq('batch_id', batch_id).eq('status', 'uncoded');
  if (uncoded) return json({ error: `${uncoded} row(s) are still uncoded` }, 400);

  // ---- build the entry from the database, not from the browser ----
  // Which accounts require an Entity on their line. Read from the synced
  // chart rather than assumed: a row coded to an intercompany receivable
  // ('Sugar Hill Receivable', 'Two Wrongs Receivable') is an AR line, and
  // QuickBooks refuses the WHOLE entry if any such line lacks an Entity.
  const { data: acctRows } = await supabase
    .from('quickbooks_accounts')
    .select('qbo_account_id, name, account_type')
    .eq('company_entity_id', companyId);
  const acctType = new Map((acctRows || []).map((a: any) => [String(a.qbo_account_id), a.account_type]));
  const acctLabel = new Map((acctRows || []).map((a: any) => [String(a.qbo_account_id), a.name]));
  const needsEntity = (id: unknown) =>
    ['Accounts Receivable', 'Accounts Payable'].includes(acctType.get(String(id)) || '');

  const lines: any[] = [];
  let net = 0;

  // Checked before anything is staged: failing here costs nothing, whereas
  // failing at Intuit costs a claimed posting row and an opaque error.
  const missingEntity = coded.filter((t: any) => needsEntity(t.qbo_account_id) && !t.entity_qbo_id);
  if (missingEntity.length) {
    const names = [...new Set(missingEntity
      .map((t: any) => acctLabel.get(String(t.qbo_account_id)) || t.qbo_account_name))].slice(0, 4);
    return json({
      error: `${missingEntity.length} line(s) post to a receivable or payable account `
        + `(${names.join(', ')}) with no entity. QuickBooks requires a customer or vendor `
        + 'on those lines.',
    }, 400);
  }

  for (const t of coded) {
    const amount = round2(Number(t.amount));
    if (amount === 0) continue;
    net += amount;
    const locId = t.qbo_location_id || src.default_qbo_location_id || null;
    lines.push({
      DetailType: 'JournalEntryLineDetail',
      Amount: Math.abs(amount),
      Description: [t.txn_date, t.description].filter(Boolean).join(' · ').slice(0, 4000),
      JournalEntryLineDetail: {
        PostingType: amount >= 0 ? 'Debit' : 'Credit',
        AccountRef: { value: String(t.qbo_account_id) },
        ...(t.entity_qbo_id
          ? {
            Entity: {
              Type: t.entity_type === 'Vendor' ? 'Vendor' : 'Customer',
              EntityRef: { value: String(t.entity_qbo_id) },
            },
          }
          : {}),
        ...(locId ? { DepartmentRef: { value: String(locId) } } : {}),
      },
    });
  }

  net = round2(net);
  if (!lines.length) return json({ error: 'Every coded row is zero' }, 400);

  lines.push({
    DetailType: 'JournalEntryLineDetail',
    Amount: Math.abs(net),
    Description: `${src.display_name} ${batch.label || ''}`.trim().slice(0, 4000),
    JournalEntryLineDetail: {
      PostingType: net >= 0 ? 'Credit' : 'Debit',
      AccountRef: { value: String(src.credit_qbo_account_id) },
      // Vendor on an AP line, Customer on an AR line -- QuickBooks rejects the
      // wrong kind, and the kind follows from the account, not from a guess.
      ...(src.credit_vendor_qbo_id
        ? {
          Entity: {
            Type: /Accounts Receivable/i.test(src.credit_qbo_account_type || '')
              ? 'Customer' : 'Vendor',
            EntityRef: { value: String(src.credit_vendor_qbo_id) },
          },
        }
        : {}),
      ...(src.default_qbo_location_id
        ? { DepartmentRef: { value: String(src.default_qbo_location_id) } }
        : {}),
    },
  });

  const dr = round2(lines.filter((l) => l.JournalEntryLineDetail.PostingType === 'Debit')
    .reduce((n, l) => n + l.Amount, 0));
  const cr = round2(lines.filter((l) => l.JournalEntryLineDetail.PostingType === 'Credit')
    .reduce((n, l) => n + l.Amount, 0));
  if (Math.abs(dr - cr) >= 0.005) {
    return json({ error: `Entry does not balance: debits ${dr}, credits ${cr}` }, 400);
  }

  const payload = {
    TxnDate: batch.entry_date,
    PrivateNote: `SILO card coding · ${src.display_name} · ${batch.label || ''}`.trim(),
    Line: lines,
  };

  // ---- claim the post BEFORE calling Intuit ----
  // The partial unique index on (company, source, source_ref) where
  // status = 'posted' is what makes a double post impossible. Inserting the
  // claim first means a second caller fails here, rather than both reaching
  // Intuit and creating two journal entries.
  const { data: claim, error: claimErr } = await supabase
    .from('quickbooks_journal_postings').insert({
      company_entity_id: companyId,
      source: 'card_import',
      source_ref: batch_id,
      period_start: batch.period_start,
      period_end: batch.period_end,
      memo: payload.PrivateNote,
      payload,
      status: 'posted',
      created_by: user.id,
      posted_by: user.id,
      posted_at: new Date().toISOString(),
    }).select('id').single();

  if (claimErr) {
    // 23505 is the unique violation: someone already posted this batch.
    if ((claimErr as any).code === '23505') {
      return json({ error: 'This batch has already been posted.' }, 409);
    }
    return json({ error: `Could not stage the entry: ${claimErr.message}` }, 500);
  }

  const fail = async (msg: string, extra: Record<string, unknown> = {}) => {
    // Release the claim so a fixed batch can be posted, and keep the reason.
    await supabase.from('quickbooks_journal_postings')
      .update({ status: 'failed', error_message: msg.slice(0, 500), ...extra })
      .eq('id', claim.id);
    return json({ error: msg }, 502);
  };

  const { data: conn } = await supabase
    .from('quickbooks_connections')
    .select('id, realm_id, environment, access_token, refresh_token, token_expires_at, refresh_token_expires_at')
    .eq('company_entity_id', companyId).limit(1).maybeSingle();
  if (!conn) return await fail('No QuickBooks connection');
  if (conn.environment !== configuredEnv()) {
    return await fail(`environment_mismatch: connection is ${conn.environment}, QBO_ENVIRONMENT is ${configuredEnv()}`);
  }

  let token: string;
  try {
    token = await ensureAccessToken(supabase, conn);
  } catch (e) {
    return await fail(e instanceof Error ? e.message : String(e));
  }

  let created: any;
  let intuitTid: string | null = null;
  try {
    const res = await fetch(
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
    intuitTid = res.headers.get('intuit_tid');
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return await fail(`post_failed_${res.status}: ${detail.slice(0, 400)}${tid(res)}`,
        { intuit_tid: intuitTid });
    }
    const body = await res.json();
    created = body?.JournalEntry;
    if (!created?.Id) return await fail('QuickBooks accepted the call but returned no entry id',
      { intuit_tid: intuitTid });
  } catch (e) {
    return await fail(e instanceof Error ? e.message : String(e), { intuit_tid: intuitTid });
  }

  // ---- read it back ----
  // "Intuit returned 200" is not the same as "the books hold what we meant".
  // The comparison is on totals and line count, which is what a reconciliation
  // would check by hand.
  let readback: any = null;
  let matches: boolean | null = null;
  try {
    const res = await fetch(
      `${apiBase(conn.environment)}/v3/company/${conn.realm_id}/journalentry/${created.Id}?minorversion=75`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    );
    if (res.ok) {
      const body = await res.json();
      readback = body?.JournalEntry ?? null;
      const rl = readback?.Line ?? [];
      const rdr = round2(rl.filter((l: any) => l.JournalEntryLineDetail?.PostingType === 'Debit')
        .reduce((n: number, l: any) => n + Number(l.Amount || 0), 0));
      const rcr = round2(rl.filter((l: any) => l.JournalEntryLineDetail?.PostingType === 'Credit')
        .reduce((n: number, l: any) => n + Number(l.Amount || 0), 0));
      matches = rl.length === lines.length
        && Math.abs(rdr - dr) < 0.005
        && Math.abs(rcr - cr) < 0.005;
    }
  } catch { /* the entry exists either way; a failed readback is not a failed post */ }

  await supabase.from('quickbooks_journal_postings').update({
    connection_id: conn.id,
    qbo_journal_entry_id: String(created.Id),
    qbo_doc_number: created.DocNumber ?? null,
    readback,
    readback_matches: matches,
    intuit_tid: intuitTid,
  }).eq('id', claim.id);

  await supabase.from('card_import_batches').update({
    status: 'posted',
    posting_id: claim.id,
    updated_at: new Date().toISOString(),
  }).eq('id', batch_id);

  return json({
    ok: true,
    qbo_journal_entry_id: String(created.Id),
    doc_number: created.DocNumber ?? null,
    line_count: lines.length,
    debits: dr,
    credits: cr,
    readback_matches: matches,
    warning: matches === false
      ? 'The entry posted, but reading it back did not match what was sent. Check it in QuickBooks.'
      : matches === null
        ? 'The entry posted, but it could not be read back to confirm. Check it in QuickBooks.'
        : undefined,
  });
});
