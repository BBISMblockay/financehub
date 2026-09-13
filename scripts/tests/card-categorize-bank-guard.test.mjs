// Execute the real categorizer callback; no Anthropic or database network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../../supabase/functions/card-categorize/index.ts', import.meta.url), 'utf8');
const effectiveSource=process.env.BANK_AI_MUTATION==='clearing-account' ? source.replace("const canSuggestAccount = !!candidate && (allowedTypes[treatment] || []).includes(candidate.type);",'const canSuggestAccount = true;') : source;
const runnable = stripTypeScriptTypes(effectiveSource.replace(/import \{ createClient \} from 'https:[^']+';/, ''), { mode: 'strip' });
const ids = { batch: '00000000-0000-4000-8000-000000000001', source: '00000000-0000-4000-8000-000000000002',
  tx: '00000000-0000-4000-8000-000000000003', otherTx: '00000000-0000-4000-8000-000000000004',
  connection: '00000000-0000-4000-8000-000000000005', company: '00000000-0000-4000-8000-000000000006' };

function fixture(options = {}) {
  const records = {
    profiles: [{ id: 'user', active_company_id: ids.company, is_active: true, role: 'owner', department: 'finance' }],
    entity_memberships: [{ user_id: 'user', entity_id: ids.company, role: 'owner_admin' }],
    entities: [{ id: ids.company, title: 'Synthetic Company' }],
    card_import_batches: [{ id: ids.batch, company_entity_id: ids.company, source_id: ids.source,
      qbo_connection_id: ids.connection, status: 'draft', origin: 'plaid', ...options.batch }],
    card_sources: [{ id: ids.source, company_entity_id: ids.company, source_type: 'card', ingest_mode: 'plaid',
      qbo_connection_id: ids.connection, display_name: 'Database Card Name', is_active: true, ...options.source }],
    quickbooks_connections: [{ id: ids.connection, company_entity_id: ids.company, is_active: true, ...options.connection }],
    card_transactions_v: [{ id: ids.tx, batch_id: ids.batch, company_entity_id: ids.company,
      merchant_norm: 'store', card_name: 'Supplies', description: 'Actual store descriptor', amount: 19.99,
      currency: 'USD', status: 'uncoded', qbo_account_id: null, origin: 'plaid', provider_status: 'posted',
      accounting_treatment: 'purchase', ...options.transaction }],
    quickbooks_accounts: [
      { company_entity_id: ids.company, connection_id: ids.connection, qbo_account_id: 'expense',
        name: 'Supplies expense', account_type: 'Expense', is_active: true },
      { company_entity_id: ids.company, connection_id: 'foreign-connection', qbo_account_id: 'foreign',
        name: 'FOREIGN REALM ACCOUNT', account_type: 'Expense', is_active: true },
      { company_entity_id: ids.company, connection_id: 'foreign-connection', qbo_account_id: 'interco',
        name: 'FOREIGN REALM Receivable', account_type: 'Accounts Receivable', is_active: true },
    ],
    quickbooks_locations: [
      { company_entity_id: ids.company, connection_id: ids.connection, name: 'HQ', is_active: true },
      { company_entity_id: ids.company, connection_id: 'foreign-connection', name: 'FOREIGN REALM LOCATION', is_active: true },
    ],
    quickbooks_report_runs: [{ company_entity_id: ids.company, connection_id: 'foreign-connection', report_name: 'ProfitAndLoss',
      status: 'ok', raw_response: { ColData: [{ id: 'expense' }, { value: '987654321' }] }, start_date: 'FOREIGN YEAR', end_date: 'FOREIGN YEAR' }],
    card_coding_rules: [],
  };
  const queries = [], modelCalls = [], writes = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.singleResult = false; this.maxRows = Infinity; }
    select(columns) { this.columns = columns; return this; }
    eq(key, value) { this.filters.push(['eq', key, value]); return this; }
    in(key, value) { this.filters.push(['in', key, value]); return this; }
    not(key, operator, value) { this.filters.push(['not', key, value]); return this; }
    or(value) { this.filters.push(['or', value]); return this; }
    order() { return this; }
    limit(count) { this.maxRows = count; return this; }
    range(from, to) { this.offset = from; this.maxRows = to - from + 1; return this; }
    update(value) { writes.push(value); throw new Error('Categorizer must not write'); }
    insert(value) { writes.push(value); throw new Error('Categorizer must not write'); }
    delete() { throw new Error('Categorizer must not delete'); }
    execute() {
      queries.push({ table: this.table, filters: structuredClone(this.filters), columns: this.columns });
      if (options.queryFailure === this.table) return { data: null, error: { message: 'synthetic read failure' } };
      const rows = (records[this.table] || []).filter((row) => this.filters.every(([op, key, value]) => {
        if (op === 'eq') return row[key] === value;
        if (op === 'in') return value.includes(row[key]);
        if (op === 'not') return row[key] !== value;
        if (op === 'or') return key.split(',').some((part) => {
          const [field, comparator, expected] = part.split('.');
          return comparator === 'is' ? row[field] == null : row[field] === expected;
        });
        throw new Error(`Unsupported filter ${op}`);
      })).slice(this.offset || 0, (this.offset || 0) + this.maxRows);
      return { data: structuredClone(this.singleResult ? rows[0] ?? null : rows), error: null };
    }
    maybeSingle() { this.singleResult = true; return Promise.resolve(this.execute()); }
    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
  }
  let handler;
  vm.runInNewContext(runnable, {
    Request, Response, console,
    Deno: { env: { get: () => 'synthetic' }, serve: (callback) => { handler = callback; } },
    createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user' } }, error: null }) }, from: (table) => new Query(table) }),
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      modelCalls.push(JSON.parse(init.body));
      return Response.json({ content: [{ type: 'text', text: JSON.stringify({ suggestions: [{ merchant: 'store', card_name: 'Supplies',
        direction: 'outflow', accounting_treatment: 'purchase', account_name: 'Supplies expense', location_name: 'HQ', vendor_name: 'Store', confidence: 0.9, reasoning: 'Synthetic purchase.', ...options.suggestion }] }) }], stop_reason: 'end_turn' });
    },
  });
  return { records, queries, modelCalls, writes, async run(body = {}) {
    const response = await handler(new Request('https://silo.test/card-categorize', { method: 'POST',
      headers: { Authorization: 'Bearer test-user', 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch_id: ids.batch, transaction_ids: [ids.tx],
        merchants: [{ merchant: 'FORGED MERCHANT', card_name: 'FORGED CARD', sample: 'FORGED DESCRIPTOR', total: 999999, count: 123 }],
        source_name: 'FORGED SOURCE', ...body }),
    }));
    return { status: response.status, body: await response.json() };
  } };
}

