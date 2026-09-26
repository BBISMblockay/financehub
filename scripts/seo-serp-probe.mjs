// scripts/seo-serp-probe.mjs -- measure DataForSEO before writing the SERP
// sync. READ ONLY against SILO: no Supabase client, no writes, nothing stored.
// It spends a few cents at the provider (each live SERP task is billed) and
// prints what one observation costs so the weekly budget is a measurement,
// not a recalled price.
//
// WHY THIS EXISTS. The seo_serp_* schema (20260926120000) fixes what an
// observation IS -- one dated, located, device-specific rank -- but the
// writer needs four facts about THIS provider that should be measured rather
// than assumed from documentation:
//
//   1. Auth + balance   -- /appendix/user_data: does Basic auth work, what is
//                          the balance, what are the per-minute limits.
//   2. Location/device  -- does location_code 2840 resolve to the United
//                          States, and does device=mobile return a different
//                          page than device=desktop for the same keyword
//                          (if it does not, storing device separately is
//                          storing the same number twice).
//   3. Result shape     -- which item types come back inline on a live
//                          advanced call (organic only, or shopping / people
//                          also ask / video / local pack too), what fields an
//                          organic item carries, and how many ORGANIC ranks a
//                          depth of 10 actually yields once non-organic
//                          elements are counted in rank_absolute.
//   4. Cost             -- the `cost` field per task, which is what a weekly
//                          run of N keywords x devices will multiply.
//   5. Queue turnaround -- MEASURED 2026-09-26 (run 36221338860): the live
//                          endpoint accepts ONE task per request ("40000 You
//                          can set only one task at a time"), so a weekly
//                          set is either N sequential live calls at $0.002
//                          or one task_post batch on the standard queue at
//                          a lower price with results collected later. This
//                          step posts the whole set to the queue, polls
//                          tasks_ready, and reports the turnaround and the
//                          per-task cost, because that is the path the
//                          writer will actually take.
//
// Prints counts, positions, domains and costs. NEVER prints the credentials.
//
// Env: DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD (HTTP Basic).
// Optional: SERP_PROBE_KEYWORDS (comma-separated, default two Baseballism
//           terms), SERP_PROBE_OUR_DOMAIN (default baseballism.com),
//           SERP_PROBE_LOCATION_CODE (default 2840), SERP_PROBE_SPEND
//           ('false' runs only the free endpoints), SERP_PROBE_BASE_URL
//           (tests only: point at a stub server), SERP_PROBE_QUEUE_WAIT_MS /
//           SERP_PROBE_POLL_MS (queue collection deadline and poll interval).

const LOGIN = process.env.DATAFORSEO_LOGIN || '';
const PASSWORD = process.env.DATAFORSEO_PASSWORD || '';
const BASE_URL = (process.env.SERP_PROBE_BASE_URL || 'https://api.dataforseo.com').replace(/\/$/, '');
const KEYWORDS = (process.env.SERP_PROBE_KEYWORDS || 'baseballism,baseball dad hat')
  .split(',').map((s) => s.trim()).filter(Boolean);
const OUR_DOMAIN = (process.env.SERP_PROBE_OUR_DOMAIN || 'baseballism.com').toLowerCase().replace(/^www\./, '');
const LOCATION_CODE = Number(process.env.SERP_PROBE_LOCATION_CODE || 2840);
const SPEND = (process.env.SERP_PROBE_SPEND || 'true').toLowerCase() !== 'false';
const DEPTH = 10;

if (!LOGIN || !PASSWORD) throw new Error('Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD');
if (!Number.isInteger(LOCATION_CODE) || LOCATION_CODE <= 0) throw new Error(`Bad SERP_PROBE_LOCATION_CODE: ${process.env.SERP_PROBE_LOCATION_CODE}`);

const AUTH = 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');

function log(...a) { console.log(...a); }
function money(n) { return n == null ? 'n/a' : `$${Number(n).toFixed(4)}`; }
function bareDomain(d) { return String(d || '').toLowerCase().replace(/^www\./, ''); }

async function call(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* reported below */ }
  if (!res.ok || !json) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (json.status_code !== 20000) {
    throw new Error(`${method} ${path} -> API ${json.status_code} ${json.status_message}`);
  }
  return json;
}

