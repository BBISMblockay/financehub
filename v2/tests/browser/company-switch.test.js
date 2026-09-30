/* What an open page does when the active company changes under it
 * (v2/silo-chrome.js, PR #830 review 2026-09-30).
 *
 * A page captures its company once, at load, and scopes every query and
 * write by it. When another tab switches company, repainting the sidebar
 * label is not enough, because the page body is still built for the old
 * company. So:
 *   1. An open page told of a switch (a real cross-tab storage event) is
 *      blocked behind a "Workspace changed" notice with a Reload button, and
 *      the stale page is made inert. It is not reloaded out from under
 *      someone mid-edit.
 *   2. A page that loads already mismatched is reloaded once. If it is still
 *      mismatched after that reload (the cache could not be corrected), it
 *      shows the notice rather than reloading again.
 *   3. A switch that lands while a check is already running is not dropped.
 *      The running check finishes, then one more runs and catches it.
 *   4. No false alarms: an unchanged company, and a deep link that had no
 *      cached company at all, show no notice and do not reload. The deep
 *      link adopts its first company, so a later switch is still caught.
 */
'use strict';

const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('company-switch');

const ALPHA = { id: 'co-alpha', title: 'Alpha Co' };
const BETA = { id: 'co-beta', title: 'Beta Co' };

const tables = () => ({
  factories: [], po_headers: [], po_lines: [], v_po_header_summary: [], products_master: [],
  product_tracker: [], launch_product_readiness: [], po_concept_links: [],
});

const MOUNTED = () => !!document.querySelector('#siloSbNav') && (window.__ENSURE_CALLS__ || 0) >= 1;
const notice = (page) => page.evaluate(() => {
  const n = document.querySelector('.silo-company-changed');
  return n ? { text: n.textContent.replace(/\s+/g, ' '), inert: document.getElementById('silo-app').hasAttribute('inert') } : null;
});
const loads = (page) => page.evaluate(() => Number(sessionStorage.getItem('test:loads') || 0));

(async () => {
  const suite = await startSuite();
  // Counts page loads per tab (sessionStorage is per tab and survives reload).
  await suite.context.addInitScript(() => {
    try { sessionStorage.setItem('test:loads', String(Number(sessionStorage.getItem('test:loads') || 0) + 1)); } catch (_) { /* ignore */ }
  });
  const settle = (page) => page.waitForTimeout(400);
  try {
    // 1. Cross-tab switch on an open page: notice, inert, no reload.
    {
      const page = await suite.open('/v2/po-builder.html', tables(), {
        ready: MOUNTED, cachedCompany: ALPHA, serverCompany: ALPHA,
      });
      await settle(page);
      R.ok('no notice while the company matches', (await notice(page)) === null);

      // The other tab switches: the server now answers Beta, and the picker
      // writes the broadcast key. A second real tab fires a real storage event.
      await page.evaluate((b) => { window.__FIXTURE_SERVER_COMPANY__ = b; }, BETA);
      const other = await suite.context.newPage();
      await other.goto(`${suite.base}/v2/beacon.css`);
      await other.evaluate(() => localStorage.setItem('silo:company:switched', String(Date.now())));
      await page.waitForFunction(() => !!document.querySelector('.silo-company-changed'), { timeout: 5000 }).catch(() => {});
      const n = await notice(page);

      R.ok('a switch in another tab blocks this page behind a notice', !!n, JSON.stringify(n));
      R.ok('the notice names the new and the old company', !!n && /Beta Co/.test(n.text) && /Alpha Co/.test(n.text), n && n.text);
      R.ok('the stale page underneath is inert', !!n && n.inert, JSON.stringify(n));
      R.ok('the open page is not reloaded out from under the user', (await loads(page)) === 1, `loads: ${await loads(page)}`);
      const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-silo-action'));
      R.ok('focus moves to the Reload button', focused === 'reload-for-company', focused);
      await other.close();
    }

    // 2. Loads mismatched: one reload, then the notice (never a loop).
    {
      const page = await suite.open('/v2/po-builder.html', tables(), {
        ready: () => !!document.querySelector('.silo-company-changed'),
        cachedCompany: ALPHA, serverCompany: BETA,
      });
      await settle(page);
      R.ok('a page loaded for the wrong company reloads exactly once', (await loads(page)) === 2, `loads: ${await loads(page)}`);
      R.ok('still mismatched after that, it shows the notice instead of reloading again', !!(await notice(page)));
    }

    // 3. A switch arriving mid-check is not dropped.
    {
      const page = await suite.open('/v2/po-builder.html', tables(), {
        ready: () => !!document.querySelector('#siloSbNav') && (window.__ENSURE_CALLS__ || 0) >= 1,
        cachedCompany: ALPHA, serverCompany: ALPHA, ensureGate: true,
      });
      // The first check is waiting on the server. The switch lands now: the
      // server changes, and the wake-up arrives while that check is in flight.
      await page.evaluate((b) => { window.__FIXTURE_SERVER_COMPANY__ = b; }, BETA);
      await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'silo:company:switched' })));
      const before = await page.evaluate(() => window.__ENSURE_CALLS__);
      await page.evaluate(() => window.__RELEASE_ENSURE__());
      await page.waitForFunction(() => !!document.querySelector('.silo-company-changed'), { timeout: 5000 }).catch(() => {});
      const after = await page.evaluate(() => window.__ENSURE_CALLS__);

      R.ok('the in-flight check is followed by one more', after > before, `before ${before}, after ${after}`);
      R.ok('and that one catches the switch', !!(await notice(page)));
    }

    // 4a. No false alarm: a wake-up with nothing changed.
    {
      const page = await suite.open('/v2/po-builder.html', tables(), {
        ready: MOUNTED, cachedCompany: ALPHA, serverCompany: ALPHA,
      });
      await settle(page);
      await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'silo:company:switched' })));
      await settle(page);
      R.ok('an unchanged company shows no notice', (await notice(page)) === null);
      R.ok('and does not reload', (await loads(page)) === 1, `loads: ${await loads(page)}`);
    }

    // 4b. A deep link with nothing cached: resolving a company is the normal
    // self-heal, not a switch.
    {
      const page = await suite.open('/v2/po-builder.html', tables(), {
        ready: MOUNTED, cachedCompany: null, serverCompany: BETA,
      });
      await settle(page);
      R.ok('a page with no cached company shows no notice', (await notice(page)) === null);
      R.ok('and does not reload', (await loads(page)) === 1, `loads: ${await loads(page)}`);

      // It adopted Beta as its company, so a later switch is still caught.
      await page.evaluate((a) => { window.__FIXTURE_SERVER_COMPANY__ = a; }, ALPHA);
      await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'silo:company:switched' })));
      await page.waitForFunction(() => !!document.querySelector('.silo-company-changed'), { timeout: 5000 }).catch(() => {});
      const n = await notice(page);
      R.ok('a later switch on that deep-linked page is still caught', !!n && /Alpha Co/.test(n.text) && /Beta Co/.test(n.text), n && n.text);
    }
  } finally {
    await suite.close();
  }
  process.exit(R.summary().fail ? 1 : 0);
})();