test('actual Plaid purchase rebuilds merchant/source context from scoped stored rows', async () => {
  const h = fixture(); const result = await h.run();
  assert.equal(result.status, 200); assert.equal(result.body.suggestions[0].merchant, 'store');
  assert.equal(h.modelCalls.length, 1);
  assert.match(h.modelCalls[0].messages[0].content, /Actual store descriptor/);
  assert.match(h.modelCalls[0].messages[0].content, /19\.99/);
  assert.match(h.modelCalls[0].system, /Database Card Name/);
  assert.equal(JSON.stringify(h.modelCalls).includes('FORGED'), false);
  assert.equal(h.writes.length, 0);
});

test('bank source requests a COA category with transaction type as supporting metadata', async () => {
  const h = fixture({ source: { source_type: 'bank' } });
  const result=await h.run();
  assert.equal(result.status, 200); assert.equal(h.modelCalls.length, 1);
  assert.match(h.modelCalls[0].system,/Suggest an actual account_name from the chart/);
  assert.equal(result.body.suggestions[0].accounting_treatment,'purchase');
});

test('incompatible expense suggestions are stripped for clearing, deposit and unknown treatments', async () => {
  for(const accounting_treatment of ['transfer','card_payment','payroll_settlement','shopify_settlement','deposit','unknown','invented']) {
    const h=fixture({source:{source_type:'bank'},transaction:{amount:accounting_treatment==='deposit'?-20:20},suggestion:{accounting_treatment,direction:accounting_treatment==='deposit'?'inflow':'outflow'}});
    const result=await h.run(), s=result.body.suggestions[0];
    assert.equal(result.status,200); assert.equal(s.account_name,null,accounting_treatment); assert.equal(s.location_name,null);
    assert.equal(s.accounting_treatment,accounting_treatment==='invented'?'unknown':accounting_treatment);
    assert.match(s.reasoning,/Model account suggestion discarded/);
    assert.equal(h.writes.length,0);
  }
});
test('bank inflow refunds can suggest an account but contradictory purchase direction cannot',async()=>{
  for(const treatment of ['refund','purchase']) {
    const h=fixture({source:{source_type:'bank'},transaction:{amount:-25,accounting_treatment:'unknown'},suggestion:{direction:'inflow',accounting_treatment:treatment}});
    const s=(await h.run()).body.suggestions[0];
    assert.equal(s.account_name,treatment==='refund'?'Supplies expense':null);
  }
});

