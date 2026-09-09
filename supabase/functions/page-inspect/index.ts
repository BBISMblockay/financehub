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
async function resolveHostAddresses(host: string): Promise<string[]> {
  const out: string[] = [];

  const maybeResolve = (Deno as unknown as {
    resolveDns?: (h: string, t: string) => Promise<string[]>;
  }).resolveDns;
  if (typeof maybeResolve === 'function') {
    for (const type of ['A', 'AAAA']) {
      try { out.push(...await maybeResolve(host, type)); } catch { /* NODATA is normal */ }
    }
    if (out.length) return out;
  }

  for (const type of ['A', 'AAAA']) {
    try {
      const res = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
        { headers: { Accept: 'application/dns-json' } },
      );
      if (!res.ok) continue;
      const data = await res.json();
      for (const answer of data?.Answer ?? []) {
        // 1 = A, 28 = AAAA. Anything else in the chain (CNAME) is followed by
        // the resolver itself, so only address records are collected.
        if (answer?.type === 1 || answer?.type === 28) out.push(String(answer.data));
      }
    } catch { /* fall through to the empty-list refusal */ }
  }
  return out;
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
  let response: Response | null = null;
  let fetchError: string | null = null;

  // ONE controller and ONE timer for the whole operation, redirects and body
  // download included. The first version cleared the timer in a `finally` that
  // ran before the body was read, so a server that answered headers quickly and
  // then dribbled bytes forever was completely unbounded -- the timeout only
  // ever covered the handshake.
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
      // name currently points somewhere public.
      const hopHost = new URL(currentUrl).hostname;
      const addresses = await resolveHostAddresses(hopHost);
      if (!allAddressesPublic(addresses)) {
        fetchError = addresses.length
          ? `destination_not_public: ${hopHost} -> ${addresses.join(', ').slice(0, 120)}`
          : `unresolvable_host: ${hopHost}`;
        break;
      }

      const res = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        redirectChain.push({ from: currentUrl, status: res.status, location });
        // Drain the redirect body so the connection is not left hanging.
        await res.body?.cancel().catch(() => {});
        if (hop === MAX_HOPS) { fetchError = 'too_many_redirects'; break; }
        const next = admitRedirect(location, currentUrl, allowed);
        if (next.error) { fetchError = `redirect_${next.error}`; break; }
        currentUrl = next.url as string;
        continue;
      }
      response = res;
      break;
    }

    if (response) {
      // Read at most MAX_BYTES + 1 and stop. response.text() downloads the
      // WHOLE body first and truncates after, which makes the cap decorative:
      // a 2 GB response is fully transferred before a single byte is discarded.
      // The extra byte is what distinguishes "exactly at the cap" from "over".
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        while (total <= MAX_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) { chunks.push(value); total += value.byteLength; }
        }
        if (total > MAX_BYTES) {
          isTruncated = true;
          await reader.cancel().catch(() => {});
        }
      }
      const joined = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) { joined.set(c, at); at += c.byteLength; }
      html = new TextDecoder().decode(joined.slice(0, MAX_BYTES));
      htmlHash = await sha256Hex(html);
      facts = extractPageFacts(html);
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
