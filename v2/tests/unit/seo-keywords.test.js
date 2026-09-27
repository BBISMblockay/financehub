/* /v2/seo-keywords.html's decisions: three kinds of absence that must never
 * read alike, and a cost estimate that matches what the sync will spend.
 *
 * Why: the SEO module's one rule is that an absent value is not a zero. A
 * keyword nobody has checked, a keyword checked where we were not on the
 * page, and a keyword checked where Google returned nothing are three
 * different facts; a page that prints "—" or "0" for all three teaches the
 * reader that they are one. */
'use strict';

const { createReporter } = require('../lib/assert');
const { loadV2 } = require('../lib/load');

const K = loadV2(['seo-keywords.js']).SiloSeoKeywords;
const r = createReporter('seo-keywords');

console.log('\n── three absences, three strings ──');
const never = K.rankingLabels({ observation_runs: 0, latest_observed_on: null, results_in_latest_run: null, our_serp_position: null });
const nothing = K.rankingLabels({ observation_runs: 1, latest_observed_on: '2026-09-28', results_in_latest_run: 0, our_serp_position: null });
const absent = K.rankingLabels({ observation_runs: 1, latest_observed_on: '2026-09-28', results_in_latest_run: 17, our_serp_position: null });
const present = K.rankingLabels({ observation_runs: 2, latest_observed_on: '2026-09-28', results_in_latest_run: 17, our_serp_position: 3, previous_observed_on: '2026-09-21', our_previous_serp_position: 5 });
r.test('never observed is named as such', () => { r.eq(never.state, 'never_observed'); r.eq(never.ours, 'never observed'); });
r.test('asked, nothing returned is named as such', () => { r.eq(nothing.state, 'asked_nothing'); r.eq(nothing.ours, 'nothing returned'); });
r.test('observed but absent names the depth it was absent from', () => { r.eq(absent.state, 'observed_absent'); r.eq(absent.ours, 'not in top 17 observed'); });
r.test('the three absences are three different strings', () => {
  r.truthy(new Set([never.ours, nothing.ours, absent.ours]).size === 3, 'absences collapsed');
  r.truthy(![never.ours, nothing.ours, absent.ours].some((s) => /\b0\b|—/.test(s)), 'an absence rendered as zero or a dash');
});
r.test('a present position is a number with its movement in words and sign', () => {
  r.eq(present.ours, '#3'); r.eq(present.movement, 'up 2'); r.eq(present.movementSign, 2);
});
r.test('movement without a prior run is "no prior run", never "unchanged"', () => {
  const m = K.rankingLabels({ observation_runs: 1, latest_observed_on: '2026-09-28', results_in_latest_run: 17, our_serp_position: 3, previous_observed_on: null });
  r.eq(m.movement, 'no prior run');
});
r.test('dropping out and entering are named, not computed from a fake zero', () => {
  const drop = K.rankingLabels({ observation_runs: 2, latest_observed_on: '2026-09-28', results_in_latest_run: 17, our_serp_position: null, previous_observed_on: '2026-09-21', our_previous_serp_position: 4 });
  const enter = K.rankingLabels({ observation_runs: 2, latest_observed_on: '2026-09-28', results_in_latest_run: 17, our_serp_position: 8, previous_observed_on: '2026-09-21', our_previous_serp_position: null });
  r.eq(drop.movement, 'dropped out (was #4)'); r.eq(enter.movement, 'entered (was absent)');
  r.eq(drop.movementSign, undefined);
});

console.log('\n── cost before the switch ──');
r.test('300 keywords x 2 devices at the measured price is $0.72 a run', () => {
  const e = K.estimateRun({ activeKeywords: 300, devices: ['desktop', 'mobile'], maxKeywords: 300, maxCostUsd: 2 });
  r.eq(e.tasks, 600); r.eq(e.usdPerRun, 0.72); r.eq(e.usdPerYear, 37.44); r.eq(e.costCapBinds, false);
});
r.test('the keyword cap bounds what is asked, and says how many fall outside it', () => {
  const e = K.estimateRun({ activeKeywords: 450, devices: ['desktop'], maxKeywords: 300 });
  r.eq(e.keywordsAsked, 300); r.eq(e.keywordsBeyondCap, 150); r.eq(e.tasks, 300);
});
r.test('the cost cap is flagged when the estimate exceeds it', () => {
  const e = K.estimateRun({ activeKeywords: 1000, devices: ['desktop', 'mobile'], maxKeywords: 1000, maxCostUsd: 2 });
  r.eq(e.usdPerRun, 2.4); r.eq(e.costCapBinds, true);
});
r.test('an unknown device is not counted', () => {
  r.eq(K.estimateRun({ activeKeywords: 10, devices: ['desktop', 'tablet'], maxKeywords: 10 }).tasks, 10);
});

