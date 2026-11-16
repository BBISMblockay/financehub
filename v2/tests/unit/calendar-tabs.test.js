/* One "Calendar" nav row, two tabs (2026-11-11).
 *
 * The sidebar used to carry two Planning rows -- "Launch calendar" and
 * "Org Calendar". They are now one row whose page shows a tab strip, and each
 * view keeps its own URL so existing bookmarks and the ?launch= / ?po_id= deep
 * links still land. Nothing is behaviourally shared between the two pages, so
 * the only things that can silently break are: the nav collapsing back to two
 * rows, one page losing the strip (which makes the other view unreachable from
 * the UI), a tab pointing at a file that is not there, or a page mounting
 * chrome under the old nav key so no row highlights. Each is asserted here. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');

const r = createReporter('calendar-tabs');
const root = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const PAGES = ['/v2/launch-calendar.html', '/v2/calendar.html']; // also the tab order
const NAV_KEY = 'planning/calendar';

/* 2026-11-13: Planning itself collapsed to one row (Tasks), so Calendar is now
 * a tab of THAT row and the Org calendar is a tab of Calendar. Both pages are
 * still rows with their own gates and "Jump to" entries, and the in-page
 * .cal-switch strip is still the only way between the two calendars -- which
 * is what the rest of this file guards. */
r.test('the launch calendar is the one drawn Planning row; the org calendar is its tab', () => {
  const context = { window: {} };
  vm.runInNewContext(read('v2/nav-config.js'), context);
  const nav = context.window.SiloNav;
  for (const profile of ['standard', 'grandfathered']) {
    const all = nav.navSectionsForProfile(profile, 'exec', 'owner', []).flatMap((s) => s.items);
    // Both pages stay nav rows, so "Jump to" and the gates are unchanged...
    const rows = all.filter((i) => PAGES.includes(i.href));
    r.eq(rows.map((i) => i.href).sort(), [...PAGES].sort(), `${profile}: both pages still nav rows`);
    // ...and exactly one of them is drawn in the sidebar: the launch calendar,
    // which since 2026-11-16 is the Planning row itself.
    const drawn = nav.sidebarSections(nav.navSectionsForProfile(profile, 'exec', 'owner', []))
      .flatMap((s) => s.items).filter((i) => PAGES.includes(i.href));
    r.eq(drawn.map((i) => i.href), ['/v2/launch-calendar.html'], `${profile}: only the launch calendar is drawn`);
    const cal = rows.find((i) => i.href === '/v2/launch-calendar.html');
    r.eq(cal.id, NAV_KEY, `${profile}: the Calendar row id`);
    // Calendar IS the drawn Planning row since 2026-11-16, so it carries the
    // suite's name; 'Calendar' is its name as the strip's first tab.
    r.eq(cal.label, 'Planning', `${profile}: row label is the suite's`);
    r.eq(cal.tabOf, undefined, `${profile}: Calendar is the drawn Planning row`);
    const planningRow = nav.sidebarSections(nav.navSectionsForProfile(profile, 'exec', 'owner', []))
      .flatMap((s) => s.items).find((i) => i.id === NAV_KEY);
    r.truthy(planningRow, `${profile}: the Planning row is drawn`);
    // ...and the strip it heads is the Planning suite's, with Calendar first
    // and Tasks last.
    const suite = (nav.SUITES || []).find((x) => x.row === NAV_KEY);
    r.eq(suite?.pages[0]?.[0], NAV_KEY, `${profile}: Calendar is the first Planning tab`);
    r.eq(suite?.pages[suite.pages.length - 1]?.[0], 'planning/tasks', `${profile}: Tasks is the last Planning tab`);
    const org = rows.find((i) => i.href === '/v2/calendar.html');
    r.eq(org.tabOf, NAV_KEY, `${profile}: Org calendar is a tab of the Calendar row`);
  }
});

r.test('both pages carry the tab strip and mount the same nav key', () => {
  for (const page of PAGES) {
    const src = read(page.slice(1));
    r.has(src, '<nav class="cal-switch"', `${page}: has the strip`);
    for (const href of PAGES) {
      r.has(src, `<a href="${href}"`, `${page}: links ${href}`);
      r.truthy(fs.existsSync(path.join(root, href.slice(1))), `${href} must exist`);
    }
    // Exactly one tab marks itself current, and it is this page's own.
    const current = [...src.matchAll(/<a href="([^"]+)" aria-current="page">/g)].map((m) => m[1]);
    r.eq(current, [page], `${page}: the current tab is this page`);
    r.has(src, `'${NAV_KEY}'`, `${page}: mounts active:'${NAV_KEY}'`);
    r.not(src, 'planning/launch-calendar', `${page}: no stale nav key`);
  }
});

r.test('the strip is not a .pg-tab-bar', () => {
  // launch-calendar.html relocates document.querySelector('.pg-tab-bar') into
  // its toolbar; a strip wearing that class would be the one it grabs.
  for (const page of PAGES) {
    const src = read(page.slice(1));
    const at = src.indexOf('<nav class="cal-switch"');
    r.not(src.slice(at, src.indexOf('</nav>', at)), 'pg-tab', `${page}: strip must not use pg-tab`);
  }
});

const out = r.summary();
process.exit(out.fail ? 1 : 0);
