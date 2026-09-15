/* What a filter position on /v2/transactions.html actually selects.
 *
 * The register is the one place in SILO where a wrong ROW SET is invisible:
 * every number on the page (the KPI band, the segment counts, the "N in
 * dates" line, the bulk-edit selection) is computed from the same filtered
 * array, so a predicate that quietly drops or duplicates a row produces a
 * screen that is internally consistent and wrong. The three cases this suite
 * exists for are all of that kind:
 *
 *   - a SPLIT transaction filtered by one of its accounts, which must appear
 *     once and not once per line;
 *   - a transaction whose source supplied NO merchant, which must stay blank
 *     rather than inheriting its own description;
 *   - an AMOUNT filter, where the stored value is signed and the typed value
 *     is a magnitude.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { loadV2 } = require('../lib/load');

const F = loadV2(['transaction-filters.js']).SiloTransactionFilters;
const r = createReporter('transaction-filters');

// ---------------------------------------------------------------- fixtures

const splits = new Map();

const ctx = {
  splitsFor: (t) => splits.get(t.id) || null,
  merchantKey: (t) => String(t.clean_merchant || t.description || '').toLowerCase(),
  sourceName: () => 'Amex Platinum',
  hasSuggestion: (t) => t.id === 'suggested',
  accountName: (id) => ({ acc_rent: 'Lease & Rent', acc_int: 'Interest Expense' }[id] || id),
  typeLabel: (v) => ({ purchase: 'Purchase', refund: 'Refund' }[v] || v),
  statusLabel: (v) => ({ uncoded: 'Needs categorizing' }[v] || v),
};

const txn = (over) => Object.assign({
  id: 'x', txn_date: '2026-09-04', description: 'AMZN Mktp US*2A4XY9',
  clean_merchant: 'Amazon', amount: 120.5, status: 'coded',
  coding_source: 'manual', confidence: 1, coding_conflict: null,
  accounting_treatment: 'purchase', qbo_account_id: 'acc_rent',
  qbo_account_name: 'Lease & Rent', card_name: 'Ops',
}, over || {});

// A $25,187.68 loan payment split into principal and interest -- the shape
// the splits feature was built for.
const loan = txn({
  id: 'loan', description: 'BIZ2CREDIT PAYMENT', clean_merchant: null,
  amount: 25187.68, qbo_account_id: null, qbo_account_name: null,
  accounting_treatment: 'purchase',
});
splits.set('loan', [
  { line_no: 1, qbo_account_id: 'acc_loan', qbo_account_name: 'Biz2Credit Loan', amount: 22000 },
  { line_no: 2, qbo_account_id: 'acc_int', qbo_account_name: 'Interest Expense', amount: 3187.68 },
]);

const refund = txn({ id: 'refund', amount: -45.25, accounting_treatment: 'refund',
  clean_merchant: 'Amazon', description: 'RETURN CREDIT 8841' });
const bare = txn({ id: 'bare', clean_merchant: null, description: 'CHECKCARD 0412 SQ *TST' });
const uncoded = txn({
  id: 'uncoded', status: 'uncoded', qbo_account_id: null, qbo_account_name: null,
  clean_merchant: 'Comcast', description: 'COMCAST BUSINESS', amount: 310, txn_date: '2026-08-02',
  accounting_treatment: 'unknown',
});
const rows = [txn(), loan, refund, bare, uncoded];

const ids = (list) => list.map((t) => t.id);
const applied = (patch) => ids(F.apply(rows, Object.assign({}, F.EMPTY, patch), ctx));

// --------------------------------------------------------------- merchant

console.log('\n── merchant comes from the source, or not at all ──');

r.test('a source-supplied merchant is returned as given', () => {
  r.eq(F.merchantOf(txn()), 'Amazon');
});

r.test('NO merchant is blank -- never the description', () => {
  r.eq(F.merchantOf(bare), '');
  r.eq(F.merchantOf(loan), '');
  r.eq(F.merchantOf({ clean_merchant: '   ' }), '');
});

r.test('the "merchant" column of card_transactions is not consulted', () => {
  // Plaid writes merchant = coalesce(merchant_name, name): it falls back to
  // the descriptor, which is exactly the substitution we must not make.
  r.eq(F.merchantOf({ clean_merchant: null, merchant: 'CHECKCARD 0412' }), '');
});

r.test('filtering by merchant selects only that merchant', () => {
  r.eq(applied({ merchant: 'Amazon' }), ['x', 'refund']);
});

r.test('filtering by merchant is case-insensitive', () => {
  r.eq(applied({ merchant: 'amazon' }), ['x', 'refund']);
});

r.test('"no merchant" is its own selectable filter', () => {
  r.eq(applied({ merchant: F.NO_MERCHANT }), ['loan', 'bare']);
});

/* Cycle-1 review finding, and it reproduces on production data: three
   merchants are stored under two casings, "Portland General Electric" and
   "PORTLAND GENERAL ELECTRIC" across 10 rows among them. Matching was already
   case-insensitive while the picker grouped by the RAW value, so the list
   offered two choices of one row each and selecting either matched both --
   the count contradicted the table under it, and a bulk edit from that
   selection acted on a row the choice said was not there. */
