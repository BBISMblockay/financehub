/* End-to-end coverage of the three reported bugs, driving the REAL
 * v2/inventory.html in Chromium against the REAL fixture rows from
 * inventory_workboard_v.
 *
 * The unit suites prove the rules. This one proves the page is wired to them:
 * that the search box survives Clear lenses in the actual DOM, that the pin
 * really does drop out of the ≤7 day lens on screen, and that the two Sonic
 * sizes read "Out of stock" rather than "OK".
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');
const F = require('../fixtures/sonic-rows');

/* The fake client serves raw view rows, exactly as PostgREST would. */
function viewRows() {
  const raw = F.raw;
  return [raw.PIN, raw.TEE_YM, raw.TEE_YS, raw.TEE_YL, raw.SWEATS_M,
          raw.STOLEN_YS, raw.DEAD_STOCK, raw.STALE_STOCK].map((v, i) =>
    Object.assign({ id: i + 1, retail_price: 12, shop_domain: 'x.myshopify.com' }, v));
}

const r = createReporter('inventory-page');

(async () => {
  const suite = await startSuite();
  let page;
  try {
    page = await suite.open(viewRows(), []);

    /* ---------------------------------------------------- load + wiring --- */
    console.log('\n── the page loads and renders ──');
    const rowCount = await page.locator('#tbody tr').count();
    r.ok('the table renders rows', rowCount > 0, `got ${rowCount} rows`);
    r.ok('the default view level is Product',
      await page.locator('#btnModeProduct').getAttribute('class') === 'active',
      await page.locator('#modeLine').textContent());

    const queries = await page.evaluate(() => window.__QUERIES__.map((q) => ({ t: q.table, c: q.columns, o: q.order })));
    const inv = queries.find((q) => q.t === 'inventory_workboard_v');
    r.ok('the inventory fetch names its columns', inv && inv.c && inv.c !== '*', JSON.stringify(inv && inv.c));
    r.ok('it requests velocity_matched', !!(inv && inv.c.includes('velocity_matched')));
    r.ok('it requests days_oos', !!(inv && inv.c.includes('days_oos')));
    r.ok('it is ordered, so paging cannot repeat or skip rows', !!(inv && inv.o && inv.o.col === 'id'));
    r.ok('it never asks for row_hash', !(inv && inv.c.includes('row_hash')));
    r.ok('the whole set comes back in ONE request',
      queries.filter((q) => q.t === 'inventory_workboard_v').length === 1,
      `${queries.filter((q) => q.t === 'inventory_workboard_v').length} requests`);

    /* --------------------------------------------------------- BUG 3 ------ */
    console.log('\n── bug 3: zero stock with sales must not read as OK ──');
    await page.locator('#btnModeSku').click();
    await page.waitForTimeout(150);

    const ymRow = await page.evaluate(() => {
      const tr = [...document.querySelectorAll('#tbody tr')]
        .find((row) => row.querySelector('[data-col="sku"]')?.textContent.includes('SC-YM-SonicSquad-Y'));
      if (!tr) return null;
      return {
        signal: tr.querySelector('[data-col="inventory_signal"]')?.textContent.trim(),
        cover: tr.querySelector('[data-col="days_oos"]')?.textContent.trim(),
        onHand: tr.querySelector('[data-col="avail_qty"]')?.textContent.trim(),
        sold30: tr.querySelector('[data-col="sold_30"]')?.textContent.trim(),
      };
    });
    r.ok('the YM row is on screen', !!ymRow, JSON.stringify(ymRow));
    r.ok('its inventory signal is Out of stock, not OK', ymRow && ymRow.signal === 'Out of stock', JSON.stringify(ymRow));
    r.ok('its days cover is 0, not blank', ymRow && ymRow.cover === '0', JSON.stringify(ymRow));
    r.ok('its recent sales are still shown', ymRow && ymRow.sold30 === '450', JSON.stringify(ymRow));
    r.ok('no row anywhere in the table reads OK while out of stock',
      await page.evaluate(() => [...document.querySelectorAll('#tbody tr')].every((tr) => {
        const oh = tr.querySelector('[data-col="avail_qty"]')?.textContent.trim();
        const sig = tr.querySelector('[data-col="inventory_signal"]')?.textContent.trim();
        return !(oh === '0' && sig === 'OK');
      })));

    console.log('\n── bug 3: the detail view separates status from transfer ──');
    await page.locator('#btnModeProduct').click();
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('#tbody button[data-details]')]
        .find((b) => b.textContent.includes('Team Sonic Youth T-Shirt'));
      if (btn) btn.click();
    });
    await page.waitForSelector('#modal:not(.hidden)', { timeout: 5000 });

    const modal = await page.evaluate(() => ({
      title: document.getElementById('modalTitle').textContent.trim(),
      headers: [...document.querySelectorAll('#modalBody .dl-table thead th')].map((th) => th.textContent.trim()),
      body: document.getElementById('modalBody').textContent,
    }));
    r.ok('the modal is titled "Product Inventory"', modal.title === 'Product Inventory', modal.title);
    r.ok('there is an Inventory column', modal.headers.includes('Inventory'), JSON.stringify(modal.headers));
    r.ok('there is a separate Transfer column', modal.headers.includes('Transfer'), JSON.stringify(modal.headers));
    r.ok('the transfer column explains what a dash means',
      modal.body.includes('not a statement that stock is healthy'));

    const cells = await page.evaluate(() => {
      // The Locations table is the one with a Transfer column.
      const tables = [...document.querySelectorAll('#modalBody .dl-table')];
      const t = tables.find((x) => [...x.querySelectorAll('thead th')].some((th) => th.textContent.trim() === 'Transfer'));
      if (!t) return null;
      const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
      const iSku = heads.indexOf('SKU');
      const iInv = heads.indexOf('Inventory');
      const iXfr = heads.indexOf('Transfer');
      const iCov = heads.indexOf('Days Cover');
      return [...t.querySelectorAll('tbody tr')].map((tr) => {
        const td = tr.querySelectorAll('td');
        return {
          sku: td[iSku]?.textContent.trim(),
          inv: td[iInv]?.textContent.trim(),
          xfr: td[iXfr]?.textContent.trim(),
          cover: td[iCov]?.textContent.trim(),
        };
      });
    });
    r.ok('the locations table rendered', Array.isArray(cells) && cells.length > 0);
    const ym = cells && cells.find((c) => c.sku === 'SC-YM-SonicSquad-Y');
    const ys = cells && cells.find((c) => c.sku === 'SC-YS-SonicSquad-Y');
    [['YM', ym], ['YS', ys]].forEach(([n, c]) => {
      r.ok(`${n}: inventory column says Out of stock`, c && c.inv === 'Out of stock', JSON.stringify(c));
      r.ok(`${n}: transfer column says nothing, not OK`, c && c.xfr === '—', JSON.stringify(c));
      r.ok(`${n}: days cover is 0, not blank`, c && c.cover === '0', JSON.stringify(c));
    });
    r.ok('no transfer cell anywhere says OK',
      cells && cells.every((c) => !/^ok$/i.test(c.xfr || '')), JSON.stringify(cells));

    await page.locator('#btnCloseModal').click();

    /* --------------------------------------------------- BUG 1 + BUG 2 ---- */
    console.log('\n── bugs 1 and 2: the reported sequence, end to end ──');
    await page.locator('#btnModeSku').click();
    await page.waitForTimeout(120);

    // 1. Search "Sonic".
    await page.fill('#txtSearch', 'Sonic');
    await page.press('#txtSearch', 'Enter');
    await page.waitForTimeout(200);
    const afterSearch = await page.locator('#tbody tr').count();
    r.ok('the search narrows the table', afterSearch > 0 && afterSearch < 8, `${afterSearch} rows`);

    // 2. Apply the ≤ 7 days lens (it lives in the More filters drawer).
    await page.locator('#btnMoreFilters').click();
    await page.waitForTimeout(150);
    await page.locator('button[data-lens="cover7"]').click();
    await page.waitForTimeout(200);

    const lensRows = await page.evaluate(() => [...document.querySelectorAll('#tbody tr')].map((tr) => ({
      sku: tr.querySelector('[data-col="sku"]')?.textContent.trim(),
      onHand: tr.querySelector('[data-col="avail_qty"]')?.textContent.trim(),
      cover: tr.querySelector('[data-col="days_oos"]')?.textContent.trim(),
    })));
    r.ok('BUG 2: the 1,002-unit pin is NOT in the ≤7 day lens',
      !lensRows.some((x) => x.sku === 'SC-OESonic(Sept26)-Pin'), JSON.stringify(lensRows));
    r.ok('BUG 2: no row in the lens has an unmeasurable cover',
      lensRows.every((x) => /^-?\d+$/.test(x.cover || '')), JSON.stringify(lensRows));
    r.ok('the lens still finds the genuinely urgent rows',
      lensRows.some((x) => x.sku === 'SC-YM-SonicSquad-Y'), JSON.stringify(lensRows));

    // 3. Clear lenses.
    await page.locator('#btnClearLenses').click();
    await page.waitForTimeout(200);

    const afterClear = await page.evaluate(() => ({
      search: document.getElementById('txtSearch').value,
      maxDays: document.getElementById('numMaxDays').value,
      rows: document.querySelectorAll('#tbody tr').length,
      pressed: [...document.querySelectorAll('button[data-lens]')].filter((b) => b.getAttribute('aria-pressed') === 'true').length,
    }));
    r.ok('BUG 1: the search term is still "Sonic"', afterClear.search === 'Sonic', JSON.stringify(afterClear));
    r.ok('BUG 1: the full product list did NOT come back',
      afterClear.rows === afterSearch, `${afterClear.rows} rows, expected ${afterSearch}`);
    r.ok('the lens condition WAS cleared', afterClear.maxDays === '', JSON.stringify(afterClear));
    r.ok('no lens button is left pressed', afterClear.pressed === 0, JSON.stringify(afterClear));

    // 4. Reset all is a separate control that does clear everything.
    await page.locator('#btnResetAll').click();
    await page.waitForTimeout(200);
    const afterReset = await page.evaluate(() => ({
      search: document.getElementById('txtSearch').value,
      rows: document.querySelectorAll('#tbody tr').length,
    }));
    r.ok('Reset all clears the search', afterReset.search === '', JSON.stringify(afterReset));
    r.ok('Reset all brings the full list back', afterReset.rows > afterSearch, JSON.stringify(afterReset));

    /* ------------------------------------------------------ chips + count -- */
    console.log('\n── active filter chips ──');
    await page.fill('#txtSearch', 'Sonic');
    await page.press('#txtSearch', 'Enter');
    await page.waitForTimeout(200);
    const chips = await page.evaluate(() => ({
      hidden: document.getElementById('chipBar').hidden,
      labels: [...document.querySelectorAll('#chipBar .filter-chip .chip-text')].map((x) => x.textContent.trim()),
      count: document.querySelector('#chipBar .chip-count')?.textContent.trim(),
    }));
    r.ok('the chip bar is visible', chips.hidden === false);
    r.ok('the search shows as a removable chip',
      chips.labels.some((l) => l.includes('Sonic')), JSON.stringify(chips.labels));
    r.ok('a filtered result count is shown', /\d+ of \d+ rows/.test(chips.count || ''), chips.count);

    await page.evaluate(() => document.querySelector('#chipBar button[data-chip-clear="q"]').click());
    await page.waitForTimeout(200);
    r.ok('removing the chip clears that filter',
      await page.evaluate(() => document.getElementById('txtSearch').value) === '');

    /* --------------------------------------------- preserved functionality - */
    console.log('\n── everything that had to keep working ──');
    for (const [id, label] of [['btnModeProduct', 'Product'], ['btnModeSku', 'SKU'],
                               ['btnModeType', 'Type'], ['btnModeLocation', 'Location']]) {
      await page.locator('#' + id).click();
      await page.waitForTimeout(150);
      const n = await page.locator('#tbody tr').count();
      r.ok(`the ${label} view level renders rows`, n > 0, `${n} rows`);
    }

    await page.locator('#btnModeProduct').click();
    await page.waitForTimeout(150);
    await page.evaluate(() => document.querySelector('#tbody input[data-rowchk]').click());
    await page.waitForTimeout(100);
    r.ok('selecting a row updates the SELECTED KPI',
      await page.locator('#kSelected').textContent() === '1');

    const dl = page.waitForEvent('download', { timeout: 10000 });
    await page.locator('#btnExportSelected').click();
    const file = await dl;
    r.ok('exporting the selection produces a CSV', /\.csv$/.test(file.suggestedFilename()), file.suggestedFilename());

    await page.locator('#btnClearSelection').click();
    await page.waitForTimeout(100);
    r.ok('clearing the selection resets the KPI',
      await page.locator('#kSelected').textContent() === '0');

    console.log('\n── the columns picker ──');
    await page.locator('#btnColumns').click();
    await page.waitForSelector('#modal:not(.hidden)');
    const picker = await page.evaluate(() => ({
      entries: [...document.querySelectorAll('[data-col-toggle]')].map((i) => ({
        key: i.getAttribute('data-col-toggle'),
        label: i.parentElement.querySelector('span').textContent.trim(),
      })),
      headers: [...document.querySelectorAll('#theadRow th')].map((th) => ({
        key: th.getAttribute('data-col'), text: th.textContent.trim(),
      })),
    }));
    r.ok('_select is not offered in the picker',
      !picker.entries.some((e) => e.key === '_select'), JSON.stringify(picker.entries.slice(0, 3)));
    r.ok('_details is not offered either',
      !picker.entries.some((e) => e.key === '_details'));
    r.ok('no picker entry has a blank label',
      picker.entries.every((e) => e.label.length > 0), JSON.stringify(picker.entries.filter((e) => !e.label.length)));
    const mismatches = picker.entries
      .map((e) => ({ e, h: picker.headers.find((h) => h.key === e.key) }))
      .filter((x) => x.h && x.h.text !== x.e.label);
    r.ok('every visible column\'s picker label matches its header',
      mismatches.length === 0, JSON.stringify(mismatches));
    await page.locator('#btnCloseModal').click();

    console.log('\n── KPIs read the whole filtered set, not the page ──');
    await page.locator('#btnModeLocation').click();
    await page.waitForTimeout(150);
    const kpis = await page.evaluate(() => ({
      rows: document.getElementById('kRows').textContent,
      units: document.getElementById('kUnits').textContent,
      unknown: document.getElementById('kUnknown').textContent,
      avg: document.getElementById('kAvgDays').textContent,
    }));
    r.ok('rows counts all eight fixtures', kpis.rows === '8', JSON.stringify(kpis));
    // 1002 + 0 + 0 + 69 + 49 + (-1) + 240 + 240 = 1,599
    r.ok('units sums every row, including the 1,002-unit pin',
      kpis.units === '1,599', JSON.stringify(kpis));
    r.ok('the unknown-demand KPI counts the pin', kpis.unknown === '1', JSON.stringify(kpis));
    // Measured rows only: 0 + 0 + 7.5 + 98 + (-0.1) = 105.4 over 5 = 21.1.
    // Folding the three unmeasurable rows in as zero would give 13.2 — which
    // is the understatement this KPI used to publish.
    r.ok('average cover is measured over measurable rows only',
      kpis.avg === '21.1', kpis.avg);

    console.log('\n── narrow screen ──');
    await page.setViewportSize({ width: 480, height: 900 });
    await page.waitForTimeout(200);
    const narrow = await page.evaluate(() => ({
      bodyScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      toolbar: !!document.querySelector('.inv-toolbar'),
      search: document.getElementById('txtSearch').getBoundingClientRect().width > 0,
    }));
    r.ok('the toolbar is still present at 480px', narrow.toolbar && narrow.search, JSON.stringify(narrow));
    r.ok('the page body does not scroll horizontally', !narrow.bodyScroll, JSON.stringify(narrow));

  } catch (err) {
    r.ok('suite ran without throwing', false, err && err.stack ? err.stack : String(err));
  } finally {
    await suite.close();
  }

  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})();
