// affiliate-discovery-run -- "Search now" for Affiliate Studio: run one
// program's discovery searches immediately, instead of waiting for the weekly
// workflow (.github/workflows/affiliate-discovery.yml), which keeps running as
// the background refresh.
//
// The search logic is lib/affiliate-discovery-core.mjs, a VERBATIM copy of
// scripts/lib/affiliate-discovery-core.mjs pinned by
// scripts/tests/affiliate-discovery-run-edge.test.mjs: one implementation,
// two callers, the same per-program cost cap.
//
// Authority:
//   * The FIRST call is a caller-token PostgREST call,
//     affiliate_managed_company(), whose error aborts. It returns the caller's
//     active company only if they may manage affiliate programs there, in one
//     statement, so a company switch mid-request cannot redirect it. That call
//     is also what makes the two-step-login and third-party-token hooks apply
//     (supabase/functions/CLAUDE.md).
//   * The program must belong to THAT company and be active. The company is
//     never taken from the request.
//   * Only then does it use the service role: discovery writes
//     affiliate_discovery_runs (service-role-only by design) and prospects.
//
// Spend: each query is a paid provider request, bounded by the program's
// stored cap (discovery_max_cost_usd) exactly as the weekly run is, and a
// program can be searched at most once a minute.
//
// Request: POST { program_id }
// Reply:   { ran, failed, skipped, prospects_new, prospects_updated } -- no
//          cost figures; spend is the operator's business, not the page's.
import { runDiscovery, fetchSerpLive } from './lib/affiliate-discovery-core.mjs';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};
export const COOLDOWN_MS = 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

export function createDiscoveryRunHandler({ service, userClientFor, credentials, fetchSerp, now = () => new Date() }) {
  const search = fetchSerp || ((task) => fetchSerpLive({ credentials, task }));

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);
    const authHeader = req.headers.get('Authorization') || '';
    if (!/^Bearer\s+\S+/.test(authHeader)) return reply({ error: 'Unauthorized' }, 401);

    // 1. Authority and company, from the database, as the caller, in one call.
    const caller = userClientFor(authHeader);
    const { data: company, error: gateErr } = await caller.rpc('affiliate_managed_company');
    if (gateErr) return reply({ error: 'Your session could not be verified. Sign in again.' }, 401);
    if (!company || !UUID_RE.test(String(company))) {
      return reply({ error: 'Searching needs Affiliate Studio access for your active company.' }, 403);
    }

    let body;
    try { body = await req.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const programId = String(body?.program_id || '');
    if (!UUID_RE.test(programId)) return reply({ error: 'Choose a program.' }, 400);

    // 2. The program, inside the caller's company only.
    const { data: program, error: pErr } = await service.from('affiliate_programs')
      .select('id, status').eq('id', programId).eq('company_entity_id', company).maybeSingle();
    if (pErr) return reply({ error: 'Could not load the program.' }, 500);
    if (!program) return reply({ error: 'Program not found.' }, 404);
    if (program.status !== 'active') return reply({ error: 'Set the program to active to search.' }, 409);

    if (!fetchSerp && !(credentials?.login && credentials?.password)) {
      return reply({ error: 'Search is not set up yet. It runs with the weekly refresh in the meantime.' }, 503);
    }

    // 3. At most one search per program per minute: a double click must not
    //    pay twice.
    const { data: last, error: lErr } = await service.from('affiliate_discovery_runs')
      .select('started_at').eq('company_entity_id', company).eq('program_id', programId)
      .order('started_at', { ascending: false }).limit(1);
    if (lErr) return reply({ error: 'Could not check recent searches.' }, 500);
    const lastAt = last?.[0]?.started_at ? new Date(last[0].started_at).getTime() : 0;
    if (lastAt && now().getTime() - lastAt < COOLDOWN_MS) {
      return reply({ error: 'A search just ran for this program. Try again in a minute.' }, 429);
    }

    // 4. Run it -- the same code and cap as the weekly refresh.
    try {
      const s = await runDiscovery({ supabase: service, onlyProgramId: programId, fetchSerp: search, now });
      return reply({ ran: s.ran, failed: s.failed, skipped: s.skipped, prospects_new: s.prospects_new, prospects_updated: s.prospects_updated });
    } catch (err) {
      return reply({ error: 'The search could not be completed. Try again shortly.', detail: String(err?.message || err).slice(0, 300) }, 500);
    }
  };
}
