/* SILO's MCP server: lets Claude, ChatGPT and any other MCP client run SILO's
 * reports for a person who connected it.
 *
 * WHAT IT IS
 *
 * A thin translator. The model speaks MCP (JSON-RPC 2.0 over Streamable HTTP);
 * SILO's developer API speaks PostgREST RPC. This file turns one into the
 * other and adds nothing in between -- it holds no credentials of its own and
 * NEVER uses the service role. Every byte of data it returns came from
 * PostgREST, called with the caller's own OAuth token, so every request runs
 * through the database's pre-request gate, the integration role, the grant's
 * company and its scope (20261020030000). If this file were wrong in any way
 * that matters, the database would still refuse.
 *
 * WHY verify_jwt IS OFF
 *
 * An MCP client discovers how to sign in by being turned away: it calls with
 * no token, gets 401 with `WWW-Authenticate: Bearer resource_metadata=...`,
 * fetches that document, and from it finds Supabase's OAuth server. The
 * Supabase gateway's own 401 carries no such header, so a client connecting
 * for the first time would stop dead. The discovery document is also public
 * by definition. So this function verifies the caller itself:
 *
 *   - the shape check below refuses anything that is not a signed-in
 *     third-party connection (no subject, anon, the dead-end role, or a
 *     first-party session with no client_id);
 *   - the SIGNATURE is verified by PostgREST on the first data call, which
 *     `initialize` makes on purpose -- so a forged token is refused at connect
 *     time, and no data path exists that skips PostgREST.
 *
 * WHAT IT EXPOSES
 *
 * Two tools, deliberately generic: list_reports and run_report. A tool per
 * report would give the model typed arguments, but would make the tool list a
 * data read, rename tools whenever a report is retitled, and double the
 * surface. list_reports returns each report's parameter spec, which is what
 * the model needs to call run_report correctly.
 */

import { readTokenClaims } from './integration-gate.mjs';
import { ICON_PNG_BASE64 } from './icon.mjs';

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'silo', title: 'SILO', version: '1.0.0', websiteUrl: 'https://get-silo.com' };
const ICON_DATA_URI = 'data:image/png;base64,' + ICON_PNG_BASE64;

const INSTRUCTIONS = [
  'SILO is an operations platform. This connection can run SILO\'s built-in reports for ONE company,',
  'read-only. Call list_reports first to see what exists and what parameters each report takes, then',
  'run_report with a report id. Dates are in the company\'s own timezone. Results come in pages of up to',
  '1000 rows; when has_more is true, call again with offset increased by page_size. A report with',
  'query_count above 1 has several result sets: pass query_index 0, 1, ... to read each one.',
].join(' ');

