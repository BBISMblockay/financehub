// Executes the actual Deno request handler with synthetic Supabase/Intuit IO.
// Database semantics (including JSONB scale) are covered by finance-db separately.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import * as postingCore from '../../supabase/functions/quickbooks-post-journal/posting-core.mjs';

const source = await readFile(new URL('../../supabase/functions/quickbooks-post-journal/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/import \{ createClient \} from 'https:[^']+';/, '')
  .replace(/import \{[\s\S]*?\} from '\.\/posting-core\.mjs';/, ''), { mode: 'strip' });
const hash = '0123456789abcdef'.repeat(4);
let scenarios = 0;

function fixture(options = {}) {
  const kind = options.kind || 'adjustment';
  const parentTable = kind === 'card' ? 'card_import_batches' : 'journal_adjustments';
  const sourceName = kind === 'card' ? 'card_import' : 'manual_adjustment';
  const snapshot = {
    schema_version: 1, source: sourceName, source_ref: 'parent-1',
    qbo_connection_id: 'connection-1', period_start: '2026-08-01', period_end: '2026-08-31',
    payload: { TxnDate: '2026-08-31', PrivateNote: 'Synthetic regression fixture', Line: [
      { Amount: 35, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: {
        PostingType: 'Debit', AccountRef: { value: 'expense' },
      } },
      { Amount: 35, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: {
        PostingType: 'Credit', AccountRef: { value: 'cash' },
      } },
    ] },
  };
  const records = {
    profiles: [{ id: 'user-1', active_company_id: 'company-1', is_active: true }],
    [parentTable]: [{ id: 'parent-1', company_entity_id: 'company-1', status: 'approved',
      source_id: 'source-1', accounting_source: sourceName, accounting_source_ref: 'parent-1',
      approval_snapshot: snapshot, approval_hash: hash, approval_version: 4,
      qbo_connection_id: 'connection-1' }],
    card_sources: [{ id: 'source-1', company_entity_id: 'company-1',
      qbo_connection_id: 'connection-1', posting_enabled: true }],
    quickbooks_connections: [{ id: 'connection-1', company_entity_id: 'company-1',
      realm_id: 'synthetic-realm', environment: 'sandbox', is_active: true,
      access_token: 'synthetic-token', token_expires_at: '2999-01-01T00:00:00Z' }],
    plaid_accounts: options.bankException ? [{ id: 'bank-account-1', source_id: 'source-1', company_entity_id: 'company-1' }] : [],
    plaid_sync_exceptions: options.bankException ? [{ id: 'exception-1', account_id: 'bank-account-1', company_entity_id: 'company-1', status: 'open' }] : [],
    quickbooks_journal_postings: options.claimStatus ? [{
      id: 'claim-1', company_entity_id: 'company-1', connection_id: 'connection-1',
      source: sourceName, source_ref: 'parent-1', payload_hash: hash,
      status: options.claimStatus, attempt_count: 1,
      qbo_journal_entry_id: options.claimStatus === 'posted' ? 'existing-qbo-id' : null,
    }] : [],
  };
  const events = [];
  let posts = 0;
  let journal = null;
  let handler;
  let raced = false;
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.op = 'select'; }
    select() { return this; }
    eq(key, value) { this.filters.push([key, [value]]); return this; }
    in(key, values) { this.filters.push([key, values]); return this; }
    order() { return this; }
    limit() { return this; }
    update(values) { this.op = 'update'; this.values = values; return this; }
    insert(values) { this.op = 'insert'; this.values = values; return this; }
    execute(single = false) {
      const rows = records[this.table] || [];
      if (this.op === 'update' && this.table === 'quickbooks_journal_postings'
          && this.values.status === 'unknown' && options.raceBeforeUnknown && !raced) {
        rows[0].status = 'posted'; raced = true;
      }
      if (this.op === 'update' && this.table === 'quickbooks_journal_postings'
          && this.values.status === 'failed' && options.raceBeforeRelease && !raced) {
        rows[0].status = 'posted'; raced = true;
      }
      let selected = rows.filter(row => this.filters.every(([key, values]) => values.includes(row[key])));
      if (this.op === 'insert') {
        if (options.bankExceptionAtClaim && this.table === 'quickbooks_journal_postings') {
          return { data: null, error: { code: 'PBF01', message: 'Resolve the bank feed change before a new posting attempt' } };
        }
        if (options.concurrentClaim && this.table === 'quickbooks_journal_postings') {
          return { data: null, error: { code: '23505', message: 'active claim already exists' } };
        }
        selected = [{ id: 'claim-1', ...structuredClone(this.values) }];
        rows.push(...selected);
      }
      if (this.op === 'update') {
        events.push({ table: this.table, values: structuredClone(this.values), filters: this.filters, matched: selected.length });
        if (options.parentWriteFails && this.table === parentTable) {
          return { data: null, error: { message: 'synthetic local write failure' } };
        }
        selected.forEach(row => Object.assign(row, structuredClone(this.values)));
      }
      return { data: structuredClone(single ? selected[0] || null : selected), error: null };
    }
    maybeSingle() { return Promise.resolve(this.execute(true)); }
    single() { return Promise.resolve(this.execute(true)); }
    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
  }
  const service = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: table => new Query(table),
    rpc: async (name, args) => {
      events.push({ rpc: name, args });
      assert.equal(name, 'finance_approval_hash_matches', 'handler must verify stored JSONB, not a JS round trip');
      assert.deepEqual(JSON.parse(JSON.stringify(args)), {
        p_source_type: parentTable, p_source_id: 'parent-1',
        p_expected_hash: hash, p_expected_version: 4,
      });
      return { data: options.hashMatches !== false, error: options.hashError ? { message: 'synthetic RPC error' } : null };
    },
  };
  const fetchFake = async (url, init = {}) => {
    const parsed = new URL(url);
    if (init.method === 'POST') {
      assert.match(parsed.pathname, /\/journalentry$/);
      posts++;
      const payload = JSON.parse(init.body);
      assert.deepEqual(payload.Line.map(line => line.Amount), [35, 35]);
      if (options.confirmDuringPost) records.quickbooks_journal_postings[0].status = 'posted';
      if (options.postFailure === 'network') throw new Error('synthetic timeout after send');
      if (typeof options.postFailure === 'number') return new Response('synthetic failure', { status: options.postFailure });
      if (options.postFailure === 'missing-id') return Response.json({});
      journal = { Id: 'created-qbo-id', ...payload };
      return Response.json({ JournalEntry: journal });
    }
    if (parsed.pathname.endsWith('/query')) {
      const entries = options.ambiguous ? [ { Id: 'one' }, { Id: 'two' } ]
        : options.recoverExisting ? [{ Id: 'existing-qbo-id', ...postingCore.buildApprovedPayload(snapshot, postingCore.makeDocNumber(hash)) }]
        : [];
      return Response.json({ QueryResponse: { JournalEntry: entries } });
    }
    if (parsed.pathname.includes('/journalentry/')) {
      return journal ? Response.json({ JournalEntry: journal }) : new Response('missing', { status: 404 });
    }
    throw new Error(`Unexpected network path ${parsed.pathname}`);
  };
  vm.runInNewContext(runnable, {
    ...postingCore, Response, Request, URLSearchParams, btoa,
    createClient: (_url, _key, opts) => opts ? {
      rpc: async () => ({ data: options.canManage !== false, error: null }),
    } : service,
    fetch: fetchFake,
    Deno: { env: { get: key => ({ QBO_ENVIRONMENT: 'sandbox' })[key] || 'synthetic' },
      serve: callback => { handler = callback; } },
  }, { filename: 'quickbooks-post-journal/index.ts' });
  return {
    records, events, parentTable, posts: () => posts,
    async request(extra = {}) {
      const response = await handler(new Request('https://silo.test/post-journal', {
        method: 'POST', headers: { Authorization: 'Bearer synthetic-user-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ [kind === 'card' ? 'batch_id' : 'adjustment_id']: 'parent-1', ...extra }),
      }));
      return { status: response.status, body: await response.json() };
    },
  };
}

