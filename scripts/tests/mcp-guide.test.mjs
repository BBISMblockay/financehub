// SILO's MCP training layer (supabase/functions/mcp/guide.mjs).
//
// What is worth asserting, and why:
//
//  1. The training actually reaches a client. It is delivered in three
//     different places -- the server's instructions, the tool descriptions and
//     its own tool -- and a bot only learns what its own client happens to
//     show it, so each delivery point is pinned separately. A refactor that
//     drops one of them is silent otherwise: nothing fails, the answers just
//     get worse.
//  2. The rules that change a number are present: blank is not zero, credited
//     revenue is never summed, windows end at the last complete day. Those are
//     the three a bot gets wrong on its own.
//  3. It stays OFF the catalog. list_reports already returns about 63k
//     characters for 24 reports, and a client that caps a tool result would
//     start truncating the reports themselves -- so the guide is its own call,
//     and this file pins that the catalog comes back untouched.
//  4. It reads nothing. The guide tool makes no PostgREST call, which is also
//     why it cannot be a way to reach data.
//  5. The notes are keyed by report id, so they drift the moment a report is
//     retired or renamed. Every id and title is checked against the migrations
//     that define the reports.
//  6. The page map is the one part of this that can send a person to a dead
//     link, so every path is checked against the repository and every page and
//     section against v2/nav-config.js.
//
// Run: node --test scripts/tests/mcp-guide.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMcpHandler, TOOLS } from '../../supabase/functions/mcp/handler.mjs';
import {
  buildGuide, toolsWithGuide, instructionsWithTraining,
  GLOSSARY, HOW_TO_CHOOSE, REPORT_NOTES, WHERE_IN_SILO, GUIDE_TOOL, GUIDE_TOOL_NAME, GUIDE_VERSION,
} from '../../supabase/functions/mcp/guide.mjs';

const BASE = 'https://ref.supabase.co';
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const tok = (claims) => `Bearer ${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url(claims)}.sig`;
const INTEGRATION = tok({
  sub: '11111111-1111-4111-8111-111111111111',
  role: 'silo_integration', aal: 'aal1', client_id: 'client-one',
});
const REPORT = 'c3000000-0000-4000-a000-000000000001'; // Sales vs Last Year
const CATALOG = {
  reports: [{ id: REPORT, title: 'Sales vs Last Year', parameters: [], query_count: 1 }],
  company_entity_id: 'co', timezone: 'America/Los_Angeles', generated_at: 'now',
};

