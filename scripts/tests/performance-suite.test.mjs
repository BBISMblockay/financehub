// The Performance suite: the four places marketing results are read -- Overview,
// Explorer, Report, Attribution -- as ONE sidebar row with a tab strip.
//
// What is worth asserting here, and why:
//
//  1. The tabs are the EXISTING pages at their existing URLs, in order. A tab
//     pointed at a new route would break every bookmark and saved link.
//  2. The sidebar draws ONE row for the four pages, on both nav profiles, and
//     every one of the four pages highlights that row.
//  3. Each tab's visibility is still its nav ROW's own. Report stays
//     grandfathered-only; Attribution is open to every workspace since
//     2026-11-13 (it was a pilot gated on one company's entity id -- see
//     nav-config.js) and so has no gate beyond its profiles; the Marketing
//     module switch still hides everything. The strip has no gate of its own:
//     it shows the tabs whose nav ROW is visible, so this is tested against
//     the rows, in both directions.
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

// The profile comes from the company's OWN DATA (entities.meta.nav_profile,
// 20261113040000), never from entity_key -- so the grandfathered fixture says
// so explicitly, and a company without the flag is standard.
const BASEBALLISM = { id: '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', entity_key: 'baseballism', meta: { nav_profile: 'grandfathered' } };
const OTHER = { id: '11111111-1111-4111-8111-111111111111', entity_key: 'acme' };
// A second grandfathered workspace, which the entity_key gate made impossible.
const OTHER_GF = { id: '22222222-2222-4222-8222-222222222222', meta: { nav_profile: 'grandfathered' } };

const OVERVIEW = 'reports/marketing-overview';
const EXPLORER = 'reports/marketing-explorer';
const REPORT = 'reports/wow-report';
const ATTRIBUTION = 'reports/silo-attribution';
// Ad Studio and SEO joined the strip 2026-11-13 (Blake: "marketing sub
// performance, all tabbed"), so Marketing draws ONE sidebar row. Each is
// itself a small suite of pages, and those inner pages resolve to the tab
// they belong to -- asserted below with the inner strips stubbed in.
const AD_STUDIO = 'reports/ad-studio';
const SEO = 'reports/seo';
const PAGES = {
  [OVERVIEW]: 'marketing-overview.html',
  [EXPLORER]: 'marketing-explorer.html',
  [REPORT]: 'wow-report.html',
  [ATTRIBUTION]: 'silo-attribution.html',
  [AD_STUDIO]: 'ad-studio.html',
  [SEO]: 'seo-studio.html',
};
// Every tab except the open one; the strip marks exactly one current.
const notCurrent = (n) => Array(n).fill(undefined);

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

test('six tabs in order, each on its existing page at its existing URL', () => {
  assert.deepEqual(nav.PERFORMANCE_SUITE_PAGES.map(([id, , path]) => [id, path]), Object.entries(PAGES));
  const h = harness(BASEBALLISM);
  h.mount(OVERVIEW);
  assert.deepEqual(h.tabs(), Object.keys(PAGES));
  assert.deepEqual(h.links().map((a) => a.href), Object.values(PAGES).map((p) => '/v2/' + p));
  assert.deepEqual(h.links().map((a) => a.getAttribute('aria-current')), ['page', ...notCurrent(Object.keys(PAGES).length - 1)]);
  // Each tab href is the href of its own nav row: one source for a page's URL.
  for (const [id, , path] of nav.PERFORMANCE_SUITE_PAGES) {
    assert.equal(nav.NAV_ITEMS.find((i) => i.id === id).href, '/v2/' + path);
  }
});

// The basis is the link's TOOLTIP, not a printed caption. It was a grey
// caption beside every tab until 2026-11-13 (Blake: the strip was "wierd
// with the extra light grey notes next to suite tabs ... or remove the
// extra notes, simplify"), so four tabs read as four footnotes. The fact
// each tab still names its basis is what this pins; where it is drawn is
// the second assertion, so removing the caption cannot come back by
// accident and neither can losing the basis itself.
test('every tab names the revenue figure its page is built on', () => {
  const h = harness(BASEBALLISM);
  h.mount(EXPLORER);
  for (const [i, a] of h.links().entries()) {
    const [, label, , basis] = nav.PERFORMANCE_SUITE_PAGES[i];
    assert.ok(basis, 'a tab without a basis');
    assert.equal(a.title, `${label}: ${basis}`, 'a tab whose tooltip does not name its basis');
    assert.ok(!a.children.some((c) => c.className === 'perf-suite-basis'), 'the basis is printed again as a caption');
  }
  assert.match(h.links()[1].title, /claimed/i);
});

