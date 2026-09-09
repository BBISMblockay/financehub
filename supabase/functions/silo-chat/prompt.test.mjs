/* Ask SILO prompt-assembly assertions.
 *
 * These exist because of a specific live failure (2026-09-08): an SEO answer
 * concluded eight Shopify collections "don't exist" on the strength of a
 * LIMIT 30 query over a table that is itself a top-250-per-day slice. The
 * closest existing guard -- "ABSENCE OF HISTORY IS NOT EVIDENCE AGAINST" --
 * was real, correct, and unreachable: it lives in
 * PRODUCT_CONCEPT_SYSTEM_BLOCK, which is appended only for concept-mode
 * testers, so an ordinary question never saw it.
 *
 * That is the failure mode this file guards. A rule in the wrong prompt
 * block is invisible rather than wrong, and nothing else in the repo would
 * catch it moving back. Every assertion below therefore checks WHICH block
 * a rule is in, not merely that the text exists somewhere in the file.
 *
 * Run: node supabase/functions/silo-chat/prompt.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');

/** Pull a template-literal constant out of the TypeScript source.
 *  Deliberately source-scraping rather than importing: index.ts is Deno,
 *  imports npm:/jsr: specifiers and calls Deno.serve at module scope, so
 *  it cannot be imported into plain Node. The prompts are plain string
 *  constants, which makes scraping them exact. */
function constant(name) {
  const start = SRC.indexOf(`const ${name} = \``);
  if (start === -1) throw new Error(`prompt constant ${name} not found in index.ts`);
  const from = SRC.indexOf('`', start) + 1;
  let i = from;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '\\') { i++; continue; }
    if (SRC[i] === '`') break;
  }
  return SRC.slice(from, i);
}

const BEFORE = constant('BASE_PROMPT_BEFORE_SCHEMA');
const AFTER = constant('BASE_PROMPT_AFTER_SCHEMA');
const CONCEPT = constant('PRODUCT_CONCEPT_SYSTEM_BLOCK');

// What every question gets, concept tester or not. buildSystemPrompt()
// composes BEFORE + schema + AFTER + date/brand/strategy/notes; the
// concept block is appended only when conceptsEnabled.
const GENERAL = BEFORE + '\n' + AFTER;

