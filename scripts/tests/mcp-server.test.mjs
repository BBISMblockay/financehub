// SILO's MCP server (supabase/functions/mcp/, 20261030050000).
//
// What is worth asserting, and why:
//
//  1. The server holds NO authority of its own. It never touches the service
//     role, and every data call is PostgREST with the caller's token -- so the
//     database's gate, role, company and scope decide everything. If this file
//     were wrong, the database would still refuse; these tests pin that the
//     file cannot quietly become something that bypasses it.
//  2. Discovery works the way MCP clients actually connect: no token -> 401 with
//     WWW-Authenticate naming the metadata document -> that document names
//     Supabase's OAuth issuer. And the URL it advertises comes from
//     configuration, never from a Host header a caller chose.
//  3. A dead connection is told to sign in again (401 + invalid_token), not
//     handed a tool error it cannot act on -- that is what sends the person
//     back through SILO's consent screen.
//  4. A bad request inside a tool is a tool error the model can read and fix.
//
// Run: node --test scripts/tests/mcp-server.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createMcpHandler, checkShape, decodeRefusal, TOOLS, SUPPORTED_PROTOCOLS } from '../../supabase/functions/mcp/handler.mjs';

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const BASE = 'https://ref.supabase.co';
const ANON = 'anon-key-value';
const RESOURCE = BASE + '/functions/v1/mcp';

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const tok = (claims) => `Bearer ${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url(claims)}.sig`;
const USER = '11111111-1111-4111-8111-111111111111';
const INTEGRATION = tok({ sub: USER, role: 'silo_integration', aal: 'aal1', client_id: 'client-one' });
const REPORT = 'c3000000-0000-4000-a000-000000000004';
const CATALOG = { reports: [{ id: REPORT, title: 'Ads by Platform', parameters: [], query_count: 1 }],
  company_entity_id: 'co', timezone: 'America/Los_Angeles', generated_at: 'now' };

