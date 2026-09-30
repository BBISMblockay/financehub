/* Report ownership and reversible archive, through the real library page.
 * Only Supabase is faked: assert the RPC boundary as well as the visible UI.
 * Database authorization and tenant isolation have their own SQL tests. */
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { startSuite, PERSIST_FAKE_DB, FIXTURES } = require('../lib/harness');

const USAGE = 'saved_report_archive_usage';
const ARCHIVE = 'set_saved_report_archived';
const action = (id, kind = 'archive', pane = 'mineBody') =>
  `#${pane} [data-report-action="${kind}"][data-report-id="${id}"]`;

async function seed(page) {
  await page.addInitScript(PERSIST_FAKE_DB);
  await page.goto(`${BASE}/v3/dashboards.html?tab=mine`);
  await page.waitForFunction(() => !!window.__FAKE_DB__);
  await page.evaluate(() => {
    const db = window.__FAKE_DB__;
    const example = db.silo_chat_saved_reports.find((r) => r.id === 'R1');
    db.silo_chat_saved_reports.push(
      { ...example, id: 'M_PRIVATE', title: 'Private ' + 'unbroken'.repeat(22), visibility: 'private' },
      { ...example, id: 'M_ARCHIVED', title: 'Previously archived', archived_at: '2026-09-29T10:00:00Z' },
      { ...example, id: 'M_OTHER_ARCHIVED', title: 'Colleague archived', created_by: 'U9', created_by_name: 'Jon Loomis', archived_at: '2026-09-29T10:00:00Z' },
      { ...example, id: 'M_OWNERLESS', title: 'Legacy unattributed shared report', created_by: null, created_by_name: null },
    );
    db.dashboards.push(
      { ...db.dashboards[0], id: 'D_PRIVATE', created_by: 'U9', visibility: 'private', name: 'SECRET BOARD NEVER DISCLOSE' },
      { ...db.dashboards[0], id: 'D_SHARED', created_by: 'U9', visibility: 'company', name: 'Quarterly <img src=x onerror="window.__archiveXss=1"> report' },
      { ...db.dashboards[0], id: 'D_FOREIGN', company_entity_id: 'C9', name: 'OTHER TENANT BOARD NEVER DISCLOSE' },
    );
    db.dashboard_widgets.push(...['D1', 'D1', 'D_PRIVATE', 'D_SHARED', 'D_FOREIGN'].map((id, i) => ({
      id: `WM${i}`, dashboard_id: id, report_id: 'R1', query_index: 0,
      title: 'Existing report tile', visual_type: 'table', visual_config: {},
      layout: { x: (i % 2) * 6, y: 0, w: 6, h: 4 }, sort_order: i,
    })));
    sessionStorage.setItem('__FAKE_DB_STATE__', JSON.stringify({
      silo_chat_saved_reports: db.silo_chat_saved_reports,
      dashboards: db.dashboards, dashboard_widgets: db.dashboard_widgets,
    }));
  });
  await page.reload();
  await page.waitForSelector(action('R1'));
}

const calls = (page, name) => page.evaluate((n) => window.__FAKE_DB__.rpcCalls.filter((c) => c.name === n), name);
const report = (page, id) => page.evaluate((i) => window.__FAKE_DB__.silo_chat_saved_reports.find((r) => r.id === i), id);
const ids = (page, pane) => page.$$eval(`#${pane} .lib-card`, (els) => els.map((e) => e.dataset.id).sort());
const waitReady = (page) => page.waitForFunction(() => {
  const button = document.getElementById('btnConfirmArchive');
  return document.getElementById('archiveDialog').open && button && !button.disabled;
});
async function openAction(page, id, kind = 'archive', pane = 'mineBody') {
  await page.click(action(id, kind, pane));
  await page.waitForSelector('#archiveDialog[open]');
  await waitReady(page);
}
async function waitClosed(page) {
  await page.waitForFunction(() => !document.getElementById('archiveDialog').open);
}

