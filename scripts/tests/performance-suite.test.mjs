// The Performance suite: the four places marketing results are read -- Overview,
// Explorer, Report, Attribution -- as ONE sidebar row with a tab strip.
//
// What is worth asserting here, and why:
//
//  1. The tabs are the EXISTING pages at their existing URLs, in order. A tab
//     pointed at a new route would break every bookmark and saved link.
//  2. The sidebar draws ONE row for the four pages, on both nav profiles, and
//     every one of the four pages highlights that row.
//  3. NO visibility boundary moved. Report and Attribution are still
//     Baseballism-only, Attribution still needs its pilot companyGate, and the
//     Marketing module switch still hides everything. The strip has no gate of
//     its own: it shows the tabs whose nav ROW is visible, so this is tested
//     against the rows, in both directions.
//  4. "Jump to" (the palette) still finds every page by name: the three tab
//     rows are hidden from the sidebar only, not from the nav.
//  5. The tab you are LOOKING AT is always in its own strip, and refresh()
//     redraws once the real company is known (a deep link has none cached).
//
// Run: node --test scripts/tests/performance-suite.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const navSource = await read('v2/nav-config.js');
const stripSource = await read('v2/performance-suite.js');
const chromeSource = await read('v2/silo-chrome.js');

const BASEBALLISM = { id: '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', entity_key: 'baseballism' };
const OTHER = { id: '11111111-1111-4111-8111-111111111111', entity_key: 'acme' };
// Grandfathered by meta but NOT the pilot company: gets Report, never Attribution.
const OTHER_GF = { id: '22222222-2222-4222-8222-222222222222', meta: { nav_profile: 'grandfathered' } };

const OVERVIEW = 'reports/marketing-overview';
const EXPLORER = 'reports/marketing-explorer';
const REPORT = 'reports/wow-report';
const ATTRIBUTION = 'reports/silo-attribution';
const PAGES = {
  [OVERVIEW]: 'marketing-overview.html',
  [EXPLORER]: 'marketing-explorer.html',
  [REPORT]: 'wow-report.html',
  [ATTRIBUTION]: 'silo-attribution.html',
};

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {};
    this.innerHTML = ''; this.textContent = ''; this.replacedWith = null;
  }
  append(...v) { this.children.push(...v); }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  replaceWith(n) { this.replacedWith = n; }
}

function harness(company) {
  const document = { createElement: (tag) => new Element(tag) };
  const state = { company };
  const window = { __SILO_CONFIG__: { getActiveCompany: () => state.company } };
  vm.runInNewContext(navSource, { window });
  vm.runInNewContext(stripSource, { window, document, URLSearchParams });
  let mounted;
  const main = {
    querySelector: () => mounted,
    firstElementChild: { after: (n) => { mounted = n; } },
  };
  return {
    window, main, state,
    get nav() { return mounted; },
    links: () => (mounted ? mounted.children[1].children : []),
    tabs: () => (mounted ? String(mounted.dataset.perfSuiteTabs || '').split(',').filter(Boolean) : []),
    mount: (active) => window.SiloPerformanceSuite.mount(main, active),
    refresh: (active) => window.SiloPerformanceSuite.refresh(main, active),
  };
}

const nav = (() => { const w = {}; new Function('window', navSource)(w); return w.SiloNav; })();
const idsOf = (sections) => sections.flatMap((s) => s.items.map((i) => i.id));
const sidebarIds = (company) => idsOf(nav.sidebarSections(nav.navSectionsForCompany(company)));
const marketingSidebar = (company) => nav.sidebarSections(nav.navSectionsForCompany(company))
  .find((s) => s.section === 'Marketing')?.items.map((i) => i.id) || [];

test('four tabs in order, each on its existing page at its existing URL', () => {
  assert.deepEqual(nav.PERFORMANCE_SUITE_PAGES.map(([id, , path]) => [id, path]), Object.entries(PAGES));
  const h = harness(BASEBALLISM);
  h.mount(OVERVIEW);
  assert.deepEqual(h.tabs(), Object.keys(PAGES));
  assert.deepEqual(h.links().map((a) => a.href), Object.values(PAGES).map((p) => '/v2/' + p));
  assert.deepEqual(h.links().map((a) => a.getAttribute('aria-current')), ['page', undefined, undefined, undefined]);
  // Each tab href is the href of its own nav row: one source for a page's URL.
  for (const [id, , path] of nav.PERFORMANCE_SUITE_PAGES) {
    assert.equal(nav.NAV_ITEMS.find((i) => i.id === id).href, '/v2/' + path);
  }
});

