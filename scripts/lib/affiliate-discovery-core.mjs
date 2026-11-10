// scripts/lib/affiliate-discovery-core.mjs -- Affiliate Studio's native
// prospect discovery.
//
// WHAT IT DOES. For every enabled `serp_query` source on an active program,
// run the operator's own search query through the SERP provider SILO already
// pays for (DataForSEO, the SEO module's vendor), keep only results that are
// recognisably a creator's PROFILE on a known platform, score each one with a
// stated basis, and upsert it as a prospect with the URL and time it was read.
//
// WHAT IT DOES NOT DO -- each is a deliberate limit, documented in
// docs/ops/affiliate-studio.md:
//   * It fetches no creator page. Everything stored came back in the search
//     result itself (URL, title, snippet, rank). Fetching third-party pages
//     would need the page-inspect SSRF discipline and raises terms-of-service
//     questions per platform; neither is in scope for this release.
//   * It reports no follower count, engagement rate or audience demographic.
//     A search result does not carry those, and SILO will not estimate them.
//   * It stores an email only when one appears LITERALLY in the result
//     snippet, with the result URL as its source. Nothing is pattern-guessed.
//   * It never changes a prospect a human has reviewed: status, review notes
//     and an existing contact are left alone; only evidence is refreshed.
//   * It never contacts anyone.
//
// The scoring is additive and printed in full on every row (confidence_basis)
// so the number can be argued with. It measures FIT TO THE QUERY, not quality
// of the creator.

export const PROVIDER = 'dataforseo';
export const DATAFORSEO_BASE = 'https://api.dataforseo.com';

const RESERVED = {
  instagram: new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'tv', 'about', 'developer', 'legal', 'directory', 'web']),
  twitch: new Set(['directory', 'videos', 'p', 'settings', 'downloads', 'jobs', 'search', 'subscriptions']),
  x: new Set(['home', 'search', 'i', 'intent', 'share', 'hashtag', 'explore', 'settings', 'login', 'signup', 'tos', 'privacy']),
  pinterest: new Set(['pin', 'ideas', 'search', 'today', 'business', 'categories', '_']),
};

// Sites that dominate creator searches and are not a creator's own site. Only
// consulted for the `web`/`blog` lane, which is off unless a program opts in.
const NOT_A_CREATOR_SITE = [
  'amazon.', 'wikipedia.org', 'reddit.com', 'facebook.com', 'linkedin.com', 'quora.com',
  'ebay.', 'walmart.com', 'target.com', 'etsy.com', 'yelp.com', 'tripadvisor.',
  'google.', 'apple.com', 'spotify.com', 'imdb.com', 'nytimes.com', 'forbes.com',
];

const STOPWORDS = new Set(['with', 'that', 'this', 'from', 'their', 'they', 'have', 'about', 'your',
  'into', 'over', 'more', 'most', 'like', 'who', 'what', 'when', 'where', 'which', 'people', 'fans', 'and', 'the', 'for']);

function cleanHandle(h) {
  const v = String(h || '').trim().replace(/^@/, '');
  return /^[A-Za-z0-9._-]{2,64}$/.test(v) ? v : null;
}

/**
 * A search result URL -> the creator profile it belongs to, or null.
 *
 * Conservative on purpose: a URL whose owner cannot be read from the URL
 * itself (a YouTube /watch link, an Instagram /p/ post) is NOT a profile, and
 * guessing the channel behind it would mean fetching the page.
 */
