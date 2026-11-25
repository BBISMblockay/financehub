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
import { timingSafeEqual } from 'node:crypto';
import { upsertCandidates, fetchSerpLive, buildSerpTask, candidatesFromResults, RETRYABLE_SERP_CODES } from './lib/affiliate-discovery-core.mjs';
import { storeProspectPhotos } from './lib/affiliate-photo-core.mjs';
import { enrichYouTubeProspects, needsYouTubeRefresh, buildCreatorProfile, channelRef, searchYouTubeChannels, refreshContentStats } from './lib/affiliate-youtube-core.mjs';
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
  clampFinds, FINDS_MAX, companyMaxChecks, createSerpQueue, QUEUE_POST_BATCH,
  scorePick, tallyBucket, companyTerms, termsInput, buildCountTask, judgeCount,
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
// Legs end on WORK, not only on time (production 2026-11-24, scan c005d734:
// a leg that collected ~370 queued searches in its last two minutes was
// killed for "CPU Time exceeded" (2,000 ms) before it could hand off, and the
// scan sat "running" with 909 searches in flight). Reading and judging a
// search result is the CPU cost, so a leg looks at no more than
// SCAN_LEG_GETS of them and then hands the same scan to a fresh run -- well
// under the limit at the ~5 ms each that leg measured. More legs per press as
// a result, so the cap on legs is higher.
export const SCAN_LEG_GETS = 150;
export const SCAN_MAX_LEGS = 150;
// The hunt's queue: customers in flight at once, collected this many at a
// time; a search is first looked for this long after it was posted (the
// provider answered in 106-139s when measured), looked for again every
// SCAN_POLL_MS, and counted as failed once it is SCAN_TASK_EXPIRY_MS old.
export const SCAN_MAX_INFLIGHT = 1000;
export const SCAN_GET_CONCURRENCY = 20;
export const SCAN_FIRST_LOOK_MS = 45_000;
export const SCAN_POLL_MS = 15_000;
export const SCAN_TASK_EXPIRY_MS = 45 * 60_000;
// ── Affiliate Studio spend (20261125040000) ────────────────────────────
// Every Google search Find and Discovery make is metered through the same
// credit RPCs as the AI, under the same feature ('affiliate_research'), so
// the company sees ONE Affiliate Studio line at its own price (Blake
// 2026-11-25: "one 'studio' bill"). The price of a search is the
// ai_provider_rates row for this model, set at rollout; none = unpriced.
export const SEARCH_RATE_MODEL = 'dataforseo-serp';
const STUDIO_LIMIT_NOTE = {
  month: "Stopped at this month's Affiliate Studio limit.",
  night: "Stopped at tonight's Affiliate Studio limit.",
  credit: 'Stopped: the workspace is out of credit for Affiliate Studio.',
};
/** Which limit this spend has reached, or null. Pure. */
export function studioLimitHit(spend, { nightly = false, nightMax = null } = {}) {
  if (!spend) return null;
  const cap = Number(spend.month_cap_micros);
  if (Number.isFinite(cap) && cap > 0 && Number(spend.month_micros) >= cap) return 'month';
  const night = Number(nightMax);
  if (nightly && Number.isFinite(night) && night > 0 && Number(spend.scan_micros) >= night) return 'night';
  return null;
}
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
  // The hunt's searches: DataForSEO's standard queue (lib createSerpQueue),
  // and how a run waits between looks at it. Tests pass fakes.
  serpQueue: queueIn = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  // The service-role key: the nightly job's Authorization (compared in
  // constant time). Unset = no nightly entry at all.
  nightlyKey = '', verifyServiceToken = async () => false,
}) {
  // This month's Studio spend for a company (and one scan's own), in
  // customer dollars, from the database. null when the migration is not
  // applied yet: then no limit applies, exactly as before it.
  async function studioSpend(company, scanId = null) {
    const { data, error } = await service.rpc('affiliate_studio_spend', { p_company: company, p_scan: scanId });
    if (error) return null;
    return data || null;
  }
  // Meter one batch of Google searches: open a hold for n, run them, settle
  // what was accepted. false = the hold was refused (out of credit, or a
  // search has no price where billing is enforced): nothing is searched.
  async function meteredSearches({ company, callerId, sourceRef, n, run }) {
    const m = createCreditMeter({ db: service, requestId: newId(), companyId: company, userId: callerId,
      feature: 'affiliate_research', model: SEARCH_RATE_MODEL, sourceRef });
    const opened = await m.open({ estInput: 0, maxOutput: 0, maxWeb: n, calls: 1 }).catch(() => ({ ok: false }));
    if (!opened?.ok) return false;
    let used = 0;
    try { used = await run(); } finally {
      await m.settle({ usage: { web_search: used }, outcome: used > 0 ? 'succeeded' : 'failed', error: used > 0 ? null : 'no_searches' }).catch(() => {});
    }
    return true;
  }
  const serpQueue = queueIn || (serpCredentials?.login && serpCredentials?.password ? createSerpQueue({ credentials: serpCredentials, fetchImpl }) : null);
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

  async function gatherLeads(program, focus, { google = true } = {}) {
    let searched = 0; let failed = 0; let youtube = 0;
    const yt = (async () => {
      try { const l = await youtubeLeads(program, focus); youtube = l.length; return l; }
      catch { failed += 1; return []; }
    })();
    const lists = await Promise.all([yt, ...(search && google ? leadSearches(program, focus) : []).map(async (src) => {
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

  // nightly = { max } when the schedule started it (nightlyDiscovery): it
  // stops at that dollar figure while it runs. A press has no nightly limit;
  // every run, nightly or pressed, stops at the monthly cap.
  async function research({ company, program, body, callerId, nightly = null }) {
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

    // The company's own monthly Affiliate Studio cap, over Find and Discovery.
    if (studioLimitHit(await studioSpend(company)) === 'month') {
      return reply({ error: "This month's Affiliate Studio limit is reached. A workspace owner can change it in Workspace Settings → Billing.", limit_reached: true }, 402);
    }
    const focus = String(body?.focus || '').trim().slice(0, 500);
    const runId = newId();
    const { data: row, error: rErr } = await service.from('affiliate_discovery_runs').insert({
      company_entity_id: company, program_id: program.id, source_id: null, run_id: runId, provider: RESEARCH_PROVIDER,
      query: focus || program.niche || 'AI research', started_at: now().toISOString(), status: 'running',
      ...(nightly ? { nightly: true } : {}),
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
    let limitHit = null;
    const work = (async () => {
      let usages = []; let outcome = 'failed';
      try {
        const known = await knownFor(company).catch(() => null);
        // The Google leads are Studio usage too: metered, and skipped (fewer
        // leads, never an error) when the hold is refused.
        let g = { leads: [], searched: 0, failed: 0, youtube: 0 };
        const n = search ? leadSearches(program, focus).length : 0;
        const ranMetered = n ? await meteredSearches({ company, callerId, sourceRef: row.id, n, run: async () => {
          g = await gatherLeads(program, focus).catch(() => ({ leads: [], searched: 0, failed: 1 }));
          return g.searched;
        } }) : false;
        if (!ranMetered) g = await gatherLeads(program, focus, { google: false }).catch(() => ({ leads: [], searched: 0, failed: 1 }));
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
          if (s.ok === false) return false;
          // The company's limits, against the usage just recorded: this run's
          // own spend so far (nightly), and the month's (every run). Reached =
          // no more investigating; the model writes up what it has.
          const hit = studioLimitHit(await studioSpend(company, nightly ? row.id : null), { nightly: !!nightly, nightMax: nightly?.max });
          if (hit) { limitHit = hit; return false; }
          return true;
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
        const limitNote = limitHit ? ` ${STUDIO_LIMIT_NOTE[limitHit]}` : '';
        await finishRun(row.id, {
          status: 'ok', results_returned: stats.returned, profiles_recognized: stats.kept,
          prospects_new: wrote.prospects_new, prospects_updated: wrote.prospects_updated,
          suppressed_skipped: wrote.suppressed_skipped, emails_found: stats.emails_kept,
          error: stats.minors || stats.unverified || stats.not_profile || stats.over_source || stats.topped_up || stats.known || stats.kept < wanted || g.leads.length
            ? `skipped: ${stats.minors} likely minors, ${stats.unverified} not found on a page read, ${stats.not_profile} not a profile link${stats.over_source ? `, ${stats.over_source} over the per-source limit` : ''}${stats.topped_up ? `, ${stats.topped_up} added from a list page to fill the run` : ''}${stats.known ? `, ${stats.known} already known` : ''}${stats.kept < wanted ? `; found ${stats.kept} of ${wanted}` : ''}${g.leads.length ? `; ${g.leads.length} ${g.youtube ? `leads checked (${g.youtube} from YouTube)` : 'Google leads checked'}` : ''}${lean ? ', shortlist mode' : ''}${limitNote}`
            : (limitNote.trim() || null),
        });
      } catch (err) {
        // Stopped by the company's own limit before anything was recorded:
        // say which limit, not a failure.
        await finishRun(row.id, limitHit ? { status: 'ok', error: STUDIO_LIMIT_NOTE[limitHit] }
          : { status: 'error', error: String(err?.message || err).slice(0, 500) }).catch(() => {});
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
  async function customerScan({ company, body, callerId, authHeader, nightly = false }) {
    if (!serpQueue) return reply({ error: 'Social lookups are not set up yet.' }, 503);
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
      background(runScan({ company, program: COMPANY_SCAN_SCOPE, scanId: id, want: clampFinds(filters.want), maxChecks: companyMaxChecks({ affiliate_customer_scan_max_checks: filters.max_checks }),
        filters, minFollowers: Number(row.min_followers) || 0,
        callerId, started: now().getTime(), authHeader, leg, resume: row }));
      return reply({ scan_id: id, continued: true }, 202);
    }
    // Every platform SILO reads profiles from, not one program's ticks: the
    // answer is about the customer, and it is the same in every program.
    const program = COMPANY_SCAN_SCOPE;
    // The company's own monthly Affiliate Studio cap, over Find and Discovery.
    const spend0 = await studioSpend(company);
    if (studioLimitHit(spend0) === 'month') {
      return reply({ error: "This month's Affiliate Studio limit is reached. A workspace owner can change it in Workspace Settings → Billing.", limit_reached: true }, 402);
    }
    // The nightly job's own press: its limits ride on the scan row, so every
    // leg stops at the same place.
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
    // How many FINDS the person asked for, and the company's cap on how many
    // customers one press may check to get them.
    const want = nightly ? FINDS_MAX : clampFinds(body?.finds);
    const maxChecks = nightly ? Math.max(1, Math.min(5000, Math.floor(Number(spend0?.night_max_customers)) || 300)) : companyMaxChecks(ent?.meta);
    // The company's niche words, for the niche signal in the match score:
    // company data, else its active programs' own niche text. Kept on the
    // scan row so every leg of the press scores the same way.
    // The page's "Niche words" box rides on the press: what was typed is
    // saved as the company's own words before this press uses them.
    let meta = ent?.meta && typeof ent.meta === 'object' ? ent.meta : {};
    if (typeof body?.terms === 'string' && !nightly) {
      const words = termsInput(body.terms);
      const had = Array.isArray(meta.affiliate_customer_scan_terms) ? meta.affiliate_customer_scan_terms : null;
      if (JSON.stringify(had || []) !== JSON.stringify(words)) {
        const next = { ...meta };
        if (words.length) next.affiliate_customer_scan_terms = words; else delete next.affiliate_customer_scan_terms;
        const { error: tErr } = await service.from('entities').update({ meta: next }).eq('id', company);
        if (tErr) return reply({ error: 'Could not save the niche words. Try again.' }, 500);
        meta = next;
      }
    }
    const { data: progs } = await service.from('affiliate_programs').select('niche, audience_notes')
      .eq('company_entity_id', company).eq('status', 'active').limit(50);
    const filters = { ...scanFilters(body?.filters), terms: companyTerms(meta, progs || []),
      ...(nightly ? { nightly: true, night_max_micros: Number(spend0?.night_max_micros) || 3_000_000 } : {}) };
    const startedAt = now();
    const { data: scan, error: sErr } = await service.from('affiliate_customer_scans').insert({
      company_entity_id: company, program_id: null, created_by: callerId, status: 'running',
      requested: 0, started_at: startedAt.toISOString(), heartbeat_at: startedAt.toISOString(), filters, min_followers: minFollowers,
    }).select('id').single();
    // The partial unique index refuses a second running scan: two presses at
    // the same instant join one scan rather than paying twice.
    if (sErr) return reply({ error: 'A scan is already running. Its results appear on this list.' }, 429);
    background(runScan({ company, program, scanId: scan.id, want, maxChecks, filters, minFollowers, callerId, started: startedAt.getTime(), authHeader }));
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
    // them, and somebody whose data has since been erased (or been added to
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
  // Returns { queued, cursor, exhausted }: cursor is the customer-list page
  // the next call starts from, so a long hunt never re-walks the top of the
  // list; exhausted means the slice has nobody left to check.
  async function queueScan({ company, program, scanId, want, filters, guards, cursor = 0 }) {
    const { suppressed, isTeam } = guards;
    const { data: left } = await service.from('affiliate_customer_social').select('id, customer_key, status')
      .eq('company_entity_id', company).in('status', ['pending', 'error']).neq('scan_id', scanId)
      .order('created_at', { ascending: true }).limit(want);
    const eligible = await recheck(company, left, guards);
    const dropped = (left || []).filter((r) => !eligible(r)).map((r) => r.id);
    for (const ids of chunks(dropped)) {
      await service.from('affiliate_customer_social').delete().eq('company_entity_id', company).in('id', ids);
    }
    const resumed = (left || []).filter(eligible).map((r) => r.id);
    // A queued row keeps any search a dead run already posted for it, which
    // this scan collects; a failed one is searched again.
    const failedIds = new Set((left || []).filter((r) => r.status === 'error').map((r) => r.id));
    for (const ids of chunks(resumed)) {
      await service.from('affiliate_customer_social').update({ scan_id: scanId, status: 'pending' })
        .eq('company_entity_id', company).in('id', ids);
      const retry = ids.filter((id) => failedIds.has(id));
      if (retry.length) await service.from('affiliate_customer_social').update({ serp_task_id: null, serp_task_kind: null, serp_posted_at: null })
        .eq('company_entity_id', company).in('id', retry);
    }
    let need = want - resumed.length;
    if (need <= 0) return { queued: resumed.length, cursor, exhausted: false };
    let added = 0; let page = cursor; let exhausted = false;
    for (; page < cursor + SCAN_MAX_PAGES && need > 0; page += 1) {
      let q = service.from('company_customer_profiles')
        .select('customer_key, email_lc, name_lc, first_name_lc, last_name_lc, order_count, last_order_at, lifetime_spend, email_consent_state')
        .eq('company_entity_id', company).gte('order_count', filters.minOrders)
        // An erased customer is never researched. NULL (not checked yet) IS
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
      if (!rows?.length) { exhausted = true; break; }
      let pick = rows.filter((r) => personName(r.name_lc, r.first_name_lc, r.last_name_lc) && !suppressed(r.email_lc) && !isTeam(r.email_lc));
      // Somebody this company already scanned -- under any program, or none
      // -- is not searched (or paid for) twice.
      const seen = new Set();
      for (const keys of chunks(pick.map((r) => r.customer_key))) {
        const { data: had } = await service.from('affiliate_customer_social').select('customer_key')
          .eq('company_entity_id', company).in('customer_key', keys);
        for (const h of had || []) seen.add(h.customer_key);
      }
      const fresh = pick.filter((r) => !seen.has(r.customer_key));
      pick = fresh.slice(0, need);
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
      // This page still has unchecked customers: the next call reads it again.
      if (fresh.length > pick.length) break;
      if (rows.length < SCAN_PAGE) { exhausted = true; page += 1; break; }
    }
    return { queued: resumed.length + added, cursor: page, exhausted };
  }

  // ── The hunt ──────────────────────────────────────────────────────────
  // "Find 25" means 25 people over the bar come back (Blake 2026-11-24: "if
  // silo user ask for 25 or 500 that's what they should receive not a partial
  // or trimmed list"). A press keeps checking customers, best first, in waves
  // sized from the hit rate so far, until that many are found, the slice runs
  // out, or the company's cap on customers checked per press is reached. The
  // scan row's filters.end says which ('goal' | 'pool' | 'cap').
  //
  // Searches go through DataForSEO's standard queue (about a third of the
  // live price, up to 100 per request), so one run can have hundreds in
  // flight. A search's task id is written on its row BEFORE anything is
  // collected: the next run of the same scan collects what this one posted,
  // and never posts (or pays for) it twice.
  async function runScan({ company, program, scanId, want, maxChecks, filters, minFollowers, callerId, started, authHeader = null, leg = 0, resume = null }) {
    const left = () => RUN_BUDGET_MS - (now().getTime() - started);
    // A continued scan keeps counting from where the previous leg stopped.
    const r0 = resume || {};
    // 'check': over the bar, but the score is under LIKELY_SCORE. Never
    // counted as found; kept on the scan row's filters (to_check), so the
    // page needs no new column to read it.
    const t = { checked: +r0.checked || 0, found: +r0.found || 0, below: +r0.below || 0, no_count: +r0.no_count || 0,
      ambiguous: +r0.ambiguous || 0, none: +r0.not_found || 0, error: +r0.failed || 0, check: +r0.filters?.to_check || 0 };
    const terms = Array.isArray(filters.terms) ? filters.terms : [];
    let requested = +r0.requested || 0;
    const st = { cursor: Math.max(0, Math.floor(Number(filters.cursor)) || 0), poolDone: filters.pool_done === true };
    const costBefore = Number(r0.cost_usd) || 0;
    let cost = 0; let usages = []; let aiDecided = 0;
    // Rows the model answered for this run (whatever it said).
    const asked = new Set();
    const meter = createCreditMeter({ db: service, requestId: newId(), companyId: company, userId: callerId, feature: 'affiliate_research', model, sourceRef: scanId });
    let meterOpen = null;
    // The scan row's counters. Column names differ from two statuses ('none'
    // and 'error' read badly as columns, and the row has its own error text).
    const counts = () => ({ requested, checked: t.checked, found: t.found, below: t.below, no_count: t.no_count, ambiguous: t.ambiguous, not_found: t.none, failed: t.error });
    const state = () => ({ ...filters, want, max_checks: maxChecks, cursor: st.cursor, pool_done: st.poolDone, to_check: t.check });
    // Builders are thenables, not Promises: wrap so .catch() exists.
    const beat = (patch = {}) => Promise.resolve(service.from('affiliate_customer_scans').update({ ...counts(), heartbeat_at: now().toISOString(), filters: state(), ...patch })
      .eq('id', scanId).eq('company_entity_id', company));
    const write = (id, patch) => Promise.resolve(service.from('affiliate_customer_social').update(patch).eq('id', id).eq('company_entity_id', company));
    // A few at a time, so a wave of a thousand rows neither runs serially nor
    // all at once.
    const each = async (list, n, fn) => {
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) await fn(list[i++]); }));
    };

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
      const countAsk = [];
      for (const o of applyAiAnswer({ rows: batch, answer, minFollowers })) {
        const row = batch.find((b) => b.key === o.key);
        // Still unclear to the model: recorded as judged, so no later run
        // asks again about the same profiles.
        if (o.status === 'ambiguous') { await write(row.id, { decided_by: 'ai' }); continue; }
        const sp = o.pick ? scorePick({ pick: o.pick, person: row.person, email: row.email, city: row.city, terms, decidedBy: 'ai' }) : null;
        await write(row.id, socialRowPatch({ status: o.status, pick: o.pick, candidates: row.candidates, decidedBy: 'ai', query: row.query, checkedAt: at,
          basis: sp?.basis ?? null, score: sp?.score ?? null }));
        // A row carried over from an earlier scan was never counted in this
        // one, so this scan's counters are left alone.
        if (!row.carried) {
          t.ambiguous -= 1; t[tallyBucket(o.status, sp?.score)] += 1;
          const ct = o.status === 'no_count' ? buildCountTask(o.pick) : null;
          if (ct) countAsk.push({ row: { id: row.id }, kind: 'count', task: ct });
        }
        aiDecided += 1;
      }
      await post(countAsk);
    }
    const forModel = (r, carried = false) => {
      const person = personName(r.display_name);
      return person && Array.isArray(r.candidates) && r.candidates.length
        ? { id: r.id, key: r.customer_key, name: person.display, city: r.city, query: r.query, candidates: r.candidates, person, email: r.email_lc, carried }
        : null;
    };

    // The company's limits, checked before every batch of searches: this
    // month's cap over all Studio usage and, for the nightly run, tonight's
    // dollar limit for this scan. What is already in flight is collected (it
    // is paid for); nothing new is searched.
    let limitHit = null;
    const checkLimit = async () => {
      if (limitHit) return limitHit;
      limitHit = studioLimitHit(await studioSpend(company, scanId), { nightly: filters.nightly === true, nightMax: filters.night_max_micros });
      return limitHit;
    };

    // Post searches for rows, 100 per request. Each accepted task's id is on
    // its row before this returns.
    let postFailures = 0;
    async function post(list) {
      for (const part of chunks(list, QUEUE_POST_BATCH)) {
        if (left() < SCAN_TAIL_MS) return;
        if (await checkLimit()) return;
        let acks;
        // Metered as Affiliate Studio usage: a hold for this batch first.
        const metered = await meteredSearches({ company, callerId, sourceRef: scanId, n: part.length, run: async () => {
          try { acks = await serpQueue.post(part.map((x) => ({ task: x.task }))); postFailures = 0; } catch (err) {
            postFailures += 1;
            console.warn(`customer_scan: posting searches failed ${String(err?.message || err).slice(0, 200)}`);
            return 0;
          }
          return (acks || []).filter((a) => a?.id).length;
        } });
        if (!metered) { limitHit = 'credit'; return; }
        if (!acks) return;
        const at = now().toISOString();
        await each(part.map((x, i) => ({ x, a: acks[i] })), 10, async ({ x, a }) => {
          cost += Number(a?.cost) || 0;
          if (a?.id) { await write(x.row.id, { serp_task_id: a.id, serp_task_kind: x.kind, serp_posted_at: at }); return; }
          console.warn(`customer_scan: search refused ${a?.code ?? '?'}`);
          // A refused name search is a failed check, kept to retry; a refused
          // username search leaves the name search's answer as it is.
          if (x.kind === 'name') { await write(x.row.id, { status: 'error', checked_at: at }); t.checked += 1; t.error += 1; }
        });
      }
    }

    // Collect what the queue has answered.
    async function collect(rows) {
      const handles = [];
      await each(rows, SCAN_GET_CONCURRENCY, async (r) => {
        if (left() < SCAN_TAIL_MS / 2 || gets >= SCAN_LEG_GETS) return;
        // Counted before the call, so concurrent workers respect the cap.
        gets += 1;
        let res;
        try { res = await serpQueue.get(r.serp_task_id); } catch (err) {
          console.warn(`customer_scan: collecting a search failed ${String(err?.message || err).slice(0, 200)}`);
          return;
        }
        const at = now().toISOString();
        const stale = now().getTime() - Date.parse(r.serp_posted_at) > SCAN_TASK_EXPIRY_MS;
        if (res.state === 'pending' && !stale) return;
        const clear = { serp_task_id: null, serp_task_kind: null, serp_posted_at: null };
        const person = personName(r.display_name);
        if (r.serp_task_kind === 'count') {
          // The follower count for a profile matched without one. Read only
          // from that profile's own result; nothing found leaves it as it was.
          const pick = { platform: r.platform, handle: r.handle, profile_url: r.profile_url };
          const got = res.state === 'ready' && r.status === 'no_count' && r.profile_url ? judgeCount({ items: res.items || [], pick, collectedAt: at }) : null;
          if (got && person) {
            const status = got.followers >= minFollowers ? 'found' : 'below';
            const shown = (Array.isArray(r.candidates) ? r.candidates : []).find((c) => c?.profile_url === r.profile_url) || {};
            const sp = scorePick({ pick: { ...shown, ...pick, followers: got.followers }, person, email: r.email_lc, city: r.city, terms,
              decidedBy: r.decided_by === 'ai' ? 'ai' : 'search', also: r.match_basis === 'email_handle' ? ['email_handle'] : [] });
            await write(r.id, { status, followers: got.followers, followers_approx: got.followers_approx, followers_quote: got.followers_quote,
              source_url: got.source_url, match_basis: sp.basis, match_score: sp.score, checked_at: at, ...clear });
            t.no_count -= 1; t[tallyBucket(status, sp.score)] += 1;
          } else await write(r.id, clear);
          return;
        }
        if (r.serp_task_kind === 'handle') {
          const eh = person ? emailHandle(r.email_lc, person) : null;
          const h = res.state === 'ready' && eh ? judgeHandle({ items: res.items || [], handle: eh, program, minFollowers, collectedAt: at }) : null;
          if (h?.pick) {
            // The profile whose handle IS their email username: it settles
            // the name search, whatever it said.
            const sp = scorePick({ pick: h.pick, person, email: r.email_lc, city: r.city, terms, also: ['email_handle'] });
            await write(r.id, { ...socialRowPatch({ status: h.status, pick: h.pick, candidates: null, decidedBy: 'search', query: r.query, checkedAt: at, basis: 'email_handle', score: sp.score }), ...clear });
            t[r.status] -= 1; t[tallyBucket(h.status, sp.score)] += 1;
            const ct = h.status === 'no_count' ? buildCountTask(h.pick) : null;
            if (ct) handles.push({ row: { id: r.id }, kind: 'count', task: ct });
          } else await write(r.id, clear);
          return;
        }
        // A provider fault (40101 and the like, ~1 in 5 checks on
        // 2026-11-24) is searched once more in this press. A pending row's
        // checked_at marks that it already had its retry: it is null until a
        // row is first answered, and a failed row resumed by a later press
        // keeps its own.
        if (res.state === 'error' && RETRYABLE_SERP_CODES.has(res.code) && person && r.status === 'pending' && !r.checked_at) {
          await write(r.id, { checked_at: at, ...clear });
          return;
        }
        if (res.state !== 'ready' || !person) {
          console.warn(`customer_scan: search failed ${res.state === 'pending' ? 'never answered' : `code ${res.code ?? '?'}`}`);
          await write(r.id, { status: 'error', checked_at: at, ...clear });
          t.checked += 1; t.error += 1;
          return;
        }
        const j = judgeResults({ items: res.items || [], person, program, minFollowers, collectedAt: at });
        const sp = j.pick ? scorePick({ pick: j.pick, person, email: r.email_lc, city: r.city, terms }) : null;
        const basis = sp?.basis ?? null;
        await write(r.id, { ...socialRowPatch({ status: j.status, pick: j.pick, candidates: j.candidates, decidedBy: 'search', query: r.query, checkedAt: at, basis, score: sp?.score ?? null }), ...clear });
        t.checked += 1; t[tallyBucket(j.status, sp?.score)] += 1;
        // A profile matched with no count stated: one search for its own
        // handle, which usually states it.
        const ct = j.status === 'no_count' ? buildCountTask(j.pick) : null;
        if (ct) handles.push({ row: { id: r.id }, kind: 'count', task: ct });
        // The email username, as one more search, only when the name
        // search did not settle it (nothing, or several namesakes): a
        // second paid search on every customer roughly doubled the cost
        // for little gain (Blake, 2026-11-24). A profile whose handle IS
        // that username wins: it is the strongest signal there is, and it
        // settles an ambiguous name search without asking the model.
        const eh = (j.status === 'none' || j.status === 'ambiguous') ? emailHandle(r.email_lc, person) : null;
        if (eh) handles.push({ row: { ...r, status: j.status }, kind: 'handle', task: buildHandleTask(eh, program) });
      });
      await post(handles);
    }

    let status = 'done'; let error = null; let aiOwed = false; let complete = false;
    // Search results looked at in this leg (see SCAN_LEG_GETS).
    let gets = 0;
    try {
      const guards = await scanGuards(company);
      const goalMet = () => t.found >= want || !!limitHit;
      const capLeft = () => Math.max(0, maxChecks - requested);
      // How many more customers to line up: enough, at the hit rate so far
      // (1 in 100 until there is a measured rate), to reach the goal.
      const wave = () => {
        const rate = t.checked >= 200 ? Math.max(t.found / t.checked, 0.003) : 0.01;
        return Math.max(QUEUE_POST_BATCH, Math.min(SCAN_MAX_INFLIGHT, Math.ceil(((want - t.found) / rate) * 1.25)));
      };
      const readScanRows = async (cols, extra) => {
        let q = service.from('affiliate_customer_social').select(cols).eq('company_entity_id', company).eq('scan_id', scanId);
        q = extra(q);
        const { data, error: e } = await q;
        if (e) throw new Error(`could not read the scan: ${e.message || e}`);
        return data || [];
      };
      const ROW_COLS = 'id, customer_key, email_lc, display_name, city, query, status, checked_at, decided_by, candidates, platform, handle, profile_url, match_basis, serp_task_id, serp_task_kind, serp_posted_at';
      while (left() > SCAN_TAIL_MS) {
        let inflight = await readScanRows(ROW_COLS, (q) => q.not('serp_task_id', 'is', null).limit(SCAN_MAX_INFLIGHT * 2));
        let waiting = await readScanRows(ROW_COLS, (q) => q.eq('status', 'pending').is('serp_task_id', null).order('created_at', { ascending: true }).limit(SCAN_MAX_INFLIGHT));
        if (goalMet()) {
          // Enough found: customers lined up but never searched go back to
          // the pool, unpaid, for a later press.
          const ids = waiting.map((r) => r.id);
          for (const part of chunks(ids)) await service.from('affiliate_customer_social').delete().eq('company_entity_id', company).in('id', part);
          requested -= ids.length; waiting = [];
        } else {
          const room = SCAN_MAX_INFLIGHT - inflight.length - waiting.length;
          if (room >= QUEUE_POST_BATCH && !st.poolDone && capLeft() > 0) {
            const q = await queueScan({ company, program, scanId, want: Math.min(room, capLeft(), wave()), filters, guards, cursor: st.cursor });
            requested += q.queued; st.cursor = q.cursor; if (q.exhausted) st.poolDone = true;
            await beat();
            if (q.queued) waiting = await readScanRows(ROW_COLS, (qq) => qq.eq('status', 'pending').is('serp_task_id', null).order('created_at', { ascending: true }).limit(SCAN_MAX_INFLIGHT));
          }
          await post(waiting.filter((r) => personName(r.display_name)).map((r) => ({ row: r, kind: 'name', task: buildScanTask(personName(r.display_name), r.city, program) })));
          // Nothing a search can use: answered without one.
          for (const r of waiting.filter((x) => !personName(x.display_name))) {
            await write(r.id, { status: 'none', checked_at: now().toISOString(), decided_by: 'search' }); t.checked += 1; t.none += 1;
          }
          if (postFailures >= 3) throw new Error('the search provider refused three times in a row');
        }
        // Collect what has had time to come back.
        inflight = await readScanRows(ROW_COLS, (q) => q.not('serp_task_id', 'is', null).limit(SCAN_MAX_INFLIGHT * 2));
        const due = inflight.filter((r) => now().getTime() - Date.parse(r.serp_posted_at) >= SCAN_FIRST_LOOK_MS);
        await collect(due);
        // The model, on settled ambiguous searches, a batch at a time.
        const unclear = (await readScanRows(ROW_COLS, (q) => q.eq('status', 'ambiguous').eq('decided_by', 'search').is('serp_task_id', null).limit(AI_BATCH * 10)))
          .filter((r) => !asked.has(r.id)).map((r) => forModel(r)).filter(Boolean);
        const open = await readScanRows('id', (q) => q.or('serp_task_id.not.is.null,status.eq.pending').limit(1));
        const more = !goalMet() && !st.poolDone && capLeft() > 0;
        while (unclear.length >= AI_BATCH || (unclear.length && !open.length && !more)) {
          if (left() < SCAN_TAIL_MS / 2) break;
          await decide(unclear.splice(0, AI_BATCH));
          if (!meterOpen) break;
        }
        await beat();
        if (!open.length && !more) { complete = true; break; }
        // This leg has done its share of work: the next leg carries on.
        if (gets >= SCAN_LEG_GETS) break;
        // The queue answers in a minute or two: wait, then look again.
        await sleep(Math.max(0, Math.min(SCAN_POLL_MS, left() - SCAN_TAIL_MS)));
      }
      if (complete) {
        // Searches an EARLIER scan left ambiguous (its model step failed, or
        // there was no time) are judged now from the profiles already stored:
        // no new search, so nothing is paid twice. Once per press, after the
        // hunt itself is finished.
        if (apiKey && left() > SCAN_TAIL_MS / 2) {
          const { data: old } = await service.from('affiliate_customer_social')
            .select('id, customer_key, email_lc, display_name, city, query, candidates').eq('company_entity_id', company)
            .eq('status', 'ambiguous').eq('decided_by', 'search').order('created_at', { ascending: true }).limit(CARRY_AMBIGUOUS + asked.size);
          // The same CURRENT consent, do-not-contact and team check as the
          // queue: somebody who opted out since their search ran is never sent
          // to the model, and their row is cleared like a dropped queue row.
          const fresh = (old || []).filter((r) => !asked.has(r.id)).slice(0, CARRY_AMBIGUOUS);
          const okNow = await recheck(company, fresh, guards);
          const gone = fresh.filter((r) => !okNow(r)).map((r) => r.id);
          for (const ids of chunks(gone)) {
            await service.from('affiliate_customer_social').delete().eq('company_entity_id', company).in('id', ids);
          }
          const carried = fresh.filter(okNow).map((r) => forModel(r, true)).filter(Boolean);
          while (carried.length && left() > 15_000) await decide(carried.splice(0, AI_BATCH));
        }
        // This scan's own ambiguous searches the model has not answered (the
        // run ran out of time before asking): one more run does only that.
        // Not when there is no key or the credit hold refused.
        const owed = await readScanRows('id', (q) => q.eq('status', 'ambiguous').eq('decided_by', 'search').limit(500));
        aiOwed = !!apiKey && meterOpen !== false && owed.some((r) => !asked.has(r.id));
      } else status = 'stopped';
    } catch (err) {
      status = 'error'; error = String(err?.message || err).slice(0, 500);
    } finally {
      await meter.settle({ usage: addUsage(usages.map(usageFromResponse)), outcome: aiDecided > 0 ? 'succeeded' : 'failed', error: aiDecided > 0 ? null : 'no_ai_decisions' }).catch(() => {});
      // Spend is recorded for SILO, never shown on the page (Blake, 2026-11-24:
      // a rep should not do arithmetic before pressing a button).
      const spent = Math.round((costBefore + cost) * 10000) / 10000;
      const end = complete ? (limitHit ? 'limit' : t.found >= want ? 'goal' : st.poolDone ? 'pool' : 'cap') : null;
      // Not finished: the same scan carries on in a fresh run, and the page
      // keeps showing it as running. Anything that stops the handoff (no
      // caller token, the run cap, the next run refusing) ends the scan as
      // "stopped early", exactly as before.
      let handedOff = false;
      if ((status === 'stopped' || (status === 'done' && aiOwed)) && !error && selfInvoke && authHeader && leg + 1 < SCAN_MAX_LEGS) {
        try {
          const handoff = newId();
          await beat({ status: 'running', cost_usd: spent, filters: { ...state(), handoff } });
          const res = await selfInvoke(authHeader, { action: 'customer_scan', continue_scan: scanId, handoff, leg: leg + 1 });
          handedOff = !!res && res.status === 202;
          if (!handedOff) console.warn(`customer_scan: continuing refused ${res?.status ?? 'no response'}`);
        } catch (err) { console.warn(`customer_scan: continuing failed ${String(err?.message || err).slice(0, 200)}`); }
      }
      if (!handedOff) {
        await beat({ status, filters: { ...state(), end, ...(limitHit ? { limit: limitHit } : {}) },
          error_message: error ?? (limitHit ? STUDIO_LIMIT_NOTE[limitHit] : status === 'stopped' ? 'Stopped early. More to check.' : null), finished_at: now().toISOString(), cost_usd: spent }).catch(() => {});
      }
    }
  }

  // The nightly Find (scripts/affiliate-nightly-find.mjs): the scheduled job
  // calls with the service-role key, ONE company per call, and only a company
  // whose own setting is on. Its scan continues in fresh runs with the same
  // key. A person's token never reaches this path, and this path never takes
  // a person's press.
  async function nightly({ body, authHeader }) {
    if (body?.continue_scan !== undefined) {
      const id = String(body.continue_scan || '');
      if (!UUID_RE.test(id)) return reply({ error: 'Unknown scan.' }, 400);
      const { data: row } = await service.from('affiliate_customer_scans').select('company_entity_id, filters').eq('id', id).maybeSingle();
      if (!row || row.filters?.nightly !== true) return reply({ error: 'This scan is not waiting to continue.' }, 409);
      return customerScan({ company: row.company_entity_id, body, callerId: null, authHeader, nightly: true });
    }
    const company = String(body?.company || '');
    if (!UUID_RE.test(company)) return reply({ error: 'Name the company.' }, 400);
    const spend = await studioSpend(company);
    if (!spend) return reply({ error: 'Affiliate Studio limits need a database update first.' }, 503);
    if (spend.nightly_enabled !== true) return reply({ skipped: 'off' });
    // The top unchecked customers: repeat buyers, most orders first, then
    // spend and the newest order (SCAN_SORTS.orders). Nobody is searched
    // twice; the usual never-scan rules apply.
    return customerScan({ company, body: { filters: { sort: 'orders', minOrders: 2, consent: 'any' } }, callerId: null, authHeader, nightly: true });
  }
  // The nightly Discovery: ONE company per call, only when its own setting is
  // on, and modest by design (Blake: "modest amount if nightly ... bigger on
  // demand"): its own creators-per-night and dollars-per-night, one program a
  // night, the one researched longest ago (nightly), so every active program
  // takes its turn. A program already researching is left alone (429).
  async function nightlyDiscovery({ body }) {
    const company = String(body?.company || '');
    if (!UUID_RE.test(company)) return reply({ error: 'Name the company.' }, 400);
    const spend = await studioSpend(company);
    if (!spend) return reply({ error: 'Affiliate Studio limits need a database update first.' }, 503);
    if (spend.discovery_nightly_enabled !== true) return reply({ skipped: 'off' });
    if (studioLimitHit(spend) === 'month') {
      return reply({ error: "This month's Affiliate Studio limit is reached.", limit_reached: true }, 402);
    }
    const { data: programs, error: pErr } = await service.from('affiliate_programs')
      .select('id, company_entity_id, name, niche, audience_notes, platforms, geographies, status')
      .eq('company_entity_id', company).eq('status', 'active').order('created_at', { ascending: true }).limit(200);
    if (pErr) return reply({ error: 'Could not load the programs.' }, 500);
    if (!programs?.length) return reply({ skipped: 'no_active_program' });
    const { data: past } = await service.from('affiliate_discovery_runs').select('program_id, started_at')
      .eq('company_entity_id', company).eq('nightly', true).order('started_at', { ascending: false }).limit(500);
    const lastAt = new Map();
    for (const r of past || []) if (!lastAt.has(r.program_id)) lastAt.set(r.program_id, new Date(r.started_at).getTime());
    const program = [...programs].sort((a, b) => (lastAt.get(a.id) ?? 0) - (lastAt.get(b.id) ?? 0))[0];
    return research({ company, program, body: { count: Number(spend.discovery_night_creators) || 10 }, callerId: null,
      nightly: { max: Number(spend.discovery_night_max_micros) || 1000000 } });
  }
  const claimedRole = (token) => {
    try {
      const part = token.split('.')[1]; if (!part) return null;
      return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='))).role ?? null;
    } catch { return null; }
  };
  // Exactly the service key, or (the platform's injected key is not always
  // byte-identical to the one the job holds -- on-deck-prepare, 2026-09-29) a
  // token claiming service_role that the auth server's admin API accepts.
  async function isService(authHeader) {
    if (!nightlyKey) return false;
    const enc = new TextEncoder();
    const a = enc.encode(authHeader); const b = enc.encode(`Bearer ${nightlyKey}`);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    return claimedRole(token) === 'service_role' && await verifyServiceToken(token).catch(() => false) === true;
  }

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);
    const authHeader = req.headers.get('Authorization') || '';
    if (!/^Bearer\s+\S+/.test(authHeader)) return reply({ error: 'Unauthorized' }, 401);
    if (await isService(authHeader)) {
      let nb;
      try { nb = await req.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
      if (nb?.action === 'nightly_scan' || (nb?.action === 'customer_scan' && nb?.continue_scan !== undefined)) return nightly({ body: nb, authHeader });
      if (nb?.action === 'nightly_discovery') return nightlyDiscovery({ body: nb });
      return reply({ error: 'Unknown action.' }, 400);
    }

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
    // Numbers for the YouTube posts affiliates linked (20261125230000): the
    // video's own public counts from the official API, for this company's
    // posts only. Nothing here costs money (API quota only).
    if (body?.action === 'content_stats') {
      if (!youtubeKey) return reply({ checked: 0, updated: 0, unavailable: true });
      return reply(await refreshContentStats({ service, company, apiKey: youtubeKey, fetchImpl: youtubeFetch, now }));
    }
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
