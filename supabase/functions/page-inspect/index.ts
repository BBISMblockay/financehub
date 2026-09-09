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
import { admitUrl, admitRedirect, extractPageFacts } from './inspect-lib.mjs';

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const res = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        redirectChain.push({ from: currentUrl, status: res.status, location });
        if (hop === MAX_HOPS) { fetchError = 'too_many_redirects'; break; }
        const next = admitRedirect(location, currentUrl, allowed);
        if (next.error) { fetchError = `redirect_${next.error}`; break; }
        currentUrl = next.url as string;
        continue;
      }
      response = res;
      break;
    }
  } catch (err) {
    fetchError = (err as Error)?.name === 'AbortError'
      ? `timeout_after_${TIMEOUT_MS}ms`
      : `fetch_failed: ${String((err as Error)?.message ?? err).slice(0, 300)}`;
  } finally {
    clearTimeout(timer);
  }

  const responseMs = Date.now() - startedAt;

  let facts: Record<string, unknown> = {};
  let html = '';
  let isTruncated = false;
  let htmlHash: string | null = null;

  if (response) {
    const raw = await response.text();
    isTruncated = raw.length > MAX_BYTES;
    html = isTruncated ? raw.slice(0, MAX_BYTES) : raw;
    htmlHash = await sha256Hex(html);
    facts = extractPageFacts(html);
  }

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

  return json({
    ok: !fetchError && !!response,
    inspection_id: inserted?.id ?? null,
    store_error: insErr?.message ?? null,
    ...row,
  }, 200);
});
