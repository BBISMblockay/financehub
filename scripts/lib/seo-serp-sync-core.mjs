// SEO SERP sync: the weekly DataForSEO fetch of the company's keyword set into
// seo_serp_runs / seo_serp_run_keywords / seo_serp_observations, bounded by
// seo_serp_schedules and resumable through seo_serp_provider_tasks.
//
// Provider facts this is built on were MEASURED 2026-09-26 by
// .github/workflows/seo-serp-probe.yml, not recalled:
//   * the live endpoint takes one task per request; the standard queue
//     (task_post) takes up to 100 per request and answered 4 tasks in
//     106-139 s at $0.0012 per task (depth 20, priority normal);
//   * depth counts ABSOLUTE SERP slots, so depth 10 yields 7-8 organic ranks
//     and depth 20 yields 16-19; the schedule's default is 20;
//   * desktop and mobile differ materially; two fetches of one identity
//     minutes apart can differ on whether our own site is in the page at all.
//     A stored position is one snapshot.
//
// Order of operations for one company, one device, one observed_on:
//   1. the run row (the identity; completed_at NULL while in flight);
//   2. POST the keywords the ledger does not yet hold, in batches of 100,
//      writing a seo_serp_provider_tasks row for every accepted task BEFORE
//      any collection -- the ledger is what makes a resume a resume;
//   3. poll tasks_ready; for each of OUR pending ids: task_get, then write the
//      seo_serp_run_keywords row (asked, N results), then the organic
//      observations, then mark the ledger row collected;
//   4. once the ledger has nothing pending for the run, stamp completed_at LAST.
// A collection deadline (a GitHub job has a clock) leaves the run in flight
// with its ledger intact; the catch-up run the same day resumes at step 3 and
// posts nothing. A run left in flight on an EARLIER day is resumed the same
// way before today's starts (RESUME_WINDOW_DAYS), and a task the provider
// answered but no longer lists in tasks_ready (a crash between fetch and
// write) is fetched directly once it is DIRECT_FETCH_AFTER_MS old. A provider error on a task marks the ledger row failed and
// writes NO run_keywords row: the keyword was asked about and not answered,
// which is "never observed" for that run, never "nothing within depth".
//
// Two cost bounds, both from the schedule row and both enforced before a post:
// max_keywords_per_run (keywords x devices = tasks) and max_cost_per_run_usd
// (the provider's own reported cost so far, checked between batches).

export const DATAFORSEO_BASE = 'https://api.dataforseo.com';
export const SEO_SERP_JOB_TYPE = 'seo_serp_weekly';
export const TASK_POST_BATCH = 100;
export const PROVIDER = 'dataforseo';
const STATUS_OK = 20000;
const STATUS_CREATED = 20100;
// Task-level codes meaning "not finished yet" on task_get.
const STATUS_IN_PROGRESS = new Set([40601, 40602]);
const FALLBACK_TZ = 'America/Los_Angeles';
const MAX_POST_ATTEMPTS = 3;
const PAGE = 1000;
// A task the provider has answered but tasks_ready no longer lists (a run
// that crashed between task_get and its writes: the provider drops a task
// from tasks_ready the moment it is fetched once) is fetched DIRECTLY once it
// is this old. Direct task_get on an unfinished task says so (40601/40602).
export const DIRECT_FETCH_AFTER_MS = 5 * 60 * 1000;
const DIRECT_FETCH_PER_PASS = 200;
// How far back an in-flight run (completed_at null) is resumed before today's
// is started. Results stay collectable at the provider for 30 days.
export const RESUME_WINDOW_DAYS = 21;

export class DataForSeoError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'DataForSeoError';
    this.status = status;
    this.code = code;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** YYYY-MM-DD of `date` as seen in `timeZone`. */
export function dayInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function bareDomain(domain) {
  return String(domain || '').trim().toLowerCase().replace(/^www\./, '');
}

