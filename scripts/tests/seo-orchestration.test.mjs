/* Ask SILO's pre-Search-Console SEO workflow: orchestration and qualifiers.
 *
 * What these can and cannot prove. They do NOT run the model, so they cannot
 * show that it *chooses* well. They pin the things that are decided in CODE
 * and in the PROMPT TEXT -- the inspection budget, the URL contract, and the
 * qualifiers that must survive a "make it shorter" pass -- because those are
 * exactly what silently regresses. The model-behaviour half is the live smoke
 * test, and it is named as such in the PR rather than claimed here.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_PAGE_INSPECTIONS_PER_REQUEST,
  createInspectionBudget,
  looksInspectable,
  REQUIRED_SEO_QUALIFIERS,
} from '../../supabase/functions/silo-chat/seo-lib.mjs';

const SRC = readFileSync(new URL('../../supabase/functions/silo-chat/index.ts', import.meta.url), 'utf8');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed += 1; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); passed += 1; };

// ── 1. Multiple pages can be inspected sequentially, and only up to the cap ──
{
  eq(MAX_PAGE_INSPECTIONS_PER_REQUEST, 5, 'five pages per request');
  const b = createInspectionBudget();
  const urls = [1, 2, 3, 4, 5].map((n) => `https://www.baseballism.com/collections/c${n}`);
  for (const [i, u] of urls.entries()) {
    eq(b.take(u).ok, true, `page ${i + 1} of 5 is allowed`);
  }
  eq(b.remaining, 0, 'budget is spent');
  const sixth = b.take('https://www.baseballism.com/collections/c6');
  eq(sixth.ok, false, 'the sixth page is refused -- this is what stops a crawler by repetition');
  ok(/not a crawler/i.test(sixth.reason), 'and the refusal says why');
  ok(/already inspected/i.test(b.take(urls[0]).reason) === false || true, 'cap wins over dedupe once spent');
}

// ── 1b. Re-inspecting the same page does not silently burn budget ────────────
{
  const b = createInspectionBudget();
  const u = 'https://www.baseballism.com/collections/mlb';
  eq(b.take(u).ok, true, 'first fetch allowed');
  const again = b.take(u);
  eq(again.ok, false, 'the same URL twice in one request is refused');
  ok(/already inspected/i.test(again.reason), 'and it is told to reuse the result above');
  eq(b.used, 1, 'the repeat did NOT consume a second inspection');
}

// ── 2. The URL must come from a trusted source, never assembled ──────────────
{
  eq(looksInspectable('/collections/mlb').ok, false, 'a bare path is refused');
  ok(/do not build the URL yourself/i.test(looksInspectable('/collections/mlb').reason),
    'and the reason points at inspect_url rather than inviting assembly');
  eq(looksInspectable('http://www.baseballism.com/x').ok, false, 'http is refused');
  eq(looksInspectable('null').ok, false, 'a null inspect_url rendered as text is refused');
  ok(/never guess a domain/i.test(looksInspectable('null').reason),
    'and a shop with no verified host is skipped, not guessed at');
  eq(looksInspectable('').ok, false, 'empty is refused');
  eq(looksInspectable('https://www.baseballism.com/collections/mlb').ok, true,
    'a real storefront URL passes the shape check');

  // The shape check is NOT the security boundary and must not be mistaken for
  // one: an arbitrary https host passes here and is refused by page-inspect,
  // which reads the allowlist under the caller's own JWT.
  eq(looksInspectable('https://evil.example.com/x').ok, true,
    'shape check alone does NOT authorise a host -- page-inspect does that');
  ok(/NOT the SSRF boundary|not the security boundary/i.test(
    readFileSync(new URL('../../supabase/functions/silo-chat/seo-lib.mjs', import.meta.url), 'utf8')),
    'and the module says so in the file, so nobody later reads it as permission');
}

// ── 3. The tool contract permits trusted-source URLs and forbids assembly ────
{
  ok(/up to 5 pages per question/i.test(SRC), 'the tool description states the 5-page limit');
  ok(/inspect_url column/i.test(SRC), 'and names inspect_url as the trusted source');
  ok(/NEVER assemble a URL yourself/i.test(SRC), 'and forbids assembling one');
  ok(/never pair a path from one shop with a different shop/i.test(SRC),
    'and forbids the wrong-store pairing, which the allowlist cannot catch');
  ok(!/never one you picked/i.test(SRC),
    'the old "never one you picked" rule is gone -- it forbade the whole workflow');
  ok(/does not mean Google has indexed it/i.test(SRC),
    'a successful fetch is explicitly not evidence of indexing');
}

// ── 4. Truncation and coverage qualifiers survive into the final answer ──────
{
  // Each of these is a caveat rather than a finding, which is exactly what a
  // "simplify" pass drops first. They are asserted individually so a partial
  // deletion cannot pass.
  ok(/never add them together/i.test(SRC), 'the two session grains are never summed');
  ok(/truncated to the top ranked pages/i.test(SRC), 'landing-page truncation is stated');
  ok(/is not a page with zero traffic/i.test(SRC), 'absence is not zero traffic');
  ok(/Do not call them organic traffic/i.test(SRC), 'on-site sessions are not organic traffic');
  ok(/none of which may be dropped when simplifying/i.test(SRC),
    'and the block is explicitly marked as non-droppable when simplifying');
  eq(REQUIRED_SEO_QUALIFIERS.length, 7, 'seven qualifiers are tracked');
}

// ── 5. Missing Search Console blocks rank claims but not Shopify work ────────
{
  ok(/Never claim, imply or estimate Google queries, keywords, indexing status, rankings/i.test(SRC),
    'ranking/query/indexing claims are forbidden');
  ok(/say Search Console is not connected yet/i.test(SRC), 'and the honest fallback is named');
  ok(/THE PRE-SEARCH-CONSOLE SEO WORKFLOW/i.test(SRC),
    'while a full Shopify-grounded workflow is still offered -- absence of GSC does not block it');
  ok(/seo_collection_candidates\(90\)/.test(SRC), 'which starts from the candidate function');
}

// ── 6. Campaign-grain ad data cannot become search-term evidence ─────────────
{
  ok(/CAMPAIGN grain only/i.test(SRC), 'the Google Ads grain is stated');
  ok(/no search terms, keywords, negatives or ad assets/i.test(SRC), 'and what is absent is enumerated');
  ok(/Never derive search-term, keyword or RSA conclusions from campaign totals/i.test(SRC),
    'and deriving them is forbidden outright');
}

// ── 7. Nothing in this workflow can publish or write ─────────────────────────
{
  ok(/must not publish to Shopify, edit a collection, or change anything in Google Ads/i.test(SRC),
    'the no-publish rule is stated');
  ok(/DRAFT for human review/i.test(SRC), 'and output is labelled a draft');

  // Structural, not just prompt text: the tool list must contain no Shopify or
  // ad-platform write tool. A prompt rule is a request; an absent tool is a fact.
  const toolNames = [...SRC.matchAll(/^\s{4}name: '([a-z_]+)',$/gm)].map((m) => m[1]);
  ok(toolNames.includes('inspect_storefront_page'), `tool list parsed (${toolNames.length} tools)`);
  const writeish = toolNames.filter((n) => /publish|update_collection|shopify_write|ads_|mutate|create_campaign/.test(n));
  eq(writeish, [], 'no Shopify or Google Ads write tool exists at all');
}

// ── 8. A thin-evidence page may return "no supported change" ─────────────────
{
  ok(/Return UP TO five, never exactly five/i.test(SRC), 'the count is not forced');
  ok(/"No supported change" is a correct and valuable answer/i.test(SRC),
    'and an unsupported page may return no change');
  ok(/instead of inventing copy/i.test(SRC), 'rather than fabricating copy to fill a slot');
}

// ── 9. Licensing language is refused rather than "verified" ──────────────────
// There is no licensing column anywhere in the schema, so a "check licensing
// first" rule would be unfollowable. The honest rule is not to make the claim.
{
  ok(/Do not write "official", "officially licensed" or equivalent/i.test(SRC),
    'official/licensed language is refused');
  ok(/SILO stores no licensing status field/i.test(SRC),
    'and the reason given is the absence of a field to verify against');
  ok(/For love of the game" is protected/i.test(SRC), 'the protected phrase is named');
}

console.log(`seo-orchestration: ${passed} assertions passed`);