console.log('\n── one merchant, however the source capitalised it ──');

const casings = [
  txn({ id: 'pge-1', clean_merchant: 'Portland General Electric', description: 'PGE AUTOPAY', amount: 400 }),
  txn({ id: 'pge-2', clean_merchant: 'PORTLAND GENERAL ELECTRIC', description: 'PGE AUTOPAY', amount: 410 }),
  txn({ id: 'other', clean_merchant: 'Comcast', description: 'COMCAST', amount: 50 }),
];

r.test('the picker offers ONE option for two casings, counted together', () => {
  const o = F.options(casings, ctx);
  r.eq(o.merchants.length, 2, 'Portland General Electric and Comcast');
  const pge = o.merchants.find((m) => m.key === 'portland general electric');
  r.eq(pge.count, 2, 'both casings counted under one choice');
  r.eq(pge.name, 'Portland General Electric', 'the first casing seen is the label');
});

r.test('selecting that option matches BOTH casings', () => {
  const out = F.apply(casings, Object.assign({}, F.EMPTY, { merchant: 'portland general electric' }), ctx);
  r.eq(ids(out), ['pge-1', 'pge-2']);
});

r.test('the count the picker shows equals the rows the choice selects', () => {
  // The bug in one assertion: option count and matched rows must agree.
  const o = F.options(casings, ctx);
  for (const option of o.merchants) {
    const matched = F.apply(casings, Object.assign({}, F.EMPTY, { merchant: option.key }), ctx);
    r.eq(matched.length, option.count, `option "${option.name}" says ${option.count}`);
  }
});

r.test('an option value is the canonical key, so a stored choice still resolves', () => {
  const o = F.options(casings, ctx);
  r.eq(o.merchants.map((m) => m.key), ['comcast', 'portland general electric']);
  // Whichever casing the loaded rows happen to carry, the key is the same.
  const flipped = [casings[1], casings[0]];
  r.eq(F.options(flipped, ctx).merchants.find((m) => m.key === 'portland general electric').count, 2);
});

r.test('a chip names the merchant in its own casing, not the key', () => {
  const labelled = Object.assign({}, ctx, {
    merchantLabel: (key) => ({ 'portland general electric': 'Portland General Electric' }[key] || ''),
  });
  r.eq(F.describe(Object.assign({}, F.EMPTY, { merchant: 'portland general electric' }), labelled)[0].label,
    'Merchant: Portland General Electric');
  // With no label available the key is shown rather than nothing.
  r.eq(F.describe(Object.assign({}, F.EMPTY, { merchant: 'wave pro' }), ctx)[0].label, 'Merchant: wave pro');
});

r.test('canonicalMerchant is what the page must store', () => {
  r.eq(F.canonicalMerchant('  PORTLAND General Electric '), 'portland general electric');
  r.eq(F.canonicalMerchant(null), '');
});

r.test('a position stored with the source\'s casing is canonicalised on read', () => {
  // sessionStorage may hold a merchant written before the key existed.
  r.eq(F.normalize({ merchant: 'Portland General Electric' }).merchant, 'portland general electric');
  r.eq(F.normalize({ merchant: F.NO_MERCHANT }).merchant, F.NO_MERCHANT, 'the sentinel survives');
  r.eq(ids(F.apply(casings, { merchant: 'PORTLAND GENERAL ELECTRIC' }, ctx)), ['pge-1', 'pge-2']);
});

// ----------------------------------------------------------------- splits

console.log('\n── a split matches on its lines, once ──');

r.test('the parent carries no account of its own', () => {
  r.eq(loan.qbo_account_id, null);
});

r.test('filtering by a split line account finds the parent', () => {
  r.eq(applied({ account: 'acc_int' }), ['loan']);
});