function harness(answer = () => [200, CATALOG]) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const fn = String(url).replace(BASE + '/rest/v1/rpc/', '');
    calls.push({ fn, body: JSON.parse(init.body || '{}') });
    const [status, data] = answer(fn);
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  };
  const handle = createMcpHandler({ env: { SUPABASE_URL: BASE, SUPABASE_ANON_KEY: 'anon' }, fetchImpl });
  return { handle, calls };
}
const post = (body) => new Request(`${BASE}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: INTEGRATION },
  body: JSON.stringify(body),
});
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const call = async (handle, name, args) =>
  (await (await handle(post(rpc('tools/call', { name, arguments: args || {} })))).json()).result;

// ── 1. the three delivery points ───────────────────────────────────────────

test('initialize carries the rules on top of the server\'s own instructions', async () => {
  const { handle } = harness();
  const res = await (await handle(post(rpc('initialize', { protocolVersion: '2025-06-18' })))).json();
  const text = res.result.instructions;
  assert.match(text, /This connection reads ONE company/, 'the server\'s own instructions survive');
  assert.match(text, /Blank is not zero/);
  assert.match(text, /never add them to net sales/i);
  assert.match(text, /last\s+COMPLETE day/);
  assert.ok(text.includes(GUIDE_TOOL_NAME), 'the instructions name the tool that holds the rest');
});

test('the tool list carries the guide tool and the guidance on the other two', async () => {
  const before = JSON.parse(JSON.stringify(TOOLS));
  const { handle, calls } = harness();
  const res = await (await handle(post(rpc('tools/list')))).json();
  const byName = Object.fromEntries(res.result.tools.map((t) => [t.name, t]));
  assert.ok(byName[GUIDE_TOOL_NAME], 'the guide is offered as a tool');
  assert.match(byName[GUIDE_TOOL_NAME].description, /before answering/i);
  assert.match(byName.list_reports.description, new RegExp(GUIDE_TOOL_NAME));
  assert.match(byName.run_report.description, /never summed/);
  assert.deepEqual(byName.list_reports.inputSchema, before.find((t) => t.name === 'list_reports').inputSchema,
    'the input schema is untouched -- only the prose is added to');
  assert.deepEqual(TOOLS, before, 'the exported tool list is not rewritten in place');
  assert.equal(calls.length, 0, 'listing tools reads no data');
});

test('the guide tool answers the glossary, the routing table and a note per report', async () => {
  const { handle, calls } = harness();
  const out = await call(handle, GUIDE_TOOL_NAME);
  const g = out.structuredContent;
  assert.equal(out.isError, false);
  assert.equal(g.version, GUIDE_VERSION);
  assert.ok(g.glossary['net sales'], 'the glossary is there');
  assert.ok(g.how_to_choose.some((r) => r.use === 'Sales vs Last Year'));
  const note = g.reports.find((r) => r.id === REPORT);
  assert.equal(note.title, 'Sales vs Last Year');
  assert.match(note.when_to_use, /how are sales doing/i);
  assert.equal(g.reports.length, Object.keys(REPORT_NOTES).length);
  assert.ok(g.where_in_silo.pages.some((x) => x.page === 'Ask SILO'), 'and where things are in the app');
  // The point of a tool rather than a field on the catalog.
  assert.equal(calls.length, 0, 'the guide reaches no database, so it needs no token, scope or company');
  assert.deepEqual(JSON.parse(out.content[0].text), g, 'the text and the structured result agree');
});

test('the guide tool takes no arguments and ignores any it is sent', async () => {
  const { handle } = harness();
  assert.deepEqual(GUIDE_TOOL.inputSchema.properties, {});
  assert.equal(GUIDE_TOOL.inputSchema.additionalProperties, false);
  const out = await call(handle, GUIDE_TOOL_NAME, { report_id: REPORT, anything: 1 });
  assert.equal(out.isError, false);
  assert.equal(out.structuredContent.version, GUIDE_VERSION);
});

// ── 2. the catalog is left alone ───────────────────────────────────────────

test('list_reports still returns exactly what the database gave it', async () => {
  const { handle } = harness();
  const out = await call(handle, 'list_reports');
  assert.deepEqual(out.structuredContent, CATALOG, 'the training layer adds no weight to the catalog');
  assert.deepEqual(JSON.parse(out.content[0].text), CATALOG);
});

test('the wiring keeps the guide out of the data paths', () => {
  const src = fs.readFileSync(new URL('../../supabase/functions/mcp/handler.mjs', import.meta.url), 'utf8');
  const dataPaths = src.slice(src.indexOf("if (name === 'list_reports')"), src.indexOf('GUIDE_TOOL_NAME) return'));
  assert.ok(dataPaths.length > 0, 'the tool-call branches moved; this assertion needs rewriting');
  assert.equal(/buildGuide|toolsWithGuide/.test(dataPaths), false,
    'list_reports and run_report results must come back as the database sent them');
});

test('an unknown tool is still unknown', async () => {
  const { handle } = harness();
  const body = await (await handle(post(rpc('tools/call', { name: 'how_to_use_silo_please', arguments: {} })))).json();
  assert.equal(body.error.code, -32602);
});

// ── 3. shape safety ────────────────────────────────────────────────────────

test('toolsWithGuide leaves a tool it has no note for alone, and still offers the guide', () => {
  const out = toolsWithGuide([{ name: 'something_else', description: 'As written.' }]);
  assert.equal(out[0].description, 'As written.');
  assert.equal(out[1].name, GUIDE_TOOL_NAME);
  assert.deepEqual(toolsWithGuide(null), [GUIDE_TOOL]);
});

test('instructionsWithTraining still answers with the rules when the base is empty', () => {
  assert.match(instructionsWithTraining(''), /Blank is not zero/);
  assert.match(instructionsWithTraining(null), /HOW TO ANSWER WITH SILO/);
});

// ── 4. drift against the reports that actually exist ───────────────────────

const migrations = (() => {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(new URL(f, dir), 'utf8')).join('\n')
    + fs.readFileSync(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
})();

test('every report note names a report the migrations define, under that exact title', () => {
  const orphans = Object.entries(REPORT_NOTES)
    .filter(([id, r]) => !migrations.includes(id) || !migrations.includes(r.title))
    .map(([id, r]) => `${r.title} (${id})`);
  assert.deepEqual(orphans, [], 'a note whose report was retired or retitled is advice about nothing');
});

test('every report the routing table names has a note, so the two cannot disagree', () => {
  const titles = new Set(Object.values(REPORT_NOTES).map((r) => r.title));
  const missing = HOW_TO_CHOOSE.map((r) => r.use).filter((t) => !titles.has(t));
  assert.deepEqual(missing, [], 'the model is told to use a report the guide then says nothing about');
});

test('a note is a sentence or two, and no two reports share one', () => {
  const seen = new Map();
  for (const [id, r] of Object.entries(REPORT_NOTES)) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, id);
    assert.ok(r.title && r.title.length > 2, id);
    assert.ok(r.when_to_use.length > 40 && r.when_to_use.length < 400,
      `${r.title}: ${r.when_to_use.length} characters`);
    assert.equal(seen.has(r.when_to_use), false, `${r.title} repeats ${seen.get(r.when_to_use)}'s note`);
    seen.set(r.when_to_use, r.title);
  }
});

