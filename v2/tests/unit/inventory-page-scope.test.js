/* The inventory page is for stock visibility. Buying recommendations and PO
 * drafting belong to the purchasing pages.
 *
 * This suite reads v2/inventory.html as text and asserts the purchasing
 * surfaces are gone and stay gone. It is a coarse check on purpose: the point
 * is that someone re-adding a SUGGEST PO button or a draft drawer has to
 * delete a test that says why it was removed, rather than quietly reopening
 * the boundary.
 *
 * It also guards the things that had to SURVIVE the removal — tagging,
 * selection, exports and all four view levels — because the risk in a
 * deletion of this size is taking a neighbour with it. */
'use strict';

const fs = require('fs');
const path = require('path');
const { createReporter } = require('../lib/assert');
const { REPO_ROOT } = require('../lib/load');

const r = createReporter('inventory-page-scope');
const PAGE = path.join(REPO_ROOT, 'v2', 'inventory.html');
const raw = fs.readFileSync(PAGE, 'utf8');

/* Strip comments before the "is it gone" checks. The comments explaining WHY
 * a purchasing surface was removed necessarily name it, and a guard that
 * fires on its own rationale is a guard nobody can keep. Code and markup are
 * what these assertions are about. */
const html = raw
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/* Report a hit by line number instead of printing the whole 130 KB file,
 * which is what the shared not() helper would do. */
function absent(what, needle) {
  r.test(`${what} is not on the page`, () => {
    const idx = html.indexOf(needle);
    if (idx === -1) return;
    const line = html.slice(0, idx).split('\n').length;
    const src = raw.split('\n')[line - 1] || '';
    throw new Error(`still present at line ~${line}: ${src.trim().slice(0, 120)}`);
  });
}
function present(what, needle) {
  r.test(`${what} is present`, () => {
    if (html.indexOf(needle) === -1) throw new Error(`missing: ${JSON.stringify(needle)}`);
  });
}

console.log('\n── purchasing surfaces are gone ──');
const GONE = [
  ['btnSuggestPO', 'the Suggest PO button'],
  ['btnAddSelectedToDraft', 'the Add to Draft button'],
  ['btnDraftDrawerToggle', 'the PO Draft toggle'],
  ['draftDrawer', 'the PO draft drawer'],
  ['silo_po_draft', 'the PO draft localStorage key'],
  ['kSuggested', 'the Suggested quantity KPI'],
  ['category_buy', 'the category-buy column'],
  ['mix_shortage', 'the mix-shortage column'],
  ['suggested_po', 'the suggested-quantity column'],
  ['suggestPOQty', 'the suggestion calculator'],
  ['getStrategyInputs', 'the planning-engine inputs'],
  ['btnStratRepl', 'the Replenish strategy button'],
  ['btnStratGrowth', 'the Growth strategy button'],
  ['btnStratHybrid', 'the Hybrid strategy button'],
  ['numTargetCover', 'the target-cover planning input'],
  ['numGrowthPct', 'the growth-uplift planning input'],
  ['numSeedAvgDay', 'the seeded-velocity planning input'],
  ['numMinReorder', 'the minimum-reorder planning input'],
  ['numSafetyDays', 'the safety-days planning input'],
  ['BUY NOW', 'the BUY NOW recommendation'],
  ['Mix Δ', 'the Mix delta label'],
  ['Cat buy', 'the category-buy short label'],
];
GONE.forEach(([needle, what]) => absent(what, needle));

absent('a sort option ranking rows by buying priority', 'Buy / Mix Priority');
absent('the suggested-quantity sort key', 'suggested_desc');
r.test('the default sort is an inventory signal, not a buy list', () => {
  // The sort list is built at runtime from the shared module, so this is
  // where the default lives.
  const { loadSignals } = require('../lib/load');
  const S = loadSignals();
  r.eq(S.emptyState().sort, 'signal');
  r.eq(S.SORTS[0].value, 'signal');
  r.has(S.SORTS[0].label, 'Inventory signal');
  r.eq(S.SORTS.filter((o) => /buy|mix|suggest/i.test(o.label)), []);
});

