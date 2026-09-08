/* BUG 3 — the Sonic Team Sonic Youth T-Shirt detail showed two zero-stock
 * sizes with recent sales as "OK" under Transfer, with a blank days cover.
 *
 * Root cause: the allocation table had ONE column doing two jobs. Its ladder
 * was `avail < 0 ? "DATA ISSUE" : (cover > 0 && cover <= risk ? "SHORT"
 * : (cover >= 90 && avail > 0 ? "EXCESS" : "OK"))`. For a size with 0 units
 * and 450 sold in 30 days the view returns days_oos = 0.0, so `cover > 0` was
 * false, `avail > 0` was false, and the row fell through to "OK". The header
 * said Transfer; the value said the stock was fine.
 *
 * The rules here:
 *   1. Inventory status and transfer eligibility are separate answers.
 *   2. Transfer never says "OK". Its no-signal value is a dash, and the dash
 *      means "no transfer to make", not "healthy".
 *   3. No row reaches the OK inventory status unless its cover was actually
 *      measured and sits in the healthy band. */
'use strict';

const { createReporter } = require('../lib/assert');
const { loadSignals } = require('../lib/load');
const F = require('../fixtures/sonic-rows');

const S = loadSignals();
const r = createReporter('inventory-vs-transfer');

console.log('\n── the two reported sizes ──');
[['YM', F.rows.TEE_YM], ['YS', F.rows.TEE_YS]].forEach(([name, row]) => {
  r.test(`${name}: inventory status is Out of stock, not OK`, () => {
    const sig = S.inventorySignal(row);
    r.eq(sig.code, 'out_of_stock');
    r.not(sig.label, 'OK');
  });
  r.test(`${name}: transfer says nothing, and never says OK`, () => {
    const t = S.transferStatus(row);
    r.eq(t.code, 'none');
    r.eq(t.label, '—');
  });
  r.test(`${name}: days cover is not blank`, () => {
    r.eq(S.coverDisplay(row).text, '0');
  });
  r.test(`${name}: recent sales are intact, so this is not a data gap`, () => {
    r.truthy(row.sold_30 > 300, 'fixture should carry real recent sales');
    r.eq(S.demandBasis(row), 'measured');
  });
});

console.log('\n── transfer never reports health ──');
r.test('no fixture row produces a transfer status of "OK"', () => {
  const labels = F.all().map((row) => S.transferStatus(row).label);
  r.eq(labels.filter((l) => /ok/i.test(l)), []);
});
r.test('transfer only ever returns short, excess or nothing', () => {
  const codes = new Set(F.all().map((row) => S.transferStatus(row).code));
  [...codes].forEach((c) => r.truthy(['short', 'excess', 'none'].includes(c), `unexpected code ${c}`));
});
r.test('a low-cover row with stock IS a receive candidate', () => {
  r.eq(S.transferStatus(F.rows.TEE_YL).code, 'short');   // 69 units, 7.5 days
});
r.test('a long-cover row with stock IS a send candidate', () => {
  r.eq(S.transferStatus(F.rows.SWEATS_M).code, 'excess'); // 49 units, 98 days
});
r.test('a row with unknown cover is never a transfer candidate either way', () => {
  r.eq(S.transferStatus(F.rows.PIN).code, 'none');
});
r.test('the transfer column carries an explanation of what a dash means', () => {
  r.has(S.TRANSFER_NOTE, 'not a statement that stock is healthy');
  r.has(S.TRANSFER_NOTE, 'Inventory');
});

