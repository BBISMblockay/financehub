// page-inspect — fetch one storefront page and record what it says about
// itself. READ ONLY against the web, write-only into page_inspections.
//
// The security model, in one line: the caller supplies a URL, and the ONLY
// hosts that can be fetched are the ones Shopify itself vouched for, for a
// shop the CALLER'S OWN company is connected to. The allowlist is read with
// the caller's JWT, so RLS -- not a parameter -- decides which company's
// hosts are in scope; a caller cannot inspect another tenant's storefront by
// passing an id.
//
// Redirects are followed MANUALLY and every hop is re-admitted against that
// same allowlist. Letting fetch() follow redirects would hand an attacker who
// controls any response the ability to bounce us to an internal address,
// which is the one way an exact-match allowlist can otherwise be escaped.
//
// The admission and extraction logic lives in ./inspect-lib.mjs so it can be
// tested in Node (scripts/tests/page-inspect.test.mjs, 40 assertions covering
// the known allowlist bypasses). Do not inline it back here.
//
// NOTHING THIS RETURNS IS EVIDENCE ABOUT SEARCH. meta_robots is a directive
// the page states; it is not an observation that anything indexed, crawled or
// ranked the page, and SILO holds no data that could support such a claim.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  admitUrl, admitRedirect, extractPageFacts, allAddressesPublic,
  findHeaderEnd, parseResponseHead, decodeChunkedBody, buildRequest,
} from './inspect-lib.mjs';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const MAX_HOPS = 5;
const MAX_BYTES = 2 * 1024 * 1024;   // 2 MiB of HTML is far past any real page
const TIMEOUT_MS = 15_000;
const USER_AGENT = 'SILO-PageInspect/1.0 (+https://silo-baseballism.com)';

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Resolve a host to every address it currently points at.
 *
 * Deno.resolveDns where the runtime exposes it; DNS-over-HTTPS otherwise. Both
 * are attempted because the edge runtime's permissions are not guaranteed, and
 * the DoH call is to a fixed resolver we chose -- the user-supplied part is
 * only the NAME being looked up, never the endpoint.
 *
 * Returns [] when resolution fails, and the caller treats that as a REFUSAL.
 * Failing closed is the point: not knowing where a name points is not the same
 * as knowing it is safe. */
async function resolveHostAddresses(host: string, signal: AbortSignal): Promise<string[]> {
  const out: string[] = [];

  const maybeResolve = (Deno as unknown as {
    resolveDns?: (h: string, t: string) => Promise<string[]>;
  }).resolveDns;
  if (typeof maybeResolve === 'function') {
    for (const type of ['A', 'AAAA']) {
      try {
        // resolveDns takes no signal, so it is RACED against the deadline --
        // otherwise a hanging resolver sits outside the timeout entirely, which
        // is the gap review found: the abort covered the fetch and nothing else.
        out.push(...await Promise.race([
          maybeResolve(host, type),
          abortPromise(signal),
        ]) as string[]);
      } catch { /* NODATA is normal; an abort rethrows below via signal check */ }
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    }
    if (out.length) return out;
  }

  for (const type of ['A', 'AAAA']) {
    try {
      const res = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
        { headers: { Accept: 'application/dns-json' }, signal },
      );
      if (!res.ok) { await res.body?.cancel().catch(() => {}); continue; }
      const data = await res.json();
      for (const answer of data?.Answer ?? []) {
        // 1 = A, 28 = AAAA. A CNAME chain is followed by the resolver itself,
        // so only address records are collected.
        if (answer?.type === 1 || answer?.type === 28) out.push(String(answer.data));
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      /* otherwise fall through to the empty-list refusal */
    }
  }
  return out;
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
}

/** One HTTPS request, made to an ADDRESS WE ALREADY VALIDATED.
 *
 * This is the part that actually closes DNS rebinding. Validating a name and
 * then handing the NAME to fetch() means two independent lookups: the one we
 * approved and the one the connection used. Nothing binds them, so a zone that
 * answers differently a moment later wins. Connecting to the validated address
 * removes the second lookup entirely.
 *
 * TLS is still pinned to the HOSTNAME: `servername` sets SNI and is what the
 * certificate is validated against, so connecting by address does not weaken
 * authentication -- an attacker who can point DNS at their box still cannot
 * present a valid certificate for the storefront.
 *
 * Returns { status, headers, body, truncated, complete }. */