test('the sidebar draws ONE Marketing row for all six pages, on both profiles', () => {
  // No role passed, so the exec-gated SEO row is not filtered out here.
  assert.deepEqual(marketingSidebar(BASEBALLISM), [OVERVIEW]);
  assert.deepEqual(marketingSidebar(OTHER), [OVERVIEW]);
  for (const co of [BASEBALLISM, OTHER, OTHER_GF, null]) {
    const ids = sidebarIds(co);
    for (const tab of [EXPLORER, REPORT, ATTRIBUTION, AD_STUDIO, SEO]) assert.ok(!ids.includes(tab), `${tab} drawn as a sidebar row`);
  }
  // Exactly these five rows are tabs OF PERFORMANCE_ROW; nothing else is.
  // (Other suites use the same `tabOf` mechanism -- the Calendar row's Org
  // calendar tab, 2026-11-11 -- so this is scoped to this row's tabs rather
  // than to every hidden row in the nav.)
  const tabsOfPerformance = nav.NAV_ITEMS.filter((i) => i.tabOf === nav.PERFORMANCE_ROW).map((i) => i.id);
  assert.deepEqual(tabsOfPerformance.sort(), [EXPLORER, REPORT, ATTRIBUTION, AD_STUDIO, SEO].sort());
  // Whoever the parent is, it has to be a real row: a typo'd `tabOf` would
  // hide a page from the sidebar with no strip anywhere that draws it back.
  for (const tab of nav.NAV_ITEMS.filter((i) => i.tabOf)) {
    assert.ok(nav.NAV_ITEMS.some((i) => i.id === tab.tabOf), `${tab.id}: tabOf names no row`);
  }
  assert.equal(nav.PERFORMANCE_ROW, OVERVIEW);
});

test('each tab row carries its own profiles, and Attribution carries no company gate', () => {
  const row = (id) => nav.NAV_ITEMS.find((i) => i.id === id);
  assert.deepEqual([...row(REPORT).profiles], ['grandfathered']);
  assert.deepEqual([...row(ATTRIBUTION).profiles], ['grandfathered', 'standard']);
  // The pilot gate is gone, not merely widened: a companyGate naming one
  // company is the shape this PR removed, so assert there is none at all.
  assert.equal(row(ATTRIBUTION).companyGate, undefined);
  assert.equal(nav.isSiloAttributionEnabled, undefined);
  assert.deepEqual([...row(EXPLORER).profiles], ['grandfathered', 'standard']);
  assert.deepEqual([...row(OVERVIEW).profiles], ['grandfathered', 'standard']);
  // No row anywhere in the nav may gate on a company identity again.
  for (const item of nav.NAV_ITEMS) {
    assert.equal(typeof item.companyGate, 'undefined', `${item.id} reintroduced a companyGate`);
  }
});

test('no company identity decides anything in the nav', () => {
  // Comments stripped: the history of WHY the entity_key branch and the pilot
  // gate were removed names the company, and that record is worth keeping.
  // What must not survive is a company name or id the code BRANCHES on.
  const code = navSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /baseballism/i);
  assert.doesNotMatch(code, /3bd934c9/);
  // And a company with no flag is standard, whatever its entity_key says.
  assert.equal(nav.resolveNavProfile({ id: BASEBALLISM.id, entity_key: 'baseballism' }), 'standard');
  assert.equal(nav.resolveNavProfile(BASEBALLISM), 'grandfathered');
  assert.equal(nav.resolveNavProfile(OTHER_GF), 'grandfathered');
  assert.equal(nav.resolveNavProfile(null), 'standard');
});

test('"Jump to" still finds every page: the tab rows remain in the nav', () => {
  const bb = idsOf(nav.navSectionsForCompany(BASEBALLISM));
  for (const id of Object.keys(PAGES)) assert.ok(bb.includes(id), `${id} gone from Baseballism's nav`);
  const std = idsOf(nav.navSectionsForCompany(OTHER));
  assert.ok(std.includes(EXPLORER));
  assert.ok(std.includes(ATTRIBUTION), 'Attribution is open to every workspace');
  assert.ok(!std.includes(REPORT));
});

test('a standard company gets every tab but Report', () => {
  const h = harness(OTHER);
  h.mount(OVERVIEW);
  assert.deepEqual(h.tabs(), [OVERVIEW, EXPLORER, ATTRIBUTION, AD_STUDIO, SEO]);
});

test('Attribution is offered on both profiles, and Report on neither standard one', () => {
  // A second grandfathered workspace gets all four; the entity-id pilot gate
  // used to withhold Attribution from it no matter what its profile said.
  const gf = harness(OTHER_GF);
  gf.mount(OVERVIEW);
  assert.deepEqual(gf.tabs(), Object.keys(PAGES));
  // Flipping the grandfathered company to standard drops Report and KEEPS
  // Attribution -- the one asymmetry this change introduces.
  const asStandard = harness({ ...BASEBALLISM, meta: { nav_profile: 'standard' } });
  asStandard.mount(OVERVIEW);
  assert.deepEqual(asStandard.tabs(), [OVERVIEW, EXPLORER, ATTRIBUTION, AD_STUDIO, SEO]);
  // An unresolved company is NOT handled here, and deliberately so: the nav is
  // discovery, and Attribution is now the same kind of row as the other three,
  // none of which inspect _staleReconcile. The refusal lives on the page --
  // silo-attribution-page.js assertCompany, covered by
  // scripts/tests/silo-attribution-access.test.mjs -- which is where a read
  // actually happens. Asserted so that moving it back into the nav is a
  // visible decision rather than a silent one.
  const stale = harness({ ...BASEBALLISM, _staleReconcile: true });
  stale.mount(OVERVIEW);
  assert.deepEqual(stale.tabs(), Object.keys(PAGES));
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
  assert.deepEqual(h.tabs(), [OVERVIEW, EXPLORER, ATTRIBUTION, AD_STUDIO, SEO]);
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
  h.mount('planning/tasks');
  assert.equal(h.nav, undefined);
  assert.doesNotThrow(() => h.refresh('finance/accounting'));
  assert.equal(h.nav, undefined);
});

