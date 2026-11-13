// Scheduling only: publication remains the reconciled, atomic evidence path.
export const shiftDay = (day, n) => new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10);
export function storeToday(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function coverageConfig(env) {
  const companies = (env.ATTRIBUTION_COVERAGE_COMPANIES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!companies.length || companies.some(s => s !== '*' && !/^[0-9a-f-]{36}$/i.test(s)) || (companies.includes('*') && companies.length !== 1)) throw Error('Explicit company allowlist or * required');
  const initialDays = Number(env.ATTRIBUTION_INITIAL_DAYS || 31);
  if (!Number.isInteger(initialDays) || initialDays < 1 || initialDays > 31) throw Error('Initial history must be 1–31 days');
  // Historical days collected per store per run. Bounded by the widest window planDays can floor to.
  const gapDays = Number(env.ATTRIBUTION_GAP_DAYS || 10);
  if (!Number.isInteger(gapDays) || gapDays < 1 || gapDays > 60) throw Error('Catch-up budget must be 1–60 days');
  // How deep the automatic backward walk goes, in days before today. 730 is the depth the
  // rest of SILO imports to (integration-bootstrap-core.mjs), so attribution reaches as far
  // back as the sales it explains. 0 switches the walk off entirely, which is what every
  // run did before it existed. An unset GitHub repo variable arrives as '' and Number('')
  // is 0, so the default has to be applied to '' as well as undefined.
  const historyDays = Number(env.ATTRIBUTION_HISTORY_DAYS === undefined || env.ATTRIBUTION_HISTORY_DAYS === '' ? 730 : env.ATTRIBUTION_HISTORY_DAYS);
  if (!Number.isInteger(historyDays) || historyDays < 0 || historyDays > 1095) throw Error('History depth must be 0–1095 days');
  // Historical days walked backwards per store per run. Separate budget from gapDays on
  // purpose: deep history must never be able to consume the budget that keeps the last
  // weeks current, and it is planned last so a slow night drops history, not today.
  const historyBudget = Number(env.ATTRIBUTION_HISTORY_BUDGET || 20);
  if (!Number.isInteger(historyBudget) || historyBudget < 1 || historyBudget > 60) throw Error('History budget must be 1–60 days');
  return { companies, initialDays, gapDays, historyDays, historyBudget, excluded: new Set((env.ATTRIBUTION_EXCLUDED_CONNECTIONS || '').split(',').map(s => s.trim()).filter(Boolean)) };
}
export function eligible(connection, config) {
  return connection.is_active === true && connection.sync_enabled === true && !config.excluded.has(connection.id)
    && (config.companies.includes('*') || config.companies.includes(connection.company_entity_id));
}
export function missingScopes(connection) {
  return ['read_orders', 'read_reports'].filter(scope => !connection.scopes_granted?.includes(scope));
}
export function canPublish(fresh, original, config, day, today) {
  return fresh && eligible(fresh, config) && !missingScopes(fresh).length
    && fresh.company_entity_id === original.company_entity_id && fresh.shop_domain === original.shop_domain
    && (fresh.scopes_granted.includes('read_all_orders') || day >= shiftDay(today, -59));
}
/** How far back the automatic backward walk may go for THIS store, or null for no walk.
 *
 *  Three bounds, and each rules out history that cannot exist or cannot be read:
 *   - the configured depth (`historyDays` before today), which is the target;
 *   - `read_all_orders`. Without it Shopify serves only a ~60-day rolling window, which
 *     the trailing refresh and the gap catch-up already cover, so there is no deeper
 *     history to walk and the store is reported rather than attempted;
 *   - the day the SHOP itself was created. Asking Shopify for a day before the store
 *     existed cannot return a reconciled day, so the walk stops there by construction
 *     instead of burning its budget on days that must fail. Unknown (null) does not
 *     bound anything -- the depth still does.
 */
export function historyFloorDay({ today, connection, historyDays, shopCreatedDay = null }) {
  if (!historyDays || !connection?.scopes_granted?.includes('read_all_orders')) return null;
  const target = shiftDay(today, -historyDays);
  return shopCreatedDay && shopCreatedDay > target ? shopCreatedDay : target;
}
export function planDays({ today, state, snapshots, fullHistory, gapDays, historyFloor = null, historyBudget = 0 }) {
  // Refuse rather than default: a missing budget would silently plan zero historical days forever.
  if (!Number.isInteger(gapDays) || gapDays < 1) throw Error('Catch-up budget required');
  const end = shiftDay(today, -1);
  // Stay conservatively inside Shopify's 60-day rolling order-access limit.
  const floor = fullHistory ? state.start_day : [state.start_day, shiftDay(today, -59)].sort().at(-1);
  const published = new Map(snapshots.map(row => [row.day, row.extracted_at]));
  const refresh = [];
  for (let n = 7; n >= 1; n--) {
    const day = shiftDay(today, -n), extracted = published.get(day);
    if (day >= state.start_day && (!extracted || storeToday(state.shop_timezone, new Date(extracted)) < today)) refresh.push(day);
  }
  const gaps = [];
  // Cursor rotates past failures, so a permanently bad day cannot starve later gaps.
  const cursor = state.next_day >= floor && state.next_day <= end ? state.next_day : floor;
  for (const [first, last] of [[cursor, end], [floor, shiftDay(cursor, -1)]]) {
    for (let day = first; day <= last && gaps.length < gapDays; day = shiftDay(day, 1)) {
      if (!published.has(day) && !refresh.includes(day)) gaps.push(day);
    }
  }
  // Deep history, walked BACKWARDS from the day before enrolment, one bounded slice a
  // night. Backwards rather than forwards so the covered history is always contiguous:
  // a run that stops early leaves a shorter history, never a hole. Its own cursor
  // (`state.history_day`) moves past every day it attempts, success or failure, so one
  // permanently unreadable old day costs one attempt and then stops costing anything --
  // it can never wedge the walk the way a retried day would. Days already published
  // (an earlier manual backfill, say) are stepped over without spending budget.
  const history = [];
  if (historyFloor && historyBudget > 0) {
    const first = state.history_day && state.history_day < state.start_day ? state.history_day : shiftDay(state.start_day, -1);
    for (let day = first; day >= historyFloor && history.length < historyBudget; day = shiftDay(day, -1)) {
      if (!published.has(day)) history.push(day);
    }
  }
  return { refresh, gaps, history, floor, end, historyFloor,
    historyComplete: Boolean(historyFloor) && !history.length,
    permissionLimited: floor > state.start_day };
}

// Injected I/O lets the real orchestration run against deterministic fixtures.
export async function runCoverage({ config, listConnections, loadState, saveState, loadSnapshots, prepare, runDay, currentConnection, now = () => new Date(), log = console.log, deadline = Infinity }) {
  const connections = (await listConnections()).filter(c => eligible(c, config));
  const work = [];
  let failures = 0;
  for (const connection of connections) {
    try { work.push({ connection, state: await loadState(connection.id) }); }
    catch { failures++; log(JSON.stringify({ connection_id: connection.id, status: 'checkpoint_read_failed' })); }
  }
  work.sort((a, b) => (a.state?.last_attempt_at || '').localeCompare(b.state?.last_attempt_at || '') || a.connection.id.localeCompare(b.connection.id));
  for (let index = 0; index < work.length; index++) {
    const item = work[index];
    if (+now() >= deadline) break;
    let { connection, state } = item;
    // Deep history gets an equal share of whatever time is left, per store. Without this
    // the first store in the rotation could spend the entire run walking its own history
    // and every other store would miss its trailing refresh -- history would starve the
    // current days ACROSS stores even though it is planned last WITHIN one.
    let historyDeadline = null;
    const historyShare = () => Number.isFinite(deadline)
      ? +now() + Math.max(0, deadline - +now()) / (work.length - index)
      : Infinity;
    const receipt = { connection_id: connection.id, attempted: 0, succeeded: 0, failed: 0 };
    try {
      connection = await currentConnection(connection.id);
      if (!connection || !eligible(connection, config)) continue;
      const missing = missingScopes(connection);
      if (missing.length) { log(JSON.stringify({ ...receipt, status: 'scope_skipped', missing })); continue; }
      // `prepare` returns the store calendar, and may also report the day the shop was
      // created. A plain string keeps the older contract working unchanged.
      const prepared = await prepare(connection);
      const timeZone = typeof prepared === 'string' ? prepared : prepared?.timeZone;
      const shopCreatedDay = typeof prepared === 'string' ? null : prepared?.createdDay || null;
      if (!timeZone) throw Error('Store calendar required');
      const today = storeToday(timeZone, now());
      state ||= { connection_id: connection.id, start_day: shiftDay(today, -config.initialDays), next_day: shiftDay(today, -config.initialDays) };
      state.shop_timezone = timeZone;
      state.last_attempt_at = now().toISOString();
      state.last_status = 'running';
      await saveState(state); // Freeze enrollment BEFORE the first remote day fetch.
      // The backward walk needs somewhere durable to keep its cursor, and the column that
      // holds it ships in a migration that is applied by hand after merge. A checkpoint row
      // read back from the database carries the key once the column exists, so until then
      // the walk simply does not plan anything and nothing writes a column that is not
      // there. A store enrolling tonight has a locally built state and starts walking on
      // its next run.
      const historyReady = Object.prototype.hasOwnProperty.call(state, 'history_day');
      const historyFloor = historyReady ? historyFloorDay({ today, connection, historyDays: config.historyDays, shopCreatedDay }) : null;
      // Snapshots are read from the deepest day the plan can reach, so history the store
      // already has -- from an earlier manual backfill, or from last night's walk -- is
      // stepped over rather than published again.
      const plan = planDays({ today, state,
        snapshots: await loadSnapshots(connection.id, historyFloor && historyFloor < state.start_day ? historyFloor : state.start_day),
        fullHistory: connection.scopes_granted.includes('read_all_orders'), gapDays: config.gapDays,
        historyFloor, historyBudget: config.historyBudget });
      receipt.permission_limited = plan.permissionLimited;
      receipt.accessible_start = plan.floor;
      receipt.history_floor = plan.historyFloor;
      // A store without read_all_orders has no deep history to walk, which is the account
      // owner's scope to grant, not a fault of the run. Said once a night, in its receipt.
      if (historyReady && config.historyDays && !plan.historyFloor) receipt.history_scope_missing = true;
      if (plan.historyComplete) receipt.history_complete = true;
      // Historical budget is separate from refresh budget; neither can consume the other.
      // Deep history goes LAST so a night that runs out of time drops the oldest work
      // rather than the trailing days everything reads.
      const deep = new Set(plan.history);
      for (const day of [...plan.gaps, ...plan.refresh, ...plan.history]) {
        if (+now() >= deadline) break;
        if (deep.has(day)) {
          historyDeadline ??= historyShare();
          if (+now() >= historyDeadline) break;
        }
        const fresh = await currentConnection(connection.id);
        if (!canPublish(fresh, connection, config, day, storeToday(timeZone, now()))) break;
        receipt.attempted++;
        if (deep.has(day)) receipt.history_attempted = (receipt.history_attempted || 0) + 1;
        try {
          await runDay(connection, day);
          receipt.succeeded++;
          if (deep.has(day)) receipt.history_succeeded = (receipt.history_succeeded || 0) + 1;
        } catch {
          // Do not persist upstream errors: they may contain credentials or response bodies.
          // A day of deep history that cannot be read is recorded and walked past: old days
          // fail for reasons nobody can fix tonight (a journey Shopify no longer holds, a
          // later refund that no longer reconciles), and that must not turn the nightly run
          // that keeps every store current into a failure.
          if (deep.has(day)) { receipt.history_failed = (receipt.history_failed || 0) + 1; receipt.history_failed_day = day; }
          else {
            receipt.failed++; failures++;
            state.last_failed_day = day;
            state.last_failed_at = now().toISOString();
          }
        }
        if (deep.has(day)) state.history_day = shiftDay(day, -1);
        else if (plan.gaps.includes(day)) state.next_day = day >= plan.end ? plan.floor : shiftDay(day, 1);
        state.last_status = receipt.failed || receipt.history_failed ? 'partial_failure' : 'running';
        state.last_result = receipt;
        await saveState(state);
      }
      state.last_status = receipt.failed || receipt.history_failed ? 'partial_failure' : receipt.attempted < plan.gaps.length+plan.refresh.length+plan.history.length ? 'paused' : receipt.permission_limited ? 'permission_limited' : 'success';
      state.last_result = receipt;
      await saveState(state);
      log(JSON.stringify({ ...receipt, status: state.last_status }));
    } catch {
      failures++;
      log(JSON.stringify({ ...receipt, status: 'store_failed' }));
      if (state) {
        state.last_status = 'store_failed'; state.last_attempt_at = now().toISOString(); state.last_result = receipt;
        try { await saveState(state); } catch { /* Next run can still find missing snapshots. */ }
      }
    }
  }
  return { failures };
}