console.log('\n── the schedule form validates the way the database will ──');
r.test('defaults pass', () => {
  r.eq(K.validateSchedule({ devices: ['desktop', 'mobile'], depth: 20, maxKeywords: 300, maxCostUsd: 2, priority: 1 }).ok, true);
});
r.test('no device, a duplicate device, depth 5, 0 keywords, $0 cost and priority 3 are each refused', () => {
  r.eq(K.validateSchedule({ devices: [], depth: 20, maxKeywords: 300, maxCostUsd: 2, priority: 1 }).ok, false);
  r.eq(K.validateSchedule({ devices: ['desktop', 'desktop'], depth: 20, maxKeywords: 300, maxCostUsd: 2, priority: 1 }).ok, false);
  r.eq(K.validateSchedule({ devices: ['desktop'], depth: 5, maxKeywords: 300, maxCostUsd: 2, priority: 1 }).ok, false);
  r.eq(K.validateSchedule({ devices: ['desktop'], depth: 20, maxKeywords: 0, maxCostUsd: 2, priority: 1 }).ok, false);
  r.eq(K.validateSchedule({ devices: ['desktop'], depth: 20, maxKeywords: 10, maxCostUsd: 0, priority: 1 }).ok, false);
  r.eq(K.validateSchedule({ devices: ['desktop'], depth: 20, maxKeywords: 10, maxCostUsd: 1, priority: 3 }).ok, false);
});

console.log('\n── the rest ──');
r.test('top domains are organic only, in position order, with own-domain flagged', () => {
  const t = K.topDomains([
    { position: 2, domain: 'b.com', result_type: 'organic' },
    { position: 1, domain: 'www.baseballism.com', result_type: 'organic', is_own_domain: true },
    { position: 1, domain: 'shop.example', result_type: 'shopping' },
    { position: 3, domain: 'c.com', result_type: 'organic' },
    { position: 4, domain: 'd.com', result_type: 'organic' },
  ], 3);
  r.eq(t.map((x) => x.domain).join(','), 'www.baseballism.com,b.com,c.com');
  r.eq(t[0].own, true);
});
r.test('new candidates exclude what is already in the set', () => {
  r.eq(K.newCandidates([{ keyword: 'a', already_in_set: true }, { keyword: 'b', already_in_set: false }]).length, 1);
});
r.test('the tracking sentence distinguishes off, waiting, collecting and done', () => {
  r.eq(K.trackingSummary({ schedule: null }).state, 'off');
  r.eq(K.trackingSummary({ schedule: { is_active: false } }).state, 'off');
  r.eq(K.trackingSummary({ schedule: { is_active: true, last_run_on: null } }).state, 'on_waiting');
  r.eq(K.trackingSummary({ schedule: { is_active: true, last_run_on: '2026-09-28' }, pendingTasks: 4 }).state, 'on_pending');
  r.eq(K.trackingSummary({ schedule: { is_active: true, last_run_on: '2026-09-28' }, pendingTasks: 0, failedTasks: 1 }).state, 'on');
});
r.test('domainNorm strips scheme, path and www.', () => {
  r.eq(K.domainNorm('https://WWW.Fanatics.com/baseballism'), 'fanatics.com');
});

