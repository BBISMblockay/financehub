// card-categorize as a PREPARATION service: what it records, when, and what it
// refuses to spend tokens on again. The real prepare.ts runs in a vm against a
// fake database and a fake model; nothing touches the network.
//
// Every fixture is invented.
//
// Mutation hooks (the suite must FAIL under each):
//   CATEGORIZE_PERSIST_MUTATION=save-at-end        results recorded only after every call returns
//   CATEGORIZE_PERSIST_MUTATION=facts-before-hash  fingerprints read after the facts
//   CATEGORIZE_PERSIST_MUTATION=reask-prepared     live suggestions ignored, every row asked again
//   CATEGORIZE_PERSIST_MUTATION=ignore-claims      rows another worker holds are asked anyway
//   CATEGORIZE_PERSIST_MUTATION=no-release         a finished request keeps its claim until the lease expires
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCategorizer, prepareSource, fakeDatabase } from './lib/card-categorize-sandbox.mjs';

const MUTATIONS = {
  'save-at-end': [
    ['      out.push(...answers);\n      await persistSlice(answers);', '      out.push(...answers);'],
    ['  timings.model_ms = elapsed(phase);', '  await persistSlice(out as any);\n  timings.model_ms = elapsed(phase);'],
  ],
  'facts-before-hash': [
    ['  const inputHash = new Map<string, string>();\n  for (const part of chunks(transactionIds, 500)) {',
     '  const inputHash = new Map<string, string>();\n  await supabase.from(\'card_transactions_v\').select(\'id\').eq(\'company_entity_id\', companyId);\n  for (const part of chunks(transactionIds, 500)) {'],
  ],
  'reask-prepared': [['    if (!current || current.stale_reason) return true;', '    return true;']],
  'ignore-claims': [['  const pendingRows = unprepared.filter((row) => claimed.has(String(row.id)));', '  const pendingRows = unprepared;']],
  'no-release': [['    await release();', '    void release;']],
};
const mutation = process.env.CATEGORIZE_PERSIST_MUTATION || '';
let source = await prepareSource();
if (mutation) {
  assert.ok(MUTATIONS[mutation], `Unknown mutation ${mutation}`);
  for (const [from, to] of MUTATIONS[mutation]) { assert.ok(source.includes(from), `Stale mutation ${mutation}`); source = source.replace(from, to); }
}

const COMPANY = '00000000-0000-4000-8000-000000000006', BATCH = '00000000-0000-4000-8000-000000000001';
const SOURCE = '00000000-0000-4000-8000-000000000002', CONNECTION = '00000000-0000-4000-8000-000000000005';
const txnId = (i) => `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`;