async function httpsGetViaAddress(opts: {
  address: string; host: string; pathWithQuery: string;
  signal: AbortSignal; maxBytes: number;
}): Promise<{
  status: number; headers: Map<string, string>;
  body: Uint8Array; truncated: boolean; complete: boolean;
}> {
  const connectTls = (Deno as unknown as {
    connectTls?: (o: Record<string, unknown>) => Promise<Deno.Conn>;
  }).connectTls;
  if (typeof connectTls !== 'function') {
    // FAIL CLOSED. Falling back to fetch(host) here would silently reopen the
    // exact hole this function exists to close, and it would do it invisibly.
    throw new Error('tls_connect_unavailable: cannot pin the connection to a validated address');
  }

  // An IPv6 literal needs brackets in the URL sense but NOT in connectTls's
  // hostname, which takes the bare address.
  const address = opts.address.replace(/^\[|\]$/g, '');
  const conn = await connectTls({ hostname: address, port: 443, servername: opts.host });

  const onAbort = () => { try { conn.close(); } catch { /* already closed */ } };
  opts.signal.addEventListener('abort', onAbort, { once: true });

  try {
    await conn.write(new TextEncoder().encode(
      buildRequest(opts.host, opts.pathWithQuery, USER_AGENT),
    ));

    // Read headers, then body, never more than the cap plus one chunk. The cap
    // applies to bytes off the wire, so an oversized page costs us the cap and
    // not the page.
    const chunks: Uint8Array[] = [];
    let total = 0;
    let headEnd = -1;
    let joined = new Uint8Array(0);

    while (true) {
      const buf = new Uint8Array(64 * 1024);
      const n = await conn.read(buf);
      if (n === null) break;
      chunks.push(buf.subarray(0, n));
      total += n;

      joined = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) { joined.set(c, at); at += c.byteLength; }

      if (headEnd === -1) headEnd = findHeaderEnd(joined);
      if (headEnd !== -1 && total - (headEnd + 4) > opts.maxBytes) break;
      if (headEnd === -1 && total > 256 * 1024) break;  // absurd header block
    }

    if (headEnd === -1) throw new Error('no_response_headers');
    const head = parseResponseHead(new TextDecoder().decode(joined.slice(0, headEnd)));
    if ((head as { error?: string }).error) throw new Error((head as { error: string }).error);

    const { status, headers } = head as { status: number; headers: Map<string, string> };
    const rawBody = joined.slice(headEnd + 4);

    let body = rawBody;
    let truncated = false;
    let complete = true;
    if ((headers.get('transfer-encoding') || '').toLowerCase().includes('chunked')) {
      const decoded = decodeChunkedBody(rawBody, opts.maxBytes);
      body = decoded.body;
      truncated = decoded.truncated;
      complete = decoded.complete;
    } else if (rawBody.byteLength > opts.maxBytes) {
      body = rawBody.slice(0, opts.maxBytes);
      truncated = true;
    }

    return { status, headers, body, truncated, complete };
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
    try { conn.close(); } catch { /* already closed by abort or by the peer */ }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const authHeader = req.headers.get('Authorization') ?? '';
  const service = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: { user }, error: authErr } = await service.auth.getUser(
    authHeader.replace('Bearer ', ''),
  );
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const requestedUrl = String(body?.url ?? '');
  if (!requestedUrl) return json({ error: 'url required' }, 400);

  // The allowlist is read through the CALLER's JWT. shopify_shop_domains'
  // select policy is company_entity_id = active_company_id(), so this returns
  // only the hosts this caller's active company may inspect -- the tenant
  // check and the allowlist are the same query, and cannot drift apart.
  const rls = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: domainRows, error: domErr } = await rls
    .from('shopify_shop_domains')
    .select('company_entity_id, host');
  if (domErr) return json({ error: `allowlist_read_failed: ${domErr.message}` }, 500);
  if (!domainRows?.length) {
    return json({
      error: 'no_allowlisted_hosts',
      detail: 'No storefront domains are recorded for your active company yet. '
        + 'They are learned from Shopify by the nightly sync.',
    }, 409);
  }

  const allowed = new Set(domainRows.map((r) => String(r.host)));
  const admitted = admitUrl(requestedUrl, allowed);
  if (admitted.error) return json({ error: admitted.error, allowed_hosts: [...allowed] }, 400);

  const companyEntityId = domainRows.find((r) => String(r.host) === admitted.host)?.company_entity_id
    ?? domainRows[0].company_entity_id;

  // ── fetch, following redirects ourselves ─────────────────────────────────
  const startedAt = Date.now();
  const redirectChain: Array<Record<string, unknown>> = [];
  let currentUrl = admitted.url as string;
  // Not a fetch Response: httpsGetViaAddress returns what it read off a
  // connection we opened to a validated address.
  let response: {
    status: number; headers: Map<string, string>;
    body: Uint8Array; truncated: boolean; complete: boolean;
  } | null = null;
  let fetchError: string | null = null;

  // ONE controller and ONE timer for the WHOLE operation: DNS resolution,
  // every redirect hop, the TLS connect, and the body read.
  //
  // Two prior versions of this were wrong in different ways. The first cleared
  // the timer in a `finally` that ran before the body was read, so a server
  // that answered headers quickly and then dribbled bytes forever was
  // unbounded. The second covered the fetch but not the name lookup -- neither
  // Deno.resolveDns nor the DNS-over-HTTPS fallback took the signal, so a
  // hanging resolver sat entirely outside the deadline. resolveHostAddresses
  // now races the abort and passes the signal, and the TLS socket is closed on
  // abort, so there is no step left outside the budget.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let facts: Record<string, unknown> = {};
  let html = '';
  let isTruncated = false;
  let htmlHash: string | null = null;

  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      // Resolution is checked HERE, per hop, not once at admission. The
      // allowlist proves we are willing to talk to this NAME; this proves the
      // name currently points somewhere public. The address we approve is then
      // the address we connect to -- see httpsGetViaAddress.
      const hopUrl = new URL(currentUrl);
      const hopHost = hopUrl.hostname;
      const addresses = await resolveHostAddresses(hopHost, controller.signal);
      if (!allAddressesPublic(addresses)) {
        fetchError = addresses.length
          ? `destination_not_public: ${hopHost} -> ${addresses.join(', ').slice(0, 120)}`
          : `unresolvable_host: ${hopHost}`;
        break;
      }

      const res = await httpsGetViaAddress({
        address: addresses[0],
        host: hopHost,
        pathWithQuery: `${hopUrl.pathname}${hopUrl.search}`,
        signal: controller.signal,
        maxBytes: MAX_BYTES,
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location') ?? null;
        redirectChain.push({ from: currentUrl, status: res.status, location, address: addresses[0] });
        if (hop === MAX_HOPS) { fetchError = 'too_many_redirects'; break; }
        const next = admitRedirect(location, currentUrl, allowed);
        if (next.error) { fetchError = `redirect_${next.error}`; break; }
        currentUrl = next.url as string;
        continue;
      }

      response = res;
      isTruncated = res.truncated;
      html = new TextDecoder().decode(res.body);
      htmlHash = await sha256Hex(html);
      facts = extractPageFacts(html);
      // A chunked body that never delivered its terminating chunk is a partial
      // page. Recording it as a clean capture would let a later comparison read
      // "the content shrank" off a connection that was cut.
      if (!res.complete && !res.truncated) fetchError = 'incomplete_body';
      break;
    }
  } catch (err) {
    fetchError = (err as Error)?.name === 'AbortError'
      ? `timeout_after_${TIMEOUT_MS}ms`
      : `fetch_failed: ${String((err as Error)?.message ?? err).slice(0, 300)}`;
  } finally {
    // Only now, once the body is consumed or abandoned.
    clearTimeout(timer);
  }

  const responseMs = Date.now() - startedAt;

  const row = {
    company_entity_id: companyEntityId,
    requested_url: requestedUrl,
    host: admitted.host,
    final_url: response ? currentUrl : null,
    redirect_chain: redirectChain,
    http_status: response?.status ?? null,
    ...facts,
    content_bytes: response ? html.length : null,
    is_truncated: isTruncated,
    response_ms: responseMs,
    html_sha256: htmlHash,
    fetch_error: fetchError,
    fetched_at: new Date().toISOString(),
    fetched_by: user.id,
  };

  // The capture is recorded whether or not the fetch succeeded. A failed
  // attempt is a real observation ("we could not read this page at this
  // time") and losing it would leave a gap indistinguishable from never
  // having looked.
  const { data: inserted, error: insErr } = await service
    .from('page_inspections')
    .insert(row)
    .select('id')
    .single();

  // A capture that was not recorded is not a capture. This function's whole
  // purpose is to produce evidence a publication or a baseline can point at,
  // and returning ok:true with a null inspection_id hands the caller a reading
  // that nothing can later be checked against -- worse than an error, because
  // it looks like it worked. Fail loudly and let the caller retry.
  if (insErr || !inserted?.id) {
    return json({
      ok: false,
      error: `capture_not_stored: ${insErr?.message ?? 'insert returned no row'}`,
      inspection_id: null,
      ...row,
    }, 500);
  }

  return json({
    ok: !fetchError && !!response,
    inspection_id: inserted.id,
    ...row,
  }, 200);
});
