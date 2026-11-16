/* Two nav changes of 2026-11-16, both Blake's.
 *
 * 1. A sidebar section with ONE visible row is drawn as that row: no expand
 *    step, no chevron, one click to the page. ("if 'Planning' only has
 *    'planning' sub menu, when they click main header menu for 'Planning'
 *    just go, don't require two clicks of 'planning'.") A section with more
 *    than one row keeps its toggle, so the accordion is not gone -- it just
 *    stops appearing where there is nothing to choose between.
 *
 * 2. Home is a suite: /v2/finance.html is its Overview, and Setup, My Profile
 *    and Help are tabs of the strip on it and ONLY there. Blake: "my profile
 *    and help ... are available if your in the tabbed suite, so don't wanna
 *    duplicate menu names and dropdowns." Start therefore draws one row --
 *    Home -- which, being alone, is a direct link by rule 1.
 *
 * What could silently go wrong, and is therefore asserted: a solo row that is
 * not a link at all; a solo row that stops being an `a.silo-sb-link` (the
 * Home mirror in home-nav.js and the "Jump to" palette both read that class);
 * a strip whose tabs are not Home's; a tab that reappears as a sidebar row,
 * which is the duplication this removed; and a tab page that stops
 * highlighting the Home row it is reached through.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('nav-solo-and-home-suite');

const STANDARD = { id: 'acme-co', title: 'Acme Co', entity_key: 'acme' };
const GRANDFATHERED = { id: 'test-company', title: 'Baseballism', entity_key: 'baseballism', meta: { nav_profile: 'grandfathered' } };
const tables = ({ role, department, membership, entity }) => ({
  profiles: [{ id: 'test-user', role, department, email: 'test@baseballism.com' }],
  entity_memberships: [{ user_id: 'test-user', entity_id: entity, role: membership }],
});
const ready = () => !!document.querySelector('#siloSbNav .silo-sb-link');

async function readNav(page) {
  await page.waitForTimeout(900); // department, grants and role repaint the sidebar
  return page.evaluate(() => {
    const sections = [...document.querySelectorAll('#siloSbNav .silo-sb-section')].map((s) => ({
      name: s.getAttribute('data-section'),
      solo: s.classList.contains('silo-sb-section--solo'),
      featured: s.classList.contains('silo-sb-section--featured'),
      hasToggle: !!s.querySelector('[data-silo-action="section-toggle"]'),
      hasChevron: !!s.querySelector('.silo-sb-section-chevron'),
      links: [...s.querySelectorAll('a.silo-sb-link, a.silo-sb-feature')].map((a) => ({
        href: a.getAttribute('href'),
        label: (a.querySelector('.silo-sb-link-label, .silo-sb-feature-label') || a).textContent.trim(),
        visible: a.offsetParent !== null,
      })),
    }));
    const strip = document.querySelector('[data-suite-nav]');
    return {
      sections,
      strip: strip && {
        key: strip.dataset.suiteNav,
        label: strip.querySelector('.suite-nav-label')?.textContent.trim(),
        tabs: [...strip.querySelectorAll('.suite-nav-links a')].map((a) => ({
          href: a.getAttribute('href'),
          text: a.querySelector('.suite-nav-text')?.textContent.trim(),
          current: a.getAttribute('aria-current') === 'page',
        })),
      },
      active: document.querySelector('#siloSbNav a.silo-sb-link--active')?.getAttribute('data-nav-id') || null,
    };
  });
}

(async () => {
  const suite = await startSuite({ viewport: { width: 1400, height: 900 } });
  try {
    for (const [name, company, entity] of [['grandfathered', GRANDFATHERED, 'test-company'], ['standard', STANDARD, 'acme-co']]) {
      console.log(`\n── ${name} owner: one-row sections are the row ──`);
      const page = await suite.open('/v2/finance.html',
        tables({ role: 'owner', department: 'exec', membership: 'owner_admin', entity }),
        { cachedCompany: company, ready });
      const nav = await readNav(page);
      const solos = nav.sections.filter((s) => s.solo);
      r.ok(`${name}: there are one-row sections to collapse`, solos.length >= 4,
        JSON.stringify(nav.sections.map((s) => [s.name, s.links.length, s.solo])));
      for (const s of solos) {
        r.ok(`${name}: ${s.name} is one visible link`, s.links.length === 1 && s.links[0].visible, JSON.stringify(s));
        r.ok(`${name}: ${s.name} has no expand step`, !s.hasToggle && !s.hasChevron, JSON.stringify(s));
      }
      // Multi-row sections keep the accordion: the change is scoped.
      const grouped = nav.sections.filter((s) => !s.solo && !s.featured);
      r.ok(`${name}: multi-row sections still expand`, grouped.length >= 1 && grouped.every((s) => s.hasToggle),
        JSON.stringify(grouped.map((s) => [s.name, s.links.length, s.hasToggle])));
      // Start is one row -- Home -- and the pages that used to sit beside it
      // are tabs of its strip, named nowhere else in the menu.
      const start = nav.sections.find((s) => s.name === 'Start');
      r.ok(`${name}: Start is one direct Home link`,
        !!start && start.solo && start.links.length === 1 && start.links[0].href === '/v2/finance.html',
        JSON.stringify(start));
      const everyLink = nav.sections.flatMap((s) => s.links.map((l) => l.href));
      for (const dup of ['/v2/profile.html', '/v2/help.html', '/v2/setup-checklist.html']) {
        r.ok(`${name}: ${dup} is not also a menu row`, !everyLink.includes(dup), JSON.stringify(everyLink));
      }

      console.log(`── ${name} owner: Home is a suite ──`);
      r.ok(`${name}: Home draws the Start strip`, nav.strip?.key === 'start' && nav.strip.label === 'Home',
        JSON.stringify(nav.strip));
      const tabs = nav.strip?.tabs || [];
      r.ok(`${name}: Overview leads it and is the open tab`,
        tabs[0]?.href === '/v2/finance.html' && tabs[0]?.text === 'Overview' && tabs[0]?.current,
        JSON.stringify(tabs));
      r.ok(`${name}: My Profile and Help are tabs`,
        tabs.some((t) => t.href === '/v2/profile.html') && tabs.some((t) => t.href === '/v2/help.html'),
        JSON.stringify(tabs));
      // Setup is a standard-profile, admin-only row, so it is a tab exactly
      // where its own row is -- the strip adds no visibility of its own.
      r.ok(`${name}: Setup is a tab only where its row is`,
        tabs.some((t) => t.href === '/v2/setup-checklist.html') === (name === 'standard'),
        JSON.stringify(tabs));

      // A tab page highlights the ONE row the suite collapsed into, as every
      // other suite does -- there is no row of its own left to highlight.
      await Promise.all([page.waitForURL(/\/v2\/help\.html/), page.click('[data-suite-nav] a[href="/v2/help.html"]')]);
      const onHelp = await readNav(page);
      r.ok(`${name}: Help highlights the Home row`, onHelp.active === 'finance/menu', String(onHelp.active));
      r.ok(`${name}: and carries the same strip, with Help current`,
        onHelp.strip?.key === 'start' && onHelp.strip.tabs.find((t) => t.current)?.href === '/v2/help.html',
        JSON.stringify(onHelp.strip));
      await page.close();
    }

    console.log('\n── one click: a solo row navigates straight there ──');
    const page = await suite.open('/v2/finance.html',
      tables({ role: 'owner', department: 'exec', membership: 'owner_admin', entity: 'test-company' }),
      { cachedCompany: GRANDFATHERED, ready });
    await page.waitForTimeout(900);
    const href = await page.$eval('#siloSbNav .silo-sb-section--solo a.silo-sb-link', (a) => a.getAttribute('href'));
    await Promise.all([page.waitForURL((u) => u.pathname === href), page.click('#siloSbNav .silo-sb-section--solo a.silo-sb-link')]);
    r.ok(`one click reached ${href}`, new URL(page.url()).pathname === href, page.url());
    await page.close();
  } catch (err) {
    r.ok('suite ran without throwing', false, err && err.stack);
  } finally {
    await suite.close();
  }
  const { fail } = r.summary();
  process.exit(fail ? 1 : 0);
})();