r.test('the parent appears ONCE even when two lines match the filter', () => {
  // Both lines are on acc_int here: the row must still be listed once.
  splits.set('loan', [
    { line_no: 1, qbo_account_id: 'acc_int', qbo_account_name: 'Interest Expense' },
    { line_no: 2, qbo_account_id: 'acc_int', qbo_account_name: 'Interest Expense' },
  ]);
  const out = applied({ account: 'acc_int' });
  splits.set('loan', [
    { line_no: 1, qbo_account_id: 'acc_loan', qbo_account_name: 'Biz2Credit Loan' },
    { line_no: 2, qbo_account_id: 'acc_int', qbo_account_name: 'Interest Expense' },
  ]);
  r.eq(out, ['loan'], 'one parent row, not one per matching line');
});

r.test('apply() can never return more rows than it was given', () => {
  const out = F.apply(rows, Object.assign({}, F.EMPTY, { account: 'acc_int' }), ctx);
  r.truthy(out.length <= rows.length, 'filtering must not duplicate');
});

r.test('a split is NOT "uncategorized" despite its null parent account', () => {
  r.eq(applied({ account: F.NO_ACCOUNT }), ['uncoded']);
});

r.test('an unsplit row still matches its own account', () => {
  r.eq(applied({ account: 'acc_rent' }), ['x', 'refund', 'bare']);
});

r.test('account counts credit a split once per distinct account', () => {
  const o = F.options(rows, ctx);
  const int = o.accounts.find((a) => a.id === 'acc_int');
  r.eq(int.count, 1);
  r.eq(int.name, 'Interest Expense');
  r.eq(o.noAccount, 1, 'only the genuinely uncategorized row');
  r.eq(o.noMerchant, 2);
});

r.test('an account id with no cached name keeps its own id, not a neighbour\'s', () => {
  const orphan = { id: 'orphan', amount: 5, txn_date: '2026-09-01', accounting_treatment: 'purchase' };
  const twoLines = new Map([['orphan', [
    { line_no: 1, qbo_account_id: 'acc_a', qbo_account_name: null },
    { line_no: 2, qbo_account_id: 'acc_b', qbo_account_name: 'Named B' },
  ]]]);
  const o = F.options([orphan], { splitsFor: (t) => twoLines.get(t.id) });
  r.eq(o.accounts.map((a) => [a.id, a.name]), [['acc_a', 'acc_a'], ['acc_b', 'Named B']]);
});

// ----------------------------------------------------------------- amount

console.log('\n── sign is direction, magnitude is amount ──');

r.test('positive is money out, negative is money in', () => {
  r.eq(F.directionOf(txn()), 'out');
  r.eq(F.directionOf(refund), 'in');
  r.eq(F.directionOf({ amount: 0 }), null);
});

r.test('money in selects the refund alone', () => {
  r.eq(applied({ direction: 'in' }), ['refund']);
});

r.test('money out excludes it', () => {
  r.eq(applied({ direction: 'out' }), ['x', 'loan', 'bare', 'uncoded']);
});

r.test('an exact amount is matched as a magnitude', () => {
  r.eq(applied({ amountMode: 'exact', amountExact: '45.25' }), ['refund']);
});

r.test('an exact amount tolerates $ and thousands separators', () => {
  r.eq(applied({ amountMode: 'exact', amountExact: '$25,187.68' }), ['loan']);
});

r.test('exact amounts compare in cents, not floats', () => {
  const pennies = [{ id: 'p', amount: 0.1 + 0.2, txn_date: '2026-09-01' }];
  r.eq(ids(F.apply(pennies, Object.assign({}, F.EMPTY, { amountMode: 'exact', amountExact: '0.30' }), ctx)), ['p']);
});

r.test('a range is inclusive at both ends', () => {
  r.eq(applied({ amountMode: 'range', amountMin: '120.50', amountMax: '310' }), ['x', 'bare', 'uncoded']);
});

r.test('a half-open range needs only one end', () => {
  r.eq(applied({ amountMode: 'range', amountMin: '1000' }), ['loan']);
  r.eq(applied({ amountMode: 'range', amountMax: '100' }), ['refund']);
});

r.test('a reversed range is read in order rather than matching nothing', () => {
  r.eq(applied({ amountMode: 'range', amountMin: '310', amountMax: '120.50' }), ['x', 'bare', 'uncoded']);
});

r.test('an amount mode with nothing typed narrows nothing', () => {
  r.eq(applied({ amountMode: 'range' }), ids(rows));
  r.eq(applied({ amountMode: 'exact', amountExact: '' }), ids(rows));
});

r.test('a half-typed amount narrows nothing rather than emptying the screen', () => {
  r.eq(applied({ amountMode: 'exact', amountExact: '.' }), ids(rows));
});

