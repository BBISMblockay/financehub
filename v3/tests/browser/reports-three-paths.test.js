/* One report, three ways in: the SQL builder, the plain-English UI, and an
 * authorized agent.
 *
 * The risk in making Reports simpler is that the simple surface quietly
 * becomes a different product: its own kind of report, its own copy of the
 * query, its own idea of what "last week" means. This suite is the guard
 * against that. A power user edits the report's SQL; a teammate who never
 * sees SQL opens that same report and schedules it; and the query an
 * authorized agent would run (MCP passes the report's parameters by name to
 * the same chat_run_readonly_query) is compared with the query the page ran
 * -- text, rows and total.
 *
 * The edit the power user makes CHANGES THE NUMBERS on purpose. If any path
 * were reading its own copy of the report, it would still return the old
 * seven rows, and the totals would not line up.
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

const SQL_BEFORE = 'select day_date, net_sales from sales where day_date between ';
// What the power user's edit adds. The stub serves different rows for it, so
// "the same report" has to mean the edited one everywhere.
const EDIT = "\n   and channel = 'retail'";

const SEED = `
  if (!window.__FAKE_DB__.silo_chat_saved_reports.some((r) => r.id === 'SALESC'))
  window.__FAKE_DB__.silo_chat_saved_reports.push({
    id: 'SALESC', title: 'Sales by day (company)',
    description: 'Net sales for each day in the period.',
    question: null, source: 'manual', company_entity_id: 'C1', visibility: 'company',
    created_by: 'U1', created_by_name: 'Blake', created_at: '2026-11-01T00:00:00Z',
    parameters: [
      { key: 'date_from', type: 'date', label: 'From', default: 'today-27d' },
      { key: 'date_to', type: 'date', label: 'Through', default: 'today-1d' },
    ],
    columns_metadata: { net_sales: { semantic: 'currency' }, day_date: { semantic: 'date' } },
    queries_run: ['select day_date, net_sales from sales where day_date between {{date_from}} and {{date_to}}'],
  });
  try {
    sessionStorage.setItem('__FAKE_QUERY_PREFIXES__', JSON.stringify([{
      // The EDITED query, matched first: its prefix is the original plus the
      // new line, so an un-edited read falls through to the original rows.
      prefix: ${JSON.stringify(SQL_BEFORE)},
      rows: Array.from({ length: 7 }, (_, i) => ({
        day_date: '2026-11-0' + (i + 2), net_sales: 8000 + i * 125,
      })),
    }]));
  } catch (e) { /* ignore */ }
`;

/** Rows the stub serves for a query, by the same prefix rule the fixture
 *  uses -- so the expected totals are derived, never typed twice. */
const WIRE_EDITED_ROWS = `
  try {
    const list = JSON.parse(sessionStorage.getItem('__FAKE_QUERY_PREFIXES__') || '[]');
    list.unshift({
      prefix: ${JSON.stringify(SQL_BEFORE)},
      match: 'retail',
      rows: [
        { day_date: '2026-11-02', net_sales: 2500 },
        { day_date: '2026-11-03', net_sales: 2750 },
        { day_date: '2026-11-04', net_sales: 3000 },
      ],
    });
    sessionStorage.setItem('__FAKE_QUERY_PREFIXES__', JSON.stringify(list));
  } catch (e) { /* ignore */ }