export function classifyProfileUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, '');
  const seg = u.pathname.split('/').filter(Boolean);

  if (host === 'instagram.com') {
    const h = cleanHandle(seg[0]);
    if (!h || RESERVED.instagram.has(h.toLowerCase())) return null;
    return { platform: 'instagram', handle: `@${h}`, profile_url: `https://www.instagram.com/${h}` };
  }
  if (host === 'tiktok.com') {
    if (!seg[0]?.startsWith('@')) return null;
    const h = cleanHandle(seg[0]);
    if (!h) return null;
    return { platform: 'tiktok', handle: `@${h}`, profile_url: `https://www.tiktok.com/@${h}` };
  }
  if (host === 'youtube.com') {
    if (seg[0]?.startsWith('@')) {
      const h = cleanHandle(seg[0]);
      return h ? { platform: 'youtube', handle: `@${h}`, profile_url: `https://www.youtube.com/@${h}` } : null;
    }
    if (['c', 'user', 'channel'].includes(seg[0]) && seg[1]) {
      const h = cleanHandle(seg[1]);
      return h ? { platform: 'youtube', handle: h, profile_url: `https://www.youtube.com/${seg[0]}/${h}` } : null;
    }
    return null;
  }
  if (host === 'twitch.tv') {
    const h = cleanHandle(seg[0]);
    if (!h || RESERVED.twitch.has(h.toLowerCase())) return null;
    return { platform: 'twitch', handle: h, profile_url: `https://www.twitch.tv/${h.toLowerCase()}` };
  }
  if (host === 'x.com' || host === 'twitter.com') {
    const h = cleanHandle(seg[0]);
    if (!h || RESERVED.x.has(h.toLowerCase())) return null;
    return { platform: 'x', handle: `@${h}`, profile_url: `https://x.com/${h}` };
  }
  if (host === 'pinterest.com' || /^[a-z]{2}\.pinterest\.com$/.test(host)) {
    const h = cleanHandle(seg[0]);
    if (!h || RESERVED.pinterest.has(h.toLowerCase())) return null;
    return { platform: 'pinterest', handle: h, profile_url: `https://www.pinterest.com/${h}` };
  }
  return null;
}

/** The `web`/`blog` lane: a result's own site, if it plausibly is a creator's. */
export function classifyWebsite(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (NOT_A_CREATOR_SITE.some((d) => host.includes(d))) return null;
  // Platform hosts are handled by classifyProfileUrl; a non-profile URL on one
  // of them (a /watch link) is not "a website".
  if (/(^|\.)(instagram|tiktok|youtube|twitch|twitter|x|pinterest)\.(com|tv)$/.test(host)) return null;
  return { platform: 'blog', handle: host, profile_url: `https://${host}` };
}