r.test('direction and amount combine', () => {
  r.eq(applied({ direction: 'in', amountMode: 'range', amountMin: '40', amountMax: '50' }), ['refund']);
  r.eq(applied({ direction: 'out', amountMode: 'range', amountMin: '40', amountMax: '50' }), []);
});

// ------------------------------------------------------------------ dates

console.log('\n── dates ──');

r.test('a date range selects within the loaded set', () => {
  r.eq(applied({ dateStart: '2026-09-01', dateEnd: '2026-09-30' }), ['x', 'loan', 'refund', 'bare']);
  r.eq(applied({ dateEnd: '2026-08-31' }), ['uncoded']);
});

r.test('a reversed date range is read in order', () => {
  r.eq(applied({ dateStart: '2026-09-30', dateEnd: '2026-09-01' }), ['x', 'loan', 'refund', 'bare']);
});

r.test('a row with no date is excluded by a date bound, not included by accident', () => {
  const undated = [{ id: 'u', txn_date: null, amount: 5 }];
  r.eq(ids(F.apply(undated, Object.assign({}, F.EMPTY, { dateStart: '2026-01-01' }), ctx)), []);
  r.eq(ids(F.apply(undated, F.EMPTY, ctx)), ['u']);
});

r.test('a malformed date bound is ignored rather than dropping every row', () => {
  r.eq(applied({ dateStart: 'last tuesday' }), ids(rows));
});

// --------------------------------------------------------- type and text

console.log('\n── type, text and status ──');

r.test('transaction type filters on accounting_treatment', () => {
  r.eq(applied({ type: 'refund' }), ['refund']);
  r.eq(applied({ type: 'unknown' }), ['uncoded'], 'a null treatment reads as unknown');
});

r.test('merchant-or-description text reads both, and the memo', () => {
  r.eq(applied({ text: 'amzn' }), ['x'], 'the descriptor');
  r.eq(applied({ text: 'amazon' }), ['x', 'refund'], 'the merchant');
});

r.test('merchant-or-description text does NOT read the account name', () => {
  // Otherwise typing a vendor also matches every row merely coded to that
  // vendor's account, and the count stops meaning what it says.
  r.eq(applied({ text: 'Lease & Rent' }), []);
});

r.test('the quick search DOES reach the account, card and split lines', () => {
  r.eq(applied({ search: 'Lease & Rent' }), ['x', 'refund', 'bare']);
  r.eq(applied({ search: 'Interest Expense' }), ['loan'], 'through the split lines');
  r.eq(applied({ search: 'Amex' }), ids(rows), 'through the source name');
});

r.test('status filters keep their existing meanings', () => {
  r.eq(applied({ status: 'uncoded' }), ['uncoded']);
  const low = [txn({ id: 'low', confidence: 0.4 }), txn({ id: 'lowex', confidence: 0.4, status: 'excluded' })];
  r.eq(ids(F.apply(low, Object.assign({}, F.EMPTY, { status: 'low' }), ctx)), ['low'],
    'an excluded row is never "low confidence"');
});

r.test('the AI status includes a pending suggestion, not just a stored one', () => {
  const list = [txn({ id: 'suggested', coding_source: 'manual' }), txn({ id: 'ai', coding_source: 'ai' })];
  r.eq(ids(F.apply(list, Object.assign({}, F.EMPTY, { status: 'ai' }), ctx)), ['suggested', 'ai']);
});

// ------------------------------------------------------------ combination

console.log('\n── filters combine ──');

r.test('every filter narrows the previous one', () => {
  r.eq(applied({ direction: 'out', type: 'purchase', dateStart: '2026-09-01' }), ['x', 'loan', 'bare']);
  r.eq(applied({ direction: 'out', type: 'purchase', dateStart: '2026-09-01', merchant: 'Amazon' }), ['x']);
  r.eq(applied({
    direction: 'out', type: 'purchase', dateStart: '2026-09-01',
    merchant: 'Amazon', amountMode: 'range', amountMax: '1',
  }), []);
});

r.test('filters apply to the WHOLE set given, not a slice of it', () => {
  // The page renders every loaded row, so "the visible page" and "the
  // dataset" are the same array -- this pins that apply() never truncates.
  const many = Array.from({ length: 900 }, (_, i) => txn({ id: 'n' + i, amount: i + 1 }));
  const out = F.apply(many, Object.assign({}, F.EMPTY, { amountMode: 'range', amountMin: '800' }), ctx);
  r.eq(out.length, 101);
  r.eq(out[0].id, 'n799');
});

// ------------------------------------------------------- chips and clear

console.log('\n── active filters, counts and clearing ──');