// ── HTTP ───────────────────────────────────────────────────────────────────

export async function dataForSeoRequest({
  login, password, method, path, body, fetchImpl = fetch, sleep = defaultSleep, maxRetries = 5, baseUrl = DATAFORSEO_BASE,
}) {
  const auth = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (attempt >= maxRetries) throw new DataForSeoError(`DataForSEO ${method} ${path}: network failure after ${attempt + 1} attempts: ${err?.message || err}`);
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      let code = null;
      try { code = JSON.parse(text)?.status_code ?? null; } catch { /* reported below */ }
      throw new DataForSeoError(`DataForSEO refused the request (HTTP ${res.status}${code ? `, ${code}` : ''}): ${text.slice(0, 200)}`, { status: res.status, code });
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= maxRetries) throw new DataForSeoError(`DataForSEO HTTP ${res.status} after ${attempt + 1} attempts: ${text.slice(0, 200)}`, { status: res.status });
      await sleep(2000 * (attempt + 1));
      continue;
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* reported below */ }
    if (!res.ok || !json) throw new DataForSeoError(`DataForSEO ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`, { status: res.status });
    if (json.status_code !== STATUS_OK) {
      throw new DataForSeoError(`DataForSEO ${method} ${path} -> ${json.status_code} ${json.status_message}`, { status: res.status, code: json.status_code });
    }
    return json;
  }
}

// ── pure pieces ────────────────────────────────────────────────────────────

/** Active keywords by priority (nulls last) then age, capped. */
export function selectKeywords(rows, cap) {
  const active = rows.filter((r) => r.is_active !== false);
  active.sort((a, b) => {
    const pa = a.priority ?? Number.POSITIVE_INFINITY, pb = b.priority ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    return String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id));
  });
  return active.slice(0, cap);
}

export function taskTag(runId, keywordId) { return `${runId}|${keywordId}`; }

export function buildTask({ keyword, schedule, device, runId }) {
  return {
    keyword: keyword.keyword,
    location_code: schedule.location_code,
    language_code: schedule.language_code,
    device,
    os: device === 'mobile' ? 'android' : 'windows',
    depth: schedule.depth,
    priority: schedule.priority ?? 1,
    tag: taskTag(runId, keyword.id),
  };
}

/**
 * The organic observations in one task_get result. Position is the ORGANIC
 * rank (rank_group), never the absolute slot; a duplicate rank_group (seen
 * once in the probe: two consecutive items from one domain) keeps the first.
 */
export function mapObservations(taskResult) {
  const items = taskResult?.items || [];
  const seen = new Set();
  const rows = [];
  for (const it of items) {
    if (it.type !== 'organic') continue;
    const position = Number(it.rank_group);
    if (!Number.isInteger(position) || position < 1 || seen.has(position)) continue;
    const domain = bareDomain(it.domain);
    if (!domain || !it.url) continue;
    seen.add(position);
    rows.push({ position, domain, url: String(it.url), title: it.title ? String(it.title).slice(0, 500) : null });
  }
  return { rows, itemTypes: Array.isArray(taskResult?.item_types) ? taskResult.item_types.map(String) : null };
}

// ── database helpers ───────────────────────────────────────────────────────

async function one(query, label) {
  const { data, error } = await query;
  if (error) throw new Error(`${label} failed: ${error.message}`);
  return data;
}

/** Every row of an ORDERED query, paged: the client's default page is 1000. */
async function readAll(makeQuery, label) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const page = await one(makeQuery().range(from, from + PAGE - 1), label) || [];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

async function businessTimezone(supabase, companyEntityId) {
  const rows = await one(supabase.from('company_settings').select('business_timezone').eq('company_entity_id', companyEntityId), 'company_settings read');
  return rows?.[0]?.business_timezone || FALLBACK_TZ;
}