console.log('\n── nothing on this page can write a PO or mutate a source record ──');
r.test('the page writes to product_tags and nothing else', () => {
  const writes = [...html.matchAll(/\.from\("([a-z_]+)"\)\s*\.(insert|update|upsert|delete)/g)]
    .map((m) => `${m[1]}.${m[2]}`);
  r.eq([...new Set(writes)].sort(), ['product_tags.insert', 'product_tags.update']);
});
r.test('no purchasing table is referenced at all', () => {
  ['po_headers', 'po_lines', 'po_costing', 'product_concepts'].forEach((t) => r.not(html, t));
});
r.test('the only table read for inventory is the workboard view', () => {
  r.has(html, 'inventory_workboard_v');
});

console.log('\n── what had to survive the removal ──');
const KEPT = [
  ['btnTagSelected', 'tagging selected rows'],
  ['btnApplyTag', 'the tag apply button'],
  ['btnClearTags', 'the tag clear button'],
  ['selDriver', 'the tag picker'],
  ['selIndicatorGroup', 'the indicator picker'],
  ['btnExportFiltered', 'exporting the filtered set'],
  ['btnExportSelected', 'exporting the selection'],
  ['btnClearSelection', 'clearing the selection'],
  ['btnColumns', 'the column picker'],
  ['btnModeProduct', 'the Product view level'],
  ['btnModeSku', 'the SKU view level'],
  ['btnModeType', 'the Type view level'],
  ['btnModeLocation', 'the Location view level'],
  ['btnPrev', 'paging back'],
  ['btnNext', 'paging forward'],
];
KEPT.forEach(([needle, what]) => present(what, needle));

console.log('\n── the new filter surface is wired ──');
[
  ['txtSearch', 'the search box'],
  ['selLocation', 'the location filter'],
  ['selProductTypeFilter', 'the product type filter'],
  ['btnMoreFilters', 'the More filters button'],
  ['chipBar', 'the active-filter chip bar'],
  ['btnClearLenses', 'Clear lenses'],
  ['btnResetAll', 'Reset all'],
  ['selSignalFilter', 'the inventory signal filter'],
].forEach(([needle, what]) => present(what, needle));
r.test('Clear lenses and Reset all are different controls', () => {
  r.truthy(html.indexOf('btnClearLenses') !== html.indexOf('btnResetAll'),
    'they must not be the same element');
});

console.log('\n── labelling ──');
absent('the old "Product Planning Details" title', 'Product Planning Details');
present('the "Product Inventory" title', 'openModal("Product Inventory"');
present('the retail-value-is-not-cost disclaimer', 'This is NOT inventory cost');
absent('the old planning mode line', 'Product Type Planning');
present('the plain view label', 'View: Product');
r.test('the shared signals module is loaded before the page script', () => {
  const mod = html.indexOf('inventory-signals.js');
  const use = html.indexOf('window.SiloInventorySignals');
  r.truthy(mod !== -1 && use !== -1 && mod < use, 'module must load first');
});