test('Plaid inflow, transfer, card payment, pending, removed and excluded rows never reach the model', async () => {
  for (const transaction of [{ amount: -19.99 }, { amount: 0 }, { provider_status: 'pending' }, { provider_status: 'removed' },
    { accounting_treatment: 'transfer' }, { accounting_treatment: 'card_payment' }, { accounting_treatment: 'payroll_settlement' },
    { accounting_treatment: 'shopify_settlement' }, { accounting_treatment: 'unknown' }, { accounting_treatment: 'prepaid' },
    { currency: 'EUR' }, { status: 'excluded' }, { status: 'coded', qbo_account_id: 'expense' }]) {
    const h = fixture({ transaction }); const result = await h.run();
    assert.equal(result.status, 409, JSON.stringify(transaction)); assert.equal(h.modelCalls.length, 0);
  }
});

test('foreign company, foreign batch and unknown transaction IDs are rejected', async () => {
  for (const options of [{ batch: { company_entity_id: 'foreign-company' } },
    { transaction: { batch_id: 'foreign-batch' } }, { transaction: { company_entity_id: 'foreign-company' } }]) {
    const h = fixture(options); assert.ok((await h.run()).status >= 400); assert.equal(h.modelCalls.length, 0);
  }
  const h = fixture(); assert.ok((await h.run({ transaction_ids: [ids.otherTx] })).status >= 400); assert.equal(h.modelCalls.length, 0);
});

test('frozen batch and unbound, inactive or mismatched QBO connections are rejected', async () => {
  for (const options of [{ batch: { status: 'approved' } }, { batch: { status: 'posted' } },
    { source: { qbo_connection_id: null } }, { source: { is_active: false } },
    { batch: { qbo_connection_id: 'different-connection' } }, { connection: { is_active: false } },
    { connection: { company_entity_id: 'foreign-company' } }]) {
    const h = fixture(options); assert.ok((await h.run()).status >= 400); assert.equal(h.modelCalls.length, 0);
  }
});

test('QBO chart, locations and usage context are filtered to the source connection', async () => {
  const h = fixture(); const result = await h.run(); assert.equal(result.status, 200);
  assert.equal(JSON.stringify(h.modelCalls).includes('FOREIGN REALM'), false);
  assert.equal(result.body.usage_from, null);
  for (const query of h.queries.filter((q) => ['quickbooks_accounts', 'quickbooks_locations', 'quickbooks_report_runs'].includes(q.table))) {
    assert.ok(query.filters.some(([op, column, value]) => op === 'eq' && column === 'connection_id' && value === ids.connection), query.table);
  }
});