console.log('\n── tactics: page paths, feature chips, page types, compare ──');
r.test('pagePath strips the host, the hash and click/tracking params, never the real query', () => {
  r.eq(K.pagePath('https://www.baseballism.com/?srsltid=AU7gw4U5'), '/');
  r.eq(K.pagePath('https://bl101.com/collections/backpacks?srsltid=abc&utm_source=x#top'), '/collections/backpacks');
  r.eq(K.pagePath('https://www.amazon.com/s?k=baseball+backpack&srsltid=zz'), '/s?k=baseball+backpack');
  r.eq(K.pagePath('https://baseballism.com/products/tee?variant=1'), '/products/tee?variant=1');
  r.eq(K.pagePath(''), '/');
});
r.test('feature chips are one per type in page order, counts summed, trailing blocks last, unknown types labelled from their name', () => {
  const chips = K.featureChips([
    { feature_type: 'related_searches', position: 9, item_count: 8, details: { entries: [{ title: 'x' }] } },
    { feature_type: 'people_also_ask', position: 3, item_count: 4, details: { entries: [{ title: 'q1' }] } },
    { feature_type: 'ai_overview', position: 1, item_count: 2, details: { entries: [] } },
    { feature_type: 'people_also_ask', position: 12, item_count: 3, details: { entries: [{ title: 'q2' }] } },
    { feature_type: 'things_to_know', position: 5, item_count: null, details: {} },
  ]);
  r.eq(chips.map((c) => c.type).join(','), 'ai_overview,people_also_ask,things_to_know,related_searches');
  r.eq(chips[1].count, 7); r.eq(chips[1].position, 3); r.eq(chips[1].entries.length, 2);
  r.eq(chips[0].label, 'AI overview'); r.eq(chips[2].label, 'Things to know'); r.eq(chips[2].count, null);
  r.eq(K.featureChips(null).length, 0);
});
r.test('page-type summary orders by keywords won, with a fixed order for ties', () => {
  const s = K.pageTypeSummary([
    { page_type: 'home', keywords_in_top_10: 3, distinct_pages: 1 },
    { page_type: 'collection', keywords_in_top_10: 7, distinct_pages: 4, best_position: 1, example_path: '/collections/backpacks', example_keyword: 'baseball backpacks' },
    { page_type: 'article', keywords_in_top_10: 3, distinct_pages: 2 },
  ]);
  r.eq(s.map((x) => x.page_type).join(','), 'collection,article,home');
  r.eq(s[0].keywords, 7); r.eq(s[0].pages, 4); r.eq(s[0].best, 1); r.eq(s[0].example_path, '/collections/backpacks');
});
r.test('namesTerm needs every word of the keyword, whole words, plural-tolerant, order-free', () => {
  r.eq(K.namesTerm('baseball backpack', 'Baseball Backpacks & Bags | BL101'), true);
  r.eq(K.namesTerm('baseball backpack', 'Backpacks | Baseballism Online'), false, 'baseballism is not baseball');
  r.eq(K.namesTerm('baseball backpacks', 'Backpack for baseball players'), true);
  r.eq(K.namesTerm('mlb hat', 'MLB Hats & Caps'), true);
  r.eq(K.namesTerm('', 'anything'), false); r.eq(K.namesTerm('x', null), false);
});
r.test('compareFacts: a missing side reads "not captured" on every row, a failed fetch says so, and the term check is on both sides', () => {
  const ours = { title: 'Backpacks | Baseballism Online', title_length: 30, h1: ['Backpacks'], h2_count: 2, word_count: 140, image_count: 24, images_missing_alt: 3, jsonld_types: ['BreadcrumbList'], fetched_at: '2026-09-26T08:00:00Z' };
  const theirs = { title: 'Baseball Backpacks & Bags | BL101', title_length: 33, h1: ['Baseball Backpacks'], h2_count: 6, word_count: 610, image_count: 30, images_missing_alt: 0, jsonld_types: ['CollectionPage', 'Product'], fetched_at: '2026-09-26T08:01:00Z' };
  const rows = K.compareFacts('baseball backpacks', ours, theirs);
  const by = Object.fromEntries(rows.map((x) => [x.key, x]));
  r.eq(by.title_names_term.ours, 'no'); r.eq(by.title_names_term.theirs, 'yes');
  r.eq(by.h1_names_term.ours, 'no'); r.eq(by.h1_names_term.theirs, 'yes');
  r.eq(by.word_count.ours, '140'); r.eq(by.word_count.theirs, '610');
  r.eq(by.images.ours, '24 (3)'); r.eq(by.images.theirs, '30 (0)');
  r.eq(by.jsonld.theirs, 'CollectionPage, Product');
  const none = K.compareFacts('x', null, theirs);
  r.truthy(none.every((x) => x.ours === 'not captured'), 'missing side named on every row');
  r.truthy(!none.some((x) => /\b0\b/.test(x.ours)), 'never a zero for a missing capture');
  const failed = K.compareFacts('x', { fetch_error: 'timeout_after_15000ms' }, theirs);
  r.eq(failed[0].ours, 'fetch failed: timeout_after_15000ms');
});