async function findRun(supabase, schedule, observedOn, device) {
  const rows = await one(supabase.from('seo_serp_runs').select('*')
    .eq('company_entity_id', schedule.company_entity_id)
    .eq('provider', PROVIDER)
    .eq('observed_on', observedOn)
    .eq('location_name', schedule.location_name)
    .eq('language_code', schedule.language_code)
    .eq('device', device)
    .eq('search_engine', schedule.search_engine), 'seo_serp_runs read');
  return rows?.[0] || null;
}

async function ensureRun({ supabase, schedule, observedOn, device, keywordCount, nowIso, batchId }) {
  const existing = await findRun(supabase, schedule, observedOn, device);
  if (existing) return { run: existing, created: false };
  const { data, error } = await supabase.from('seo_serp_runs').insert({
    company_entity_id: schedule.company_entity_id,
    provider: PROVIDER,
    observed_on: observedOn,
    location_code: schedule.location_code,
    location_name: schedule.location_name,
    language_code: schedule.language_code,
    device,
    search_engine: schedule.search_engine,
    depth: schedule.depth,
    keyword_count: keywordCount,
    requested_at: nowIso,
    synced_at: nowIso,
    sync_batch_id: batchId,
  }).select('*').single();
  if (error) throw new Error(`seo_serp_runs insert failed: ${error.message}`);
  return { run: data, created: true };
}

// ── posting ────────────────────────────────────────────────────────────────

async function postKeywords({ supabase, api, schedule, run, device, keywords, ledger, nowIso, batchId, log }) {
  const byKeyword = new Map(ledger.map((l) => [l.keyword_id, l]));
  const toPost = keywords.filter((k) => {
    const l = byKeyword.get(k.id);
    if (!l) return true;
    return l.status === 'failed' && l.attempts < MAX_POST_ATTEMPTS && !l.collected_at;
  });
  let spent = ledger.reduce((s, l) => s + Number(l.post_cost_usd || 0), 0);
  let accepted = 0, refused = 0, capped = 0;
  for (let i = 0; i < toPost.length; i += TASK_POST_BATCH) {
    if (spent >= Number(schedule.max_cost_per_run_usd)) {
      capped = toPost.length - i;
      log(`[seo-serp] ${schedule.company_entity_id} ${device}: cost cap $${schedule.max_cost_per_run_usd} reached after $${spent.toFixed(4)}; ${capped} keyword(s) not posted`);
      break;
    }
    const slice = toPost.slice(i, i + TASK_POST_BATCH);
    const body = slice.map((k) => buildTask({ keyword: k, schedule, device, runId: run.id }));
    const res = await api('POST', '/v3/serp/google/organic/task_post', body);
    const tasks = res.tasks || [];
    if (tasks.length !== slice.length) throw new DataForSeoError(`task_post returned ${tasks.length} tasks for ${slice.length} posted`);
    const rows = [];
    for (let j = 0; j < slice.length; j += 1) {
      const t = tasks[j];
      const keyword = slice[j];
      const prior = byKeyword.get(keyword.id);
      const ok = t.status_code === STATUS_CREATED && t.id;
      if (ok) accepted += 1; else refused += 1;
      spent += Number(t.cost || 0);
      rows.push({
        company_entity_id: schedule.company_entity_id,
        run_id: run.id,
        keyword_id: keyword.id,
        provider: PROVIDER,
        provider_task_id: ok ? String(t.id) : `refused:${run.id}:${keyword.id}:${(prior?.attempts || 0) + 1}`,
        status: ok ? 'posted' : 'failed',
        status_code: t.status_code ?? null,
        status_message: ok ? null : String(t.status_message || 'refused').slice(0, 500),
        post_cost_usd: t.cost ?? null,
        posted_at: nowIso,
        collected_at: null,
        item_types: null,
        attempts: (prior?.attempts || 0) + 1,
        synced_at: nowIso,
        sync_batch_id: batchId,
      });
    }
    // The ledger row lands before anything is collected: a crash after this
    // point resumes; a crash before it re-posts only this batch.
    await one(supabase.from('seo_serp_provider_tasks').upsert(rows, { onConflict: 'run_id,keyword_id' }), 'seo_serp_provider_tasks upsert');
  }
  return { posted: toPost.length - capped, accepted, refused, capped, spent };
}

