// /v2/marketing-ops.html against its own migration and the page conventions.
//
// A select on the page offering a value the CHECK constraint rejects is a save
// that fails at the database with a constraint name in the message -- the kind
// of break that only shows up when somebody tries to file a real test. These
// assertions compare the page's four vocabularies with the constraints in
// 20261013120000_marketing_tests.sql, and check the Pattern 1 shell the page
// needs in order to render a sidebar at all.
//
// Run:  node scripts/tests/marketing-ops-page.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const page = read('v2/marketing-ops.html');
const migration = read('supabase/migrations/20261013120000_marketing_tests.sql');
const nav = read('v2/nav-config.js');

// The values inside `check (col in ('a', 'b', ...))`. The clause is written
// across line breaks for the longer lists, so the opening paren is found after
// the `in`, not assumed to follow it, and the list ends at the first `)`
// because no value contains one.
function checkValues(column) {
  const at = migration.indexOf(`check (${column} in`);
  assert.ok(at !== -1, `no CHECK list found for ${column}`);
  const open = migration.indexOf('(', at + `check (${column} in`.length);
  const close = migration.indexOf(')', open);
  assert.ok(open !== -1 && close > open, `unterminated CHECK list for ${column}`);
  const values = [...migration.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.ok(values.length, `the CHECK list for ${column} parsed as empty`);
  return values;
}

// A `const NAME = [['value', 'Label'], ...]` block in the page.
function pageValues(name) {
  const m = page.match(new RegExp(`const ${name} = \\[(.*?)\\];`, 's'));
  assert.ok(m, `no ${name} list found in the page`);
  return [...m[1].matchAll(/\['([a-z_]+)',/g)].map((x) => x[1]).sort();
}

test('every channel the page offers is one the database accepts', () => {
  assert.deepEqual(pageValues('CHANNELS'), checkValues('channel'));
});

test('every element the page offers is one the database accepts', () => {
  assert.deepEqual(pageValues('ELEMENTS'), checkValues('element'));
});

test('every metric the page offers is one the database accepts', () => {
  assert.deepEqual(pageValues('METRICS'), checkValues('metric'));
});

test('every status the page offers is one the database accepts', () => {
  assert.deepEqual(pageValues('TEST_STATUS'), checkValues('status'));
});

test('the outcome options match the outcome CHECK, plus the empty choice', () => {
  const inPage = [...page.matchAll(/<option value="(win|loss|inconclusive)">/g)].map((m) => m[1]).sort();
  assert.deepEqual(inPage, checkValues('outcome'));
  assert.ok(/id="tOutcome"[\s\S]{0,200}<option value="">/.test(page),
    'the outcome select keeps an empty choice, so a test can be un-concluded');
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

test('the page mounts the chrome under its own nav id, and the nav row exists', () => {
  assert.match(page, /active: 'reports\/marketing-ops'/);
  assert.match(nav, /id: 'reports\/marketing-ops'[^}]*href: '\/v2\/marketing-ops\.html'/);
});

test('the page resolves the company with ensureActiveCompany, not getActiveCompany', () => {
  assert.match(page, /ensureActiveCompany\?\.\(db\)/);
  assert.ok(!/getActiveCompany\(/.test(page),
    'getActiveCompany() is null in a bookmarked tab, which would make every write company-less');
});

test('it writes the schedule SILO already has, and no table of its own', () => {
  assert.match(page, /from\('launch_channel_items'\)/);
  const tables = [...page.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)].sort(),
    ['ad_ideas', 'launch_calendar', 'launch_channel_items', 'marketing_tests', 'profiles']);
});

test('there is no alert() and no new CSS variable', () => {
  assert.ok(!/\balert\(/.test(page), 'alert() is banned; the page has a bcn-status line');
  const declared = [...page.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]);
  assert.deepEqual(declared, [], `the page declares CSS variables: ${declared.join(', ')}`);
});
