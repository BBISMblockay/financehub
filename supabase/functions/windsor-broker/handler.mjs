// JWT-auth: Windsor.ai as a tenant broker (TEST PHASE -- only
// /v2/windsor-test.html calls this). SILO holds ONE Windsor owner key
// (WINDSOR_API_KEY); each SILO company connects its own accounts through an
// authorization link SILO mints for that company, and every Windsor read is
// restricted to the accounts that company's links brought in.
//
// Logic lives here so node can execute it (scripts/tests/windsor-broker.test.mjs);
// index.ts wires the real collaborators.
//
// Actions (POST { action, ... }):
//   status     -- is the key configured. No Windsor call.
//   mint_link  -- { source? } -> { url }. Records the link's token for the
//                 caller's company BEFORE handing the URL out.
//   reconcile  -- asks Windsor which accounts each of this company's links
//                 brought in and records them. Never attributes an account
//                 whose row does not carry this company's own link token.
//   preview    -- { linked_account_id, connector?, fields, date_preset } ->
//                 rows for ONE of this company's accounts. Read-only, stores
//                 nothing.
//   unlink     -- { linked_account_id } -> removes it from SILO's Windsor team
//                 and from SILO.
//
// The company is ALWAYS the caller's active company, read from their profile,
// never from the request body (supabase/functions/CLAUDE.md).
import { mayConnect } from './google-oauth-lib.mjs';
import {
  WINDSOR_ONBOARD, WINDSOR_CONNECTORS, PREVIEW_MAX_ROWS, MAX_LINKS_PER_RECONCILE,
  parseSource, parseConnector, parseFields, parseDatePreset, windsorUrl, redact,
  parseBody, describeShape, extractLink, rowsOf, partitionLinkedAccounts, planUpserts,
  filterRowsToAccount,
} from './windsor-lib.mjs';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const LINKS = 'windsor_links';
const ACCOUNTS = 'windsor_linked_accounts';

