// The Ad Studio suite: one marketing destination in the sidebar, with the test
// record and the schedule as a tab of it rather than a row of their own.
//
// What is worth asserting here, and why:
//
//  1. The tabs are the EXISTING pages at their existing URLs. Pointing a tab at
//     a new route would be a second implementation of a page and would break
//     every link to it, so the hrefs are pinned. /v2/marketing-ops.html shipped
//     as its own sidebar row for a few hours on 2026-10-13; that URL has to
//     keep working.
//  2. The sidebar shows ONE Ad Studio row. A row per tab beside a tab strip is
//     two navigations for one place, which is what this work removed.
//  3. The Schedule tab is Baseballism-only for now (Blake, 2026-10-13) while
//     the page is shaped around how Baseballism runs tests -- and it is the
//     FIRST tab in SILO narrowed on its own, so the per-tab profiles list is
//     tested in both directions. This is discovery, not access: marketing_tests
//     RLS is the boundary and a direct URL was never a leak.
//  4. The tab you are LOOKING AT is always in its own strip. A deep-linked tab
//     has no cached company (sessionStorage is per-tab, the auth session is
//     not), so resolveNavProfile answers 'standard' for one paint -- and a
//     strip that hid the open page would leave no way back out of it.
//  5. refresh() exists for that same paint: it redraws once the real company is
//     known, and leaves the DOM alone when the set of tabs did not change.
//
// Run: node --test scripts/tests/ad-studio-suite.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const navSource = await read('v2/nav-config.js');
const stripSource = await read('v2/marketing-suite.js');
const chromeSource = await read('v2/silo-chrome.js');

const BASEBALLISM = { id: '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', entity_key: 'baseballism' };
const OTHER = { id: '11111111-1111-4111-8111-111111111111', entity_key: 'acme' };

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

// `company` is what getActiveCompany() answers: null reproduces a deep link
// with nothing cached, which is the case the strip has to fail small on.
function harness(company) {
  const document = { createElement: (tag) => new Element(tag) };
  const window = { __SILO_CONFIG__: { getActiveCompany: () => company } };
  vm.runInNewContext(navSource, { window });
  vm.runInNewContext(stripSource, { window, document });
  let mounted;
  const main = {
    querySelector: () => mounted,
    firstElementChild: { after: (n) => { mounted = n; } },
  };
  return {
    window,
    main,
    get nav() { return mounted; },
    links: () => (mounted ? mounted.children[1].children : []),
    tabs: () => (mounted ? String(mounted.dataset.adsSuiteTabs || '').split(',').filter(Boolean) : []),
    mount: (active) => window.SiloAdStudioSuite.mount(main, active),
    refresh: (active) => window.SiloAdStudioSuite.refresh(main, active),
  };
}

const nav = (() => { const w = {}; new Function('window', navSource)(w); return w.SiloNav; })();
const PAGES = {
  'ads/studio': 'ad-studio.html',
  'ads/testing': 'marketing-ops.html',
};

test('two tabs, Ad Studio first, each on its existing page, the current one identified', () => {
  assert.deepEqual(nav.AD_STUDIO_SUITE_PAGES.map(([id, , path]) => [id, path]), Object.entries(PAGES));
  for (const active of Object.keys(PAGES)) {
    const h = harness(BASEBALLISM);
    h.mount(active);
    assert.equal(h.links().length, 2);
    const current = h.links().filter((l) => l.attributes['aria-current'] === 'page');
    assert.equal(current.length, 1);
    assert.equal(current[0].href, '/v2/' + PAGES[active]);
  }
});

test('the strip is inert off the suite, and never mounts twice', () => {
  const off = harness(BASEBALLISM);
  off.mount('reports/wow-report');
  assert.equal(off.nav, undefined);
  off.mount('seo/studio');
  assert.equal(off.nav, undefined);

  const on = harness(BASEBALLISM);
  on.mount('ads/studio');
  const first = on.nav;
  on.mount('ads/studio');
  assert.equal(on.main.querySelector(), first);
});

test('the sidebar carries ONE Ad Studio destination, not one row per tab', () => {
  for (const profile of ['grandfathered', 'standard']) {
    const items = nav.navSectionsForProfile(profile, 'marketing', 'owner', new Set())
      .flatMap((s) => s.items);
    const studio = items.filter((i) => /ad-studio|marketing-ops/.test(i.href));
    assert.deepEqual(studio.map((i) => i.id), ['reports/ad-studio'], `${profile}: one row`);
    assert.equal(studio[0].href, '/v2/ad-studio.html');
    assert.equal(items.filter((i) => i.href === '/v2/marketing-ops.html').length, 0,
      `${profile}: marketing-ops is reached through the tab strip`);
  }
  // Every tab highlights that one row, and the strip is mounted at all.
  assert.match(chromeSource, /SiloAdStudioSuite\?\.contains\(navActive\)\) navActive = 'reports\/ad-studio'/);
  assert.match(chromeSource, /SiloAdStudioSuite\?\.mount\(mainEl, opts\.active\)/);
});

