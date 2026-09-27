/* /v2/ad-studio.html's decisions: how ads become baselines, what a number's
 * evidence is, what the studio says about an ad, and the bar an idea is held
 * to.
 *
 * Why: Ad Studio is where someone decides what to make next from what worked.
 * A rate averaged instead of pooled, an absent measure read as zero, or a bar
 * that moves after an idea launches would each send that decision the wrong
 * way while looking precise. */
'use strict';

const { createReporter } = require('../lib/assert');
const { loadV2 } = require('../lib/load');

const A = loadV2(['ad-studio.js']).SiloAdStudio;
const r = createReporter('ad-studio');

const ad = (o) => Object.assign({
  ad_id: 'a', ad_name: 'Ad', objective: 'purchase', spend: 1000, impressions: 100000, clicks: 1500,
  conversions: 40, conversion_value: 4000, thruplays: null, leads: null,
  first_day: '2026-08-01', last_day: '2026-09-20', data_through: '2026-09-20', days_with_spend: 50,
  recent_spend: 100, recent_impressions: 10000, recent_clicks: 150, early_impressions: 20000, early_clicks: 300,
}, o);

console.log('\n── pooled, never averaged ──');
r.test('the objective baseline pools sums; it is not the mean of per-ad ROAS', () => {
  // ROAS 2 on $100 and ROAS 8 on $10,000: pooled 7.94, averaged 5.
  const ads = [ad({ ad_id: 'x', spend: 100, conversion_value: 200 }), ad({ ad_id: 'y', spend: 10000, conversion_value: 80000 })];
  const b = A.baseline(ads, 'purchase');
  r.eq(Math.round(b.value * 100) / 100, 7.94);
  r.eq(b.ads, 2);
});
r.test('ads under the spend floor do not shape the baseline', () => {
  const b = A.baseline([ad({ spend: 50, conversion_value: 5000 }), ad({ ad_id: 'b', spend: 1000, conversion_value: 2000 })], 'purchase');
  r.eq(b.value, 2);
  r.eq(b.ads, 1);
});
r.test('each objective is judged on the metric it was bought on', () => {
  r.eq(A.objective('purchase').primary, 'roas');
  r.eq(A.objective('thruplay').primary, 'cost_per_thruplay');
  r.eq(A.objective('subscribers').primary, 'cost_per_lead');
  r.eq(A.objective('traffic').primary, 'cpc');
  r.eq(A.objective('nonsense').key, 'other', 'an unknown objective is "other", never dropped');
});

console.log('\n── absent is not zero ──');
r.test('a measure no row reported stays null through pooling', () => {
  const s = A.pool([ad({ thruplays: null }), ad({ thruplays: null })]);
  r.eq(s.thruplays, null);
  r.eq(A.metric(s, 'cost_per_thruplay'), null);
});
r.test('a zero denominator is null, not infinity or zero', () => {
  r.eq(A.metric(A.pool([ad({ conversions: 0 })]), 'cpa'), null);
  r.eq(A.metric(A.pool([ad({ spend: 0, conversion_value: 0 })]), 'roas'), null);
});

console.log('\n── evidence from volume ──');
r.test('ROAS on a handful of conversions is early and is not ranked', () => {
  const scored = A.score([ad({ ad_id: 'few', conversions: 3, conversion_value: 3000 }), ad({ ad_id: 'many' })]);
  const few = scored.find((x) => x.ad_id === 'few');
  r.eq(few.evidence, 'early');
  r.eq(few.index, null, 'a 3-conversion ROAS of 3x never tops the gallery');
  r.eq(A.rank(scored)[0].ad_id, 'many');
});
r.test('evidence is a word, never a percentage', () => {
  const ev = A.evidence(A.pool([ad({ conversions: 60 })]), 'roas');
  r.eq(ev, 'strong');
  r.eq(A.evidence(A.pool([ad({ conversions: 20 })]), 'roas'), 'moderate');
});
r.test('index is direction-adjusted: a lower cost is better', () => {
  r.eq(A.indexVs(2, 4, 'cpa'), 2);
  r.eq(A.indexVs(8, 4, 'roas'), 2);
  r.eq(A.indexVs(null, 4, 'roas'), null);
});