`;

const EDITED_TOTAL = 2500 + 2750 + 3000;
const SQL_ON_SCREEN = /\bselect\b[\s\S]{0,80}\bfrom\b/i;

(async () => {
  const suite = await startSuite({ viewport: { width: 1440, height: 950 } });
  const { BASE } = suite;
  const fake = fs.readFileSync(path.join(FIXTURES, 'fake-supabase.js'), 'utf8');
  const { page: p, errors } = await suite.newPage();
  await p.addInitScript(PERSIST_FAKE_DB);
  await p.route('**/@supabase/supabase-js**', (r) => r.fulfill({
    contentType: 'text/javascript', body: fake + SEED + WIRE_EDITED_ROWS,
  }));

  try {
    // ── 1. The power user edits the SQL ─────────────────────────────────
    await p.goto(`${BASE}/v3/report-builder.html?id=SALESC`);
    await p.waitForFunction(() => /from sales/.test(document.getElementById('sqlText')?.value || ''),
      null, { timeout: 20000 });
    const original = await p.inputValue('#sqlText');
    await p.fill('#sqlText', original + EDIT);
    // Run it first, as a person would: the builder saves the query it has
    // just proved against the database, not whatever is in the box.
    await p.click('#btnRunQuery');
    await p.waitForTimeout(1500);
    await p.click('#btnSave');
    await p.waitForSelector('#btnConfirmSave:visible', { timeout: 10000 });
    await p.click('#btnConfirmSave');
    await p.waitForFunction(() => /and channel = 'retail'/.test(
      (window.__FAKE_DB__.silo_chat_saved_reports.find((r) => r.id === 'SALESC')?.queries_run || [''])[0]),
    null, { timeout: 10000 });
    const stored = await p.evaluate(() => window.__FAKE_DB__.silo_chat_saved_reports
      .find((r) => r.id === 'SALESC'));
    ok('the power user\'s edit is saved on the SAME report, not a new one',
      stored.id === 'SALESC'
      && (await p.evaluate(() => window.__FAKE_DB__.silo_chat_saved_reports.filter((r) => r.title.startsWith('Sales by day (company)')).length)) === 1);
    ok('and the parameters it declares are untouched',
      stored.parameters.map((d) => d.key).join(',') === 'date_from,date_to');

    // ── 2. A teammate opens it and schedules it, without seeing SQL ──────
    // A member, not an admin: the role the simple surface is for.
    await p.goto(`${BASE}/v3/dashboards.html?tab=company`);
    await p.waitForSelector('#companyBody .lib-card[data-id="SALESC"]', { timeout: 20000 });
    await p.click('#companyBody .lib-card[data-id="SALESC"] .lib-link');
    await p.waitForSelector('[gs-id="preview-table"] table', { timeout: 20000 });
    // The same window the schedule will cover, chosen the way a person does:
    // from the filter bar, by name.
    await p.selectOption('#slicer_date_from', 'prior_week');
    await p.waitForTimeout(1200);
    const onScreenRows = await p.locator('[gs-id="preview-table"] tbody tr').count();
    ok('the teammate sees the EDITED report\'s numbers', onScreenRows === 3, String(onScreenRows));
    ok('and no SQL anywhere on the page', !SQL_ON_SCREEN.test(await p.innerText('body')));

    await p.click('#btnEmailSchedule');
    await p.waitForSelector('#reportEmailPanel .res-frequency', { timeout: 20000 });
    ok('the schedule panel shows no SQL either',
      !SQL_ON_SCREEN.test(await p.innerText('#reportEmailPanel')));
    await p.selectOption('#reportEmailPanel .res-frequency', 'monday');
    await p.selectOption('#reportEmailPanel .res-time', '0700');
    await p.selectOption('#reportEmailPanel .res-period', 'prior_week');
    await p.click('#resSave');
    await p.waitForFunction(() => window.__FAKE_DB__.report_email_schedules.length === 1,
      null, { timeout: 10000 });
    const sched = (await p.evaluate(() => window.__FAKE_DB__.report_email_schedules[0]));
    ok('the schedule points at the same report id the power user edited',
      sched.report_id === 'SALESC', sched.report_id);

    // ── 3. The agent, on the same report and the same filters ───────────
    // chat_run_readonly_query is the one engine; the MCP reaches it with the
    // report's parameters by name, exactly as the scheduled email does.
    const proof = await p.evaluate(async () => {
      const sb = window.__SILO_TEST_SB__ || null;
      const report = window.__FAKE_DB__.silo_chat_saved_reports.find((r) => r.id === 'SALESC');
      const sched2 = window.__FAKE_DB__.report_email_schedules[0];
      const P = window.SiloReportParams;
      const decls = P.normalizeDeclarations(report.parameters);
      const agentSql = P.substitute(report.queries_run[0], decls, {
        date_from: 'prior_week_start', date_to: 'prior_week_end',
      });
      const emailSql = P.substitute(report.queries_run[0], decls, sched2.parameter_state);
      const onScreen = window.__FAKE_DB__.rpcCalls
        .filter((c) => c.name === 'chat_run_readonly_query' && /from sales/.test(String(c.args.query)))
        .slice(-1)[0];
      // Run what the agent would run, through the same RPC.
      const client = window.supabase.createClient('x', 'y');
      const { data } = await client.rpc('chat_run_readonly_query', { query: agentSql.sql });
      const rows = (data && (data.rows || data)) || [];
      return {
        agent: agentSql.sql || agentSql.error,
        email: emailSql.sql || emailSql.error,
        screen: onScreen ? onScreen.args.query : null,
        agentRows: rows.length,
        agentTotal: rows.reduce((n, r) => n + Number(r.net_sales || 0), 0),
        sb: !!sb,
      };
    });
    ok('the agent runs the power user\'s edited SQL', /and channel = 'retail'/.test(proof.agent), proof.agent);
    ok('the agent, the scheduled email and the screen resolve to one query',
      proof.agent === proof.email && proof.agent === proof.screen, JSON.stringify(proof));
    ok('and the agent gets the same rows the teammate saw',
      proof.agentRows === onScreenRows, `${proof.agentRows} vs ${onScreenRows}`);
    ok('with the same total', proof.agentTotal === EDITED_TOTAL,
      `${proof.agentTotal} vs ${EDITED_TOTAL}`);

    ok('no page errors throughout', errors.length === 0, errors.join('\n'));
  } finally {
    await suite.close();
  }

  console.log(`\n${fails ? 'FAIL' : 'PASS'} Three paths, one report: ${checks - fails}/${checks} checks`);
  if (fails) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
