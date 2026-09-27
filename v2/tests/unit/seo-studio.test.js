/* /v2/seo-studio.html's decisions: which page an opportunity belongs to,
 * what SILO can honestly say about that page, and the recommendation line.
 *
 * Why: the studio is where someone decides to edit a live page. A finding it
 * shows must come from data that exists, an absent value must read as absent
 * (never as fine, never as zero), and the page's priority must be the view's
 * own score -- so the studio can never disagree with the Recommendations tab. */
'use strict';

const { createReporter } = require('../lib/assert');
const { loadV2 } = require('../lib/load');

const S = loadV2(['seo-keywords.js', 'seo-studio.js']).SiloSeoStudio;
const r = createReporter('seo-studio');

const rec = (o) => Object.assign({
  opportunity_class: 'page_one_not_top3', keyword: 'baseball backpacks', keyword_cluster: null,
  our_url: 'https://www.baseballism.com/collections/backpacks?srsltid=AAA', our_page_type: 'collection',
  our_position: 4, device: 'desktop', score: 100, evidence_strength: 'moderate',
}, o);

console.log('\n── one page, one queue entry ──');
const recs = [
  rec({ keyword: 'baseball backpacks', our_position: 3, score: 300, evidence_strength: 'strong' }),
  rec({ keyword: 'baseball backpack', our_position: 4, score: 200, device: 'mobile', our_url: 'https://www.baseballism.com/collections/backpacks?srsltid=BBB' }),
  rec({ keyword: 'caps', our_url: 'https://www.baseballism.com/collections/caps', our_position: 4, score: 450, evidence_strength: 'early' }),
  rec({ opportunity_class: 'absent_with_demand', keyword: 'baseball gifts for boys', our_url: null, our_page_type: null, our_position: null, score: 120 }),
  rec({ opportunity_class: 'missing_category', keyword: null, keyword_cluster: ['raglan tee', 'raglan sleeve'], our_url: null, our_page_type: null, our_position: null, score: 90 }),
];
const q = S.groupByPage(recs);
r.test('two tracking-param variants of one URL are one page', () => {
  const bp = q.find((g) => g.path === '/collections/backpacks');
  r.truthy(bp, 'backpacks page missing');
  r.eq(bp.rows.length, 2);
  r.eq(bp.keywords.join('|'), 'baseball backpacks|baseball backpack');
});
r.test('a page\'s score is the SUM of its rows\' view scores, and the queue is ordered by it', () => {
  r.eq(q[0].path, '/collections/backpacks'); r.eq(q[0].score, 500);
  r.eq(q[1].path, '/collections/caps'); r.eq(q[1].score, 450);
});
r.test('a page\'s evidence is the best of its rows\', never an average', () => { r.eq(q[0].evidence, 'strong'); r.eq(q[1].evidence, 'early'); });
r.test('the best rank carries its keyword and device', () => { r.eq(q[0].bestRank.position, 3); r.eq(q[0].bestRank.keyword, 'baseball backpacks'); r.eq(q[0].bestRank.device, 'desktop'); });
r.test('an opportunity with no ranking page is "needs a page", never attached to another page', () => {
  const needs = q.filter((g) => g.kind === 'not_ranking');
  r.eq(needs.length, 2);
  r.truthy(needs.every((g) => g.path === null && g.bestRank === null), 'a needs-page entry claimed a page or a rank');
  r.eq(needs.find((g) => g.classes[0] === 'missing_category').keywords.join('|'), 'raglan tee|raglan sleeve');
});
r.test('rank range reads "#3–4", a single rank "#4", no rank null', () => {
  r.eq(S.rankRange(q[0]), '#3–4'); r.eq(S.rankRange(q[1]), '#4');
  r.eq(S.rankRange(q.find((g) => g.kind === 'not_ranking')), null);
});
r.test('empty or junk input yields an empty queue', () => { r.eq(S.groupByPage(null).length, 0); r.eq(S.groupByPage([null]).length, 0); });