for (const kind of ['card', 'adjustment']) {
  const f = fixture({ kind });
  const out = await f.request();
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(f.posts(), 1);
  assert.equal(f.records[f.parentTable][0].status, 'posted');
  scenarios++;
}
for (const options of [{ hashMatches: false }, { hashError: true }, { canManage: false }]) {
  const f = fixture(options);
  const out = await f.request();
  assert.equal(out.status, options.canManage === false ? 403 : 409);
  assert.equal(f.posts(), 0);
  assert.equal(f.records.quickbooks_journal_postings.length, 0);
  scenarios++;
}
for (const options of [{ hashMatches: false, bankException: true }, { bankExceptionAtClaim: true }]) {
  const f = fixture({ kind: 'card', ...options });
  const out = await f.request();
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'BANK_FEED_REVIEW_REQUIRED');
  assert.match(out.body.error, /Bank feeds/);
  assert.equal(f.posts(), 0);
  assert.equal(f.records.quickbooks_journal_postings.length, 0);
  scenarios++;
}
for (const ambiguous of [false, true]) {
  const f = fixture({ claimStatus: 'posted', ambiguous });
  for (const extra of [{}, { recovery_action: 'confirm_not_posted', recovery_note: 'Synthetic independent absence check' }]) {
    const out = await f.request(extra);
    assert.equal(out.status, 409);
    assert.equal(out.body.code, 'POSTED_ENTRY_REQUIRES_REVIEW');
    assert.equal(out.body.can_confirm_absent, undefined);
    assert.equal(f.records.quickbooks_journal_postings[0].status, 'posted');
    assert.equal(f.posts(), 0);
    scenarios++;
  }
}
for (const ambiguous of [false, true]) {
  const f = fixture({ claimStatus: 'unknown', raceBeforeUnknown: true, ambiguous });
  const out = await f.request();
  assert.equal(out.status, 502, 'a zero-row CAS failure cannot report successful recovery');
  assert.equal(f.records.quickbooks_journal_postings[0].status, 'posted');
  assert.equal(f.posts(), 0);
  scenarios++;
}
{
  const f = fixture({ claimStatus: 'unknown', raceBeforeRelease: true });
  const out = await f.request({ recovery_action: 'confirm_not_posted',
    recovery_note: 'Synthetic independent absence check' });
  assert.equal(out.status, 502, 'confirmation races fail without releasing a posted claim');
  assert.equal(f.records.quickbooks_journal_postings[0].status, 'posted');
  assert.equal(f.posts(), 0);
  scenarios++;
}
{
  const f = fixture({ claimStatus: 'unknown' });
  const out = await f.request();
  assert.equal(out.body.can_confirm_absent, true);
  assert.equal(f.records.quickbooks_journal_postings[0].status, 'unknown');
  assert.equal(f.posts(), 0);
  scenarios++;
}
for (const postFailure of ['network', 503, 400, 'missing-id']) {
  const f = fixture({ postFailure, confirmDuringPost: true });
  await f.request();
  assert.equal(f.records.quickbooks_journal_postings[0].status, 'posted', 'late failed response cannot downgrade another request\'s confirmation');
  assert.equal(f.posts(), 1);
  scenarios++;
}
{
  const f = fixture({ postFailure: 'network' });
  const out = await f.request();
  assert.equal(out.body.code, 'UNKNOWN_OUTCOME');
  assert.equal(f.records.quickbooks_journal_postings[0].status, 'unknown');
  await f.request();
  assert.equal(f.posts(), 1, 'retry searches QBO without sending another journal');
  scenarios++;
}
{
  const f = fixture({ parentWriteFails: true });
  const out = await f.request();
  assert.equal(out.body.code, 'LOCAL_PERSISTENCE_FAILURE');
  assert.equal(f.records.quickbooks_journal_postings[0].status, 'posted');
  assert.equal(f.records.quickbooks_journal_postings[0].qbo_journal_entry_id, 'created-qbo-id');
  assert.equal(f.records[f.parentTable][0].status, 'approved');
  scenarios++;
}
{
  const f = fixture({ concurrentClaim: true });
  const out = await f.request();
  assert.equal(out.body.code, 'UNKNOWN_OUTCOME');
  assert.equal(f.posts(), 0, 'losing the unique claim never sends to QBO');
  scenarios++;
}
{
  const f = fixture({ claimStatus: 'unknown', recoverExisting: true });
  const out = await f.request();
  assert.equal(out.body.recovered, true);
  assert.equal(f.records.quickbooks_journal_postings[0].status, 'posted');
  assert.equal(f.posts(), 0, 'recovering the existing QBO journal does not post again');
  scenarios++;
}
console.log(`finance-v1-posting-handler: ${scenarios} executed request scenarios passed`);
