// Loads the real card-categorize preparation service into a vm sandbox, with
// no network: the caller supplies createClient (a fake database) and fetch (a
// fake model). Shared by every categorizer suite so they execute one file the
// same way -- prepare.ts, the module both the user endpoint and the scheduled
// worker serve.
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { historyEvidence } from './history-evidence-fake.mjs';

export const PREPARE_URL = new URL('../../../supabase/functions/card-categorize/prepare.ts', import.meta.url);
export const prepareSource = () => readFile(PREPARE_URL, 'utf8');

// Returns the Deno.serve callback index.ts would install, plus the module's
// own exports for suites that drive prepareCoding() directly.
export function loadCategorizer(source, { createClient, fetch, env = () => 'synthetic', console: log = console }) {
  const runnable = stripTypeScriptTypes(source.replace(/^export /gm, ''), { mode: 'strip' })
    + '\nDeno.serve(createCategorizeHandler({ createDb: () => createClient() }));'
    + '\nglobalThis.__exports = { prepareCoding, PROMPT_VERSION, buildEvidence };';
  let handler;
  const context = {
    Request, Response, AbortSignal, performance, crypto: globalThis.crypto, console: log, createClient, fetch,
    Deno: { env: { get: env }, serve: (callback) => { handler = callback; } },
  };
  vm.runInNewContext(runnable, context);
  return { handler, exports: context.__exports };
}

// A small in-memory stand-in for the supabase-js query builder: filters,
// ordering and ranges over plain records, plus the two writes the preparer is
// allowed (the run log and the suggestion writer RPC). Every other write
// throws, so "the preparer never writes card_transactions" is enforced by the
// fake itself rather than by an assertion someone could forget.
export function fakeDatabase(records, { rpc = {}, fail = {} } = {}) {
  const timeline = [], writes = [], runs = [], rpcCalls = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.orders = []; this.single_ = false; this.offset = 0; this.max = Infinity; }
    select(columns) { this.columns = columns; return this; }
    eq(k, v) { this.filters.push(['eq', k, v]); return this; }
    in(k, v) { this.filters.push(['in', k, v]); return this; }
    not(k, _op, v) { this.filters.push(['not', k, v]); return this; }
    gte(k, v) { this.filters.push(['gte', k, v]); return this; }
    lte(k, v) { this.filters.push(['lte', k, v]); return this; }
    or(v) { this.filters.push(['or', v]); return this; }
    order(k, o) { this.orders.push([k, o?.ascending !== false]); return this; }
    limit(n) { this.max = n; return this; }
    range(a, b) { this.offset = a; this.max = b - a + 1; return this; }
    insert(value) {
      if (this.table !== 'card_coding_preparation_runs') { writes.push([this.table, value]); throw new Error(`Preparer must not write ${this.table}`); }
      const row = { id: `run-${runs.length + 1}`, ...structuredClone(value) }; runs.push(row); this.result = { data: { id: row.id }, error: null }; return this;
    }
    update(value) {
      if (this.table !== 'card_coding_preparation_runs') { writes.push([this.table, value]); throw new Error(`Preparer must not write ${this.table}`); }
      this.patch = value; return this;
    }
    delete() { writes.push([this.table, 'delete']); throw new Error(`Preparer must not delete ${this.table}`); }
    execute() {
      if (this.result) return this.result;
      if (this.patch) {
        for (const run of runs) if (this.filters.every(([op, k, v]) => op === 'eq' && run[k] === v)) Object.assign(run, structuredClone(this.patch));
        return { data: null, error: null };
      }
      timeline.push(`from:${this.table}`);
      if (fail[this.table]) return { data: null, error: { message: `synthetic ${this.table} failure` } };
      let rows = (records[this.table] || []).filter((row) => this.filters.every(([op, k, v]) => {
        if (op === 'eq') return row[k] === v;
        if (op === 'in') return v.includes(row[k]);
        if (op === 'not') return row[k] !== v;
        if (op === 'gte') return row[k] >= v;
        if (op === 'lte') return row[k] <= v;
        if (op === 'or') return k.split(',').some((part) => { const [f, c, e] = part.split('.'); return c === 'is' ? row[f] == null : row[f] === e; });
        throw new Error(`Unsupported filter ${op}`);
      }));
      for (const [k, asc] of [...this.orders].reverse()) rows.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (asc ? 1 : -1));
      rows = rows.slice(this.offset, this.offset + this.max);
      return { data: structuredClone(this.single_ ? rows[0] ?? null : rows), error: null };
    }
    maybeSingle() { this.single_ = true; return Promise.resolve(this.execute()); }
    single() { this.single_ = true; return Promise.resolve(this.execute()); }
    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
  }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user' } }, error: null }) },
    from: (table) => new Query(table),
    rpc: async (name, args) => {
      timeline.push(`rpc:${name}`); rpcCalls.push({ name, args: structuredClone(args) });
      if (rpc[name]) return rpc[name](args);
      // Defaults for the two reads every preparation makes: no saved rule
      // answers anything, and history is what the records hold.
      if (name === 'card_coding_rule_answered') return { data: [], error: null };
      if (name === 'card_coding_history_evidence') {
        return historyEvidence({ ...records, card_transactions: records.card_transactions || records.card_transactions_v || [] }, args);
      }
      throw new Error(`Unexpected rpc ${name}`);
    },
  };
  return { client, timeline, writes, runs, rpcCalls };
}