console.log('\n── paths ──');
r.test('page kinds come from the URL shape, locale prefixes included', () => {
  r.eq(S.pathKind('/'), 'home');
  r.eq(S.pathKind('/collections/caps'), 'collection');
  r.eq(S.pathKind('/es/collections/texas-rangers'), 'collection');
  r.eq(S.pathKind('/collections/mlb/products/tee'), 'product');
  r.eq(S.pathKind('/products/tee'), 'product');
  r.eq(S.pathKind('/blogs/news/x'), 'article');
});
r.test('handles are read only from their own URL shapes', () => {
  r.eq(S.collectionHandle('/collections/Backpacks'), 'backpacks');
  r.eq(S.collectionHandle('/es/collections/texas-rangers'), 'texas-rangers');
  r.eq(S.collectionHandle('/collections/mlb/products/tee'), null);
  r.eq(S.productHandle('/collections/mlb/products/tee'), 'tee');
  r.eq(S.productHandle('/collections/caps'), null);
});
r.test('a title from a path is readable; the home page is named', () => {
  r.eq(S.titleFromPath('/collections/new-york-yankees'), 'New York Yankees'); r.eq(S.titleFromPath('/'), 'Home page');
});

console.log('\n── Search Console: absent is not zero ──');
r.test('no page rows is null (not returned), never zero traffic', () => { r.eq(S.pageStats([]), null); r.eq(S.pageStats(null), null); });
r.test('clicks and impressions sum; position is impression-weighted, never a plain mean', () => {
  const st = S.pageStats([{ clicks: 1, impressions: 100, position: 2 }, { clicks: 0, impressions: 900, position: 10 }]);
  r.eq(st.clicks, 1); r.eq(st.impressions, 1000); r.eq(st.avgPosition, 9.2); r.eq(st.ctr, 0.001);
});

console.log('\n── who ranks above us ──');
const results = [
  { position: 1, domain: 'www.bl101.com', result_type: 'organic', title: 'Baseball Backpacks & Bags | BL101' },
  { position: 2, domain: 'easton.rawlings.com', result_type: 'organic', title: 'Bags | Easton' },
  { position: 3, domain: 'www.baseballism.com', result_type: 'organic', is_own_domain: true, title: 'Backpacks | Baseballism Online' },
  { position: 4, domain: 'cheapbats.com', result_type: 'organic' },
  { position: 1, domain: 'shopping', result_type: 'shopping' },
];
r.test('only organic results strictly above us, our own storefront excluded, www stripped', () => {
  const a = S.aboveUs(results, 3);
  r.eq(a.map((x) => x.domain).join('|'), 'bl101.com|easton.rawlings.com');
});
r.test('when we are absent, the top of the page is shown', () => { r.eq(S.aboveUs(results, null).length, 3); });
r.test('our observed title is read from our own result', () => { r.eq(S.ourObservedTitle(results), 'Backpacks | Baseballism Online'); r.eq(S.ourObservedTitle([]), null); });

