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
  return { companies, initialDays, excluded: new Set((env.ATTRIBUTION_EXCLUDED_CONNECTIONS || '').split(',').map(s => s.trim()).filter(Boolean)) };
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
export function planDays({ today, state, snapshots, fullHistory }) {
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
    for (let day = first; day <= last && gaps.length < 3; day = shiftDay(day, 1)) {
      if (!published.has(day) && !refresh.includes(day)) gaps.push(day);
    }
  }
  return { refresh, gaps, floor, end,
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
  for (const item of work) {
    if (+now() >= deadline) break;
    let { connection, state } = item;
    const receipt = { connection_id: connection.id, attempted: 0, succeeded: 0, failed: 0 };
    try {
      connection = await currentConnection(connection.id);
      if (!connection || !eligible(connection, config)) continue;
      const missing = missingScopes(connection);
      if (missing.length) { log(JSON.stringify({ ...receipt, status: 'scope_skipped', missing })); continue; }
      const timeZone = await prepare(connection);
      const today = storeToday(timeZone, now());
      state ||= { connection_id: connection.id, start_day: shiftDay(today, -config.initialDays), next_day: shiftDay(today, -config.initialDays) };
      state.shop_timezone = timeZone;
      state.last_attempt_at = now().toISOString();
      state.last_status = 'running';
      await saveState(state); // Freeze enrollment BEFORE the first remote day fetch.
      const plan = planDays({ today, state, snapshots: await loadSnapshots(connection.id, state.start_day), fullHistory: connection.scopes_granted.includes('read_all_orders') });
      receipt.permission_limited = plan.permissionLimited;
      receipt.accessible_start = plan.floor;
      // Historical budget is separate from refresh budget; neither can consume the other.
      for (const day of [...plan.gaps, ...plan.refresh]) {
        if (+now() >= deadline) break;
        const fresh = await currentConnection(connection.id);
        if (!canPublish(fresh, connection, config, day, storeToday(timeZone, now()))) break;
        receipt.attempted++;
        try {
          await runDay(connection, day);
          receipt.succeeded++;
        } catch {
          // Do not persist upstream errors: they may contain credentials or response bodies.
          receipt.failed++; failures++;
          state.last_failed_day = day;
          state.last_failed_at = now().toISOString();
        }
        if (plan.gaps.includes(day)) state.next_day = day >= plan.end ? plan.floor : shiftDay(day, 1);
        state.last_status = receipt.failed ? 'partial_failure' : 'running';
        state.last_result = receipt;
        await saveState(state);
      }
      state.last_status = receipt.failed ? 'partial_failure' : receipt.attempted < plan.gaps.length+plan.refresh.length ? 'paused' : receipt.permission_limited ? 'permission_limited' : 'success';
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