export const TOOLS = [
  {
    name: 'list_reports',
    title: 'List SILO reports',
    description: 'List every report this connection can run, with each one\'s id, title, description, '
      + 'parameters (key, type, default, and the allowed options for an enum), number of result sets '
      + '(query_count) and columns. Call this before run_report.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'run_report',
    title: 'Run a SILO report',
    description: 'Run one SILO report and return a page of rows. Get report_id and the parameter keys '
      + 'from list_reports. Omit a parameter to use its default. Dates are YYYY-MM-DD. Returns the '
      + 'company, its timezone, generated_at, row_count, has_more and the rows.',
    inputSchema: {
      type: 'object',
      properties: {
        report_id: { type: 'string', description: 'The report\'s id, from list_reports.' },
        params: {
          type: 'object',
          description: 'Parameter values keyed by the parameter\'s key, e.g. {"date_from": "2026-10-01"}.',
          additionalProperties: true,
        },
        query_index: {
          type: 'integer', minimum: 0, default: 0,
          description: 'Which result set to read, for a report whose query_count is above 1.',
        },
        offset: {
          type: 'integer', minimum: 0, default: 0,
          description: 'Rows to skip, for reading the next page when has_more is true.',
        },
      },
      required: ['report_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, apikey, x-client-info',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
};

/**
 * @param {{
 *   env: { SUPABASE_URL?: string, SUPABASE_ANON_KEY?: string, SILO_MCP_PUBLIC_URL?: string },
 *   fetchImpl: typeof fetch,
 * }} deps
 */
export function createMcpHandler({ env, fetchImpl }) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anonKey = String(env.SUPABASE_ANON_KEY || '');
  // The URL a client is told to use. Derived from configuration, never from
  // the request: behind Supabase's gateway req.url is an internal address,
  // and an attacker-chosen Host header must not end up in a document that
  // tells clients where to send their tokens.
  const resource = String(env.SILO_MCP_PUBLIC_URL || (base + '/functions/v1/mcp')).replace(/\/+$/, '');
  const metadataUrl = resource + '/.well-known/oauth-protected-resource';
  const issuer = base + '/auth/v1';
  const iconUrl = resource + '/icon.png';

  /* How a client shows SILO's mark rather than its host's. Each client looks
     in a different place, so the mark is offered in all of them: MCP's own
     `icons` on serverInfo (both as a URL and inline, since a client may
     refuse one form), and RFC 9728's `logo_uri` on the discovery document. */
  const serverInfo = {
    ...SERVER_INFO,
    icons: [
      { src: iconUrl, mimeType: 'image/png', sizes: ['256x256'] },
      { src: ICON_DATA_URI, mimeType: 'image/png', sizes: ['256x256'] },
    ],
  };

  const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra },
  });

  /* The 401 that starts the OAuth flow. error="invalid_token" when a token was
     presented and is no good, so a client with a stale or revoked connection
     knows to sign in again rather than to retry. */
  const unauthorized = (why, presented) => json(401, {
    jsonrpc: '2.0', id: null,
    error: { code: -32001, message: why },
  }, {
    'WWW-Authenticate': 'Bearer resource_metadata="' + metadataUrl + '"'
      + (presented ? ', error="invalid_token", error_description="' + why.replace(/"/g, "'") + '"' : ''),
  });

  const rpcResult = (id, result) => json(200, { jsonrpc: '2.0', id, result });
  const rpcError = (id, code, message, status = 200) =>
    json(status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  /* One PostgREST call as the caller. Returns { ok, status, data } or the
     database's own refusal, decoded. */
  async function callRpc(authorization, fn, body) {
    const res = await fetchImpl(base + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { message: text }; }
    if (res.ok) return { ok: true, status: res.status, data };
    return { ok: false, status: res.status, ...decodeRefusal(data) };
  }

  async function onInitialize(id, params, authorization) {
    // The connect-time data call. It is what verifies the token's SIGNATURE
    // (PostgREST does) and the grant's state (the pre-request gate does), so
    // a forged, expired, revoked or idle connection is refused here, before
    // the client believes it is connected.
    const probe = await callRpc(authorization, 'silo_api_list_reports', {});
    if (!probe.ok) return refusalResponse(id, probe);

    const asked = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    return rpcResult(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo,
      instructions: INSTRUCTIONS,
    });
  }

  async function onToolCall(id, params, authorization) {
    const name = params && params.name;
    const args = (params && params.arguments && typeof params.arguments === 'object') ? params.arguments : {};

    if (name === 'list_reports') {
      const r = await callRpc(authorization, 'silo_api_list_reports', {});
      if (!r.ok) return refusalResponse(id, r, true);
      return rpcResult(id, toolOk(r.data));
    }

    if (name === 'run_report') {
      const reportId = typeof args.report_id === 'string' ? args.report_id.trim() : '';
      if (!UUID.test(reportId)) {
        return rpcResult(id, toolErr('report_id must be a report id from list_reports.'));
      }
      const params = args.params == null ? {} : args.params;
      if (typeof params !== 'object' || Array.isArray(params)) {
        return rpcResult(id, toolErr('params must be an object keyed by parameter key.'));
      }
      const qi = args.query_index == null ? 0 : args.query_index;
      const off = args.offset == null ? 0 : args.offset;
      if (!Number.isInteger(qi) || qi < 0) return rpcResult(id, toolErr('query_index must be a whole number, 0 or more.'));
      if (!Number.isInteger(off) || off < 0) return rpcResult(id, toolErr('offset must be a whole number, 0 or more.'));

      const r = await callRpc(authorization, 'silo_api_run_report', {
        p_report_id: reportId, p_params: params, p_query_index: qi, p_offset: off,
      });
      if (!r.ok) return refusalResponse(id, r, true);
      return rpcResult(id, toolOk(r.data));
    }

    return rpcError(id, -32602, 'Unknown tool: ' + String(name));
  }

  /* A refusal from the database, as the client needs to hear it.
     - Signature, expiry, revocation, idle, a missing grant: the connection is
       no good, and the fix is to sign in again. That is HTTP 401 with the
       discovery header, so a client re-runs OAuth -- which lands the person on
       SILO's consent screen, where the repeat-authorization path now asks for
       the company again (20261029234000).
     - Anything else (a bad report id, a bad parameter): the connection is
       fine and the request was wrong. Inside a tool call that is a tool
       result with isError, so the model can read it and correct itself. */
  function refusalResponse(id, r, inTool = false) {
    if (r.reauth) return unauthorized(r.message, true);
    if (inTool) return rpcResult(id, toolErr(r.message));
    return rpcError(id, -32603, r.message);
  }

  return async function handle(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');

    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

    // RFC 9728. Served under the function's own path, because the function
    // cannot answer at the origin's root; the 401 below tells clients where.
    if (path.endsWith('/.well-known/oauth-protected-resource')) {
      if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
      return json(200, {
        resource,
        authorization_servers: [issuer],
        bearer_methods_supported: ['header'],
        scopes_supported: ['openid'],
        resource_name: 'SILO',
        resource_documentation: 'https://get-silo.com',
        logo_uri: iconUrl,
      });
    }

    // The mark, public like the discovery document: a client fetches it
    // before anyone has signed in.
    if (path.endsWith('/icon.png')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
      }
      const bytes = Uint8Array.from(atob(ICON_PNG_BASE64), (c) => c.charCodeAt(0));
      return new Response(req.method === 'HEAD' ? null : bytes, {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
      });
    }

    // This server streams nothing to the client unprompted, which Streamable
    // HTTP allows it to say with 405 on GET.
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' });

    const authorization = req.headers.get('authorization') || '';
    const shape = checkShape(authorization);
    if (!shape.ok) return unauthorized(shape.message, Boolean(authorization));

    let msg;
    try { msg = await req.json(); } catch (_) { return rpcError(null, -32700, 'Parse error', 400); }
    if (Array.isArray(msg)) return rpcError(null, -32600, 'Batched requests are not supported.', 400);
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg && msg.id, -32600, 'Invalid request', 400);
    }

    // A notification has no id and gets no body back.
    if (msg.id === undefined || msg.id === null) {
      return new Response(null, { status: 202, headers: CORS });
    }

    try {
      switch (msg.method) {
        case 'initialize': return await onInitialize(msg.id, msg.params, authorization);
        case 'ping':       return rpcResult(msg.id, {});
        case 'tools/list': return rpcResult(msg.id, { tools: TOOLS });
        case 'tools/call': return await onToolCall(msg.id, msg.params, authorization);
        default:           return rpcError(msg.id, -32601, 'Method not found: ' + msg.method);
      }
    } catch (e) {
      // Never echo an internal error's text: it can carry a URL or a header.
      console.error('mcp handler error', e);
      return rpcError(msg.id, -32603, 'SILO could not complete this request.');
    }
  };
}

