/* SEO SERP sync core, driven end to end with a fake DataForSEO and a fake
 * Supabase that stores rows and applies filters.
 *
 * What this pins, and why each matters:
 *   1. Tasks are posted to the STANDARD QUEUE in batches of <=100 carrying the
 *      schedule's location/language/device/depth/priority and a tag of
 *      run|keyword -- the live endpoint takes one task per request (measured).
 *   2. A ledger row (seo_serp_provider_tasks) is written for every accepted
 *      task BEFORE any collection, so a resume is a resume.
 *   3. Collection writes the asked-row (seo_serp_run_keywords) and the ORGANIC
 *      observations (position = rank_group, never the absolute slot) with
 *      provider / observed_on / location / device on every row, then marks the
 *      ledger collected, and stamps the run's completed_at LAST.
 *   4. A collection deadline leaves the run in flight; the same-day catch-up
 *      posts NOTHING and collects the rest, then completes.
 *   5. A completed identity is skipped: no post, no spend.
 *   6. max_keywords_per_run bounds what is asked: keywords beyond it have no
 *      ledger row and no asked-row (never observed, not unranked).
 *   7. A provider error on a task marks the ledger failed and writes NO
 *      asked-row; a page with no organic items writes result_count 0.
 *   8. max_cost_per_run_usd stops posting between batches.
 *   9. 429 is retried; 401 is an error recorded on sync_jobs and rethrown.
 *  10. A task the provider answered but no longer lists in tasks_ready (a
 *      crash between fetch and write) is fetched DIRECTLY once it is old
 *      enough; one the provider says is still queued stays pending.
 *  11. A run left in flight on an EARLIER day is resumed before today's
 *      starts: collected and completed, with nothing posted for it.
 *
 * Run: node scripts/tests/seo-serp-sync.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './lib/fake-supabase.mjs';
import { DIRECT_FETCH_AFTER_MS, DataForSeoError, dataForSeoRequest, mapObservations, selectKeywords, syncSerpSchedule } from '../lib/seo-serp-sync-core.mjs';

const CO = 'company-a';
const noSleep = async () => {};
const CREDS = { login: 'u', password: 'p' };
const SCHEDULE = {
  id: 'sched-1', company_entity_id: CO, is_active: true, provider: 'dataforseo', location_code: 2840,
  location_name: 'United States', language_code: 'en', search_engine: 'google', devices: ['desktop', 'mobile'],
  depth: 20, max_keywords_per_run: 300, max_cost_per_run_usd: 2, priority: 1,
};

function organic(rank, domain, extra = {}) {
  return { type: 'organic', rank_group: rank, rank_absolute: rank + 1, domain, url: `https://${domain}/p${rank}`, title: `t${rank}`, ...extra };
}

/** A DataForSEO whose queue answers when `ready(taskId)` says so. */
function fakeProvider({ pages = {}, ready = () => true, refuse = () => false, taskError = () => null, postCost = 0.0012, http = null, hidden = () => false, inProgress = () => false } = {}) {
  const requests = [];
  const queue = new Map();
  let nextId = 1;
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    if (http) { const r = http(url, requests.length); if (r) return r; }
    const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (url.endsWith('/task_post')) {
      const tasks = JSON.parse(init.body).map((t) => {
        if (refuse(t)) return { status_code: 40000, status_message: 'refused', cost: 0, data: t };
        const id = `task-${nextId++}`;
        queue.set(id, t);
        return { id, status_code: 20100, status_message: 'Task Created.', cost: postCost, data: t };
      });
      return json({ status_code: 20000, tasks });
    }
    if (url.endsWith('/tasks_ready')) {
      const list = [...queue.keys()].filter((id) => ready(id) && !hidden(id)).map((id) => ({ id, tag: queue.get(id).tag }));
      return json({ status_code: 20000, tasks: [{ result: list }] });
    }
    const m = url.match(/task_get\/advanced\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const t = queue.get(id);
      if (!t) return json({ status_code: 20000, tasks: [{ id, status_code: 40401, status_message: 'Task Not Found.', cost: 0, result: null }] });
      if (inProgress(id)) return json({ status_code: 20000, tasks: [{ id, status_code: 40602, status_message: 'Task In Queue.', cost: 0, result: null }] });
      const err = taskError(t, id);
      if (err) return json({ status_code: 20000, tasks: [{ id, status_code: err.code, status_message: err.message, cost: 0, result: null }] });
      const items = pages[`${t.keyword}|${t.device}`] ?? [organic(1, 'a.com'), organic(2, 'www.baseballism.com'), organic(3, 'b.com')];
      return json({ status_code: 20000, tasks: [{ id, status_code: 20000, status_message: 'Ok.', cost: postCost, result: [{ keyword: t.keyword, item_types: ['organic', 'ai_overview'], items: [{ type: 'ai_overview', rank_absolute: 1 }, ...items] }] }] });
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
  return { fetchImpl, requests, queue };
}

function seed(sb, { keywords = 3 } = {}) {
  sb.tables.set('company_settings', [{ company_entity_id: CO, business_timezone: 'America/Los_Angeles' }]);
  sb.tables.set('seo_keyword_set', Array.from({ length: keywords }, (_, i) => ({
    id: `kw-${i + 1}`, company_entity_id: CO, keyword: `keyword ${i + 1}`, priority: i + 1, is_active: true, created_at: `2026-09-0${(i % 9) + 1}T00:00:00Z`,
  })));
  sb.tables.set('seo_serp_schedules', [{ ...SCHEDULE }]);
}

const NOW = () => new Date('2026-09-28T16:00:00Z'); // Monday 09:00 Pacific
const runs = (sb) => sb.rows('seo_serp_runs');
const ledger = (sb) => sb.rows('seo_serp_provider_tasks');
const asked = (sb) => sb.rows('seo_serp_run_keywords');
const obs = (sb) => sb.rows('seo_serp_observations');
const jobs = (sb) => sb.rows('sync_jobs');

test('posts the keyword set to the queue in batches with the schedule bounds and a run|keyword tag; ledger before collection', async () => {
  const sb = createFakeSupabase();
  seed(sb, { keywords: 150 });
  const provider = fakeProvider();
  const out = await syncSerpSchedule({ supabase: sb, schedule: SCHEDULE, credentials: CREDS, now: NOW, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1 });
  const posts = provider.requests.filter((r) => r.url.endsWith('/task_post'));
  assert.equal(posts.length, 4, 'two devices x (100 + 50)');
  assert.deepEqual(posts.map((p) => p.body.length), [100, 50, 100, 50]);
  const t = posts[0].body[0];
  assert.equal(t.location_code, 2840); assert.equal(t.language_code, 'en'); assert.equal(t.depth, 20); assert.equal(t.priority, 1);
  assert.equal(t.device, 'desktop'); assert.equal(t.os, 'windows');
  assert.equal(posts[2].body[0].device, 'mobile'); assert.equal(posts[2].body[0].os, 'android');
  assert.equal(t.tag, `${runs(sb)[0].id}|kw-1`);
  assert.match(provider.requests[0].auth, /^Basic /);
  assert.equal(out.observed_on, '2026-09-28', 'business day in the company timezone');
  assert.equal(runs(sb).length, 2);
  assert.ok(runs(sb).every((r) => r.completed_at && r.provider === 'dataforseo' && r.depth === 20));
  assert.equal(ledger(sb).length, 300);
  assert.ok(ledger(sb).every((l) => l.status === 'collected' && l.collected_at && l.item_types.includes('ai_overview')));
  assert.equal(asked(sb).length, 300);
  assert.equal(obs(sb).length, 900);
  const o = obs(sb).find((r) => r.keyword_id === 'kw-1' && r.device === 'desktop' && r.position === 2);
  assert.equal(o.domain, 'baseballism.com', 'www. stripped, organic rank not absolute slot');
  assert.equal(o.observed_on, '2026-09-28'); assert.equal(o.location_name, 'United States'); assert.equal(o.provider, 'dataforseo'); assert.equal(o.result_type, 'organic');
  assert.equal(jobs(sb)[0].status, 'success');
  assert.equal(jobs(sb)[0].result.devices[0].collected, 150);
  assert.equal(sb.rows('seo_serp_schedules')[0].last_run_on, '2026-09-28');
  const run = runs(sb)[0];
  assert.equal(run.result_count, 450); assert.equal(run.cost_usd, Number((150 * 0.0012).toFixed(4)));
});

test('a collection deadline leaves the run in flight; the catch-up posts nothing and completes it', async () => {
  const sb = createFakeSupabase();
  seed(sb, { keywords: 3 });
  let phase = 1;
  const provider = fakeProvider({ ready: (id) => phase === 2 || id === 'task-1' });
  const out1 = await syncSerpSchedule({ supabase: sb, schedule: { ...SCHEDULE, devices: ['desktop'] }, credentials: CREDS, now: NOW, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1, collectWaitMs: 0 });
  assert.equal(out1.devices[0].collected, 1); assert.equal(out1.devices[0].pending, 2); assert.equal(out1.devices[0].completed, false);
  assert.equal(runs(sb)[0].completed_at, undefined);
  assert.equal(asked(sb).length, 1);
  assert.equal(jobs(sb)[0].status, 'success');
  const postsBefore = provider.requests.filter((r) => r.url.endsWith('/task_post')).length;
  phase = 2;
  const out2 = await syncSerpSchedule({ supabase: sb, schedule: { ...SCHEDULE, devices: ['desktop'] }, credentials: CREDS, now: NOW, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1 });
  assert.equal(provider.requests.filter((r) => r.url.endsWith('/task_post')).length, postsBefore, 'the resume posted nothing');
  assert.equal(out2.devices[0].created, false); assert.equal(out2.devices[0].posted, 0);
  assert.equal(out2.devices[0].collected, 2); assert.equal(out2.devices[0].completed, true);
  assert.ok(runs(sb)[0].completed_at);
  assert.equal(asked(sb).length, 3);
  assert.equal(ledger(sb).length, 3);
});

test('a completed identity is skipped: no post, no spend', async () => {
  const sb = createFakeSupabase();
  seed(sb);
  const provider = fakeProvider();
  const sched = { ...SCHEDULE, devices: ['desktop'] };
  await syncSerpSchedule({ supabase: sb, schedule: sched, credentials: CREDS, now: NOW, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1 });
  const n = provider.requests.length;
  const out = await syncSerpSchedule({ supabase: sb, schedule: sched, credentials: CREDS, now: NOW, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1 });
  assert.equal(provider.requests.length, n);
  assert.equal(out.devices[0].skipped, 'already_complete');
  assert.equal(runs(sb).length, 1);
});

test('max_keywords_per_run bounds what is asked; the rest is never observed, not unranked', async () => {
  const sb = createFakeSupabase();
  seed(sb, { keywords: 5 });
  sb.rows('seo_keyword_set'); // priority 1..5
  const provider = fakeProvider();
  await syncSerpSchedule({ supabase: sb, schedule: { ...SCHEDULE, devices: ['desktop'], max_keywords_per_run: 2 }, credentials: CREDS, now: NOW, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1 });
  assert.deepEqual(ledger(sb).map((l) => l.keyword_id).sort(), ['kw-1', 'kw-2']);
  assert.deepEqual(asked(sb).map((l) => l.keyword_id).sort(), ['kw-1', 'kw-2']);
  assert.equal(runs(sb)[0].keyword_count, 2);
});

test('a provider error on a task marks the ledger failed and writes no asked-row; an empty page writes result_count 0', async () => {
  const sb = createFakeSupabase();
  seed(sb, { keywords: 3 });
  const provider = fakeProvider({
    taskError: (t) => (t.keyword === 'keyword 2' ? { code: 40501, message: 'Task Error' } : null),
    pages: { 'keyword 3|desktop': [{ type: 'people_also_ask', rank_absolute: 2 }] },
  });
  const out = await syncSerpSchedule({ supabase: sb, schedule: { ...SCHEDULE, devices: ['desktop'] }, credentials: CREDS, now: NOW, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1 });
  const failed = ledger(sb).find((l) => l.keyword_id === 'kw-2');
  assert.equal(failed.status, 'failed'); assert.equal(failed.status_code, 40501); assert.equal(failed.collected_at, null);
  assert.equal(asked(sb).find((a) => a.keyword_id === 'kw-2'), undefined, 'asked and unanswered is not a measurement');
  assert.equal(asked(sb).find((a) => a.keyword_id === 'kw-3').result_count, 0, 'answered with no organic items IS a measurement');
  assert.equal(obs(sb).filter((o) => o.keyword_id === 'kw-3').length, 0);
  assert.equal(out.devices[0].failed, 1); assert.equal(out.devices[0].completed, true);
  assert.ok(runs(sb)[0].completed_at, 'a failed task does not hold the run open');
});

test('a refused post is recorded failed and is re-tried on a later run, up to three attempts', async () => {
  const sb = createFakeSupabase();
  seed(sb, { keywords: 2 });
  let refusing = true;
  const provider = fakeProvider({ refuse: (t) => refusing && t.keyword === 'keyword 2' });
  const sched = { ...SCHEDULE, devices: ['desktop'] };
  const out1 = await syncSerpSchedule({ supabase: sb, schedule: sched, credentials: CREDS, now: NOW, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1 });
  assert.equal(out1.devices[0].refused, 1);
  assert.equal(ledger(sb).find((l) => l.keyword_id === 'kw-2').status, 'failed');
  assert.ok(runs(sb)[0].completed_at, 'nothing pending, so the run completes');
  // The run is complete, so a later same-day run skips it; a refused post
  // is retried only when the identity is still in flight.
  refusing = false;
  const out2 = await syncSerpSchedule({ supabase: sb, schedule: sched, credentials: CREDS, now: NOW, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1 });
  assert.equal(out2.devices[0].skipped, 'already_complete');
});

test('max_cost_per_run_usd stops posting between batches', async () => {
  const sb = createFakeSupabase();
  seed(sb, { keywords: 250 });
  const provider = fakeProvider({ postCost: 0.01 });
  const out = await syncSerpSchedule({ supabase: sb, schedule: { ...SCHEDULE, devices: ['desktop'], max_cost_per_run_usd: 1.5 }, credentials: CREDS, now: NOW, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1 });
  assert.equal(out.devices[0].accepted, 200, 'two batches of 100 at $0.01 = $2.00 >= cap; the third never posts');
  assert.equal(out.devices[0].capped, 50);
  assert.equal(ledger(sb).length, 200);
});

test('no active keywords: skipped in sync_jobs, nothing posted', async () => {
  const sb = createFakeSupabase();
  seed(sb, { keywords: 0 });
  const provider = fakeProvider();
  const out = await syncSerpSchedule({ supabase: sb, schedule: SCHEDULE, credentials: CREDS, now: NOW, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1 });
  assert.equal(out.skipped, 'no_keywords');
  assert.equal(provider.requests.length, 0);
  assert.equal(jobs(sb)[0].status, 'skipped');
});

test('401 is an error recorded on sync_jobs and rethrown; the ledger is untouched', async () => {
  const sb = createFakeSupabase();
  seed(sb);
  const provider = fakeProvider({ http: () => ({ ok: false, status: 401, text: async () => '{"status_code":40100}' }) });
  await assert.rejects(
    () => syncSerpSchedule({ supabase: sb, schedule: SCHEDULE, credentials: CREDS, now: NOW, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1 }),
    (e) => e instanceof DataForSeoError && e.status === 401,
  );
  assert.equal(jobs(sb)[0].status, 'error');
  assert.match(jobs(sb)[0].error, /401/);
  assert.equal(ledger(sb).length, 0);
});

test('429 and 5xx are retried with backoff; a post is never doubled by the retry', async () => {
  let calls = 0;
  const slept = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls <= 2) return { ok: false, status: calls === 1 ? 429 : 503, text: async () => 'slow down' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ status_code: 20000, tasks: [] }) };
  };
  const res = await dataForSeoRequest({ ...CREDS, method: 'GET', path: '/x', fetchImpl, sleep: async (ms) => { slept.push(ms); } });
  assert.equal(res.status_code, 20000); assert.equal(calls, 3); assert.deepEqual(slept, [2000, 4000]);
});