test('existing CSV purchase coding still works within a valid stored card batch', async () => {
  const h = fixture({ batch: { origin: 'csv', qbo_connection_id: null }, source: { ingest_mode: 'csv' },
    transaction: { origin: 'csv', provider_status: null, accounting_treatment: 'unknown' } });
  assert.equal((await h.run()).status, 200); assert.equal(h.modelCalls.length, 1);
});

test('missing, malformed and duplicate row selection is rejected before model dispatch', async () => {
  for (const body of [{ batch_id: null }, { transaction_ids: null }, { transaction_ids: [] },
    { transaction_ids: ['not-a-uuid'] }, { transaction_ids: [ids.tx, ids.tx] }]) {
    const h = fixture(); assert.equal((await h.run(body)).status, 400); assert.equal(h.modelCalls.length, 0);
  }
});

test('failed source or transaction reads never fall back to caller merchant data', async () => {
  for (const queryFailure of ['card_import_batches', 'card_sources', 'card_transactions_v', 'quickbooks_connections']) {
    const h = fixture({ queryFailure }); assert.ok((await h.run()).status >= 400); assert.equal(h.modelCalls.length, 0);
  }
});

test('bank categories return a scoped COA ID for supported revenue, clearing, and card destinations',async()=>{
 for(const [treatment,type,name,amount] of [
  ['deposit','Income','Retail sales',-20],['transfer','Other Current Asset','Transfer clearing',20],
  ['payroll_settlement','Other Current Liability','Payroll clearing',20],
  ['shopify_settlement','Other Current Asset','Shopify clearing',-20],
  ['card_payment','Credit Card','Amex payable',20],['card_payment','Accounts Payable','Divvy payable',20]
 ]) {
  const h=fixture({source:{source_type:'bank'},transaction:{amount,accounting_treatment:'unknown'},suggestion:{accounting_treatment:treatment,direction:amount<0?'inflow':'outflow',account_name:name}});
  h.records.quickbooks_accounts.push({company_entity_id:ids.company,connection_id:ids.connection,qbo_account_id:'destination',name,account_type:type,is_active:true});
  const s=(await h.run()).body.suggestions[0];
  assert.equal(s.account_name,name);assert.equal(s.account_id,'destination');assert.equal(s.accounting_treatment,treatment);
  assert.match(h.modelCalls[0].system,new RegExp(name));assert.equal(h.writes.length,0);
 }
});
test('invented, duplicate, inactive, and foreign destination accounts cannot become COA suggestions',async()=>{
 for(const kind of ['invented','duplicate','inactive','foreign']) {
  const h=fixture({source:{source_type:'bank'},suggestion:{accounting_treatment:'card_payment',account_name:'Amex payable'}});
  const account={company_entity_id:ids.company,connection_id:ids.connection,qbo_account_id:'card',name:'Amex payable',account_type:'Credit Card',is_active:true};
  if(kind==='duplicate')h.records.quickbooks_accounts.push(account,{...account,qbo_account_id:'other'});
  if(kind==='inactive')h.records.quickbooks_accounts.push({...account,is_active:false});
  if(kind==='foreign')h.records.quickbooks_accounts.push({...account,connection_id:'foreign-connection'});
  const s=(await h.run()).body.suggestions[0];assert.equal(s.account_name,null);assert.equal(s.account_id,null);assert.equal(s.confidence,0);
 }
});
test('bank deposit outflows cannot be suggested as revenue',async()=>{
 const h=fixture({source:{source_type:'bank'},suggestion:{accounting_treatment:'deposit',account_name:'Revenue'}});
 h.records.quickbooks_accounts.push({company_entity_id:ids.company,connection_id:ids.connection,qbo_account_id:'income',name:'Revenue',account_type:'Income',is_active:true});
 const s=(await h.run()).body.suggestions[0];assert.equal(s.account_name,null);assert.equal(s.accounting_treatment,'unknown');
});