export function createWindsorHandler({ env, admin, fetchImpl, checkMfa, checkIntegration, now = () => new Date() }) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
  const key = env.WINDSOR_API_KEY || '';

  // One place that talks to Windsor. The URL carries the owner key, so it is
  // never logged and never returned; only status and a redacted body are.
  async function windsor(url, method = 'GET') {
    let res;
    try {
      res = await fetchImpl(url, { method, signal: AbortSignal.timeout(20000) });
    } catch (e) {
      return { ok: false, status: 0, body: null, detail: redact(e?.name === 'TimeoutError' ? 'timed out' : 'network error', key) };
    }
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body: parseBody(text), detail: res.ok ? '' : redact(text, key) };
  }

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: auth } = jwt ? await admin.auth.getUser(jwt) : { data: null };
    const user = auth?.user;
    if (!user) return json({ error: 'Unauthorized' }, 401);

    // Third-party tokens (20261020030000): everything below runs with the
    // service role, which the Data API's pre-request hook never sees. Pure,
    // so before the two-step gate's round trip. Unwired refuses.
    const integ = checkIntegration
      ? checkIntegration(req.headers.get('Authorization') ?? '')
      : { ok: false, status: 503, code: 'integration_check_failed', message: 'Connection check is not configured.' };
    if (!integ.ok) return json({ error: integ.message, code: integ.code }, integ.status);

    // Two-step login (20261014000000). Refused when not wired.
    const mfa = checkMfa
      ? await checkMfa(req.headers.get('Authorization') ?? '')
      : { ok: false, status: 503, code: 'mfa_check_failed', message: 'Two-step login check is not configured.' };
    if (!mfa.ok) return json({ error: mfa.message, code: mfa.code }, mfa.status);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
    const action = body?.action;

    // The caller's ACTIVE company, and only if they administer it. Same rule
    // as every connect function (mayConnect), with the company taken from the
    // profile rather than the request.
    const { data: profile, error: profileError } = await admin.from('profiles')
      .select('role, active_company_id, is_active').eq('id', user.id).maybeSingle();
    const companyId = profile?.active_company_id ?? null;
    if (!companyId) return json({ error: 'No active company' }, 400);
    const { data: membership, error: membershipError } = await admin.from('entity_memberships')
      .select('role').eq('entity_id', companyId).eq('user_id', user.id).maybeSingle();
    if (!mayConnect({ profile, profileError, membership, membershipError, companyId })) {
      return json({ error: 'Admin access required for this company' }, 403);
    }

    if (action === 'status') return json({ configured: Boolean(key) });
    if (!key) return json({ error: 'Windsor is not configured (WINDSOR_API_KEY is not set)' }, 503);

    // ── mint_link ────────────────────────────────────────────────────────
    if (action === 'mint_link') {
      const src = parseSource(body.source);
      if (!src.ok) return json({ error: src.reason }, 400);
      const r = await windsor(windsorUrl(WINDSOR_ONBOARD, '/api/team/generate-co-user-url/', {
        api_key: key, allowed_sources: src.value,
      }));
      if (!r.ok) return json({ error: `Windsor answered ${r.status || 'nothing'}`, detail: r.detail }, 502);
      const link = extractLink(r.body);
      // No token, no link: an account connected through a link SILO cannot
      // tie to a company would sit on SILO's Windsor team unattributable.
      if (!link.ok) {
        return json({ error: 'Windsor returned a link SILO could not read a token from, so it was not used',
          shape: describeShape(r.body) }, 502);
      }
      const { error } = await admin.from(LINKS)
        .insert({ company_entity_id: companyId, access_token: link.token, allowed_source: src.value, created_by: user.id })
        .select('id').single();
      if (error) return json({ error: 'Could not record the link' }, 500);
      return json({ url: link.url, source: src.value });
    }

    // ── reconcile ────────────────────────────────────────────────────────
    if (action === 'reconcile') {
      const { data: links, error: linksErr } = await admin.from(LINKS)
        .select('id, access_token').eq('company_entity_id', companyId)
        .order('created_at', { ascending: false }).limit(MAX_LINKS_PER_RECONCILE);
      if (linksErr) return json({ error: 'Could not read this company\'s links' }, 500);

      const summary = { links: (links ?? []).length, found: 0, added: 0, refreshed: 0, conflicts: [],
        rejected: { token_mismatch: 0, token_missing: 0, malformed: 0 }, errors: [] };
      for (const link of links ?? []) {
        const r = await windsor(windsorUrl(WINDSOR_ONBOARD, '/api/team/co-user-linked-accounts/', {
          api_key: key, access_token: link.access_token,
        }));
        if (!r.ok) { summary.errors.push(`Windsor answered ${r.status || 'nothing'}: ${r.detail}`); continue; }
        const rows = rowsOf(r.body);
        if (!rows) { summary.errors.push(`unexpected response: ${describeShape(r.body)}`); continue; }
        const { accepted, rejected } = partitionLinkedAccounts(rows, link.access_token);
        summary.found += accepted.length;
        for (const k of Object.keys(rejected)) summary.rejected[k] += rejected[k];
        if (!accepted.length) continue;

        const { data: existing, error: exErr } = await admin.from(ACCOUNTS)
          .select('id, company_entity_id, ds_id, account_id')
          .in('account_id', accepted.map((a) => a.account_id));
        if (exErr) { summary.errors.push('could not read existing accounts'); continue; }
        const plan = planUpserts(accepted, existing ?? [], companyId);
        summary.conflicts.push(...plan.conflicts);
        const seenAt = now().toISOString();
        for (const a of plan.inserts) {
          const { error } = await admin.from(ACCOUNTS).insert({
            company_entity_id: companyId, link_id: link.id, ds_id: a.ds_id, account_id: a.account_id,
            account_name: a.account_name, first_seen_at: seenAt, last_seen_at: seenAt,
          }).select('id').single();
          // A unique violation here means another company's reconcile claimed
          // it between our read and our write: a conflict, not a failure.
          if (error) {
            if (error.code === '23505') summary.conflicts.push({ ds_id: a.ds_id, account_id: a.account_id });
            else summary.errors.push(`could not record ${a.ds_id} ${a.account_id}`);
          } else summary.added += 1;
        }
        for (const t of plan.touches) {
          const patch = { last_seen_at: seenAt, ...(t.account_name ? { account_name: t.account_name } : {}) };
          const { error } = await admin.from(ACCOUNTS).update(patch).eq('id', t.id).eq('company_entity_id', companyId);
          if (error) summary.errors.push('could not refresh an account');
          else summary.refreshed += 1;
        }
      }
      return json(summary);
    }

    // Both remaining actions act on ONE of this company's accounts. The row is
    // read with the company in the filter, so another tenant's id is simply
    // not found.
    async function ownAccount() {
      const id = body?.linked_account_id;
      if (!id || typeof id !== 'string') return { error: json({ error: 'linked_account_id required' }, 400) };
      const { data, error } = await admin.from(ACCOUNTS)
        .select('id, ds_id, account_id').eq('id', id).eq('company_entity_id', companyId).maybeSingle();
      if (error) return { error: json({ error: 'Could not read the account' }, 500) };
      if (!data) return { error: json({ error: 'Account not found' }, 404) };
      return { row: data };
    }

    // ── preview ──────────────────────────────────────────────────────────
    if (action === 'preview') {
      const own = await ownAccount();
      if (own.error) return own.error;
      const conn = parseConnector(body.connector || own.row.ds_id);
      if (!conn.ok) return json({ error: conn.reason }, 400);
      const fields = parseFields(body.fields);
      if (!fields.ok) return json({ error: fields.reason }, 400);
      const preset = parseDatePreset(body.date_preset);
      if (!preset.ok) return json({ error: preset.reason }, 400);

      const r = await windsor(windsorUrl(WINDSOR_CONNECTORS, `/${conn.value}`, {
        api_key: key, date_preset: preset.value, fields: fields.value.join(','),
        select_accounts: own.row.account_id, _max_rows: PREVIEW_MAX_ROWS,
      }));
      if (!r.ok) return json({ error: `Windsor answered ${r.status || 'nothing'}`, detail: r.detail }, 502);
      const rows = rowsOf(r.body);
      if (!rows) return json({ error: 'Windsor did not return a list of rows', shape: describeShape(r.body) }, 502);
      const { kept, foreign, unattributed } = filterRowsToAccount(rows, own.row.account_id);
      return json({
        connector: conn.value, fields: fields.value, date_preset: preset.value,
        returned: rows.length, foreign, unattributed,
        // _max_rows caps the answer and Windsor documents no pagination, so a
        // full page may be a truncated one. Said, not hidden.
        maybe_truncated: rows.length >= PREVIEW_MAX_ROWS,
        rows: kept,
      });
    }

    // ── unlink ───────────────────────────────────────────────────────────
    if (action === 'unlink') {
      const own = await ownAccount();
      if (own.error) return own.error;
      const r = await windsor(windsorUrl(WINDSOR_ONBOARD, '/api/team/co-user-linked-accounts/', {
        api_key: key, ds_id: own.row.ds_id, account_id: own.row.account_id,
      }), 'DELETE');
      // 404 = Windsor no longer has it linked; SILO's row is then stale and
      // goes too. Anything else keeps SILO's row, so the two cannot disagree
      // in the direction that hides a live authorization.
      if (!r.ok && r.status !== 404) {
        return json({ error: `Windsor answered ${r.status || 'nothing'}; nothing was removed`, detail: r.detail }, 502);
      }
      const { error } = await admin.from(ACCOUNTS).delete().eq('id', own.row.id).eq('company_entity_id', companyId);
      if (error) return json({ error: 'Unlinked in Windsor, but SILO could not remove its row' }, 500);
      return json({ unlinked: true, windsor_status: r.status });
    }

    return json({ error: 'Unknown action' }, 400);
  };
}