// 1. Auth, balance, limits ---------------------------------------------------
async function probeAccount() {
  log('\n== 1. Account (GET /v3/appendix/user_data) ==');
  const j = await call('GET', '/v3/appendix/user_data');
  const r = j.tasks?.[0]?.result?.[0] || {};
  log(`  login ok; balance ${money(r.money?.balance)}; money.total ${money(r.money?.total)}`);
  // The account record minus the (very long) price list: whatever the
  // provider says about verification, limits and rates is printed verbatim,
  // because a 40104 "verify your account" refusal after the panel's banner
  // has gone is not diagnosable from the refusal alone.
  const { price, ...rest } = r;
  log(`  account record (price list omitted): ${JSON.stringify(rest)}`);
  const serpPrice = price?.serp?.google?.organic?.live?.advanced;
  if (serpPrice != null) log(`  listed price serp/google/organic/live/advanced: ${JSON.stringify(serpPrice)}`);
  return r;
}

// 2. Location code ------------------------------------------------------------
async function probeLocation() {
  log(`\n== 2. Location (GET /v3/serp/google/locations/us, looking for ${LOCATION_CODE}) ==`);
  const j = await call('GET', '/v3/serp/google/locations/us');
  const list = j.tasks?.[0]?.result || [];
  const hit = list.find((l) => Number(l.location_code) === LOCATION_CODE);
  log(`  ${list.length} US locations listed; ${LOCATION_CODE} = ${hit ? `${hit.location_name} (${hit.location_type})` : 'NOT FOUND'}`);
  if (!hit) throw new Error(`location_code ${LOCATION_CODE} is not in the provider's US list`);
  return hit;
}

// 3 + 4. Live SERP shape and cost --------------------------------------------
function summarise(task, label) {
  const result = task.result?.[0];
  if (!result) {
    log(`  [${label}] task ${task.status_code} ${task.status_message}; cost ${money(task.cost)}; NO RESULT`);
    return null;
  }
  const items = result.items || [];
  const byType = {};
  for (const it of items) byType[it.type] = (byType[it.type] || 0) + 1;
  const organic = items.filter((it) => it.type === 'organic');
  const maxOrganicRank = organic.reduce((m, it) => Math.max(m, it.rank_group || 0), 0);
  const ours = organic.filter((it) => bareDomain(it.domain) === OUR_DOMAIN || bareDomain(it.domain).endsWith('.' + OUR_DOMAIN));
  log(`  [${label}] cost ${money(task.cost)}; se_results_count ${result.se_results_count}; items ${items.length}; item_types ${JSON.stringify(result.item_types || Object.keys(byType))}`);
  log(`    by type: ${JSON.stringify(byType)}`);
  log(`    organic ranks returned: ${organic.length} (max rank_group ${maxOrganicRank})`);
  log(`    fetched ${result.datetime}; check_url ${result.check_url || 'n/a'}`);
  for (const it of organic.slice(0, DEPTH)) {
    log(`    #${String(it.rank_group).padStart(2)} (abs ${String(it.rank_absolute).padStart(2)}) ${bareDomain(it.domain).padEnd(28)} ${it.url}`);
  }
  log(`    ${OUR_DOMAIN}: ${ours.length ? `rank_group ${ours.map((o) => o.rank_group).join(', ')}` : 'not in returned organic items (absence within depth, not "unranked")'}`);
  const sample = organic[0];
  if (sample) log(`    organic item fields: ${Object.keys(sample).join(', ')}`);
  return { result, organic, ours, byType };
}

function taskFor(keyword, device, depth) {
  return { keyword, location_code: LOCATION_CODE, language_code: 'en', device, os: device === 'mobile' ? 'android' : 'windows', depth, tag: `${keyword}|${device}|${depth}` };
}

function compareDevices(out, keywords, suffix) {
  log('\n  device comparison (does mobile differ from desktop?):');
  for (const keyword of keywords) {
    const d = out[`${keyword}|desktop${suffix}`], m = out[`${keyword}|mobile${suffix}`];
    if (!d || !m) { log(`    ${keyword}: incomplete`); continue; }
    const dd = d.organic.map((o) => bareDomain(o.domain)), md = m.organic.map((o) => bareDomain(o.domain));
    const same = dd.length === md.length && dd.every((x, i) => x === md[i]);
    const overlap = dd.filter((x) => md.includes(x)).length;
    log(`    ${keyword}: ${same ? 'IDENTICAL order' : `differ; ${overlap}/${Math.max(dd.length, md.length)} domains shared`}; ours desktop ${d.ours[0]?.rank_group ?? '-'} / mobile ${m.ours[0]?.rank_group ?? '-'}`);
  }
}