console.log('\n── OK is earned, never fallen into ──');
r.test('a row with unknown demand can never be OK', () => {
  r.not(S.inventorySignal(F.rows.PIN).code, 'ok');
});
r.test('a row with no recorded sales can never be OK', () => {
  r.not(S.inventorySignal(F.rows.DEAD_STOCK).code, 'ok');
});
r.test('a stale row can never be OK', () => {
  r.not(S.inventorySignal(F.rows.STALE_STOCK).code, 'ok');
});
r.test('a zero-stock row can never be OK', () => {
  r.not(S.inventorySignal(F.rows.TEE_YM).code, 'ok');
});
r.test('a negative-stock row can never be OK', () => {
  r.not(S.inventorySignal(F.rows.STOLEN_YS).code, 'ok');
});
r.test('every OK row has a measured cover inside the healthy band', () => {
  F.all().forEach((row) => {
    if (S.inventorySignal(row).code !== 'ok') return;
    const cover = S.coverDays(row);
    r.truthy(cover !== null, 'OK requires a measured cover');
    r.truthy(cover > S.DEFAULTS.watchDays && cover < S.DEFAULTS.overstockDays,
      `OK cover ${cover} should sit inside the healthy band`);
  });
});

console.log('\n── the low-cover threshold is a real, labelled input ──');
r.test('raising the threshold moves a row from Watch into Low cover', () => {
  // TEE_YL sits at 7.5 days, which is already under the 14-day default.
  const row = Object.assign({}, F.rows.TEE_YL, { days_cover: 20, avail_qty: 200 });
  r.eq(S.inventorySignal(row, { lowCoverDays: 14 }).code, 'watch');
  r.eq(S.inventorySignal(row, { lowCoverDays: 25 }).code, 'low_cover');
});
r.test('the threshold moves the transfer "short" boundary with it', () => {
  const row = Object.assign({}, F.rows.TEE_YL, { days_cover: 20, avail_qty: 200 });
  r.eq(S.transferStatus(row, { lowCoverDays: 14 }).code, 'none');
  r.eq(S.transferStatus(row, { lowCoverDays: 25 }).code, 'short');
});

console.log('\n── every status explains itself ──');
r.test('each signal carries a note a person can read', () => {
  S.SIGNAL_ORDER.forEach((code) => {
    const def = S.SIGNALS[code];
    r.truthy(def && def.note && def.note.length > 15, `${code} needs an explanation`);
    r.truthy(def.label && def.label.length, `${code} needs a label`);
  });
});
r.test('no signal label is a buying instruction', () => {
  const labels = S.SIGNAL_ORDER.map((c) => S.SIGNALS[c].label.toLowerCase());
  labels.forEach((l) => {
    r.truthy(!/\bbuy\b|\breorder\b|\bpo\b|suggest/.test(l), `"${l}" reads as a purchasing recommendation`);
  });
});
r.test('the unknown-demand note explicitly refuses to claim zero demand', () => {
  r.has(S.SIGNALS.unknown_demand.note, 'not a claim');
});

console.log('\n── partial demand coverage is disclosed, not hidden ──');
r.test('a rollup with some unmatched children is flagged partial', () => {
  const rollup = Object.assign({}, F.rows.TEE_YL, {
    level: 'product', demand_known_count: 3, demand_rows_count: 5
  });
  const sig = S.inventorySignal(rollup);
  r.eq(sig.partial, true);
  r.eq(sig.coverage.known, 3);
  r.eq(sig.coverage.total, 5);
});
r.test('a fully matched rollup is not flagged partial', () => {
  const rollup = Object.assign({}, F.rows.TEE_YL, {
    level: 'product', demand_known_count: 5, demand_rows_count: 5
  });
  r.eq(S.inventorySignal(rollup).partial, false);
});
r.test('a rollup where NOTHING matched is unknown, not zero-demand', () => {
  const rollup = Object.assign({}, F.rows.TEE_YL, {
    level: 'product', demand_known_count: 0, demand_rows_count: 5,
    avg_day: 0, avg_day_7: 0, days_cover: null
  });
  r.eq(S.inventorySignal(rollup).code, 'unknown_demand');
});
r.test('the partial caveat names both counts so it can be printed', () => {
  const rollup = Object.assign({}, F.rows.TEE_YL, {
    level: 'product', demand_known_count: 2, demand_rows_count: 9
  });
  r.has(S.coverDisplay(rollup).title, '2 of 9');
});

const out = r.summary();
process.exit(out.fail ? 1 : 0);