let BASE;
(async () => {
  const suite = await startSuite({ viewport: { width: 1280, height: 820 } });
  BASE = suite.BASE;
  try {
    const { page: p, errors } = await suite.newPage();
    await seed(p);
    const dbReports = await p.evaluate(() => window.__FAKE_DB__.silo_chat_saved_reports);
    const owned = (r) => r.created_by === 'U1' && r.company_entity_id != null && r.source !== 'system';
    const sortedIds = (rows) => rows.map((r) => r.id).sort();

    // My means ownership, including private AND shared reports. Company is
    // intentionally overlapping, and legacy attribution never invents an owner.
    assert.deepEqual(await ids(p, 'mineBody'), sortedIds(dbReports.filter((r) => owned(r) && !r.archived_at)));
    assert.match(await p.innerText('#mineBody .lib-card[data-id="M_PRIVATE"]'), /Only me|Private/i);
    assert.equal(await p.locator(action('R11')).count(), 0, 'an owner role is not the report creator');
    await p.click('#tab-company');
    assert.deepEqual(await ids(p, 'companyBody'), sortedIds(dbReports.filter((r) => r.source !== 'system' && r.company_entity_id != null && r.visibility === 'company' && !r.archived_at)));
    assert.match(await p.innerText('#companyBody .lib-card[data-id="R11"]'), /Jon Loomis/, 'owner is visible without opening Details');
    assert.match(await p.innerText('#companyBody .lib-card[data-id="R1"]'), /Blake|\byou\b/i, 'own shared report is clearly attributed too');
    assert.equal(await p.locator(action('R1', 'archive', 'companyBody')).count(), 1);
    assert.equal(await p.locator(action('R11', 'archive', 'companyBody')).count(), 0);
    assert.equal(await p.locator(action('M_OWNERLESS', 'archive', 'companyBody')).count(), 0);
    await p.click('#tab-archived');
    assert.deepEqual(await ids(p, 'archivedBody'), ['M_ARCHIVED']);
    assert.equal(await p.locator(action('M_ARCHIVED', 'restore', 'archivedBody')).count(), 1);
    await p.click('#tab-silo');
    assert.equal(await p.locator('#siloBody [data-report-action]').count(), 0, 'global definitions never offer archive');
    await p.click('#tab-mine');
    console.log('  PASS ownership, visibility, owner labels and archive scope');

    // A dependency warning includes every same-company dashboard in its
    // totals, but only readable names. Markup in a legitimate name is text.
    const before = await report(p, 'R1');
    const beforeWidgets = await p.evaluate(() => JSON.stringify(window.__FAKE_DB__.dashboard_widgets));
    await openAction(p, 'R1');
    assert.deepEqual((await calls(p, USAGE)).at(-1).args, { p_report_id: 'R1' });
    const body = await p.innerText('#archiveBody');
    assert.match(body, /3 dashboards?/i);
    assert.match(body, /4 (?:widgets?|tiles?)/i);
    assert.match(body, /Monday sales review/);
    assert.match(body, /Quarterly <img src=x onerror="window.__archiveXss=1"> report/);
    assert.match(body, /1[^\n]*(?:private|hidden|cannot|can.t|not (?:visible|accessible))|(?:private|hidden)[^\n]*1/i);
    assert.doesNotMatch(await p.innerHTML('#archiveDialog'), /SECRET BOARD NEVER DISCLOSE|OTHER TENANT BOARD NEVER DISCLOSE/);
    assert.equal(await p.locator('#archiveDialog img').count(), 0);
    assert.equal(await p.evaluate(() => window.__archiveXss), undefined);
    assert.match(await p.innerText('#archiveDialog'), /keep working|continue (?:to )?work|unchanged/i);
    assert.match(await p.innerText('#archiveDialog'), /not delet|nothing is delet|no.*delet|(?:quer|widget).*kept|keep.*(?:quer|widget)/i);
    assert.equal(await p.$eval('#archiveDialog', (d) => d.tagName), 'DIALOG');
    assert.equal(await p.getAttribute('#archiveDialog', 'aria-labelledby'), 'archiveTitle');
    for (let i = 0; i < 8; i++) {
      await p.keyboard.press('Tab');
      assert.equal(await p.evaluate(() => document.getElementById('archiveDialog').contains(document.activeElement)), true, 'native modal traps keyboard focus');
    }
    for (let i = 0; i < 8; i++) {
      await p.keyboard.press('Shift+Tab');
      assert.equal(await p.evaluate(() => document.getElementById('archiveDialog').contains(document.activeElement)), true, 'reverse keyboard focus stays in the dialog');
    }
    await p.keyboard.press('Escape');
    await waitClosed(p);
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.reportId), 'R1', 'cancel restores focus to the originating card action');
    assert.equal((await calls(p, ARCHIVE)).length, 0);
    assert.deepEqual(await report(p, 'R1'), before);
    console.log('  PASS dependency privacy, escaping, cancel and keyboard modality');

    // A delayed dependency result cannot resurrect a dismissed dialog or
    // overwrite the next report's warning. The old request finishes last.
    await p.evaluate((name) => {
      window.__FAKE_RPC_HANDLERS__ = { [name]: (args) => args.p_report_id === 'R1'
        ? new Promise((resolve) => { window.__releaseOldUsage = resolve; }) : undefined };
    }, USAGE);
    await p.click(action('R1'));
    await p.waitForFunction(() => !!window.__releaseOldUsage);
    assert.equal(await p.isDisabled('#btnConfirmArchive'), true, 'cannot archive before usage is known');
    await p.click('#btnCancelArchive');
    await waitClosed(p);
    await openAction(p, 'R2');
    const currentBody = await p.innerText('#archiveBody');
    await p.evaluate(() => window.__releaseOldUsage({ data: { dashboard_count: 991, widget_count: 992,
      dashboards: [{ id: 'STALE', name: 'STALE RESPONSE SHOULD NEVER SHOW' }], hidden_dashboard_count: 0 }, error: null }));
    await p.waitForTimeout(100);
    assert.equal(await p.innerText('#archiveBody'), currentBody);
    assert.doesNotMatch(await p.innerText('#archiveDialog'), /STALE RESPONSE|991|992/);
    await p.click('#btnCloseArchive');
    await waitClosed(p);
    await p.evaluate(() => { window.__FAKE_RPC_HANDLERS__ = {}; });
    console.log('  PASS cancellation invalidates late dependency responses');

    // Both Supabase's {error} response and a rejected Promise leave the
    // write gated. The explicit retry fetches usage again before enabling
    // the destructive-looking action; it must never itself archive a row.
    for (const thrown of [false, true]) {
      await p.evaluate(({ name, thrown }) => {
        window.__FAKE_RPC_HANDLERS__[name] = () => {
          if (thrown) throw new Error('dependency transport unavailable');
          return { data: null, error: { message: 'dependency service unavailable' } };
        };
      }, { name: USAGE, thrown });
      const beforeCalls = (await calls(p, ARCHIVE)).length;
      await p.click(action('R2'));
      await p.waitForFunction(() => /unavailable/.test(document.getElementById('archiveStatus').textContent));
      assert.equal(await p.isDisabled('#btnConfirmArchive'), true, 'usage failure fails closed');
      assert.equal((await calls(p, ARCHIVE)).length, beforeCalls);
      assert.equal((await report(p, 'R2')).archived_at, null);
      assert.equal(await p.isVisible('#btnRetryArchive'), true);
      const usageCallsBeforeRetry = (await calls(p, USAGE)).length;
      await p.evaluate((name) => { delete window.__FAKE_RPC_HANDLERS__[name]; }, USAGE);
      await p.click('#btnRetryArchive');
      await waitReady(p);
      assert.equal((await calls(p, USAGE)).length, usageCallsBeforeRetry + 1);
      assert.equal((await calls(p, ARCHIVE)).length, beforeCalls);
      assert.equal(await p.isHidden('#archiveStatus'), true);
      await p.click('#btnCancelArchive');
      await waitClosed(p);
    }
    await p.evaluate((name) => {
      window.__FAKE_RPC_HANDLERS__[name] = () => ({ data: { dashboards: [] }, error: null });
    }, USAGE);
    await p.click(action('R2'));
    await p.waitForFunction(() => !document.getElementById('archiveStatus').hidden);
    assert.equal(await p.isDisabled('#btnConfirmArchive'), true, 'missing usage is never interpreted as zero dependencies');
    await p.click('#btnCancelArchive');
    await waitClosed(p);
    await p.evaluate(() => { window.__FAKE_RPC_HANDLERS__ = {}; });
    console.log('  PASS failed and thrown usage calls fail closed and retry');

    for (const thrown of [false, true]) {
      await p.evaluate(({ name, thrown }) => {
        window.__FAKE_RPC_HANDLERS__[name] = () => {
          if (thrown) throw new Error('archive transport unavailable');
          return { data: null, error: { message: 'archive service unavailable' } };
        };
      }, { name: ARCHIVE, thrown });
      await openAction(p, 'R1');
      await p.click('#btnConfirmArchive');
      await p.waitForFunction(() => /unavailable/.test(document.getElementById('archiveStatus').textContent));
      assert.deepEqual(await report(p, 'R1'), before);
      assert.equal(await p.isVisible('#archiveDialog'), true);
      assert.equal(await p.isDisabled('#btnConfirmArchive'), false);
      await p.click('#btnCancelArchive');
      await waitClosed(p);
    }
    await p.evaluate(() => { window.__FAKE_RPC_HANDLERS__ = {}; });
    console.log('  PASS archive write failures leave the report active and retryable');

    // The in-flight mutation owns the dialog. Rapid activation, Escape and
    // Cancel cannot submit twice or make the pending result invisible.
    await openAction(p, 'R1');
    await p.evaluate((name) => {
      window.__FAKE_RPC_HANDLERS__[name] = () => new Promise((resolve) => { window.__releaseArchive = resolve; });
    }, ARCHIVE);
    const priorWrites = (await calls(p, ARCHIVE)).length;
    await p.evaluate(() => {
      document.getElementById('btnConfirmArchive').click();
      document.getElementById('btnConfirmArchive').click();
    });
    await p.waitForFunction(() => !!window.__releaseArchive);
    assert.equal((await calls(p, ARCHIVE)).length, priorWrites + 1);
    assert.equal(await p.isDisabled('#btnConfirmArchive'), true);
    assert.equal(await p.isDisabled('#btnCancelArchive'), true);
    assert.equal(await p.isDisabled('#btnCloseArchive'), true);
    await p.keyboard.press('Tab');
    assert.equal(await p.evaluate(() => document.getElementById('archiveDialog').contains(document.activeElement)), true, 'pending write retains keyboard focus');
    await p.keyboard.press('Escape');
    await p.evaluate(() => {
      document.getElementById('btnCancelArchive').click();
      document.getElementById('btnCloseArchive').click();
    });
    assert.equal(await p.isVisible('#archiveDialog'), true);
    assert.equal((await report(p, 'R1')).archived_at, null, 'no optimistic archive before the server replies');
    await p.evaluate(() => window.__releaseArchive(undefined));
    await waitClosed(p);
    const archived = await report(p, 'R1');
    assert.ok(archived.archived_at);
    assert.deepEqual({ ...archived, archived_at: null }, before, 'archiving changes no report SQL, name or sharing');
    assert.equal(await p.evaluate(() => JSON.stringify(window.__FAKE_DB__.dashboard_widgets)), beforeWidgets, 'archiving never deletes or rewrites widgets');
    assert.deepEqual((await calls(p, ARCHIVE)).at(-1).args, { p_report_id: 'R1', p_archived: true });
    assert.equal(await p.locator('#mineBody .lib-card[data-id="R1"]').count(), 0);
    await p.click('#tab-company');
    assert.equal(await p.locator('#companyBody .lib-card[data-id="R1"]').count(), 0);
    await p.click('#tab-archived');
    assert.equal(await p.locator(action('R1', 'restore', 'archivedBody')).count(), 1);
    await p.reload();
    await p.waitForSelector(action('R1', 'restore', 'archivedBody'));
    assert.equal(await p.getAttribute('#tab-archived', 'aria-selected'), 'true', 'archive state and selected tab survive reload');
    console.log('  PASS archive mutation, duplicate lock, preservation and persistence');

    // Existing references keep resolving archived SQL; discovery is the
    // only exclusion. This exercises the real renderer and real picker.
    await p.goto(`${BASE}/v3/dashboard.html?id=D1&edit=1`);
    await p.waitForSelector('.dw[data-widget-id="WM0"] .dw-table');
    assert.equal(await p.locator('.dw[data-widget-id="WM0"] .dw-empty--error').count(), 0);
    assert.ok((await calls(p, 'chat_run_readonly_query')).some((c) => c.args.query === before.queries_run[0]));
    await p.click('#btnAddWidget');
    await p.waitForSelector('#reportSearch');
    await p.fill('#reportSearch', before.title);
    assert.equal(await p.locator('.v3-report-card[data-report="R1"]').count(), 0, 'archived report is excluded from new-widget picker');
    await p.fill('#reportSearch', 'Daily sales trend');
    assert.equal(await p.locator('.v3-report-card[data-report="R2"]').count(), 1, 'active reports still available');
    await p.click('#btnCloseAdd');
    console.log('  PASS archived picker exclusion and existing widget SQL');

    // Restore has no usage gate, preserves the sharing setting, and handles
    // both error shapes without falsely moving the row out of Archived.
    await p.goto(`${BASE}/v3/dashboards.html?tab=archived`);
    await p.waitForSelector(action('R1', 'restore', 'archivedBody'));
    for (const thrown of [false, true]) {
      await p.evaluate(({ name, thrown }) => {
        window.__FAKE_RPC_HANDLERS__ = { [name]: () => {
          if (thrown) throw new Error('restore transport unavailable');
          return { data: null, error: { message: 'restore service unavailable' } };
        } };
      }, { name: ARCHIVE, thrown });
      const beforeUsage = (await calls(p, USAGE)).length;
      await openAction(p, 'R1', 'restore', 'archivedBody');
      assert.match(await p.innerText('#archiveTitle'), /Restore/i);
      assert.equal((await calls(p, USAGE)).length, beforeUsage, 'restore requires no dependency request');
      await p.click('#btnConfirmArchive');
      await p.waitForFunction(() => /unavailable/.test(document.getElementById('archiveStatus').textContent));
      assert.ok((await report(p, 'R1')).archived_at);
      assert.equal(await p.isVisible('#archiveDialog'), true);
      assert.equal(await p.isDisabled('#btnConfirmArchive'), false, 'failed write can be retried');
      await p.click('#btnCancelArchive');
      await waitClosed(p);
    }
    await p.evaluate(() => { window.__FAKE_RPC_HANDLERS__ = {}; });
    await openAction(p, 'R1', 'restore', 'archivedBody');
    await p.click('#btnConfirmArchive');
    await waitClosed(p);
    assert.deepEqual((await calls(p, ARCHIVE)).at(-1).args, { p_report_id: 'R1', p_archived: false });
    assert.deepEqual(await report(p, 'R1'), before);
    assert.equal(await p.locator('#archivedBody .lib-card[data-id="R1"]').count(), 0);
    await p.click('#tab-mine');
    assert.equal(await p.locator(action('R1')).count(), 1);
    await p.click('#tab-company');
    assert.equal(await p.locator('#companyBody .lib-card[data-id="R1"]').count(), 1);
    console.log('  PASS restore errors, retry and original visibility');

    await p.click('#tab-mine');
    await openAction(p, 'M_PRIVATE');
    await p.evaluate((name) => {
      window.__FAKE_RPC_HANDLERS__[name] = () => new Promise((resolve) => { window.__releasePrivateArchive = resolve; });
    }, ARCHIVE);
    await p.click('#btnConfirmArchive');
    await p.waitForFunction(() => !!window.__releasePrivateArchive);
    for (const key of ['Tab', 'Shift+Tab']) {
      await p.keyboard.press(key);
      assert.equal(await p.evaluate(() => document.activeElement?.id), 'archiveTitle', 'zero-dependency pending action retains focus when every button is disabled');
    }
    await p.evaluate(() => window.__releasePrivateArchive(undefined));
    await waitClosed(p);
    await p.evaluate(() => { window.__FAKE_RPC_HANDLERS__ = {}; });
    await p.click('#tab-archived');
    await openAction(p, 'M_PRIVATE', 'restore', 'archivedBody');
    await p.click('#btnConfirmArchive');
    await waitClosed(p);
    assert.equal((await report(p, 'M_PRIVATE')).visibility, 'private');
    await p.click('#tab-mine');
    assert.equal(await p.locator(action('M_PRIVATE')).count(), 1);
    await p.click('#tab-company');
    assert.equal(await p.locator('#companyBody .lib-card[data-id="M_PRIVATE"]').count(), 0, 'restoring a private report never publishes it');

    // The default standard-workspace hub remains dashboard-only. The
    // explicit management route used by Ask SILO must still offer recovery
    // without exposing the grandfathered SILO catalog or report authoring.
    const { page: standard, errors: standardErrors } = await suite.newPage();
    await standard.addInitScript(PERSIST_FAKE_DB);
    const config = fs.readFileSync(path.join(FIXTURES, 'fake-config.js'), 'utf8');
    await standard.route('**/pages/config.js', (route) => route.fulfill({
      contentType: 'text/javascript', body: config.replace("entity_key: 'baseballism'", "entity_key: 'another-company'"),
    }));
    await standard.goto(`${BASE}/v3/dashboards.html?tab=silo`);
    await standard.waitForSelector('#listBody .lib-card');
    assert.equal(await standard.isHidden('#tab-mine'), true);
    assert.equal(await standard.isHidden('#tab-company'), true);
    assert.equal(await standard.isHidden('#tab-archived'), true);
    await standard.goto(`${BASE}/v3/dashboards.html?manage=reports&tab=mine`);
    await standard.waitForSelector(action('R1'));
    assert.equal(await standard.isVisible('#tab-company'), true);
    assert.equal(await standard.isVisible('#tab-archived'), true);
    assert.equal(await standard.isHidden('#tab-silo'), true);
    assert.equal(await standard.isHidden('#btnNewReport'), true);
    await openAction(standard, 'R1');
    await standard.click('#btnConfirmArchive');
    await waitClosed(standard);
    await standard.click('#tab-archived');
    await openAction(standard, 'R1', 'restore', 'archivedBody');
    await standard.click('#btnConfirmArchive');
    await waitClosed(standard);
    assert.equal(new URL(standard.url()).searchParams.get('manage'), 'reports');
    assert.equal((await report(standard, 'R1')).archived_at, null);

    // Even after the last saved answer is archived, the modal header keeps
    // the one recovery link. A link inside report detail would disappear.
    await standard.goto(`${BASE}/v2/silo-chat.html`);
    await standard.waitForSelector('#btnSaved');
    await standard.evaluate(() => {
      const db = window.__FAKE_DB__;
      for (const r of db.silo_chat_saved_reports) if (r.source !== 'system') r.archived_at = '2026-09-29T00:00:00Z';
      sessionStorage.setItem('__FAKE_DB_STATE__', JSON.stringify({ silo_chat_saved_reports: db.silo_chat_saved_reports }));
    });
    await standard.click('#btnSaved');
    await standard.waitForFunction(() => /Nothing saved yet/.test(document.getElementById('savedBody').textContent));
    assert.equal(await standard.isVisible('#btnManageReports'), true);
    assert.equal(await standard.getAttribute('#btnManageReports', 'href'), '/v3/dashboards.html?manage=reports&tab=mine');
    await standard.click('#btnManageReports');
    await standard.waitForFunction(() => /No saved reports/.test(document.getElementById('mineBody').textContent));
    assert.equal(await standard.locator('#mineBody a[href*="report-builder"]').count(), 0, 'empty management page does not expose authoring');
    await standard.click('#tab-archived');
    await standard.waitForSelector(action('R1', 'restore', 'archivedBody'));
    assert.deepEqual(standardErrors, []);
    await standard.close();
    console.log('  PASS standard workspace explicit management route');

    // A page-sized batch of newer colleagues' reports cannot hide older
    // owned reports. This must exercise real .range() requests, not just
    // an unbounded in-memory array that masks the production row cap.
    const { page: large, errors: largeErrors } = await suite.newPage();
    await large.addInitScript(PERSIST_FAKE_DB);
    await large.goto(`${BASE}/v3/dashboards.html?tab=mine`);
    await large.waitForSelector(action('R1'));
    await large.evaluate(() => {
      const db = window.__FAKE_DB__;
      const template = db.silo_chat_saved_reports.find((r) => r.id === 'R1');
      db.silo_chat_saved_reports = Array.from({ length: 610 }, (_, i) => ({
        ...template, id: `L${String(i).padStart(4, '0')}`, title: `Page-spanning report ${i}`,
        created_by: i >= 600 ? 'U1' : 'U9', created_by_name: i >= 600 ? 'Blake' : 'Jon Loomis',
        archived_at: i === 609 ? '2026-09-29T00:00:00Z' : null,
        created_at: i >= 600 ? '2026-08-01T00:00:00Z' : '2026-09-29T00:00:00Z',
      }));
      sessionStorage.setItem('__FAKE_DB_STATE__', JSON.stringify({ silo_chat_saved_reports: db.silo_chat_saved_reports }));
    });
    await large.reload();
    await large.waitForSelector(action('L0600'));
    assert.deepEqual(await ids(large, 'mineBody'), Array.from({ length: 9 }, (_, i) => `L0${600 + i}`));
    const pages = await large.evaluate(() => window.__FAKE_DB__.queryCalls.filter((c) => c.table === 'silo_chat_saved_reports_v').map((c) => c.range));
    assert.deepEqual(pages, [{ from: 0, to: 499 }, { from: 500, to: 999 }]);
    await large.click('#tab-company');
    assert.equal((await ids(large, 'companyBody')).length, 609);
    await large.click('#tab-archived');
    assert.deepEqual(await ids(large, 'archivedBody'), ['L0609']);
    assert.deepEqual(largeErrors, []);
    await large.close();
    console.log('  PASS paginated reports preserve older owned and archived rows');

    const phoneContext = await suite.newContext({ viewport: { width: 390, height: 844 } });
    const phone = await phoneContext.newPage();
    const phoneErrors = [];
    phone.on('pageerror', (err) => phoneErrors.push(String(err)));
    await seed(phone);
    for (const tab of ['mine', 'company', 'archived']) {
      await phone.click(`#tab-${tab}`);
      assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${tab} does not overflow phone width`);
    }
    await phone.click('#tab-mine');
    await openAction(phone, 'M_PRIVATE');
    assert.equal(await phone.evaluate(() => {
      const rect = document.getElementById('archiveDialog').getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1
        && document.getElementById('archiveDialog').scrollWidth <= document.getElementById('archiveDialog').clientWidth + 1;
    }), true, 'long report titles do not push the dialog past the phone viewport');
    await phone.click('#btnCancelArchive');
    await openAction(phone, 'R1');
    assert.equal(await phone.$eval('#archiveDialog', (d) => d.scrollWidth <= d.clientWidth + 1), true, 'dependency names wrap inside the mobile dialog');
    assert.deepEqual(phoneErrors, []);
    await phoneContext.close();
    assert.deepEqual(errors, [], 'no console or uncaught page errors, including caught RPC failures');
    console.log('  PASS mobile layout and no page errors');
    console.log('\nPASS report-management browser regression suite');
  } finally { await suite.close(); }
})().catch((err) => { console.error(err); process.exit(1); });
