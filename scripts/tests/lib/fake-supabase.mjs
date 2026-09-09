/* A fake Supabase that actually stores rows and APPLIES FILTERS.
 *
 * The first version of this returned { error: null } from every update
 * regardless of its .eq()/.is()/.lt() chain. That was enough to prove a
 * sweep had been CALLED and nothing more -- so "both tables swept" passed
 * while saying nothing about which rows were touched, which is the only
 * part that matters. A sweep that marks the wrong rows missing and a sweep
 * that marks the right ones are indistinguishable to a fake that ignores
 * predicates (caught in review of PR #634).
 *
 * Supports the surface runCollectionsSync uses:
 *   from(t).insert(row).select(cols).single()
 *   from(t).upsert(rows, { onConflict })      -- merges on the conflict key
 *   from(t).update(patch).eq().is().lt().neq() -- filtered, awaited
 *   from(t).delete().eq().not(col,'in',list).select()  -- filtered, returns rows
 *
 * Filters are evaluated against stored rows, so a test can assert on the
 * table's resulting CONTENT rather than on call shapes.
 */

let autoId = 0;

export function createFakeSupabase() {
  /** @type {Map<string, object[]>} */
  const tables = new Map();
  const calls = { inserts: [], upserts: [], updates: [], deletes: [], rpcs: [] };

  const rowsOf = (t) => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t);
  };

  /** PostgREST renders an `in` list as `("a","b")`. The retirement sweep in
   * runShopDomainsSync builds exactly that string, so the fake has to parse it
   * rather than accept it blindly -- otherwise a sweep that deletes the whole
   * allowlist and one that deletes only retired hosts look identical here, and
   * this table authorises outbound fetches. */
  const parseInList = (raw) => new Set(
    String(raw ?? '').replace(/^\(|\)$/g, '')
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .filter(Boolean),
  );

  const matches = (row, filters) => filters.every((f) => {
    const v = row[f.col];
    if (f.op === 'eq') return v === f.val;
    if (f.op === 'neq') return v !== f.val;
    if (f.op === 'is') return f.val === null ? (v === null || v === undefined) : v === f.val;
    if (f.op === 'lt') return v != null && v < f.val;
    if (f.op === 'gte') return v != null && v >= f.val;
    if (f.op === 'not_in') return !parseInList(f.val).has(v);
    throw new Error(`fake-supabase: unsupported filter ${f.op}`);
  });

  function deleteBuilder(table) {
    const filters = [];
    let wantSelect = false;
    const run = () => {
      const all = rowsOf(table);
      const doomed = all.filter((r) => matches(r, filters));
      const survivors = all.filter((r) => !matches(r, filters));
      tables.set(table, survivors);
      calls.deletes.push({ table, filters, deleted: doomed.map((r) => ({ ...r })) });
      return { data: wantSelect ? doomed.map((r) => ({ ...r })) : null, error: null };
    };
    const builder = {
      eq(col, val) { filters.push({ op: 'eq', col, val }); return builder; },
      neq(col, val) { filters.push({ op: 'neq', col, val }); return builder; },
      is(col, val) { filters.push({ op: 'is', col, val }); return builder; },
      not(col, op, val) {
        if (op !== 'in') throw new Error(`fake-supabase: unsupported not(${op})`);
        filters.push({ op: 'not_in', col, val });
        return builder;
      },
      select() { wantSelect = true; return builder; },
      then(resolve) { return resolve(run()); },
    };
    return builder;
  }

  function updateBuilder(table, patch) {
    const filters = [];
    const builder = {
      eq(col, val) { filters.push({ op: 'eq', col, val }); return builder; },
      neq(col, val) { filters.push({ op: 'neq', col, val }); return builder; },
      is(col, val) { filters.push({ op: 'is', col, val }); return builder; },
      lt(col, val) { filters.push({ op: 'lt', col, val }); return builder; },
      gte(col, val) { filters.push({ op: 'gte', col, val }); return builder; },
      // Awaiting the chain runs it. Recording the matched count lets a test
      // assert "this sweep touched exactly one row" rather than "a sweep ran".
      then(resolve) {
        const affected = rowsOf(table).filter((r) => matches(r, filters));
        for (const r of affected) Object.assign(r, patch);
        calls.updates.push({ table, patch, filters, affected: affected.length });
        return resolve({ error: null, count: affected.length });
      },
    };
    return builder;
  }

  /* RPCs, implemented against the same stored rows.
   *
   * A stub returning a canned answer would let a broken resume and a working
   * one both pass -- the whole question is which days the caller SKIPS and
   * which rows the sweep REMOVES, and neither is observable unless the fake
   * really computes them from the table. `missingRpcs` lets a test assert the
   * feature-detect path (migration not applied yet) instead of pretending it
   * cannot happen.
   */
  const missingRpcs = new Set();
  const rpcHandlers = {
    shopify_landing_pages_covered_days({ p_company_entity_id, p_shop_domain, p_since, p_until }) {
      const days = new Set(rowsOf('shopify_landing_pages_daily')
        .filter((r) => r.company_entity_id === p_company_entity_id
          && r.shop_domain === p_shop_domain
          && r.day_date >= p_since && r.day_date <= p_until)
        .map((r) => r.day_date));
      return { data: [...days].sort(), error: null };
    },
    shopify_landing_pages_sweep_day({ p_company_entity_id, p_shop_domain, p_day, p_keep_paths }) {
      // Mirrors the function's own guard. An empty keep-list must never mean
      // "delete the whole day" -- that is a bad fetch, not a restatement.
      if (!p_keep_paths || p_keep_paths.length === 0) {
        return { data: null, error: { message: 'refusing to sweep with an empty keep-list' } };
      }
      const keep = new Set(p_keep_paths);
      const all = rowsOf('shopify_landing_pages_daily');
      const doomed = all.filter((r) => r.company_entity_id === p_company_entity_id
        && r.shop_domain === p_shop_domain
        && r.day_date === p_day
        && !keep.has(r.landing_page_path));
      tables.set('shopify_landing_pages_daily', all.filter((r) => !doomed.includes(r)));
      calls.rpcs.push({ fn: 'shopify_landing_pages_sweep_day', deleted: doomed.map((r) => ({ ...r })) });
      return { data: doomed.length, error: null };
    },
  };

  return {
    calls,
    tables,
    rows: (t) => rowsOf(t).map((r) => ({ ...r })),
    /** Make an RPC behave as though its migration has not been applied. */
    breakRpc(name) { missingRpcs.add(name); },
    async rpc(fn, args) {
      calls.rpcs.push({ fn, args });
      if (missingRpcs.has(fn)) {
        return { data: null, error: { code: '42883', message: `function public.${fn} does not exist` } };
      }
      const handler = rpcHandlers[fn];
      if (!handler) throw new Error(`fake-supabase: unstubbed rpc ${fn}`);
      return handler(args || {});
    },
    from(table) {
      return {
        insert(row) {
          const stored = { id: `row-${++autoId}`, ...row };
          rowsOf(table).push(stored);
          calls.inserts.push({ table, row: stored });
          return {
            select: () => ({ single: async () => ({ data: { ...stored }, error: null }) }),
          };
        },
        upsert(rows, opts) {
          const keys = String(opts?.onConflict || '').split(',').map((k) => k.trim()).filter(Boolean);
          if (!keys.length) throw new Error('fake-supabase: upsert without onConflict');
          for (const incoming of rows) {
            const existing = rowsOf(table).find((r) => keys.every((k) => r[k] === incoming[k]));
            if (existing) Object.assign(existing, incoming);
            else rowsOf(table).push({ id: `row-${++autoId}`, ...incoming });
          }
          calls.upserts.push({ table, rows, opts });
          return Promise.resolve({ error: null });
        },
        update(patch) { return updateBuilder(table, patch); },
        delete() { return deleteBuilder(table); },
      };
    },
  };
}
