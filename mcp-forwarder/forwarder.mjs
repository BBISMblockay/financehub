// A thin front door for SILO's MCP server, for clients that look for OAuth
// metadata at the ROOT of the host.
//
// WHY THIS EXISTS
//
// RFC 9728 lets a client find a resource's metadata two ways: follow the
// `resource_metadata` URL in the 401's WWW-Authenticate header (what Claude
// and ChatGPT do), or build it from the resource URL by inserting
// `/.well-known/oauth-protected-resource` at the root of the host. Grok does
// only the second. For https://api.get-silo.com/functions/v1/mcp that is
// https://api.get-silo.com/.well-known/oauth-protected-resource/functions/v1/mcp,
// and on Supabase every path outside /functions/v1/<name>/ belongs to the
// gateway, which answers 401 "No API key found" -- measured 2026-10-30 on both
// api.get-silo.com and the project's supabase.co host. So Grok stops at
// discovery, on any Supabase address.
//
// Served from a host we control (mcp.get-silo.com), the root is ours: this
// answers the metadata there and passes every MCP request through, unchanged,
// to the real server.
//
// HOLDS NO AUTHORITY. No secret, no service role, no database. It forwards the
// caller's own bearer token; PostgREST, the pre-request gate and the grant
// decide everything, exactly as when the client talks to the function
// directly. The upstream and the advertised URL come from configuration, never
// from the request, so a Host header cannot redirect tokens.
import http from 'node:http';

const strip = (s) => String(s || '').replace(/\/+$/, '');

export function createForwarder(env = {}, fetchImpl = fetch) {
  const upstream = strip(env.SILO_MCP_UPSTREAM || 'https://api.get-silo.com/functions/v1/mcp');
  const publicUrl = strip(env.SILO_MCP_FORWARDER_URL || 'https://mcp.get-silo.com/mcp');
  const issuer = strip(env.SILO_MCP_ISSUER || 'https://mkquclffrvlzyecnabyf.supabase.co/auth/v1');
  const pub = new URL(publicUrl);
  const mcpPath = pub.pathname;                                         // "/mcp"
  const metadataUrl = pub.origin + '/.well-known/oauth-protected-resource' + mcpPath;

  // Request headers an MCP client sends that the server reads. Nothing else is
  // forwarded: no cookies, no client IP chains, no Host.
  const FORWARD_IN = ['authorization', 'content-type', 'accept', 'mcp-protocol-version',
    'mcp-session-id', 'last-event-id'];
  const FORWARD_OUT = ['content-type', 'cache-control', 'mcp-session-id', 'mcp-protocol-version',
    'access-control-allow-origin', 'access-control-allow-methods',
    'access-control-allow-headers', 'access-control-expose-headers'];

  // The upstream document, with this host's URL as the resource. Falls back to
  // a minimal one if the upstream cannot be read, so discovery never depends
  // on a second hop succeeding.
  async function metadata() {
    let doc = {};
    try {
      const r = await fetchImpl(upstream + '/.well-known/oauth-protected-resource');
      if (r.ok) doc = await r.json();
    } catch (_) { /* fall back below */ }
    return {
      ...doc,
      resource: publicUrl,
      authorization_servers: Array.isArray(doc.authorization_servers) && doc.authorization_servers.length
        ? doc.authorization_servers : [issuer],
    };
  }

  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body !== 'string' && !(body instanceof Uint8Array);
    res.writeHead(status, {
      'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  };

  const readBody = (req, limit = 1 << 20) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  return async function handle(req, res) {
    const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/health') return send(res, 200, { ok: true });

      // Both forms: inserted (RFC 9728 section 3.1) and bare root.
      if (path === '/.well-known/oauth-protected-resource' + mcpPath
          || path === '/.well-known/oauth-protected-resource') {
        if (req.method === 'OPTIONS') return send(res, 204, '', corsPreflight());
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });
        return send(res, 200, await metadata(), { 'Cache-Control': 'public, max-age=300' });
      }

      if (path === mcpPath || path.startsWith(mcpPath + '/')) {
        const rest = path.slice(mcpPath.length);
        // Only the MCP endpoint itself and its icon. The function's own
        // metadata path is answered above with this host's resource.
        if (rest !== '' && rest !== '/icon.png') return send(res, 404, { error: 'not_found' });
        const headers = {};
        for (const h of FORWARD_IN) if (req.headers[h]) headers[h] = req.headers[h];
        const body = (req.method === 'POST') ? await readBody(req) : undefined;
        const up = await fetchImpl(upstream + rest, { method: req.method, headers, body });
        const out = {};
        for (const h of FORWARD_OUT) { const v = up.headers.get(h); if (v) out[h] = v; }
        // The 401 that starts sign-in must point at THIS host's metadata, or the
        // client would be told the resource is somewhere it did not connect to.
        if (up.headers.get('www-authenticate')) {
          out['www-authenticate'] = up.headers.get('www-authenticate')
            .replace(/resource_metadata="[^"]*"/, `resource_metadata="${metadataUrl}"`);
        }
        res.writeHead(up.status, out);
        if (up.body && req.method !== 'HEAD') {
          for await (const chunk of up.body) res.write(chunk);
        }
        return res.end();
      }

      if (path === '/') return send(res, 200, 'SILO MCP. Connect your AI app to ' + publicUrl + '\n');
      return send(res, 404, { error: 'not_found' });
    } catch (e) {
      if (res.headersSent) return res.end();
      return send(res, e.status || 502, { error: e.status === 413 ? 'too_large' : 'upstream_unavailable' });
    }
  };

  function corsPreflight() {
    return {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version',
    };
  }
}

// Run directly: `node mcp-forwarder/forwarder.mjs`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const handle = createForwarder(process.env);
  http.createServer(handle).listen(Number(process.env.PORT) || 10000, () => {
    console.log('SILO MCP forwarder listening on', process.env.PORT || 10000);
  });
}
