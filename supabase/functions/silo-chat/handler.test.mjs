/* Ask SILO REQUEST-HANDLER assertions -- the real Deno.serve callback, run.
 *
 * Why this file exists, stated bluntly: the 2026-09-16 audit found five
 * reliability defects in this function, and the two suites that already
 * guarded it (prompt.test.mjs, seo-orchestration.test.mjs) passed on every
 * one of them. They had to: both assert on SOURCE TEXT. A prompt rule can be
 * checked that way because a prompt IS text. A handler cannot -- "the answer
 * returned is the whole answer" is a statement about what the code DOES, and
 * no amount of string matching reaches it. Two of the five bugs (the
 * truncated-answer continuation, the swallowed audit rejection) lived in five
 * lines each and read perfectly in review.
 *
 * So this runs the actual exported handler out of index.ts, with the model
 * API and the database mocked, and asserts on the Response it produces and
 * the rows it writes.
 *
 * How index.ts is loaded: it is Deno, so it imports npm:/jsr: specifiers and
 * registers its handler via Deno.serve. Both are substitutable --
 * `globalThis.Deno` is stubbed before import (serve() just captures the
 * callback), and the two non-Node imports are rewritten to local stubs in a
 * copy written to a temp file. Nothing else about the source is touched; in
 * particular the handler body is the file's own, so a change there is a change
 * here. Node strips the TypeScript annotations on import.
 *
 * Needs Node 22.18+ (TypeScript type-stripping on by default). On an older
 * Node, run it with --experimental-strip-types.
 *
 * Run: node supabase/functions/silo-chat/handler.test.mjs
 */
import { CATALOG_FIXTURE, COMBINED_SPEND_SQL, COMBINED_SPEND_ROWS, PER_PLATFORM_SQL, PER_PLATFORM_ROWS } from './evidence-fixtures.mjs';
import {
  correctionRoundFits, modelCallTimeoutMs,
  GATEWAY_SAFE_MS, MODEL_CALL_FLOOR_MS, QUERY_CEILING_MS, MIN_FINAL_CALL_MS, WORKER_WALL_CLOCK_MS,
} from './budget-lib.mjs';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, 'index.ts');
const SEO_LIB_URL = pathToFileURL(join(HERE, 'seo-lib.mjs')).href;
const EVIDENCE_LIB_URL = pathToFileURL(join(HERE, 'evidence-scope.mjs')).href;
const BUDGET_LIB_URL = pathToFileURL(join(HERE, 'budget-lib.mjs')).href;
const PROMPT_LIB_URL = pathToFileURL(join(HERE, 'prompt-lib.mjs')).href;
const PROVIDER_LIB_URL = pathToFileURL(join(HERE, 'provider-lib.mjs')).href;
const QUERY_SHAPE_LIB_URL = pathToFileURL(join(HERE, 'query-shape-lib.mjs')).href;
const KEEPALIVE_LIB_URL = pathToFileURL(join(HERE, 'keepalive-lib.mjs')).href;
const CREDIT_LIB_URL = pathToFileURL(join(HERE, 'ai-credit-lib.mjs')).href;
const REPORTS_LIB_URL = pathToFileURL(join(HERE, 'silo-reports-lib.mjs')).href;
const REPORT_PARAMS_LIB_URL = pathToFileURL(join(HERE, 'report-params-lib.mjs')).href;

