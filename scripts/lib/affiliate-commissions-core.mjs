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

  const lookupDone = new Set();               // companies whose customer lookup this run refreshed
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
      // Refunds and cancellations on credited orders of ANY age, and on
      // orders whose code was since retired (20261119040000): the window above
      // only re-reads recent orders, by order date, through active codes. The
      // nightly sweep only -- chained runs stay short. Before the migration is
      // applied the function does not exist, which is not a failure.
      if (source === 'nightly') {
        const rr = await supabase.rpc('affiliate_refresh_credited_orders', { p_program: p.id });
        if (rr.error) {
          const missing = rr.error.code === 'PGRST202' || /affiliate_refresh_credited_orders/.test(rr.error.message || '') && /not find|does not exist/i.test(rr.error.message || '');
          if (!missing) throw new Error(`refresh credited: ${rr.error.message}`);
        } else if (rr.data) {
          result.credited_refresh = rr.data;
          summary.entries_reduced += Number(rr.data.entries_reduced) || 0;
        }
      }
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
      // The past-customer badge on this program's prospects. Nightly only:
      // it is a recruiting aid, not a money step, and a chained sync run has
      // nothing new for it. Its failure is recorded and changes nothing else
      // on the run -- a missing badge must never cost a commission.
      if (source === 'nightly') {
        try {
          result.customer_match = await refreshAndMatchCustomers({
            supabase, program: p, now,
            // Two programs in one company share one customer lookup, so it is
            // refreshed once per run and then only the prospects differ.
            refreshLookup: !lookupDone.has(p.company_entity_id),
          });
          lookupDone.add(p.company_entity_id);
        } catch (err) {
          result.customer_match = { error: String(err?.message || err) };
          log(`[affiliate-commissions] ${p.id} customer match failed (commissions unaffected): ${result.customer_match.error}`);
        }
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

// ── Past-customer badge (20261123210000) ────────────────────────────────────
//
// Keeps the company's customer lookup current and then badges the program's
// prospects. Two rules shape this:
//
//   * Every call shares the 8s API statement timeout, so the lookup is built
//     in WINDOWS of order dates. A nightly run refreshes the last few days and
//     walks a few older windows, so a company with ten years of orders fills
//     in over a few nights instead of timing out on the first.
//   * None of it can touch the money steps above. Its failure is recorded on
//     the run and nothing else.
// Windows are short because the cost of one is set by how many customers
// ordered inside it, and every caller shares the 8s API statement timeout.
// Measured on production 2026-11-23: a week of Baseballism's orders touches
// ~11,900 customers, so a week is not a small window for a big store.
export const CUSTOMER_WINDOW_DAYS = 3;          // the nightly top-up
export const CUSTOMER_BACKFILL_DAYS = 30;       // one backfill window
export const CUSTOMER_BACKFILL_WINDOWS = 4;     // per run
export const CUSTOMER_WINDOW_SPLITS = 5;        // halvings before a window gives up

export async function refreshAndMatchCustomers({ supabase, program, now = () => new Date(), windows = CUSTOMER_BACKFILL_WINDOWS, refreshLookup = true }) {
  const out = { windows: 0, customers_total: null, matched: null };
  const iso = (d) => new Date(d).toISOString();
  if (!refreshLookup) return matchOnly({ supabase, program, out });

  // A window that fails -- a statement timeout on a busy store's week is the
  // realistic way -- is halved and tried again, rather than losing the whole
  // run. Each half is an independent, idempotent call.
  const refreshWindow = async (sinceMs, untilMs, depth = 0) => {
    const args = { p_company: program.company_entity_id, p_since: iso(sinceMs) };
    if (untilMs != null) args.p_until = iso(untilMs);
    const r = await supabase.rpc('refresh_company_customer_profiles', args);
    if (!r.error) {
      out.windows += 1;
      if (r.data?.customers_total != null) out.customers_total = r.data.customers_total;
      return r;
    }
    if (missingFunction(r.error, 'refresh_company_customer_profiles')) return { notInstalled: true };
    const span = (untilMs ?? now().getTime()) - sinceMs;
    if (depth >= CUSTOMER_WINDOW_SPLITS || span <= 86400000) throw new Error(`customer lookup: ${r.error.message}`);
    out.splits = (out.splits || 0) + 1;
    const mid = sinceMs + Math.floor(span / 2);
    // Oldest half first, so `covered_from` only ever moves backwards.
    await refreshWindow(sinceMs, mid, depth + 1);
    return refreshWindow(mid, untilMs ?? now().getTime(), depth + 1);
  };

  // 1. The recent window, every run. Before the migration is applied the
  // function does not exist, which is not a failure: the prospects simply
  // carry no badge yet.
  const top = await refreshWindow(now().getTime() - CUSTOMER_WINDOW_DAYS * 86400000, null);
  if (top?.notInstalled) return { skipped: 'not_installed' };

  // 2. A few older windows, until the lookup reaches the company's first
  //    order. `covered_from` is stored state, not a derived minimum: a
  //    customer touched by a recent window can have a first order years
  //    earlier, which would read as coverage the build never did.
  const { data: state } = await supabase.from('company_customer_profile_state')
    .select('covered_from').eq('company_entity_id', program.company_entity_id).maybeSingle();
  const { data: oldest } = await supabase.from('shopify_orders')
    .select('shopify_created_at').eq('company_entity_id', program.company_entity_id)
    .not('shopify_created_at', 'is', null)
    .order('shopify_created_at', { ascending: true }).limit(1).maybeSingle();
  const floor = oldest?.shopify_created_at ? new Date(oldest.shopify_created_at).getTime() : null;
  let frontier = state?.covered_from ? new Date(state.covered_from).getTime() : now().getTime();
  // A backfill window that cannot be made to fit stops the WALK, not the run:
  // the recent window above is what this program's new prospects are matched
  // against, and the next run tries the older window again.
  try {
    for (let i = 0; i < windows && floor != null && frontier > floor; i += 1) {
      const since = Math.max(floor, frontier - CUSTOMER_BACKFILL_DAYS * 86400000);
      await refreshWindow(since, frontier);
      if (since <= floor) { out.history_complete = true; break; }
      frontier = since;
    }
  } catch (err) {
    out.backfill_error = String(err?.message || err);
  }

  // 3. The prospects of this program only. The customer base is never scanned
  //    looking for creators; that is both the wrong direction and the
  //    expensive one.
  return matchOnly({ supabase, program, out });
}

async function matchOnly({ supabase, program, out }) {
  const m = await supabase.rpc('affiliate_match_prospect_customers', { p_program: program.id });
  if (m.error) {
    if (missingFunction(m.error, 'affiliate_match_prospect_customers')) return { ...out, skipped: 'matcher_not_installed' };
    throw new Error(`prospect match: ${m.error.message}`);
  }
  out.matched = m.data ?? null;
  return out;
}

function missingFunction(error, name) {
  return error.code === 'PGRST202'
    || (new RegExp(name).test(error.message || '') && /not find|does not exist/i.test(error.message || ''));
}