// Live endpoint: one task per request (measured), so the first keyword only,
// desktop then mobile, at depth 10 and then depth 20 on desktop to see how
// many ORGANIC ranks each depth yields once non-organic elements are counted.
async function probeLive() {
  log(`\n== 3. Live SERP (POST /v3/serp/google/organic/live/advanced), ONE task per request ==`);
  const keyword = KEYWORDS[0];
  const plan = [taskFor(keyword, 'desktop', DEPTH), taskFor(keyword, 'mobile', DEPTH), taskFor(keyword, 'desktop', 20)];
  const out = {};
  let spent = 0, ok = 0;
  for (const t of plan) {
    const j = await call('POST', '/v3/serp/google/organic/live/advanced', [t]);
    const task = j.tasks?.[0];
    if (!task) { log(`  [${t.tag}] no task in response`); continue; }
    spent += task.cost || 0;
    const r = summarise(task, t.tag);
    if (r) { ok += 1; out[t.tag] = r; }
  }
  log(`  live: ${ok}/${plan.length} tasks succeeded, ${money(spent)} spent -> ${money(ok ? spent / ok : null)} per live observation`);
  compareDevices(out, [keyword], `|${DEPTH}`);
  const d10 = out[`${keyword}|desktop|${DEPTH}`], d20 = out[`${keyword}|desktop|20`];
  if (d10 && d20) log(`  organic yield: depth ${DEPTH} -> ${d10.organic.length} organic; depth 20 -> ${d20.organic.length} organic (ours at ${d20.ours[0]?.rank_group ?? '-'} in the depth-20 page)`);
  return ok ? spent / ok : null;
}

// Standard queue: every keyword x device in ONE task_post, then poll.
async function probeQueue() {
  const tasks = [];
  for (const keyword of KEYWORDS) for (const device of ['desktop', 'mobile']) tasks.push({ ...taskFor(keyword, device, 20), priority: 1 });
  log(`\n== 4. Standard queue (POST /v3/serp/google/organic/task_post), ${tasks.length} tasks in one request, depth 20, priority normal ==`);
  const posted = await call('POST', '/v3/serp/google/organic/task_post', tasks);
  const ids = new Map();
  let postCost = 0, created = 0;
  for (const task of posted.tasks || []) {
    postCost += task.cost || 0;
    if (task.status_code === 20100) { created += 1; ids.set(task.id, task.data?.tag); }
    else log(`  post refused: ${task.status_code} ${task.status_message} (${task.data?.tag})`);
  }
  log(`  ${created}/${tasks.length} tasks created; posting cost ${money(postCost)} -> ${money(created ? postCost / created : null)} per task`);
  if (!created) return null;
  const startedAt = Date.now();
  const done = new Map();
  const deadlineMs = Number(process.env.SERP_PROBE_QUEUE_WAIT_MS || 240000);
  const pollMs = Number(process.env.SERP_PROBE_POLL_MS || 10000);
  while (done.size < ids.size && Date.now() - startedAt < deadlineMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    const ready = await call('GET', '/v3/serp/google/organic/tasks_ready');
    for (const t of ready.tasks || []) {
      for (const item of t.result || []) {
        if (!ids.has(item.id) || done.has(item.id)) continue;
        const got = await call('GET', `/v3/serp/google/organic/task_get/advanced/${item.id}`);
        const task = got.tasks?.[0];
        done.set(item.id, { task, elapsedMs: Date.now() - startedAt });
      }
    }
    log(`  ${Math.round((Date.now() - startedAt) / 1000)}s: ${done.size}/${ids.size} ready`);
  }
  const out = {};
  for (const [id, { task, elapsedMs }] of done) {
    const tag = ids.get(id);
    log(`  ready after ${Math.round(elapsedMs / 1000)}s:`);
    const r = summarise(task, tag);
    if (r) out[tag] = r;
  }
  if (done.size < ids.size) log(`  ${ids.size - done.size} task(s) NOT ready within ${deadlineMs / 1000}s -- the writer must collect on a later run, not block`);
  compareDevices(out, KEYWORDS, '|20');
  return created ? postCost / created : null;
}

async function probeSerp() {
  if (!SPEND) { log('\n== 3/4. Live SERP and queue skipped (SERP_PROBE_SPEND=false) =='); return; }
  const livePer = await probeLive();
  const queuePer = await probeQueue();
  log('\n  weekly projection, 300 keywords x 2 devices:');
  if (livePer != null) log(`    live, one call each:  ${money(livePer * 600)} per run, ${money(livePer * 600 * 52)} per year, 600 sequential requests`);
  if (queuePer != null) log(`    standard queue:       ${money(queuePer * 600)} per run, ${money(queuePer * 600 * 52)} per year, 6 batched requests + collection`);
}

const account = await probeAccount();
await probeLocation();
await probeSerp();
log(`\nDone. Balance before this run ${money(account.money?.balance)}; nothing written to SILO.`);