test('every tab names the revenue figure its page is built on', () => {
  const h = harness(BASEBALLISM);
  h.mount(EXPLORER);
  for (const a of h.links()) {
    const basis = a.children.find((c) => c.className === 'perf-suite-basis');
    assert.ok(basis && basis.textContent.trim(), 'a tab without a basis caption');
  }
  const explorer = h.links()[1].children.find((c) => c.className === 'perf-suite-basis');
  assert.match(explorer.textContent, /claimed/i);
});

test('the sidebar draws ONE row for the four pages, on both profiles', () => {
  // No role passed, so the exec-gated SEO row is not filtered out here.
  assert.deepEqual(marketingSidebar(BASEBALLISM), [OVERVIEW, 'reports/ad-studio', 'reports/seo']);
  assert.deepEqual(marketingSidebar(OTHER), [OVERVIEW, 'reports/ad-studio', 'reports/seo']);
  for (const co of [BASEBALLISM, OTHER, OTHER_GF, null]) {
    const ids = sidebarIds(co);
    for (const tab of [EXPLORER, REPORT, ATTRIBUTION]) assert.ok(!ids.includes(tab), `${tab} drawn as a sidebar row`);
  }
  // The Performance row has exactly these three tabs and no fourth. Scoped to
  // PERFORMANCE_ROW rather than to every `tabOf` item in the nav, because
  // `tabOf` is a shared mechanism: the Calendar row took it for Org calendar
  // (#1245), which made the old nav-wide form fail on main for a change that
  // was nothing to do with this suite. The guard that matters is unchanged --
  // a page cannot become a hidden tab of THIS row without being named here.
  assert.deepEqual(
    nav.NAV_ITEMS.filter((i) => i.tabOf === nav.PERFORMANCE_ROW).map((i) => i.id).sort(),
    [EXPLORER, REPORT, ATTRIBUTION].sort(),
  );
  assert.equal(nav.PERFORMANCE_ROW, OVERVIEW);
  // Whoever else uses `tabOf`, it must point at a row that really exists, or
  // the tab is hidden from the sidebar with nothing drawing it.
  const ids = new Set(nav.NAV_ITEMS.map((i) => i.id));
  for (const i of nav.NAV_ITEMS.filter((x) => x.tabOf)) {
    assert.ok(ids.has(i.tabOf), `${i.id} is a tab of ${i.tabOf}, which is not a nav row`);
  }
});

test('no row lost a gate: the tab rows keep their profiles and the pilot companyGate', () => {
  const row = (id) => nav.NAV_ITEMS.find((i) => i.id === id);
  assert.deepEqual([...row(REPORT).profiles], ['grandfathered']);
  assert.deepEqual([...row(ATTRIBUTION).profiles], ['grandfathered']);
  assert.equal(row(ATTRIBUTION).companyGate, nav.isSiloAttributionEnabled);
  assert.deepEqual([...row(EXPLORER).profiles], ['grandfathered', 'standard']);
  assert.deepEqual([...row(OVERVIEW).profiles], ['grandfathered', 'standard']);
});

test('"Jump to" still finds every page: the tab rows remain in the nav', () => {
  const bb = idsOf(nav.navSectionsForCompany(BASEBALLISM));
  for (const id of Object.keys(PAGES)) assert.ok(bb.includes(id), `${id} gone from Baseballism's nav`);
  const std = idsOf(nav.navSectionsForCompany(OTHER));
  assert.ok(std.includes(EXPLORER));
  assert.ok(!std.includes(REPORT) && !std.includes(ATTRIBUTION));
});

test('a standard company gets Overview and Explorer only', () => {
  const h = harness(OTHER);
  h.mount(OVERVIEW);
  assert.deepEqual(h.tabs(), [OVERVIEW, EXPLORER]);
});

test('Attribution is offered to the pilot company only, never by profile alone', () => {
  const gf = harness(OTHER_GF);
  gf.mount(OVERVIEW);
  assert.deepEqual(gf.tabs(), [OVERVIEW, EXPLORER, REPORT]);
  for (const co of [{ ...BASEBALLISM, _staleReconcile: true }, { ...BASEBALLISM, meta: { nav_profile: 'standard' } }]) {
    const h = harness(co);
    h.mount(OVERVIEW);
    assert.ok(!h.tabs().includes(ATTRIBUTION), 'Attribution offered past its companyGate');
  }
});

test('the Marketing module switch still hides the suite tabs', async () => {
  const h = harness(OTHER);
  const db = { from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [{ company_entity_id: OTHER.id, module_id: 'marketing', visible: false }], error: null }) }) }) };
  await h.window.SiloNav.loadModuleVisibility(db, OTHER);
  const off = idsOf(h.window.SiloNav.navSectionsForCompany(OTHER));
  // Only meaningful if the stub really switched the module off.
  assert.ok(!off.includes(OVERVIEW), 'module stub did not switch Marketing off');
  h.mount(EXPLORER);
  assert.deepEqual(h.tabs(), [EXPLORER], 'only the open page stays, as its own way back');
});

