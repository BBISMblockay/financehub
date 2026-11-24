import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('login presents SILO rather than Baseballism-specific instructions', async () => {
  const html = await read('pages/login.html');
  assert.doesNotMatch(html, /Baseballism operations|you@baseballism\.com|© Baseballism/);
  assert.match(html, /Finish company setup/);
  assert.match(html, /Create your owner account/);
});

test('customer-facing settings do not link to implementation docs or expose secret names', async () => {
  const integrations = await read('v2/integrations.html');
  const notifications = await read('v2/settings-notifications.html');
  assert.doesNotMatch(integrations, /docs\/ops\/stripe\.md/);
  assert.doesNotMatch(notifications, /SILO_MAIL_FROM|edge-function secret|comp-request-notify|sample-notify/);
});

test('vendor suggestions ship as data, not as one company\'s names inside the page', async () => {
  const html = await read('v2/purchase_request.html');
  // The 195-name array that used to live here went into
  // payment_request_vendor_suggestions (20261113030000). The gate on it was
  // never a boundary: a static array reaches EVERY tenant's browser whatever
  // company they are in, and the repo is public, so those names were readable
  // in devtools and on GitHub. RLS on the table is the boundary now.
  assert.doesNotMatch(html, /BASEBALLISM_VENDORS/);
  assert.doesNotMatch(html, /entity_key === 'baseballism'/);
  // No vendor or ambassador names left in the page at all, under any name.
  assert.doesNotMatch(html, /Baseballism Ambassador/i);
  assert.match(html, /from\("payment_request_vendor_suggestions"\)/);
  // Scoped to the active company on the way out as well as by RLS.
  assert.match(html, /payment_request_vendor_suggestions[\s\S]{0,200}company_entity_id/);
  // And a missing table or a failed read must not stop someone filing a
  // request: both suggestion reads fall back to an empty list.
  assert.match(html, /fetchSuggestedVendors\(\)\.catch\(/);
  assert.match(html, /fetchPriorVendors\(\)\.catch\(/);
});

test('shared chrome displays friendly workspace roles without storage jargon', async () => {
  const source = await read('v2/silo-chrome.js');
  assert.match(source, /owner_admin: 'Owner'/);
  assert.match(source, /from\('entity_memberships'\)/);
  assert.doesNotMatch(source, /RLS ·|· RLS/);
});

test('standard home hides Baseballism team workflows and links Customers', async () => {
  const html = await read('v2/finance.html');
  assert.match(html, /href="\/v2\/customers\.html">Customers<\/a>/);
  assert.match(html, /data-nav-profile="grandfathered">\s*<div class="fin-card-head"><h2>Team<\/h2>/);
});

test('standard dashboard hub hides report authoring while keeping Ask SILO', async () => {
  const html = await read('v3/dashboards.html');
  assert.match(html, /navProfile === 'standard'/);
  // Authoring is the thing gated, not reading. The tabs are no longer hidden
  // one id at a time (that is what this check used to pin, and the page stopped
  // doing it): a standard workspace gets an allow-list and every tab outside it
  // is hidden by the loop below, so the allow-list is what has to be asserted.
  assert.match(html, /el\('btnNewReport'\)\.hidden = true/);
  // The one named door to SQL is hidden in a standard workspace too.
  assert.match(html, /el\('btnAdvanced'\)\.hidden = true/);
  // The allow-list moved out of the page into report-library.js, where the
  // schedules tab can be gated on the DATABASE's admin check rather than on
  // the nav profile. Assert it where it now lives: reading is allowed,
  // authoring is not.
  assert.match(html, /allowedTabs = L\.allowedTabsFor\(\{ navProfile, explicitManagement, isScheduleAdmin \}\)/);
  assert.match(html, /for \(const t of L\.TABS\) el\(`tab-\$\{t\.id\}`\)\.hidden = !allowedTabs\.includes\(t\.id\)/);
  const lib = await read('v3/js/report-library.js');
  assert.match(lib, /function allowedTabsFor/);
  assert.match(lib, /o\.navProfile === 'standard'/);
  // No deep link into the report builder from a standard workspace either.
  assert.match(lib, /if \(!r\.id \|\| r\.href \|\| navProfile !== 'grandfathered'\) return null;/);
  assert.match(html, /crumbs: navProfile === 'standard' \? \['Insights',/);
  assert.match(html, /href="\/v2\/silo-chat\.html">Ask SILO<\/a>/);
});