// ── collecting ─────────────────────────────────────────────────────────────

async function collectOne({ supabase, api, schedule, run, ledgerRow, nowIso, batchId }) {
  const got = await api('GET', `/v3/serp/google/organic/task_get/advanced/${encodeURIComponent(ledgerRow.provider_task_id)}`);
  const task = got.tasks?.[0];
  if (!task) throw new DataForSeoError(`task_get ${ledgerRow.provider_task_id}: no task in response`);
  if (STATUS_IN_PROGRESS.has(task.status_code)) return { state: 'pending' };
  if (task.status_code !== STATUS_OK || !task.result?.[0]) {
    await one(supabase.from('seo_serp_provider_tasks').update({
      status: 'failed', status_code: task.status_code ?? null,
      status_message: String(task.status_message || 'no result').slice(0, 500),
      collected_at: null, synced_at: nowIso, sync_batch_id: batchId,
    }).eq('id', ledgerRow.id), 'seo_serp_provider_tasks update');
    return { state: 'failed', code: task.status_code };
  }
  const result = task.result[0];
  const { rows, itemTypes } = mapObservations(result);
  // 1. asked, N results -- the row that separates "observed, absent" from
  //    "never observed".
  await one(supabase.from('seo_serp_run_keywords').upsert([{
    company_entity_id: schedule.company_entity_id,
    run_id: run.id,
    keyword_id: ledgerRow.keyword_id,
    result_count: rows.length,
    provider_request_id: String(task.id || ledgerRow.provider_task_id),
    cost_usd: task.cost ?? ledgerRow.post_cost_usd ?? null,
    synced_at: nowIso,
    sync_batch_id: batchId,
  }], { onConflict: 'run_id,keyword_id' }), 'seo_serp_run_keywords upsert');
  // 2. the observations.
  if (rows.length) {
    await one(supabase.from('seo_serp_observations').upsert(rows.map((r) => ({
      company_entity_id: schedule.company_entity_id,
      run_id: run.id,
      keyword_id: ledgerRow.keyword_id,
      provider: PROVIDER,
      observed_on: run.observed_on,
      location_name: run.location_name,
      language_code: run.language_code,
      device: run.device,
      search_engine: run.search_engine,
      result_type: 'organic',
      position: r.position,
      domain: r.domain,
      url: r.url,
      title: r.title,
      synced_at: nowIso,
      sync_batch_id: batchId,
    })), { onConflict: 'run_id,keyword_id,result_type,position' }), 'seo_serp_observations upsert');
  }
  // 3. the ledger says collected, last.
  await one(supabase.from('seo_serp_provider_tasks').update({
    status: 'collected', status_code: task.status_code, status_message: null,
    collected_at: nowIso, item_types: itemTypes, synced_at: nowIso, sync_batch_id: batchId,
  }).eq('id', ledgerRow.id), 'seo_serp_provider_tasks update');
  return { state: 'collected', results: rows.length };
}

async function readLedger(supabase, runId) {
  return readAll(() => supabase.from('seo_serp_provider_tasks').select('*').eq('run_id', runId).order('posted_at').order('id'), 'seo_serp_provider_tasks read');
}

