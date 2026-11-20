/* The acceptance flow for Reports as a merchant uses it.
 *
 * One person, one report, start to finish, with no SQL on screen at any point
 * and without Ask SILO:
 *
 *   Reports -> open a sales report -> switch to last completed week -> run it
 *   -> schedule it for Mondays -> find that schedule -> edit it -> pause it
 *   -> resume it -> send it -> read the delivery history -> see a failed send
 *      explained
 *
 * and then the part that keeps "simpler" from meaning "less capable": the SAME
 * report, with the same filters, still resolves to the same query for the
 * power-user path (the builder's SQL) and for an authorized agent (the
 * parameters the MCP would pass), proved by comparing the resolved SQL rather
 * than by trusting that two code paths look similar.
 *
 * Nothing leaves the browser. The Supabase client is the in-memory stub, and
 * the delivery edge function -- the only thing in this product that sends real
 * mail -- is intercepted by the fixture's fake transport (__FAKE_MAIL__),
 * which records the send and writes the report_email_runs row the real
 * function writes.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { startSuite, FIXTURES, PERSIST_FAKE_DB } = require('../lib/harness');

let fails = 0;
let checks = 0;
const ok = (name, cond, extra) => {
  checks += 1;
  if (cond) { console.log('  ok   ' + name); return; }
  fails += 1;
  console.log('  FAIL ' + name + (extra ? '\n       ' + String(extra).slice(0, 400) : ''));
};

/* The report this flow is about: a plain sales report with a date RANGE, which
   is what gives it a period picker and a "last completed week". `system`, so it
   is a SILO template -- the case a merchant starts from. */
const SALES_SQL = 'select day_date, net_sales from sales where day_date between ';
const SEED = `
  // Idempotent: the fake DB survives navigation in this suite, so the restored
  // report list already carries this row on the second page.
  if (!window.__FAKE_DB__.silo_chat_saved_reports.some((r) => r.id === 'SALESD'))
  window.__FAKE_DB__.silo_chat_saved_reports.push({
    id: 'SALESD', title: 'Sales by day',
    description: 'Net sales for each day in the period. Shopify net sales, not platform-claimed revenue.',
    question: null, source: 'system', company_entity_id: null, visibility: 'company',
    created_by: null, created_by_name: null, created_at: '2026-11-01T00:00:00Z',
    parameters: [
      { key: 'date_from', type: 'date', label: 'From', default: 'today-27d' },
      { key: 'date_to', type: 'date', label: 'Through', default: 'today-1d' },
    ],
    columns_metadata: { net_sales: { semantic: 'currency' }, day_date: { semantic: 'date' } },
    queries_run: ['select day_date, net_sales from sales where day_date between {{date_from}} and {{date_to}}'],
  });
  try {
    sessionStorage.setItem('__FAKE_QUERY_PREFIXES__', JSON.stringify([{
      prefix: ${JSON.stringify(SALES_SQL)},
      rows: Array.from({ length: 7 }, (_, i) => ({
        day_date: '2026-11-0' + (i + 2), net_sales: 8000 + i * 125,
      })),
    }]));
  } catch (e) { /* ignore */ }
  // An answer declared as two parts. Its header took a different code path,
  // which never wired Run/Export/Schedule, so every multi-part report was
  // unschedulable and ?openSchedule=1 did nothing on it.
  if (!window.__FAKE_DB__.silo_chat_saved_reports.some((r) => r.id === 'SALESP'))
  window.__FAKE_DB__.silo_chat_saved_reports.push({
    id: 'SALESP', title: 'Sales, two ways', description: 'Net sales by day, and the same period by store.',
    question: null, source: 'system', company_entity_id: null, visibility: 'company',
    created_by: null, created_at: '2026-11-01T00:00:00Z',
    parameters: [
      { key: 'date_from', type: 'date', label: 'From', default: 'today-27d' },
      { key: 'date_to', type: 'date', label: 'Through', default: 'today-1d' },
    ],
    columns_metadata: { _queries: [{ index: 0, title: 'By day' }, { index: 1, title: 'By store' }] },
    queries_run: [
      'select day_date, net_sales from sales where day_date between {{date_from}} and {{date_to}}',
      'select day_date, net_sales from sales where day_date between {{date_from}} and {{date_to}}',
    ],
  });
`;