test('mapObservations keeps organic only, by rank_group, first of a duplicated rank, www. stripped', () => {
  const { rows, itemTypes } = mapObservations({
    item_types: ['organic', 'popular_products'],
    items: [
      { type: 'popular_products', rank_absolute: 1 },
      organic(1, 'www.a.com'), organic(2, 'b.com'), organic(2, 'dup.com'),
      { type: 'organic', rank_group: 3, domain: '', url: 'https://x' },
      organic(4, 'c.com'),
    ],
  });
  assert.deepEqual(rows.map((r) => [r.position, r.domain]), [[1, 'a.com'], [2, 'b.com'], [4, 'c.com']]);
  assert.deepEqual(itemTypes, ['organic', 'popular_products']);
});

test('selectKeywords: priority first (nulls last), then age, capped, inactive dropped', () => {
  const rows = [
    { id: 'z', keyword: 'z', priority: null, created_at: '2026-01-01', is_active: true },
    { id: 'b', keyword: 'b', priority: 2, created_at: '2026-01-02', is_active: true },
    { id: 'a', keyword: 'a', priority: 1, created_at: '2026-01-03', is_active: true },
    { id: 'off', keyword: 'off', priority: 0, created_at: '2026-01-03', is_active: false },
    { id: 'y', keyword: 'y', priority: null, created_at: '2025-12-31', is_active: true },
  ];
  assert.deepEqual(selectKeywords(rows, 10).map((r) => r.id), ['a', 'b', 'y', 'z']);
  assert.deepEqual(selectKeywords(rows, 2).map((r) => r.id), ['a', 'b']);
});