console.log('\n── images ──');
r.test('the archived image wins; an expired Meta thumbnail is not drawn', () => {
  const now = Date.parse('2026-10-05T00:00:00Z');
  const a = ad({ image_path: 'co/abc.jpg', thumbnail_url: 'https://scontent.xx.fbcdn.net/x.jpg?oe=6ABE26B1' });
  r.eq(A.imageFor(a, { 'co/abc.jpg': 'https://x.supabase.co/signed' }, now).kind, 'archived');
  r.eq(A.imageFor(a, {}, now).kind, 'none', 'the fbcdn URL expired on 1 Oct');
  r.eq(A.imageFor(a, {}, Date.parse('2026-09-28T00:00:00Z')).kind, 'meta_thumbnail', 'still valid before then');
});
r.test('a signed URL that is not https is never used', () => {
  r.eq(A.imageFor(ad({ image_path: 'p' }), { p: 'javascript:alert(1)' }, 0).kind, 'none');
});
r.test('an image shared by several ads is flagged as a template, and its format as catalog', () => {
  const t = ad({ image_path: 'p', image_shared_by: 5, object_type: 'SHARE' });
  r.eq(A.imageFor(t, { p: 'https://s/p' }, 0).template, true);
  r.eq(A.formatOf(t), 'catalog');
  r.eq(A.formatOf(ad({ object_type: 'VIDEO' })), 'video');
});

console.log('\n── findings ──');
r.test('findings compare with the baseline and name the evidence', () => {
  const ads = [ad({ ad_id: 'w', conversion_value: 8000 }), ad({ ad_id: 'b1', conversion_value: 2000 }), ad({ ad_id: 'b2', conversion_value: 2000 })];
  const base = A.baseline(ads, 'purchase');
  const f = A.findings(ads[0], base, { purchase: 3000 });
  r.has(f[0].title, 'ROAS 8.00');
  r.has(f[0].title, 'baseline');
  r.eq(f[0].tone, 'pos');
  r.has(f[0].detail, 'Moderate evidence');
});
r.test('an early metric says what it needs instead of comparing', () => {
  const f = A.findings(ad({ conversions: 4 }), A.baseline([ad()], 'purchase'), {});
  r.has(f[0].title, 'is early');
  r.has(f[0].detail, '15 are needed');
});
r.test('fatigue: a running ad whose CTR fell from its first two weeks is flagged', () => {
  const tired = ad({ early_clicks: 400, early_impressions: 20000, recent_clicks: 100, recent_impressions: 10000 });
  const f = A.findings(tired, A.baseline([tired], 'purchase'), {});
  r.truthy(f.some((x) => /Click-through down 50%/.test(x.title)));
  const ended = Object.assign({}, tired, { last_day: '2026-08-01', recent_spend: null });
  r.truthy(!A.findings(ended, A.baseline([ended], 'purchase'), {}).some((x) => /down/.test(x.title)), 'an ended ad is not "fatigued"');
});
r.test('a shared template is said out loud', () => {
  const f = A.findings(ad({ image_shared_by: 4 }), null, {});
  r.truthy(f.some((x) => /Same image as 4 other ads/.test(x.title)));
});
r.test('hook is the first sentence of the copy', () => {
  r.eq(A.firstLine('Hoodie weather is here. Grab yours.\nFree shipping'), 'Hoodie weather is here.');
  r.eq(A.firstLine(''), '');
});