// Ad Studio and SEO each keep their own inner strip over several pages. The
// Marketing strip has to draw on those pages too -- otherwise walking into
// SEO's Keywords page leaves no way back to Marketing -- with the tab the page
// sits under marked current, not a tab of its own.
test('an inner page of Ad Studio or SEO draws the Marketing strip under its own tab', () => {
  for (const [inner, tab] of [['seo/keywords', SEO], ['seo/studio', SEO], ['ads/testing', AD_STUDIO], ['ads/studio', AD_STUDIO]]) {
    const h = harness(BASEBALLISM);
    h.window.SiloSeoSuite = { contains: (id) => String(id).startsWith('seo/') };
    h.window.SiloAdStudioSuite = { contains: (id) => String(id).startsWith('ads/') };
    h.mount(inner);
    assert.ok(h.nav, `${inner}: no Marketing strip`);
    assert.deepEqual(h.tabs(), Object.keys(PAGES), `${inner}: wrong tab set`);
    const current = h.links().filter((a) => a.getAttribute('aria-current') === 'page');
    assert.equal(current.length, 1, `${inner}: not exactly one current tab`);
    assert.equal(current[0].href, '/v2/' + PAGES[tab], `${inner}: the current tab is not ${tab}`);
  }
});

test('the chrome maps every suite page onto the one row, mounts and refreshes the strip, and skips tab rows', () => {
  assert.match(chromeSource, /SiloPerformanceSuite\?\.contains\(navActive\)\) navActive = Nav\.PERFORMANCE_ROW/);
  // Ad Studio and SEO pages resolve to their own row first; that row is itself
  // a tab, so the chrome resolves once more onto the row the sidebar draws.
  assert.match(chromeSource, /PERFORMANCE_SUITE_PAGES \|\| \[\]\)\.some\(\(\[id\]\) => id === navActive\)/);
  assert.match(chromeSource, /SiloPerformanceSuite\?\.mount\(mainEl, opts\.active\)/);
  // Every strip is redrawn through one helper (2026-11-13), which runs when
  // the company, the department or the grants resolve -- each of which can
  // change which tabs this person may be offered.
  assert.match(chromeSource, /SiloPerformanceSuite\?\.refresh\(mainEl, active\)/);
  assert.match(chromeSource, /refreshSuiteStrips\(mainEl, opts\.active\)/);
  assert.match(chromeSource, /Nav\.sidebarSections/);
});

test('every marketing page loads the strip before the chrome and keeps its nav id', async () => {
  const sources = {
    [OVERVIEW]: await read('v2/marketing-overview.html'),
    [EXPLORER]: await read('v2/marketing-explorer.html'),
    [REPORT]: await read('v2/wow-report.html'),
    [ATTRIBUTION]: (await read('v2/silo-attribution.html')) + (await read('v2/silo-attribution-page.js')),
  };
  // The inner pages of Ad Studio and SEO carry the strip too, each under its
  // own nav id (checked by its own suite's test), so only the load order and
  // the stylesheet are asserted for them here.
  const inner = ['v2/ad-studio.html', 'v2/marketing-ops.html', 'v2/seo-studio.html',
    'v2/seo-overview.html', 'v2/seo-keywords.html', 'v2/seo-tasks.html'];
  for (const file of inner) {
    const src = await read(file);
    const navAt = src.indexOf('src="nav-config.js"');
    const stripAt = src.indexOf('src="performance-suite.js"');
    const chromeAt = src.indexOf('src="silo-chrome.js"');
    assert.ok(navAt > -1 && navAt < stripAt && stripAt < chromeAt, `${file}: nav-config, performance-suite, silo-chrome in that order`);
    assert.ok(src.includes('href="performance-suite.css"'), `${file}: strip stylesheet missing`);
  }
  for (const [id, src] of Object.entries(sources)) {
    const navAt = src.indexOf('src="nav-config.js"');
    const stripAt = src.indexOf('src="performance-suite.js"');
    const chromeAt = src.indexOf('src="silo-chrome.js"');
    assert.ok(navAt > -1 && navAt < stripAt && stripAt < chromeAt, `${id}: nav-config, performance-suite, silo-chrome in that order`);
    assert.ok(src.includes('href="performance-suite.css"'), `${id}: strip stylesheet missing`);
    assert.ok(src.replace(/\s/g, '').includes(`active:'${id}'`), `${id}: page no longer mounts with its own id`);
  }
});