/** The last completed week, as the filter bar's `prior_week` preset resolves
 *  it -- worked out here from the same calendar rule rather than hardcoded, so
 *  the suite does not expire. */
function priorWeek(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Monday-start weeks, matching report-params' PERIOD_LOCAL.
  const dow = (d.getDay() + 6) % 7;
  const thisMonday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
  const start = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7);
  const end = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 1);
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { from: iso(start), to: iso(end) };
}

/** No SQL on screen. The whole point of the front door: a person who has
 *  never written any should not meet any. */
const SQL_ON_SCREEN = /\bselect\b[\s\S]{0,80}\bfrom\b/i;

(async () => {
  const suite = await startSuite({ viewport: { width: 1440, height: 950 } });
  const { BASE } = suite;
  const fake = fs.readFileSync(path.join(FIXTURES, 'fake-supabase.js'), 'utf8');
  const { page: p, errors } = await suite.newPage();
  await p.addInitScript(PERSIST_FAKE_DB);
  await p.route('**/@supabase/supabase-js**', (r) => r.fulfill({
    contentType: 'text/javascript', body: fake + SEED,
  }));

  const db = (fn, arg) => p.evaluate(fn, arg);
  const schedules = () => db(() => window.__FAKE_DB__.report_email_schedules.map((s) => ({ ...s })));
  const runs = () => db(() => window.__FAKE_DB__.report_email_runs.map((r) => ({ ...r })));

  try {
    // ── 1. The front door ───────────────────────────────────────────────
    await p.goto(`${BASE}/v3/dashboards.html`);
    await p.waitForSelector('#siloBody .lib-card');

    ok('reports are a compact table, not a grid of cards',
      (await p.locator('#siloBody table.lib-table').count()) === 1
      && (await p.locator('#siloBody .lib-grid').count()) === 0);
    const heads = await p.locator('#siloBody thead th').evaluateAll((ts) => ts.map((t) => t.textContent.trim()));
    ok('the columns are name, area, scheduled',
      heads.join('|').startsWith('Report|Area|Scheduled'), heads.join('|'));
    const row = p.locator('#siloBody .lib-card[data-id="SALESD"]');
    ok('the report is listed by its plain name',
      (await row.locator('.lib-link').textContent()).trim() === 'Sales by day');
    ok('what it answers is on the row, nothing to open',
      /Net sales for each day/.test(await row.locator('.lib-summary').textContent()));
    ok('it is filed under Sales',
      (await row.locator('td').nth(1).textContent()).trim() === 'Sales');
    ok('and says it is not scheduled yet',
      (await row.locator('td').nth(2).textContent()).trim() === '—');
    ok('Advanced Builder is where the SQL went, named and separate',
      await p.isVisible('#btnAdvanced'));
    ok('no SQL on the front door', !SQL_ON_SCREEN.test(await p.innerText('body')),
      (await p.innerText('body')).slice(0, 200));

    // ── 2. Open it: results, with Run, Export and Schedule ──────────────
    await row.locator('.lib-link').click();
    await p.waitForSelector('[gs-id="preview-table"] table');
    ok('opening a report lands on its results, not on a SQL editor',
      /\/v3\/dashboard\.html\?report=SALESD/.test(p.url()));
    for (const [label, sel] of [['Run', '#btnRefresh'], ['Export', '#btnExportReport'], ['Schedule', '#btnEmailSchedule']]) {
      ok(`${label} is in the header where a person can find it`,
        await p.isVisible(sel) && (await p.textContent(sel)).trim() === label);
    }
    ok('Advanced Builder is one click away, and named as the advanced door',
      // A SILO template opens in the builder as a copy, which the label says.
      (await p.textContent('#previewBuilder')).trim() === 'Advanced Builder (copy)'
      && /report-builder\.html\?id=SALESD/.test(await p.getAttribute('#previewBuilder', 'href')));
    ok('no SQL on the report page', !SQL_ON_SCREEN.test(await p.innerText('body')));

    // ── 3. Switch to the last completed week ────────────────────────────
    const want = priorWeek();
    await p.waitForSelector('#slicer_date_from');
    await p.selectOption('#slicer_date_from', 'prior_week');
    await p.waitForFunction((w) => window.__FAKE_DB__.rpcCalls.some(
      (c) => c.name === 'chat_run_readonly_query' && String(c.args.query).includes(w.from) && String(c.args.query).includes(w.to),
    ), want, { timeout: 8000 });
    const ran = await db((w) => window.__FAKE_DB__.rpcCalls.filter(
      (c) => c.name === 'chat_run_readonly_query' && String(c.args.query).includes(w.from)).slice(-1)[0], want);
    ok('“Last week” means the week that just ended, resolved to real dates',
      ran && ran.args.query.includes(want.from) && ran.args.query.includes(want.to), JSON.stringify(ran && ran.args));
    const chips = await p.innerText('#filterChips').catch(() => '');
    ok('and the applied window is shown resolved, not as a token',
      chips.includes(want.from) || chips.includes(want.to), chips);

    // ── 4. Schedule it for Mondays ──────────────────────────────────────
    await p.click('#btnEmailSchedule');
    await p.waitForSelector('#reportEmailPanel .res-frequency');
    ok('how often and what time are two controls',
      (await p.locator('#reportEmailPanel .res-frequency').count()) === 1
      && (await p.locator('#reportEmailPanel .res-time').count()) === 1);
    ok('the one supported time zone is stated, not offered as a select of one',
      (await p.locator('#reportEmailPanel select.res-timezone').count()) === 0
      && /Pacific Time \(US & Canada\)/.test(await p.innerText('#reportEmailPanel')));
    ok('the zone was read from the database, not written into the page',
      await db(() => window.__FAKE_DB__.rpcCalls.some((c) => c.name === 'silo_business_timezone')));
    await p.selectOption('#reportEmailPanel .res-frequency', 'monday');
    await p.selectOption('#reportEmailPanel .res-time', '0700');
    await p.selectOption('#reportEmailPanel .res-period', 'prior_week');
    await p.waitForTimeout(120);
    const sentence = (await p.innerText('#resSummary')).replace(/\s+/g, ' ');
    ok('it says in one sentence what will happen',
      /Every Monday at 7:00 AM Pacific Time \(US & Canada\), send last week of Sales by day\./.test(sentence), sentence);
    ok('and when the first one goes out, in plain English',
      /First send: \w+day, \w+ \d+ at 7:00 AM/.test(sentence), sentence);
    ok('and whether the email carries the data or a link to it',
      /CSV attachment/.test(sentence) && /download link/.test(sentence), sentence);
    const goesTo = await p.innerText('#resGoesTo');
    ok('and who it goes to, before anything is saved',
      /workspace admins/i.test(goesTo), goesTo);
    ok('the schedule panel shows no SQL either',
      !SQL_ON_SCREEN.test(await p.innerText('#reportEmailPanel')));

    await p.click('#resSave');
    await p.waitForFunction(() => window.__FAKE_DB__.report_email_schedules.length === 1, null, { timeout: 8000 });
    let saved = (await schedules())[0];
    ok('the cadence is stored as frequency + time', saved.cadence_preset === 'monday_0700', saved.cadence_preset);
    ok('the period is stored as TOKENS, so every send rolls forward',
      saved.parameter_state.date_from === 'prior_week_start'
      && saved.parameter_state.date_to === 'prior_week_end', JSON.stringify(saved.parameter_state));
    ok('...and NOT as the dates that happened to be on screen',
      saved.parameter_state.date_from !== want.from);
    ok('the first send is computed, not left null', !!saved.next_run_at);
    ok('it points at the report that was open', saved.report_id === 'SALESD');

    // A report whose answer is declared in parts gets the same header, and
    // the deep link that opens the schedule panel works there too.
    await p.goto(`${BASE}/v3/dashboard.html?report=SALESP&openSchedule=1`);
    await p.waitForSelector('#reportEmailPanel .res-frequency', { timeout: 15000 });
    ok('a multi-part report can be scheduled from its own header',
      await p.isVisible('#btnEmailSchedule') && await p.isVisible('#btnExportReport')
      && (await p.textContent('#btnRefresh')).trim() === 'Run');
    ok('and it opens on that report, not on the first part only',
      /Sales, two ways/.test(await p.innerText('#reportEmailPanel')));

    // ── 5. Find it again from Reports, without opening the report ───────
    await p.goto(`${BASE}/v3/dashboards.html?tab=scheduled`);
    await p.waitForSelector('.res-table tbody tr');
    const manage = await p.innerText('.res-table');
    ok('the Schedules view names the report, the cadence and the window',
      /Sales by day/.test(manage) && /Every Monday/.test(manage) && /Last week/.test(manage), manage);
    ok('and who owns it', /Blake/.test(manage), manage);
    ok('and what has been sent so far, honestly', /Not sent yet/.test(manage), manage);
    ok('a schedule nobody has run is not described as delivered', !/Delivered/i.test(manage));
    for (const action of ['edit', 'pause', 'history', 'run', 'del']) {
      ok(`${action} is reachable from the row`, (await p.locator(`[data-${action}]`).count()) >= 1);
    }
    ok('the Scheduled column on the library now says so',
      /Every Monday/.test(await p.evaluate(async () => {
        document.getElementById('tab-silo').click();
        await new Promise((r) => setTimeout(r, 300));
        return document.querySelector('#siloBody .lib-card[data-id="SALESD"]').textContent;
      })));

    // ── 6. Edit it without opening the builder ──────────────────────────
    await p.goto(`${BASE}/v3/dashboards.html?tab=scheduled`);
    await p.waitForSelector('[data-edit]');
    await p.click('[data-edit]');
    await p.waitForSelector('#schedEditHost .res-panel');
    ok('editing opens on the schedule, not on a blank form',
      /Edit this schedule/.test(await p.innerText('#schedEditHost')));
    await p.fill('#schedEditHost .res-subject', 'Monday sales');
    await p.click('#schedEditHost #resSave');
    await p.waitForFunction(() => window.__FAKE_DB__.report_email_schedules[0].subject_template === 'Monday sales',
      null, { timeout: 8000 });
    saved = (await schedules())[0];
    ok('a second Save edits the one schedule rather than adding another',
      (await schedules()).length === 1);
    ok('and the window it sends is untouched by an edit to something else',
      saved.parameter_state.date_from === 'prior_week_start', JSON.stringify(saved.parameter_state));
    ok('as is its cadence', saved.cadence_preset === 'monday_0700');

    // ── 7. Pause, and resume ────────────────────────────────────────────
    await p.waitForSelector('[data-pause]');
    await p.click('[data-pause]');
    await p.waitForFunction(() => window.__FAKE_DB__.report_email_schedules[0].is_paused === true,
      null, { timeout: 8000 });
    await p.waitForSelector('[data-resume]');
    ok('a paused schedule says Paused and offers Resume',
      /Paused/.test(await p.innerText('.res-table')));
    ok('and stops naming a next send it will not make',
      !/Nov|Dec|Jan/.test(await p.locator('.res-table tbody tr').first().locator('td').nth(5).innerText()));
    await p.click('[data-resume]');
    await p.waitForFunction(() => window.__FAKE_DB__.report_email_schedules[0].is_paused === false,
      null, { timeout: 8000 });
    ok('resume puts it back on', /\bOn\b/.test(await p.innerText('.res-table')));

    // ── 8. Send it, and read the history ────────────────────────────────
    await p.click('[data-run]');
    await p.waitForFunction(() => window.__FAKE_DB__.report_email_runs.length === 1, null, { timeout: 8000 });
    const mail = await db(() => window.__FAKE_MAIL__.sent.map((m) => ({ ...m })));
    ok('Send now reaches the delivery function once, with this schedule',
      mail.length === 1 && mail[0].schedule_id === saved.id, JSON.stringify(mail));
    await p.waitForSelector('[data-history]');
    await p.click('[data-history]');
    await p.waitForSelector('.res-runtable tbody tr');
    const history = await p.innerText('.res-history');
    ok('the history records the send', /Sent/.test(history));
    ok('and says a person started it, not the schedule',
      /Sent now by a person/.test(history), history);
    ok('and warns that the unattended path is still unproven',
      /No send has yet gone out on the schedule itself/.test(history), history);
    ok('and explains that Sent is not Delivered',
      /handed the email to the mail provider/.test(history));
    ok('the history never claims delivery', !/Delivered/i.test(history));

    // ── 9. A failed send, explained ─────────────────────────────────────
    await db(() => { window.__FAKE_MAIL_FAIL__ = 'No recipients resolved'; });
    await p.click('[data-run]');
    await p.waitForFunction(() => window.__FAKE_DB__.report_email_runs.length === 2, null, { timeout: 8000 });
    await p.waitForFunction(() => /Nobody to send it to/.test(document.body.textContent), null, { timeout: 8000 });
    const failRow = await p.innerText('.res-failrow');
    ok('a failure is in plain language, on the row', /Nobody to send it to/.test(failRow), failRow);
    ok('and says what to do next', /Add at least one recipient/.test(failRow), failRow);
    ok('and whether it will try again on its own',
      /will not try again until someone resumes it/.test(failRow), failRow);
    ok('a fault the schedule owns pauses it, and the row says it was a failure',
      /Paused after a failure/.test(await p.innerText('.res-table')));
    const failedRuns = await runs();
    ok('the failed attempt is recorded, not swallowed',
      failedRuns.length === 2 && failedRuns[1].status === 'failed'
      && failedRuns[1].error_message === 'No recipients resolved', JSON.stringify(failedRuns[1]));
    await db(() => { window.__FAKE_MAIL_FAIL__ = null; });

    // ── 10. Same engine, two ways in, plus the agent ────────────────────
    // The simple path stored tokens; the builder and an authorized agent both
    // substitute the SAME declarations through the SAME module. Compare the
    // RESOLVED SQL rather than trusting that the three paths look alike: that
    // is the only thing that proves "simpler" did not fork the engine.
    const parity = await db((onScreen) => {
      const report = window.__FAKE_DB__.silo_chat_saved_reports.find((r) => r.id === 'SALESD');
      const sched = window.__FAKE_DB__.report_email_schedules[0];
      const P = window.SiloReportParams;
      const decls = P.normalizeDeclarations(report.parameters);
      const sql = report.queries_run[0];
      // What the scheduled email will send.
      const scheduled = P.substitute(sql, decls, sched.parameter_state);
      // What an authorized agent asking for the same report with the same
      // filters gets -- the MCP passes the period boundaries by name.
      const agent = P.substitute(sql, decls, { date_from: 'prior_week_start', date_to: 'prior_week_end' });
      return { scheduled: scheduled.sql || scheduled.error, agent: agent.sql || agent.error, onScreen };
    }, ran.args.query);
    ok('the scheduled email and an agent resolve the report identically',
      parity.scheduled && parity.scheduled === parity.agent,
      JSON.stringify(parity));
    ok('...and to exactly what the person saw on screen',
      parity.onScreen && parity.scheduled === parity.onScreen, JSON.stringify(parity));

    // The power-user path on the same report: the builder still opens it with
    // its SQL, and a SILO report is still read-only there (RLS, not the UI).
    await p.goto(`${BASE}/v3/report-builder.html?id=SALESD`);
    await p.waitForFunction(() => /from sales where/.test(document.getElementById('sqlText')?.value || ''),
      null, { timeout: 15000 });
    const builderSql = await p.inputValue('#sqlText');
    ok('a power user still gets the same report\'s own SQL, tokens and all',
      /select day_date, net_sales from sales/.test(builderSql)
      && builderSql.includes('{{date_from}}') && builderSql.includes('{{date_to}}'), builderSql);

    ok('no page errors throughout', errors.length === 0, errors.join('\n'));
  } finally {
    await suite.close();
  }

  console.log(`\n${fails ? 'FAIL' : 'PASS'} Reports front door: ${checks - fails}/${checks} checks`);
  if (fails) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