let failures = 0;
let run = 0;
async function test(name, fn) {
  run++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label || 'value'}\n       expected ${e}\n       actual   ${a}`);
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ── the handler, loaded once ──────────────────────────────────────────────
const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  ANTHROPIC_API_KEY: 'test-key',
  CHAT_MODEL: 'claude-test',
};

let capturedHandler = null;
globalThis.Deno = {
  env: { get: (k) => ENV[k] },
  serve: (fn) => { capturedHandler = fn; },
};

// createClient is read off a global so each test can hand the handler its own
// database. The rewrite below is the ONLY change made to the source.
let currentClientFactory = () => { throw new Error('no client factory installed'); };
globalThis.__silo_test_createClient = (...args) => currentClientFactory(...args);

const harnessPath = join(tmpdir(), `silo-chat-harness-${process.pid}.ts`);
{
  const src = readFileSync(INDEX, 'utf8');
  const rewritten = src
    .replace(
      "import { createClient } from 'npm:@supabase/supabase-js@2';",
      'const createClient = globalThis.__silo_test_createClient;',
    )
    .replace(
      "import { encodeBase64 } from 'jsr:@std/encoding/base64';",
      'const encodeBase64 = (bytes) => Buffer.from(bytes).toString("base64");',
    )
    .replace("from './seo-lib.mjs';", `from ${JSON.stringify(SEO_LIB_URL)};`)
    .replace("from './evidence-scope.mjs';", `from ${JSON.stringify(EVIDENCE_LIB_URL)};`)
    .replace("from './budget-lib.mjs';", `from ${JSON.stringify(BUDGET_LIB_URL)};`)
    .replace("from './prompt-lib.mjs';", `from ${JSON.stringify(PROMPT_LIB_URL)};`)
    .replace("from './provider-lib.mjs';", `from ${JSON.stringify(PROVIDER_LIB_URL)};`)
    .replace("from './query-shape-lib.mjs';", `from ${JSON.stringify(QUERY_SHAPE_LIB_URL)};`)
    .replace("from './keepalive-lib.mjs';", `from ${JSON.stringify(KEEPALIVE_LIB_URL)};`)
    .replace("from './ai-credit-lib.mjs';", `from ${JSON.stringify(CREDIT_LIB_URL)};`)
    .replace("from './silo-reports-lib.mjs';", `from ${JSON.stringify(REPORTS_LIB_URL)};`)
    .replace("from './report-params-lib.mjs';", `from ${JSON.stringify(REPORT_PARAMS_LIB_URL)};`);
  // A silently-unapplied rewrite would load a file that still imports npm:,
  // which fails with a confusing resolver error 40 lines away from the cause.
  for (const marker of ["globalThis.__silo_test_createClient", SEO_LIB_URL, EVIDENCE_LIB_URL, BUDGET_LIB_URL, PROMPT_LIB_URL, PROVIDER_LIB_URL, QUERY_SHAPE_LIB_URL, KEEPALIVE_LIB_URL, CREDIT_LIB_URL, REPORTS_LIB_URL, REPORT_PARAMS_LIB_URL, 'Buffer.from(bytes)']) {
    if (!rewritten.includes(marker)) {
      throw new Error(`harness rewrite failed: index.ts no longer matches the expected import for ${marker}`);
    }
  }
  writeFileSync(harnessPath, rewritten);
}
try {
  await import(pathToFileURL(harnessPath).href);
} finally {
  rmSync(harnessPath, { force: true });
}
if (typeof capturedHandler !== 'function') {
  throw new Error('index.ts did not register a handler via Deno.serve');
}

// ── mocks ─────────────────────────────────────────────────────────────────

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'nobody@example.com' };
// Product Concepts is available to every caller; this fixture is just an
// arbitrary named actor kept for the tests that want one on the record.
const CONCEPT_TESTER = { id: USER.id, email: 'blake@baseballism.com' };
let currentUser = USER;
const COMPANY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** A supabase-js-shaped stub. Query builders are thenable, so `await
 *  client.from(t).select().eq().maybeSingle()` resolves through `resolve`. */
function makeClient({
  activeCompanies = [COMPANY_A],
  auditError = null,
  profileErrorOn = [],
  catalog = CATALOG_FIXTURE,
  // SILO reports (silo_chat_saved_reports, source = 'system'). None by default,
  // so every older test sees exactly the request it always did.
  siloReports = [],
  // Queued chat_run_readonly_query results, consumed in call order. A plain
  // array is reused for every call; an array of arrays is a script.
  rpcResults = null,
  rpcError = null,
  // Insert errors that clear after the first attempt, so the "column is not
  // there yet" retry can be exercised.
  insertErrorOnce = null,
} = {}) {
  const state = {
    inserts: [],
    updates: [],
    rpcCalls: [],
    reportReads: [],
    profileReads: 0,
    auditAttempts: 0,
  };
  const rpcQueue = Array.isArray(rpcResults) && Array.isArray(rpcResults[0]) ? rpcResults.slice() : null;
  const remaining = activeCompanies.slice();
  let lastCompany = remaining[remaining.length - 1] ?? null;

  const resolve = (b) => {
    if (b._table === 'silo_chat_audit_log' && b._op === 'insert') {
      state.auditAttempts++;
      if (insertErrorOnce && state.auditAttempts === 1) return { data: null, error: insertErrorOnce };
      return { data: null, error: auditError };
    }
    if (b._table === 'silo_chat_schema_catalog') return { data: catalog, error: null };
    if (b._table === 'silo_chat_saved_reports') {
      state.reportReads.push({ eq: b._eq, is: b._is });
      return { data: siloReports, error: null };
    }
    if (b._table === 'product_concepts') {
      // A SELECT here is the duplicate-title lookup, which uses maybeSingle():
      // it must resolve to null (no duplicate), not to the generic empty ARRAY
      // the list reads want -- an array is truthy and reads as "a duplicate
      // exists", which silently skips the insert the test is asserting on.
      if (b._op === 'select') return { data: null, error: null };
      const row = { id: '33333333-3333-4333-8333-333333333333', ...(b._payload || {}) };
      return { data: row, error: null };
    }
    if (b._table === 'profiles') {
      state.profileReads++;
      // 1-indexed, counting every attempt including the built-in retry.
      if (profileErrorOn.includes(state.profileReads)) {
        return { data: null, error: { message: 'could not connect', code: 'PGRST000' } };
      }
      const value = remaining.length > 1 ? remaining.shift() : (remaining[0] ?? lastCompany);
      return { data: { active_company_id: value }, error: null };
    }
    // notes / schema catalog / anything else the handler reads for context
    return { data: [], error: null };
  };

  const builder = (table) => {
    const b = {
      _table: table,
      _op: 'select',
      _payload: null,
      _eq: [],
      _is: [],
      select() { return b; },
      eq(col, val) { b._eq.push([col, val]); return b; },
      is(col, val) { b._is.push([col, val]); return b; },
      ilike() { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return b; },
      single() { return b; },
      update(payload) {
        b._op = 'update';
        b._payload = payload;
        state.updates.push({ table, payload, eq: b._eq });
        return b;
      },
      insert(payload) {
        b._op = 'insert';
        b._payload = payload;
        state.inserts.push({ table, payload });
        return b;
      },
      then(onOk, onErr) { return Promise.resolve(resolve(b)).then(onOk, onErr); },
    };
    return b;
  };

  return {
    __state: state,
    auth: { getUser: async () => { globalThis.__silo_test_onRequestStart?.(); return { data: { user: currentUser }, error: null }; } },
    from: (table) => builder(table),
    rpc: async (name, args) => {
      state.rpcCalls.push({ name, args });
      // A function lets one test script a failure THEN a success, which is the
      // whole shape of a correction: the retry has to be able to work.
      const err = typeof rpcError === 'function' ? rpcError(state.rpcCalls.length, args) : rpcError;
      if (err) return { data: null, error: err };
      if (rpcQueue) return { data: rpcQueue.length ? rpcQueue.shift() : [], error: null };
      // A function gets the call index, for a test that needs a DIFFERENT
      // result per query -- a planning record then a sales rollup, say.
      if (typeof rpcResults === 'function') return { data: rpcResults(state.rpcCalls.length, args) || [], error: null };
      return { data: rpcResults || [], error: null };
    },
  };
}

/** Scripted Anthropic responses, one per model round, in order. */
function installModel(rounds, onCall = () => {}) {
  const queue = rounds.slice();
  // Every request body the handler sent. The assertions that matter most here
  // are about what the model was SHOWN -- a tool result's evidence envelope,
  // the wording of the budget-exhausted instruction -- and that is only
  // visible on the way out.
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('api.anthropic.com')) {
      throw new Error(`unexpected outbound fetch in test: ${url}`);
    }
    sent.push(JSON.parse(init.body));
    onCall(sent.length);
    if (!queue.length) throw new Error('model called more times than the test scripted');
    const body = queue.shift();
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { remaining: () => queue.length, sent };
}

/** A controllable clock.
 *
 *  The wall-clock paths could not be tested before this: the handler measures
 *  elapsed time with Date.now(), and every existing budget test reaches the
 *  ROUND cap instead, which is a different branch. Advancing on each model call
 *  is also the honest shape -- the 2026-09-16 Sonic request spent 18.3s of its
 *  138s in the database and the rest waiting on the model.
 */
// The time budget moved from 95s/140s to 215s/260s on 2026-09-28 (the
// response now starts early and heartbeats past the 150s gateway). Every
// window moved by the same amount, so rather than re-derive each hand-tuned
// scenario below, the fake clock jumps by that amount the moment a request
// starts: 8 x 12s calls still reach the round-start budget on the 8th call,
// and so on. Model-call timings are untouched, which is what keeps the
// correction arithmetic's inputs identical.
const BUDGET_SHIFT_MS = 120_000;
function installClock() {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow.call(Date) + offset;
  globalThis.__silo_test_onRequestStart = () => { offset += BUDGET_SHIFT_MS; globalThis.__silo_test_onRequestStart = null; };
  return {
    advance: (ms) => { offset += ms; },
    restore: () => { Date.now = realNow; globalThis.__silo_test_onRequestStart = null; },
  };
}

/** Every tool_result string the handler fed back to the model, once each.
 *  Read off the LAST request body: messages accumulate across rounds, so the
 *  final one holds the whole transcript and every earlier body is a prefix of
 *  it. Scanning all of them counts each result once per remaining round. */
function toolResultsSeen(sent) {
  const out = [];
  for (const body of sent.slice(-1)) {
    for (const m of body.messages || []) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (block && block.type === 'tool_result' && typeof block.content === 'string') out.push(block.content);
      }
    }
  }
  return out;
}

const say = (text, stop_reason = 'end_turn') => ({
  content: [{ type: 'text', text }],
  stop_reason,
});

const REQUEST_ID = '99999999-9999-4999-8999-999999999999';

function request(body) {
  return new Request('https://example.supabase.co/functions/v1/silo-chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function ask(body, clientOpts, user = USER) {
  const client = makeClient(clientOpts);
  currentClientFactory = () => client;
  currentUser = user;
  try {
    const res = await capturedHandler(request(body));
    return { res, json: await res.json(), client };
  } finally {
    currentUser = USER;
  }
}
const wrote = (client, table) => client.__state.inserts.filter((i) => i.table === table);
const updated = (client, table) => client.__state.updates.filter((u) => u.table === table);

const BASIC = {
  history: [{ role: 'user', content: 'What did we sell last week?' }],
  request_id: REQUEST_ID,
};

// ── the five defects the audit found, one test each ───────────────────────

console.log('\n-- an answer cut off by the output limit keeps its beginning --');

// The handler correctly refused to ship a truncated fragment and asked the
// model to continue -- then returned ONLY the continuation. The user got an
// answer starting mid-thought with its opening figures missing, and the audit
// row recorded that same headless text as the answer given.
await test('the truncated first half is kept, not replaced by the continuation', async () => {
  installModel([
    say('Website sales were $412,500 last week, up 6% on the week before. The', 'max_tokens'),
    say(' biggest mover was the Bubbles and Doubles tee.'),
  ]);
  const { json } = await ask(BASIC);
  eq(
    json.answer,
    'Website sales were $412,500 last week, up 6% on the week before. The biggest mover was the Bubbles and Doubles tee.',
    'returned answer',
  );
});

await test('...and the audit row records the whole answer, not the tail', async () => {
  installModel([
    say('OPENING.', 'max_tokens'),
    say(' CLOSING.'),
  ]);
  const { client } = await ask(BASIC);
  const row = client.__state.inserts.find((i) => i.table === 'silo_chat_audit_log');
  assert(row, 'no audit row was written');
  eq(row.payload.answer, 'OPENING. CLOSING.', 'audited answer');
});

// Guards the reset: prose the model abandons to go back to running queries is
// NOT the start of the eventual answer, and gluing it on would put a
// half-finished sentence in front of every answer that followed a tool call.
await test('prose abandoned for another tool call is not glued to the answer', async () => {
  installModel([
    say('Let me start by checking', 'max_tokens'),
    {
      content: [{ type: 'tool_use', id: 'tu_1', name: 'run_sql', input: { query: 'select 1' } }],
      stop_reason: 'tool_use',
    },
    say('Sales were $10.'),
  ]);
  const { json } = await ask(BASIC);
  eq(json.answer, 'Sales were $10.', 'returned answer');
});

// The forced-answer path is a SECOND copy of the truncation handling, reached
// only after the round or wall-clock budget is spent -- i.e. on the longest,
// most expensive questions, which are exactly the ones whose answers were
// being decapitated. Nothing else in the repo executes it.
const MAX_TOOL_ROUNDS = 20;
const toolRound = (i) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `tu_${i}`, name: 'run_sql', input: { query: `select ${i}` } }],
});
const exhaustRounds = () => Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => toolRound(i));
const ROUND_PARTIAL_PREFIX = '**Partial answer:** the investigation limit was reached before all checks finished; this answer covers what had been gathered.\n\n';

await test('the forced answer at the round cap is returned', async () => {
  installModel([...exhaustRounds(), say('Out of budget, but here is the number: $10.')]);
  const { res, json } = await ask(BASIC);
  eq(res.status, 200, 'status');
  eq(json.answer, ROUND_PARTIAL_PREFIX + 'Out of budget, but here is the number: $10.', 'answer');
});

await test('...and ITS continuation is appended, not substituted for it', async () => {
  installModel([
    ...exhaustRounds(),
    say('Out of budget. Sales were $412,500, and the', 'max_tokens'),
    say(' top mover was the tee.'),
  ]);
  const { json } = await ask(BASIC);
  eq(json.answer, ROUND_PARTIAL_PREFIX + 'Out of budget. Sales were $412,500, and the top mover was the tee.', 'answer');
});

// The one path that reaches the forced answer holding a half-written one: the
// LAST round before the budget runs out is itself cut off by the output limit.
// Nothing is left to continue it inside the loop, so the forced turn has to
// finish it rather than start again.
await test('a half-written answer carried into the forced turn is finished, not restarted', async () => {
  installModel([
    ...exhaustRounds().slice(0, MAX_TOOL_ROUNDS - 1),
    say('Sales were $412,500 last week, and the', 'max_tokens'),
    say(' top mover was the tee.'),
  ]);
  const { json } = await ask(BASIC);
  eq(json.answer, ROUND_PARTIAL_PREFIX + 'Sales were $412,500 last week, and the top mover was the tee.', 'answer');
});

console.log('\n-- a rejected audit insert is reported, never swallowed --');

// supabase-js resolves with a RETURNED error object rather than throwing, so
// the old try/catch could not see an RLS or constraint rejection at all. The
// row silently never existed: silo_chat_health_v computed reliability over a
// log with holes in it, and crash recovery had nothing to find.
await test('an insert rejection is surfaced to the client as audit_logged=false', async () => {
  installModel([say('Sales were $10.')]);
  const { json } = await ask(BASIC, { auditError: { message: 'new row violates row-level security policy', code: '42501' } });
  eq(json.answer, 'Sales were $10.', 'answer still returned');
  eq(json.audit_logged, false, 'audit_logged flag');
});

await test('...and a successful insert does not set the flag at all', async () => {
  installModel([say('Sales were $10.')]);
  const { json } = await ask(BASIC);
  assert(!('audit_logged' in json), 'audit_logged should be absent when logging succeeded');
});

console.log('\n-- web sources survive the answer assembly --');

// Answer assembly maps content blocks to `b.text` and drops everything else,
// so the citations attached to a web_search-backed claim never reached the
// user: an external, unverified figure arrived alongside queried numbers with
// nothing to tell them apart.
await test('citations on a text block are returned as sources', async () => {
  installModel([{
    stop_reason: 'end_turn',
    content: [{
      type: 'text',
      text: 'Industry average return rate is about 18%.',
      citations: [{ url: 'https://example.com/returns-report', title: 'Returns benchmark 2026' }],
    }],
  }]);
  const { json } = await ask(BASIC);
  eq(json.sources, [{ url: 'https://example.com/returns-report', title: 'Returns benchmark 2026' }], 'sources');
});

await test('...and so are results inside a web_search_tool_result block', async () => {
  installModel([{
    stop_reason: 'end_turn',
    content: [
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://example.com/a', title: 'A' },
          { type: 'web_search_result', url: 'https://example.com/a', title: 'A again' },
          { type: 'web_search_result', url: 'https://example.com/b', title: 'B' },
        ],
      },
      { type: 'text', text: 'Two sources.' },
    ],
  }]);
  const { json } = await ask(BASIC);
  eq(json.sources.map((s) => s.url), ['https://example.com/a', 'https://example.com/b'], 'deduped source urls');
});

await test('an answer with no web search carries no sources field', async () => {
  installModel([say('Sales were $10.')]);
  const { json } = await ask(BASIC);
  assert(!('sources' in json), 'sources should be omitted entirely when nothing was searched');
});

console.log('\n-- a request has an identity of its own --');

// Recovery used to match on question TEXT, which repeats inside a conversation
// ("yes", "keep going") and which the exec-visibility select policy does not
// scope to the reader.
await test('the client request id is written onto the audit row', async () => {
  installModel([say('Sales were $10.')]);
  const { client } = await ask(BASIC);
  const row = client.__state.inserts.find((i) => i.table === 'silo_chat_audit_log');
  eq(row.payload.request_id, REQUEST_ID, 'audited request_id');
});

await test('a malformed request id is never passed through; the server mints one', async () => {
  installModel([say('Sales were $10.')]);
  const { client } = await ask({ ...BASIC, request_id: 'not-a-uuid' });
  const row = client.__state.inserts.find((i) => i.table === 'silo_chat_audit_log');
  assert(row.payload.request_id !== 'not-a-uuid', 'malformed id passed through');
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.payload.request_id),
    'a metered request must always carry a real id');
});

console.log('\n-- the company a question was asked from is the company it is answered for --');

// RLS scopes every read through profiles.active_company_id -- one mutable
// per-user field, not a property of this request -- while a single request
// makes many database calls over a minute or more. A switch in another tab
// lands between two of them.
await test('a tab declaring a different company than the server has is refused', async () => {
  installModel([]);
  const { res, json } = await ask({ ...BASIC, company_entity_id: COMPANY_B }, { activeCompanies: [COMPANY_A] });
  eq(res.status, 409, 'status');
  eq(json.company_changed, true, 'company_changed flag');
  assert(!json.answer, 'no answer should be produced');
});

await test('a switch DURING the request discards the answer instead of showing it', async () => {
  installModel([say('Sales were $10.')]);
  const { res, json, client } = await ask(BASIC, { activeCompanies: [COMPANY_A, COMPANY_B] });
  eq(res.status, 409, 'status');
  eq(json.company_changed, true, 'company_changed flag');
  assert(!json.answer, 'the answer must not be returned');
  assert(
    !client.__state.inserts.some((i) => i.table === 'silo_chat_audit_log'),
    'the question must not be filed under the company it was not asked in',
  );
});

await test('a matching declared company is answered normally', async () => {
  installModel([say('Sales were $10.')]);
  const { res, json } = await ask({ ...BASIC, company_entity_id: COMPANY_A }, { activeCompanies: [COMPANY_A] });
  eq(res.status, 200, 'status');
  eq(json.answer, 'Sales were $10.', 'answer');
});

// A request that never declares a company must still work -- a browser tab
// cached before this shipped does not send one, and refusing those would take
// Ask SILO down for everyone until they reloaded.
await test('a request with no declared company is not refused', async () => {
  installModel([say('Sales were $10.')]);
  const { res, json } = await ask(BASIC, { activeCompanies: [COMPANY_A] });
  eq(res.status, 200, 'status');
  eq(json.answer, 'Sales were $10.', 'answer');
});

console.log('\n-- a write never lands in a company the question was not asked in --');

// Cycle-1 review finding (PR #712, P1). The delivery check runs AFTER the tool
// loop, and a write does not wait for the answer: the row is stamped with the
// NEW company by stamp_company_entity_id, committed, and only then does the
// final check discard the answer. Refusing to deliver does nothing about a row
// already sitting in another company's data.
const useTool = (name, input) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `tu_${name}`, name, input }],
});

await test('save_note is refused when the company changed mid-request', async () => {
  installModel([
    useTool('save_note', { note: 'Pin of Month is a one-time drop.' }),
    say('I could not save that.'),
  ]);
  // A at the start, B by the time the tool fires.
  const { client } = await ask(BASIC, { activeCompanies: [COMPANY_A, COMPANY_B] });
  eq(wrote(client, 'silo_chat_notes').length, 0, 'notes written');
});

await test('...and the model is told plainly that nothing was saved', async () => {
  let relayed = null;
  installModel([
    useTool('save_note', { note: 'x' }),
    say('Nothing was saved.'),
  ]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    for (const m of body.messages || []) {
      for (const blk of Array.isArray(m.content) ? m.content : []) {
        if (blk.type === 'tool_result') relayed = String(blk.content);
      }
    }
    return realFetch(url, init);
  };
  await ask(BASIC, { activeCompanies: [COMPANY_A, COMPANY_B] });
  assert(relayed && /nothing was saved/i.test(relayed), `tool result did not say nothing was saved: ${relayed}`);
  assert(/do not retry/i.test(relayed), 'the model was not told to stop retrying');
});

await test('a concept write is refused on the same change', async () => {
  installModel([
    useTool('create_product_concept', { title: 'Youth Hoodie' }),
    say('Nothing was saved.'),
  ]);
  const { client } = await ask(
    { ...BASIC, workflow: 'product_concept' },
    { activeCompanies: [COMPANY_A, COMPANY_B] },
    CONCEPT_TESTER,
  );
  eq(wrote(client, 'product_concepts').length, 0, 'concepts written');
});

// The gate is stricter than the delivery check on purpose: a row committed
// under a company nobody could confirm is not undoable by refusing afterwards.
await test('a write is refused when the company cannot be confirmed at all', async () => {
  installModel([
    useTool('save_note', { note: 'x' }),
    say('Nothing was saved.'),
  ]);
  // Read 1 is the start check; the gate's read (2) fails and so does its retry (3).
  const { client } = await ask(BASIC, { profileErrorOn: [2, 3] });
  eq(wrote(client, 'silo_chat_notes').length, 0, 'notes written');
});

await test('an unchanged company still lets a write through', async () => {
  installModel([
    useTool('save_note', { note: 'Pin of Month is a one-time drop.' }),
    say('Saved.'),
  ]);
  const { client, json } = await ask(BASIC);
  eq(wrote(client, 'silo_chat_notes').length, 1, 'notes written');
  eq(json.answer, 'Saved.', 'answer');
});

// The set beside the tool loop is the whole guard. A write tool added to the
// loop and not to the set has no gate, and nothing else would show it.
await test('every tool that writes is named in WRITE_TOOLS', () => {
  const src = readFileSync(INDEX, 'utf8');
  const setSrc = src.slice(src.indexOf('const WRITE_TOOLS'), src.indexOf(']);', src.indexOf('const WRITE_TOOLS')));
  const declared = new Set((setSrc.match(/'([a-z_]+)'/g) || []).map((q) => q.slice(1, -1)));

  // Slice the tool loop into one segment per branch, then ask which segments
  // reach a write on the caller client. Deliberately structural rather than a
  // hand-kept list: a hand-kept list in the test has exactly the defect the
  // set in index.ts has, one layer further away.
  const loop = src.slice(src.indexOf('for (const use of toolUses)'));
  const marks = [...loop.matchAll(/use\.name === '([a-z_]+)'/g)];
  const segments = marks.map((m, i) => ({
    name: m[1],
    body: loop.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : m.index + 6000),
  }));
  // Any branch containing an insert or an update at all is a writer. NOT a
  // proximity match against `callerClient`: the first version of this used a
  // 400-character window and stopped seeing save_note the moment a comment was
  // added between the table and the call. A false positive here just means a
  // tool gets added to WRITE_TOOLS unnecessarily, which is the safe direction.
  const writers = [...new Set(
    segments.filter((seg) => /\.(insert|update)\(/.test(seg.body)).map((seg) => seg.name),
  )];

  for (const w of writers) {
    assert(declared.has(w), `${w} writes but is not in WRITE_TOOLS, so it has no company gate`);
  }
  // The detector itself has to be working, or this test passes by finding
  // nothing. These four are the writes that exist today.
  for (const expected of ['save_note', 'create_product_concept', 'update_product_concept', 'approve_product_concept']) {
    assert(writers.includes(expected), `the write detector missed ${expected}; found ${JSON.stringify(writers)}`);
  }
});

// Cycle-2 review finding (PR #712, P1). The gate and the write are separate
// round trips, so the gate can always be raced -- create_product_concept even
// runs a duplicate-title lookup in between. The gate is a pre-check; what makes
// the write safe is that it carries the STARTING company explicitly, so
// stamp_company_entity_id leaves it alone (it only fills a NULL) and the insert
// policy's `company_entity_id = active_company_id()` refuses the row outright
// if the active company has moved. These assert the value actually goes.
await test('save_note sends the starting company rather than leaving it to the trigger', async () => {
  installModel([useTool('save_note', { note: 'x' }), say('Saved.')]);
  const { client } = await ask(BASIC);
  const [row] = wrote(client, 'silo_chat_notes');
  assert(row, 'no note was written');
  eq(row.payload.company_entity_id, COMPANY_A, 'stamped company');
});

await test('a concept insert sends it too, across the duplicate lookup', async () => {
  installModel([useTool('create_product_concept', { title: 'Youth Hoodie' }), say('Drafted.')]);
  const { client } = await ask(
    { ...BASIC, workflow: 'product_concept' }, undefined, CONCEPT_TESTER,
  );
  const [row] = wrote(client, 'product_concepts');
  assert(row, 'no concept was written');
  eq(row.payload.company_entity_id, COMPANY_A, 'stamped company');
});

// The race the gate cannot close: it reads A, the duplicate lookup runs, the
// profile flips to B, and only THEN does the insert go. The gate passes, and
// the row must still carry A so the database refuses it.
await test('a switch after the gate still leaves the insert carrying the starting company', async () => {
  installModel([useTool('create_product_concept', { title: 'Youth Hoodie' }), say('Drafted.')]);
  // Reads: 1 start (A), 2 gate (A), then B for everything after.
  const { client } = await ask(
    { ...BASIC, workflow: 'product_concept' },
    { activeCompanies: [COMPANY_A, COMPANY_A, COMPANY_B] },
    CONCEPT_TESTER,
  );
  const [row] = wrote(client, 'product_concepts');
  assert(row, 'the gate should have passed, so the insert should have been attempted');
  eq(row.payload.company_entity_id, COMPANY_A, 'stamped company');
});

// An UPDATE cannot be refused by a WITH CHECK it still satisfies, so it is
// addressed by company instead.
await test('a concept update is scoped to the starting company', async () => {
  installModel([
    useTool('update_product_concept', { id: '33333333-3333-4333-8333-333333333333', title: 'Revised' }),
    say('Revised.'),
  ]);
  const { client } = await ask(
    { ...BASIC, workflow: 'product_concept' }, undefined, CONCEPT_TESTER,
  );
  const [u] = updated(client, 'product_concepts');
  assert(u, 'no update was issued');
  assert(
    u.eq.some(([col, val]) => col === 'company_entity_id' && val === COMPANY_A),
    `update was not scoped to the starting company: ${JSON.stringify(u.eq)}`,
  );
});

await test('...and so is an approve', async () => {
  installModel([
    useTool('approve_product_concept', { id: '33333333-3333-4333-8333-333333333333' }),
    say('Approved.'),
  ]);
  const { client } = await ask(
    { ...BASIC, workflow: 'product_concept' }, undefined, CONCEPT_TESTER,
  );
  const [u] = updated(client, 'product_concepts');
  assert(u, 'no update was issued');
  assert(
    u.eq.some(([col, val]) => col === 'company_entity_id' && val === COMPANY_A),
    `approve was not scoped to the starting company: ${JSON.stringify(u.eq)}`,
  );
});

console.log('\n-- company verification fails closed, never open --');

// Cycle-1 review finding (PR #712, P1). The first version converted a lookup
// error to null and only compared when both sides were known, so a transient
// error on either read skipped the check entirely -- the same outcome as not
// checking, arrived at silently.
await test('a start lookup that cannot be established refuses the request', async () => {
  installModel([]);
  const { res, json } = await ask(BASIC, { profileErrorOn: [1, 2] });
  eq(res.status, 503, 'status');
  eq(json.company_unverified, true, 'company_unverified flag');
  assert(!json.answer, 'no answer should be produced');
});

await test('a final lookup that cannot be established discards the answer', async () => {
  installModel([say('Sales were $10.')]);
  // Read 1 is the start check; reads 2 and 3 are the delivery check and its retry.
  const { res, json, client } = await ask(BASIC, { profileErrorOn: [2, 3] });
  eq(res.status, 503, 'status');
  eq(json.company_unverified, true, 'company_unverified flag');
  assert(!json.answer, 'the answer must not be delivered');
  eq(wrote(client, 'silo_chat_audit_log').length, 0, 'audit rows for a discarded answer');
});

// The retry is what keeps a single blip from discarding a minute of work.
await test('one transient failure is retried rather than refused', async () => {
  installModel([say('Sales were $10.')]);
  const { res, json } = await ask(BASIC, { profileErrorOn: [2] });
  eq(res.status, 200, 'status');
  eq(json.answer, 'Sales were $10.', 'answer');
});


// ── evidence scope, retrieval and deadline honesty (2026-09-16 traces) ─────
//
// These run the REAL tool loop. The distinction that matters: they assert on
// what the handler PUT IN FRONT OF THE MODEL and what it wrote to the audit
// row, both of which are code. They assert nothing about what a model then
// says -- that is evals/evidence-scope.eval.mjs, which costs money and is not
// run in CI. A green run here is not evidence of better answers.

console.log('\n-- a query result carries what it is scoped to --');

const sqlRound = (sql) => ({
  content: [{ type: 'tool_use', id: 'tu-sql', name: 'run_sql', input: { query: sql } }],
  stop_reason: 'tool_use',
});
const describeRound = (relations, id = 'tu-d') => ({
  content: [{ type: 'tool_use', id, name: 'describe_relations', input: { relations } }],
  stop_reason: 'tool_use',
});

await test('a pooled result tells the model it is pooled, in the same payload as the rows', async () => {
  const model = installModel([sqlRound(COMBINED_SPEND_SQL), say('done')]);
  await ask(BASIC, { rpcResults: COMBINED_SPEND_ROWS });
  const results = toolResultsSeen(model.sent);
  assert(results.length === 1, `expected one tool result, got ${results.length}`);
  const payload = JSON.parse(results[0]);
  assert(payload.evidence_scope, 'the rows came back with no scope at all');
  const totals = (payload.evidence_scope.totals_only || []).find((t) => t.relation === 'marketing_daily_totals_v');
  assert(totals && totals.carries_none_of.includes('platform'),
    `the all-platform result did not say so: ${JSON.stringify(payload.evidence_scope)}`);
  eq(payload.rows, COMBINED_SPEND_ROWS, 'the rows themselves');
});

await test('...and a per-platform result does not, so the two are told apart', async () => {
  const model = installModel([sqlRound(PER_PLATFORM_SQL), say('done')]);
  await ask(BASIC, { rpcResults: PER_PLATFORM_ROWS });
  const payload = JSON.parse(toolResultsSeen(model.sent)[0]);
  assert(!payload.evidence_scope.totals_only, 'a per-platform result claimed to be pooled');
  eq((payload.evidence_scope.broken_out_per_value || []).map((b) => b.column), ['platform'], 'broken out');
});

await test('a schema-discovery query is not given a business-scope envelope', async () => {
  const model = installModel([
    sqlRound("select column_name from information_schema.columns where table_name='sales_by_day'"),
    say('done'),
  ]);
  await ask(BASIC, { rpcResults: [{ column_name: 'day_date' }] });
  assert(!toolResultsSeen(model.sent)[0].includes('evidence_scope'), 'a catalog lookup paid for an envelope');
});

await test('a failing query is reported as an error, not as an empty scoped result', async () => {
  const model = installModel([sqlRound('select nope from sales_by_day'), say('done')]);
  await ask(BASIC, { rpcError: { message: 'column "nope" does not exist' } });
  const r = toolResultsSeen(model.sent)[0];
  assert(r.startsWith('Error:'), `an error was dressed as a result: ${r}`);
  assert(!r.includes('evidence_scope'), 'an error carried a scope envelope');
});

console.log('\n-- guidance can be fetched for where the investigation actually went --');

await test('describe_relations returns the full card for a relation the question never named', async () => {
  const model = installModel([describeRound(['marketing_kpis_daily']), say('done')]);
  await ask(BASIC, { rpcResults: [{ relation: 'marketing_kpis_daily', date_column: 'day_date', earliest: '2025-07-28', latest: '2026-09-15' }] });
  const payload = JSON.parse(toolResultsSeen(model.sent)[0]);
  const card = payload.cards[0];
  eq(card.relation, 'marketing_kpis_daily', 'relation');
  assert(card.columns.some((c) => c.startsWith('campaign_name')), 'columns are missing from the card');
  assert(/CLAIMED, NOT ACTUAL/.test(card.business_meaning), 'the curated caveats did not come with it');
});

await test('coverage is MEASURED from the data, not read out of the card', async () => {
  const model = installModel([describeRound(['meta_ad_performance_daily']), say('done')]);
  const { client } = await ask(BASIC, {
    rpcResults: [{ relation: 'meta_ad_performance_daily', date_column: 'day_date', earliest: '2025-07-28', latest: '2026-09-15' }],
  });
  const payload = JSON.parse(toolResultsSeen(model.sent)[0]);
  eq(payload.measured_coverage[0].earliest, '2025-07-28', 'measured earliest');
  const coverageCall = client.__state.rpcCalls.find((c) => /min\(day_date\)/.test(c.args?.query || ''));
  assert(coverageCall, 'no min/max was actually run -- coverage would be a remembered claim again');
  assert(/from meta_ad_performance_daily/.test(coverageCall.args.query), 'the measured relation is wrong');
});

await test('a coverage measurement that fails says UNKNOWN rather than falling back', async () => {
  const model = installModel([describeRound(['meta_ad_performance_daily']), say('done')]);
  await ask(BASIC, { rpcError: { message: 'canceling statement due to statement timeout' } });
  const payload = JSON.parse(toolResultsSeen(model.sent)[0]);
  eq(payload.measured_coverage.measured, false, 'measured flag');
  assert(/do not fall back to any range written in a card/i.test(payload.coverage_note), 'no instruction not to fall back');
});

await test('a relation with no day-grain date column is "not measured", never "no history"', async () => {
  const model = installModel([describeRound(['meta_ad_creatives']), say('done')]);
  const { client } = await ask(BASIC, {});
  const payload = JSON.parse(toolResultsSeen(model.sent)[0]);
  assert(payload.measured_coverage === null, 'coverage was invented for a relation with no date column');
  assert(/not a statement that they lack history/i.test(payload.coverage_note), 'absence read as emptiness');
  assert(!client.__state.rpcCalls.some((c) => /min\(/.test(c.args?.query || '')), 'a pointless coverage query ran');
});

await test('an unknown relation is reported as unknown, not silently skipped', async () => {
  const model = installModel([describeRound(['marketing_kpis_daily', 'no_such_relation']), say('done')]);
  await ask(BASIC, { rpcResults: [] });
  const payload = JSON.parse(toolResultsSeen(model.sent)[0]);
  const miss = payload.cards.find((c) => c.relation === 'no_such_relation');
  assert(miss && miss.found === false, `a missing relation vanished: ${JSON.stringify(payload.cards)}`);
});

await test('the describe budget is enforced in code, not asked for in prose', async () => {
  const model = installModel([
    describeRound(['marketing_kpis_daily'], 'd1'),
    describeRound(['sales_by_day'], 'd2'),
    describeRound(['meta_ad_creatives'], 'd3'),
    describeRound(['launch_calendar'], 'd4'),
    say('done'),
  ]);
  await ask(BASIC, { rpcResults: [] });
  const results = toolResultsSeen(model.sent);
  assert(results.length === 4, `expected four describe results, got ${results.length}`);
  assert(!results[3].startsWith('Error:') === false, 'the fourth call was not refused');
  assert(/budget for this question/.test(results[3]), `unexpected refusal text: ${results[3]}`);
  assert(/could not confirm its meaning/.test(results[3]), 'the refusal does not say what to do instead');
});

await test('more relations than the per-call cap are trimmed, not refused wholesale', async () => {
  const many = ['marketing_kpis_daily', 'sales_by_day', 'meta_ad_creatives', 'launch_calendar',
    'meta_ad_performance_daily', 'marketing_daily_totals_v', 'products_master'];
  const model = installModel([describeRound(many), say('done')]);
  await ask(BASIC, { rpcResults: [] });
  const payload = JSON.parse(toolResultsSeen(model.sent)[0]);
  eq(payload.cards.length, 6, 'cards returned');
});

console.log('\n-- running out of budget returns partial findings, not a manufactured conclusion --');

await test('the budget-exhausted instruction asks for supported findings AND unfinished checks', async () => {
  const model = installModel([...exhaustRounds(), say('partial answer')]);
  await ask(BASIC, { rpcResults: [] });
  const last = model.sent[model.sent.length - 1];
  const nudge = last.messages[last.messages.length - 1].content;
  assert(/WHAT THE EVIDENCE SUPPORTS/.test(nudge), `no supported-findings section: ${nudge}`);
  assert(/WHAT IS STILL UNCHECKED/.test(nudge), 'no unfinished-checks section');
  assert(/only reaches an observation/.test(nudge), 'nothing stops an observation being promoted to a recommendation');
  assert(!/instead of refusing to answer/.test(nudge),
    'the old "answer anyway" wording is back -- that is what produced a recommendation with no evidence behind it');
});

await test('...and the response says it is partial, in a field prose cannot drop', async () => {
  installModel([...exhaustRounds(), say('partial answer')]);
  const { json } = await ask(BASIC, { rpcResults: [] });
  eq(json.partial, true, 'partial flag');
  assert(/investigation limit/.test(json.partial_reason || ''), `partial_reason: ${json.partial_reason}`);
  eq(json.answer, ROUND_PARTIAL_PREFIX + 'partial answer', 'the gathered answer is still returned');
});

await test('a normal answer carries no partial flag at all', async () => {
  installModel([say('a complete answer')]);
  const { json } = await ask(BASIC, {});
  assert(!('partial' in json), 'a finished answer was marked partial');
  assert(!('partial_reason' in json), 'a finished answer carried a partial reason');
});

console.log('\n-- diagnostics: enough to diagnose, never a second copy of the data --');

const auditRow = (client) => wrote(client, 'silo_chat_audit_log').slice(-1)[0]?.payload;

await test('each query records its outcome and its derived scope', async () => {
  installModel([sqlRound(COMBINED_SPEND_SQL), say('done')]);
  const { client } = await ask(BASIC, { rpcResults: COMBINED_SPEND_ROWS });
  const d = auditRow(client).diagnostics;
  assert(d, 'no diagnostics were written');
  eq(d.queries.length, 1, 'queries logged');
  eq(d.queries[0].ok, true, 'ok flag');
  eq(d.queries[0].row_count, 1, 'row count');
  assert(d.queries[0].scope.totals_only, 'the derived scope was not kept with the outcome');
});

// query-shape-lib.mjs, through the real call path: the DATABASE receives the
// fast shape, Save report / the query panel store the fast shape (so a re-run
// is fast too), and the log keeps what the model wrote beside what ran.
await test('slow statement shapes are rewritten before they reach the database', async () => {
  const written = "SELECT sum(total_net_sales) FROM sales_by_day WHERE location_tag = any(silo_channel_location_tags('online')) AND day_date >= current_date - interval '90 days'";
  const ran = "SELECT sum(total_net_sales) FROM sales_by_day WHERE location_tag = any((select silo_channel_location_tags('online'))::text[]) AND day_date >= (current_date - 90)";
  installModel([sqlRound(written), say('done')]);
  const { client, json } = await ask(BASIC, { rpcResults: [{ sum: 1 }] });
  const sent = client.__state.rpcCalls.filter((c) => c.name === 'chat_run_readonly_query').map((c) => c.args.query);
  eq(sent, [ran], 'statement sent to the database');
  eq(json.queries_run, [ran], 'queries_run (Save report re-runs this)');
  const q = auditRow(client).diagnostics.queries[0];
  eq(q.sql, written, 'the log keeps what the model wrote');
  eq(q.executed_sql, ran, 'the log names what actually ran');
  eq(q.rewrites.slice().sort(), ['channel_tags_hoist', 'date_interval'], 'rewrites named');
  eq((q.scope.narrowed_to || []).map((n) => n.values), [['channel:online']], 'scope still reads the channel');
});

// Deferred delivery through the REAL handler and wiring (keepalive-lib.mjs +
// storeFinishedResponse): a request that asks for it and runs past the
// 5-second threshold gets 202 pending, and its finished response lands in
// silo_chat_responses under the request id. Takes ~5s of real time on purpose:
// the threshold is a real timer, and faking it would test the helper again
// rather than the wiring.
await test('a slow request asking for deferred delivery gets 202, then its answer is stored for the page', async () => {
  const RID = '99999999-9999-4999-8999-999999999999';
  installModel([say('Deep answer.')]);
  const modelFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { await new Promise((r) => setTimeout(r, 5_300)); return modelFetch(...args); };
  try {
    const { res, json, client } = await ask({ ...BASIC, request_id: RID, async: true });
    eq(res.status, 202, 'status');
    eq(json.pending, true, 'pending');
    let rows = [];
    for (let i = 0; i < 40 && !rows.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      rows = wrote(client, 'silo_chat_responses');
    }
    eq(rows.length, 1, 'finished response stored');
    eq(rows[0].payload.request_id, RID, 'under the request id');
    // The company read at the START of the request, sent explicitly -- left to
    // the stamp trigger it would be whatever is active when the answer lands.
    eq(rows[0].payload.company_entity_id, COMPANY_A, 'filed under the company the question was asked in');
    eq(rows[0].payload.http_status, 200, 'status stored');
    eq(rows[0].payload.response.answer, 'Deep answer.', 'the full response body is stored');
  } finally {
    globalThis.fetch = modelFetch;
  }
});

await test('a statement needing no rewrite runs verbatim and logs no rewrite', async () => {
  const sql = "select sum(total_net_sales) from sales_by_day where day_date between '2026-09-01' and '2026-09-27'";
  installModel([sqlRound(sql), say('done')]);
  const { client } = await ask(BASIC, { rpcResults: [{ sum: 1 }] });
  eq(client.__state.rpcCalls.filter((c) => c.name === 'chat_run_readonly_query').map((c) => c.args.query), [sql], 'sent');
  const q = auditRow(client).diagnostics.queries[0];
  assert(!('executed_sql' in q) && !('rewrites' in q), `rewrite fields on an unrewritten query: ${JSON.stringify(q)}`);
});

await test('a query that errored records WHY, which is the half that was missing', async () => {
  installModel([sqlRound('select nope from sales_by_day'), say('done')]);
  const { client } = await ask(BASIC, { rpcError: { message: 'column "nope" does not exist' } });
  const d = auditRow(client).diagnostics;
  eq(d.queries[0].ok, false, 'ok flag');
  assert(/does not exist/.test(d.queries[0].error), `error not recorded: ${JSON.stringify(d.queries[0])}`);
});

await test('NO result rows are copied into the audit row', async () => {
  installModel([sqlRound(PER_PLATFORM_SQL), say('done')]);
  const { client } = await ask(BASIC, { rpcResults: PER_PLATFORM_ROWS });
  const serialized = JSON.stringify(auditRow(client).diagnostics);
  assert(!serialized.includes('114334.99'), 'a returned figure was copied into the diagnostics');
  assert(!serialized.includes('meta_ads'), 'a returned value was copied into the diagnostics');
  assert(/No result rows, ever/.test(serialized), 'the payload does not state what it refuses to carry');
});

await test('the coverage probe is logged but is not offered as one of the user\'s queries', async () => {
  installModel([describeRound(['meta_ad_performance_daily']), say('done')]);
  const { client, json } = await ask(BASIC, {
    rpcResults: [{ relation: 'meta_ad_performance_daily', date_column: 'day_date', earliest: '2025-07-28', latest: '2026-09-15' }],
  });
  eq(json.queries_run, [], 'a coverage probe leaked into the query panel and into Save report');
  const probe = auditRow(client).diagnostics.queries.find((q) => q.kind === 'coverage');
  assert(probe, 'the coverage probe left no trace in the diagnostics');
  eq(probe.ok, true, 'probe outcome');
  assert(!('sql' in probe), 'a probe with no statement was logged as having one');
});

await test('which relations were in context, and which had to be fetched, is recorded', async () => {
  installModel([describeRound(['marketing_kpis_daily']), say('done')]);
  const { client } = await ask(BASIC, { rpcResults: [] });
  const ctx = auditRow(client).diagnostics.context;
  assert(Array.isArray(ctx.schema_detail_relations), 'the up-front slice was not recorded');
  eq(ctx.relations_described_mid_request, ['marketing_kpis_daily'], 'mid-request fetches');
  eq(ctx.describe_calls_used, 1, 'describe calls used');
});

const HUGE_SQL = `select ${'x'.repeat(5000)} from marketing_kpis_daily where day_date = '2026-09-01'`;
// Eight statements per round is well within what one model turn can ask for,
// and it is the only way to reach the logging caps inside 20 rounds.
const busyRound = () => ({
  content: Array.from({ length: 8 }, (_, i) => ({
    type: 'tool_use', id: `tu-${i}`, name: 'run_sql', input: { query: HUGE_SQL },
  })),
  stop_reason: 'tool_use',
});

await test('a very long statement is truncated in the log and says it was', async () => {
  installModel([sqlRound(HUGE_SQL), say('done')]);
  const { client } = await ask(BASIC, { rpcResults: [] });
  const logged = auditRow(client).diagnostics.queries[0].sql;
  assert(logged.length < HUGE_SQL.length, 'a 5KB statement was stored whole');
  assert(/\[truncated\]$/.test(logged), `truncation not marked: ${logged.slice(-40)}`);
});

await test('more queries than the log holds are COUNTED, not silently dropped', async () => {
  const rounds = Array.from({ length: MAX_TOOL_ROUNDS }, busyRound);
  installModel([...rounds, say('done')]);
  const { client, json } = await ask(BASIC, { rpcResults: [] });
  const d = auditRow(client).diagnostics;
  assert(d.queries.length <= 40, `logged ${d.queries.length} entries`);
  assert(d.queries_not_logged > 0, 'the queries beyond the cap vanished without a count');
  eq(json.answer, ROUND_PARTIAL_PREFIX + 'done', 'capping the log changed the answer');
});

await test('...and the whole payload stays inside the size budget', async () => {
  const rounds = Array.from({ length: MAX_TOOL_ROUNDS }, busyRound);
  installModel([...rounds, say('done')]);
  const { client } = await ask(BASIC, { rpcResults: [] });
  const size = JSON.stringify(auditRow(client).diagnostics).length;
  assert(size <= 120_000, `diagnostics were ${size} bytes -- an insert this large is one that fails`);
});

await test('an audit table without the diagnostics column still logs the row', async () => {
  installModel([sqlRound(PER_PLATFORM_SQL), say('done')]);
  const { client, json } = await ask(BASIC, {
    rpcResults: PER_PLATFORM_ROWS,
    insertErrorOnce: { code: 'PGRST204', message: "Could not find the 'diagnostics' column of 'silo_chat_audit_log' in the schema cache" },
  });
  eq(client.__state.auditAttempts, 2, 'the retry without the new column did not happen');
  const second = wrote(client, 'silo_chat_audit_log')[1].payload;
  assert(!('diagnostics' in second), 'the retry sent the column again');
  assert(!('audit_logged' in json), 'a recovered log was still reported as failed');
});

await test('a genuine insert rejection is NOT retried into a false success', async () => {
  installModel([say('done')]);
  const { client, json } = await ask(BASIC, { auditError: { code: '42501', message: 'new row violates row-level security policy' } });
  eq(client.__state.auditAttempts, 1, 'an RLS refusal was retried');
  eq(json.audit_logged, false, 'an RLS refusal was reported as logged');
});

// Advance time at the model boundary, never sleep or call a live service.
async function withClock(fn) {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  globalThis.__silo_test_onRequestStart = () => { now += BUDGET_SHIFT_MS; globalThis.__silo_test_onRequestStart = null; };
  try { return await fn((ms) => { now += ms; }); }
  finally { Date.now = realNow; globalThis.__silo_test_onRequestStart = null; }
}
const checkpointMessages = (body) => body.messages.filter((m) =>
  typeof m.content === 'string' && m.content.startsWith('Investigation checkpoint:'));

await test('eight slow rounds get one early checkpoint, then a visibly partial persisted answer', async () => {
  await withClock(async (advance) => {
    const model = installModel([
      ...Array.from({ length: 8 }, (_, i) => toolRound(i)),
      say('Spend was $10. Returns remain unchecked.'),
    ], (n) => advance(n <= 8 ? 12_000 : 27_000));
    const { json, client } = await ask({ ...BASIC, history: [{ role: 'user', content:
      'Compare Sonic spend, subscriber acquisition, sales and returns before and after launch. Check coverage first.' }] });
    eq(model.sent.length, 9, 'eight tool rounds and one forced final');
    for (const body of model.sent.slice(0, 4)) eq(checkpointMessages(body).length, 0, 'checkpoint before threshold');
    for (const body of model.sent.slice(4)) eq(checkpointMessages(body).length, 1, 'checkpoint missing or repeated');
    const checkpoint = model.sent[4];
    assert(checkpoint.tools.some((t) => t.name === 'run_sql'), 'checkpoint lost SQL tool');
    assert(checkpoint.tool_choice?.type !== 'none', 'checkpoint forced an early final answer');
    const prior = checkpoint.messages[checkpoint.messages.length - 2];
    assert(prior.content.some((b) => b.type === 'tool_result'), 'checkpoint displaced pending tool results');
    eq(model.sent[8].tool_choice.type, 'none', 'time limit no longer stops tools');
    eq(json.partial, true, 'response partial status');
    assert(json.answer.startsWith('**Partial answer:** the time budget ran out'), 'visible time-limit label');
    assert(json.answer.endsWith('Spend was $10. Returns remain unchecked.'), 'gathered work was lost');
    const row = auditRow(client);
    eq(row.answer, json.answer, 'recovery and saved text must keep the label');
    eq(row.tool_rounds, 8, 'actual rounds');
    eq(row.error_message, 'forced final answer at wall-clock budget (243s, 8 rounds)', 'stop reason');
    eq(row.diagnostics.context.partial, true, 'persisted partial status');
    eq(row.diagnostics.context.partial_reason, json.partial_reason, 'persisted reason');
    eq(row.diagnostics.context.investigation_checkpoint_sent, true, 'checkpoint audit');
  });
});

await test('a natural finish after the checkpoint is not labelled budget-limited', async () => {
  await withClock(async (advance) => {
    const model = installModel([toolRound(1), say('Sales were $10.')], () => advance(45_000));
    const { json, client } = await ask(BASIC);
    eq(checkpointMessages(model.sent[1]).length, 1, 'checkpoint at threshold');
    eq(json.answer, 'Sales were $10.', 'normal answer changed');
    assert(!('partial' in json), 'normal response marked partial');
    eq(auditRow(client).diagnostics.context.partial, false, 'no forced-stop signal');
    eq(auditRow(client).diagnostics.context.partial_reason, null, 'no forced-stop reason');
  });
});

await test('a fast question gets no checkpoint', async () => {
  const model = installModel([say('Sales were $10.')]);
  const { client } = await ask(BASIC);
  eq(checkpointMessages(model.sent[0]).length, 0, 'fast request was interrupted');
  eq(auditRow(client).diagnostics.context.investigation_checkpoint_sent, false, 'checkpoint falsely recorded');
});

await test('the checkpoint does not interrupt a truncated prose continuation or concept workflow', async () => {
  for (const mode of ['continuation', 'workflow', 'concept-history']) {
    await withClock(async (advance) => {
      const model = installModel([
        mode === 'continuation' ? say('Sales were', 'max_tokens') : toolRound(1),
        say(' $10.'),
      ], () => advance(45_000));
      const body = mode === 'workflow' ? { ...BASIC, workflow: 'product_concept' }
        : mode === 'concept-history' ? { ...BASIC, history: [{ ...BASIC.history[0], conceptId: 'test-concept' }] }
        : BASIC;
      const { json } = await ask(body);
      eq(checkpointMessages(model.sent[1]).length, 0, `${mode} interrupted`);
      if (mode === 'continuation') eq(json.answer, 'Sales were $10.', 'continuation seam');
    });
  }
});

await test('forced partial answers still obey the final company guard', async () => {
  installModel([...exhaustRounds(), say('Company A figures')]);
  const { res, json, client } = await ask(BASIC, { activeCompanies: [COMPANY_A, COMPANY_B] });
  eq(res.status, 409, 'company switch was accepted');
  assert(!json.answer, 'partial answer leaked across company switch');
  eq(wrote(client, 'silo_chat_audit_log').length, 0, 'cross-company audit written');
});

await test('partial label survives a missing diagnostics column and a rejected audit', async () => {
  for (const opts of [
    { insertErrorOnce: { code: 'PGRST204', message: 'diagnostics column missing' } },
    { auditError: { code: '42501', message: 'RLS rejection' } },
  ]) {
    installModel([...exhaustRounds(), say('Returns remain unchecked.')]);
    const { json, client } = await ask(BASIC, opts);
    eq(json.answer, ROUND_PARTIAL_PREFIX + 'Returns remain unchecked.', 'visible partial label');
    if (opts.auditError) eq(json.audit_logged, false, 'rejection hidden');
    else {
      eq(client.__state.auditAttempts, 2, 'missing-column fallback');
      eq(auditRow(client).answer, json.answer, 'fallback lost recovery label');
    }
  }
});

// ── a guessed column is answered from the catalog, and gets a round to use it ──
//
// The 2026-09-16 Sonic request (silo_chat_audit_log b44e03ab…) ended without
// the one measure it was built around. The statement that would have isolated
// Sonic ad spend ran in the last round, failed in 110ms on `min(date)` against
// meta_ad_performance_daily (whose column is day_date), and the loop was
// already past the wall-clock guard, so no round remained to use the
// correction. Both halves are tested here: the hint, and the round.
//
// Guidance was not the missing piece. That same request had called
// describe_relations ON that table and been handed every column with its type.

console.log('\n-- a column error is answered from the schema map, not from a list --');

const AD_SQL = "select ad_id, min(date) as first_day, sum(spend) spend from meta_ad_performance_daily where ad_id in ('1','2') group by ad_id";
const colErr = (col) => ({ message: `column "${col}" does not exist`, code: '42703' });

await test('an unknown column is answered with the relation\'s real columns', async () => {
  const model = installModel([sqlRound(AD_SQL), say('done')]);
  await ask(BASIC, { rpcError: colErr('date') });
  const r = toolResultsSeen(model.sent)[0];
  assert(/column "date" does not exist/.test(r), `the original error was lost: ${r}`);
  assert(/There is no column "date" on the relations this statement reads/.test(r), `no catalog hint: ${r}`);
  assert(/meta_ad_performance_daily has: /.test(r), 'the real column list is missing');
  assert(/day_date/.test(r), 'day_date -- the actual column -- was not named');
});

// Live re-run 2026-09-28 15:32: this view timed out, was retried with a
// narrower filter, and timed out again -- filtering cannot help it.
await test('a timeout on a whole-history rollup names the pre-computed alternative', async () => {
  const sql = "SELECT month_start, location, net FROM sales_monthly_location_rollup_v WHERE month_start >= '2026-07-01'";
  const model = installModel([sqlRound(sql), say('done')]);
  await ask(BASIC, { rpcError: { message: 'canceling statement due to statement timeout' } });
  const r = toolResultsSeen(model.sent)[0];
  assert(/statement timeout/.test(r), `the original error was lost: ${r}`);
  assert(/For COMPLETED months use sales_monthly_product_type_rollup_v instead/.test(r), `no alternative named: ${r}`);
  // Review finding (PR #820, cycle 1): the alternative is a matview refreshed at
  // the end of the sync, so the hint must keep current-period questions on the
  // live table rather than silently reporting an older snapshot as current.
  assert(/as of the last completed sync/.test(r) && /CURRENT month or any period ending today/.test(r)
    && /query sales_by_day directly with a day_date range/.test(r), `freshness caveat missing: ${r}`);
});

await test('...and an ordinary timeout gets no invented hint', async () => {
  const model = installModel([sqlRound("select sum(total_net_sales) from sales_by_day"), say('done')]);
  await ask(BASIC, { rpcError: { message: 'canceling statement due to statement timeout' } });
  const r = toolResultsSeen(model.sent)[0];
  assert(!/Hint:/.test(r), `a hint was attached to an ordinary timeout: ${r}`);
});

await test('...with the near-miss called out ahead of the full list', async () => {
  const model = installModel([sqlRound(AD_SQL), say('done')]);
  await ask(BASIC, { rpcError: colErr('date') });
  const r = toolResultsSeen(model.sent)[0];
  assert(/Closest by name: [^:]*meta_ad_performance_daily\.day_date/.test(r), `day_date not offered as the near match: ${r}`);
  assert(r.indexOf('Closest by name') < r.indexOf('has: '), 'the near match is buried under the full column list');
});

await test('...and is told to re-run rather than drop the measure', async () => {
  const model = installModel([sqlRound(AD_SQL), say('done')]);
  await ask(BASIC, { rpcError: colErr('date') });
  const r = toolResultsSeen(model.sent)[0];
  assert(/do not guess a second time/.test(r), 'nothing discourages a second guess');
  assert(/do not drop the measure this query was for/.test(r), 'nothing protects the measure itself');
});

for (const [shape, msg] of [
  ['bare', 'column "date" does not exist'],
  ['unquoted', 'column date does not exist'],
  ['qualified', 'column m.date does not exist'],
  ['qualified and quoted', 'column "m"."date" does not exist'],
]) {
  await test(`the ${shape} form of the error is understood`, async () => {
    // One pattern covers all four; a second alternative for the qualified case
    // was removed once these proved it unreachable.
    const model = installModel([sqlRound(AD_SQL), say('done')]);
    await ask(BASIC, { rpcError: { message: msg, code: '42703' } });
    assert(/Closest by name: [^:]*day_date/.test(toolResultsSeen(model.sent)[0]),
      `${shape}: day_date was not offered`);
  });
}

await test('a relation outside the schema map degrades to the bare error', async () => {
  const model = installModel([sqlRound('select nope from not_catalogued_at_all'), say('done')]);
  await ask(BASIC, { rpcError: colErr('nope') });
  const r = toolResultsSeen(model.sent)[0];
  assert(/column "nope" does not exist/.test(r), 'the error was lost');
  assert(!/has: /.test(r), `columns were invented for an unknown relation: ${r}`);
});

await test('a timeout is not dressed up as a column problem', async () => {
  const model = installModel([sqlRound(AD_SQL), say('done')]);
  await ask(BASIC, { rpcError: { message: 'canceling statement due to statement timeout' } });
  const r = toolResultsSeen(model.sent)[0];
  assert(!/There is no column/.test(r), `a timeout got a column hint: ${r}`);
});

await test('the hand-written traps still fire', async () => {
  // These encode real, hard-won mistakes; the catalog lookup is additional, not
  // a replacement.
  // Postgres names a qualified column as it was written, which is what the
  // hand-written patterns match on.
  const model = installModel([sqlRound('select f.name from factories f'), say('done')]);
  await ask(BASIC, { rpcError: { message: 'column f.name does not exist', code: '42703' } });
  assert(/factory_name, not name/.test(toolResultsSeen(model.sent)[0]), 'the static hint was dropped');
});

console.log('\n-- one round is held back to use the correction --');

const WALL_CLOCK_BUDGET_MS = 215_000;

/**
 * Runs a scripted request where each model call costs a DIFFERENT amount of
 * time, and a nominated call is cut off the way AbortSignal.timeout cuts one
 * off in production.
 *
 * askWithClock's single `perCall` cannot express the failure this exists for:
 * a call that is SLOWER than the samples the grant was admitted on. With a
 * fixed latency the estimate is always right by construction, which is exactly
 * why the estimator looked like an enforcement boundary.
 */
async function askWithSpike(rounds, callMs, { abortOnCall = [], ...clientOpts } = {}) {
  const aborts = new Set([abortOnCall].flat());
  const clock = installClock();
  const sent = [];
  const signalled = [];
  try {
    const queue = rounds.slice();
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes('api.anthropic.com')) {
        throw new Error(`unexpected outbound fetch in test: ${url}`);
      }
      sent.push(JSON.parse(init.body));
      signalled.push(Boolean(init.signal));
      const n = sent.length;
      clock.advance(callMs[n - 1] ?? callMs[callMs.length - 1]);
      if (aborts.has(n)) {
        // What a deadline-aborted fetch throws. Scripted rather than driven by
        // a real AbortSignal because the signal fires on REAL time and this
        // clock is fake -- the assertions below pin the deadline VALUE that
        // reached the fetch, which is the half a fake clock can check.
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      if (!queue.length) throw new Error('model called more times than the test scripted');
      const body = queue.shift();
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
    const out = await ask(BASIC, clientOpts);
    return { ...out, sent, signalled, remaining: () => queue.length };
  } finally {
    clock.restore();
  }
}

/** The handler drives a REAL clock through a fake offset, so a deadline it
 *  computes lands a millisecond or two under the arithmetic. modelCallTimeoutMs
 *  pins the exact number; here the band only has to be tight enough to tell the
 *  right reservation from a missing one (22s against 44s). */
function eqDeadline(actual, expected, msg) {
  assert(Math.abs(actual - expected) <= 100, `${msg} -- expected ~${expected}ms, got ${actual}ms`);
}

/** Runs a scripted request with time advanced by `perCall` on each model call. */
async function askWithClock(rounds, perCall, clientOpts) {
  const clock = installClock();
  try {
    const model = installModel(rounds, () => clock.advance(perCall));
    const out = await ask(BASIC, clientOpts);
    return { ...out, model };
  } finally {
    clock.restore();
  }
}

console.log('\n-- the correction reservation, as exact arithmetic --');

// Figures in the comments below were written against the 95s/140s budget;
// since 2026-09-28 every elapsed value carries +120s (see BUDGET_SHIFT_MS).

// The handler tests below prove the WIRING: that a grant and a refusal both
// happen and that the request lands inside the gateway. They cannot pin the
// formula, because driving real elapsed time lands within a millisecond or two
// of any boundary and two mutations survived in exactly that gap. Here the
// numbers are inputs, so each term can be isolated.

test('the floor is applied even when the observed calls are cheaper', () => {
  // 104s elapsed with 13s calls: trusting the observation fits (140s exactly),
  // the 15s floor does not (144s). Lower the floor away and this goes green.
  const at = { elapsedMs: 224_000, modelCallMs: [13_000, 13_000] };
  eq(correctionRoundFits(at), false, 'the floor stopped being applied');
  eq(correctionRoundFits({ ...at, floorMs: 1_000 }), true, 'the case does not actually discriminate');
});

test('the MEASURED latency is read, not just the floor', () => {
  // 100s elapsed with 25s calls: the floor alone would fit (140s exactly), the
  // real timings do not (160s).
  const at = { elapsedMs: 220_000, modelCallMs: [25_000, 24_000] };
  eq(correctionRoundFits(at), false, 'measured latency stopped being read');
  eq(correctionRoundFits({ ...at, modelCallMs: [] }), true, 'the case does not actually discriminate');
});

test('BOTH model calls are reserved -- the correction and the forced final', () => {
  // 100s elapsed, 20s calls. One call reserved fits (130s); two do not (150s).
  // Dropping the final answer's own call is the mistake that produced a 157s
  // worst case against a 150s gateway.
  const at = { elapsedMs: 220_000, modelCallMs: [20_000] };
  eq(correctionRoundFits(at), false, 'the forced final answer stopped being reserved for');
  const oneCall = at.elapsedMs + 20_000 + QUERY_CEILING_MS <= GATEWAY_SAFE_MS;
  eq(oneCall, true, 'the case does not actually discriminate');
});

test('the query ceiling is reserved too', () => {
  // 105s + two 15s calls = 135s, which fits; the 10s query pushes it to 145s,
  // which does not. 100s would have fitted either way and proven nothing.
  const at = { elapsedMs: 225_000, modelCallMs: [15_000] };
  eq(correctionRoundFits(at), false, 'query time stopped being reserved');
  eq(correctionRoundFits({ ...at, queryCeilingMs: 0 }), true, 'the case does not actually discriminate');
});

test('a cheap request at the budget boundary still fits', () => {
  // The window this exists to keep open: reached 95s through many quick rounds.
  eq(correctionRoundFits({ elapsedMs: 216_000, modelCallMs: [12_000, 11_000] }), true, 'the window is shut');
});

test('the Sonic request would NOT have been granted one', () => {
  // 17.1s per model call, ~121s elapsed at its round-6 boundary. Stated plainly
  // because the first version of this feature was written for that request and
  // would not have fired on it either -- F1's catalog hint is the half that
  // works regardless of budget.
  eq(correctionRoundFits({ elapsedMs: 240_893, modelCallMs: [17_094, 17_094] }), false, 'Sonic would have been granted a round');
});

// --- the deadline that the estimate above is NOT ---
//
// correctionRoundFits admits a correction from what earlier rounds cost. Cycle
// 2 named the gap: the two calls it reserves for have not happened yet, and a
// call slower than the samples is ordinary latency variation rather than a code
// error. Nothing made the estimate binding on those calls, so overshooting it
// reached the 150s gateway -- which writes no answer and no audit row.

test('a correction round reserves its query AND the forced final', () => {
  // 96s in, 44s of margin left. The correction call may have 22s of it; the
  // other 22s belongs to the query it will run and the answer that reports it.
  eq(modelCallTimeoutMs({ elapsedMs: 216_000, reserveMs: QUERY_CEILING_MS + MIN_FINAL_CALL_MS }), 22_000,
    'the correction deadline stopped reserving what has to follow it');
  eq(modelCallTimeoutMs({ elapsedMs: 216_000 }), 44_000,
    'the case does not actually discriminate');
});

test('the forced final may use the whole remaining margin', () => {
  // Nothing is reserved past it, so reserving anything would shorten the one
  // call that has to produce the answer.
  eq(modelCallTimeoutMs({ elapsedMs: 238_000 }), 22_000, 'the final answer lost margin it was owed');
});

test('a deadline already passed is 0, never negative', () => {
  // A negative would be handed to AbortSignal.timeout as a duration, which
  // rounds it to an immediate abort at best; 0 is what callers read as "do not
  // start this call".
  eq(modelCallTimeoutMs({ elapsedMs: 265_000 }), 0, 'an expired deadline came back negative');
  eq(modelCallTimeoutMs({ elapsedMs: 259_999 }), 1, 'the case does not actually discriminate');
});

test('the deadline is measured from the gateway-safe line, not the 150s gateway', () => {
  eq(modelCallTimeoutMs({ elapsedMs: 0 }), GATEWAY_SAFE_MS, 'the hard deadline moved off the safe line');
  assert(GATEWAY_SAFE_MS < WORKER_WALL_CLOCK_MS, 'a call could be admitted right up to the worker wall clock itself');
});

test('every admissible grant leaves the correction call real time to run in', () => {
  // This is the invariant that makes a zero-deadline guard at the grant site
  // dead code, so it is asserted where a change to either constant fails it.
  // Scanned rather than argued: any elapsed/latency pair the estimator admits
  // must leave the correction call more than nothing.
  for (let elapsedMs = 215_000; elapsedMs <= 260_000; elapsedMs += 250) {
    for (const call of [0, 12_000, 15_000, 17_100, 25_000]) {
      const modelCallMs = call ? [call] : [];
      if (!correctionRoundFits({ elapsedMs, modelCallMs })) continue;
      const deadline = modelCallTimeoutMs({ elapsedMs, reserveMs: QUERY_CEILING_MS + MIN_FINAL_CALL_MS });
      assert(deadline > 0, `admitted at ${elapsedMs}ms with ${call}ms calls but left ${deadline}ms to run in`);
    }
  }
});

test('the gateway margin is real', () => {
  // A worker can already have been running when a request lands on it, so the
  // safe line keeps a wide margin under the wall clock, not a 10s one.
  assert(GATEWAY_SAFE_MS <= WORKER_WALL_CLOCK_MS - 100_000, 'too little margin below the worker wall clock');
  assert(MODEL_CALL_FLOOR_MS * 2 + QUERY_CEILING_MS < GATEWAY_SAFE_MS - WALL_CLOCK_BUDGET_MS,
    'the floor leaves no window at all above the round-start budget');
});

// Latencies are chosen against the real arithmetic, not for convenience: a
// grant needs elapsed >= 95s AND elapsed + 2*worstCall + 10s <= 140s, so it is
// only reachable when rounds have been cheap. 12s x 8 calls lands at 96s with a
// 15s floor -> 96 + 30 + 10 = 136s, inside the reservation.
const CHEAP_CALL_MS = 12_000;
// The old 150s gateway sat 10s past the old safe line; keep that tightness.
const GATEWAY_MS = GATEWAY_SAFE_MS + 10_000;
const failingRounds = (n) => Array.from({ length: n }, () => sqlRound(AD_SQL));

await test('a correctable failure buys one more round when the time still fits', async () => {
  const { model, json, client } = await askWithClock(
    [...failingRounds(8), sqlRound(AD_SQL.replace('min(date)', 'min(day_date)')), say('corrected answer')],
    CHEAP_CALL_MS,
    { rpcError: (n) => (n <= 8 ? colErr('date') : null), rpcResults: [{ ad_id: '1', spend: 25488.06 }] },
  );
  eq(model.remaining(), 0, 'the granted round was never taken');
  const q = auditRow(client).diagnostics.queries;
  eq(q.length, 9, 'the retry did not run');
  eq(q[8].ok, true, 'the corrected query did not succeed');
  eq(q[8].round, 9, 'the correction did not run in the granted round');
  assert(json.answer.includes('corrected answer'), `answer text: ${json.answer}`);
  eq(auditRow(client).diagnostics.context.correction_round_granted, true, 'grant not recorded');
});

await test('...and the whole request still lands inside the gateway deadline', async () => {
  // The property the old fixed cutoff did not have. 150s returns a bare 504 and
  // writes no audit row at all, so finishing at or past it is the failure this
  // budget exists to avoid -- not a slow answer, no answer.
  const { client } = await askWithClock(
    [...failingRounds(8), sqlRound(AD_SQL.replace('min(date)', 'min(day_date)')), say('corrected answer')],
    CHEAP_CALL_MS,
    { rpcError: (n) => (n <= 8 ? colErr('date') : null), rpcResults: [{ ad_id: '1', spend: 1 }] },
  );
  const elapsed = auditRow(client).diagnostics.context.elapsed_ms;
  assert(elapsed < GATEWAY_MS, `finished at ${elapsed}ms, at or past the ${GATEWAY_MS}ms gateway`);
});

await test('...and the granted round is told to spend it on the failed query', async () => {
  const { model } = await askWithClock(
    [...failingRounds(8), sqlRound(AD_SQL), say('done')],
    CHEAP_CALL_MS,
    { rpcError: colErr('date') },
  );
  const bodies = model.sent;
  const granted = bodies[8].messages[bodies[8].messages.length - 1].content;
  assert(/One extra round/.test(granted), `no correction instruction: ${JSON.stringify(granted).slice(0, 200)}`);
  assert(/SINGLE most valuable query that failed/.test(granted), 'it was not pointed at the failed query');
  assert(!/Investigation checkpoint/.test(granted), 'the checkpoint contradicted the correction in the same round');
});

// Each refusal below sits in a window where ONLY the correct arithmetic
// refuses. A refusal far past the threshold proves nothing: the first version
// of this was one test at 28s x 4 rounds (112s elapsed), and every wrong
// variant of the reservation refused there too, so three mutations survived.
// The reservation is elapsed + 2*worstCall + 10s <= 140s, worstCall =
// max(15s, observed).

await test('refused when reserving BOTH model calls is what does not fit', async () => {
  // 20s x 5 = 100s. Two calls reserved: 100 + 40 + 10 = 150 > 140, refused.
  // Reserve only the correction call and it would fit (130), so this fails if
  // the forced final answer stops being reserved for.
  const { model, json, client } = await askWithClock(
    [...failingRounds(5), say('partial answer')], 20_000, { rpcError: colErr('date') },
  );
  eq(model.remaining(), 0, 'a round was granted that left no room for the final answer');
  eq(json.partial, true, 'expected a partial answer');
  eq(auditRow(client).diagnostics.context.correction_round_granted, false, 'grant recorded on a refusal');
  assert(auditRow(client).diagnostics.context.elapsed_ms < GATEWAY_MS, 'finished at or past the gateway');
});

await test('refused when the FLOOR is what does not fit, despite cheap rounds', async () => {
  // The check fires at the FIRST round past 95s, not at a round of the test's
  // choosing -- 10s calls reach that boundary at 100s, where both readings fit
  // and nothing is proven. 13s x 8 lands it at 104s instead: the floor holds
  // worstCall at 15s, so 104 + 30 + 10 = 144 > 140 and it is refused, while
  // trusting the observed 13s fits exactly (140). Lower the floor away and this
  // goes green.
  const { model, json, client } = await askWithClock(
    [...failingRounds(8), say('partial answer')], 13_000, { rpcError: colErr('date') },
  );
  eq(model.remaining(), 0, 'the floor stopped being applied');
  eq(json.partial, true, 'expected a partial answer');
  eq(auditRow(client).diagnostics.context.correction_round_granted, false, 'grant recorded on a refusal');
});

await test('refused when the MEASURED latency is what does not fit', async () => {
  // 25s x 4 = 100s. Observed 25s: 100 + 50 + 10 = 160 > 140. Fall back to the
  // 15s floor and it fits exactly (140), so this fails if the real timings stop
  // being read. The Sonic request is this shape -- 17.1s calls, ~121s elapsed
  // at its boundary -- and is refused for the same reason.
  const { model, json, client } = await askWithClock(
    [...failingRounds(4), say('partial answer')], 25_000, { rpcError: colErr('date') },
  );
  eq(model.remaining(), 0, 'measured latency stopped being read');
  eq(json.partial, true, 'expected a partial answer');
  eq(auditRow(client).diagnostics.context.correction_round_granted, false, 'grant recorded on a refusal');
  assert(auditRow(client).diagnostics.context.elapsed_ms < GATEWAY_MS, 'finished at or past the gateway');
});

await test('the per-call timings behind the decision are recorded', async () => {
  // A refusal must be diagnosable from the record, or it is indistinguishable
  // from "there was no correctable error".
  const { client } = await askWithClock(
    [...failingRounds(4), say('partial answer')], 25_000, { rpcError: colErr('date') },
  );
  const ms = auditRow(client).diagnostics.context.model_call_ms;
  assert(Array.isArray(ms) && ms.length >= 4, `model_call_ms: ${JSON.stringify(ms)}`);
  assert(Math.max(...ms) >= 25_000, 'the timings do not reflect the scripted latency');
});

await test('a TIMEOUT buys nothing, however cheap the rounds have been', async () => {
  // Re-running the same heavy statement is not a correction, and against the
  // real ~8s query ceiling it would time out again. This pins the exclusion in
  // CORRECTABLE_QUERY_ERROR: widen that pattern to match a timeout and it fails.
  const { model, json } = await askWithClock(
    [...failingRounds(8), say('partial answer')],
    CHEAP_CALL_MS,
    { rpcError: { message: 'canceling statement due to statement timeout' } },
  );
  eq(model.remaining(), 0, 'the model was called an unexpected number of times');
  eq(json.partial, true, 'a timed-out request was not reported as partial');
});

await test('at most ONE correction round, however many failures follow', async () => {
  const { model, json } = await askWithClock(
    [...failingRounds(8), sqlRound(AD_SQL), say('still partial')],
    CHEAP_CALL_MS,
    { rpcError: colErr('date') },
  );
  eq(model.remaining(), 0, 'more than one correction round was granted');
  eq(json.partial, true, 'the second failure should still end as a partial answer');
});

await test('a healthy request is unaffected by any of this', async () => {
  const { model, json } = await askWithClock([sqlRound(AD_SQL), say('fine')], 1_000, { rpcResults: [{ a: 1 }] });
  eq(model.remaining(), 0, 'round count changed for a healthy request');
  eq(json.answer, 'fine', 'answer');
  assert(!('partial' in json), 'a healthy request was marked partial');
});

console.log('\n-- an admitted correction is bounded, not just predicted --');

// 16s x 6 = 96s elapsed at the seventh round's top. worstCall 16s, so
// 96 + 32 + 10 = 138 <= 140: admitted. The grant then reserves the query and
// the final, leaving the correction call 140 - 96 - 22 = 22s.
const SPIKE_CALLS = [16_000, 16_000, 16_000, 16_000, 16_000, 16_000];
const spikeRounds = (tail) => [...failingRounds(6), ...tail];

await test('the correction call is handed an absolute deadline, not a hope', async () => {
  const { client } = await askWithSpike(
    spikeRounds([sqlRound(AD_SQL), say('partial answer')]),
    [...SPIKE_CALLS, 15_000, 15_000],
    { rpcError: colErr('date') },
  );
  const ctx = auditRow(client).diagnostics.context;
  eq(ctx.correction_round_granted, true, 'the scenario did not actually grant a correction');
  eq(ctx.model_call_deadline_ms.slice(0, 6), [0, 0, 0, 0, 0, 0],
    'an ordinary in-budget round was given a deadline it does not need');
  eqDeadline(ctx.model_call_deadline_ms[6], 22_000,
    'the correction call carried no deadline, or not the one that reserves what follows it');
});

await test('a correction slower than every sample loses the round, not the answer', async () => {
  // The cycle-2 failure exactly: earlier calls cheap enough to admit the grant,
  // then a correction call that runs long. Unbounded it reaches the gateway at
  // 96 + 60 + 15 = 171s and the user gets a bare 504 with no audit row. Bounded
  // it is cut off at its 22s deadline, and the time that was held back for the
  // forced final is still there to write the partial answer with.
  const { json, client, signalled, remaining } = await askWithSpike(
    spikeRounds([say('partial answer')]),
    [...SPIKE_CALLS, 22_000, 15_000],
    { rpcError: colErr('date'), abortOnCall: 7 },
  );
  eq(signalled[6], true, 'the correction fetch went out with no abort signal at all');
  eq(remaining(), 0, 'the forced final never ran');
  assert(json.answer && json.answer.includes('partial answer'), `no answer came back: ${JSON.stringify(json).slice(0, 200)}`);
  eq(json.partial, true, 'a deadline-cut correction was reported as a complete answer');
  const ctx = auditRow(client).diagnostics.context;
  assert(ctx.elapsed_ms < GATEWAY_MS, `finished at ${ctx.elapsed_ms}ms, at or past the ${GATEWAY_MS}ms gateway`);
  eqDeadline(ctx.model_call_deadline_ms[7], 22_000, 'the forced final was left unbounded');
});

await test('...and the queries gathered before it are still in the answer path', async () => {
  // Losing the correction must not lose the investigation: the six results that
  // preceded it are what the partial answer is built from.
  const { client } = await askWithSpike(
    spikeRounds([say('partial answer')]),
    [...SPIKE_CALLS, 22_000, 15_000],
    { rpcError: colErr('date'), abortOnCall: 7 },
  );
  eq(auditRow(client).diagnostics.queries.length, 6, 'the gathered queries were dropped with the round');
  eq(auditRow(client).status, 'ok', 'a deadline-cut correction was audited as a failed request');
});

await test('...and prose already written is shipped rather than dropped', async () => {
  // A round answered and was cut off by the output limit, so answerSoFar holds
  // real text; then the forced continuation runs past its deadline. Before this
  // branch that paid-for prose was replaced by the generic out-of-time message.
  const { json, client } = await askWithSpike(
    // Calls 1-5 query and fail, call 6 answers and is cut off by the output
    // limit (96s elapsed), and the forced final that would finish it is then
    // cut off by its own deadline.
    [...failingRounds(5), say('THE PART THAT WAS WRITTEN.', 'max_tokens'), say('never arrives')],
    [...SPIKE_CALLS, 22_000, 22_000],
    { rpcError: colErr('date'), abortOnCall: 7 },
  );
  assert(json.answer && json.answer.includes('THE PART THAT WAS WRITTEN.'),
    `the already-written prose was dropped: ${JSON.stringify(json).slice(0, 300)}`);
  eq(json.partial, true, 'a deadline-cut answer was reported as complete');
  const row = auditRow(client);
  assert(row, 'no audit row was written');
  assert(/cut off by its own deadline/.test(row.error_message || ''),
    `the deadline cause was not recorded: ${row.error_message}`);
});

await test('one slow in-budget round cannot push an UNBOUNDED final past the gateway', async () => {
  // Only post-budget calls carry a deadline, so an ordinary round that starts
  // at 94s and runs long is the one way to arrive at the forced final with the
  // safe line already spent. A remaining budget of 0 must not read as
  // "unbounded" there -- that call is exactly the one the gateway kills, and a
  // gateway kill writes nothing at all.
  const { json, client, remaining } = await askWithSpike(
    [sqlRound(AD_SQL), say('should never be asked for')],
    [145_000],
    { rpcError: colErr('date') },
  );
  eq(remaining(), 1, 'the forced final went out with no time left to run in');
  assert(!json.answer, `an answer came back from a call that should not have been made: ${JSON.stringify(json).slice(0, 200)}`);
  const row = auditRow(client);
  assert(row, 'no audit row was written -- the invisible-504 failure mode survived');
  eq(row.status, 'error', 'an unanswered request was audited as ok');
});

await test('a forced final that also overruns still leaves an audit row behind', async () => {
  // The harsher case, and the one the gateway handles worst. There is no answer
  // to be had -- but "no answer, recorded as out of time" is a row in
  // silo_chat_health_v, where the 504 it replaces is invisible.
  const { json, client } = await askWithSpike(
    spikeRounds([say('never arrives')]),
    [...SPIKE_CALLS, 22_000, 22_000],
    { rpcError: colErr('date'), abortOnCall: [7, 8] },
  );
  assert(!json.answer, `an answer came back from a call that never returned: ${JSON.stringify(json).slice(0, 200)}`);
  const row = auditRow(client);
  assert(row, 'no audit row was written -- the 504 failure mode survived');
  assert(row.diagnostics.context.elapsed_ms < GATEWAY_MS,
    `finished at ${row.diagnostics.context.elapsed_ms}ms, at or past the ${GATEWAY_MS}ms gateway`);
});

console.log('\n-- the record says which round, and whether a correction was granted --');

await test('every logged query carries the round it ran in', async () => {
  // Absent until now, and its absence is what left the Sonic trace unable to
  // say whether the failed spend query shared a round with a successful one.
  installModel([sqlRound(AD_SQL), say('done')]);
  const { client } = await ask(BASIC, { rpcResults: [{ a: 1 }] });
  eq(auditRow(client).diagnostics.queries[0].round, 1, 'round index');
});

await test('a request with no correctable error records no grant', async () => {
  // The granted and refused cases are asserted by the budget tests above; this
  // is the third state -- nothing went wrong, so nothing was reserved.
  installModel([sqlRound(AD_SQL), say('done')]);
  const { client } = await ask(BASIC, { rpcResults: [{ a: 1 }] });
  eq(auditRow(client).diagnostics.context.correction_round_granted, false, 'ungranted case');
});

console.log('\n-- the answer is checked against the envelopes it was written from --');

const SONIC_SALES_SQL = "select product_title, day_date, sum(units_sold) as units from sales_by_product_title_daily_v where product_title ilike '%sonic%' and day_date between '2026-08-01' and '2026-09-15' group by product_title, day_date";

await test('a channel word on a channel-pooled request is flagged in the answer', async () => {
  installModel([sqlRound(SONIC_SALES_SQL), say('Sonic sold 924 units online on launch day.')]);
  const { json } = await ask(BASIC, { rpcResults: [{ product_title: 'Sonic Tee', units: 924 }] });
  assert(/Scope check \(automatic\)/.test(json.answer), `no scope note in the answer: ${json.answer}`);
  assert(/"online"/.test(json.answer), 'the offending word is not quoted back');
  eq(json.claim_flags[0].label, 'sales channel', 'claim_flags on the response');
});

await test('...and the note is in the PERSISTED answer, not just the response', async () => {
  // The client saves and recovers answer TEXT and does not retain response
  // fields, so a note that lived only on the response would vanish on recovery
  // and the recovered answer would read as verified.
  installModel([sqlRound(SONIC_SALES_SQL), say('Sonic sold 924 units online on launch day.')]);
  const { client } = await ask(BASIC, { rpcResults: [{ product_title: 'Sonic Tee', units: 924 }] });
  const row = auditRow(client);
  assert(/Scope check \(automatic\)/.test(row.answer), 'the audit row lost the scope note');
  eq(row.diagnostics.context.claim_flags[0].terms, ['online'], 'claim_flags in diagnostics');
});

await test('an answer that makes no such claim is left alone', async () => {
  installModel([sqlRound(SONIC_SALES_SQL), say('Sonic sold 924 units on launch day.')]);
  const { json, client } = await ask(BASIC, { rpcResults: [{ product_title: 'Sonic Tee', units: 924 }] });
  eq(json.answer, 'Sonic sold 924 units on launch day.', 'a clean answer was modified');
  assert(!('claim_flags' in json), 'a clean answer carried claim_flags');
  eq(auditRow(client).diagnostics.context.claim_flags, [], 'diagnostics should record an empty check');
});

await test('a request that narrowed the channel may say it', async () => {
  const narrowed = "select sum(net_sales) from sales_by_product_title_daily_v where location_tag = 'online'";
  installModel([sqlRound(narrowed), say('Online net sales were $212,080.')]);
  const { json } = await ask(BASIC, { rpcResults: [{ sum: 212080 }] });
  assert(!/Scope check/.test(json.answer), `a narrowed request was flagged: ${json.answer}`);
});

await test('an online-filtered sales_by_day request may say "online" (live 2026-09-27 false flag)', async () => {
  // sales_by_day carries location_tag AND location_name; filtering the tag
  // leaves the name ungrouped, which the note used to read as "nothing
  // restricted sales channel" on every correctly labelled online figure.
  const online = "SELECT day_date, SUM(total_net_sales) FROM sales_by_day WHERE location_tag = 'online' AND day_date >= '2026-08-28' AND day_date <= '2026-09-26' GROUP BY 1";
  installModel([sqlRound(online), say('Online net sales were $1,066,995 over the last 30 complete days.')]);
  const { json } = await ask(BASIC, { rpcResults: [{ day_date: '2026-09-26', sum: 35000 }] });
  assert(!/Scope check/.test(json.answer), `a correctly labelled online figure was flagged: ${json.answer}`);
});

await test('an answer that names the combination is not flagged (live 02:52 answer)', async () => {
  const all = "SELECT SUM(total_net_sales) FROM sales_by_day WHERE day_date >= '2026-06-29' AND day_date <= '2026-09-26'";
  installModel([sqlRound(all), say('Across all store locations (online plus retail), net sales totaled $8,844,752.')]);
  const { json } = await ask(BASIC, { rpcResults: [{ sum: 8844752 }] });
  assert(!/Scope check/.test(json.answer), `a combined label was flagged: ${json.answer}`);
});

await test('an answer over the configured online mapping may say "online"', async () => {
  const mapped = "SELECT sum(total_net_sales) FROM sales_by_day WHERE location_tag = any(silo_channel_location_tags('online')) AND day_date BETWEEN '2026-09-14' AND '2026-09-20'";
  installModel([sqlRound(mapped), say('Online sales last week were $153,155.')]);
  const { json } = await ask(BASIC, { rpcResults: [{ sum: 153155 }] });
  assert(!/Scope check/.test(json.answer), `a mapped online figure was flagged: ${json.answer}`);
});

console.log('\n-- a period boundary is traced to where it came from --');

await test('a date from an earlier result is sourced; an invented one is not', async () => {
  // Mirrors the live shape: the planning record (which answers the launch date
  // and is SILENT on prelaunch), then a coverage check, then the sales query.
  // 2026-09-15 is therefore traceable and 2026-08-01 is not -- which is exactly
  // the asymmetry production had and nothing recorded.
  const model = installModel([
    sqlRound('select title, launch_date, preview_start_date from launch_calendar'),
    sqlRound('select max(day_date) as max_d from sales_by_day'),
    sqlRound(SONIC_SALES_SQL),
    say('done'),
  ]);
  await ask(BASIC, {
    rpcResults: (n) => {
      if (n === 1) return [{ title: 'Baseballism x Sonic the Hedgehog', launch_date: '2026-09-01', preview_start_date: null }];
      if (n === 2) return [{ max_d: '2026-09-15' }];
      return [{ product_title: 'Sonic Tee', units: 924 }];
    },
  });
  const shown = JSON.parse(toolResultsSeen(model.sent)[2]);
  const p = shown.evidence_scope.date_scope.boundary_provenance;
  eq(p.unsourced, ['2026-08-01'], 'the invented prelaunch boundary');
  eq(p.from_results, ['2026-09-15'], 'the boundary that WAS traceable to a queried value');
});

await test('a statement cannot source its own literals from its own result', async () => {
  // The harvest runs AFTER the envelope is built. Reverse that and every
  // boundary looks sourced, because the rows contain the dates the query asked
  // for -- which is the one way this check could quietly become useless.
  const model = installModel([sqlRound(SONIC_SALES_SQL), say('done')]);
  await ask(BASIC, { rpcResults: [{ product_title: 'Sonic Tee', day_date: '2026-08-01', units: 3 }] });
  const p = JSON.parse(toolResultsSeen(model.sent)[0]).evidence_scope.date_scope.boundary_provenance;
  assert(p.unsourced.includes('2026-08-01'), 'a statement sourced its own boundary from its own rows');
});

await test('a date the person asked about counts as supplied', async () => {
  const model = installModel([sqlRound(SONIC_SALES_SQL), say('done')]);
  await ask({
    history: [{ role: 'user', content: 'How did Sonic sell between 2026-08-01 and 2026-09-15?' }],
    request_id: REQUEST_ID,
  }, { rpcResults: [{ units: 1 }] });
  const p = JSON.parse(toolResultsSeen(model.sent)[0]).evidence_scope.date_scope.boundary_provenance;
  assert(!p.unsourced, `dates the person gave were called invented: ${JSON.stringify(p)}`);
  eq(p.from_question.sort(), ['2026-08-01', '2026-09-15'], 'question-supplied dates');
});


// ── prompt guidance is selected per request, and never grants a tool ───────
//
// These run the real handler and read the system prompt and tool list it
// actually SENT, so they cover the wiring between selectGuidance(),
// buildSystemPrompt() and the authorization decision -- the part a
// prompt-lib unit test cannot see.

const SEO_HEAD = 'SEO, SEARCH AND SITE TRAFFIC --';
const MARKETING_HEAD = 'MARKETING, ADVERTISING AND LAUNCHES --';
const CONCEPT_HEAD = 'PRODUCT CONCEPTS:';
const CONCEPT_HINT_HEAD = 'Product Concepts: you have access to a structured product-concept workflow';
const CONCEPT_TOOL_NAMES = ['create_product_concept', 'update_product_concept', 'approve_product_concept'];
const systemOf = (sent) => sent[0].system.map((b) => b.text).join('');
const toolNamesOf = (sent) => sent[0].tools.map((t) => t.name).filter(Boolean);
const convo = (...turns) => ({
  history: turns.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content })),
  request_id: REQUEST_ID,
});

await test('an ordinary sales question carries the core only, and no concept tools', async () => {
  const model = installModel([say('Sales were $10.')]);
  const { client } = await ask(BASIC);
  const sys = systemOf(model.sent);
  for (const head of [SEO_HEAD, MARKETING_HEAD, CONCEPT_HEAD, CONCEPT_HINT_HEAD]) {
    assert(!sys.includes(head), `ordinary question carried: ${head}`);
  }
  assert(sys.includes('EVERY FIGURE KEEPS THE POPULATION IT CAME FROM'), 'core scope rules missing');
  assert(sys.includes('WHEN YOU SIMPLIFY, THE QUALIFIERS ARE PART OF THE ANSWER'), 'core simplify rule missing');
  for (const t of CONCEPT_TOOL_NAMES) assert(!toolNamesOf(model.sent).includes(t), `${t} was sent`);
  eq(auditRow(client).diagnostics.context.guidance_modules, [], 'recorded guidance modules');
});

await test('an SEO question carries the SEO guidance and records it', async () => {
  const model = installModel([say('ok')]);
  const { client } = await ask(convo('Which collection pages should we rewrite meta descriptions for?'));
  assert(systemOf(model.sent).includes(SEO_HEAD), 'SEO guidance missing');
  eq(auditRow(client).diagnostics.context.guidance_modules, ['seo'], 'recorded guidance modules');
});

await test('a hyphenated meta-description request carries SEO, not marketing (review cycle 1)', async () => {
  const model = installModel([say('ok')]);
  const { client } = await ask(convo('audit the homepage meta-description'));
  const sys = systemOf(model.sent);
  assert(sys.includes(SEO_HEAD), 'SEO guidance missing');
  assert(!sys.includes(MARKETING_HEAD), 'meta-description read as Meta advertising');
  eq(auditRow(client).diagnostics.context.guidance_modules, ['seo'], 'recorded guidance modules');
});

await test('an open-ended business review carries the marketing guidance (2026-09-27 live run)', async () => {
  const model = installModel([say('ok')]);
  const { client } = await ask(convo('Look at past 30 days of business suggest improvements'));
  assert(systemOf(model.sent).includes(MARKETING_HEAD), 'business review ran without marketing guidance');
  eq(auditRow(client).diagnostics.context.guidance_modules, ['marketing'], 'recorded guidance modules');
});

await test('a launch/ads comparison carries the marketing guidance', async () => {
  const model = installModel([say('ok')]);
  await ask(convo('Compare Meta spend and sales for the Back To School launch vs Labor Day'));
  const sys = systemOf(model.sent);
  assert(sys.includes(MARKETING_HEAD), 'marketing guidance missing');
  assert(!sys.includes(SEO_HEAD), 'SEO guidance loaded for a paid-media question');
});

await test('"simplify that" keeps the guidance the previous turn needed', async () => {
  const model = installModel([say('ok')]);
  await ask(convo(
    'How are our collection pages doing in Google search?',
    'Search clicks to collection pages were 4,210 over the 28 days of data we hold...',
    'simplify that',
  ));
  assert(systemOf(model.sent).includes(SEO_HEAD), 'follow-up lost the SEO guidance');
});

await test('the system prompt and tools are identical on every round of one request', async () => {
  const model = installModel([toolRound(1), toolRound(2), say('done')]);
  await ask(convo('How did the Sonic launch do on TikTok ads?'));
  assert(model.sent.length === 3, `expected 3 model calls, got ${model.sent.length}`);
  for (const later of model.sent.slice(1)) {
    eq(later.system, model.sent[0].system, 'system prompt changed between rounds');
    eq(later.tools, model.sent[0].tools, 'tools changed between rounds');
  }
});

await test('concept wording alone, without the workflow, never adds concept guidance or tools', async () => {
  const model = installModel([say('ok')]);
  await ask(convo('Draft a new product concept for a youth hoodie collection'));
  const sys = systemOf(model.sent);
  assert(!sys.includes(CONCEPT_HEAD), 'concept block loaded from wording alone, without the workflow');
  for (const t of CONCEPT_TOOL_NAMES) assert(!toolNamesOf(model.sent).includes(t), `${t} was sent from wording alone`);
});

await test('an analytical question without the workflow gets the hint, not the tools', async () => {
  const model = installModel([say('ok')]);
  await ask(convo('Draft a demand plan for our launch collection by product type'));
  const sys = systemOf(model.sent);
  assert(sys.includes(CONCEPT_HINT_HEAD), 'caller was not told the workflow exists');
  assert(!sys.includes(CONCEPT_HEAD), 'concept block loaded without the workflow');
  for (const t of CONCEPT_TOOL_NAMES) assert(!toolNamesOf(model.sent).includes(t), `${t} was sent without the workflow`);
});

await test('explicit concept mode carries the concept block, launch guidance and tools', async () => {
  const model = installModel([say('ok')]);
  const { client } = await ask(
    { ...convo('Something for summer, a new cap idea'), workflow: 'product_concept' },
  );
  const sys = systemOf(model.sent);
  assert(sys.includes(CONCEPT_HEAD), 'concept block missing');
  assert(sys.includes(MARKETING_HEAD), 'launch guidance concept grounding relies on is missing');
  assert(!sys.includes(CONCEPT_HINT_HEAD), 'hint shown alongside the active workflow');
  for (const t of CONCEPT_TOOL_NAMES) assert(toolNamesOf(model.sent).includes(t), `${t} missing in concept mode`);
  eq(auditRow(client).diagnostics.context.guidance_modules, ['marketing'], 'recorded guidance modules');
});

await test('a concept card action (conceptId) turns concept mode on for any caller', async () => {
  const withId = { history: [{ role: 'user', content: 'Cut the buy 25%', conceptId: 'c-1' }], request_id: REQUEST_ID };
  const model = installModel([say('ok')]);
  await ask(withId);
  assert(systemOf(model.sent).includes(CONCEPT_HEAD), 'card action lost the concept block');
  for (const t of CONCEPT_TOOL_NAMES) assert(toolNamesOf(model.sent).includes(t), `${t} missing from a card action`);
});


// ── volume: provider pushback, the shared cached core, usage, concurrency ───
//
// Sized for 10-15 users (2026-09-27). Until now a 429/529 surfaced as a raw
// "Anthropic API 429" error with an instant retry button, the per-question
// schema slice sat in the middle of the only cached block (so no two
// questions shared a cache entry), and no call's token usage was recorded.

/** Scripted model responses that may be HTTP failures. Each entry is either a
 *  model body (200) or { status, retryAfter, body }. */
function installScriptedModel(steps) {
  const queue = steps.slice();
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('api.anthropic.com')) throw new Error(`unexpected outbound fetch in test: ${url}`);
    sent.push(JSON.parse(init.body));
    if (!queue.length) throw new Error('model called more times than the test scripted');
    const step = queue.shift();
    if (step && typeof step.status === 'number') {
      return {
        ok: false, status: step.status,
        headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? (step.retryAfter ?? null) : null) },
        text: async () => step.body || '{"type":"error"}',
        json: async () => ({}),
      };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => step, text: async () => JSON.stringify(step) };
  };
  return { sent, remaining: () => queue.length };
}
const withUsage = (body, usage) => ({ ...body, usage });

await test('the system prompt is sent as two blocks: the shared core (1h) then this request (5m)', async () => {
  const model = installScriptedModel([say('ok')]);
  await ask(BASIC);
  const sys = model.sent[0].system;
  eq(sys.length, 2, 'block count');
  eq(sys[0].cache_control, { type: 'ephemeral', ttl: '1h' }, 'core cache_control');
  eq(sys[1].cache_control, { type: 'ephemeral' }, 'request cache_control');
  assert(sys[0].text.startsWith('You are the SILO data assistant'), 'core is not first');
  assert(!sys[0].text.includes("Today's date is"), 'the date leaked into the shared core');
});

await test('two different requests send a byte-identical first block', async () => {
  let model = installScriptedModel([say('ok')]);
  await ask(convo('What did we sell last week?'));
  const a = model.sent[0].system[0].text;
  model = installScriptedModel([say('ok')]);
  await ask({ ...convo('Which collection pages should we improve for Google search?'), workflow: 'product_concept' }, undefined, CONCEPT_TESTER);
  eq(model.sent[0].system[0].text === a, true, 'the shared core differs between requests');
  assert(model.sent[0].system[1].text !== a, 'sanity: request blocks should differ');
});

await test('per-call token usage and its totals land in the audit row', async () => {
  installScriptedModel([
    withUsage(toolRound(1), { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 6100, cache_creation_input_tokens: 3000 }),
    withUsage(say('Sales were $10.'), { input_tokens: 300, output_tokens: 20, cache_read_input_tokens: 9100, cache_creation_input_tokens: 0 }),
  ]);
  const { client } = await ask(BASIC);
  const ctx = auditRow(client).diagnostics.context;
  eq(ctx.model_usage, [
    { input: 900, output: 40, cache_read: 6100, cache_write: 3000 },
    { input: 300, output: 20, cache_read: 9100, cache_write: 0 },
  ], 'model_usage');
  eq(ctx.model_usage_total, { input: 1200, output: 60, cache_read: 15200, cache_write: 3000 }, 'model_usage_total');
  eq(ctx.provider_retries, [], 'no retries');
});

await test('a 429 is retried and the question is still answered, with the retry recorded', async () => {
  const model = installScriptedModel([{ status: 429, retryAfter: '0' }, say('Sales were $10.')]);
  const { json, client } = await ask(BASIC);
  eq(json.answer, 'Sales were $10.', 'answer after a retry');
  eq(model.sent.length, 2, 'model calls');
  eq(auditRow(client).diagnostics.context.provider_retries, [{ status: 429, wait_ms: 0 }], 'retry recorded');
});

await test('an overloaded 529 is retried too', async () => {
  installScriptedModel([{ status: 529, retryAfter: '0' }, { status: 529, retryAfter: '0' }, say('ok')]);
  const { json } = await ask(BASIC);
  eq(json.answer, 'ok', 'answered on the third attempt');
});

await test('a persistent 429 becomes a plain busy message, not the raw API error', async () => {
  const model = installScriptedModel([
    { status: 429, retryAfter: '0', body: '{"type":"error","error":{"type":"rate_limit_error","message":"secret-ish detail"}}' },
    { status: 429, retryAfter: '0' },
    { status: 429, retryAfter: '0' },
  ]);
  const { res, json, client } = await ask(BASIC);
  eq(res.status, 503, 'status');
  eq(json.provider_busy, true, 'provider_busy flag');
  eq(json.retryable, true, 'retryable');
  assert(/try it again in about a minute/i.test(json.error), `message: ${json.error}`);
  assert(!/Anthropic API|rate_limit_error|secret-ish/.test(json.error), `raw provider error leaked: ${json.error}`);
  eq(model.sent.length, 3, 'one call plus two retries, then stop');
  eq(auditRow(client).error_message, 'provider_busy: 429', 'audit error_message');
  eq(auditRow(client).status, 'error', 'audit status');
});

await test('a busy provider on the forced final answer is reported as busy, not as "couldn\'t land"', async () => {
  installScriptedModel([...exhaustRounds(), { status: 529, retryAfter: '0' }, { status: 529, retryAfter: '0' }, { status: 529, retryAfter: '0' }]);
  const { res, json } = await ask(BASIC, { rpcResults: [{ a: 1 }] });
  eq(res.status, 503, `status (${json.error})`);
  eq(json.provider_busy, true, 'provider_busy');
});

await test('a spend-cap 429 is not retried and is not reported as busy', async () => {
  const model = installScriptedModel([
    toolRound(1),
    { status: 429, body: '{"type":"error","error":{"type":"rate_limit_error","message":"cap","details":{"error_code":"enforced_spend_limit_reached"}}}' },
  ]);
  const { res, json, client } = await ask(BASIC, { rpcResults: [{ a: 1 }] });
  eq(res.status, 503, `status (${json.error})`);
  eq(json.provider_spend_limit, true, 'provider_spend_limit');
  eq(json.retryable, false, 'retryable');
  eq(json.provider_busy, undefined, 'must not claim busy');
  assert(!/about a minute/i.test(json.error), `told to retry shortly: ${json.error}`);
  assert(!/Anthropic API|enforced_spend/.test(json.error), `raw provider error leaked: ${json.error}`);
  eq(model.sent.length, 2, 'the spend-cap call was retried');
  eq(auditRow(client).error_message, 'provider_spend_limit: 429', 'audit error_message');
  // tool_rounds counts rounds entered, the refused one included -- the same
  // count every other error path records.
  eq(auditRow(client).tool_rounds, 2, 'rounds already used are kept');
});

await test('a configured workspace spend limit (400) is reported as a spend limit, not a raw error', async () => {
  const model = installScriptedModel([
    { status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified workspace API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."}}' },
  ]);
  const { res, json, client } = await ask(BASIC);
  eq(res.status, 503, `status (${json.error})`);
  eq(json.provider_spend_limit, true, 'provider_spend_limit');
  eq(json.retryable, false, 'retryable');
  assert(!/Anthropic API|usage limits/.test(json.error), `raw provider error leaked: ${json.error}`);
  eq(model.sent.length, 1, 'retried');
  eq(auditRow(client).error_message, 'provider_spend_limit: 400', 'audit error_message');
});

await test('a busy failure after real rounds keeps their rounds, usage and retries in the audit row', async () => {
  installScriptedModel([
    withUsage(toolRound(1), { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 6100, cache_creation_input_tokens: 3000 }),
    withUsage(toolRound(2), { input_tokens: 500, output_tokens: 30, cache_read_input_tokens: 9100, cache_creation_input_tokens: 0 }),
    { status: 429, retryAfter: '0' },
    { status: 429, retryAfter: '0' },
    { status: 429, retryAfter: '0' },
  ]);
  const { res, client } = await ask(BASIC, { rpcResults: [{ a: 1 }] });
  eq(res.status, 503, 'status');
  const row = auditRow(client);
  eq(row.error_message, 'provider_busy: 429', 'audit error_message');
  eq(row.tool_rounds, 3, 'tool_rounds (two completed, the refused third entered)');
  const ctx = row.diagnostics.context;
  eq(ctx.model_usage_total, { input: 1400, output: 70, cache_read: 15200, cache_write: 3000 }, 'usage of the calls that succeeded');
  eq(ctx.provider_retries, [{ status: 429, wait_ms: 0 }, { status: 429, wait_ms: 0 }], 'retries');
  assert(Array.isArray(row.diagnostics.queries) && row.diagnostics.queries.length === 2, 'query outcomes kept');
});

await test('a 400 is not retried', async () => {
  const model = installScriptedModel([{ status: 400, body: 'bad request' }]);
  const { res } = await ask(BASIC);
  eq(model.sent.length, 1, 'a rejected request was retried');
  eq(res.status, 500, 'status');
});

await test('concurrent requests do not bleed into each other', async () => {
  // One shared database stub, eight questions in flight at once. The model
  // echoes each request's own question, so any cross-request state -- a
  // shared transcript, query log or company -- shows up as a mismatch.
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
    const q = typeof lastUser.content === 'string' ? lastUser.content : '';
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 20)));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => say(`answer to: ${q}`), text: async () => '' };
  };
  const client = makeClient();
  currentClientFactory = () => client;
  const questions = Array.from({ length: 8 }, (_, i) => `What did store ${i} sell last week?`);
  const results = await Promise.all(questions.map(async (q) => {
    const res = await capturedHandler(request({ history: [{ role: 'user', content: q }], request_id: null }));
    return res.json();
  }));
  results.forEach((j, i) => eq(j.answer, `answer to: ${questions[i]}`, `request ${i}`));
  const rows = wrote(client, 'silo_chat_audit_log').map((r) => r.payload);
  eq(rows.length, questions.length, 'audit rows');
  for (const r of rows) eq(r.answer, `answer to: ${r.question}`, 'an audit row paired one question with another\'s answer');
});


console.log('\n-- AI credit: hold before the first call, charge only a delivered answer --');

// A service-role double for the three credit RPCs. The user-scoped client from
// makeClient() never sees them, and the credit client never sees anything else.
function creditDb({ open = { ok: true, mode: 'enforce', held_micros: 50000 }, step = { ok: true, held_micros: 90000 },
  settle = (a) => ({ ok: true, outcome: a.p_outcome, enforced: true, charged_micros: a.p_outcome === 'succeeded' ? 1234 : 0 }),
  error = null } = {}) {
  const calls = [];
  return {
    calls,
    from() { throw new Error('the credit client must only call the credit RPCs'); },
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (error && error(name)) return { data: null, error: error(name) };
      if (name === 'ai_credit_open') return { data: typeof open === 'function' ? open(args) : open, error: null };
      if (name === 'ai_credit_step') return { data: typeof step === 'function' ? step(args) : step, error: null };
      if (name === 'ai_credit_settle') return { data: settle(args), error: null };
      throw new Error(`credit client called ${name}`);
    },
  };
}
async function askMetered(body, credit, clientOpts) {
  ENV.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const client = makeClient(clientOpts);
  currentClientFactory = (_url, key) => (key === 'service-key' ? credit : client);
  try {
    const res = await capturedHandler(request(body));
    return { res, json: await res.json(), client };
  } finally {
    delete ENV.SUPABASE_SERVICE_ROLE_KEY;
  }
}
const creditCalls = (credit, name) => credit.calls.filter((c) => c.name === name);

await test('the service key is read in exactly one place', async () => {
  const src = readFileSync(INDEX, 'utf8');
  eq(src.split('SUPABASE_SERVICE_ROLE_KEY').length - 1, 1, 'occurrences of the service key');
  eq(src.split('creditClient()').length - 1, 2, 'creditClient is defined once and called once');
});

await test('a delivered answer is charged once, with measured usage, and says so', async () => {
  const credit = creditDb();
  let callsAtFirstModel = null;
  installModel([toolRound(1), say('Sales were $10.')], (n) => { if (n === 1) callsAtFirstModel = credit.calls.map((c) => c.name); });
  globalThis.__usage = null;
  const { json } = await askMetered(BASIC, credit, { rpcResults: [{ total: 10 }] });
  eq(callsAtFirstModel, ['ai_credit_open'], 'the hold is taken BEFORE the first model call');
  eq(creditCalls(credit, 'ai_credit_open')[0].args.p_request, REQUEST_ID, 'request id');
  eq(creditCalls(credit, 'ai_credit_open')[0].args.p_company, COMPANY_A, 'company from the server, not the body');
  eq(creditCalls(credit, 'ai_credit_open')[0].args.p_user, USER.id, 'user');
  eq(creditCalls(credit, 'ai_credit_step').length, 1, 'the second call grew the hold first');
  const settles = creditCalls(credit, 'ai_credit_settle');
  eq(settles.length, 1, 'settled exactly once');
  eq(settles[0].args.p_outcome, 'succeeded', 'outcome');
  eq(json.ai_credit, { status: 'charged', charged_micros: 1234 }, 'per-answer charge in the response');
});

await test('no credit refuses with 402 and never calls the model', async () => {
  const credit = creditDb({ open: { ok: false, mode: 'enforce', reason: 'insufficient_credit' } });
  const model = installModel([]);
  const { res, json } = await askMetered(BASIC, credit);
  eq(res.status, 402, 'status');
  eq(json.credit_exhausted, true, 'flag');
  eq(model.sent.length, 0, 'model calls');
  eq(creditCalls(credit, 'ai_credit_settle').length, 0, 'nothing to settle');
});

await test('a replayed request id is refused, not run twice', async () => {
  const credit = creditDb({ open: { ok: false, mode: 'enforce', reason: 'duplicate' } });
  const model = installModel([]);
  const { res } = await askMetered(BASIC, credit);
  eq(res.status, 409, 'status');
  eq(model.sent.length, 0, 'model calls');
});

await test('an unreachable credit check refuses rather than spending unmetered', async () => {
  const credit = creditDb({ error: (n) => (n === 'ai_credit_open' ? { message: 'connection refused', code: 'PGRST000' } : null) });
  const model = installModel([]);
  const { res, json } = await askMetered(BASIC, credit);
  eq(res.status, 503, 'status');
  eq(json.credit_unavailable, true, 'flag');
  eq(model.sent.length, 0, 'model calls');
});

await test('before the migration is applied the meter is off and Ask SILO is unchanged', async () => {
  const credit = creditDb({ error: (n) => (n === 'ai_credit_open' ? { message: 'Could not find the function public.ai_credit_open', code: 'PGRST202' } : null) });
  installModel([say('Sales were $10.')]);
  const { res, json } = await askMetered(BASIC, credit);
  eq(res.status, 200, 'status');
  eq(json.ai_credit, { status: 'not_metered' }, 'not metered');
  eq(creditCalls(credit, 'ai_credit_settle').length, 0, 'no settle');
});

await test('a failed question is settled free', async () => {
  const credit = creditDb();
  globalThis.fetch = async () => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => 'bad request', json: async () => ({}) });
  const { res } = await askMetered(BASIC, credit);
  eq(res.status, 500, 'status');
  const settles = creditCalls(credit, 'ai_credit_settle');
  eq(settles.length, 1, 'settled once');
  eq(settles[0].args.p_outcome, 'failed', 'outcome');
});

await test('a company switch mid-request discards the answer and charges nothing', async () => {
  const credit = creditDb();
  installModel([say('Sales were $10.')]);
  const { res } = await askMetered(BASIC, credit, { activeCompanies: [COMPANY_A, COMPANY_B] });
  eq(res.status, 409, 'status');
  const settles = creditCalls(credit, 'ai_credit_settle');
  eq(settles.length, 1, 'settled once');
  eq(settles[0].args.p_outcome, 'failed', 'outcome');
});

await test('credit running low stops the investigation and answers from what is held', async () => {
  const credit = creditDb({ step: (a) => ({ ok: false, reason: 'insufficient_credit', held_micros: 50000 }) });
  const model = installModel([toolRound(1), say('Partial: sales were $10.')]);
  const { res, json } = await askMetered(BASIC, credit, { rpcResults: [{ total: 10 }] });
  eq(res.status, 200, 'status');
  eq(model.sent.length, 2, 'one investigation round, then the forced final');
  assert(model.sent[1].tool_choice?.type === 'none', 'the second call is the forced final answer');
  assert(/AI credit ran low/.test(json.answer), 'the answer says why it is partial');
  eq(creditCalls(credit, 'ai_credit_settle')[0].args.p_outcome, 'succeeded', 'a delivered partial answer is charged (capped at the hold)');
});

await test('a settle that fails reports pending, never $0', async () => {
  const credit = creditDb({ error: (n) => (n === 'ai_credit_settle' ? { message: 'db down' } : null) });
  installModel([say('Sales were $10.')]);
  const { res, json } = await askMetered(BASIC, credit);
  eq(res.status, 200, 'the answer is still delivered');
  eq(json.ai_credit, { status: 'pending' }, 'pending');
});


console.log('\n-- SILO reports are run first, as defined --');

// Shaped like the production rows (2026-10-06): a parameterised single-query
// report on the company calendar, an enum parameter, and a multi-query report
// with no parameters at all.
const REPORT_DAILY = {
  id: '5110de50-0000-4000-a000-000000000001', title: 'Daily Sales',
  description: 'Daily canonical net sales, units and distinct non-cancelled orders. Defaults to 60 days.',
  parameters: [
    { key: 'date_from', type: 'date', label: 'From', default: 'today-60d', date_basis: 'company' },
    { key: 'date_to', type: 'date', label: 'To', default: 'today-1d', date_basis: 'company' },
  ],
  queries_run: ['select day_date, net_sales from sales_daily_v where day_date between {{date_from}} and {{date_to}} order by day_date'],
};
const REPORT_CREATIVE = {
  id: 'c3000000-0000-4000-a000-00000000000a', title: 'Creative Performance',
  description: 'Paid spend by platform.',
  parameters: [{ key: 'platform', type: 'enum', label: 'Platform', default: 'all', options: ['all', 'meta_ads', 'google_ads'] }],
  queries_run: ["select platform, spend from creative_v where ({{platform}} = 'all' or platform = {{platform}})"],
};
const REPORT_INVENTORY = {
  id: 'c1000000-0000-4000-a000-000000000001', title: 'Inventory Summary',
  description: 'On-hand and incoming stock.', parameters: null,
  queries_run: ['select 1 as total', 'select 2 as by_type', 'select 3 as by_product'],
};
const REPORTS = [REPORT_CREATIVE, REPORT_DAILY, REPORT_INVENTORY];
const reportCall = (input, id = 'tu_r') => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name: 'run_silo_report', input }],
});
const readonlyCalls = (client) => client.__state.rpcCalls.filter((c) => c.name === 'chat_run_readonly_query');
const systemText = (body) => (Array.isArray(body.system) ? body.system.map((b) => b.text).join('\n') : String(body.system));

await test('the request lists SILO reports and offers run_silo_report, read as global, live, system rows', async () => {
  const model = installModel([say('ok')]);
  const { client } = await ask(BASIC, { siloReports: REPORTS });
  const body = model.sent[0];
  const text = systemText(body);
  assert(text.includes('SILO reports -- answer from these FIRST'), 'the guidance is in the prompt');
  assert(text.includes(`- ${REPORT_DAILY.id} — Daily Sales:`), 'each report is listed by id and title');
  assert(text.includes('date_from (date, default today-60d)'), 'parameters are described');
  assert(text.includes('Returns 3 result sets.'), 'a multi-query report says so');
  assert(body.tools.some((t) => t.name === 'run_silo_report'), 'the tool is offered');
  // The report list is per-request: it must never land in the cached core.
  assert(!body.system[0].text.includes('SILO reports -- answer from these FIRST'), 'not in the cached core block');
  const read = client.__state.reportReads[0];
  assert(read, 'the reports were read');
  eq(read.eq, [['source', 'system']], 'system rows only');
  eq(read.is, [['company_entity_id', null], ['archived_at', null]], 'global and not archived');
});

await test('with no SILO reports the tool is not offered and nothing is listed', async () => {
  const model = installModel([say('ok')]);
  await ask(BASIC, { siloReports: [] });
  assert(!model.sent[0].tools.some((t) => t.name === 'run_silo_report'), 'no tool');
  assert(!systemText(model.sent[0]).includes('SILO reports -- answer from these FIRST'), 'no list');
});

await test('run_silo_report runs the stored SQL with typed parameters, under the caller, and says where the figure came from', async () => {
  const model = installModel([
    reportCall({ report: REPORT_DAILY.id, parameters: { date_from: '2026-09-01', date_to: 'today-1d' } }),
    say('Per the SILO Daily Sales report, sales were $100.'),
  ]);
  const { json, client } = await ask(BASIC, { siloReports: REPORTS, rpcResults: [[{ day_date: '2026-09-01', net_sales: 100 }]] });
  const calls = readonlyCalls(client);
  eq(calls.length, 1, 'one statement');
  const sql = calls[0].args.query;
  assert(sql.includes("between date '2026-09-01' and ((select public.silo_business_today()) - 1)"), `substituted on the company calendar: ${sql}`);
  assert(!sql.includes('{{'), 'no token left');
  eq(json.queries_run, [sql], 'the run SQL is what a saved report would keep');
  eq(json.silo_reports_used, [{ id: REPORT_DAILY.id, title: 'Daily Sales', parameters: { date_from: '2026-09-01', date_to: 'today-1d' } }], 'provenance in the reply');
  const result = JSON.parse(toolResultsSeen(model.sent)[0]);
  eq(result.silo_report.title, 'Daily Sales', 'the model is told which report');
  eq(result.results.length, 1, 'one result set');
  eq(result.results[0].result_id, 'R1', 'result id');
  eq(result.results[0].rows, [{ day_date: '2026-09-01', net_sales: 100 }], 'rows');
  const audit = client.__state.inserts.find((i) => i.table === 'silo_chat_audit_log');
  const logged = audit.payload.diagnostics.queries[0];
  eq(logged.silo_report_id, REPORT_DAILY.id, 'the audit row names the report');
  eq(logged.ok, true, 'and the outcome');
});

await test('omitted parameters use the report default, and the title works as well as the id', async () => {
  installModel([reportCall({ report: 'daily sales' }), say('ok')]);
  const { json, client } = await ask(BASIC, { siloReports: REPORTS, rpcResults: [[]] });
  const sql = readonlyCalls(client)[0].args.query;
  assert(sql.includes('((select public.silo_business_today()) - 60) and ((select public.silo_business_today()) - 1)'), sql);
  eq(json.silo_reports_used[0].parameters, { date_from: 'today-60d', date_to: 'today-1d' }, 'defaults recorded');
});

await test('every query of a multi-query report runs, each with its own result id', async () => {
  const model = installModel([reportCall({ report: REPORT_INVENTORY.id }), say('ok')]);
  const { json, client } = await ask(BASIC, { siloReports: REPORTS, rpcResults: [[{ total: 1 }], [{ by_type: 2 }], [{ by_product: 3 }]] });
  eq(readonlyCalls(client).map((c) => c.args.query), REPORT_INVENTORY.queries_run, 'all three, in order');
  const result = JSON.parse(toolResultsSeen(model.sent)[0]);
  eq(result.results.map((r) => r.result_id), ['R1', 'R2', 'R3'], 'ids');
  eq(json.queries_run.length, 3, 'all recorded');
});

await test('a parameter the report does not declare is refused before anything runs', async () => {
  const model = installModel([reportCall({ report: REPORT_DAILY.id, parameters: { location: 'online' } }), say('ok')]);
  const { json, client } = await ask(BASIC, { siloReports: REPORTS });
  eq(readonlyCalls(client).length, 0, 'nothing ran');
  const content = toolResultsSeen(model.sent)[0];
  assert(/^Error: "Daily Sales" has no parameter "location"/.test(content), content);
  assert(content.includes('Its parameters are: date_from, date_to.'), 'it names what the report takes');
  assert(!json.silo_reports_used, 'a refused report is not cited');
});

await test('an enum value outside the declared options is refused, not passed into SQL', async () => {
  const model = installModel([reportCall({ report: REPORT_CREATIVE.id, parameters: { platform: "x' or 1=1 --" } }), say('ok')]);
  const { client } = await ask(BASIC, { siloReports: REPORTS });
  eq(readonlyCalls(client).length, 0, 'nothing ran');
  assert(/^Error: "Creative Performance":/.test(toolResultsSeen(model.sent)[0]), 'refused with the report named');
});

await test('an unknown report is refused with the list of real ones', async () => {
  const model = installModel([reportCall({ report: 'Weekly Magic' }), say('ok')]);
  const { client } = await ask(BASIC, { siloReports: REPORTS });
  eq(readonlyCalls(client).length, 0, 'nothing ran');
  const content = toolResultsSeen(model.sent)[0];
  assert(content.startsWith('Error: there is no SILO report "Weekly Magic"'), content);
  assert(content.includes(`${REPORT_DAILY.id} (Daily Sales)`), 'lists the real ones');
});

await test('a report query that fails is reported in its result, and the report is still named as used', async () => {
  const model = installModel([reportCall({ report: REPORT_INVENTORY.id }), say('ok')]);
  const { json } = await ask(BASIC, {
    siloReports: REPORTS,
    rpcError: (n) => (n === 2 ? { message: 'canceling statement due to statement timeout' } : null),
    rpcResults: [[{ total: 1 }], [{ by_product: 3 }]],
  });
  const result = JSON.parse(toolResultsSeen(model.sent)[0]);
  eq(result.results.length, 3, 'all three reported');
  assert(/^Error: canceling statement due to statement timeout/.test(result.results[1].error), JSON.stringify(result.results[1]));
  eq(json.silo_reports_used.length, 1, 'cited');
});

console.log(`\n${run - failures}/${run} passed`);
process.exit(failures ? 1 : 0);
