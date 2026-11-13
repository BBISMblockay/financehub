/* Revenue projection and its scenarios move into Finance (2026-11-13).
 *
 * Blake: "Revenue projection and planning scenarios should go under accounting
 * in menu. Change main name of accounting menu to finance sub accounting,
 * customers, rev proj (tabbed with planning scenario not as own tab in
 * finance)".
 *
 * So: the section is named Finance on BOTH profiles (it was 'Accounting' for
 * grandfathered and 'Finance' for standard -- one menu with two names), it
 * holds Accounting, Customers and Revenue projection, and the scenarios are a
 * TAB of the projection rather than a row of their own.
 *
 * What can silently break, and is asserted here:
 *  - the section reverting to two names, or Planning keeping either page;
 *  - the scenarios coming back as a sidebar row;
 *  - either page losing the strip, which makes the other unreachable from it;
 *  - a tab pointing at a file that is not there, or a page mounting chrome
 *    under a key the strip does not know;
 *  - MODULES falling out of step with the rows' `section`. moduleVisible()
 *    matches on item.section, so a stale list there means the Finance switch
 *    silently stops reaching these pages -- a visibility bug with no error. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');

const r = createReporter('projections-suite');
const root = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const ROW = 'planning/revenue-projections';
const SCENARIOS = 'planning/scenarios';
const TABS = [
  [ROW, '/v2/projections.html'],
  [SCENARIOS, '/v2/planning-scenarios.html'],
];
const PROFILES = ['standard', 'grandfathered'];

function nav() {
  const context = { window: {} };
  vm.runInNewContext(read('v2/nav-config.js'), context);
  return context.window.SiloNav;
}
const sectionsFor = (Nav, profile) => Nav.navSectionsForProfile(profile, 'exec', 'owner', []);
const sectionNamed = (sections, name) => sections.find((s) => s.section === name);

r.test('Finance is the section name on both profiles, and holds the three rows', () => {
  const Nav = nav();
  for (const profile of PROFILES) {
    const drawn = Nav.sidebarSections(sectionsFor(Nav, profile));
    const finance = sectionNamed(drawn, 'Finance');
    r.truthy(finance, `${profile}: a Finance section`);
    r.not(sectionNamed(drawn, 'Accounting'), `${profile}: no section still called Accounting`);
    const ids = finance.items.map((i) => i.id);
    for (const id of ['finance/accounting', 'finance/customers', ROW]) {
      r.truthy(ids.includes(id), `${profile}: Finance holds ${id}`);
    }
    // Both pages left Planning: that is the move, not a copy.
    const planning = sectionNamed(drawn, 'Planning');
    for (const id of [ROW, SCENARIOS]) {
      r.truthy(!(planning?.items || []).some((i) => i.id === id), `${profile}: ${id} is no longer in Planning`);
    }
  }
});

r.test('the scenarios are a tab of the projection, not a sidebar row', () => {
  const Nav = nav();
  r.eq(Nav.PROJECTIONS_ROW, ROW, 'PROJECTIONS_ROW');
  r.eq(Nav.PROJECTIONS_SUITE_PAGES.map((p) => p[0]), TABS.map((t) => t[0]), 'tab order');
  for (const profile of PROFILES) {
    const sections = sectionsFor(Nav, profile);
    const all = sections.flatMap((s) => s.items);
    // Every tab stays a nav row, so its gate and its "Jump to" entry are
    // exactly what they were -- only the sidebar skips it.
    for (const [id, href] of TABS) {
      const row = all.find((i) => i.id === id);
      r.truthy(row, `${profile}: ${id} is still a nav row`);
      r.eq(row.href, href, `${profile}: ${id} href`);
      r.eq(row.section, 'Finance', `${profile}: ${id} is in Finance`);
    }
    r.eq(all.find((i) => i.id === SCENARIOS).tabOf, ROW, `${profile}: scenarios are a tab of the projection`);
    const drawn = Nav.sidebarSections(sections).flatMap((s) => s.items)
      .filter((i) => TABS.some(([id]) => id === i.id));
    r.eq(drawn.length, 1, `${profile}: one projection row in the sidebar`);
    r.eq(drawn[0].id, ROW, `${profile}: row id`);
  }
});

r.test('both pages exist, carry the strip and mount their own nav key', () => {
  for (const [id, href] of TABS) {
    const file = href.slice(1);
    r.truthy(fs.existsSync(path.join(root, file)), `${href} must exist`);
    const src = read(file);
    r.has(src, 'projections-suite.js', `${href}: loads the strip`);
    r.has(src, 'projections-suite.css', `${href}: loads the strip's styles`);
    r.has(src, `'${id}'`, `${href}: mounts active:'${id}'`);
    // The strip must be parsed before silo-chrome.js mounts it.
    r.truthy(src.indexOf('projections-suite.js') < src.indexOf('silo-chrome.js'),
      `${href}: the strip loads before silo-chrome.js`);
  }
});

r.test('silo-chrome maps both pages to the one sidebar row', () => {
  const src = read('v2/silo-chrome.js');
  r.has(src, 'SiloProjectionsSuite?.contains(navActive)', 'highlights the row from either tab');
  r.has(src, 'SiloProjectionsSuite?.mount(', 'mounts the strip');
  r.has(src, 'SiloProjectionsSuite?.refresh(', 'redraws it once the company is known');
});

r.test('the Finance module still reaches the rows it governs', () => {
  const Nav = nav();
  const finance = Nav.MODULES.find((m) => m.id === 'finance');
  r.truthy(finance, 'a finance module');
  // moduleVisible() matches MODULES[].sections against item.section. If the
  // rows say 'Finance' and this list still says 'Accounting', turning the
  // module off stops hiding them and nothing errors.
  const sections = sectionsFor(Nav, 'standard').flatMap((s) => s.items)
    .filter((i) => ['finance/accounting', 'finance/customers', ROW, SCENARIOS].includes(i.id))
    .map((i) => i.section);
  for (const name of new Set(sections)) {
    r.truthy(finance.sections.includes(name), `the finance module covers the '${name}' section`);
  }
});

r.test('the strip draws only the tabs the nav returns', () => {
  const Nav = nav();
  const context = { window: { SiloNav: Nav, __SILO_CONFIG__: {} }, document: undefined };
  // A minimal DOM: enough for build() to make the strip and for us to read it.
  const make = (tag) => ({
    tag, children: [], dataset: {}, attrs: {}, className: '', textContent: '', innerHTML: '', href: '',
    append(...n) { this.children.push(...n); },
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelector() { return null; },
  });
  context.document = { createElement: make };
  vm.runInNewContext(read('v2/projections-suite.js'), context);
  const Suite = context.window.SiloProjectionsSuite;
  r.truthy(Suite.contains(ROW) && Suite.contains(SCENARIOS), 'both pages are in the suite');
  r.truthy(!Suite.contains('finance/accounting'), 'an unrelated page is not');

  let mounted = null;
  const main = { querySelector: () => mounted, firstElementChild: { after: (n) => { mounted = n; } } };
  Suite.mount(main, ROW);
  const links = mounted.children[1].children;
  r.eq(links.map((a) => a.href), TABS.map((t) => t[1]), 'both tabs drawn, in order');
  r.eq(links[0].attrs['aria-current'], 'page', 'the open tab is marked current');
});

r.summary();
