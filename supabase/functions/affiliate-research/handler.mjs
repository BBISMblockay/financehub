// affiliate-research -- Affiliate Studio's "Find creators with AI" and
// "Import a list". The logic is lib/affiliate-research-core.mjs (a VERBATIM
// copy of scripts/lib/affiliate-research-core.mjs) on top of
// lib/affiliate-discovery-core.mjs (VERBATIM too); both are pinned by
// scripts/tests/affiliate-research-edge.test.mjs.
//
// Authority, exactly as affiliate-discovery-run:
//   * the FIRST call is the caller-token RPC affiliate_managed_company(), whose
//     error aborts: it returns the caller's active company only if they may
//     manage affiliate programs there (and makes the two-step-login and
//     third-party-token hooks apply -- supabase/functions/CLAUDE.md);
//   * the program must belong to THAT company; the company is never taken
//     from the request;
//   * only then the service role, for the writes (affiliate_discovery_runs is
//     service-role-only by design) and the AI credit RPCs.
//
// Request: POST { action: 'research', program_id, focus?, count? }
//   -> 202 { run_id }. The research runs in the background (it takes minutes);
//      the page watches the run row. One research per program at a time.
// Request: POST { action: 'import', program_id, rows: [...] }  (<= 500 rows)
//   -> { kept, prospects_new, prospects_updated, skipped_minors, skipped_not_profile, suppressed_skipped }
//
// AI credit (docs/ops/ai-credits.md): one hold per run, opened before the
// first model call, grown before each later call; charged only when at least
// one creator survived the checks, free otherwise.
import { upsertCandidates, fetchSerpLive, buildSerpTask, candidatesFromResults } from './lib/affiliate-discovery-core.mjs';
import {
  buildResearchRequest, runResearchConversation, validateResearchCreators, importRowsToCandidates, clampCount,
  RESEARCH_PROVIDER, IMPORT_PROVIDER, MAX_IMPORT_ROWS, MAX_OUTPUT_TOKENS, WEB_SEARCH_USES, MAX_LEADS,
} from './lib/affiliate-research-core.mjs';
import { createCreditMeter, estimateInputTokens, usageFromResponse, addUsage } from './ai-credit-lib.mjs';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};
export const RUN_BUDGET_MS = 330_000;   // under the platform's background wall clock
export const STALE_RUN_MS = 10 * 60_000; // a "running" row older than this is a dead worker
// Fetched pages are re-read on every server-side step, so the input side of a
// run is far larger than the request. Deliberately high: a hold that is too
// big is released; one that is too small is absorbed by SILO.
export const HOLD_INPUT_TOKENS = 400_000;
// A further search round starts only with this much of the budget left, so a
// round is not cut off mid-way and the creators already found are saved.
export const ROUND_MIN_MS = 75_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

