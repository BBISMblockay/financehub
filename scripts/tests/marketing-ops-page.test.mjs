// /v2/marketing-ops.html — the schedule, against the page conventions and the
// one table it writes.
//
// The page used to carry the separate test record as well (Tests and Learnings
// tabs over `marketing_tests`, whose four vocabularies were asserted here
// against that migration's CHECKs). Those tabs were removed on 2026-10-29: a
// test is a stage of an idea in the Ad Studio idea bank
// (`ad_ideas.status = 'testing'` with `testing_element`), and its result is
// read off the ads the idea is linked to. So what is asserted now is:
//
//  1. The page writes `launch_channel_items` — the Launch calendar's own
//     table — and reads nothing it does not need. In particular it must not
//     write `marketing_test_id`: no row uses that column, it was NOT dropped,
//     and sending it on every edit is how a surviving link would get nulled.
//  2. The retired surfaces are gone, all of them: a leftover `marketing_tests`
//     read or a pane whose markup went but whose render function stayed is
//     half a removal, and the half that stays is what throws at boot.
//  3. An old link into the test record (`?test=`, `?tab=tests|learnings`) is
//     answered rather than silently showing the schedule as if nothing moved.
//  4. The Pattern 1 shell the sidebar needs, and the Ad Studio tab wiring.
//
// Run:  node scripts/tests/marketing-ops-page.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const page = read('v2/marketing-ops.html');
const nav = read('v2/nav-config.js');

// A `const NAME = [['value', 'Label'], ...]` block in the page.
function pageValues(name) {
  const m = page.match(new RegExp(`const ${name} = \\[(.*?)\\];`, 's'));
  assert.ok(m, `no ${name} list found in the page`);
  return [...m[1].matchAll(/\['([a-z_]+)',/g)].map((x) => x[1]).sort();
}

test('it writes the schedule SILO already has, and no table of its own', () => {
  assert.match(page, /from\('launch_channel_items'\)/);
  const tables = [...page.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)].sort(),
    ['launch_calendar', 'launch_channel_items', 'profiles']);
});

// The column survives on the table (nothing was dropped) and no row uses it.
// A page that sent `marketing_test_id: null` in its payload would unlink a row
// that did have one the next time anybody edited it, which is a silent data
// loss on a surface that no longer shows the link at all.
test('marketing_test_id is neither read nor written, so an edit cannot null it', () => {
  // Comment lines are stripped first: the page explains in a comment WHY the
  // column is left alone, and that sentence is the opposite of a regression.
  const code = page.split('\n').filter((l) => !/^\s*(\/\/|--|\*)/.test(l)).join('\n');
  assert.ok(!/marketing_test_id/.test(code),
    'the page still reads or writes marketing_test_id; an edit would overwrite a link it does not show');
});

test('the retired test surfaces are gone whole, markup and render path together', () => {
  for (const gone of [
    'marketing_tests',      // the table
    'paneTests', 'paneLearn', 'testDrawer',   // the panes and the drawer
    'renderTests', 'renderLearn', 'visibleLearnings', 'openTest', 'saveTest', 'deleteTest',
    'tabTests', 'tabLearn', 'btnNewTest',
    'fTestSearch', 'fLearnSearch', 'fItemTest', 'iTestSel',
    'TEST_STATUS', 'OUTCOME_TONE', 'mo-learn',
  ]) {
    assert.ok(!page.includes(gone), `${gone} is still in the page`);
  }
  // Nothing is left behind that the removed vocabularies fed, either.
  assert.ok(!/const (ELEMENTS|METRICS) = /.test(page),
    'a vocabulary of the removed test record is still declared');
});

