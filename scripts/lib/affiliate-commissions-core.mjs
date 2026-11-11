// Affiliate Studio nightly commissions (20261110180000). For every active
// program: match recent orders to affiliates, then accrue commissions on
// them -- the same two database steps the Studio "Update commissions"
// option runs, called with the service role. Both are idempotent, so a
// re-run or an overlap with a person pressing the button changes nothing.
// Then it sweeps "your code is live" notices the instant kick missed.
//
// Writes nothing itself except one sync_jobs row per program.

export const LOOKBACK_DAYS = 45;

// YYYY-MM-DD, `days` before `at` (UTC). The window is deliberately wider than
// any company's day boundary, so the timezone does not matter here; the
// database steps judge each order on the company's own day.
export function dayOffset(at, days) {
  return new Date(at.getTime() - days * 86400000).toISOString().slice(0, 10);
}

export async function runCommissions({ supabase, now = () => new Date(), deliverNotices = null, log = () => {}, onlyProgramId = '' }) {
  const summary = { programs: 0, failed: 0, entries_accrued: 0, entries_reduced: 0, notices: null };
  let q = supabase.from('affiliate_programs').select('id, company_entity_id, name').eq('status', 'active');
  if (onlyProgramId) q = q.eq('id', onlyProgramId);
  const { data: programs, error } = await q;
  if (error) throw new Error(`affiliate_programs: ${error.message}`);

  const to = dayOffset(now(), -1);            // tomorrow (UTC) covers every zone's today
  const from = dayOffset(now(), LOOKBACK_DAYS);
  for (const p of programs || []) {
    summary.programs += 1;
    const started = now().toISOString();
    let status = 'success', result = { program_id: p.id, from, to };
    try {
      const r1 = await supabase.rpc('affiliate_resolve_attributions', { p_program: p.id, p_from: from, p_to: to });
      if (r1.error) throw new Error(`resolve: ${r1.error.message}`);
      const r2 = await supabase.rpc('affiliate_accrue_commissions', { p_program: p.id, p_from: from, p_to: to });
      if (r2.error) throw new Error(`accrue: ${r2.error.message}`);
      result = { ...result, orders_recorded: r1.data?.rows_written ?? null, entries_accrued: r2.data?.entries_accrued ?? 0,
        entries_reduced: r2.data?.entries_reduced ?? 0, net_amount_cents: r2.data?.net_amount_cents ?? 0 };
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
