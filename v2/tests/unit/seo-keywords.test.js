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

const out = r.summary();
process.exit(out.fail ? 1 : 0);