// The schedule's own vocabularies. launch_channel_items has NO check
// constraint (it has other writers), so these are suggestions rather than a
// contract -- what matters is that the drawer and the filter offer the same
// list, or an item can be given a status the filter can never match.
test('the status filter offers exactly the statuses the drawer can save', () => {
  const statuses = page.match(/const ITEM_STATUS\s+= \[(.*?)\];/s);
  assert.ok(statuses, 'ITEM_STATUS is declared');
  const list = [...statuses[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(list, ['planned', 'scheduled', 'live', 'done', 'cancelled']);
  assert.match(page, /fillSelect\(\$\('iStatus'\), ITEM_STATUS/);
  assert.match(page, /fillSelect\(\$\('fItemStatus'\), ITEM_STATUS/);
  // The "still open" KPIs must be a subset of them, or a count is of nothing.
  const open = page.match(/const OPEN_STATUS = new Set\(\[(.*?)\]\)/s);
  assert.ok(open, 'OPEN_STATUS is declared');
  for (const s of [...open[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])) {
    assert.ok(list.includes(s), `OPEN_STATUS names ${s}, which no item can have`);
  }
});

test('every channel the drawer offers is one the filter offers back', () => {
  assert.deepEqual(pageValues('CHANNELS'),
    ['email', 'google', 'meta', 'organic', 'other', 'sms', 'tiktok', 'website']);
  assert.match(page, /fillSelect\(\$\('iChannel'\), CHANNELS\)/);
  assert.match(page, /fillSelect\(\$\('fItemChannel'\), CHANNELS/);
});

// Links to the test record exist in Slack and in people's tabs. They land
// here, so the page says where that record went rather than showing the
// schedule as though nothing had changed.
test('an old link into the test record is answered, not ignored', () => {
  assert.match(page, /qp\.get\('test'\)/);
  assert.match(page, /\['tests', 'learnings'\]\.includes\(qp\.get\('tab'\)\)/);
  assert.match(page, /idea bank/i);
});

// Pattern 1 (root CLAUDE.md): the asset order is not cosmetic. nav-config.js
// must load BEFORE silo-chrome.js or no sidebar renders at all, and the two
// stylesheets that follow the page's own <style> are what keep Beacon's
// mirrors and the mobile rules on top of it.
test('the page follows the Pattern 1 asset order', () => {
  const at = (needle) => {
    const i = page.indexOf(needle);
    assert.ok(i !== -1, `missing from the page: ${needle}`);
    return i;
  };
  const order = [
    'href="beacon.css"',
    'href="silo-brand.css"',
    'href="beacon-mirrors-unified.css"',
    'href="v2-mobile.css"',
    'src="v2-shell.js"',
    'src="nav-config.js"',
    'src="silo-chrome.js"',
  ].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'assets are out of Pattern 1 order');
});

// The page is a TAB of the Ad Studio destination (2026-10-13), not a sidebar
// row of its own: it announces the suite id the strip looks for, the strip
// lists it at its own URL, and silo-chrome.js maps that id onto the Ad Studio
// row. A page that forgets any one of those renders with no way across. The
// id stays 'ads/testing' although the tab is now the Schedule: it is the key
// the strip and the chrome agree on, and the URL never moved.
test('the page mounts as the Ad Studio suite tab the strip and chrome expect', () => {
  const chrome = read('v2/silo-chrome.js');
  const strip = read('v2/marketing-suite.js');
  assert.match(page, /active: 'ads\/testing'/);
  assert.match(page, /src="marketing-suite\.js"/);
  assert.match(page, /href="marketing-suite\.css"/);
  assert.match(nav, /\['ads\/testing','Schedule','marketing-ops\.html'/);
  assert.ok(!/id: 'reports\/marketing-ops'/.test(nav),
    'a tab of Ad Studio plus a sidebar row of its own would be two navigations for one page');
  assert.match(strip, /AD_STUDIO_SUITE_PAGES/);
  assert.match(chrome, /SiloAdStudioSuite\?\.contains\(navActive\)\) navActive = 'reports\/ad-studio'/);
  assert.match(chrome, /SiloAdStudioSuite\?\.mount\(mainEl, opts\.active\)/);
});

test('the page resolves the company with ensureActiveCompany, not getActiveCompany', () => {
  assert.match(page, /ensureActiveCompany\?\.\(db\)/);
  assert.ok(!/getActiveCompany\(/.test(page),
    'getActiveCompany() is null in a bookmarked tab, which would make every write company-less');
});

test('there is no alert() and no new CSS variable', () => {
  assert.ok(!/\balert\(/.test(page), 'alert() is banned; the page has a bcn-status line');
  const declared = [...page.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]);
  assert.deepEqual(declared, [], `the page declares CSS variables: ${declared.join(', ')}`);
});