/* Refuse anything that is not plainly a third-party connection. Cheap, and
   NOT the signature check -- see the header comment for where that happens.
   A first-party SILO session is refused too: a connection that has no grant
   row never shows up under Connected apps, never expires and cannot be
   disconnected there, so the MCP door is for OAuth connections only. */
export function checkShape(authorization) {
  if (!/^Bearer\s+\S+/i.test(String(authorization || ''))) {
    return { ok: false, message: 'Sign in to SILO to connect.' };
  }
  const claims = readTokenClaims(authorization);
  if (!claims) return { ok: false, message: 'This token is not a SILO connection.' };
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const role = typeof claims.role === 'string' ? claims.role : '';
  const clientId = typeof claims.client_id === 'string' ? claims.client_id : '';
  if (!sub || role === 'anon') return { ok: false, message: 'Sign in to SILO to connect.' };
  if (role === 'silo_revoked') {
    return { ok: false, message: 'This connection is no longer authorized. Reconnect it from SILO.' };
  }
  if (!clientId) {
    return { ok: false, message: 'Connect through your AI app\'s SILO connector, not a SILO session token.' };
  }
  return { ok: true };
}

/* PostgREST answers a refusal as JSON with code/message/hint. The pre-request
   gate raises with a JSON-encoded MESSAGE ({code, message, hint}), and a plain
   `raise exception 'report_not_found: ...'` arrives as message text. Both are
   decoded to one { message, reauth } so the caller decides on one field. */
export function decodeRefusal(data) {
  const d = data && typeof data === 'object' ? data : {};
  let code = typeof d.code === 'string' ? d.code : '';
  let message = typeof d.message === 'string' ? d.message : '';
  let hint = typeof d.hint === 'string' ? d.hint : '';

  if (message.startsWith('{')) {
    try {
      const inner = JSON.parse(message);
      code = inner.code || code;
      message = inner.message || message;
      hint = inner.hint || hint;
    } catch (_) { /* not the gate's shape; keep the text */ }
  }
  const prefixed = /^([a-z_]+):\s*(.*)$/s.exec(message);
  if (prefixed) { code = code || prefixed[1]; }

  const REAUTH = new Set([
    'integration_revoked', 'not_authenticated', 'no_active_company',
    'PGRST301', 'PGRST302', 'PGRST303', // JWT invalid / expired / missing
  ]);
  const reauth = REAUTH.has(code) || (prefixed && REAUTH.has(prefixed[1])) || /JWT|jwt/.test(message);

  const text = (prefixed ? prefixed[2] : message) || 'SILO refused this request.';
  return { code, reauth: Boolean(reauth), message: hint ? text + ' ' + hint : text };
}

function toolOk(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data },
    isError: false,
  };
}
function toolErr(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
