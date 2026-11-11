'use strict';
// Keep retirement scoped to the approved entry points. Modern equivalents and
// unrelated iframe targets must remain, and no surviving runtime URL may point
// at a removed entry point. Historical prose and migrations are not runtime links.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const retired = [
  'employeehub.html', 'v2/buyer.html', 'executive.html', 'inventory.html',
  'mailroom.html', 'legacy/ops.html', 'projections.html', 'silo-pitch.html',
  'v2/testmock.html', 'legacy/pages/purchase-request.html',
  'legacy/pages/planning-scenarios.html', 'legacy/pages/launch-calendar.html',
  'legacy/pages/request-manager.html', 'legacy/pages/reallycoolbars.html',
  'pages/product-manager.html', 'legacy/pages/intern.html',
  'legacy/pages/po-report.html', 'legacy/pages/sales-reports.html',
  'legacy/pages/backend.html', 'legacy/executive.html', 'legacy/pages/sales-db.html',
  'legacy/marketing.html', 'v2/licensing/index.html', 'v2/wholesale.html',
  'legacy/pages/po-builder.html', 'legacy/pages/testing.html', 'legacy/app-status.html',
  // 2026-10-06: the two unauthenticated root iframe targets and checkwriter's wrapper.
  'buyer.html', 'checkwriter.html', 'v2/checkwriter.html',
  // 2026-10-14: three unlinked, unauthenticated pages whose only data source was
  // a Google Sheet published to the web. Nothing linked them -- they were
  // reachable only by typing the URL -- and the published links they carried are
  // credentials, so the pages go rather than the links alone.
  'pages/wholesale.html', 'legacy/pages/mise.html', 'legacy/pages/product-tags.html',
  // 2026-11-11: the wholesale book itself, and with it the last Pattern 2 iframe
  // target. Its ar_* tables froze on 2026-10-12 and open balances have come from
  // the Shopify sync since 2026-10-20, so the page could only show a book that
  // cannot move. The TABLES stay -- this retires a screen, not a dataset.
  'pages/baseballismwholesale.html',
];
const protectedPages = [
  'v2/inventory.html', 'v2/mailroom.html', 'v2/projections.html', 'v2/finance.html',
  'v2/po-builder.html', 'v2/po-report.html', 'v2/po-costing.html',
  'v2/purchase_request.html', 'v2/request_manager.html', 'v2/purchase_request2.html',
  'v2/planning-scenarios.html', 'v2/launch-calendar.html', 'v2/products.html',
  'v2/backend.html', 'v2/employeehub.html', 'v2/product-manager.html',
  'v2/baseballismwholesale.html',
  'index.html', 'pages/login.html',
];
for (const file of retired) assert.equal(fs.existsSync(path.join(root, file)), false, `retired page returned: ${file}`);
for (const file of protectedPages) assert.ok(fs.existsSync(path.join(root, file)), `protected page missing: ${file}`);
const retiredSet = new Set(retired);
const skip = new Set(['.git', '.claude', 'node_modules', 'tests', 'docs', 'data']);
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!skip.has(entry.name)) walk(path.join(dir, entry.name)); }
    else if (/\.(html|js|mjs|ts)$/.test(entry.name) && !/\.min\.js$/.test(entry.name)) files.push(path.join(dir, entry.name));
  }
}
walk(root);
const dead = [];
for (const file of files) {
  const rel = path.relative(root, file).replaceAll(path.sep, '/');
  const source = fs.readFileSync(file, 'utf8');
  // A URL token must be delimited, so /v2/inventory.html never matches the
  // retired root inventory.html. Handle absolute site URLs and query/hash too.
  for (const match of source.matchAll(/["'`]([^"'`\s<>]*\.html(?:[?#][^"'`\s<>]*)?)["'`]/g)) {
    const value = match[1];
    if (/^https?:/i.test(value) && !/^https?:\/\/(?:silo-baseballism\.com|get-silo\.com)(?:\/|$)/i.test(value)) continue;
    if (value.includes('${') || value.startsWith('//')) continue;
    const url = new URL(value, `https://silo-baseballism.com/${rel}`);
    const target = decodeURIComponent(url.pathname).replace(/^\//, '');
    if (retiredSet.has(target)) dead.push(`${rel}: ${value}`);
  }
}
assert.deepEqual(dead, [], 'surviving runtime source still names a retired URL');
console.log(`legacy retirement: ${retired.length} removed, ${protectedPages.length} protected pages present, ${files.length} runtime sources scanned`);

// Exercise the actual route definitions, not a second hand-copied list.
const vm = require('node:vm');
for (const file of ['legacy/finance.html', 'legacy/retail.html']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const routeBlock = source.match(/const ROUTES = (\[[\s\S]*?\n    \]);/);
  assert.ok(routeBlock, `route definition missing: ${file}`);
  const routes = vm.runInNewContext(`(${routeBlock[1]})`, Object.create(null));
  const entries = routes.flatMap((r) => r.items || [r]);
  const expected = file === 'legacy/finance.html'
    ? { baseballism: '/v2/finance.html', mailroom: '/v2/mailroom.html', projections: '/v2/projections.html', inventory: '/v2/inventory.html', 'product-tags': '/v2/products.html?tab=catalog' }
    : { baseballism: '/v2/finance.html' };
  for (const [id, url] of Object.entries(expected)) {
    assert.equal(entries.find((r) => r.id === id)?.src, url, `${file}: ${id}`);
    assert.ok(fs.existsSync(path.join(root, new URL(url, 'https://silo.test').pathname)), `${file}: replacement must exist`);
  }
  assert.equal(entries.some((r) => r.id === 'executive'), false, 'no invented Executive successor');
}
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'v2/nav-config.js'), 'utf8'), context);
for (const profile of ['standard', 'grandfathered']) {
  const sections = context.window.SiloNav.navSectionsForProfile(profile, 'exec', 'owner', []);
  assert.ok(sections.length > 0, `${profile} nav still builds`);
  for (const item of sections.flatMap((s) => s.items)) {
    if (!item.href || !item.href.startsWith('/')) continue;
    const target = new URL(item.href, 'https://silo.test').pathname.slice(1);
    assert.ok(!retiredSet.has(target), `${profile} nav exposes retired ${target}`);
    assert.ok(fs.existsSync(path.join(root, target)), `${profile} nav has no file: ${target}`);
  }
}
// BBISM Receivables left the nav 2026-10-20 and the page was retired 2026-11-11.
// The WRAPPER URL survives as a stub (it is in protectedPages above) because the
// nav row was live for years and bookmarks outlive it; the wholesale book it
// framed is in `retired` above. Assert the stub actually forwards rather than
// trusting that a 26-line file still redirects, and that it carries no auth,
// chrome or Supabase client of its own -- a stub with logic is the thing the
// Pattern 3 rule exists to prevent.
const WHOLESALE_PAGE = '/v2/baseballismwholesale.html';
for (const profile of ['standard', 'grandfathered']) {
  const sections = context.window.SiloNav.navSectionsForProfile(profile, 'exec', 'owner', []);
  const hrefs = sections.flatMap((s) => s.items).map((i) => i.href);
  assert.equal(hrefs.includes(WHOLESALE_PAGE), false,
    `${profile} nav still offers the retired receivables book`);
}
const wholesaleStub = fs.readFileSync(path.join(root, 'v2/baseballismwholesale.html'), 'utf8');
assert.match(wholesaleStub, /location\.replace\('\/v3\/dashboards\.html'\)/,
  'retired receivables URL must forward to the reports library');
for (const forbidden of ['tool-shell', 'silo-chrome', 'supabase-js', 'dept-guard']) {
  assert.ok(!wholesaleStub.includes(forbidden),
    `receivables stub must stay a bare redirect, found: ${forbidden}`);
}
// Retiring the screen must not have retired the book. These tables hold the only
// copy of the pre-2026-05 wholesale history, the collections queue and the
// contact log; they are read through Reports / Ask SILO / MCP now. The
// dispatch-only sheet sync is the only writer and stays wired to them.
const arSync = fs.readFileSync(path.join(root, 'server/ar-sync.mjs'), 'utf8');
for (const table of ['ar_customers', 'ar_invoices']) {
  assert.ok(arSync.includes(table), `ar-sync must still address ${table}`);
}
console.log('legacy retirement: receivables URL is a bare stub to the reports library, ar_* tables untouched');

const guide = fs.readFileSync(path.join(root, 'v2/launch-calendar-guide.html'), 'utf8');
assert.ok(guide.includes('href="https://github.com/BBISMblockay/financehub/blob/main/CLAUDE.md"'), 'architecture link names authoritative guide');
console.log('legacy retirement: archived route definitions and both current nav profiles verified');