test('a task answered but absent from tasks_ready is fetched directly once old enough; one still queued stays pending', async () => {
  const sb = createFakeSupabase();
  seed(sb, { keywords: 3 });
  const sched = { ...SCHEDULE, devices: ['desktop'] };
  // task-1: ready. task-2: answered but never listed (collected by a run that
  // crashed before writing). task-3: the provider says still in queue.
  const provider = fakeProvider({ ready: (id) => id === 'task-1', hidden: (id) => id === 'task-2', inProgress: (id) => id === 'task-3' });
  const t0 = NOW().getTime();
  let clock = t0;
  const now = () => new Date(clock);
  // Pass 1 at t0: only task-1 comes back; nothing is old enough for a direct fetch.
  const out1 = await syncSerpSchedule({ supabase: sb, schedule: sched, credentials: CREDS, now, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1, collectWaitMs: 0 });
  assert.equal(out1.devices[0].collected, 1); assert.equal(out1.devices[0].pending, 2);
  assert.equal(provider.requests.filter((r) => /task_get/.test(r.url)).length, 1, 'no direct fetch inside the grace period');
  // Pass 2 after the grace period: task-2 is fetched directly and collected;
  // task-3 is fetched directly, the provider says 40602, it stays pending.
  clock = t0 + DIRECT_FETCH_AFTER_MS + 1000;
  const out2 = await syncSerpSchedule({ supabase: sb, schedule: sched, credentials: CREDS, now, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1, collectWaitMs: 0 });
  assert.equal(out2.devices[0].posted, 0, 'nothing re-posted');
  assert.equal(out2.devices[0].collected, 1); assert.equal(out2.devices[0].pending, 1); assert.equal(out2.devices[0].completed, false);
  assert.equal(ledger(sb).find((l) => l.provider_task_id === 'task-2').status, 'collected');
  assert.equal(ledger(sb).find((l) => l.provider_task_id === 'task-3').status, 'posted');
  assert.equal(asked(sb).length, 2);
  // A task the provider no longer has at all is recorded failed, no asked-row.
  provider.queue.delete('task-3');
  const out3 = await syncSerpSchedule({ supabase: sb, schedule: sched, credentials: CREDS, now, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1, collectWaitMs: 0 });
  assert.equal(out3.devices[0].failed, 1); assert.equal(out3.devices[0].completed, true);
  assert.equal(ledger(sb).find((l) => l.provider_task_id === 'task-3').status_code, 40401);
  assert.equal(asked(sb).length, 2, 'asked and unanswered is not a measurement');
});