/** A fake PostgREST. `answer(fn, body, headers)` -> [status, json]. Records every call. */
function harness(answer = () => [200, CATALOG], env = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const fn = String(url).replace(BASE + '/rest/v1/rpc/', '');
    const body = JSON.parse(init.body || '{}');
    calls.push({ url: String(url), fn, body, headers: init.headers });
    const [status, data] = answer(fn, body, init.headers);
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  };
  const handle = createMcpHandler({ env: { SUPABASE_URL: BASE, SUPABASE_ANON_KEY: ANON, ...env }, fetchImpl });
  return { handle, calls };
}
const post = (body, auth = INTEGRATION, host = 'ref.supabase.co') => new Request(`https://${host}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

// The gate's real refusal shape: a JSON-encoded message, raised as PGRST.
const gateRefusal = (code, message, hint = '') =>
  ({ code: 'PGRST', message: JSON.stringify({ code, message, hint }), details: null, hint: null });

// ── 1. discovery ───────────────────────────────────────────────────────────

test('the metadata document names Supabase\'s OAuth issuer and this resource', async () => {
  const { handle, calls } = harness();
  const res = await handle(new Request('https://ref.supabase.co/mcp/.well-known/oauth-protected-resource'));
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.equal(doc.resource, RESOURCE);
  assert.deepEqual(doc.authorization_servers, [BASE + '/auth/v1'],
    'the issuer Supabase itself publishes in /.well-known/oauth-authorization-server');
  assert.equal(calls.length, 0, 'discovery reads no data');
});

test('the advertised URL comes from configuration, not from the Host header', async () => {
  const { handle } = harness();
  const res = await handle(new Request('https://evil.example/mcp/.well-known/oauth-protected-resource'));
  const doc = await res.json();
  assert.equal(doc.resource, RESOURCE);
  assert.ok(!JSON.stringify(doc).includes('evil.example'));
  const r401 = await handle(post(rpc('initialize'), null, 'evil.example'));
  assert.ok(!r401.headers.get('WWW-Authenticate').includes('evil.example'),
    'a client must never be told to send its token to a host the caller picked');
});

test('a custom public URL is honoured when configured', async () => {
  const { handle } = harness(undefined, { SILO_MCP_PUBLIC_URL: 'https://mcp.get-silo.com/' });
  const doc = await (await handle(new Request('https://x/mcp/.well-known/oauth-protected-resource'))).json();
  assert.equal(doc.resource, 'https://mcp.get-silo.com');
});

test('on a custom domain the issuer stays on the project, where Supabase Auth keeps it', async () => {
  const cd = 'https://api.get-silo.com';
  const moved = harness(undefined, { SILO_MCP_PUBLIC_URL: cd + '/functions/v1/mcp' });
  const doc = await (await moved.handle(new Request('https://x/mcp/.well-known/oauth-protected-resource'))).json();
  assert.deepEqual(doc.authorization_servers, [BASE + '/auth/v1'],
    'Auth keeps its issuer on the project domain; a client that checks it would stop at discovery');
  assert.equal(doc.resource, cd + '/functions/v1/mcp');
  const pinned = harness(undefined, { SILO_MCP_PUBLIC_URL: cd + '/functions/v1/mcp', SILO_MCP_ISSUER: cd + '/auth/v1/' });
  const doc2 = await (await pinned.handle(new Request('https://x/mcp/.well-known/oauth-protected-resource'))).json();
  assert.deepEqual(doc2.authorization_servers, [cd + '/auth/v1'], 'an explicit issuer wins');
  // Data calls stay on the project URL, which keeps working after activation.
  await moved.handle(post(rpc('initialize')));
  assert.ok(moved.calls.length > 0);
  assert.ok(moved.calls.every((c) => c.url.startsWith(BASE + '/rest/v1/')));
});

test('no token: 401 that points at the metadata, without claiming the token was bad', async () => {
  const { handle, calls } = harness();
  const res = await handle(post(rpc('initialize'), null));
  assert.equal(res.status, 401);
  const h = res.headers.get('WWW-Authenticate');
  assert.equal(h, `Bearer resource_metadata="${RESOURCE}/.well-known/oauth-protected-resource"`);
  assert.equal(calls.length, 0);
  assert.match(res.headers.get('Access-Control-Expose-Headers'), /WWW-Authenticate/,
    'a browser-based client cannot read the header unless it is exposed');
});

// ── 2. who may connect ─────────────────────────────────────────────────────

test('anything that is not a third-party connection is refused before any data call', async () => {
  const cases = {
    'the anon key': tok({ role: 'anon', iss: 'supabase' }),
    'a dead-end token': tok({ sub: USER, role: 'silo_revoked', client_id: 'client-one' }),
    'a first-party SILO session': tok({ sub: USER, role: 'authenticated', aal: 'aal2' }),
    'not a JWT': 'Bearer abc',
    'no subject': tok({ role: 'silo_integration', client_id: 'c' }),
  };
  for (const [label, auth] of Object.entries(cases)) {
    const { handle, calls } = harness();
    const res = await handle(post(rpc('initialize'), auth));
    assert.equal(res.status, 401, label);
    assert.match(res.headers.get('WWW-Authenticate'), /error="invalid_token"/, label);
    assert.equal(calls.length, 0, `${label}: refused without asking the database`);
  }
});

test('a first-party session is refused: it has no grant, so nothing could ever expire or disconnect it', () => {
  const r = checkShape(tok({ sub: USER, role: 'authenticated', aal: 'aal2' }));
  assert.equal(r.ok, false);
  assert.match(r.message, /connector/);
});

// ── 3. initialize is the signature and grant check ─────────────────────────

test('initialize asks the database first, with the caller\'s own token and the public key', async () => {
  const { handle, calls } = harness();
  const res = await handle(post(rpc('initialize', { protocolVersion: '2025-03-26' })));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.protocolVersion, '2025-03-26', 'a supported version is echoed');
  assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, 'silo_api_list_reports');
  assert.equal(calls[0].headers.Authorization, INTEGRATION, 'the caller\'s token, verbatim');
  assert.equal(calls[0].headers.apikey, ANON, 'the PUBLIC key, never the service role');
});

test('an unknown protocol version gets the newest one this server speaks', async () => {
  const { handle } = harness();
  const body = await (await handle(post(rpc('initialize', { protocolVersion: '1999-01-01' })))).json();
  assert.equal(body.result.protocolVersion, SUPPORTED_PROTOCOLS[0]);
});

test('a revoked, idle or expired connection is told to sign in again at connect time', async () => {
  const { handle } = harness(() => [403, gateRefusal('integration_revoked',
    'This connection is no longer authorized.', 'Reconnect the application in SILO to continue.')]);
  const res = await handle(post(rpc('initialize')));
  assert.equal(res.status, 401);
  assert.match(res.headers.get('WWW-Authenticate'), /error="invalid_token"/);
  assert.match(res.headers.get('WWW-Authenticate'), /resource_metadata=/,
    'and told where to sign in, which lands on SILO\'s consent screen');
});

test('a forged or expired token, which only PostgREST can detect, is also a 401', async () => {
  const { handle } = harness(() => [401, { code: 'PGRST301', message: 'JWSError JWSInvalidSignature' }]);
  const res = await handle(post(rpc('initialize')));
  assert.equal(res.status, 401);
});

// ── 4. tools ───────────────────────────────────────────────────────────────

test('two tools, both read-only, and listing them reads no data', async () => {
  const { handle, calls } = harness();
  const body = await (await handle(post(rpc('tools/list')))).json();
  // how_to_use_silo is the training layer's own tool and reads no data
  // (supabase/functions/mcp/guide.mjs, scripts/tests/mcp-guide.test.mjs).
  assert.deepEqual(body.result.tools.map((t) => t.name), ['list_reports', 'run_report', 'how_to_use_silo']);
  for (const t of body.result.tools) assert.equal(t.annotations.readOnlyHint, true, t.name);
  for (const t of TOOLS) assert.equal(t.annotations.readOnlyHint, true, t.name);
  assert.equal(calls.length, 0);
});

test('list_reports returns the catalog exactly as the database gave it', async () => {
  const { handle, calls } = harness();
  const body = await (await handle(post(rpc('tools/call', { name: 'list_reports', arguments: {} })))).json();
  assert.equal(body.result.isError, false);
  assert.deepEqual(body.result.structuredContent, CATALOG);
  assert.deepEqual(JSON.parse(body.result.content[0].text), CATALOG);
  assert.equal(calls[0].fn, 'silo_api_list_reports');
});

test('list_reports kind "company" calls the saved-reports search overload, and needs a search', async () => {
  const { handle, calls } = harness(() => [200, { reports: [], total: 0 }]);
  const body = await (await handle(post(rpc('tools/call', {
    name: 'list_reports', arguments: { kind: 'company', search: ' restock ' } })))).json();
  assert.equal(body.result.isError, false);
  assert.equal(calls[0].fn, 'silo_api_list_reports');
  assert.deepEqual(calls[0].body, { p_search: 'restock' });
  for (const args of [{ kind: 'company' }, { kind: 'company', search: ' x ' }]) {
    const { handle: h2, calls: c2 } = harness(() => [200, { reports: [] }]);
    const b2 = await (await h2(post(rpc('tools/call', { name: 'list_reports', arguments: args })))).json();
    assert.equal(b2.result.isError, true, 'a company listing without a real search term was allowed');
    assert.equal(c2.length, 0, 'the database was called without a search term');
  }
  const { handle: h3, calls: c3 } = harness();
  await h3(post(rpc('tools/call', { name: 'list_reports', arguments: { kind: 'silo' } })));
  assert.deepEqual(c3[0].body, {}, 'the built-in catalog is the no-argument overload');
});

test('list_reports refuses a bad kind or search without reaching the database', async () => {
  for (const args of [{ kind: 'all' }, { kind: 'company', search: 5 }, { kind: 'company', search: '' }]) {
    const { handle, calls } = harness();
    const body = await (await handle(post(rpc('tools/call', { name: 'list_reports', arguments: args })))).json();
    assert.equal(body.result.isError, true, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
});

test('run_report passes exactly the four arguments the database function takes', async () => {
  const { handle, calls } = harness(() => [200, { rows: [{ a: 1 }], has_more: false }]);
  const params = { date_from: '2026-10-01', platform: 'meta_ads' };
  const body = await (await handle(post(rpc('tools/call', {
    name: 'run_report', arguments: { report_id: REPORT, params, query_index: 1, offset: 1000 } })))).json();
  assert.equal(body.result.isError, false);
  assert.equal(calls[0].fn, 'silo_api_run_report');
  assert.deepEqual(calls[0].body, { p_report_id: REPORT, p_params: params, p_query_index: 1, p_offset: 1000 });
});

test('run_report defaults to the first page of the first result set', async () => {
  const { handle, calls } = harness(() => [200, { rows: [] }]);
  await handle(post(rpc('tools/call', { name: 'run_report', arguments: { report_id: REPORT } })));
  assert.deepEqual(calls[0].body, { p_report_id: REPORT, p_params: {}, p_query_index: 0, p_offset: 0 });
});

test('malformed arguments are a tool error the model can read, and reach no database', async () => {
  const bad = [
    { report_id: 'Daily Sales' },
    { report_id: REPORT, params: ['x'] },
    { report_id: REPORT, params: 'date_from=2026-10-01' },
    { report_id: REPORT, query_index: -1 },
    { report_id: REPORT, offset: 1.5 },
  ];
  for (const args of bad) {
    const { handle, calls } = harness();
    const res = await handle(post(rpc('tools/call', { name: 'run_report', arguments: args })));
    assert.equal(res.status, 200, JSON.stringify(args));
    const body = await res.json();
    assert.equal(body.result.isError, true, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
});

test('a database refusal inside a tool is a readable tool error, not a protocol failure', async () => {
  const { handle } = harness(() => [400, { code: 'P0002', message: 'report_not_found: no approved report with that id' }]);
  const res = await handle(post(rpc('tools/call', { name: 'run_report', arguments: { report_id: REPORT } })));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.isError, true);
  assert.equal(body.result.content[0].text, 'no approved report with that id',
    'the database\'s words, without the machine prefix');
});

test('a connection revoked mid-session is a 401 even inside a tool call', async () => {
  const { handle } = harness(() => [403, gateRefusal('integration_revoked', 'This connection is no longer authorized.')]);
  const res = await handle(post(rpc('tools/call', { name: 'list_reports', arguments: {} })));
  assert.equal(res.status, 401);
});

test('an unknown tool is an invalid-params error', async () => {
  const { handle } = harness();
  const body = await (await handle(post(rpc('tools/call', { name: 'drop_tables' })))).json();
  assert.equal(body.error.code, -32602);
});

// ── 5. protocol edges ──────────────────────────────────────────────────────

test('protocol edges: notification, batch, garbage, unknown method, GET', async () => {
  const { handle } = harness();
  const note = await handle(post({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(note.status, 202);
  assert.equal(await note.text(), '');
  assert.equal((await handle(post([rpc('ping')]))).status, 400);
  assert.equal((await (await handle(post('{not json'))).json()).error.code, -32700);
  assert.equal((await (await handle(post(rpc('resources/list')))).json()).error.code, -32601);
  assert.deepEqual((await (await handle(post(rpc('ping')))).json()).result, {});
  const get = await handle(new Request('https://ref.supabase.co/mcp', { headers: { authorization: INTEGRATION } }));
  assert.equal(get.status, 405);
  assert.equal((await handle(new Request('https://ref.supabase.co/mcp', { method: 'OPTIONS' }))).status, 200);
});

test('an internal failure never echoes its own text', async () => {
  const handle = createMcpHandler({
    env: { SUPABASE_URL: BASE, SUPABASE_ANON_KEY: ANON },
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED https://secret.internal/?key=abc'); },
  });
  const orig = console.error; console.error = () => {};
  try {
    const body = await (await handle(post(rpc('tools/call', { name: 'list_reports' })))).json();
    assert.ok(!JSON.stringify(body).includes('secret.internal'));
    assert.equal(body.error.code, -32603);
  } finally { console.error = orig; }
});

test('decodeRefusal reads both the gate\'s JSON shape and a plain prefixed exception', () => {
  assert.deepEqual(decodeRefusal(gateRefusal('integration_revoked', 'No longer authorized.', 'Reconnect.')),
    { code: 'integration_revoked', reauth: true, message: 'No longer authorized. Reconnect.' });
  const plain = decodeRefusal({ code: 'P0002', message: 'report_not_found: no approved report with that id' });
  assert.equal(plain.reauth, false);
  assert.equal(plain.message, 'no approved report with that id');
  assert.equal(decodeRefusal({ code: '23514', message: 'no_active_company: not scoped' }).reauth, true);
  assert.equal(decodeRefusal(null).reauth, false);
});

// ── 6. the server holds no authority of its own ────────────────────────────

test('the function never reaches for the service role, and talks to nothing but the two RPCs', () => {
  for (const f of ['handler.mjs', 'index.ts']) {
    const src = read(`supabase/functions/mcp/${f}`);
    assert.ok(!/SERVICE_ROLE|service_role|serviceRole/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')),
      `${f} must not use the service role`);
    assert.ok(!/createClient\(/.test(src), `${f} builds no Supabase client`);
  }
  const src = read('supabase/functions/mcp/handler.mjs');
  const rpcs = [...src.matchAll(/callRpc\(authorization, '([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(rpcs)].sort(), ['silo_api_list_reports', 'silo_api_run_report']);
});

test('the claims reader is the shared gate, byte for byte', () => {
  assert.equal(read('supabase/functions/mcp/integration-gate.mjs'), read('scripts/lib/integration-gate.mjs'),
    're-copy scripts/lib/integration-gate.mjs into mcp/');
});

test('it deploys public: a client\'s first request carries no token, by design', () => {
  const list = /NO_JWT_FUNCTIONS="([^"]*)"/.exec(read('.github/workflows/deploy-edge-function.yml'))[1].split(/\s+/);
  assert.ok(list.includes('mcp'));
});

test('the database allows exactly the two paths this server calls', () => {
  const mig = read('supabase/migrations/20261030050000_developer_api_report_catalog.sql');
  assert.match(mig, /in \(\s*'\/rpc\/silo_api_run_report',\s*'\/rpc\/silo_api_list_reports'\)/);
});

test('index.ts parses and wires only configuration and fetch', () => {
  const idx = read('supabase/functions/mcp/index.ts');
  assert.doesNotThrow(() => stripTypeScriptTypes(idx, { mode: 'strip' }));
  assert.match(idx, /createMcpHandler\(\{/);
  assert.match(idx, /SUPABASE_ANON_KEY: Deno\.env\.get\('SUPABASE_ANON_KEY'\)/);
  assert.match(idx, /fetchImpl: fetch/);
});

// ── 7. SILO's mark, not the host's ─────────────────────────────────────────

test('initialize announces SILO\'s icon, as a URL and inline', async () => {
  const { handle } = harness();
  const body = await (await handle(post(rpc('initialize')))).json();
  const icons = body.result.serverInfo.icons;
  assert.equal(icons.length, 2);
  assert.equal(icons[0].src, RESOURCE + '/icon.png', 'a URL under this resource, not the Host header');
  assert.match(icons[1].src, /^data:image\/png;base64,iVBORw0KGgo/, 'an inline PNG');
  for (const i of icons) { assert.equal(i.mimeType, 'image/png'); assert.deepEqual(i.sizes, ['256x256']); }
  assert.equal(body.result.serverInfo.title, 'SILO');
});

test('the discovery document carries the logo too', async () => {
  const { handle } = harness();
  const doc = await (await handle(new Request('https://ref.supabase.co/mcp/.well-known/oauth-protected-resource'))).json();
  assert.equal(doc.logo_uri, RESOURCE + '/icon.png');
});

test('the icon is served publicly as a real 256x256 PNG', async () => {
  const { handle, calls } = harness();
  const res = await handle(new Request('https://ref.supabase.co/mcp/icon.png'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  assert.equal(buf.readUInt32BE(16), 256);
  assert.equal(buf.readUInt32BE(20), 256);
  assert.equal(calls.length, 0, 'no token and no data read');
  assert.equal((await handle(new Request('https://ref.supabase.co/mcp/icon.png', { method: 'POST' }))).status, 405);
});
