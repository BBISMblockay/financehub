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
 *
 * Filters are evaluated against stored rows, so a test can assert on the
 * table's resulting CONTENT rather than on call shapes.
 */

let autoId = 0;

export function createFakeSupabase() {
  /** @type {Map<string, object[]>} */
  const tables = new Map();
  const calls = { inserts: [], upserts: [], updates: [] };

  const rowsOf = (t) => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t);
  };

  const matches = (row, filters) => filters.every((f) => {
    const v = row[f.col];
    if (f.op === 'eq') return v === f.val;
    if (f.op === 'neq') return v !== f.val;
    if (f.op === 'is') return f.val === null ? (v === null || v === undefined) : v === f.val;
    if (f.op === 'lt') return v != null && v < f.val;
    if (f.op === 'gte') return v != null && v >= f.val;
    throw new Error(`fake-supabase: unsupported filter ${f.op}`);
  });

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

  return {
    calls,
    tables,
    rows: (t) => rowsOf(t).map((r) => ({ ...r })),
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
      };
    },
  };
}