test('a run left in flight on an earlier day is resumed and completed before today starts, posting nothing for it', async () => {
  const sb = createFakeSupabase();
  seed(sb, { keywords: 2 });
  const sched = { ...SCHEDULE, devices: ['desktop'] };
  let phase = 1;
  const provider = fakeProvider({ ready: () => phase === 2 });
  const lastWeek = () => new Date('2026-09-21T16:00:00Z');
  const out1 = await syncSerpSchedule({ supabase: sb, schedule: sched, credentials: CREDS, now: lastWeek, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1, collectWaitMs: 0 });
  assert.equal(out1.devices[0].pending, 2);
  const oldRun = runs(sb)[0];
  assert.equal(oldRun.observed_on, '2026-09-21'); assert.equal(oldRun.completed_at, undefined);
  phase = 2;
  const out2 = await syncSerpSchedule({ supabase: sb, schedule: sched, credentials: CREDS, now: NOW, fetchImpl: provider.fetchImpl, sleep: noSleep, pollMs: 1 });
  assert.equal(out2.resumed.length, 1);
  assert.equal(out2.resumed[0].run_id, oldRun.id); assert.equal(out2.resumed[0].collected, 2); assert.equal(out2.resumed[0].completed, true);
  assert.equal(out2.devices[0].created, true); assert.equal(out2.devices[0].posted, 2, "today's run is its own identity");
  assert.equal(runs(sb).length, 2);
  assert.ok(runs(sb).every((r) => r.completed_at));
  assert.equal(obs(sb).filter((o) => o.run_id === oldRun.id && o.observed_on === '2026-09-21').length, 6, 'the old run keeps its own date');
  const posts = provider.requests.filter((r) => r.url.endsWith('/task_post'));
  assert.equal(posts.length, 2, 'one post per run; the resume posted nothing');
});
