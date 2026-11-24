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
// Request: POST { action: 'customer_scan', count?, filters? }
//   -> 202 { scan_id } (or 200 { scan_id, joined: true } while one runs).
//      COMPANY level, no program (Blake 2026-11-24: people come before
//      program): one answer per customer per company, one running scan per
//      company, every platform searched, the follower bar from
//      entities.meta.affiliate_customer_scan_min_followers. A program_id in
//      the request is ignored.
//      "Find their social accounts" on Your Customers: one search per customer
//      through the same provider, the model only for ambiguous searches
//      (lib/affiliate-customer-scan-core.mjs). The page watches the scan row.
//
// AI credit (docs/ops/ai-credits.md): one hold per run, opened before the
// first model call, grown before each later call; charged only when at least
// one creator survived the checks, free otherwise.
import { upsertCandidates, fetchSerpLive, buildSerpTask, candidatesFromResults } from './lib/affiliate-discovery-core.mjs';
import { storeProspectPhotos } from './lib/affiliate-photo-core.mjs';
import { enrichYouTubeProspects, needsYouTubeRefresh, buildCreatorProfile, channelRef, searchYouTubeChannels } from './lib/affiliate-youtube-core.mjs';
import {
  buildResearchRequest, runResearchConversation, validateResearchCreators, importRowsToCandidates, clampCount,
  RESEARCH_PROVIDER, IMPORT_PROVIDER, MAX_IMPORT_ROWS, MAX_OUTPUT_TOKENS, WEB_SEARCH_USES, MAX_LEADS, leadSearches, interleaveLeads,
  knownCreators, isKnown, leanRun, LEAN_MAX_CALLS, MAX_MODEL_CALLS,
} from './lib/affiliate-research-core.mjs';
import { createCreditMeter, estimateInputTokens, usageFromResponse, addUsage } from './ai-credit-lib.mjs';
import {
  personName, buildScanTask, scanQuery, judgeResults, buildAiRequest, applyAiAnswer, clampScanCount, minFollowersFor,
  socialRowPatch, scanFilters, SCAN_SORTS, SCAN_CONCURRENCY, AI_BATCH, AI_MAX_OUTPUT_TOKENS, NEVER_SCAN_CONSENT,
  matchBasis, teamFilter, emailHandle, buildHandleTask, judgeHandle, COMPANY_SCAN_SCOPE, companyMinFollowers,
} from './lib/affiliate-customer-scan-core.mjs';

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
// Creator photos: SILO opens each profile page itself (lib/affiliate-photo-core.mjs).
// After a research run it spends at most PHOTO_RUN_MS on the creators it just
// kept; "Refresh photos" checks up to PHOTO_REFRESH_MAX prospects that have no
// stored copy yet, within PHOTO_REFRESH_MS. No photoFetch = photos off.
export const PHOTO_RUN_MS = 30_000;
export const PHOTO_REFRESH_MS = 45_000;
export const PHOTO_REFRESH_MAX = 30;
// YouTube numbers (lib/affiliate-youtube-core.mjs, SILO's YOUTUBE_API_KEY):
// after a run or an import, the YouTube creators it kept; "Refresh" checks up
// to STATS_REFRESH_MAX whose numbers are missing or a week old. No key = off.
export const STATS_RUN_MS = 25_000;
export const STATS_REFRESH_MS = 40_000;
export const STATS_REFRESH_MAX = 60;
const PROSPECT_COLS = 'id, platform, handle, display_name, profile_url, contact_email, contact_source_url, evidence, collected_at';
// Non-YouTube candidates get their structured profile now; YouTube ones get
// it from the API lookup that follows, so a run never replaces a profile that
// carries engagement with one that does not.
const withProfile = (cands) => cands.map((c) => (channelRef(c.profile_url) ? c : { ...c, evidence: { ...c.evidence, creator_profile: buildCreatorProfile(c) } }));
// "Find their social accounts" (lib/affiliate-customer-scan-core.mjs). A scan
// whose worker has not written for this long is a dead worker, not a running
// scan, so the next press takes over instead of joining it.
export const STALE_SCAN_MS = 3 * 60_000;
// Searches stop starting with this much of the run left, so the ambiguous
// customers already searched still get their model pass and the counts land.
export const SCAN_TAIL_MS = 40_000;
// How far down the customer list a press looks to fill its count: a slice
// full of names a search cannot use (businesses, initials) must not walk the
// whole table.
export const SCAN_PAGE = 1000;
export const SCAN_MAX_PAGES = 20;
// Ambiguous rows from earlier scans judged per press, from stored profiles.
export const CARRY_AMBIGUOUS = 200;
// A press runs to the end on its own: when one run's time is up with
// customers still queued, it hands the SAME scan to a fresh run of this
// function (Blake 2026-11-24: "Stopped early. Doesn't seem great user
// experience"). At most this many runs per press, so a scan whose searches
// keep failing cannot chain for ever.
export const SCAN_MAX_LEGS = 8;
const CHUNK = 200;
const chunks = (list, n = CHUNK) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

