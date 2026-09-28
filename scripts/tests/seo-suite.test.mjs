// SEO suite navigation: one SEO destination in the sidebar, three tabs across
// the pages that already existed.
//
// What is worth asserting here, and why:
//
//  1. The tabs are the EXISTING pages at their existing URLs. Pointing a tab at
//     a new route would be a second implementation of a page, and would break
//     every bookmark to it -- so the tab hrefs are pinned.
//  2. The sidebar shows ONE SEO row. A row per tab beside a tab strip is two
//     navigations for one place, which is what this work removed.
//  3. The row's gate is the union of the rows it replaced: the exec soft-launch
//     gate, OR a seo_approvers grant. Nobody who lacked both sees it.
//  4. Every tab page mounts the strip and announces the id the strip looks
//     for; a page that forgets renders inside the suite with no way across.
//
// Run: node --test scripts/tests/seo-suite.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const navSource = await read('v2/nav-config.js');
const stripSource = await read('v2/seo-suite.js');
const chromeSource = await read('v2/silo-chrome.js');

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {};
    this.innerHTML = ''; this.textContent = '';
  }
  append(...v) { this.children.push(...v); }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
}

function mountStrip(active) {
  const document = { createElement: (tag) => new Element(tag) };
  const window = {};
  vm.runInNewContext(navSource, { window });
  vm.runInNewContext(stripSource, { window, document });
  let mounted;
  const main = { querySelector: () => mounted, firstElementChild: { after: (n) => { mounted = n; } } };
  window.SiloSeoSuite.mount(main, active);
  return { window, main, nav: mounted, links: mounted ? mounted.children[1].children : [] };
}

const nav = (() => { const w = {}; new Function('window', navSource)(w); return w.SiloNav; })();
const PAGES = {
  'seo/studio': 'seo-studio.html',
  'seo/performance': 'seo-overview.html',
  'seo/keywords': 'seo-keywords.html',
  'seo/tasks': 'seo-tasks.html',
};

test('four tabs, Studio first, each on its existing page, the current one identified', () => {
  assert.deepEqual(nav.SEO_SUITE_PAGES.map(([id, , path]) => [id, path]), Object.entries(PAGES));
  for (const active of Object.keys(PAGES)) {
    const m = mountStrip(active);
    assert.equal(m.links.length, 4);
    const current = m.links.filter((l) => l.attributes['aria-current'] === 'page');
    assert.equal(current.length, 1);
    assert.equal(current[0].href, '/v2/' + PAGES[active]);
  }
});

test('the strip is inert on a page that is not an SEO tab, and never mounts twice', () => {
  assert.equal(mountStrip('reports/wow-report').nav, undefined);
  assert.equal(mountStrip('settings/team').nav, undefined);
  const s = mountStrip('seo/keywords');
  const first = s.nav;
  s.window.SiloSeoSuite.mount(s.main, 'seo/keywords');
  assert.equal(s.main.querySelector(), first);
});

test('the sidebar carries ONE SEO destination, not one row per tab', () => {
  const sections = nav.navSectionsForProfile('grandfathered', 'marketing', 'owner', new Set());
  const items = sections.flatMap((s) => s.items);
  const seo = items.filter((i) => /seo/i.test(i.id + i.href));
  assert.deepEqual(seo.map((i) => i.id), ['reports/seo']);
  assert.equal(seo[0].href, '/v2/seo-studio.html');
  for (const file of Object.values(PAGES).slice(1)) {
    assert.equal(items.filter((i) => i.href === '/v2/' + file).length, 0, `${file} is reached through the tab strip`);
  }
  // Every tab highlights that one row.
  assert.match(chromeSource, /SiloSeoSuite\?\.contains\(navActive\)\) navActive = 'reports\/seo'/);
  assert.match(chromeSource, /SiloSeoSuite\?\.mount\(mainEl, opts\.active\)/);
});

test('the SEO row is gated by the exec soft launch OR a seo_approvers grant, nothing wider', () => {
  const has = (role, grants) => nav.navSectionsForProfile('grandfathered', 'marketing', role, grants)
    .some((s) => s.items.some((i) => i.id === 'reports/seo'));
  assert.ok(has('owner', new Set()));
  assert.ok(has('executive', new Set()));
  assert.ok(!has('admin', new Set()));
  assert.ok(!has('user', new Set()));
  assert.ok(has('user', new Set(['reports/seo'])), 'a seo_approvers grant reveals it');
  const item = nav.NAV_ITEMS.find((i) => i.id === 'reports/seo');
  assert.equal(item.grantTable, 'seo_approvers');
});

test('every tab page loads the strip and declares its own tab', async () => {
  for (const [id, file] of Object.entries(PAGES)) {
    const html = await read('v2/' + file);
    assert.match(html, /seo-suite\.css/, `${file} loads the strip stylesheet`);
    assert.match(html, /seo-suite\.js/, `${file} loads the strip`);
    assert.ok(html.includes(`active: '${id}'`), `${file} mounts SiloChrome with active: ${id}`);
    assert.ok(html.indexOf('nav-config.js') < html.indexOf('seo-suite.js'), `${file} loads nav-config.js first`);
    assert.ok(html.indexOf('seo-suite.js') < html.indexOf('silo-chrome.js'), `${file} loads the strip before silo-chrome.js`);
  }
});
