// supabase/functions/silo-chat/seo-lib.mjs
//
// The orchestration rules for multi-page SEO review, kept OUT of index.ts so a
// test can execute them. That separation is the lesson from 2026-09-09: an
// orchestrator callback shipped with a temporal-dead-zone reference because
// the helper it called had 91 assertions and the five lines that called it had
// none. Anything here is reachable from scripts/tests/.
//
// WHAT THIS IS NOT. It is not the SSRF boundary. The host allowlist lives in
// page-inspect, read from shopify_shop_domains under the CALLER'S JWT, and
// that is the only thing deciding which hosts may be fetched. Nothing in this
// file may be read as permission -- re-implementing the allowlist here would
// create a second definition of the boundary that could drift from the real
// one, which is worse than having no check at all.
//
// AND URL PROVENANCE IS NOT ENFORCED IN CODE EITHER. The rule that a URL must
// come from the user or from a candidate row's inspect_url is carried by the
// prompt and the tool description. This module cannot check it: it sees a
// string, not where the string came from, and page-inspect checks only that
// the host is on the company's allowlist. A model that assembled a path onto
// one of the company's OTHER storefront hosts would be refused by nothing
// here -- seo_collection_candidates removes the REASON to do that, not the
// ability. Guidance, not a guarantee; do not describe it as code-enforced.
//
// Closing that gap is possible and deliberately not done here: it means
// tracking every URL returned in this request's tool results plus those in the
// user's message and refusing anything else, which carries real false-refusal
// risk (a URL pasted several turns ago) and deserves its own change.

/** How many page inspections one chat request may make.
 *
 * Five, not one, because an SEO review that cannot look at more than a single
 * page cannot compare pages -- and not unbounded, because a per-request cap is
 * what keeps a sequential tool loop from becoming a crawler by repetition.
 * Crawling is a separate decision with its own robots and rate-limit
 * questions, and raising this number is not how it should get made.
 */
export const MAX_PAGE_INSPECTIONS_PER_REQUEST = 5;

/** Track and spend the per-request inspection budget.
 *
 * Deliberately counts ATTEMPTS, not successes: a refused or failed fetch still
 * cost an outbound request, and a loop that retried failures forever would be
 * a crawler with extra steps.
 */
export function createInspectionBudget(max = MAX_PAGE_INSPECTIONS_PER_REQUEST) {
  let used = 0;
  const seen = new Set();
  return {
    get used() { return used; },
    get remaining() { return Math.max(max - used, 0); },
    get max() { return max; },
    take(url) {
      const key = String(url ?? '').trim();
      if (!key) {
        return { ok: false, reason: 'url is required. Use the inspect_url returned by seo_collection_candidates, or a URL the user gave you.' };
      }
      // Re-inspecting a page already fetched this request spends budget for a
      // result that is already in the transcript.
      if (seen.has(key)) {
        return { ok: false, reason: `${key} was already inspected in this request -- its result is above, reuse it rather than fetching again.` };
      }
      if (used >= max) {
        return {
          ok: false,
          reason: `the ${max}-page inspection limit for one question has been reached. `
            + 'This tool is not a crawler. Report on the pages already inspected, and say which candidates you did not reach.',
        };
      }
      used += 1;
      seen.add(key);
      return { ok: true };
    },
  };
}

/** A cheap shape check on a URL BEFORE spending an outbound request.
 *
 * NOT a security decision -- page-inspect re-derives everything from the
 * allowlist and is the only authority. This exists so an obviously malformed
 * value (a bare path, an http:// URL, a NULL inspect_url rendered as the
 * string "null") is refused locally with a useful message instead of burning
 * one of five inspections to be told the same thing.
 */
export function looksInspectable(url) {
  const raw = String(url ?? '').trim();
  if (!raw || raw === 'null' || raw === 'undefined') {
    return { ok: false, reason: 'no URL. A candidate row with a null inspect_url has no verified storefront host for its shop -- skip it and say so, never guess a domain.' };
  }
  if (raw.startsWith('/')) {
    return { ok: false, reason: 'that is a path, not a URL. Use the inspect_url column, which already carries the correct storefront host for that shop -- do not build the URL yourself.' };
  }
  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: `not a valid URL: ${raw}` }; }
  if (u.protocol !== 'https:') {
    return { ok: false, reason: 'only https:// URLs can be inspected.' };
  }
  return { ok: true };
}

/* The qualifiers that must survive into the final answer.
 *
 * These are the claims that make an SEO recommendation honest, and they are
 * exactly what a "simplify the answer" pass strips first, because each one is
 * a caveat rather than a finding. They are listed here so the prompt assembly
 * and its tests refer to ONE list.
 */
export const REQUIRED_SEO_QUALIFIERS = [
  'landing-page figures are per-page and truncated to the top ranked pages per day',
  'an absent page is not a page with zero traffic',
  'landing-page rows and store-session totals are different grains and are never added together',
  'these are on-site sessions, not organic search traffic',
  // Search Console is ingested since 2026-09-10 (search_console_{site,page,query}_daily).
  // The qualifiers changed from "we have none" to the two ways its data misleads.
  'query-level search data covers only the clicks Google attributes to a query; the per-day unattributed share on search_console_site_daily is cited with it',
  'a page absent from search_console_page_daily is not returned by Google, never zero clicks',
  'indexing status is not available (no URL Inspection data)',
  'a successful page fetch is not evidence the page is indexed',
  'recommendations are drafts for human review, nothing is published',
];