test('the Schedule is a Baseballism-only tab; the row itself is not narrowed', () => {
  assert.deepEqual(nav.AD_STUDIO_SUITE_PAGES.find(([id]) => id === 'ads/testing')[3], ['grandfathered']);
  assert.deepEqual(nav.NAV_ITEMS.find((i) => i.id === 'reports/ad-studio').profiles,
    ['grandfathered', 'standard']);

  const bb = harness(BASEBALLISM);
  bb.mount('ads/studio');
  assert.deepEqual(bb.tabs(), ['ads/studio', 'ads/testing']);

  const other = harness(OTHER);
  other.mount('ads/studio');
  assert.deepEqual(other.tabs(), ['ads/studio'], 'another company sees Ad Studio alone');
});

test('the tab you are on is always in its own strip, whatever the profile says', () => {
  // Including a company the tab is not offered to, and the no-company paint.
  for (const company of [OTHER, null]) {
    const h = harness(company);
    h.mount('ads/testing');
    assert.deepEqual(h.tabs(), ['ads/studio', 'ads/testing']);
    assert.equal(h.links().filter((l) => l.attributes['aria-current'] === 'page')[0].href,
      '/v2/marketing-ops.html');
  }
});

test('refresh redraws the strip when the company resolves, and not otherwise', () => {
  // First paint with nothing cached answers 'standard', so the narrowed tab is
  // missing; the company resolving to Baseballism has to bring it back.
  let company = null;
  const document = { createElement: (tag) => new Element(tag) };
  const window = { __SILO_CONFIG__: { getActiveCompany: () => company } };
  vm.runInNewContext(navSource, { window });
  vm.runInNewContext(stripSource, { window, document });
  let mounted;
  const main = { querySelector: () => mounted, firstElementChild: { after: (n) => { mounted = n; } } };

  window.SiloAdStudioSuite.mount(main, 'ads/studio');
  const first = mounted;
  assert.deepEqual(String(first.dataset.adsSuiteTabs).split(','), ['ads/studio']);

  company = BASEBALLISM;
  window.SiloAdStudioSuite.refresh(main, 'ads/studio');
  assert.ok(first.replacedWith, 'the strip is replaced once the company is known');
  assert.deepEqual(String(first.replacedWith.dataset.adsSuiteTabs).split(','),
    ['ads/studio', 'ads/testing']);

  // Nothing changed this time: the node is left exactly as it was, so a normal
  // load (cache already correct) never flickers the strip.
  mounted = first.replacedWith;
  mounted.replacedWith = null;
  window.SiloAdStudioSuite.refresh(main, 'ads/studio');
  assert.equal(mounted.replacedWith, null);

  // And it is inert off the suite, like mount().
  assert.doesNotThrow(() => window.SiloAdStudioSuite.refresh(main, 'reports/wow-report'));
  assert.equal(mounted.replacedWith, null);
});

test('every tab page loads the strip and declares its own tab', async () => {
  for (const [id, file] of Object.entries(PAGES)) {
    const html = await read('v2/' + file);
    assert.match(html, /marketing-suite\.css/, `${file} loads the strip stylesheet`);
    assert.match(html, /marketing-suite\.js/, `${file} loads the strip`);
    assert.ok(html.includes(`active: '${id}'`), `${file} mounts SiloChrome with active: ${id}`);
    assert.ok(html.indexOf('nav-config.js') < html.indexOf('marketing-suite.js'),
      `${file} loads nav-config.js first`);
    assert.ok(html.indexOf('marketing-suite.js') < html.indexOf('silo-chrome.js'),
      `${file} loads the strip before silo-chrome.js`);
  }
});

test('the strip styles its own classes only, and declares no new token', async () => {
  const css = await read('v2/marketing-suite.css');
  const selectors = [...css.matchAll(/^\.([a-z-]+)/gm)].map((m) => m[1]);
  assert.ok(selectors.length, 'the stylesheet has rules');
  for (const s of selectors) {
    assert.ok(s.startsWith('ads-suite'), `${s} is outside the strip's own namespace`);
  }
  assert.deepEqual([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]), [],
    'the strip declares CSS variables of its own');
});
