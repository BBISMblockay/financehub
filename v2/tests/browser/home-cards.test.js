/* Home (/v2/finance.html): a STANDARD workspace's cards are its sidebar.
 *
 * Home kept its own hand-written link list, and for standard companies it
 * drifted from the sidebar: no Marketing at all (those links lived only in a
 * Baseballism-only card), no Ask SILO, Dashboards, Setup or Accounting, and
 * Workspace Settings offered to members the sidebar hides it from. Home now
 * reads the rendered sidebar for standard workspaces (v2/home-nav.js).
 *
 * The other half matters as much: a GRANDFATHERED (Baseballism) workspace
 * keeps its own static cards exactly as before.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('home-cards');

const STANDARD = { id: 'acme-co', title: 'Acme Co', entity_key: 'acme' };
const GRANDFATHERED = { id: 'test-company', title: 'Baseballism', entity_key: 'baseballism' };

function tables({ role, department, membership }) {
  return {
    profiles: [{ id: 'test-user', role, department, email: 'test@baseballism.com' }],
    entity_memberships: [{ user_id: 'test-user', entity_id: 'acme-co', role: membership }],
  };
}

const ready = () => !!document.querySelector('#siloSbNav .silo-sb-link');

async function readHome(page) {
  await page.waitForTimeout(900); // department, grants and role repaint the sidebar
  return page.evaluate(() => {
    const sidebar = [...document.querySelectorAll('#siloSbNav a.silo-sb-link, #siloSbNav a.silo-sb-feature')]
      .map((a) => a.getAttribute('href'))
      .filter((h) => h !== '/v2/finance.html');
    const cards = [...document.querySelectorAll('#finSections .fin-card')].map((c) => ({
      title: c.querySelector('h2')?.textContent.trim(),
      links: [...c.querySelectorAll('a.fin-link')].map((a) => a.getAttribute('href')),
      labels: [...c.querySelectorAll('a.fin-link')].map((a) => a.textContent.trim()),
    }));
    return {
      title: document.getElementById('finLandingTitle').textContent.trim(),
      sidebar,
      home: cards.flatMap((c) => c.links),
      cards,
    };
  });
}

(async () => {
  const suite = await startSuite({ viewport: { width: 1400, height: 900 } });
  try {
    console.log('\n── standard founder: Home matches the sidebar ──');
    let page = await suite.open('/v2/finance.html',
      tables({ role: 'owner', department: 'exec', membership: 'owner_admin' }),
      { cachedCompany: STANDARD, ready });
    let home = await readHome(page);
    r.ok('the heading is the company name', home.title === 'Acme Co', home.title);
    r.ok('Home offers exactly the sidebar links, in the same order',
      JSON.stringify(home.home) === JSON.stringify(home.sidebar),
      `home=${JSON.stringify(home.home)}\nsidebar=${JSON.stringify(home.sidebar)}`);
    const titles = home.cards.map((c) => c.title);
    r.ok('cards follow the standard sections', titles.includes('Marketing') && titles.includes('Purchasing')
      && titles.includes('Insights'), JSON.stringify(titles));
    r.ok('Marketing is reachable from Home', home.home.includes('/v2/marketing-overview.html'));
    r.ok('Setup and Accounting are on Home for the founder',
      home.home.includes('/v2/setup-checklist.html') && home.home.includes('/v2/transactions.html'));
    r.ok('no Baseballism-only link leaks onto a standard Home',
      !home.home.some((h) => /baseballismwholesale|bi-sales-overview|reviews\.html|live-schedule|wow-report|silo-attribution/.test(h)),
      JSON.stringify(home.home));
    r.ok('Home does not link to itself', !home.home.includes('/v2/finance.html'));
    const insights = home.cards.find((c) => c.title === 'Insights');
    r.ok('On Deck leads Insights for a finance/exec founder',
      !!insights && insights.links[0] === '/v2/on-deck.html', JSON.stringify(insights));
    const products = home.cards.find((c) => c.title === 'Product & inventory');
    r.ok('Product Studio sits in Product & inventory',
      !!products && products.links.includes('/v3/product-workflow.html'), JSON.stringify(products));
    await page.close();

    console.log('\n── standard member: Home narrows with the sidebar ──');
    page = await suite.open('/v2/finance.html',
      tables({ role: 'user', department: 'marketing', membership: 'member' }),
      { cachedCompany: STANDARD, ready });
    home = await readHome(page);
    r.ok('a member\'s Home still equals their sidebar',
      JSON.stringify(home.home) === JSON.stringify(home.sidebar),
      `home=${JSON.stringify(home.home)}\nsidebar=${JSON.stringify(home.sidebar)}`);
    r.ok('Workspace Settings is not offered to a member',
      !home.home.includes('/v2/settings-company.html'), JSON.stringify(home.home));
    r.ok('nor finance-only Request Manager',
      !home.home.includes('/v2/request_manager.html'), JSON.stringify(home.home));
    r.ok('nor On Deck, which follows the finance gate',
      !home.home.includes('/v2/on-deck.html'), JSON.stringify(home.home));
    r.ok('Product Studio is offered to a member (writes are refused server-side)',
      home.home.includes('/v3/product-workflow.html'), JSON.stringify(home.home));
    await page.close();

    console.log('\n── grandfathered workspace: static cards unchanged ──');
    page = await suite.open('/v2/finance.html',
      tables({ role: 'owner', department: 'exec', membership: 'owner_admin' }),
      { cachedCompany: GRANDFATHERED, ready });
    home = await readHome(page);
    r.ok('the grandfathered heading is unchanged', home.title === 'SILO Home', home.title);
    r.ok('BBISM Receivables is still on Baseballism Home',
      home.home.includes('/v2/baseballismwholesale.html'), JSON.stringify(home.home));
    r.ok('the sales reports card is still there',
      home.home.includes('/v2/bi-sales-overview.html'), JSON.stringify(home.home));
    r.ok('Baseballism\'s sidebar has no On Deck or Product Studio for now',
      !home.sidebar.includes('/v2/on-deck.html') && !home.sidebar.includes('/v3/product-workflow.html'),
      JSON.stringify(home.sidebar));
    r.ok('and the cards are the static ones, not the sidebar mirror',
      !(await page.evaluate(() => !!document.querySelector('[data-home-section]'))));
    await page.close();
  } catch (err) {
    r.ok('suite ran without throwing', false, err && err.stack);
  } finally {
    await suite.close();
  }
  const { fail } = r.summary();
  process.exit(fail ? 1 : 0);
})();