export function createResearchHandler({
  service, userClientFor, apiKey, model = 'claude-sonnet-5-5', fetchImpl = fetch,
  background = (p) => p, now = () => new Date(), newId = () => crypto.randomUUID(),
  serpCredentials = null, fetchSerp = null,
}) {
  const search = fetchSerp || (serpCredentials?.login && serpCredentials?.password ? (task) => fetchSerpLive({ credentials: serpCredentials, task }) : null);

  // Google leads for one run: the program's enabled searches, plus the focus
  // text as one more search. Leads are only handed to the AI; nothing is
  // stored from them unless the AI checks and records the creator. A failed
  // or unconfigured search just means fewer leads.
  async function gatherLeads(program, focus) {
    if (!search) return { leads: [], searched: 0, failed: 0 };
    const { data: sources } = await service.from('affiliate_prospect_sources')
      .select('id, query, platform_hint, location_code, language_code, max_results, kind, enabled')
      .eq('company_entity_id', program.company_entity_id).eq('program_id', program.id).eq('enabled', true).eq('kind', 'serp_query')
      .order('created_at', { ascending: true }).limit(3);
    const list = [...(sources || [])];
    if (focus) list.push({ id: null, query: focus, platform_hint: null, max_results: 30, location_code: null, language_code: null });
    const byUrl = new Map(); let searched = 0; let failed = 0;
    for (const src of list) {
      try {
        const { items } = await search(buildSerpTask(src, program));
        searched += 1;
        const { candidates } = candidatesFromResults({ items, program, source: src, collectedAt: now().toISOString() });
        for (const c of candidates) if (!byUrl.has(c.profile_url.toLowerCase())) byUrl.set(c.profile_url.toLowerCase(), c);
      } catch { failed += 1; }
    }
    return { leads: [...byUrl.values()].slice(0, MAX_LEADS), searched, failed };
  }

  async function finishRun(id, patch) {
    await service.from('affiliate_discovery_runs').update({ ...patch, finished_at: now().toISOString() }).eq('id', id);
  }

  async function research({ company, program, body, callerId }) {
    if (program.status !== 'active') return reply({ error: 'Set the program to active to research creators.' }, 409);
    if (!apiKey) return reply({ error: 'AI research is not set up yet.' }, 503);

    // One research per program at a time: a double click must not pay twice.
    const { data: last, error: lErr } = await service.from('affiliate_discovery_runs')
      .select('started_at, status').eq('company_entity_id', company).eq('program_id', program.id)
      .eq('provider', RESEARCH_PROVIDER).order('started_at', { ascending: false }).limit(1);
    if (lErr) return reply({ error: 'Could not check recent research.' }, 500);
    const prev = last?.[0];
    if (prev?.status === 'running' && now().getTime() - new Date(prev.started_at).getTime() < STALE_RUN_MS) {
      return reply({ error: 'Research is already running for this program. Results appear on this tab when it finishes.' }, 429);
    }

    const focus = String(body?.focus || '').trim().slice(0, 500);
    const runId = newId();
    const { data: row, error: rErr } = await service.from('affiliate_discovery_runs').insert({
      company_entity_id: company, program_id: program.id, source_id: null, run_id: runId, provider: RESEARCH_PROVIDER,
      query: focus || program.niche || 'AI research', started_at: now().toISOString(), status: 'running',
    }).select('id').single();
    if (rErr) return reply({ error: 'Could not start research.' }, 500);

    const meter = createCreditMeter({ db: service, requestId: newId(), companyId: company, userId: callerId,
      feature: 'affiliate_research', model, sourceRef: row.id });
    const firstRequest = buildResearchRequest({ program, focus, count: body?.count, model, today: now().toISOString().slice(0, 10) });
    const opened = await meter.open({ estInput: estimateInputTokens(firstRequest) + HOLD_INPUT_TOKENS, maxOutput: MAX_OUTPUT_TOKENS, maxWeb: WEB_SEARCH_USES, calls: 1 });
    if (!opened.ok) {
      const credit = opened.reason === 'insufficient_credit';
      await finishRun(row.id, { status: 'error', error: credit ? 'AI credit exhausted' : `AI credit check failed: ${opened.reason || 'unavailable'}` });
      return credit
        ? reply({ error: 'Your workspace is out of AI credit. A workspace owner can add credit in Workspace Settings → Billing.', credit_exhausted: true }, 402)
        : reply({ error: 'AI research is unavailable right now. Nothing was charged. Try again shortly.' }, 503);
    }

    const startedAt = now().getTime();
    const work = (async () => {
      let usages = []; let outcome = 'failed';
      try {
        const g = await gatherLeads(program, focus).catch(() => ({ leads: [], searched: 0, failed: 1 }));
        const request = buildResearchRequest({ program, focus, count: body?.count, model, today: now().toISOString().slice(0, 10), leads: g.leads });
        const callModel = async (b) => {
          const left = RUN_BUDGET_MS - (now().getTime() - startedAt);
          if (left <= 5_000) { outcome = 'timed_out'; throw new Error('research ran out of time'); }
          let res;
          try {
            res = await fetchImpl('https://api.anthropic.com/v1/messages', {
              method: 'POST', signal: AbortSignal.timeout(left),
              headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify(b),
            });
          } catch (e) {
            if (e?.name === 'TimeoutError' || e?.name === 'AbortError') outcome = 'timed_out';
            throw e;
          }
          if (!res.ok) throw new Error(`model HTTP ${res.status}`);
          return res.json();
        };
        const beforeNextCall = async (u, next) => {
          usages = u;
          if (RUN_BUDGET_MS - (now().getTime() - startedAt) < ROUND_MIN_MS) return false;
          const s = await meter.step({ usage: addUsage(u.map(usageFromResponse)), estInput: estimateInputTokens(next) + HOLD_INPUT_TOKENS, maxOutput: MAX_OUTPUT_TOKENS, maxWeb: WEB_SEARCH_USES });
          return s.ok !== false;
        };
        const wanted = clampCount(body?.count);
        const collectedAt = now().toISOString();
        const countKept = (list, ev) => validateResearchCreators({ creators: list, evidence: ev, program, focus, collectedAt }).stats.kept;
        const out = await runResearchConversation({ request, callModel, beforeNextCall, wanted, countKept, leads: g.leads });
        usages = out.usages;
        const { candidates, stats } = validateResearchCreators({ creators: out.creators, evidence: out.evidence, program, focus, collectedAt: now().toISOString() });
        const wrote = await upsertCandidates({ supabase: service, program, source: { id: null, query: focus || null }, candidates, runId,
          origin: { source: 'ai_research', collector: `affiliate-research/${RESEARCH_PROVIDER}` } });
        outcome = stats.kept > 0 ? 'succeeded' : 'failed';
        await finishRun(row.id, {
          status: 'ok', results_returned: stats.returned, profiles_recognized: stats.kept,
          prospects_new: wrote.prospects_new, prospects_updated: wrote.prospects_updated,
          suppressed_skipped: wrote.suppressed_skipped, emails_found: stats.emails_kept,
          error: stats.minors || stats.unverified || stats.not_profile || stats.over_source || stats.kept < wanted || g.leads.length
            ? `skipped: ${stats.minors} likely minors, ${stats.unverified} not found on a page read, ${stats.not_profile} not a profile link${stats.over_source ? `, ${stats.over_source} over the per-source limit` : ''}${stats.kept < wanted ? `; found ${stats.kept} of ${wanted}` : ''}${g.leads.length ? `; ${g.leads.length} Google leads checked` : ''}`
            : null,
        });
      } catch (err) {
        await finishRun(row.id, { status: 'error', error: String(err?.message || err).slice(0, 500) }).catch(() => {});
      } finally {
        await meter.settle({ usage: addUsage(usages.map(usageFromResponse)), outcome, error: outcome === 'succeeded' ? null : 'no_creators_kept' }).catch(() => {});
      }
    })();
    background(work);
    return reply({ run_id: row.id }, 202);
  }

  async function importRows({ company, program, body }) {
    const rows = body?.rows;
    if (!Array.isArray(rows) || !rows.length) return reply({ error: 'The file has no rows.' }, 400);
    if (rows.length > MAX_IMPORT_ROWS) return reply({ error: `Send at most ${MAX_IMPORT_ROWS} rows at a time.` }, 413);
    const started = now().toISOString();
    const { candidates, stats } = importRowsToCandidates({ rows, program, collectedAt: started });
    const runId = newId();
    try {
      const wrote = await upsertCandidates({ supabase: service, program, source: { id: null, query: 'CSV import' }, candidates, runId,
        origin: { source: 'csv_import', collector: 'affiliate-import' } });
      await service.from('affiliate_discovery_runs').insert({
        company_entity_id: company, program_id: program.id, source_id: null, run_id: runId, provider: IMPORT_PROVIDER,
        query: 'CSV import', started_at: started, finished_at: now().toISOString(), status: 'ok',
        results_returned: stats.returned, profiles_recognized: stats.kept, prospects_new: wrote.prospects_new,
        prospects_updated: wrote.prospects_updated, suppressed_skipped: wrote.suppressed_skipped, emails_found: stats.emails_kept,
      });
      return reply({ kept: stats.kept, prospects_new: wrote.prospects_new, prospects_updated: wrote.prospects_updated,
        skipped_minors: stats.minors, skipped_not_profile: stats.not_profile, suppressed_skipped: wrote.suppressed_skipped });
    } catch (err) {
      return reply({ error: 'The import could not be completed. Nothing after the failing row was saved; import the file again to finish.', detail: String(err?.message || err).slice(0, 300) }, 500);
    }
  }

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
      return reply({ error: 'This needs Affiliate Studio access for your active company.' }, 403);
    }
    const { data: who } = await caller.auth.getUser().catch(() => ({ data: null }));

    let body;
    try { body = await req.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const programId = String(body?.program_id || '');
    if (!UUID_RE.test(programId)) return reply({ error: 'Choose a program.' }, 400);

    // 2. The program, inside the caller's company only.
    const { data: program, error: pErr } = await service.from('affiliate_programs')
      .select('id, company_entity_id, name, niche, audience_notes, platforms, geographies, status')
      .eq('id', programId).eq('company_entity_id', company).maybeSingle();
    if (pErr) return reply({ error: 'Could not load the program.' }, 500);
    if (!program) return reply({ error: 'Program not found.' }, 404);

    if (body?.action === 'research') return research({ company, program, body, callerId: who?.user?.id ?? null });
    if (body?.action === 'import') return importRows({ company, program, body });
    return reply({ error: 'Unknown action.' }, 400);
  };
}
