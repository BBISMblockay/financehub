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
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, 'index.ts');
const SEO_LIB_URL = pathToFileURL(join(HERE, 'seo-lib.mjs')).href;

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
    .replace("from './seo-lib.mjs';", `from ${JSON.stringify(SEO_LIB_URL)};`);
  // A silently-unapplied rewrite would load a file that still imports npm:,
  // which fails with a confusing resolver error 40 lines away from the cause.
  for (const marker of ["globalThis.__silo_test_createClient", SEO_LIB_URL, 'Buffer.from(bytes)']) {
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
const COMPANY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** A supabase-js-shaped stub. Query builders are thenable, so `await
 *  client.from(t).select().eq().maybeSingle()` resolves through `resolve`. */
function makeClient({ activeCompanies = [COMPANY_A], auditError = null } = {}) {
  const state = {
    inserts: [],
    rpcCalls: [],
    profileReads: 0,
  };
  const remaining = activeCompanies.slice();
  let lastCompany = remaining[remaining.length - 1] ?? null;

  const resolve = (b) => {
    if (b._table === 'silo_chat_audit_log' && b._op === 'insert') {
      return { data: null, error: auditError };
    }
    if (b._table === 'profiles') {
      state.profileReads++;
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
      select() { return b; },
      eq() { return b; },
      ilike() { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return b; },
      single() { return b; },
      update() { b._op = 'update'; return b; },
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
    auth: { getUser: async () => ({ data: { user: USER }, error: null }) },
    from: (table) => builder(table),
    rpc: async (name, args) => {
      state.rpcCalls.push({ name, args });
      return { data: [], error: null };
    },
  };
}

/** Scripted Anthropic responses, one per model round, in order. */
function installModel(rounds) {
  const queue = rounds.slice();
  globalThis.fetch = async (url) => {
    if (!String(url).includes('api.anthropic.com')) {
      throw new Error(`unexpected outbound fetch in test: ${url}`);
    }
    if (!queue.length) throw new Error('model called more times than the test scripted');
    const body = queue.shift();
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { remaining: () => queue.length };
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

async function ask(body, clientOpts) {
  const client = makeClient(clientOpts);
  currentClientFactory = () => client;
  const res = await capturedHandler(request(body));
  return { res, json: await res.json(), client };
}

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

await test('the forced answer at the round cap is returned', async () => {
  installModel([...exhaustRounds(), say('Out of budget, but here is the number: $10.')]);
  const { res, json } = await ask(BASIC);
  eq(res.status, 200, 'status');
  eq(json.answer, 'Out of budget, but here is the number: $10.', 'answer');
});

await test('...and ITS continuation is appended, not substituted for it', async () => {
  installModel([
    ...exhaustRounds(),
    say('Out of budget. Sales were $412,500, and the', 'max_tokens'),
    say(' top mover was the tee.'),
  ]);
  const { json } = await ask(BASIC);
  eq(json.answer, 'Out of budget. Sales were $412,500, and the top mover was the tee.', 'answer');
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
  eq(json.answer, 'Sales were $412,500 last week, and the top mover was the tee.', 'answer');
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

console.log(`\n${run - failures}/${run} passed`);
process.exit(failures ? 1 : 0);