console.log('\n── recommendations tab: grouping, evidence vocabulary, task pre-fill ──');
r.test('evidenceStrengthLabel only ever returns the three words, defaulting toward the weaker claim', () => {
  r.eq(K.evidenceStrengthLabel('strong'), 'strong');
  r.eq(K.evidenceStrengthLabel('moderate'), 'moderate');
  r.eq(K.evidenceStrengthLabel('early'), 'early');
  r.eq(K.evidenceStrengthLabel('90'), 'early', 'an unexpected value falls back to the weakest claim, never the strongest');
  r.eq(K.evidenceStrengthLabel(null), 'early');
});
r.test('groupRecommendations: fixed class order, each group sorted by score descending, absent classes omitted', () => {
  const groups = K.groupRecommendations([
    { opportunity_class: 'page_two', score: 10 },
    { opportunity_class: 'defend', score: 5 },
    { opportunity_class: 'defend', score: 50 },
    { opportunity_class: 'missing_category', score: 1 },
  ]);
  r.eq(groups.map((g) => g.opportunity_class).join(','), 'defend,page_two,missing_category', 'defend before page_two before missing_category, per RECOMMENDATION_CLASS_ORDER, and content_brief/absent_with_demand/page_one_not_top3 are simply absent');
  r.eq(groups[0].rows.map((x) => x.score).join(','), '50,5', 'within a class, highest score first');
  r.eq(groups[0].label, 'Defend');
  r.eq(K.groupRecommendations([]).length, 0);
  r.eq(K.groupRecommendations(null).length, 0);
});
r.test('groupRecommendations keeps an unrecognised class rather than dropping it', () => {
  const groups = K.groupRecommendations([{ opportunity_class: 'something_new', score: 1 }]);
  r.eq(groups.length, 1);
  r.eq(groups[0].label, 'something_new', 'no label mapping -- falls back to the raw class name, never blank');
});
r.test('mapPageTypeToTargetType maps the SERP page-type vocabulary onto seo_tasks.target_type\'s CHECK', () => {
  r.eq(K.mapPageTypeToTargetType('home'), 'site');
  r.eq(K.mapPageTypeToTargetType('collection'), 'collection');
  r.eq(K.mapPageTypeToTargetType('product'), 'product');
  r.eq(K.mapPageTypeToTargetType('article'), 'blog');
  r.eq(K.mapPageTypeToTargetType('video'), 'other');
  r.eq(K.mapPageTypeToTargetType('page'), 'page');
  r.eq(K.mapPageTypeToTargetType('other'), 'other');
  r.eq(K.mapPageTypeToTargetType('a-future-type'), 'other', 'an unknown type falls to other, never throws');
  r.eq(K.mapPageTypeToTargetType(null), null, 'no page type -- no guess, never a default target_type');
});
r.test('urlHandle takes the last path segment and is null, never empty, with nothing to take it from', () => {
  r.eq(K.urlHandle('https://www.baseballism.com/collections/backpacks'), 'backpacks');
  r.eq(K.urlHandle('https://www.baseballism.com/collections/backpacks?ref=x'), 'backpacks');
  r.eq(K.urlHandle('https://www.baseballism.com/'), null, 'the homepage has no segment to hand back');
  r.eq(K.urlHandle(''), null);
  r.eq(K.urlHandle(null), null);
});
r.test('canonicalTargetUrl strips the query string and fragment -- a SERP observation is evidence, not a destination', () => {
  // Found in the 2026-09-27 UI audit: a homepage ranked in a SERP carries
  // Google's srsltid click-tracking parameter, and the "Create SEO task"
  // dialog was prefilling that exact URL as the page to go work on.
  r.eq(K.canonicalTargetUrl('https://www.baseballism.com/?srsltid=AfmBOoo123abc'), 'https://www.baseballism.com/');
  r.eq(K.canonicalTargetUrl('https://www.baseballism.com/collections/hats?srsltid=xyz&utm_source=google'), 'https://www.baseballism.com/collections/hats');
  r.eq(K.canonicalTargetUrl('https://www.baseballism.com/collections/hats#reviews'), 'https://www.baseballism.com/collections/hats');
  r.eq(K.canonicalTargetUrl('https://www.baseballism.com/collections/hats'), 'https://www.baseballism.com/collections/hats', 'already clean -- unchanged');
  r.eq(K.canonicalTargetUrl(null), null);
  r.eq(K.canonicalTargetUrl(''), null);
});
r.test('taskPrefill: target_url is canonicalised, never the raw tracking-laden SERP observation', () => {
  const pf = K.taskPrefill({
    opportunity_class: 'defend', keyword: 'baseballism',
    our_url: 'https://www.baseballism.com/?srsltid=AfmBOoo123abc',
    suggested_action: 'evidence.',
  });
  r.eq(pf.target_url, 'https://www.baseballism.com/', 'srsltid stripped from the prefilled destination');
  r.eq(pf.target_handle, null, 'the homepage has no segment -- unaffected by the query string either way');
});
r.test('taskPrefill: target fields come from OUR page type/URL, rationale starts from suggested_action, title matches the class', () => {
  const rec = {
    opportunity_class: 'page_one_not_top3',
    keyword: 'baseball backpacks',
    our_page_type: 'collection',
    our_url: 'https://www.baseballism.com/collections/backpacks',
    suggested_action: 'We rank #6 on desktop for "baseball backpacks" (150 Search Console impressions, 28d). bl101.com ranks #1 with a collection page.',
  };
  const pf = K.taskPrefill(rec);
  r.eq(pf.target_type, 'collection');
  r.eq(pf.target_url, 'https://www.baseballism.com/collections/backpacks');
  r.eq(pf.target_handle, 'backpacks');
  r.eq(pf.rationale, rec.suggested_action, 'no captures on either side -- rationale is exactly the evidence sentence, nothing invented');
  r.eq(pf.proposed_title, 'Improve ranking for "baseball backpacks"');
});
r.test('taskPrefill appends the title-hypothesis sentence only when BOTH sides were captured and the words actually differ, worded as a hypothesis', () => {
  const withBoth = K.taskPrefill({
    opportunity_class: 'page_one_not_top3', keyword: 'baseball backpacks',
    our_captured_title: 'Backpacks | Baseballism Online', competitor_captured_title: 'Baseball Backpacks & Bags | BL101',
    suggested_action: 'evidence sentence.',
  });
  r.truthy(withBoth.rationale.includes('Hypothesis, not a cause'), 'the hypothesis sentence is added');
  r.truthy(withBoth.rationale.includes('their title names the term'), 'names which side names the term');
  const onlyOneCaptured = K.taskPrefill({
    opportunity_class: 'page_one_not_top3', keyword: 'x', our_captured_title: null,
    competitor_captured_title: 'X Guide', suggested_action: 'evidence sentence.',
  });
  r.eq(onlyOneCaptured.rationale, 'evidence sentence.', 'one side not captured -- no hypothesis is stated, per "not captured" never being treated as a fact');
  const bothNameIt = K.taskPrefill({
    opportunity_class: 'page_one_not_top3', keyword: 'baseball backpacks',
    our_captured_title: 'Baseball Backpacks | Baseballism', competitor_captured_title: 'Baseball Backpacks & Bags | BL101',
    suggested_action: 'evidence sentence.',
  });
  r.eq(bothNameIt.rationale, 'evidence sentence.', 'both titles already name the term -- nothing to hypothesise, so nothing is appended');
});
r.test('taskPrefill for missing_category: no single keyword, no page to target, title lists the cluster', () => {
  const pf = K.taskPrefill({
    opportunity_class: 'missing_category', keyword: 'baseball raglan',
    keyword_cluster: ['baseball raglan tee', 'baseball raglan sleeve'],
    suggested_action: '2 active keywords (baseball raglan sleeve, baseball raglan tee) share the opening phrase "baseball raglan" -- 100 combined Search Console impressions and 0 clicks (90d) -- and none has ever ranked in an observed SERP.',
  });
  r.eq(pf.target_url, null);
  r.eq(pf.target_handle, null);
  r.eq(pf.target_type, 'other', 'no page type on either side of a never-ranking cluster');
  r.eq(pf.proposed_title, 'Cover the "baseball raglan tee, baseball raglan sleeve" category');
});
r.test('taskPrefill falls back to the competitor page type when we have none of our own (we are absent)', () => {
  const pf = K.taskPrefill({ opportunity_class: 'absent_with_demand', keyword: 'x', competitor_page_type: 'article', suggested_action: 'evidence.' });
  r.eq(pf.target_type, 'blog');
  r.eq(pf.target_url, null, 'we have no page, so no target_url is guessed');
});

const out = r.summary();
process.exit(out.fail ? 1 : 0);
