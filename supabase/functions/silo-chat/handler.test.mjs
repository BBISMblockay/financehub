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
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, 'index.ts');
const SEO_LIB_URL = pathToFileURL(join(HERE, 'seo-lib.mjs')).href;
const EVIDENCE_LIB_URL = pathToFileURL(join(HERE, 'evidence-scope.mjs')).href;

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
    .replace("from './evidence-scope.mjs';", `from ${JSON.stringify(EVIDENCE_LIB_URL)};`);
  // A silently-unapplied rewrite would load a file that still imports npm:,
  // which fails with a confusing resolver error 40 lines away from the cause.
  for (const marker of ["globalThis.__silo_test_createClient", SEO_LIB_URL, EVIDENCE_LIB_URL, 'Buffer.from(bytes)']) {
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
// The concept tools are gated to PRODUCT_CONCEPT_TESTERS in index.ts; a test
// that exercises them has to be that person.
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
      select() { return b; },
      eq(col, val) { b._eq.push([col, val]); return b; },
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
    auth: { getUser: async () => ({ data: { user: currentUser }, error: null }) },
    from: (table) => builder(table),
    rpc: async (name, args) => {
      state.rpcCalls.push({ name, args });
      if (rpcError) return { data: null, error: rpcError };
      if (rpcQueue) return { data: rpcQueue.length ? rpcQueue.shift() : [], error: null };
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

await test('a malformed request id is stored as null, never passed through', async () => {
  installModel([say('Sales were $10.')]);
  const { client } = await ask({ ...BASIC, request_id: 'not-a-uuid' });
  const row = client.__state.inserts.find((i) => i.table === 'silo_chat_audit_log');
  eq(row.payload.request_id, null, 'audited request_id');
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
  try { return await fn((ms) => { now += ms; }); }
  finally { Date.now = realNow; }
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
    eq(row.error_message, 'forced final answer at wall-clock budget (123s, 8 rounds)', 'stop reason');
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

console.log(`\n${run - failures}/${run} passed`);
process.exit(failures ? 1 : 0);