async function collectPending({ supabase, api, schedule, run, now, sleep, log, collectWaitMs, pollMs, batchId }) {
  const startedAt = now().getTime();
  let collected = 0, failed = 0, results = 0;
  let pending = (await readLedger(supabase, run.id)).filter((l) => l.status === 'posted');
  let firstPass = true;
  while (pending.length) {
    if (!firstPass) {
      if (now().getTime() - startedAt >= collectWaitMs) break;
      await sleep(pollMs);
    }
    firstPass = false;
    const ready = await api('GET', '/v3/serp/google/organic/tasks_ready');
    const readyIds = new Set();
    for (const t of ready.tasks || []) for (const item of t.result || []) if (item?.id) readyIds.add(String(item.id));
    const nowMs = now().getTime();
    const due = pending.filter((l) => readyIds.has(String(l.provider_task_id)));
    // Not listed as ready but old enough that it should be: ask directly, a
    // bounded number per pass. An unfinished task answers 40601/40602 and
    // stays pending; a task the provider no longer has is recorded failed.
    const overdue = pending
      .filter((l) => !readyIds.has(String(l.provider_task_id)) && nowMs - Date.parse(l.posted_at) >= DIRECT_FETCH_AFTER_MS)
      .slice(0, DIRECT_FETCH_PER_PASS);
    for (const ledgerRow of [...due, ...overdue]) {
      const out = await collectOne({ supabase, api, schedule, run, ledgerRow, nowIso: now().toISOString(), batchId });
      if (out.state === 'collected') { collected += 1; results += out.results; }
      else if (out.state === 'failed') failed += 1;
    }
    pending = (await readLedger(supabase, run.id)).filter((l) => l.status === 'posted');
    log(`[seo-serp] ${schedule.company_entity_id} ${run.device}: ${collected} collected, ${failed} failed, ${pending.length} pending`);
  }
  return { collected, failed, results, pending: pending.length };
}

async function completeRunIfDone({ supabase, run, nowIso }) {
  const ledger = await readLedger(supabase, run.id);
  if (ledger.some((l) => l.status === 'posted')) return false;
  const asked = (await one(supabase.from('seo_serp_run_keywords').select('result_count').eq('run_id', run.id), 'seo_serp_run_keywords read')) || [];
  const cost = ledger.reduce((s, l) => s + Number(l.post_cost_usd || 0), 0);
  await one(supabase.from('seo_serp_runs').update({
    completed_at: nowIso,
    synced_at: nowIso,
    result_count: asked.reduce((s, r) => s + Number(r.result_count || 0), 0),
    cost_usd: Number(cost.toFixed(4)),
  }).eq('id', run.id), 'seo_serp_runs complete');
  return true;
}

// ── one schedule, end to end ───────────────────────────────────────────────

/**
 * Run (or resume) this week's fetch for one seo_serp_schedules row. Every
 * outcome is told apart by the sync_jobs row alone:
 *   success, devices[].pending 0         -> every run completed
 *   success, devices[].pending > 0       -> collection deadline hit; the
 *                                           catch-up run resumes, posts nothing
 *   success, devices[].skipped           -> that identity was already complete
 *   error                                -> rethrown; nothing partial is lost,
 *                                           the ledger says what was posted
 */
