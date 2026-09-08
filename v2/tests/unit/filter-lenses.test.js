/* BUG 1 — search "Sonic", apply "≤7 days", click "Clear lenses"; the search
 * box was emptied and the full product list came back.
 *
 * Root cause: the "clear" chip was wired straight to resetFilters(), which
 * blanked the search box, the location scope, the product type, all three tag
 * selects and the sort. "Clear lenses" and "Reset everything" were the same
 * function under two names.
 *
 * The rule: a lens owns exactly one named field. Clearing lenses reverts those
 * fields and nothing else. Reset all stays available as its own action.
 *
 * This file also covers filter persistence across view-level switches, since
 * that is the same question — what survives an action that is not "clear this
 * particular thing". */
'use strict';

const { createReporter } = require('../lib/assert');
const { loadSignals } = require('../lib/load');
const F = require('../fixtures/sonic-rows');

const S = loadSignals();
const r = createReporter('filter-lenses');

/** The exact sequence from the bug report. */
function sonicThenSevenDays() {
  let st = S.emptyState();
  st.q = 'Sonic';
  st.location = 'online';
  st.productType = 'T-Shirt';
  return S.toggleLens(st, 'cover7');
}

console.log('\n── the reported sequence ──');
const applied = sonicThenSevenDays();
r.test('the lens did apply', () => {
  r.eq(applied.maxCoverDays, 7);
  r.eq(applied.lenses, ['cover7']);
});

const cleared = S.clearLenses(applied);
r.test('Clear lenses PRESERVES the search term', () => { r.eq(cleared.q, 'Sonic'); });
r.test('Clear lenses PRESERVES the location scope', () => { r.eq(cleared.location, 'online'); });
r.test('Clear lenses PRESERVES the product type scope', () => { r.eq(cleared.productType, 'T-Shirt'); });
r.test('Clear lenses DOES clear the lens condition', () => { r.eq(cleared.maxCoverDays, null); });
r.test('Clear lenses empties the active lens list', () => { r.eq(cleared.lenses, []); });

console.log('\n── Reset all is still a separate, complete action ──');
const reset = S.resetAll(applied);
r.test('Reset all clears the search', () => { r.eq(reset.q, ''); });
r.test('Reset all clears the scopes', () => {
  r.eq(reset.location, '__ALL__');
  r.eq(reset.productType, '__ALL__');
});
r.test('Reset all clears the lens condition', () => { r.eq(reset.maxCoverDays, null); });
r.test('Reset all does NOT change the view level you are reading', () => {
  const st = Object.assign(S.emptyState(), { level: 'sku', q: 'Sonic' });
  r.eq(S.resetAll(st).level, 'sku');
});

console.log('\n── lens ownership ──');
r.test('a lens does not clear a threshold the user typed by hand', () => {
  let st = S.emptyState();
  st.minSold30 = 5;            // typed, not from a lens
  st = S.toggleLens(st, 'cover7');
  r.eq(S.clearLenses(st).minSold30, 5);
});
r.test('a value typed OVER a lens is the user\'s, and survives Clear lenses', () => {
  let st = S.toggleLens(S.emptyState(), 'cover7');   // maxCoverDays = 7
  st.maxCoverDays = 21;                              // user overrides it
  r.eq(S.clearLenses(st).maxCoverDays, 21);
});
r.test('two lenses on the same field replace each other rather than stacking', () => {
  let st = S.toggleLens(S.emptyState(), 'cover7');
  st = S.toggleLens(st, 'cover14');
  r.eq(st.maxCoverDays, 14);
  r.eq(st.lenses, ['cover14']);
});
r.test('lenses on different fields coexist', () => {
  let st = S.toggleLens(S.emptyState(), 'cover7');
  st = S.toggleLens(st, 'onhand10');
  r.eq(st.maxCoverDays, 7);
  r.eq(st.maxOnHand, 10);
  r.eq(st.lenses.slice().sort(), ['cover7', 'onhand10']);
});
r.test('toggling a lens off reverts only its own field', () => {
  let st = S.toggleLens(S.toggleLens(S.emptyState(), 'cover7'), 'onhand10');
  st = S.toggleLens(st, 'cover7');
  r.eq(st.maxCoverDays, null);
  r.eq(st.maxOnHand, 10);
});
r.test('Clear lenses on a clean state is a no-op, not a reset', () => {
  const st = Object.assign(S.emptyState(), { q: 'Sonic', location: 'online' });
  const after = S.clearLenses(st);
  r.eq(after.q, 'Sonic');
  r.eq(after.location, 'online');
});

