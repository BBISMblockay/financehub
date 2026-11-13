// Affiliate Studio nightly commissions (20261110180000). For every active
// program: match recent orders to affiliates, then accrue commissions on
// them -- the same two database steps the Studio "Update commissions"
// option runs, called with the service role. Both are idempotent, so a
// re-run or an overlap with a person pressing the button changes nothing.
// Then product seeding is swept, and the "your code is live" notices the
// instant kick missed.
//
// Writes nothing itself except one sync_jobs row per program.

export const LOOKBACK_DAYS = 45;

// YYYY-MM-DD, `days` before `at` (UTC). The window is deliberately wider than
// any company's day boundary, so the timezone does not matter here; the
// database steps judge each order on the company's own day.
export function dayOffset(at, days) {
  return new Date(at.getTime() - days * 86400000).toISOString().slice(0, 10);
}

// How far back a run chained to a data sync looks. It is SHORT on purpose:
// that call runs on every sync (up to twelve times a day), its only job is to
// pick up orders placed since the last one, and it shares the same 8s API
// statement timeout as every other caller. The reversals that land weeks after
// an order -- refunds, cancellations -- are the nightly LOOKBACK_DAYS sweep's
// job, which is why the chained call never replaces it.
export const CHAINED_LOOKBACK_DAYS = 3;

export async function runCommissions({ supabase, now = () => new Date(), deliverNotices = null, log = () => {}, onlyProgramId = '', onlyCompanyIds = null, lookbackDays = LOOKBACK_DAYS, source = 'nightly' }) {
  const summary = { programs: 0, failed: 0, entries_accrued: 0, entries_reduced: 0, notices: null };
  // An EMPTY company list means "no company in this run has an affiliate
  // program to update", which is not the same as "every company": filtering
  // on nothing would quietly resolve the whole platform on a single store's
  // sync.
  if (Array.isArray(onlyCompanyIds) && onlyCompanyIds.length === 0) return summary;
  let q = supabase.from('affiliate_programs').select('id, company_entity_id, name').eq('status', 'active');
  if (onlyProgramId) q = q.eq('id', onlyProgramId);
  if (Array.isArray(onlyCompanyIds)) q = q.in('company_entity_id', onlyCompanyIds);
  const { data: programs, error } = await q;
  if (error) throw new Error(`affiliate_programs: ${error.message}`);

  const to = dayOffset(now(), -1);            // tomorrow (UTC) covers every zone's today
  const from = dayOffset(now(), lookbackDays);
  for (const p of programs || []) {
    summary.programs += 1;
    const started = now().toISOString();
    // `source` is in the stored record so a short chained run cannot be read
    // as the nightly sweep having covered 45 days.
    let status = 'success', result = { program_id: p.id, from, to, source };
    try {
      const r1 = await supabase.rpc('affiliate_resolve_attributions', { p_program: p.id, p_from: from, p_to: to });
      if (r1.error) throw new Error(`resolve: ${r1.error.message}`);
      const r2 = await supabase.rpc('affiliate_accrue_commissions', { p_program: p.id, p_from: from, p_to: to });
      if (r2.error) throw new Error(`accrue: ${r2.error.message}`);
      result = { ...result, orders_recorded: r1.data?.rows_written ?? null, entries_accrued: r2.data?.entries_accrued ?? 0,
        entries_reduced: r2.data?.entries_reduced ?? 0, net_amount_cents: r2.data?.net_amount_cents ?? 0 };
      // Product seeding (20261113093000): seed purchases, progress, the
      // payback (written once, to the ledger) and expiry. After accrual, so
      // it reads the orders this run just credited. Its own failure is
      // recorded on the run and does not undo the commissions above; before
      // the migration is applied the function does not exist, which is not
      // a failure.
      const r3 = await supabase.rpc('affiliate_seed_sweep', { p_program: p.id });
      if (r3.error) {
        const missing = r3.error.code === 'PGRST202' || /affiliate_seed_sweep/.test(r3.error.message || '') && /not find|does not exist/i.test(r3.error.message || '');
        if (!missing) { status = 'error'; summary.failed += 1; result.seeding_error = r3.error.message; }
      } else if (r3.data) {
        result.seeding = r3.data;
      }
      summary.entries_accrued += Number(result.entries_accrued) || 0;
      summary.entries_reduced += Number(result.entries_reduced) || 0;
      log(`[affiliate-commissions] ${p.id}: ${JSON.stringify(result)}`);
    } catch (err) {
      status = 'error';
      summary.failed += 1;
      result = { ...result, error: String(err?.message || err) };
      log(`[affiliate-commissions] ${p.id} failed: ${result.error}`);
    }
    const { error: jErr } = await supabase.from('sync_jobs').insert({
      company_entity_id: p.company_entity_id, job_type: 'affiliate_commissions', status,
      started_at: started, finished_at: now().toISOString(), result,
    });
    if (jErr) log(`[affiliate-commissions] sync_jobs record failed: ${jErr.message}`);
  }

  if (deliverNotices) {
    try { summary.notices = await deliverNotices(); }
    catch (err) { summary.failed += 1; summary.notices = { error: String(err?.message || err) }; }
  }
  return summary;
}