console.log('\n── column visibility is per view level ──');
r.test('the visibility map is keyed by level, not by column name alone', () => {
  // A flat map resolved a key defined in several sets to whichever set was
  // listed last: `variant` defaults on at SKU and off at Location, so the SKU
  // view silently lost it. Guarded because the failure is invisible — the
  // column just is not there.
  r.has(html, 'function visibleMap()');
  r.has(html, 'VISIBLE[MODE][key]');
  r.not(html, 'VISIBLE[c.key]');
});
r.test('each column set defines its own defaults independently', () => {
  const sets = {};
  ['COLS_TYPE', 'COLS_PRODUCT', 'COLS_SKU', 'COLS_LOCATION'].forEach((name) => {
    const start = html.indexOf('const ' + name + ' = [');
    if (start === -1) throw new Error(name + ' not found');
    const body = html.slice(start, html.indexOf('\n    ];', start));
    sets[name] = Object.fromEntries(
      [...body.matchAll(/key: "([a-z0-9_]+)"[^}]*default: (true|false)/g)]
        .map((m) => [m[1], m[2] === 'true']));
  });
  // The collision that motivated the change, asserted as still a collision —
  // so the per-level map is doing real work rather than being decoration.
  r.eq(sets.COLS_SKU.variant, true);
  r.eq(sets.COLS_LOCATION.variant, false);
  r.eq(sets.COLS_PRODUCT.locations_count, true);
  r.eq(sets.COLS_SKU.locations_count, false);
});
r.test('the stored preference key changed with the stored shape', () => {
  // A stale flat preference must not merge as "everything off".
  r.has(html, 'silo_inv_cols_v12_per_level');
});
r.test('the compact default set is the six the page is for', () => {
  const start = html.indexOf('const COLS_PRODUCT = [');
  const body = html.slice(start, html.indexOf('\n    ];', start));
  const on = [...body.matchAll(/key: "([a-z0-9_]+)"[^}]*default: true/g)]
    .map((m) => m[1])
    .filter((k) => k[0] !== '_');   // _select / _details are furniture
  r.eq(on.sort(), ['avail_qty', 'days_oos', 'inventory_signal', 'locations_count',
                   'product', 'product_type', 'sold_30', 'variant_count']);
});

console.log('\n── the table is sized from the columns actually shown ──');
r.test('no hardcoded per-mode table width', () => {
  // A constant sized for the old wide column sets is what pushed the
  // Inventory column off-screen once the More filters drawer opened.
  r.not(html, 'TABLE_MIN_W');
  r.has(html, 'function setTableWidth()');
});

console.log('\n── performance guards ──');
present('an explicit inventory column list', 'INVENTORY_COLUMNS');
absent('a select("*") inventory fetch', '.select("*")');
present('velocity_matched in the requested columns — the fixes depend on it',
  '"days_oos", "velocity_basis", "velocity_matched", "velocity_source"');

r.test('the inventory fetch is NOT ordered, and pages stay at 10,000', () => {
  // Regression guard, and the reason is the opposite of what it looks like.
  // Ordering this view forces a sort of every joined row before the first one
  // can be returned (external merge, ~23MB to disk); measured cold under the
  // real 8s `authenticated` statement_timeout, `order by id limit 10000`
  // times out on its own, where the same page unordered is 474ms. One
  // all-rows request instead of seven pages timed out for the same reason.
  // If you are here to "fix" the missing ORDER BY: it is load-bearing.
  const start = html.indexOf('async function loadInventoryCurrentPaginated()');
  if (start === -1) throw new Error('loadInventoryCurrentPaginated() not found');
  const body = html.slice(start, html.indexOf('\n    }', start));
  r.not(body, '.order(', 'the inventory fetch must not be ordered');
  r.has(html, 'const INVENTORY_PAGE_SIZE = 10000;');
});
r.test('id is not requested, since nothing reads it any more', () => {
  r.not(html, '"id", "location_tag"');
});
absent('the retained raw Supabase row', '_raw_supabase');
absent('the per-paint rollup recompute', 'refreshAllRollupSuggestions');

r.test('KPIs are computed from the whole filtered set, not the painted page', () => {
  const start = html.indexOf('function updateKPIs()');
  if (start === -1) throw new Error('updateKPIs() not found');
  const body = html.slice(start, html.indexOf('\n    }', start));
  r.has(body, 'for (const r of VIEW)', 'must iterate the full filtered set');
  r.not(body, 'PAGE_SIZE', 'must not reference the page window');
  r.not(body, '.slice(', 'must not compute over a slice');
});

const out = r.summary();
process.exit(out.fail ? 1 : 0);