function fixture({ merchants = 3, live = [], modelFails = () => false, omit = () => false, recordFails = false, delay = () => 0, heldElsewhere = [] } = {}) {
  const claims = [], released = [];
  const transactions = Array.from({ length: merchants }, (_, i) => ({
    id: txnId(i), batch_id: BATCH, company_entity_id: COMPANY, merchant_norm: `vendor ${i}`, card_name: null,
    description: `VENDOR ${i} #44`, amount: 10 + i, currency: 'USD', status: 'uncoded', qbo_account_id: null,
    origin: 'csv', provider_status: null, accounting_treatment: 'unknown', txn_date: '2026-09-10',
  }));
  const records = {
    profiles: [{ id: 'user', active_company_id: COMPANY, is_active: true, role: 'owner', department: 'finance' }],
    entity_memberships: [{ user_id: 'user', entity_id: COMPANY, role: 'owner_admin' }],
    entities: [{ id: COMPANY, title: 'Synthetic Company' }],
    card_import_batches: [{ id: BATCH, company_entity_id: COMPANY, source_id: SOURCE, qbo_connection_id: CONNECTION, status: 'draft', origin: 'csv' }],
    card_sources: [{ id: SOURCE, company_entity_id: COMPANY, source_type: 'card', ingest_mode: 'csv', source_key: 'card',
      qbo_connection_id: CONNECTION, display_name: 'Synthetic Card', is_active: true }],
    quickbooks_connections: [{ id: CONNECTION, company_entity_id: COMPANY, is_active: true }],
    card_transactions_v: transactions,
    card_coding_suggestions_v: live.map((l) => ({ company_entity_id: COMPANY, ...l })),
    quickbooks_accounts: [{ company_entity_id: COMPANY, connection_id: CONNECTION, qbo_account_id: 'supplies', name: 'Supplies', account_type: 'Expense', is_active: true }],
    quickbooks_locations: [], quickbooks_report_runs: [], card_coding_rules: [], qbo_history_imports: [], qbo_history_lines: [],
  };
  const recorded = [];
  const db = fakeDatabase(records, { rpc: {
    card_coding_input_hashes: ({ p_ids }) => ({ data: p_ids.map((id) => ({ transaction_id: id, input_hash: `hash:${id}` })), error: null }),
    // Claims as the database answers them: rows another holder keeps are absent.
    claim_card_coding_preparation: ({ p_ids, p_token }) => {
      const mine = p_ids.filter((id) => !heldElsewhere.includes(id));
      claims.push({ token: p_token, ids: mine });
      return { data: mine, error: null };
    },
    release_card_coding_preparation: ({ p_token }) => { released.push(p_token); return { data: 1, error: null }; },
    record_card_coding_suggestions: ({ p_rows }) => {
      if (recordFails) return { data: null, error: { message: 'synthetic record failure' } };
      recorded.push(...structuredClone(p_rows));
      return { data: { recorded: p_rows.length, skipped: [] }, error: null };
    },
  } });
  const modelCalls = [];
  const { handler } = loadCategorizer(source, {
    console: { ...console, warn() {} },
    createClient: () => db.client,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      const asked = [...body.messages[0].content.matchAll(/merchant: "([^"]+)"/g)].map((m) => m[1]);
      modelCalls.push(asked);
      db.timeline.push(`model:${asked.length}`);
      await new Promise((r) => setTimeout(r, delay(asked)));
      db.timeline.push(`model-done:${asked.length}`);
      if (modelFails(asked)) return new Response('overloaded', { status: 529 });
      return Response.json({ content: [{ type: 'text', text: JSON.stringify({ suggestions: asked.filter((m) => !omit(m)).map((merchant) => ({
        merchant, card_name: null, account_name: 'Supplies', location_name: null, vendor_name: merchant, confidence: 0.7, reasoning: 'Synthetic.' })) }) }],
        stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } });
    },
  });
  const run = async (ids = transactions.map((t) => t.id), body = {}) => {
    const response = await handler(new Request('https://silo.test/card-categorize', { method: 'POST',
      headers: { Authorization: 'Bearer user', 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch_id: BATCH, transaction_ids: ids, ...body }) }));
    return { status: response.status, body: await response.json() };
  };
  return { db, recorded, modelCalls, run, transactions, claims, released };
}

test('each finished model call is recorded before the slowest one returns; a failed call is recorded as failed', async () => {
  // 50 merchants = two slices of 40 and 10. The slice holding "vendor 45"
  // fails; the other completes first and is saved while the failure is pending.
  const h = fixture({ merchants: 50, modelFails: (asked) => asked.includes('vendor 45'), delay: (asked) => asked.includes('vendor 45') ? 30 : 0 });
  const { status, body } = await h.run();
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(h.modelCalls.length, 2);
  const firstRecord = h.db.timeline.indexOf('rpc:record_card_coding_suggestions');
  const slowDone = h.db.timeline.indexOf('model-done:10');
  assert.ok(firstRecord > 0 && slowDone > 0 && firstRecord < slowDone,
    `the fast slice is saved before the slow one returns: ${h.db.timeline.join(' ')}`);
  const byOutcome = (o) => h.recorded.filter((r) => r.outcome === o).length;
  assert.equal(byOutcome('suggested'), 40, 'the finished slice survives its neighbour failing');
  assert.equal(byOutcome('failed'), 10);
  assert.match(h.recorded.find((r) => r.outcome === 'failed').error_code, /anthropic_529/);
  assert.equal(body.run_status, 'partial'); assert.equal(body.suggested, 40); assert.equal(body.failed, 10);
  const finalRun = h.db.runs[0];
  assert.equal(finalRun.status, 'partial'); assert.equal(finalRun.model_calls, 2); assert.equal(finalRun.model_calls_failed, 1);
  assert.equal(finalRun.suggestions_recorded, 40); assert.equal(finalRun.failures_recorded, 10);
  assert.ok(finalRun.finished_at);
  assert.deepEqual(h.db.writes, [], 'nothing but the run log is written directly');
});