test('the open page is always in its own strip, and refresh() restores narrowed tabs', () => {
  // A deep link: nothing cached, so the profile reads as standard for one paint.
  const h = harness(null);
  h.mount(ATTRIBUTION);
  assert.deepEqual(h.tabs(), [OVERVIEW, EXPLORER, ATTRIBUTION]);
  const first = h.nav;
  h.refresh(ATTRIBUTION);
  assert.equal(first.replacedWith, null, 'unchanged tab set must not redraw');
  h.state.company = BASEBALLISM;
  h.refresh(ATTRIBUTION);
  assert.ok(first.replacedWith, 'strip not redrawn once the company resolved');
  assert.deepEqual(String(first.replacedWith.dataset.perfSuiteTabs).split(','), Object.keys(PAGES));
});

test('the selection is carried between Overview and Explorer only', () => {
  const h = harness(BASEBALLISM);
  const carry = h.window.SiloPerformanceSuite.hrefWithContext;
  const search = '?days=14&platform=meta_ads&campaign=c1&adset=s1&ad=a1&tab=campaigns&utm=x';
  // Shared keys go across; a page's own keys (Overview's tab) and anything unknown do not.
  assert.equal(carry(EXPLORER, OVERVIEW, 'marketing-overview.html', search),
    '/v2/marketing-overview.html?days=14&platform=meta_ads&campaign=c1&adset=s1&ad=a1');
  assert.equal(carry(OVERVIEW, EXPLORER, 'marketing-explorer.html', '?start=2026-10-01&end=2026-10-09&tab=funnel'),
    '/v2/marketing-explorer.html?start=2026-10-01&end=2026-10-09');
  assert.equal(carry(OVERVIEW, EXPLORER, 'marketing-explorer.html', ''), '/v2/marketing-explorer.html');
  // Report and Attribution have their own period models: nothing is handed to or taken from them.
  assert.equal(carry(EXPLORER, REPORT, 'wow-report.html', search), '/v2/wow-report.html');
  assert.equal(carry(EXPLORER, ATTRIBUTION, 'silo-attribution.html', search), '/v2/silo-attribution.html');
  assert.equal(carry(ATTRIBUTION, EXPLORER, 'marketing-explorer.html', '?store=fod&start=2026-09-01&end=2026-09-30'), '/v2/marketing-explorer.html');
  assert.equal(carry(REPORT, OVERVIEW, 'marketing-overview.html', '?days=7'), '/v2/marketing-overview.html');
});

test('pages outside the suite get no strip', () => {
  const h = harness(BASEBALLISM);
  h.mount('ads/studio');
  assert.equal(h.nav, undefined);
  assert.doesNotThrow(() => h.refresh('reports/seo'));
  assert.equal(h.nav, undefined);
});

test('the chrome maps every suite page onto the one row, mounts and refreshes the strip, and skips tab rows', () => {
  assert.match(chromeSource, /SiloPerformanceSuite\?\.contains\(navActive\)\) navActive = Nav\.PERFORMANCE_ROW/);
  assert.match(chromeSource, /SiloPerformanceSuite\?\.mount\(mainEl, opts\.active\)/);
  assert.match(chromeSource, /SiloPerformanceSuite\?\.refresh\(mainEl, opts\.active\)/);
  assert.match(chromeSource, /Nav\.sidebarSections/);
});

test('each of the four pages loads the strip before the chrome and keeps its nav id', async () => {
  const sources = {
    [OVERVIEW]: await read('v2/marketing-overview.html'),
    [EXPLORER]: await read('v2/marketing-explorer.html'),
    [REPORT]: await read('v2/wow-report.html'),
    [ATTRIBUTION]: (await read('v2/silo-attribution.html')) + (await read('v2/silo-attribution-page.js')),
  };
  for (const [id, src] of Object.entries(sources)) {
    const navAt = src.indexOf('src="nav-config.js"');
    const stripAt = src.indexOf('src="performance-suite.js"');
    const chromeAt = src.indexOf('src="silo-chrome.js"');
    assert.ok(navAt > -1 && navAt < stripAt && stripAt < chromeAt, `${id}: nav-config, performance-suite, silo-chrome in that order`);
    assert.ok(src.includes('href="performance-suite.css"'), `${id}: strip stylesheet missing`);
    assert.ok(src.replace(/\s/g, '').includes(`active:'${id}'`), `${id}: page no longer mounts with its own id`);
  }
});