// ── 5. what it is allowed to cost ──────────────────────────────────────────

test('the guide is one modest call, and the instructions are compact', () => {
  const guide = JSON.stringify(buildGuide()).length;
  // One call, but a client returns it twice (text plus structured), and it has
  // to fit in the same conversation as a ~63k catalog.
  assert.ok(guide < 24000, `${guide} characters -- one call, but it still has to fit beside the catalog`);
  // The instructions can land in a system prompt on every turn, so they are
  // held far tighter than the guide itself.
  assert.ok(instructionsWithTraining('').length < 2500, 'the connect-time instructions are compact');
});

test('every page in the map is a page that exists', () => {
  const root = new URL('../../', import.meta.url);
  const missing = WHERE_IN_SILO.pages
    .filter((x) => !fs.existsSync(new URL(x.path.replace(/^\//, ''), root)))
    .map((x) => `${x.page} -> ${x.path}`);
  assert.deepEqual(missing, [], 'a bot would send someone to a dead link');
  const paths = WHERE_IN_SILO.pages.map((x) => x.path);
  assert.equal(new Set(paths).size, paths.length, 'a page is listed twice');
});

test('every page in the map is named and filed the way the sidebar names it', () => {
  const nav = fs.readFileSync(new URL('../../v2/nav-config.js', import.meta.url), 'utf8');
  const wrong = WHERE_IN_SILO.pages.filter((x) => {
    // The sidebar holds the label and the section (or sectionStandard) as
    // literals, and the Sales pages as a title. Either spelling is the menu's
    // own; neither being present means this map has drifted from it.
    const named = nav.includes(`'${x.page}'`);
    const filed = nav.includes(`'${x.section}'`);
    return !named || !filed;
  }).map((x) => `${x.section} / ${x.page}`);
  assert.deepEqual(wrong, [], 'the map calls a page or a section something the sidebar does not');
});

test('the map points at pages and promises nothing about access', () => {
  for (const x of WHERE_IN_SILO.pages) {
    assert.match(x.path, /^\/v[23]\/[a-z0-9_.-]+\.html$/, x.page);
    assert.ok(x.what.length > 10 && x.what.length < 200, `${x.page}: ${x.what.length} characters`);
  }
  assert.match(WHERE_IN_SILO.note, /depends on their role/,
    'the map has to say that what a person can open is not for the bot to assert');
  // SILO staff pages and pages deliberately kept out of the menu stay out.
  for (const path of ['/v2/platform-admin.html', '/v2/returns-overview.html']) {
    assert.equal(WHERE_IN_SILO.pages.some((x) => x.path === path), false, path);
  }
});

test('the rules say the connection cannot act in the app', () => {
  assert.match(instructionsWithTraining(''), /cannot see the screen, open a page or change anything/);
});

test('the guide reads nothing and holds no secrets', () => {
  const src = fs.readFileSync(new URL('../../supabase/functions/mcp/guide.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['fetch(', 'Deno.env', 'SERVICE_ROLE', 'callRpc', 'require(']) {
    assert.equal(src.includes(forbidden), false, `guide.mjs must stay text, but mentions ${forbidden}`);
  }
});