test('timings and token usage are measured and stored on the run', async () => {
  const h = fixture({ merchants: 3 });
  const { body } = await h.run();
  const run = h.db.runs[0];
  for (const key of ['auth_ms', 'load_ms', 'context_ms', 'history_ms', 'model_ms', 'persist_ms', 'total_ms']) {
    assert.equal(typeof run.timings[key], 'number', `${key} is recorded`);
    assert.ok(run.timings[key] >= 0);
  }
  assert.equal(run.timings.model_call_ms.length, 1);
  assert.deepEqual(run.usage, { input_tokens: 1000, output_tokens: 200 });
  assert.equal(run.trigger, 'manual'); assert.equal(run.requested_by, 'user');
  assert.equal(run.transactions_requested, 3); assert.equal(run.groups_requested, 1 * 3);
  assert.match(run.prompt_version, /^card-categorize\//);
  assert.deepEqual(body.token_usage, run.usage);
  assert.equal(run.status, 'completed');
});

test('the fingerprint a suggestion carries is read before the facts the model is shown', async () => {
  const h = fixture({ merchants: 2 });
  await h.run();
  const hashRead = h.db.timeline.indexOf('rpc:card_coding_input_hashes');
  const factRead = h.db.timeline.indexOf('from:card_transactions_v');
  assert.ok(hashRead >= 0 && factRead > hashRead, `fingerprints first, facts second: ${h.db.timeline.join(' ')}`);
  for (const r of h.recorded) assert.equal(r.expected_input_hash, `hash:${r.transaction_id}`);
});

test('a model that omits a line records a retryable failure, never a silent gap', async () => {
  const h = fixture({ merchants: 3, omit: (m) => m === 'vendor 1' });
  await h.run();
  const omitted = h.recorded.find((r) => r.transaction_id === txnId(1));
  assert.equal(omitted.outcome, 'failed'); assert.equal(omitted.error_code, 'model_omitted_line');
  assert.equal(h.recorded.filter((r) => r.outcome === 'suggested').length, 2);
});

test('prepared work is not paid for again: live suggestions are skipped, failures and stale ones re-asked', async () => {
  const live = [
    { transaction_id: txnId(0), review_status: 'open', outcome: 'suggested', stale_reason: null },
    { transaction_id: txnId(1), review_status: 'dismissed', outcome: 'suggested', stale_reason: null },
    { transaction_id: txnId(2), review_status: 'open', outcome: 'needs_judgment', stale_reason: null },
    { transaction_id: txnId(3), review_status: 'open', outcome: 'failed', stale_reason: null },
    { transaction_id: txnId(4), review_status: 'open', outcome: 'suggested', stale_reason: 'facts_changed' },
  ];
  const h = fixture({ merchants: 6, live });
  const { body } = await h.run();
  assert.deepEqual(h.modelCalls.flat().sort(), ['vendor 3', 'vendor 4', 'vendor 5']);
  assert.equal(body.already_prepared, 3);
  // Everything already prepared: no run, no model call.
  const done = fixture({ merchants: 1, live: [live[0]] });
  const out = await done.run();
  assert.equal(out.body.run_id, null); assert.equal(done.modelCalls.length, 0); assert.equal(done.db.runs.length, 0);
});

test('an explicit retry asks again about the rows named, dismissed ones included', async () => {
  const live = [
    { transaction_id: txnId(0), review_status: 'dismissed', outcome: 'suggested', stale_reason: null },
    { transaction_id: txnId(1), review_status: 'open', outcome: 'needs_judgment', stale_reason: null },
  ];
  const h = fixture({ merchants: 2, live });
  const { body } = await h.run(undefined, { retry: true });
  assert.equal(h.modelCalls.flat().length, 2);
  assert.equal(h.db.runs[0].trigger, 'retry');
  assert.equal(h.db.rpcCalls.find((c) => c.name === 'record_card_coding_suggestions').args.p_retry, true);
  assert.equal(body.already_prepared, 0);
});

test('a writer failure leaves the run marked failed and says so', async () => {
  const h = fixture({ merchants: 2, recordFails: true });
  const { status, body } = await h.run();
  assert.equal(status, 200);
  assert.equal(body.run_status, 'failed'); assert.match(body.errors.join(' '), /record: synthetic record failure/);
  assert.equal(h.db.runs[0].status, 'failed');
});

test('retry must be a boolean; the endpoint still refuses malformed requests', async () => {
  const h = fixture({ merchants: 1 });
  const { status } = await h.run(undefined, { retry: 'yes' });
  assert.equal(status, 400);
  assert.equal(h.modelCalls.length, 0);
});

test('rows another worker or click holds are left to it, and this request releases its own claim', async () => {
  const h = fixture({ merchants: 3, heldElsewhere: [txnId(1)] });
  const { body } = await h.run();
  assert.deepEqual(h.modelCalls.flat().sort(), ['vendor 0', 'vendor 2']);
  assert.equal(body.in_progress, 1);
  assert.equal(h.claims.length, 1); assert.deepEqual(h.released, [h.claims[0].token]);
  const hashes = h.db.timeline.indexOf('rpc:card_coding_input_hashes'), claim = h.db.timeline.indexOf('rpc:claim_card_coding_preparation');
  const firstModel = h.db.timeline.findIndex((e) => e.startsWith('model:'));
  assert.ok(hashes < claim && claim < firstModel, 'rows are claimed before any model call is paid for');
});

test('a claim is released even when every model call fails', async () => {
  const h = fixture({ merchants: 2, modelFails: () => true });
  await h.run();
  assert.equal(h.released.length, 1);
  assert.equal(h.db.runs[0].status, 'failed');
});

test('everything held elsewhere: no run, no model call, and the reason is reported', async () => {
  const h = fixture({ merchants: 2, heldElsewhere: [txnId(0), txnId(1)] });
  const { body } = await h.run();
  assert.equal(body.run_id, null); assert.equal(body.in_progress, 2);
  assert.equal(h.modelCalls.length, 0); assert.equal(h.db.runs.length, 0);
});

test('the scheduler path skips a row a person coded since selection instead of refusing the import', async () => {
  // Driven through prepareCoding() exactly as the scheduled worker calls it:
  // explicit company and batch, no person, background trigger.
  const h = fixture({ merchants: 3 });
  h.transactions[1].status = 'coded'; h.transactions[1].qbo_account_id = 'supplies';
  const { exports } = (await import('./lib/card-categorize-sandbox.mjs')).loadCategorizer(source, {
    console: { ...console, warn() {} }, createClient: () => h.db.client,
    fetch: async (url, init) => {
      const asked = [...JSON.parse(init.body).messages[0].content.matchAll(/merchant: "([^"]+)"/g)].map((m) => m[1]);
      h.modelCalls.push(asked);
      return Response.json({ content: [{ type: 'text', text: JSON.stringify({ suggestions: asked.map((merchant) => ({ merchant, card_name: null,
        account_name: 'Supplies', location_name: null, vendor_name: null, confidence: 0.7, reasoning: 'Synthetic.' })) }) }], stop_reason: 'end_turn', usage: {} });
    },
  });
  const result = await exports.prepareCoding(h.db.client, { companyId: COMPANY, batchId: BATCH, transactionIds: h.transactions.map((t) => t.id),
    trigger: 'background', requestedBy: null, retry: false, skipIneligible: true });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.skipped_ineligible, 1);
  assert.deepEqual(h.modelCalls.flat().sort(), ['vendor 0', 'vendor 2']);
  assert.equal(h.db.runs[0].trigger, 'background'); assert.equal(h.db.runs[0].requested_by, null);
  // The bookkeeper's endpoint keeps its strict refusal for the same situation.
  const strict = fixture({ merchants: 2 }); strict.transactions[0].status = 'coded'; strict.transactions[0].qbo_account_id = 'supplies';
  assert.equal((await strict.run()).status, 409);
});

test('with no model key nothing is claimed or recorded, so no row burns its retries', async () => {
  const h = fixture({ merchants: 1 });
  const { exports } = (await import('./lib/card-categorize-sandbox.mjs')).loadCategorizer(source, {
    console: { ...console, warn() {} }, createClient: () => h.db.client, fetch: async () => { throw new Error('no model call expected'); },
    env: (key) => (key === 'ANTHROPIC_API_KEY' ? '' : 'synthetic'),
  });
  const result = await exports.prepareCoding(h.db.client, { companyId: COMPANY, batchId: BATCH, transactionIds: [txnId(0)],
    trigger: 'background', requestedBy: null, retry: false, skipIneligible: true });
  assert.equal(result.status, 503); assert.match(result.body.error, /ANTHROPIC_API_KEY/);
  assert.equal(h.claims.length, 0); assert.equal(h.recorded.length, 0); assert.equal(h.db.runs.length, 0);
});