let failures = 0;
let run = 0;
function test(name, fn) {
  run++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
const has = (hay, needle, label) => {
  if (!hay.includes(needle)) throw new Error(`${label || 'text'} is missing: "${needle}"`);
};
const lacks = (hay, needle, label) => {
  if (hay.includes(needle)) throw new Error(`${label || 'text'} unexpectedly contains: "${needle}"`);
};

console.log('\n-- the four evidence-discipline rules reach ORDINARY questions --');

test('absence-vs-nonexistence is in the base prompt, not concept-gated', () => {
  has(GENERAL, 'ABSENCE FROM A RESULT IS NOT ABSENCE FROM THE WORLD', 'general prompt');
});
test('...and names the registry distinction that makes it actionable', () => {
  has(GENERAL, 'REGISTRY table');
});
// Updated when the registry shipped (20260909120000). The rule used to say
// SILO had no collections registry, which stopped being true. Astra's review
// of #633 asked that the replacement require a COMPLETED and CURRENT sync
// rather than merely pointing at the table -- an empty or half-synced
// registry read as authoritative is a worse version of the landing-page
// mistake, since it looks like proof.
test('...points at shopify_collections and demands a completed run', () => {
  has(GENERAL, 'shopify_collections');
  has(GENERAL, 'shopify_collection_sync_runs with completed_at set');
  has(GENERAL, 'records landing SESSIONS');
});
test('truncation must be checked before a negative or ranking claim', () => {
  has(GENERAL, 'CHECK FOR TRUNCATION AND COVERAGE BEFORE ANY NEGATIVE OR RANKING CLAIM');
  has(GENERAL, 'is_truncated');
});
test('...including not layering an own LIMIT on a truncated source', () => {
  has(GENERAL, 'never put your own LIMIT on an already-truncated source');
});
test('...and checking real date coverage, not the window requested', () => {
  has(GENERAL, 'asking for 60 days does not mean 60 days of history exist');
});
test('stock/size must be checked before recommending a product', () => {
  has(GENERAL, 'CHECK AVAILABILITY BEFORE RECOMMENDING A PRODUCT');
  has(GENERAL, 'variant_title carries the size');
});
test('simplifying must not strip qualifiers', () => {
  has(GENERAL, 'WHEN YOU SIMPLIFY, THE QUALIFIERS ARE PART OF THE ANSWER');
  has(GENERAL, 'cut LENGTH, never CERTAINTY');
});
test('...and says which to drop when both will not fit', () => {
  has(GENERAL, 'drop the finding and keep the qualifier');
});
// Live result 2026-09-09 (silo-chat v59, audit rows 8ee1b081 / 84c3201b):
// the prose rule alone did not hold. "simplify that" dropped the 6-week
// window and downgraded a hedged "likely no indexed hub" to an assertion,
// while the gloves caveat -- which WAS the finding -- survived untouched.
// The distinction is detachability, not caveat-ness, so the rule now
// prescribes the mechanism rather than only the goal.
test('the rule says HOW to keep a qualifier, not just that it must', () => {
  has(GENERAL, 'BIND THE QUALIFIER INTO THE CLAIM SENTENCE');
  has(GENERAL, 'compression detaches it');
});
test('...and explicitly rules out a standing disclaimer footer', () => {
  has(GENERAL, 'This is NOT a request for a disclaimer footer');
});

console.log('\n-- our ingested grain is separated from a provider capability --');

test('a "Not ingested" confidence state exists alongside Unavailable', () => {
  has(GENERAL, '- Not ingested:');
  has(GENERAL, '- Unavailable:');
});
test('...naming the real Google Ads case that was misreported', () => {
  has(GENERAL, 'CAMPAIGN level only');
  has(GENERAL, 'SILO does not ingest them');
});
// Review catch (Astro, PR #631): a granted scope proves we MAY query a grain,
// never that the account has it configured. The first draft said those
// structures "exist in the Google Ads account", which is a claim about
// Baseballism's setup that no evidence here supports.
test('...without claiming those structures exist in THIS account', () => {
  has(GENERAL, 'Google Ads supports ad groups');
  has(GENERAL, 'the granted scope permits querying them');
  has(GENERAL, 'NOT about this account');
  lacks(GENERAL, 'exist in the Google Ads account', 'general prompt');
});
test('...and forbidding the inference that produced the false claim', () => {
  has(GENERAL, 'never "X doesn\'t exist" or "the platform doesn\'t provide X"');
});

console.log('\n-- SEO/search honesty before Search Console is connected --');

test('no Search Console data is stated plainly', () => {
  has(GENERAL, 'SILO holds NO Search Console data');
});
test('GA4 organic is bounded to channel-level session volume', () => {
  has(GENERAL, 'Organic Search SESSIONS at channel level only');
});
test('sessions are never attributable to individual queries', () => {
  has(GENERAL, 'sessions can NEVER be attributed to individual search queries');
});
test('copy prep stays allowed, just not dressed up as measured opportunity', () => {
  has(GENERAL, 'You can still help prepare page copy');
  has(GENERAL, 'never present that work as a measured search opportunity');
});

console.log('\n-- page inspection is on-page fact, and is not a crawler --');

// The tool must be declared, and declared as ONE user-named page. A model
// that reads it as "fetch pages" will walk links, which is a different tool
// with different rate-limit and robots questions that nobody has decided yet.
test('inspect_storefront_page is declared to the model', () => {
  has(SRC, "name: 'inspect_storefront_page'", 'index.ts');
});
test('...and is described as one user-named page, never a crawl', () => {
  has(SRC, 'THIS IS NOT A CRAWLER');
  has(SRC, 'never a URL you chose yourself');
  has(SRC, 'One inspection per question');
});
test('the general prompt tells the model the tool exists and what it is not', () => {
  has(GENERAL, 'inspect_storefront_page');
  has(GENERAL, 'it is not a crawler');
});
// The whole point of the SEO paragraph is that SILO has no search data. A
// page-fetch tool is the most tempting thing to mistake for one.
test('...and that reading a page is not search performance', () => {
  has(GENERAL, 'on-page fact, not search performance');
  has(GENERAL, 'never evidence that anything indexed or ranked it');
});
// A cap the model is merely asked to respect is not a cap.
test('the crawl guard is enforced in code, not only in the prompt', () => {
  has(SRC, 'MAX_PAGE_INSPECTIONS_PER_REQUEST', 'index.ts');
  has(SRC, 'pageInspectionsThisRequest >= MAX_PAGE_INSPECTIONS_PER_REQUEST', 'index.ts');
});
// Forwarding the caller's JWT is what keeps the tenant check and the host
// allowlist the same query. A service-role call here would let Ask SILO fetch
// a storefront the asking user has no claim to.
test('the caller JWT is forwarded to page-inspect, not a service-role key', () => {
  has(SRC, 'functions/v1/page-inspect', 'index.ts');
  has(SRC, 'Authorization: `Bearer ${jwt}`', 'index.ts');
  lacks(SRC.slice(SRC.indexOf("use.name === 'inspect_storefront_page'")).slice(0, 3000),
    'SERVICE_ROLE', 'the inspect_storefront_page branch');
});

console.log('\n-- regressions --');

test('the concept block keeps its own absence rule (not moved, generalized)', () => {
  has(CONCEPT, 'ABSENCE OF HISTORY IS NOT EVIDENCE AGAINST', 'concept block');
});
test('the general rules are NOT only in the concept block', () => {
  lacks(CONCEPT, 'ABSENCE FROM A RESULT IS NOT ABSENCE FROM THE WORLD', 'concept block');
});
test('the pre-existing summing caveat for landing pages survives elsewhere', () => {
  // The prompt defers schema facts to silo_chat_schema_catalog by design.
  has(SRC, 'do NOT add schema facts back here', 'index.ts');
});

console.log(`\n${run - failures}/${run} passed`);
process.exit(failures ? 1 : 0);