console.log('\n── ideas ──');
r.test('the bar is the baselines’ pooled metric, frozen with its window', () => {
  const s = A.snapshot([ad({ ad_id: '1', spend: 100, conversion_value: 200 }), ad({ ad_id: '2', spend: 100, conversion_value: 600 })],
    { start: '2025-09-21', through: '2026-09-20' });
  r.eq(s.metric, 'roas');
  r.eq(s.value, 4);
  r.eq(s.ad_ids, ['1', '2']);
  r.eq(s.data_through, '2026-09-20');
});
r.test('a launched idea is measured only once it reaches the evidence floor', () => {
  const idea = { live_ad_ids: ['L'], baseline_snapshot: { metric: 'roas', value: 4 } };
  r.eq(A.measureIdea(idea, { L: ad({ ad_id: 'L', conversions: 5, conversion_value: 9000 }) }).state, 'early');
  const beat = A.measureIdea(idea, { L: ad({ ad_id: 'L', conversions: 30, conversion_value: 5000 }) });
  r.eq(beat.state, 'beating');
  r.eq(A.measureIdea(idea, { L: ad({ ad_id: 'L', conversions: 30, conversion_value: 3000 }) }).state, 'behind');
  r.eq(A.measureIdea({ live_ad_ids: [], baseline_snapshot: { metric: 'roas', value: 4 } }, {}).state, 'not_live');
  r.eq(A.measureIdea({ live_ad_ids: ['gone'], baseline_snapshot: { metric: 'roas', value: 4 } }, {}).state, 'no_data');
});
r.test('validation mirrors the table: title, https destination, live needs ads', () => {
  r.eq(A.validateIdea({ title: ' ' }).length, 1);
  r.has(A.validateIdea({ title: 'x', destination_url: 'javascript:1' })[0], 'https');
  r.has(A.validateIdea({ title: 'x', status: 'live', live_ad_ids: [] })[0], 'live');
  r.eq(A.validateIdea({ title: 'x', status: 'live', live_ad_ids: ['1'] }).length, 0);
});
r.test('an idea from an ad carries its hook, objective, format and a clean destination', () => {
  const i = A.ideaFromAds([ad({ ad_id: '9', ad_name: 'Gus Hoodie', body: 'Hoodie weather. Shop now.', object_type: 'PHOTO',
    link_url: 'https://www.baseballism.com/collections/hoodies?utm_source=fb' })], { start: 's', through: 't' });
  r.has(i.title, 'Gus Hoodie');
  r.eq(i.hook, 'Hoodie weather.');
  r.eq(i.format, 'image');
  r.eq(i.destination_url, 'https://www.baseballism.com/collections/hoodies');
  r.eq(i.baseline_ad_ids, ['9']);
  r.eq(i.baseline_snapshot.metric, 'roas');
});
r.test('a Facebook post is never offered as a destination', () => {
  r.eq(A.destinationOf({ link_url: 'https://www.facebook.com/baseballism/posts/1' }), null);
  r.eq(A.destinationOf({ link_url: 'javascript:alert(1)' }), null);
});
r.test('the Ask SILO prompt names each baseline with its numbers and asks for no predictions', () => {
  const p = A.askSiloPrompt([ad({ ad_id: '9', ad_name: 'Gus Hoodie', body: 'Hoodie weather.' })], A.baseline([ad()], 'purchase'));
  r.has(p, 'Gus Hoodie');
  r.has(p, 'ad 9');
  r.has(p, 'ROAS');
  r.has(p, 'Do not predict results.');
});

