/* Prepared coding suggestions: the page's view of card_coding_suggestions.

   The database is the record. This module reads live suggestions for the rows
   on screen, and accepts, dismisses and re-asks through the RPCs and the
   card-categorize function -- it never keeps a suggestion anywhere a reload
   would lose it, which is what the old in-page Map did.

   Three states a bookkeeper sees, and one they never do:
     ready     -- an account from the active chart, with its evidence
     judgment  -- Claude declined to name one; a person must choose
     failed    -- preparation did not finish; retry
     (stale)   -- facts, connection or chart moved since it was prepared. Not
                  shown: a suggestion about other facts is not a suggestion. */
(function () {
  'use strict';
  const FIELDS = 'id,transaction_id,outcome,review_status,qbo_account_id,qbo_account_name,qbo_location_id,qbo_location_name,'
    + 'vendor_name,accounting_treatment,confidence,reasoning,evidence,history_status,error_code,prepared_at,prepared_via,attempt,stale_reason';
  const missingTable = (error) => /42P01|does not exist|schema cache/i.test(`${error?.code || ''} ${error?.message || ''}`);

  const kind = (s) => s.outcome === 'suggested' ? 'ready' : s.outcome === 'failed' ? 'failed' : 'judgment';

  /* Live, current suggestions for these transactions, as a Map keyed by
     transaction id. { available:false } when the table is not there yet, so
     the page says so instead of pretending nothing was prepared. */
  async function load(db, company, ids) {
    const out = new Map();
    if (!company || !ids?.length) return { available: true, byTransaction: out };
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db.from('card_coding_suggestions_v').select(FIELDS)
        .eq('company_entity_id', company).eq('review_status', 'open').in('transaction_id', ids.slice(i, i + 200));
      if (error) {
        if (missingTable(error)) return { available: false, byTransaction: new Map() };
        throw new Error(error.message);
      }
      for (const s of data || []) {
        if (s.stale_reason) continue;
        out.set(s.transaction_id, {
          ...s, kind: kind(s),
          // The names the older page code reads, so one renderer serves both.
          account_id: s.qbo_account_id, account_name: s.qbo_account_name, location_name: s.qbo_location_name,
        });
      }
    }
    return { available: true, byTransaction: out };
  }

  /* Whether a row should show its suggestion at all: only while the row is
     still waiting for a category. A row someone coded, split or excluded has
     had its decision made. */
  const applies = (t, split) => !!t && t.status === 'uncoded' && !t.qbo_account_id && !split;

  const REASONS = {
    facts_changed: 'the bank or card details changed after it was prepared',
    connection_changed: 'the account is now bound to a different QuickBooks company',
    account_unavailable: 'the suggested account is no longer active in QuickBooks',
    location_unavailable: 'the suggested location is no longer active in QuickBooks',
    already_coded: 'it was already categorized',
    split: 'it is split across accounts',
    excluded: 'it is excluded',
    batch_locked: 'its import is approved or posted',
    not_open: 'it was already accepted or dismissed',
    not_found: 'it is no longer available',
    no_account_suggested: 'no account was suggested',
    not_settled: 'the bank has not settled it',
  };
  const reasonText = (reason) => REASONS[String(reason || '')] || String(reason || 'it could not be applied');

  async function accept(db, ids) {
    const { data, error } = await db.rpc('accept_card_coding_suggestions', { p_ids: ids });
    if (error) throw new Error(error.message);
    return { accepted: data?.accepted || [], refused: data?.refused || [] };
  }
  async function dismiss(db, ids) {
    const { data, error } = await db.rpc('dismiss_card_coding_suggestions', { p_ids: ids });
    if (error) throw new Error(error.message);
    return Number(data || 0);
  }

  /* Ask card-categorize to prepare these rows (retry = ask again even where a
     suggestion or dismissal stands). The function saves as it goes; the
     caller reloads from the database rather than trusting the response. */
  async function prepare({ url, token, batchId, ids, retry = false, fetchImpl = fetch }) {
    const res = await fetchImpl(`${url}/functions/v1/card-categorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ batch_id: batchId, transaction_ids: ids, ...(retry ? { retry: true } : {}) }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    return out;
  }

  /* The run in flight for a batch, for a progress line while prepare() is
     waiting. Absent is fine; a run older than the gateway's limit is not
     "running" whatever its row says. */
  async function progress(db, company, batchId, since) {
    const { data, error } = await db.from('card_coding_preparation_runs')
      .select('id,status,transactions_requested,suggestions_recorded,needs_judgment_recorded,failures_recorded,model_calls,started_at')
      .eq('company_entity_id', company).eq('batch_id', batchId).gte('started_at', since)
      .order('started_at', { ascending: false }).limit(1);
    if (error || !data?.length) return null;
    const r = data[0];
    return { ...r, done: (r.suggestions_recorded || 0) + (r.needs_judgment_recorded || 0) + (r.failures_recorded || 0) };
  }

  /* "Feed last synced" and "coding last prepared" are separate facts and are
     shown separately: fresh bank data says nothing about whether it has been
     prepared, and the reverse. */
  async function freshness(db, company, source) {
    const result = { feedSyncedAt: null, preparedAt: null, preparedStatus: null, available: true };
    if (!company || !source?.id) return result;
    if (source.ingest_mode === 'plaid') {
      const { data } = await db.from('plaid_accounts').select('last_synced_at')
        .eq('company_entity_id', company).eq('source_id', source.id);
      const times = (data || []).map((a) => a.last_synced_at).filter(Boolean).sort();
      result.feedSyncedAt = times.length ? times[times.length - 1] : null;
    }
    const { data, error } = await db.from('card_coding_preparation_runs').select('finished_at,status')
      .eq('company_entity_id', company).eq('source_id', source.id).not('finished_at', 'is', null)
      .order('finished_at', { ascending: false }).limit(1);
    if (error) { if (missingTable(error)) result.available = false; return result; }
    if (data?.length) { result.preparedAt = data[0].finished_at; result.preparedStatus = data[0].status; }
    return result;
  }

  function ago(iso, now = Date.now()) {
    if (!iso) return null;
    const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function counts(map, rows, splitFor) {
    const c = { ready: 0, judgment: 0, failed: 0 };
    for (const t of rows) {
      const s = map.get(t.id);
      if (s && applies(t, splitFor(t))) c[s.kind]++;
    }
    return c;
  }

  // accept_card_coding_suggestions refuses more than 500 ids in one call.
  const ACCEPT_BATCH = 500;
  window.SiloCodingSuggestions = { load, applies, accept, dismiss, prepare, progress, freshness, ago, counts, reasonText, kind, ACCEPT_BATCH };
})();