/** Words from the program's own niche/audience text, used to score fit. */
export function nicheTerms(program) {
  const text = [program?.niche, program?.audience_notes].filter(Boolean).join(' ').toLowerCase();
  const words = text.match(/[a-z0-9][a-z0-9'-]{3,}/g) || [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)))].slice(0, 30);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;
/** An email ONLY if the result text states one literally. */
export function statedEmail(text) {
  for (const m of String(text || '').match(EMAIL_RE) || []) {
    const e = m.toLowerCase().replace(/[.]+$/, '');
    if (/(^|[.@])(example|test|domain|email)\.(com|org)$/.test(e)) continue;
    if (/^(no-?reply|donotreply|privacy|abuse|support|help)@/.test(e)) continue;
    return e;
  }
  return null;
}

/**
 * Fit-to-query score, 0..0.95, with the full basis written out. Never 1.0: a
 * search result is not proof that someone is a good partner.
 */
export function scoreProspect({ item, profile, program, terms }) {
  const parts = [];
  let score = 0;
  if (profile.platform !== 'blog') { score += 0.3; parts.push(`recognised ${profile.platform} profile (+0.30)`); }
  else { score += 0.1; parts.push('personal website, not a platform profile (+0.10)'); }

  const hay = `${item.title || ''} ${item.description || ''}`.toLowerCase();
  const hits = (terms || []).filter((t) => hay.includes(t));
  if (hits.length) {
    const add = Math.min(0.3, 0.1 * hits.length);
    score += add;
    parts.push(`niche terms in title/snippet: ${hits.slice(0, 6).join(', ')} (+${add.toFixed(2)})`);
  } else {
    parts.push('no niche term in title/snippet (+0.00)');
  }

  const rank = Number(item.rank_absolute ?? item.rank_group);
  if (Number.isFinite(rank) && rank > 0 && rank <= 10) { score += 0.15; parts.push(`search rank ${rank} (+0.15)`); }
  else if (Number.isFinite(rank) && rank <= 30) { score += 0.05; parts.push(`search rank ${rank} (+0.05)`); }

  const wanted = (program?.platforms || []).map((p) => String(p).toLowerCase());
  if (wanted.length && wanted.includes(profile.platform)) { score += 0.1; parts.push('platform is one the program targets (+0.10)'); }

  const email = statedEmail(item.description);
  if (email) { score += 0.05; parts.push('contact address stated in the result (+0.05)'); }

  score = Math.min(0.95, Math.round(score * 1000) / 1000);
  return { confidence: score, confidence_basis: `Fit to the search query, not creator quality. ${parts.join('; ')}.`, email };
}

// The social platforms a search can be pinned to, as Google site: filters.
// YouTube and TikTok are pinned to their PROFILE paths (/@handle): a bare
// site:youtube.com returns /watch links, which name no channel and are
// discarded, so a YouTube search found 30 results and 0 creators.
export const PLATFORM_SITES = {
  instagram: ['instagram.com'], tiktok: ['tiktok.com/@'], youtube: ['youtube.com/@'],
  twitch: ['twitch.tv'], x: ['x.com', 'twitter.com'], pinterest: ['pinterest.com'],
};

/**
 * The words actually sent to the search engine. A search looks for CREATORS:
 * unless the operator wrote their own site: filter, the query is pinned to the
 * search's Platform, else to the program's ticked social platforms, else to all
 * of them. Only a search whose Platform is "blog" (or a program that ticked
 * only blog/web) runs unpinned, to find personal websites.
 */
export function searchKeyword(source, program) {
  const q = String(source?.query || '').replace(/\s+/g, ' ').trim();
  if (/\bsite:/i.test(q)) return q.slice(0, 700);
  const hint = String(source?.platform_hint || '').toLowerCase();
  let wanted;
  if (hint) wanted = [hint];
  else {
    const ticked = (program?.platforms || []).map((p) => String(p).toLowerCase());
    wanted = ticked.filter((p) => PLATFORM_SITES[p]);
    if (!wanted.length && !ticked.some((p) => ['blog', 'web'].includes(p))) wanted = Object.keys(PLATFORM_SITES);
  }
  const sites = [...new Set(wanted.flatMap((p) => PLATFORM_SITES[p] || []))];
  if (!sites.length) return q.slice(0, 700);
  const filter = sites.length === 1 ? `site:${sites[0]}` : `(${sites.map((s) => `site:${s}`).join(' OR ')})`;
  return `${q.slice(0, 700 - filter.length - 1)} ${filter}`;
}

/** DataForSEO live/advanced task for one source. */
export function buildSerpTask(source, program) {
  const task = { keyword: searchKeyword(source, program), depth: Math.min(Math.max(Number(source.max_results) || 20, 10), 100) };
  if (source.location_code) task.location_code = Number(source.location_code);
  else task.location_name = 'United States';
  task.language_code = source.language_code || 'en';
  return task;
}

// Provider answers that mean "try again", not "this request is wrong":
// 40101 is the search engine's own internal error (seen on production
// 2026-11-10 on a plain US/English query), 5xxxx are the provider's.
export const RETRYABLE_SERP_CODES = new Set([40101, 50000, 50301]);
export const SERP_ATTEMPTS = 3;

export class SerpError extends Error {
  constructor(message, { code = null, retryable = false } = {}) { super(message); this.code = code; this.retryable = retryable; }
}

async function fetchSerpOnce({ credentials, task, fetchImpl }) {
  // btoa, not Buffer: this module also ships verbatim in an edge function
  // (Deno), where Buffer is not a global.
  const auth = 'Basic ' + btoa(`${credentials.login}:${credentials.password}`);
  const res = await fetchImpl(`${DATAFORSEO_BASE}/v3/serp/google/organic/live/advanced`, {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify([task]),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) throw new SerpError(`SERP provider HTTP ${res.status}`, { code: res.status, retryable: res.status >= 500 || res.status === 429 });
  const t = body.tasks?.[0];
  if (!t || (t.status_code && t.status_code >= 40000)) {
    const code = t?.status_code ?? null;
    throw new SerpError(`SERP provider refused the task: ${code ?? '?'} ${t?.status_message ?? body.status_message ?? ''}`.trim(), { code, retryable: RETRYABLE_SERP_CODES.has(code) });
  }
  const items = (t.result?.[0]?.items || []).filter((i) => i && i.type === 'organic' && i.url);
  return { items, cost: Number.isFinite(Number(t.cost)) ? Number(t.cost) : null };
}

/**
 * POST one live task; returns { items, cost }. A transient provider error is
 * retried (SERP_ATTEMPTS in all, with a short backoff); anything else, or the
 * last attempt, throws with the provider's own message for the run record.
 */
export async function fetchSerpLive({ credentials, task, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchSerpOnce({ credentials, task, fetchImpl });
    } catch (err) {
      if (!err?.retryable || attempt >= SERP_ATTEMPTS) throw err;
      await sleep(1500 * attempt);
    }
  }
}

/**
 * The page a result points at. Since late October 2026 Google serves many
 * organic results through an opaque https://google.com/goto?url=CAES... link
 * (the token cannot be decoded), and the SERP provider then reports the
 * result's url AND domain as google.com. The real page survives only in the
 * breadcrumb, which for a profile reads "https://www.tiktok.com › @name".
 * Returns the url unchanged when it is not a goto link, the page rebuilt from
 * the breadcrumb when it is, and null when neither names a real page. A
 * breadcrumb segment Google shortened ("..." or "…") is dropped with
 * everything after it, so a guessed path is never stored.
 */
const GOTO_RE = /(^|[/.=])google\.[a-z.]+\/(goto|url)\?/i;
export function resolveResultUrl(item) {
  const url = String(item?.url || '');
  if (!GOTO_RE.test(url)) return url || null;
  const crumb = String(item?.breadcrumb || '').trim();
  const parts = crumb.split(/\s*›\s*/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  let origin;
  try { origin = new URL(/^https?:\/\//i.test(parts[0] || '') ? parts[0] : `https://${parts[0]}`); } catch { return null; }
  if (!/^https?:$/.test(origin.protocol) || /(^|\.)google\./i.test(origin.hostname)) return null;
  const path = [];
  for (const seg of parts.slice(1)) {
    if (/(\.\.\.|…)/.test(seg)) break;
    path.push(encodeURIComponent(seg).replace(/%40/g, '@'));
  }
  return `${origin.origin}${origin.pathname.replace(/\/+$/, '')}${path.length ? `/${path.join('/')}` : ''}`;
}

/**
 * Turn one result set into prospect candidates. Pure.
 * Returns { candidates, stats } where stats.results_returned counts every
 * organic result and stats.profiles_recognized the ones kept.
 */
export function candidatesFromResults({ items, program, source, collectedAt }) {
  const terms = nicheTerms(program);
  const webLane = (program?.platforms || []).some((p) => ['blog', 'web'].includes(String(p).toLowerCase()));
  const seen = new Map();
  const unrecognized = [];
  for (const raw of items || []) {
    const resolved = resolveResultUrl(raw);
    const item = resolved && resolved !== raw.url ? { ...raw, url: resolved, goto_url: raw.url } : raw;
    const profile = classifyProfileUrl(item.url) || (webLane ? classifyWebsite(item.url) : null);
    if (!profile) { if (unrecognized.length < 10) unrecognized.push(String(item.url).slice(0, 200)); continue; }
    const key = profile.profile_url.toLowerCase();
    if (seen.has(key)) continue; // the same creator twice in one result set is one candidate
    const { confidence, confidence_basis, email } = scoreProspect({ item, profile, program, terms });
    seen.set(key, {
      ...profile,
      display_name: String(item.title || profile.handle || '').split(/[|•\-–—(]/)[0].trim().slice(0, 120) || profile.handle,
      contact_email: email,
      contact_source_url: email ? item.url : null,
      source_url: item.url,
      collected_at: collectedAt,
      confidence,
      confidence_basis,
      evidence: {
        provider: PROVIDER,
        query: source.query,
        title: item.title ?? null,
        snippet: item.description ?? null,
        rank: item.rank_absolute ?? null,
        domain: item.domain ?? null,
        result_url: item.url,
        ...(item.goto_url ? { google_redirect_url: String(item.goto_url).slice(0, 500), resolved_from: 'breadcrumb' } : {}),
      },
    });
  }
  return {
    candidates: [...seen.values()],
    stats: { results_returned: (items || []).length, profiles_recognized: seen.size },
    // Not stored on the run row (it has no column for it): the first result
    // URLs that were NOT a profile, kept on the program's sync_jobs row so a
    // search that finds nothing can be diagnosed.
    unrecognized,
  };
}

async function canContact(supabase, program, c) {
  const { data, error } = await supabase.rpc('affiliate_outreach_can_contact', {
    p_company_entity_id: program.company_entity_id, p_program_id: program.id,
    p_email: c.contact_email, p_handle: c.handle, p_profile_url: c.profile_url,
  });
  if (error) throw new Error(`suppression check failed: ${error.message}`);
  return data === true;
}

/**
 * Write one source's candidates. Never touches a reviewed field; a prospect
 * a human rejected or suppressed stays exactly as they left it.
 */
export async function upsertCandidates({ supabase, program, source, candidates, runId, origin = { source: 'serp', collector: `affiliate-discovery/${PROVIDER}` } }) {
  const out = { prospects_new: 0, prospects_updated: 0, suppressed_skipped: 0, emails_found: 0 };
  if (!candidates.length) return out;

  const urls = candidates.map((c) => c.profile_url);
  const { data: existing, error } = await supabase
    .from('affiliate_prospects')
    .select('id, profile_url, status, contact_email, evidence')
    .eq('company_entity_id', program.company_entity_id)
    .eq('program_id', program.id)
    .in('profile_url', urls);
  if (error) throw new Error(`affiliate_prospects lookup failed: ${error.message}`);
  const byUrl = new Map((existing || []).map((p) => [String(p.profile_url).toLowerCase(), p]));

  for (const c of candidates) {
    const prior = byUrl.get(c.profile_url.toLowerCase());
    if (prior?.status === 'suppressed' || !(await canContact(supabase, program, c))) {
      out.suppressed_skipped += 1;
      continue;
    }
    if (c.contact_email) out.emails_found += 1;

    let prospectId = prior?.id;
    if (!prior) {
      const { data: ins, error: insErr } = await supabase.from('affiliate_prospects').insert({
        company_entity_id: program.company_entity_id, program_id: program.id,
        display_name: c.display_name, platform: c.platform, handle: c.handle, profile_url: c.profile_url,
        contact_email: c.contact_email, contact_source_url: c.contact_source_url,
        source_id: source.id ?? null, source: origin.source, source_url: c.source_url, collected_at: c.collected_at,
        evidence: c.evidence, confidence: c.confidence, confidence_basis: c.confidence_basis, status: 'new',
      }).select('id').single();
      if (insErr) {
        // Another run (or a person) created it between the lookup and here:
        // the identity index refused a duplicate, which is the index working.
        if (!/duplicate|unique/i.test(insErr.message)) throw new Error(`affiliate_prospects insert failed: ${insErr.message}`);
        out.prospects_updated += 1;
        continue;
      }
      prospectId = ins.id;
      out.prospects_new += 1;
    } else {
      const patch = {
        // Only ADD: a value this run did not find (null) never blanks one an
        // earlier run, an import or a person recorded.
        evidence: { ...(prior.evidence || {}), ...Object.fromEntries(Object.entries(c.evidence || {}).filter(([, v]) => v !== null && v !== undefined)), last_seen_query: source.query },
        collected_at: c.collected_at, ...(c.source_url ? { source_url: c.source_url } : {}),
        confidence: c.confidence, confidence_basis: c.confidence_basis, updated_at: c.collected_at,
      };
      // A contact a person entered, or one found before, is not overwritten.
      if (!prior.contact_email && c.contact_email) {
        patch.contact_email = c.contact_email;
        patch.contact_source_url = c.contact_source_url;
      }
      const { error: upErr } = await supabase.from('affiliate_prospects').update(patch)
        .eq('id', prior.id).eq('company_entity_id', program.company_entity_id);
      if (upErr) throw new Error(`affiliate_prospects update failed: ${upErr.message}`);
      out.prospects_updated += 1;
    }

    const { error: obsErr } = await supabase.from('affiliate_prospect_observations').insert({
      company_entity_id: program.company_entity_id, prospect_id: prospectId, source_id: source.id ?? null,
      collector: origin.collector, source_url: c.source_url, collected_at: c.collected_at,
      payload: { ...c.evidence, run_id: runId },
    });
    if (obsErr) throw new Error(`affiliate_prospect_observations insert failed: ${obsErr.message}`);
  }
  return out;
}

/**
 * The whole run. `fetchSerp(task)` -> { items, cost } is injected so tests
 * drive it without a network. dryRun calls NO provider and writes NOTHING: it
 * reports which queries would run and what they would be capped at.
 */
export async function runDiscovery({ supabase, fetchSerp, now = () => new Date(), dryRun = false, onlyProgramId = '', onlySourceId = '', log = () => {}, uuid = () => crypto.randomUUID() }) {
  let q = supabase.from('affiliate_programs')
    .select('id, company_entity_id, name, niche, audience_notes, platforms, status, discovery_max_cost_usd')
    .eq('status', 'active');
  if (onlyProgramId) q = q.eq('id', onlyProgramId);
  const { data: programs, error } = await q;
  if (error) throw new Error(`affiliate_programs load failed: ${error.message}`);

  const summary = { programs: 0, sources: 0, ran: 0, skipped: 0, failed: 0, cost_usd: 0, prospects_new: 0, prospects_updated: 0, dry_run: dryRun };
  for (const program of programs || []) {
    let sq = supabase.from('affiliate_prospect_sources')
      .select('*').eq('company_entity_id', program.company_entity_id).eq('program_id', program.id)
      .eq('kind', 'serp_query').eq('enabled', true);
    if (onlySourceId) sq = sq.eq('id', onlySourceId);
    const { data: sources, error: sErr } = await sq;
    if (sErr) throw new Error(`affiliate_prospect_sources load failed: ${sErr.message}`);
    if (!sources?.length) continue;
    summary.programs += 1;

    const runId = uuid();
    const programStarted = now().toISOString();
    const failedBefore = summary.failed;
    const cap = Number(program.discovery_max_cost_usd ?? 0);
    let spent = 0;
    const diagnostics = [];

    for (const source of sources) {
      summary.sources += 1;
      const started = now().toISOString();
      if (dryRun) {
        log(`[affiliate-discovery] DRY RUN ${program.name}: would query "${searchKeyword(source, program)}" (max ${source.max_results}, cap $${cap.toFixed(2)})`);
        continue;
      }

      const runRow = {
        company_entity_id: program.company_entity_id, program_id: program.id, source_id: source.id,
        run_id: runId, provider: PROVIDER, query: source.query, started_at: started, status: 'running',
      };
      const { data: ins, error: rErr } = await supabase.from('affiliate_discovery_runs').insert(runRow).select('id').single();
      if (rErr) throw new Error(`affiliate_discovery_runs insert failed: ${rErr.message}`);

      const finish = async (patch) => {
        const { error: fErr } = await supabase.from('affiliate_discovery_runs')
          .update({ ...patch, finished_at: now().toISOString() }).eq('id', ins.id);
        if (fErr) throw new Error(`affiliate_discovery_runs update failed: ${fErr.message}`);
      };

      // The cost cap, against the provider's OWN reported spend so far. Checked
      // before each query: a run that has reached it stops querying, and says so.
      if (spent >= cap) {
        summary.skipped += 1;
        await finish({ status: 'skipped', error: `cost cap $${cap.toFixed(2)} reached after $${spent.toFixed(4)}`, cost_usd: 0 });
        log(`[affiliate-discovery] ${program.name}: cap reached, "${source.query}" not queried`);
        continue;
      }

      try {
        const { items, cost } = await fetchSerp(buildSerpTask(source, program));
        spent += Number(cost || 0);
        const { candidates, stats, unrecognized } = candidatesFromResults({ items, program, source, collectedAt: now().toISOString() });
        diagnostics.push({ source_id: source.id, keyword: buildSerpTask(source, program).keyword, results: stats.results_returned, profiles: stats.profiles_recognized, not_profiles: unrecognized });
        const wrote = await upsertCandidates({ supabase, program, source, candidates, runId });
        await finish({ status: 'ok', cost_usd: cost, ...stats, ...wrote });
        // The source's own summary row is written LAST, so it never describes
        // prospects that failed to land.
        const { error: srcErr } = await supabase.from('affiliate_prospect_sources').update({
          last_run_at: started, last_run_results: stats.profiles_recognized, last_run_cost: cost, last_error: null,
        }).eq('id', source.id);
        if (srcErr) throw new Error(`affiliate_prospect_sources update failed: ${srcErr.message}`);
        summary.ran += 1;
        summary.cost_usd += Number(cost || 0);
        summary.prospects_new += wrote.prospects_new;
        summary.prospects_updated += wrote.prospects_updated;
        log(`[affiliate-discovery] ${program.name}: "${source.query}" -> ${stats.results_returned} results, ${stats.profiles_recognized} profiles, ${wrote.prospects_new} new, ${wrote.prospects_updated} updated, ${wrote.suppressed_skipped} suppressed, $${Number(cost || 0).toFixed(4)}`);
      } catch (err) {
        summary.failed += 1;
        const message = String(err?.message || err).slice(0, 500);
        await finish({ status: 'error', error: message });
        await supabase.from('affiliate_prospect_sources').update({ last_run_at: started, last_error: message }).eq('id', source.id);
        log(`[affiliate-discovery] ${program.name}: "${source.query}" failed: ${message}`);
      }
    }

    if (!dryRun) {
      // One sync_jobs row per program per run, like every other sync. The
      // detail lives in affiliate_discovery_runs; this row is what the
      // freshness tooling already knows how to read.
      const { error: jErr } = await supabase.from('sync_jobs').insert({
        company_entity_id: program.company_entity_id, job_type: 'affiliate_discovery',
        status: summary.failed > failedBefore ? 'error' : 'success',
        started_at: programStarted, finished_at: now().toISOString(),
        result: { program_id: program.id, run_id: runId, cost_usd: Number(spent.toFixed(4)), searches: diagnostics },
      });
      if (jErr) log(`[affiliate-discovery] sync_jobs record failed (run detail is in affiliate_discovery_runs): ${jErr.message}`);
    }
  }
  summary.cost_usd = Number(summary.cost_usd.toFixed(4));
  return summary;
}