export async function syncSerpSchedule({
  supabase, schedule, credentials, now = () => new Date(), fetchImpl = fetch, sleep = defaultSleep,
  log = () => {}, collectWaitMs = 20 * 60 * 1000, pollMs = 15000, batchId = null,
}) {
  const co = schedule.company_entity_id;
  if (!credentials?.login || !credentials?.password) throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set');
  const api = (method, path, body) => dataForSeoRequest({ ...credentials, method, path, body, fetchImpl, sleep });
  const timeZone = await businessTimezone(supabase, co);
  const observedOn = dayInZone(now(), timeZone);
  const batch = batchId || `seo-serp-${observedOn}-${now().getTime()}`;

  const keywordRows = await readAll(() => supabase.from('seo_keyword_set')
    .select('id, keyword, priority, is_active, created_at')
    .eq('company_entity_id', co).eq('is_active', true)
    .order('priority', { ascending: true, nullsFirst: false }).order('created_at').order('id'), 'seo_keyword_set read');
  const keywords = selectKeywords(keywordRows, schedule.max_keywords_per_run);

  const { data: job, error: jobErr } = await supabase.from('sync_jobs')
    .insert({ company_entity_id: co, job_type: SEO_SERP_JOB_TYPE, status: 'running', started_at: now().toISOString() })
    .select('id').single();
  if (jobErr) throw new Error(`sync_jobs insert failed: ${jobErr.message}`);
  const finish = (patch) => supabase.from('sync_jobs').update({ finished_at: now().toISOString(), ...patch }).eq('id', job.id);

  const devices = [];
  const resumed = [];
  try {
    // A run left in flight on an earlier day (its collection hit the deadline
    // and the catch-up was dropped) would otherwise never complete, since a
    // later day is a new identity. Resume it first: collect, never post.
    const inFlight = (await readAll(() => supabase.from('seo_serp_runs').select('*')
      .eq('company_entity_id', co).eq('provider', PROVIDER).order('observed_on').order('id'), 'seo_serp_runs read'))
      .filter((r) => !r.completed_at && r.observed_on < observedOn && r.observed_on >= dayInZone(new Date(now().getTime() - RESUME_WINDOW_DAYS * 86400000), timeZone));
    for (const run of inFlight) {
      const coll = await collectPending({ supabase, api, schedule, run, now, sleep, log, collectWaitMs: 0, pollMs, batchId: batch });
      const completed = await completeRunIfDone({ supabase, run, nowIso: now().toISOString() });
      resumed.push({ run_id: run.id, observed_on: run.observed_on, device: run.device, ...coll, completed });
      log(`[seo-serp] ${co} ${run.device}: resumed in-flight run of ${run.observed_on}: ${coll.collected} collected, ${coll.failed} failed, ${coll.pending} pending, ${completed ? 'completed' : 'still in flight'}`);
    }
    if (!keywords.length) {
      const result = { observed_on: observedOn, time_zone: timeZone, keywords: 0, devices: [], resumed, note: 'no active keywords' };
      await finish({ status: 'skipped', result, error: 'seo_keyword_set has no active keywords for this company' });
      log(`[seo-serp] ${co}: no active keywords; nothing posted`);
      return { company: co, skipped: 'no_keywords', ...result };
    }
    for (const device of schedule.devices) {
      const nowIso = now().toISOString();
      const { run, created } = await ensureRun({ supabase, schedule, observedOn, device, keywordCount: keywords.length, nowIso, batchId: batch });
      if (run.completed_at) {
        devices.push({ device, run_id: run.id, skipped: 'already_complete' });
        log(`[seo-serp] ${co} ${device}: ${observedOn} already complete; nothing posted`);
        continue;
      }
      const ledger = await readLedger(supabase, run.id);
      const post = await postKeywords({ supabase, api, schedule, run, device, keywords, ledger, nowIso, batchId: batch, log });
      log(`[seo-serp] ${co} ${device}: run ${created ? 'created' : 'resumed'} for ${observedOn}; posted ${post.posted} (accepted ${post.accepted}, refused ${post.refused}, capped ${post.capped}); provider cost so far $${post.spent.toFixed(4)}`);
      const coll = await collectPending({ supabase, api, schedule, run, now, sleep, log, collectWaitMs, pollMs, batchId: batch });
      const completed = await completeRunIfDone({ supabase, run, nowIso: now().toISOString() });
      devices.push({ device, run_id: run.id, created, ...post, ...coll, completed });
    }
    await one(supabase.from('seo_serp_schedules').update({ last_run_on: observedOn }).eq('id', schedule.id), 'seo_serp_schedules update');
    const result = { observed_on: observedOn, time_zone: timeZone, keywords: keywords.length, devices, resumed };
    await finish({ status: 'success', result });
    return { company: co, ...result };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 2000);
    await finish({ status: 'error', result: { observed_on: observedOn, time_zone: timeZone, keywords: keywords.length, devices, resumed }, error: message });
    throw err;
  }
}