console.log('\n── removing one chip removes one thing ──');
r.test('clearing the search chip leaves the lens alone', () => {
  const after = S.clearField(applied, 'q');
  r.eq(after.q, '');
  r.eq(after.maxCoverDays, 7);
});
r.test('clearing the cover chip also un-presses the lens that set it', () => {
  const after = S.clearField(applied, 'maxCoverDays');
  r.eq(after.maxCoverDays, null);
  r.eq(after.lenses, []);
  r.eq(after.q, 'Sonic');
});
r.test('chips list every applied condition', () => {
  const labels = S.activeChips(applied).map((c) => c.field).sort();
  r.eq(labels, ['location', 'maxCoverDays', 'productType', 'q']);
});
r.test('a lens-set chip is marked as such', () => {
  const chip = S.activeChips(applied).find((c) => c.field === 'maxCoverDays');
  r.eq(chip.lens, 'cover7');
});
r.test('a chip label states its units', () => {
  const chips = S.activeChips(Object.assign(S.emptyState(), { maxCoverDays: 7, maxOnHand: 10, minSold30: 3 }));
  r.has(chips.find((c) => c.field === 'maxCoverDays').label, 'days');
  r.has(chips.find((c) => c.field === 'maxOnHand').label, 'units');
  r.has(chips.find((c) => c.field === 'minSold30').label, 'units');
});

console.log('\n── persistence across view levels ──');
r.test('switching level keeps search, scope and sort', () => {
  const st = Object.assign(sonicThenSevenDays(), { sort: 'value_desc' });
  const atSku = Object.assign({}, st, { level: 'sku' });
  r.eq(atSku.q, 'Sonic');
  r.eq(atSku.location, 'online');
  r.eq(atSku.sort, 'value_desc');
  r.eq(atSku.maxCoverDays, 7);
});
r.test('tag filters do not apply at the product-type rollup', () => {
  r.eq(S.fieldAppliesAtLevel('tag', 'type'), false);
  r.eq(S.fieldAppliesAtLevel('tag', 'product'), true);
  r.eq(S.fieldAppliesAtLevel('tag', 'sku'), true);
});
r.test('an inapplicable tag filter is IGNORED at type level, not applied to zero rows', () => {
  // Type rollups carry no tag, so filtering on one used to empty the table
  // and read as "no matching stock".
  const typeRow = Object.assign({}, F.rows.TEE_YL, { level: 'type', tag: '' });
  const st = Object.assign(S.emptyState(), { level: 'type', tag: 'Hero' });
  r.eq(S.matchesFilters(typeRow, st), true);
});
r.test('the same filter DOES apply once you switch back down', () => {
  const productRow = Object.assign({}, F.rows.TEE_YL, { level: 'product', tag: '' });
  const st = Object.assign(S.emptyState(), { level: 'product', tag: 'Hero' });
  r.eq(S.matchesFilters(productRow, st), false);
});
r.test('an inapplicable filter is shown struck through rather than dropped', () => {
  const st = Object.assign(S.emptyState(), { level: 'type', tag: 'Hero' });
  const chip = S.activeChips(st).find((c) => c.field === 'tag');
  r.truthy(chip, 'the chip must still be listed');
  r.eq(chip.inactive, true);
});

console.log('\n── search still searches ──');
r.test('the search term filters on product, sku and variant', () => {
  const hits = F.all().filter((row) => S.matchesFilters(row, Object.assign(S.emptyState(), { q: 'sonic' })));
  r.eq(hits.length, 6);   // everything but the two non-Sonic fixtures
});
r.test('search survives a lens being applied and cleared', () => {
  let st = Object.assign(S.emptyState(), { q: 'sonic' });
  st = S.toggleLens(st, 'cover7');
  st = S.clearLenses(st);
  const hits = F.all().filter((row) => S.matchesFilters(row, st));
  r.eq(hits.length, 6);
});

const out = r.summary();
process.exit(out.fail ? 1 : 0);