console.log('\n── findings are observations, each with its source ──');
const longDesc = 'Baseballism Backpack Collection\nBuilt for Ballplayers. ' + 'x'.repeat(2200);
const base = {
  keyword: 'baseball backpacks', brandWords: ['baseballism'],
  serpTitle: 'Backpacks | Baseballism Online', competitorTitle: 'Baseball Backpacks & Bags | BL101', competitorPosition: 1,
  isCollection: true, collection: { description: '<p>An intro.</p>', seo_description_override: longDesc }, inspection: null,
};
const f1 = S.findings(base);
const keys = (fs) => fs.map((x) => x.key);
r.test('a title that does not name the term is a negative finding quoting the result that does', () => {
  const t = f1.find((x) => x.key === 'title_missing_term');
  r.truthy(t, 'missing'); r.eq(t.tone, 'neg');
  r.truthy(/Baseball Backpacks/.test(t.title), t.title);
  r.truthy(/#1 result is titled “Baseball Backpacks & Bags \| BL101”/.test(t.detail), t.detail);
});
r.test('a description past Google\'s cut-off is named with its length', () => {
  const d = f1.find((x) => x.key === 'description_too_long');
  r.truthy(d, 'missing'); r.truthy(/characters/.test(d.title) && /about 155/.test(d.detail), d.title + d.detail);
});
r.test('an intro that exists is a positive finding', () => { r.truthy(keys(f1).includes('intro_present')); });
r.test('a page never inspected is "not checked" with an Inspect action, never a pass or a fail', () => {
  const n = f1.find((x) => x.key === 'not_inspected');
  r.eq(n.tone, 'info'); r.eq(n.action, 'inspect');
  r.truthy(!keys(f1).some((k) => /^h1_|^alt_/.test(k)), 'claimed heading/alt findings without an inspection');
});
r.test('no description set is its own finding, distinct from too long', () => {
  const f = S.findings(Object.assign({}, base, { collection: { description: '', seo_description_override: null } }));
  r.truthy(keys(f).includes('description_missing')); r.truthy(!keys(f).includes('description_too_long'));
  r.truthy(keys(f).includes('intro_missing'));
});
r.test('an unknown collection (not synced) makes no description or intro claim at all', () => {
  const f = S.findings(Object.assign({}, base, { collection: null }));
  r.truthy(!keys(f).some((k) => /^description_|^intro_/.test(k)), keys(f).join(','));
});
r.test('a title that names the term is positive; a brand word is not required of it', () => {
  const f = S.findings(Object.assign({}, base, { keyword: 'baseballism backpack', serpTitle: 'Backpacks | Shop' }));
  r.truthy(keys(f).includes('title_names_term'), keys(f).join(','));
});
r.test('no observed title makes no title claim', () => {
  const f = S.findings(Object.assign({}, base, { serpTitle: null }));
  r.truthy(!keys(f).some((k) => /^title_/.test(k)));
});
r.test('an inspection supplies heading and alt findings', () => {
  const f = S.findings(Object.assign({}, base, { inspection: { h1: ['Backpacks'], images_missing_alt: 3, http_status: 200 } }));
  r.truthy(keys(f).includes('h1_missing_term')); r.truthy(f.find((x) => x.key === 'alt_missing').title.startsWith('3 images'));
  r.truthy(!keys(f).includes('not_inspected'));
});
r.test('a failed inspection is not read as a clean page', () => {
  const f = S.findings(Object.assign({}, base, { inspection: { fetch_error: 'timeout', h1: [] } }));
  r.truthy(keys(f).includes('inspection_failed')); r.truthy(!keys(f).includes('h1_missing'));
});

console.log('\n── the recommendation line ──');
r.test('built from the negative findings, in a fixed order', () => {
  r.eq(S.headline(f1, 'baseball backpacks', ['baseballism']), 'Say “Baseball Backpacks” in the title, and cut the search description to one sentence');
});
r.test('nothing specific found means no headline, never an invented one', () => {
  r.eq(S.headline([{ key: 'title_names_term', tone: 'pos' }], 'caps'), null);
});

console.log('\n── Ask SILO prompt ──');
r.test('carries the evidence and never asks to publish', () => {
  const p = S.askSiloPrompt(q[0], { serpTitle: 'Backpacks | Baseballism Online', found: f1 });
  r.truthy(p.includes('/collections/backpacks') && p.includes('#3 for "baseball backpacks"') && p.includes('Backpacks | Baseballism Online'), p);
  r.truthy(/do not publish/i.test(p), 'the prompt must say not to publish');
});

console.log('\n── Review → Draft → Approve → Measure ──');
r.test('no task is Review; a draft or proposed task is Draft', () => {
  r.eq(S.stepFor([], []).step, 'review');
  r.eq(S.stepFor([{ id: 'a', approval_status: 'draft', created_at: '2026-09-01' }], []).step, 'draft');
  r.eq(S.stepFor([{ id: 'a', approval_status: 'proposed', created_at: '2026-09-01' }], []).label, 'Proposed — waiting for approval');
});
r.test('approved is Approve; a publication moves it to Measure', () => {
  const t = [{ id: 'a', approval_status: 'approved', created_at: '2026-09-01' }];
  r.eq(S.stepFor(t, []).step, 'approve');
  r.eq(S.stepFor(t, [{ task_id: 'a' }]).step, 'measure');
});
r.test('an older publication never hides a newer draft', () => {
  const t = [{ id: 'old', approval_status: 'approved', created_at: '2026-08-01' }, { id: 'new', approval_status: 'draft', created_at: '2026-09-20' }];
  const s = S.stepFor(t, [{ task_id: 'old' }]);
  r.eq(s.step, 'draft'); r.eq(s.task.id, 'new');
});
r.test('the newest task, published, is Measure', () => {
  const t = [{ id: 'old', approval_status: 'draft', created_at: '2026-08-01' }, { id: 'new', approval_status: 'approved', created_at: '2026-09-20' }];
  r.eq(S.stepFor(t, [{ task_id: 'new' }]).step, 'measure');
});

console.log('\n── Not ranking is not "no page" ──');
r.test('a task for a not-ranking opportunity needs existing-or-new', () => {
  r.eq(S.targetDecision('not_ranking', null, '').ok, false);
  r.eq(S.targetDecision('not_ranking', 'existing', '').ok, false);
  r.eq(S.targetDecision('not_ranking', 'existing', 'javascript:x').ok, false);
  const e = S.targetDecision('not_ranking', 'existing', 'https://www.baseballism.com/collections/bags');
  r.eq(e.ok, true); r.has(e.note, 'existing page');
  const n = S.targetDecision('not_ranking', 'new', '');
  r.eq(n.ok, true); r.has(n.note, 'new page');
  r.eq(S.targetDecision('page', null, '').ok, true, 'a ranking page needs no decision');
});
r.test('the Ask SILO prompt for a not-ranking opportunity says check for an existing page', () => {
  r.has(S.askSiloPrompt({ kind: 'not_ranking', title: 'bags', keywords: ['bags'] }, {}), 'existing page');
});
r.test('a rejected task never advances the page, but is named', () => {
  const s = S.stepFor([{ id: 'a', approval_status: 'rejected', created_at: '2026-09-01' }], [{ task_id: 'a' }]);
  r.eq(s.step, 'review'); r.eq(s.label, 'A previous task was rejected');
});

console.log('\n── Collection photos: newest live first ──');
const pm = (id, o) => Object.assign({ shopify_product_id: id, product_title: 'P' + id, image_url: 'https://cdn/' + id + '.jpg', shopify_status: 'active', online_published_at: null }, o);
r.test('live products come first, newest publication first', () => {
  const out = S.pickCollectionPhotos(['1', '2', '3', '4'], [
    pm('1', { online_published_at: '2025-03-01T00:00:00Z' }),
    pm('2', { shopify_status: 'draft', online_published_at: '2026-09-20T00:00:00Z' }),
    pm('3', { online_published_at: '2026-09-01T00:00:00Z' }),
    pm('4', { online_published_at: null }),
  ]);
  r.eq(out.map(x => x.shopify_product_id).join(','), '3,1', 'a draft and an unpublished product are not live');
  r.eq(out[0].published_at, '2026-09-01T00:00:00Z');
});
r.test('only products in the collection, one photo per product, https only', () => {
  const out = S.pickCollectionPhotos(['1', '2'], [
    pm('1', { online_published_at: '2026-01-01T00:00:00Z' }),
    pm('1', { online_published_at: '2026-01-01T00:00:00Z', image_url: 'https://cdn/1b.jpg' }),
    pm('2', { online_published_at: '2026-02-01T00:00:00Z', image_url: 'http://cdn/2.jpg' }),
    pm('9', { online_published_at: '2026-09-01T00:00:00Z' }),
  ]);
  r.eq(out.length, 1); r.eq(out[0].shopify_product_id, '1');
});
r.test('nothing live: collection position order stands in, capped at n', () => {
  const out = S.pickCollectionPhotos(['3', '1', '2'], [pm('1', { shopify_status: 'archived' }), pm('2'), pm('3')], 2);
  r.eq(out.map(x => x.shopify_product_id).join(','), '3,1');
  r.eq(out[0].published_at, null);
});
r.test('empty inputs give no photos', () => {
  r.eq(S.pickCollectionPhotos([], []).length, 0);
  r.eq(S.pickCollectionPhotos(null, null).length, 0);
});

const out = r.summary();
process.exit(out.fail ? 1 : 0);