r.test('an empty position is not active and has no chips', () => {
  r.eq(F.isActive(F.EMPTY), false);
  r.eq(F.describe(F.EMPTY, ctx), []);
});

r.test('each active filter produces one named chip', () => {
  const f = Object.assign({}, F.EMPTY, {
    status: 'uncoded', merchant: 'Amazon', account: 'acc_int', type: 'purchase',
    dateStart: '2026-09-01', dateEnd: '2026-09-30', direction: 'out',
    amountMode: 'range', amountMin: '10', amountMax: '20', text: 'amzn', search: 'q',
  });
  r.eq(F.describe(f, ctx).map((c) => c.key),
    ['status', 'search', 'text', 'merchant', 'account', 'type', 'date', 'direction', 'amount']);
  r.eq(F.isActive(f), true);
});

r.test('chips name the account, not its opaque id', () => {
  const chip = F.describe(Object.assign({}, F.EMPTY, { account: 'acc_int' }), ctx)[0];
  r.eq(chip.label, 'Account: Interest Expense');
});

r.test('chips say "no merchant" and "uncategorized" in words', () => {
  r.eq(F.describe(Object.assign({}, F.EMPTY, { merchant: F.NO_MERCHANT }), ctx)[0].label,
    'No merchant from the source');
  r.eq(F.describe(Object.assign({}, F.EMPTY, { account: F.NO_ACCOUNT }), ctx)[0].label, 'Uncategorized');
});

r.test('an amount chip prints the money, both bounds and one', () => {
  const label = (p) => F.describe(Object.assign({}, F.EMPTY, p), ctx)[0].label;
  r.eq(label({ amountMode: 'exact', amountExact: '45.25' }), 'Amount $45.25');
  r.eq(label({ amountMode: 'range', amountMin: '10', amountMax: '20' }), 'Amount $10.00 – $20.00');
  r.eq(label({ amountMode: 'range', amountMin: '10' }), 'Amount from $10.00');
  r.eq(label({ amountMode: 'range', amountMax: '20' }), 'Amount up to $20.00');
});

r.test('clearing one chip leaves the others alone', () => {
  const f = Object.assign({}, F.EMPTY, { merchant: 'Amazon', direction: 'in', status: 'uncoded' });
  const after = F.clear(f, 'merchant');
  r.eq(after.merchant, '');
  r.eq(after.direction, 'in');
  r.eq(after.status, 'uncoded');
});

r.test('clearing the date chip clears BOTH ends', () => {
  const after = F.clear(Object.assign({}, F.EMPTY, { dateStart: '2026-09-01', dateEnd: '2026-09-30' }), 'date');
  r.eq([after.dateStart, after.dateEnd], ['', '']);
});

r.test('clearing the amount chip resets the mode too', () => {
  const after = F.clear(Object.assign({}, F.EMPTY, { amountMode: 'range', amountMin: '10' }), 'amount');
  r.eq([after.amountMode, after.amountMin, after.amountMax, after.amountExact], ['any', '', '', '']);
});

r.test('Clear filters resets everything', () => {
  const f = Object.assign({}, F.EMPTY, { merchant: 'Amazon', status: 'low', search: 'x' });
  r.eq(F.clear(f, 'all'), F.EMPTY);
});

r.test('an unknown key is ignored rather than corrupting the position', () => {
  const f = Object.assign({}, F.EMPTY, { merchant: 'Amazon' });
  r.eq(F.clear(f, 'nonsense'), F.normalize(f));
});

// -------------------------------------------------------------- hardening

console.log('\n── a stored position is never trusted ──');

r.test('an unknown status or direction falls back rather than matching nothing', () => {
  const f = F.normalize({ status: 'drop-everything', direction: 'sideways', amountMode: 'sql' });
  r.eq([f.status, f.direction, f.amountMode], ['all', 'any', 'any']);
});

r.test('a non-object position normalizes to empty', () => {
  r.eq(F.normalize(null), F.EMPTY);
  r.eq(F.normalize('{}'), F.EMPTY);
});

r.test('options() offers only values present in the loaded rows', () => {
  const o = F.options(rows, ctx);
  r.eq(o.merchants.map((m) => m.name), ['Amazon', 'Comcast']);
  r.eq(o.merchants[0].count, 2);
  r.eq(o.types.map((t) => t.type), ['purchase', 'refund', 'unknown']);
});

r.test('apply() tolerates a missing splits context', () => {
  r.eq(ids(F.apply(rows, Object.assign({}, F.EMPTY, { account: 'acc_rent' }), {})), ['x', 'refund', 'bare']);
});

process.exit(r.summary().fail ? 1 : 0);