console.log('\n── wording and copy ──');
r.test('a cost is compared as a cost: higher cost with the difference, never "% below baseline"', () => {
  const worse = A.compare(0.62, 0.51, 'cpa');
  r.eq(worse.tone, 'neg');
  r.eq(worse.short, 'Higher cost · +$0.11');
  r.has(worse.long, 'Costs 22% more than the $0.51 baseline');
  r.truthy(!/below/.test(worse.short + worse.long), 'no "below" beside a higher cost');
  const better = A.compare(0.40, 0.51, 'cpc');
  r.eq(better.tone, 'pos');
  r.eq(better.short, 'Lower cost · −$0.11');
  r.eq(A.compare(0.50, 0.51, 'cpc').tone, 'info');
});
r.test('a rate or ROAS reads as a multiple or a shortfall', () => {
  r.eq(A.compare(6, 4.73, 'roas').short, '1.3× the baseline');
  r.eq(A.compare(3, 4.73, 'roas').short, '37% under the baseline');
  r.eq(A.compare(3, 4.73, 'roas', 'bar').short, '37% under the bar');
  r.eq(A.compare(null, 4.73, 'roas'), null);
});
r.test('a cost-per-purchase finding says higher cost, not "below baseline"', () => {
  const base = A.baseline([ad({ ad_id: 'b', spend: 1000, conversions: 100 })], 'purchase');
  base.value = 0.5; // judged on cost per purchase for this check
  const f = A.findings(ad({ objective: 'subscribers', spend: 600, leads: 1000 }), { value: 0.5, ads: 3, minSpend: 100, sums: base.sums }, {});
  r.has(f[0].detail, 'Costs 20% more than the $0.50 baseline');
});
r.test('catalog placeholders never reach a hook or the Ask SILO prompt', () => {
  const body = 'Shop {{product.brand}} gear. {{product.name}} ships free.';
  r.eq(A.templateFields(body), ['{{product.brand}}', '{{product.name}}']);
  r.eq(A.firstLine(body), 'Shop gear.');
  r.eq(A.firstLine('{{product.brand}} {{product.name}}'), '', 'a line that was only placeholders is no hook');
  r.eq(A.firstLine('{{product.brand}} | Hoodie weather is here.'), 'Hoodie weather is here.');
  const i = A.ideaFromAds([ad({ ad_id: '7', body: '{{product.brand}} — Hoodie weather is here.' })], {});
  r.eq(i.hook, 'Hoodie weather is here.');
  const p = A.askSiloPrompt([ad({ ad_id: '7', body: '{{product.brand}} {{product.price}}' })], null);
  r.truthy(!p.includes('{{'), 'no placeholder in the prompt');
  r.has(p, 'catalog ad');
  r.truthy(A.findings(ad({ body: body }), null, {}).some((x) => /catalog placeholders/.test(x.title)));
});
r.test('the bar can be the picked ads or the objective baseline, and records both', () => {
  const winners = [ad({ ad_id: '1', spend: 100, conversions: 60, conversion_value: 1700 }), ad({ ad_id: '2', spend: 100, conversions: 60, conversion_value: 1714 })];
  const all = winners.concat([ad({ ad_id: '3', spend: 10000, conversion_value: 32000 })]);
  const b = A.baseline(all, 'purchase');
  const sel = A.snapshot(winners, {}, { objectiveBaseline: b });
  r.eq(sel.basis, 'selected');
  r.eq(sel.value, 17.07);
  r.eq(sel.objective_baseline.value, Math.round(b.value * 10000) / 10000);
  const obj = A.snapshot(winners, {}, { objectiveBaseline: b, basis: 'objective' });
  r.eq(obj.basis, 'objective');
  r.eq(obj.value, sel.objective_baseline.value);
  r.eq(obj.ad_ids, ['1', '2'], 'the ideas it came from are kept whichever bar is chosen');
  const other = A.snapshot(winners, {}, { objectiveBaseline: A.baseline(all, 'traffic'), basis: 'objective' });
  r.eq(other.basis, 'selected', 'another objective’s baseline is never used as the bar');
});
r.test('a live idea’s note says the result in the metric’s own terms', () => {
  const idea = { live_ad_ids: ['L'], baseline_snapshot: { metric: 'cost_per_lead', value: 0.5 } };
  const m = A.measureIdea(idea, { L: ad({ ad_id: 'L', objective: 'subscribers', spend: 600, leads: 1000 }) });
  r.eq(m.state, 'behind');
  r.has(m.note, 'Higher cost · +$0.10');
});

console.log('\n── cache ──');
r.test('the page loads the CURRENT ad-studio.js, never a cached older copy', () => {
  // The page and its script deploy together but cache apart: a new page with
  // yesterday's script threw "A.compare is not a function" on first load
  // (2026-09-27). The ?v= stamp is the file's own hash, so it changes exactly
  // when the script does.
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const dir = path.join(__dirname, '..', '..');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'ad-studio.js'))).digest('hex').slice(0, 12);
  r.has(fs.readFileSync(path.join(dir, 'ad-studio.html'), 'utf8'), `ad-studio.js?v=${hash}`);
});

const out = r.summary();
process.exit(out.fail ? 1 : 0);
