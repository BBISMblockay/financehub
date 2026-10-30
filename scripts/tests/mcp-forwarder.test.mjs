// The MCP forwarder (mcp-forwarder/forwarder.mjs), run as real HTTP servers in
// front of the REAL MCP handler (supabase/functions/mcp/handler.mjs) with a
// fake PostgREST behind it -- the same wiring Grok sees.
//
// Proves: the RFC 9728 inserted-path document Grok asks for is answered at the
// root with this host as the resource and Supabase's issuer; the 401 that
// starts sign-in points at this host's metadata; a signed-in call reaches the
// handler with the caller's own token and nothing invented; the icon passes
// through; nothing else of the function or the host is reachable; a Host
// header changes nothing.
//
// Run: node --test scripts/tests/mcp-forwarder.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMcpHandler } from '../../supabase/functions/mcp/handler.mjs';
import { createForwarder } from '../../mcp-forwarder/forwarder.mjs';

const BASE = 'https://ref.supabase.co';
const ISSUER = BASE + '/auth/v1';
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `Bearer ${b64url({ alg: 'ES256' })}.${b64url({ sub: '11111111-1111-4111-8111-111111111111', role: 'silo_integration', client_id: 'grok' })}.sig`;
const CATALOG = { reports: [{ id: 'r1', title: 'Daily Sales', parameters: [], query_count: 1 }],
  company_entity_id: 'co', timezone: 'America/Los_Angeles', generated_at: 'now' };

const rpcCalls = [];
let upstream, forwarder, UP, FW;

const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve(s));
});

// Bridge a fetch-style handler (the edge function) onto node:http.
const bridge = (handle) => async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await handle(new Request('http://' + req.headers.host + req.url,
    { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
};

before(async () => {
  upstream = await listen(() => {});
  UP = `http://127.0.0.1:${upstream.address().port}/functions/v1/mcp`;
  const handle = createMcpHandler({
    env: { SUPABASE_URL: BASE, SUPABASE_ANON_KEY: 'anon', SILO_MCP_PUBLIC_URL: 'https://api.get-silo.com/functions/v1/mcp' },
    fetchImpl: async (url, init) => {
      rpcCalls.push({ url: String(url), headers: init.headers });
      return new Response(JSON.stringify(CATALOG), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  upstream.removeAllListeners('request');
  upstream.on('request', bridge(handle));

  forwarder = await listen(() => {});
  FW = `http://127.0.0.1:${forwarder.address().port}`;
  forwarder.removeAllListeners('request');
  forwarder.on('request', createForwarder({
    SILO_MCP_UPSTREAM: UP,
    SILO_MCP_FORWARDER_URL: 'https://mcp.get-silo.com/mcp',
  }));
});
after(() => { upstream.closeAllConnections(); upstream.close(); forwarder.closeAllConnections(); forwarder.close(); });

test('the root metadata Grok asks for names THIS host and Supabase\'s issuer', async () => {
  for (const p of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const r = await fetch(FW + p);
    assert.equal(r.status, 200, p);
    const doc = await r.json();
    assert.equal(doc.resource, 'https://mcp.get-silo.com/mcp');
    assert.deepEqual(doc.authorization_servers, [ISSUER], 'taken from the real server, not invented');
    assert.equal(doc.resource_name, 'SILO', 'the rest of the upstream document is kept');
  }
});

test('the 401 that starts sign-in points at this host\'s metadata', async () => {
  const r = await fetch(FW + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'),
    'Bearer resource_metadata="https://mcp.get-silo.com/.well-known/oauth-protected-resource/mcp"');
});

test('a signed-in call reaches the real handler with the caller\'s own token', async () => {
  rpcCalls.length = 0;
  const r = await fetch(FW + '/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: TOKEN, cookie: 'x=1', 'x-forwarded-for': '6.6.6.6' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.result.serverInfo.name, 'silo');
  assert.equal(rpcCalls.length, 1, 'initialize verifies the token with one data call');
  assert.equal(rpcCalls[0].headers.Authorization, TOKEN, 'the caller\'s token, untouched');
});

test('the icon passes through', async () => {
  const r = await fetch(FW + '/mcp/icon.png');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
});

test('nothing else is reachable: other function paths and other hosts\' paths are 404', async () => {
  for (const p of ['/mcp/.well-known/oauth-protected-resource', '/mcp/anything', '/rest/v1/rpc/silo_api_run_report', '/functions/v1/mcp']) {
    assert.equal((await fetch(FW + p)).status, 404, p);
  }
});

test('a Host header changes nothing it advertises', async () => {
  const r = await new Promise((resolve) => {
    http.get(FW + '/.well-known/oauth-protected-resource/mcp', { headers: { host: 'evil.example' } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d));
    });
  });
  assert.ok(!r.includes('evil.example'));
  assert.match(r, /mcp\.get-silo\.com/);
});

test('upstream down: discovery still answers with the configured issuer, MCP says 502', async () => {
  const dead = createForwarder({ SILO_MCP_UPSTREAM: 'http://127.0.0.1:1/functions/v1/mcp' });
  const s = await listen(dead);
  const D = `http://127.0.0.1:${s.address().port}`;
  try {
    const doc = await (await fetch(D + '/.well-known/oauth-protected-resource/mcp')).json();
    assert.deepEqual(doc.authorization_servers, ['https://mkquclffrvlzyecnabyf.supabase.co/auth/v1']);
    assert.equal((await fetch(D + '/mcp', { method: 'POST', body: '{}' })).status, 502);
  } finally { s.close(); }
});
