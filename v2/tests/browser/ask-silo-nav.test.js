/* Ask SILO in the sidebar: its own section, drawn as ONE accented direct
 * link (no expand step) for the people who may use it, and absent -- no
 * empty section -- for everyone else. The standard Home mirrors the sidebar,
 * so the link must reach Home too (v2/home-nav.js reads it).
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('ask-silo-nav');

const STANDARD = { id: 'acme-co', title: 'Acme Co', entity_key: 'acme' };
const GRANDFATHERED = { id: 'test-company', title: 'Baseballism', entity_key: 'baseballism' };
const tables = ({ role, department, membership, entity }) => ({
  profiles: [{ id: 'test-user', role, department, email: 'test@baseballism.com' }],
  entity_memberships: [{ user_id: 'test-user', entity_id: entity, role: membership }],
});
const ready = () => !!document.querySelector('#siloSbNav .silo-sb-link');

async function readNav(page) {
  await page.waitForTimeout(900); // department, grants and role repaint the sidebar
  return page.evaluate(() => {
    const sections = [...document.querySelectorAll('#siloSbNav .silo-sb-section')].map((s) => s.getAttribute('data-section'));
    const feature = document.querySelector('#siloSbNav a.silo-sb-feature');
    const featSection = feature?.closest('.silo-sb-section');
    return {
      sections,
      feature: feature && {
        href: feature.getAttribute('href'),
        id: feature.getAttribute('data-nav-id'),
        label: feature.querySelector('.silo-sb-feature-label')?.textContent.trim(),
        visible: feature.offsetParent !== null,
        hasToggle: !!featSection?.querySelector('[data-silo-action="section-toggle"]'),
        color: getComputedStyle(feature).color,
        bg: getComputedStyle(feature).backgroundColor,
      },
      plainColor: getComputedStyle(document.querySelector('#siloSbNav .silo-sb-section-label')).color,
      home: [...document.querySelectorAll('#finSections a.fin-link')].map((a) => a.getAttribute('href')),
    };
  });
}

(async () => {
  const suite = await startSuite({ viewport: { width: 1400, height: 900 } });
  try {
    for (const [name, company, entity] of [['grandfathered', GRANDFATHERED, 'test-company'], ['standard', STANDARD, 'acme-co']]) {
      console.log(`\n── ${name} owner: Ask SILO is one accented link, second in the menu ──`);
      const page = await suite.open('/v2/finance.html',
        tables({ role: 'owner', department: 'exec', membership: 'owner_admin', entity }),
        { cachedCompany: company, ready });
      const nav = await readNav(page);
      r.ok(`${name}: Ask SILO is the second section`, nav.sections[1] === 'Ask SILO', JSON.stringify(nav.sections));
      r.ok(`${name}: drawn as a direct link to Ask SILO`,
        nav.feature && nav.feature.href === '/v2/silo-chat.html' && nav.feature.id === 'reports/silo-chat'
          && nav.feature.label === 'Ask SILO', JSON.stringify(nav.feature));
      r.ok(`${name}: visible without expanding anything, and no expand toggle`,
        nav.feature && nav.feature.visible && !nav.feature.hasToggle, JSON.stringify(nav.feature));
      r.ok(`${name}: styled apart from the plain section labels`,
        nav.feature && nav.feature.color !== nav.plainColor && nav.feature.bg !== 'rgba(0, 0, 0, 0)',
        JSON.stringify({ feature: nav.feature, plain: nav.plainColor }));
      if (name === 'standard') {
        r.ok('standard Home still offers Ask SILO (Home mirrors the sidebar)',
          nav.home.includes('/v2/silo-chat.html'), JSON.stringify(nav.home));
      }
      // Clicking it lands on Ask SILO with a breadcrumb that matches the
      // menu: no stale "Reports /" parent (review on #932).
      await Promise.all([page.waitForURL(/\/v2\/silo-chat\.html/), page.click('#siloSbNav a.silo-sb-feature')]);
      await page.waitForSelector('.silo-crumbs .crumb-last', { timeout: 10000 });
      const crumbs = await page.$$eval('.silo-crumbs > span:not(.crumb-sep)', (els) => els.map((e) => e.textContent.trim()));
      r.ok(`${name}: the Ask SILO page's breadcrumb is just "Ask SILO"`,
        JSON.stringify(crumbs) === JSON.stringify(['Ask SILO']), JSON.stringify(crumbs));
      r.ok(`${name}: the featured link shows as active there`,
        await page.$eval('#siloSbNav a.silo-sb-feature', (a) => a.classList.contains('silo-sb-feature--active')));
      await page.close();
    }

    console.log('\n── standard member without access: no Ask SILO, no empty section ──');
    const page = await suite.open('/v2/finance.html',
      tables({ role: 'user', department: 'marketing', membership: 'member', entity: 'acme-co' }),
      { cachedCompany: STANDARD, ready });
    const nav = await readNav(page);
    r.ok('no Ask SILO section', !nav.sections.includes('Ask SILO'), JSON.stringify(nav.sections));
    r.ok('no featured link', !nav.feature);
    r.ok('and not on Home', !nav.home.includes('/v2/silo-chat.html'), JSON.stringify(nav.home));
    await page.close();
  } catch (err) {
    r.ok('suite ran without throwing', false, err && err.stack);
  } finally {
    await suite.close();
  }
  const { fail } = r.summary();
  process.exit(fail ? 1 : 0);
})();