export function createResearchHandler({
  service, userClientFor, apiKey, model = 'claude-sonnet-5-5', fetchImpl = fetch,
  background = (p) => p, now = () => new Date(), newId = () => crypto.randomUUID(),
  serpCredentials = null, fetchSerp = null, photoFetch = null, youtubeKey = '', youtubeFetch = fetch,
  // (authHeader, body) => Promise<Response>: calls this function again, as
  // the same person, to continue a scan. Unset = a scan stops at its budget.
  selfInvoke = null,
}) {
  const search = fetchSerp || (serpCredentials?.login && serpCredentials?.password ? (task) => fetchSerpLive({ credentials: serpCredentials, task }) : null);

  // Google leads for one run: the words typed into Find creators, searched
  // once per ticked social platform (in parallel), the results taken in turn
  // so each platform gets a share. Leads are only handed to the AI; nothing is
  // stored from them unless the AI checks and records the creator. A failed
  // or unconfigured search just means fewer leads.
  //
  // YouTube's own channel search goes first (SILO's free API quota, real
  // subscriber numbers): the typed words, or the program's niche.
  async function youtubeLeads(program, focus) {
    const plats = program.platforms || [];
    const q = String(focus || program.niche || '').trim();
    if (!youtubeKey || !q || (plats.length && !plats.includes('youtube'))) return [];
    const geo = program.geographies || [];
    return searchYouTubeChannels({ query: q, apiKey: youtubeKey, fetchImpl: youtubeFetch, regionCode: geo.length === 1 ? geo[0] : null, collectedAt: now().toISOString() });
  }

  async function gatherLeads(program, focus) {
    let searched = 0; let failed = 0; let youtube = 0;
    const yt = (async () => {
      try { const l = await youtubeLeads(program, focus); youtube = l.length; return l; }
      catch { failed += 1; return []; }
    })();
    const lists = await Promise.all([yt, ...(search ? leadSearches(program, focus) : []).map(async (src) => {
      try {
        const { items } = await search(buildSerpTask(src, program));
        searched += 1;
        return candidatesFromResults({ items, program, source: src, collectedAt: now().toISOString() }).candidates;
      } catch { failed += 1; return []; }
    })]);
    return { leads: interleaveLeads(lists, MAX_LEADS), searched, failed, youtube };
  }

  // Photos for prospects of THIS company and program, by profile URL (null = the
  // newest ones with no stored copy yet).
  async function photosFor({ company, program, urls = null, deadline }) {
    if (!photoFetch) return { checked: 0, stored: 0 };
    let q = service.from('affiliate_prospects').select('id, profile_url, evidence, collected_at')
      .eq('company_entity_id', company).eq('program_id', program.id);
    if (urls) q = q.in('profile_url', urls);
    const { data, error } = await q.order('collected_at', { ascending: false }).limit(urls ? urls.length : 200);
    if (error) return { checked: 0, stored: 0 };
    const todo = (data || []).filter((p) => p.profile_url && (urls || !p.evidence?.profile_image_stored)).slice(0, urls ? urls.length : PHOTO_REFRESH_MAX);
    return storeProspectPhotos({ service, company, prospects: todo, fetchImpl: photoFetch, now, deadline });
  }

  // YouTube numbers for prospects of THIS company and program, by profile URL
  // (null = those missing numbers or a week old). Never throws.
  async function statsFor({ company, program, urls = null, deadline }) {
    if (!youtubeKey) return { checked: 0, updated: 0, failed: 0, skipped: 0, quota: false, off: true };
    let q = service.from('affiliate_prospects').select(PROSPECT_COLS)
      .eq('company_entity_id', company).eq('program_id', program.id).eq('platform', 'youtube');
    if (urls) q = q.in('profile_url', urls);
    const { data, error } = await q.order('collected_at', { ascending: false }).limit(urls ? urls.length : 500);
    if (error) return { checked: 0, updated: 0, failed: 0, skipped: 0, quota: false };
    const at = now();
    const todo = (data || []).filter((p) => (urls ? true : needsYouTubeRefresh(p, at))).slice(0, urls ? urls.length : STATS_REFRESH_MAX);
    return enrichYouTubeProspects({ service, company, prospects: todo, apiKey: youtubeKey, fetchImpl: youtubeFetch, now, deadline });
  }

  async function refreshStats({ company, program }) {
    if (!youtubeKey) return reply({ error: 'Creator stats are not available right now.' }, 503);
    return reply(await statsFor({ company, program, deadline: Date.now() + STATS_REFRESH_MS }));
  }

  async function refreshPhotos({ company, program }) {
    if (!photoFetch) return reply({ error: 'Photos are not available right now.' }, 503);
    const out = await photosFor({ company, program, deadline: Date.now() + PHOTO_REFRESH_MS });
    return reply(out);
  }

  // Every creator this company already has, in any program: its affiliates
  // and its prospects (whatever their status, rejected and do-not-contact
  // included). A failed read means "none known", never a failed run.
  async function knownFor(company) {
    const rows = [];
    for (const [table, cap] of [['affiliates', 2000], ['affiliate_prospects', 5000]]) {
      const { data, error } = await service.from(table).select('platform, handle, profile_url')
        .eq('company_entity_id', company).order('created_at', { ascending: false }).limit(cap);
      if (!error) rows.push(...(data || []));
    }
    return knownCreators(rows);
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
        const known = await knownFor(company).catch(() => null);
        const g = await gatherLeads(program, focus).catch(() => ({ leads: [], searched: 0, failed: 1 }));
        // A lead the company already has is not worth the AI's time.
        g.leads = g.leads.filter((l) => !isKnown(known, l));
        const lean = leanRun(g.leads, body?.count);
        const request = buildResearchRequest({ program, focus, count: body?.count, model, today: now().toISOString().slice(0, 10), leads: g.leads, known, lean });
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
        const countKept = (list, ev) => validateResearchCreators({ creators: list, evidence: ev, program, focus, collectedAt, known }).stats.kept;
        const out = await runResearchConversation({ request, callModel, beforeNextCall, wanted, countKept, leads: g.leads, maxCalls: lean ? LEAN_MAX_CALLS : MAX_MODEL_CALLS });
        usages = out.usages;
        const { candidates, stats } = validateResearchCreators({ creators: out.creators, evidence: out.evidence, program, focus, collectedAt: now().toISOString(), fillTo: wanted, known });
        const wrote = await upsertCandidates({ supabase: service, program, source: { id: null, query: focus || null }, candidates: withProfile(candidates), runId,
          origin: { source: 'ai_research', collector: `affiliate-research/${RESEARCH_PROVIDER}` } });
        // Photos for the creators this run kept; never fails the run.
        await photosFor({ company: program.company_entity_id, program, urls: candidates.map((c) => c.profile_url), deadline: Date.now() + PHOTO_RUN_MS }).catch(() => {});
        // YouTube numbers for the channels this run kept; never fails the run.
        const ytUrls = candidates.filter((c) => channelRef(c.profile_url)).map((c) => c.profile_url);
        if (ytUrls.length) await statsFor({ company: program.company_entity_id, program, urls: ytUrls, deadline: Date.now() + STATS_RUN_MS }).catch(() => {});
        outcome = stats.kept > 0 ? 'succeeded' : 'failed';
        await finishRun(row.id, {
          status: 'ok', results_returned: stats.returned, profiles_recognized: stats.kept,
          prospects_new: wrote.prospects_new, prospects_updated: wrote.prospects_updated,
          suppressed_skipped: wrote.suppressed_skipped, emails_found: stats.emails_kept,
          error: stats.minors || stats.unverified || stats.not_profile || stats.over_source || stats.topped_up || stats.known || stats.kept < wanted || g.leads.length
            ? `skipped: ${stats.minors} likely minors, ${stats.unverified} not found on a page read, ${stats.not_profile} not a profile link${stats.over_source ? `, ${stats.over_source} over the per-source limit` : ''}${stats.topped_up ? `, ${stats.topped_up} added from a list page to fill the run` : ''}${stats.known ? `, ${stats.known} already known` : ''}${stats.kept < wanted ? `; found ${stats.kept} of ${wanted}` : ''}${g.leads.length ? `; ${g.leads.length} ${g.youtube ? `leads checked (${g.youtube} from YouTube)` : 'Google leads checked'}` : ''}${lean ? ', shortlist mode' : ''}`
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
      const wrote = await upsertCandidates({ supabase: service, program, source: { id: null, query: 'CSV import' }, candidates: withProfile(candidates), runId,
        origin: { source: 'csv_import', collector: 'affiliate-import' } });
      const ytUrls = candidates.filter((c) => channelRef(c.profile_url)).map((c) => c.profile_url);
      if (ytUrls.length) await statsFor({ company, program, urls: ytUrls, deadline: Date.now() + STATS_RUN_MS }).catch(() => {});
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

  // ── Find their social accounts ────────────────────────────────────────
  // One press scans up to `count` customers from the slice the person is
  // looking at, top-ranked first. The rows are written as 'pending' before any
  // search runs, so a run that hits its time limit leaves a queue the next
  // press finishes -- "stopped early, more to check" -- rather than losing its
  // place. A press while a scan is running joins it.
  async function customerScan({ company, body, callerId, authHeader }) {
    if (!search) return reply({ error: 'Social lookups are not set up yet.' }, 503);
    // The next leg of a running scan, started by the previous leg. It must
    // carry the one-time handoff the previous leg wrote, so a stray or
    // repeated call can never run a second worker over the same queue.
    if (body?.continue_scan !== undefined) {
      const id = String(body.continue_scan || '');
      const handoff = String(body.handoff || '');
      if (!UUID_RE.test(id) || !handoff) return reply({ error: 'Unknown scan.' }, 400);
      const { data: row } = await service.from('affiliate_customer_scans')
        .select('id, status, requested, checked, found, below, no_count, ambiguous, not_found, failed, filters, min_followers, cost_usd, started_at')
        .eq('id', id).eq('company_entity_id', company).maybeSingle();
      if (!row || row.status !== 'running' || row.filters?.handoff !== handoff) return reply({ error: 'This scan is not waiting to continue.' }, 409);
      const { handoff: _used, ...filters } = row.filters || {};
      await service.from('affiliate_customer_scans').update({ filters, heartbeat_at: now().toISOString() })
        .eq('id', id).eq('company_entity_id', company);
      const leg = Math.max(1, Math.min(SCAN_MAX_LEGS, Math.floor(Number(body.leg)) || 1));
      background(runScan({ company, program: COMPANY_SCAN_SCOPE, scanId: id, want: row.requested, filters, minFollowers: Number(row.min_followers) || 0,
        callerId, started: now().getTime(), authHeader, leg, resume: row }));
      return reply({ scan_id: id, continued: true }, 202);
    }
    // Every platform SILO reads profiles from, not one program's ticks: the
    // answer is about the customer, and it is the same in every program.
    const program = COMPANY_SCAN_SCOPE;
    const { data: live, error: lErr } = await service.from('affiliate_customer_scans')
      .select('id, heartbeat_at, started_at').eq('company_entity_id', company)
      .eq('status', 'running').order('started_at', { ascending: false }).limit(1);
    if (lErr) return reply({ error: 'Social lookups need a database update first.' }, 503);
    const prev = live?.[0];
    if (prev) {
      const beat = new Date(prev.heartbeat_at || prev.started_at).getTime();
      if (now().getTime() - beat < STALE_SCAN_MS) return reply({ scan_id: prev.id, joined: true });
      await service.from('affiliate_customer_scans').update({ status: 'stopped', finished_at: now().toISOString(), error_message: 'The scan stopped before it finished.' })
        .eq('id', prev.id).eq('company_entity_id', company);
    }
    // The follower bar is the company's (data, 750 when unset).
    const { data: ent } = await service.from('entities').select('meta').eq('id', company).maybeSingle();
    const minFollowers = companyMinFollowers(ent?.meta);
    const want = clampScanCount(body?.count);
    const filters = scanFilters(body?.filters);
    const startedAt = now();
    const { data: scan, error: sErr } = await service.from('affiliate_customer_scans').insert({
      company_entity_id: company, program_id: null, created_by: callerId, status: 'running',
      requested: 0, started_at: startedAt.toISOString(), heartbeat_at: startedAt.toISOString(), filters, min_followers: minFollowers,
    }).select('id').single();
    // The partial unique index refuses a second running scan: two presses at
    // the same instant join one scan rather than paying twice.
    if (sErr) return reply({ error: 'A scan is already running. Its results appear on this list.' }, 429);
    background(runScan({ company, program, scanId: scan.id, want, filters, minFollowers, callerId, started: startedAt.getTime(), authHeader }));
    return reply({ scan_id: scan.id }, 202);
  }

  // Who may never be scanned: do-not-contact addresses and domains, and the
  // company's own people. Read fresh for every press.
  async function scanGuards(company) {
    const { data: sup } = await service.from('affiliate_suppressions').select('kind, value_normalized')
      .eq('company_entity_id', company).limit(5000);
    const supEmails = new Set((sup || []).filter((x) => x.kind === 'email').map((x) => x.value_normalized));
    const supDomains = (sup || []).filter((x) => x.kind === 'domain').map((x) => x.value_normalized);
    const suppressed = (email) => {
      const e = String(email || '').toLowerCase().trim();
      if (!e) return false;
      if (supEmails.has(e)) return true;
      const host = e.split('@')[1] || '';
      return supDomains.some((d) => host === d || host.endsWith(`.${d}`));
    };
    // The company's own people are never scanned as customers (Blake,
    // 2026-11-24: a find was an employee). Members' addresses, and their
    // company domains, from the membership list -- data, not code.
    const { data: members, error: mErr } = await service.from('entity_memberships').select('user_id').eq('entity_id', company).limit(5000);
    if (mErr) throw new Error(`could not read the team: ${mErr.message || mErr}`);
    const memberEmails = [];
    for (const ids of chunks((members || []).map((m) => m.user_id).filter(Boolean))) {
      const { data: ps, error: pErr } = await service.from('profiles').select('email').in('id', ids);
      if (pErr) throw new Error(`could not read the team: ${pErr.message || pErr}`);
      for (const x of ps || []) if (x.email) memberEmails.push(x.email);
    }
    const isTeam = teamFilter(memberEmails);
    return { suppressed, isTeam };
  }

  // Rows already stored are re-checked against CURRENT consent, suppression
  // and team before anything more is done with them: searching (the queue)
  // or sending their name and profiles to the model (carried ambiguous rows).
  async function recheck(company, left, { suppressed, isTeam }) {
    // A queued customer is re-checked before it is resumed: consent can
    // change between the press that queued them and the one that finishes
    // them, and somebody who has since unsubscribed (or been added to
    // do-not-contact) is dropped from the queue rather than searched. Their
    // row is deleted, not marked, so nothing records a search that never ran
    // and the slice can pick them up again only if they become eligible.
    const now_ = new Map();
    for (const keys of chunks((left || []).map((r) => r.customer_key))) {
      const { data: cur, error: cErr } = await service.from('company_customer_profiles')
        .select('customer_key, email_lc, email_consent_state').eq('company_entity_id', company).in('customer_key', keys);
      if (cErr) throw new Error(`could not re-check queued customers: ${cErr.message || cErr}`);
      for (const c of cur || []) now_.set(c.customer_key, c);
    }
    const eligible = (r) => {
      const c = now_.get(r.customer_key);
      return !!c && !NEVER_SCAN_CONSENT.includes(c.email_consent_state) && !suppressed(c.email_lc) && !isTeam(c.email_lc);
    };
    return eligible;
  }

  // The customers to scan, written as pending rows. Rows an earlier run left
  // pending (or that failed) come first; then new customers from the slice.
  async function queueScan({ company, program, scanId, want, filters, guards }) {
    const { suppressed, isTeam } = guards;
    const { data: left } = await service.from('affiliate_customer_social').select('id, customer_key')
      .eq('company_entity_id', company).in('status', ['pending', 'error'])
      .order('created_at', { ascending: true }).limit(want);
    const eligible = await recheck(company, left, guards);
    const dropped = (left || []).filter((r) => !eligible(r)).map((r) => r.id);
    for (const ids of chunks(dropped)) {
      await service.from('affiliate_customer_social').delete().eq('company_entity_id', company).in('id', ids);
    }
    const resumed = (left || []).filter(eligible).map((r) => r.id);
    for (const ids of chunks(resumed)) {
      await service.from('affiliate_customer_social').update({ scan_id: scanId, status: 'pending' })
        .eq('company_entity_id', company).in('id', ids);
    }
    let need = want - resumed.length;
    if (need <= 0) return resumed.length;
    let added = 0;
    for (let page = 0; page < SCAN_MAX_PAGES && need > 0; page += 1) {
      let q = service.from('company_customer_profiles')
        .select('customer_key, email_lc, name_lc, first_name_lc, last_name_lc, order_count, last_order_at, lifetime_spend, email_consent_state')
        .eq('company_entity_id', company).gte('order_count', filters.minOrders)
        // An explicit opt-out is never researched. NULL (not checked yet) IS
        // scanned: a plain NOT IN would drop every unmeasured customer, which
        // is most of them, because NULL NOT IN (...) is not true.
        .or(`email_consent_state.is.null,email_consent_state.not.in.(${NEVER_SCAN_CONSENT.join(',')})`);
      if (filters.from) q = q.gte('last_order_at', filters.from);
      if (filters.toExclusive) q = q.lt('last_order_at', filters.toExclusive);
      if (filters.consentIsNull) q = q.is('email_consent_state', null);
      else if (filters.consentState) q = q.eq('email_consent_state', filters.consentState);
      for (const [col, asc] of SCAN_SORTS[filters.sort]) q = q.order(col, { ascending: asc, nullsFirst: false });
      const { data: rows, error } = await q.range(page * SCAN_PAGE, page * SCAN_PAGE + SCAN_PAGE - 1);
      if (error) throw new Error(`could not read customers: ${error.message || error}`);
      if (!rows?.length) break;
      let pick = rows.filter((r) => personName(r.name_lc, r.first_name_lc, r.last_name_lc) && !suppressed(r.email_lc) && !isTeam(r.email_lc));
      // Somebody this company already scanned -- under any program, or none
      // -- is not searched (or paid for) twice.
      const seen = new Set();
      for (const keys of chunks(pick.map((r) => r.customer_key))) {
        const { data: had } = await service.from('affiliate_customer_social').select('customer_key')
          .eq('company_entity_id', company).in('customer_key', keys);
        for (const h of had || []) seen.add(h.customer_key);
      }
      pick = pick.filter((r) => !seen.has(r.customer_key)).slice(0, need);
      // The city is the biggest hit-rate lever there is: "Emily Durrance"
      // Phoenix finds the right Emily. From the customer's own record, where
      // the store granted read_customers; otherwise the search is name only.
      const city = new Map();
      for (const emails of chunks(pick.map((r) => r.email_lc).filter(Boolean))) {
        const { data: cs } = await service.from('shopify_customers').select('email_lc, city, province_code')
          .eq('company_entity_id', company).in('email_lc', emails);
        // "Phoenix, AZ": the state narrows the search; matchBasis reads the
        // city part only, since two letters prove nothing on their own.
        for (const c of cs || []) {
          if (!c.city || !String(c.city).trim() || city.has(c.email_lc)) continue;
          const st = /^[A-Za-z]{2}$/.test(String(c.province_code || '').trim()) ? `, ${String(c.province_code).trim().toUpperCase()}` : '';
          city.set(c.email_lc, `${String(c.city).trim()}${st}`);
        }
      }
      for (const part of chunks(pick)) {
        const { error: iErr } = await service.from('affiliate_customer_social').insert(part.map((r) => {
          const person = personName(r.name_lc, r.first_name_lc, r.last_name_lc);
          return {
            company_entity_id: company, program_id: null, scan_id: scanId, customer_key: r.customer_key,
            email_lc: r.email_lc, display_name: person.display, city: city.get(r.email_lc) || null,
            status: 'pending', query: scanQuery(person, city.get(r.email_lc) || null),
          };
        }));
        if (iErr) throw new Error(`could not queue customers: ${iErr.message || iErr}`);
        added += part.length;
      }
      need -= pick.length;
      if (rows.length < SCAN_PAGE) break;
    }
    return resumed.length + added;
  }

  async function runScan({ company, program, scanId, want, filters, minFollowers, callerId, started, authHeader = null, leg = 0, resume = null }) {
    const left = () => RUN_BUDGET_MS - (now().getTime() - started);
    // A continued scan keeps counting from where the previous leg stopped.
    const r0 = resume || {};
    const t = { checked: +r0.checked || 0, found: +r0.found || 0, below: +r0.below || 0, no_count: +r0.no_count || 0,
      ambiguous: +r0.ambiguous || 0, none: +r0.not_found || 0, error: +r0.failed || 0 };
    const costBefore = Number(r0.cost_usd) || 0;
    let cost = 0; let usages = []; let aiDecided = 0;
    // Rows the model actually answered for (whatever it said), so a run that
    // ran out of time before asking can hand them to one more run.
    const asked = new Set();
    // DataForSEO answers a search Google has nothing for with task error
    // 40102 "No Search Results". That is an answer -- no account -- not a
    // failure: on 2026-11-24 it was most of the "failed" rows.
    const searchOrEmpty = async (task) => {
      try { return await search(task); } catch (err) {
        if (err?.code === 40102) return { items: [], cost: null };
        throw err;
      }
    };
    const meter = createCreditMeter({ db: service, requestId: newId(), companyId: company, userId: callerId, feature: 'affiliate_research', model, sourceRef: scanId });
    let meterOpen = null;
    // The scan row's counters. Column names differ from two statuses ('none'
    // and 'error' read badly as columns, and the row has its own error text).
    const counts = () => ({ checked: t.checked, found: t.found, below: t.below, no_count: t.no_count, ambiguous: t.ambiguous, not_found: t.none, failed: t.error });
    // Builders are thenables, not Promises: wrap so .catch() exists.
    const beat = (patch = {}) => Promise.resolve(service.from('affiliate_customer_scans').update({ ...counts(), heartbeat_at: now().toISOString(), ...patch })
      .eq('id', scanId).eq('company_entity_id', company));
    const write = (id, patch) => service.from('affiliate_customer_social').update(patch).eq('id', id).eq('company_entity_id', company);

    // The model, for searches that showed two or more profiles carrying the
    // name. Fail-soft: no key, no credit or an error leaves them 'ambiguous'
    // with their candidates listed, never 'none'.
    async function decide(batch) {
      if (!apiKey || !batch.length) return;
      const request = buildAiRequest({ rows: batch, model });
      if (meterOpen === null) meterOpen = (await meter.open({ estInput: estimateInputTokens(request), maxOutput: AI_MAX_OUTPUT_TOKENS, calls: 1 }).catch(() => ({ ok: false }))).ok === true;
      else if (meterOpen) meterOpen = (await meter.step({ usage: addUsage(usages.map(usageFromResponse)), estInput: estimateInputTokens(request), maxOutput: AI_MAX_OUTPUT_TOKENS }).catch(() => ({ ok: false }))).ok !== false;
      if (!meterOpen || left() < 10_000) return;
      let answer;
      try {
        const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
          method: 'POST', signal: AbortSignal.timeout(Math.max(5_000, left() - 5_000)),
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(request),
        });
        if (!res.ok) {
          // Logged, never shown: a failing model call left every ambiguous
          // search unjudged on the first pilot and nothing said why.
          const why = await res.text().catch(() => '');
          console.warn(`customer_scan: model call failed ${res.status} ${why.slice(0, 300)}`);
          return;
        }
        answer = await res.json();
      } catch (err) { console.warn(`customer_scan: model call threw ${String(err?.message || err).slice(0, 200)}`); return; }
      usages.push(answer?.usage || {});
      for (const b of batch) asked.add(b.id);
      const at = now().toISOString();
      for (const o of applyAiAnswer({ rows: batch, answer, minFollowers })) {
        if (o.status === 'ambiguous') continue;
        const row = batch.find((b) => b.key === o.key);
        await write(row.id, socialRowPatch({ status: o.status, pick: o.pick, candidates: row.candidates, decidedBy: 'ai', query: row.query, checkedAt: at,
          basis: o.pick ? matchBasis({ pick: o.pick, person: row.person, email: row.email, city: row.city }) : null }));
        // A row carried over from an earlier scan was never counted in this
        // one, so this scan's counters are left alone.
        if (!row.carried) { t.ambiguous -= 1; t[o.status] += 1; }
        aiDecided += 1;
      }
    }

    let status = 'done'; let error = null; let aiOwed = false;
    try {
      const guards = await scanGuards(company);
      // A continued leg finishes the queue the first leg wrote; it never
      // queues more.
      const queued = resume ? (+r0.requested || 0) : await queueScan({ company, program, scanId, want, filters, guards });
      if (!resume) await beat({ requested: queued });
      const { data: todo, error: tErr } = await service.from('affiliate_customer_social')
        .select('id, customer_key, email_lc, display_name, city, query').eq('company_entity_id', company)
        .eq('scan_id', scanId).eq('status', 'pending').order('created_at', { ascending: true }).limit(Math.max(1, queued));
      if (tErr) throw new Error(`could not read the queue: ${tErr.message || tErr}`);
      const ambiguous = [];
      const triedHere = new Set();
      let next = 0; let sinceBeat = 0;
      const worker = async () => {
        while (next < (todo || []).length) {
          if (left() < SCAN_TAIL_MS) { status = 'stopped'; return; }
          const row = todo[next++];
          const person = personName(row.display_name);
          if (!person) { await write(row.id, { status: 'none', checked_at: now().toISOString(), decided_by: 'search' }); t.checked += 1; t.none += 1; continue; }
          try {
            const res = await searchOrEmpty(buildScanTask(person, row.city, program));
            if (Number.isFinite(Number(res?.cost))) cost += Number(res.cost);
            let j = judgeResults({ items: res?.items || [], person, program, minFollowers, collectedAt: now().toISOString() });
            let basis = j.pick ? matchBasis({ pick: j.pick, person, email: row.email_lc, city: row.city }) : null;
            // The email username, as one more search, only when the name
            // search did not settle it (nothing, or several namesakes): a
            // second paid search on every customer roughly doubled the cost
            // for little gain (Blake, 2026-11-24). A profile whose handle IS
            // that username wins: it is the strongest signal there is, and it
            // settles an ambiguous name search without asking the model.
            const eh = (j.status === 'none' || j.status === 'ambiguous') ? emailHandle(row.email_lc, person) : null;
            if (eh && left() > SCAN_TAIL_MS) {
              const hr = await searchOrEmpty(buildHandleTask(eh, program));
              if (Number.isFinite(Number(hr?.cost))) cost += Number(hr.cost);
              const h = judgeHandle({ items: hr?.items || [], handle: eh, program, minFollowers, collectedAt: now().toISOString() });
              if (h.pick) { j = { status: h.status, pick: h.pick, candidates: null }; basis = 'email_handle'; }
            }
            await write(row.id, socialRowPatch({ status: j.status, pick: j.pick, candidates: j.candidates, decidedBy: 'search', query: row.query, checkedAt: now().toISOString(), basis }));
            t[j.status] += 1;
            if (j.status === 'ambiguous') triedHere.add(row.id);
            if (j.status === 'ambiguous') ambiguous.push({ id: row.id, key: row.customer_key, name: person.display, city: row.city, query: row.query, candidates: j.candidates, person, email: row.email_lc });
          } catch (err) {
            // Logged without the customer: a run with a third of its searches
            // failing (2026-11-24) said nothing about why.
            console.warn(`customer_scan: search failed ${String(err?.message || err).slice(0, 200)}`);
            await write(row.id, { status: 'error', checked_at: now().toISOString() });
            t.error += 1;
          }
          t.checked += 1;
          if (++sinceBeat >= 10) { sinceBeat = 0; await beat(); }
          if (ambiguous.length >= AI_BATCH) await decide(ambiguous.splice(0, AI_BATCH));
        }
      };
      await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
      while (ambiguous.length) await decide(ambiguous.splice(0, AI_BATCH));
      // Searches an EARLIER scan left ambiguous (its model step failed, or
      // there was no time) are judged now from the profiles already stored:
      // no new search, so nothing is paid twice. Only with time to spare.
      // Once per press: after the queue is finished, so a continued scan
      // does not ask the model about the same rows on every leg.
      if (apiKey && status !== 'stopped' && left() > SCAN_TAIL_MS / 2) {
        const { data: old } = await service.from('affiliate_customer_social')
          .select('id, customer_key, email_lc, display_name, city, query, candidates').eq('company_entity_id', company)
          .eq('status', 'ambiguous').order('created_at', { ascending: true }).limit(CARRY_AMBIGUOUS + triedHere.size);
        // The same CURRENT consent, do-not-contact and team check as the
        // queue: somebody who opted out since their search ran is never sent
        // to the model, and their row is cleared like a dropped queue row.
        const fresh = (old || []).filter((r) => !triedHere.has(r.id)).slice(0, CARRY_AMBIGUOUS);
        const okNow = await recheck(company, fresh, guards);
        const gone = fresh.filter((r) => !okNow(r)).map((r) => r.id);
        for (const ids of chunks(gone)) {
          await service.from('affiliate_customer_social').delete().eq('company_entity_id', company).in('id', ids);
        }
        const carried = fresh.filter(okNow).map((r) => ({ ...r, person: personName(r.display_name) }))
          .filter((r) => r.person && Array.isArray(r.candidates) && r.candidates.length)
          .map((r) => ({ id: r.id, key: r.customer_key, name: r.person.display, city: r.city, query: r.query, candidates: r.candidates, person: r.person, email: r.email_lc, carried: true }));
        while (carried.length && left() > 15_000) await decide(carried.splice(0, AI_BATCH));
      }
      if (status !== 'stopped' && t.checked - (+r0.checked || 0) < (todo || []).length) status = 'stopped';
      // Searched this run, left ambiguous, and never put to the model because
      // the searches used the time (the 2026-11-24 pilot: 100 checked, 0
      // judged). One more run does only that, from the stored profiles. Not
      // when there is no key or the credit hold refused: another run could
      // not ask either.
      aiOwed = !!apiKey && meterOpen !== false && [...triedHere].some((id) => !asked.has(id));
    } catch (err) {
      status = 'error'; error = String(err?.message || err).slice(0, 500);
    } finally {
      await meter.settle({ usage: addUsage(usages.map(usageFromResponse)), outcome: aiDecided > 0 ? 'succeeded' : 'failed', error: aiDecided > 0 ? null : 'no_ai_decisions' }).catch(() => {});
      // Spend is recorded for SILO, never shown on the page (Blake, 2026-11-24:
      // a rep should not do arithmetic before pressing a button).
      const spent = Math.round((costBefore + cost) * 10000) / 10000;
      // Out of time with customers still queued: the same scan carries on in
      // a fresh run, and the page keeps showing it as running. Anything that
      // stops the handoff (no caller token, the leg cap, the next run refusing)
      // ends the scan as "stopped early", exactly as before.
      let handedOff = false;
      if ((status === 'stopped' || (status === 'done' && aiOwed)) && !error && selfInvoke && authHeader && leg + 1 < SCAN_MAX_LEGS) {
        try {
          const { count } = await service.from('affiliate_customer_social').select('id', { count: 'exact', head: true })
            .eq('company_entity_id', company).eq('scan_id', scanId).eq('status', 'pending');
          if (count > 0 || aiOwed) {
            const handoff = newId();
            await beat({ status: 'running', cost_usd: spent, filters: { ...filters, handoff } });
            const res = await selfInvoke(authHeader, { action: 'customer_scan', continue_scan: scanId, handoff, leg: leg + 1 });
            handedOff = !!res && res.status === 202;
            if (!handedOff) console.warn(`customer_scan: continuing refused ${res?.status ?? 'no response'}`);
          }
        } catch (err) { console.warn(`customer_scan: continuing failed ${String(err?.message || err).slice(0, 200)}`); }
      }
      if (!handedOff) {
        await beat({ status, filters, error_message: error ?? (status === 'stopped' ? 'Stopped early. More to check.' : null), finished_at: now().toISOString(), cost_usd: spent }).catch(() => {});
      }
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
    // Company level: no program to load or check.
    if (body?.action === 'customer_scan') return customerScan({ company, body, callerId: who?.user?.id ?? null, authHeader });
    const programId = String(body?.program_id || '');
    if (!UUID_RE.test(programId)) return reply({ error: 'Choose a program.' }, 400);

    // 2. The program, inside the caller's company only.
    const { data: program, error: pErr } = await service.from('affiliate_programs')
      .select('id, company_entity_id, name, niche, audience_notes, platforms, geographies, status')
      .eq('id', programId).eq('company_entity_id', company).maybeSingle();
    if (pErr) return reply({ error: 'Could not load the program.' }, 500);
    if (!program) return reply({ error: 'Program not found.' }, 404);

    if (body?.action === 'refresh_photos') return refreshPhotos({ company, program });
    if (body?.action === 'refresh_stats') return refreshStats({ company, program });
    if (body?.action === 'research') return research({ company, program, body, callerId: who?.user?.id ?? null });
    if (body?.action === 'import') return importRows({ company, program, body });
    return reply({ error: 'Unknown action.' }, 400);
  };
}
