/* Four more sidebar sections collapse to one row each (2026-11-13).
 *
 * Blake: "solid consolidations makes menu less overwhelming", then "plan to
 * condense those without losing power of app?". So: Inventory, Requests,
 * Planning and Team each draw ONE sidebar row, and the pages that used to be
 * rows beside it are tabs of it, drawn by one generic strip (v2/suite-nav.js)
 * from SiloNav.SUITES.
 *
 * Nothing may be lost in the collapse, so what is asserted here is what could
 * silently go missing:
 *  - a tab that stopped being a nav row, which would take its gate, its URL
 *    and its "Jump to" entry with it;
 *  - a tab whose row says one href and whose strip says another;
 *  - a page that does not load the strip, which strands every other tab;
 *  - a page mounting chrome under a key the strip does not know;
 *  - the gates: TikTok Live Schedule and the three Team pages stay
 *    grandfathered-only, Request Manager and Mailroom keep their department
 *    gates, Product Studio stays standard-only;
 *  - the "waiting on you" badges, which hang off sidebar rows: a hidden tab's
 *    count has to roll up to the row the sidebar draws, or collapsing a
 *    section silently drops it. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');

const r = createReporter('suite-nav');
const root = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function navOf() {
  const context = { window: {} };
  vm.runInNewContext(read('v2/nav-config.js'), context);
  return context.window.SiloNav;
}
const Nav = navOf();
const rowsFor = (profile) => Nav.navSectionsForProfile(profile, 'exec', 'owner', []).flatMap((s) => s.items);
const drawnFor = (profile) => Nav.sidebarSections(Nav.navSectionsForProfile(profile, 'exec', 'owner', []))
  .flatMap((s) => s.items);

r.test('every suite draws one row and keeps every tab a nav row', () => {
  r.truthy(Nav.SUITES?.length >= 4, 'four suites at least');
  for (const suite of Nav.SUITES) {
    r.eq(suite.pages[0][0], suite.row, `${suite.key}: the row's own page leads its strip`);
    for (const profile of ['grandfathered', 'standard']) {
      const rows = rowsFor(profile);
      const drawn = drawnFor(profile).map((i) => i.id);
      for (const [id, , href] of suite.pages) {
        const row = rows.find((i) => i.id === id);
        if (!row) continue;                       // narrowed away by profile, which is its row's own gate
        r.eq(row.href, href, `${profile}/${id}: the strip and the row must name one URL`);
        if (id === suite.row) r.truthy(drawn.includes(id), `${profile}: ${id} is the drawn row`);
        else r.truthy(!drawn.includes(id), `${profile}: ${id} is drawn as a row of its own`);
      }
    }
  }
});

r.test('every tab resolves to its own suite row, and no tabOf dangles', () => {
  for (const suite of Nav.SUITES) {
    for (const [id] of suite.pages.slice(1)) {
      const row = Nav.NAV_ITEMS.find((i) => i.id === id);
      r.eq(row.tabOf, suite.row, `${id}: tabOf must name its suite's row`);
    }
  }
  for (const item of Nav.NAV_ITEMS.filter((i) => i.tabOf)) {
    r.truthy(Nav.NAV_ITEMS.some((i) => i.id === item.tabOf), `${item.id}: tabOf names no row`);
  }
});

r.test('the gates are untouched by the collapse', () => {
  const row = (id) => Nav.NAV_ITEMS.find((i) => i.id === id);
  r.eq([...row('planning/live-schedule').profiles], ['grandfathered'], 'TikTok stays grandfathered');
  for (const id of ['team/reviews', 'team/my-review', 'team/comp-requests']) {
    r.eq([...row(id).profiles], ['grandfathered'], `${id} stays grandfathered`);
  }
  r.eq([...row('purchasing/product-studio').profiles], ['standard'], 'Product Studio stays standard-only');
  r.truthy(row('finance/request-manager').departments?.length, 'Request Manager keeps its department gate');
  r.truthy(row('finance/mailroom').departments?.length, 'Mailroom keeps its department gate');
  // A department that cannot see Request Manager still sees the row it is a
  // tab of -- the collapse must not hand anyone a page their gate refused.
  const marketing = Nav.navSectionsForProfile('standard', 'marketing', 'user', []).flatMap((s) => s.items).map((i) => i.id);
  r.truthy(marketing.includes('finance/payment-request'), 'anyone may raise a payment request');
  r.truthy(!marketing.includes('finance/request-manager'), 'marketing must not get Request Manager');
});

r.test('every suite page loads the strip and mounts its own nav id', () => {
  for (const suite of Nav.SUITES) {
    for (const [id, , href] of suite.pages) {
      const file = href.slice(1);
      r.truthy(fs.existsSync(path.join(root, file)), `${href} must exist`);
      // A page may mount chrome from its own module, so read the page plus
      // every local script it loads -- that is where active:'<id>' lives.
      const dir = path.dirname(file);
      const page = read(file);
      // A cache-busting ?v=... is part of the src, so match the path alone.
      const scripts = [...page.matchAll(/<script[^>]*src="([^"?]+\.js)(?:\?[^"]*)?"/g)].map((m) => m[1])
        .filter((u) => !/^https?:/.test(u))
        .map((u) => path.normalize(path.join(dir, u)))
        .filter((f) => fs.existsSync(path.join(root, f)));
      const src = page + scripts.map((f) => read(f)).join('');
      r.has(page, 'suite-nav.js', `${href}: loads the strip`);
      r.has(page, 'suite-nav.css', `${href}: loads the strip's styles`);
      r.truthy(page.indexOf('suite-nav.js') < page.indexOf('silo-chrome.js'), `${href}: the strip loads before silo-chrome.js`);
      r.truthy(src.replace(/\s/g, '').includes(`active:'${id}'`), `${href}: mounts active:'${id}'`);
    }
  }
});

r.test('silo-chrome mounts the strip and rolls a hidden tab badge up to its row', () => {
  const src = read('v2/silo-chrome.js');
  r.has(src, 'SiloSuiteNav?.contains(navActive)', 'maps a suite page onto its row');
  r.has(src, 'SiloSuiteNav?.mount(', 'mounts the strip');
  r.has(src, 'SiloSuiteNav?.refresh(', 'redraws it once the company is known');
  // The badge map the sidebar prints is the rolled-up one, not the raw counts.
  r.has(src, 'badges[item.id]', 'rows print the rolled-up count');
  r.not(src, 'navBadges[item.id]', 'a raw per-id count would drop a hidden tab');
});

r.test('the strip draws the tabs the nav returns, with the open one current', () => {
  const make = (tag) => ({
    tag, children: [], dataset: {}, attrs: {}, className: '', textContent: '', innerHTML: '', href: '',
    append(...n) { this.children.push(...n); },
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelector() { return null; },
  });
  const context = {
    window: { SiloNav: Nav, __SILO_CONFIG__: { getActiveCompany: () => ({ id: 'c1', meta: { nav_profile: 'grandfathered' } }) } },
    document: { createElement: make },
  };
  vm.runInNewContext(read('v2/suite-nav.js'), context);
  const Suite = context.window.SiloSuiteNav;
  const planning = Nav.SUITES.find((s) => s.key === 'planning');
  r.truthy(Suite.contains('planning/tasks') && Suite.contains('planning/live-schedule'), 'the Planning pages are in the suite');
  r.truthy(!Suite.contains('finance/accounting'), 'an unrelated page is not');
  r.eq(Suite.rowOf('planning/live-schedule'), 'planning/tasks', 'a tab resolves to its row');

  let mounted = null;
  const main = { querySelector: () => mounted, firstElementChild: { after: (n) => { mounted = n; } } };
  Suite.mount(main, 'planning/live-schedule');
  const links = mounted.children[1].children;
  r.eq(links.map((a) => a.href), planning.pages.map((p) => p[2]), 'every Planning tab drawn, in order');
  r.eq(links.filter((a) => a.attrs['aria-current'] === 'page').map((a) => a.href),
    ['/v2/live-schedule.html'], 'the open tab, and only it, is current');

  // A standard workspace loses the grandfathered tabs, and the page it is ON
  // is always in its own strip -- otherwise there is no way back out of it.
  const std = { window: { SiloNav: Nav, __SILO_CONFIG__: { getActiveCompany: () => ({ id: 'c2' }) } }, document: { createElement: make } };
  vm.runInNewContext(read('v2/suite-nav.js'), std);
  let m2 = null;
  const main2 = { querySelector: () => m2, firstElementChild: { after: (n) => { m2 = n; } } };
  std.window.SiloSuiteNav.mount(main2, 'planning/tasks');
  r.eq(m2.children[1].children.map((a) => a.href), ['/v2/tasks.html', '/v2/launch-calendar.html'], 'standard: no TikTok tab');
  let m3 = null;
  const main3 = { querySelector: () => m3, firstElementChild: { after: (n) => { m3 = n; } } };
  std.window.SiloSuiteNav.mount(main3, 'team/my-review');
  r.eq(m3.children[1].children.map((a) => a.href), ['/v2/my-review.html'], 'the open page is its own way back');
});

r.summary();
