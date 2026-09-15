/* What the Books & setup page CLAIMS about a QBO history archive's exceptions.
 *
 * Written from the first real import on 2026-09-15 (2026-01-01 → 2026-07-31,
 * 22,909 lines, 264 accounts). Its reconciliation is:
 *
 *   192  matched                         171 of them carrying a balance
 *    71  missing_ledger_account          EVERY one with a zero trial balance,
 *                                        and with no ledger/difference keys
 *                                        at all -- the archive builds those
 *                                        rows from the trial-balance side
 *     1  unattributed_ledger_section     QuickBooks' own "Not Specified"
 *                                        group, deliberately NOT counted in
 *                                        exception_count
 *
 * which the page reported as "71 account exceptions to review · this window
 * is not yet reconciled", over 71 rows reading "— | 0.00 | —". Every balance
 * tied; nothing was unaccounted for; the screen said the opposite.
 *
 * The archive counting a zero-balance trial-balance account as a coverage
 * exception is deliberate and stays (a zero balance in THIS window does not
 * prove the account was idle in another). So these tests pin the two claims
 * the PAGE is responsible for: that a coverage note at zero is described as
 * benign, and that the same note STOPS being described that way the moment
 * the account carries a balance.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { loadV2 } = require('../lib/load');

const H = loadV2(['qbo-history.js']).SiloQboHistory;
const r = createReporter('qbo-history-exceptions');

// ------------------------------------------------- the real import's shape

const matched = (name, tb) => ({
  qbo_account_id: 'a-' + name, account_name: name, issues: [],
  ledger_debit_net: tb, trial_balance_debit_net: tb, difference: 0,
});
// The archive builds a missing_ledger_account row from the trial-balance side
// only: no ledger_debit_net, no difference. Reproduced exactly.
const missingLedger = (name, tb) => ({
  qbo_account_id: 'a-' + name, account_name: name,
  trial_balance_debit_net: tb, issues: ['missing_ledger_account'],
});
const placeholder = {
  qbo_account_id: 'silo:unattributed', account_name: 'Not Specified',
  ledger_debit_net: 0, trial_balance_debit_net: null, difference: null,
  issues: ['unattributed_ledger_section'],
};

const production = [
  ...Array.from({ length: 171 }, (_, i) => matched('Live ' + i, 1000 + i)),
  ...Array.from({ length: 21 }, (_, i) => matched('Idle ' + i, 0)),
  ...Array.from({ length: 71 }, (_, i) => missingLedger('Dormant ' + i, 0)),
  placeholder,
];

console.log('\n── the real import reads as what it is ──');

const sum = H.summarise(production);

r.test('the fixture is the production shape', () => {
  r.eq(sum.total, 264);
  r.eq(sum.matched, 192);
  r.eq(sum.flagged, 72, '71 coverage notes plus the placeholder');
});

/* The placeholder is a note, not an exception -- the archive excludes it from
   exception_count on purpose. The page's own wording has to agree with the
   number printed beside it, or the screen says 72 and 71 at the same time. */
r.test('the page counts exceptions the way the archive does', () => {
  r.eq(sum.exceptions, 71, 'matches exception_count on the real import');
  r.eq(sum.exceptionGroups.length, 1, 'one KIND of exception, so "all of one kind"');
  r.eq(sum.groups.length, 2, 'both kinds are still explained');
  r.eq(sum.exceptionGroups[0].code, 'missing_ledger_account');
});

r.test('the placeholder block says it is not counted', () => {
  r.eq(H.ISSUES.unattributed_ledger_section.counted, false);
  // Everything else is counted, so the default must not be "uncounted".
  for (const code of Object.keys(H.ISSUES)) {
    if (code === 'unattributed_ledger_section') continue;
    r.not(String(H.ISSUES[code].counted), 'false', code + ' must count');
  }
});

r.test('every balance tied, so the page may say so', () => {
  r.eq(sum.balancesAllTie, true);
  r.eq(sum.atRiskAccounts, 0);
  r.eq(sum.atRiskBalance, 0);
});

r.test('71 accounts of ONE kind, and none of them holds a balance', () => {
  const g = sum.groups.find((x) => x.code === 'missing_ledger_account');
  r.eq(g.accounts, 71);
  r.eq(g.withBalance, 0);
  r.eq(g.balanceTotal, 0);
  r.eq(g.severity, 'coverage', 'not something to act on while the balance is zero');
});

r.test('a zero-balance coverage note is explained as benign, not as a defect', () => {
  const copy = H.ISSUES.missing_ledger_account;
  r.has(copy.zeroAction, 'Nothing is missing from the archive');
  r.has(copy.zeroAction, 'nothing is unaccounted for');
  // And it still says WHY it is listed at all, so the archive's conservative
  // stance is explained rather than contradicted.
  r.has(copy.zeroAction, 'does not prove');
});

r.test('the same note carries a different instruction once a balance exists', () => {
  const copy = H.ISSUES.missing_ledger_account;
  r.has(copy.balanceAction, 'no detail behind it');
  r.truthy(copy.balanceAction !== copy.zeroAction, 'the two cases must not share a sentence');
});

// ------------------------------------------------- severity is from the row

console.log('\n── a coverage gap on an account that HOLDS money is not benign ──');

const withBalance = [
  matched('Cash', 5000),
  missingLedger('Loan payable', -42000),
  missingLedger('Dormant', 0),
];
const risky = H.summarise(withBalance);

r.test('an unexplained balance flips the group to something to act on', () => {
  const g = risky.groups.find((x) => x.code === 'missing_ledger_account');
  r.eq(g.accounts, 2);
  r.eq(g.withBalance, 1);
  r.eq(g.balanceTotal, 42000, 'reported as a magnitude');
  r.eq(g.severity, 'difference', 'the same CODE, a different severity');
});

r.test('and the page may no longer claim every balance tied', () => {
  r.eq(risky.balancesAllTie, false);
  r.eq(risky.atRiskAccounts, 1);
  r.eq(risky.atRiskBalance, 42000);
});

r.test('severity is decided per row, never from the issue code alone', () => {
  r.eq(H.classify(missingLedger('x', 0)).severity, 'coverage');
  r.eq(H.classify(missingLedger('x', -1)).severity, 'difference');
  r.eq(H.classify(matched('x', 10)).severity, 'matched');
});

r.test('a real balance difference is always something to act on', () => {
  const mismatch = { account_name: 'Sales', issues: ['trial_balance_mismatch'],
    ledger_debit_net: 10, trial_balance_debit_net: 12, difference: -2 };
  r.eq(H.classify(mismatch).severity, 'difference');
  const s = H.summarise([mismatch]);
  r.eq(s.balancesAllTie, false);
});

r.test('a difference outranks a coverage note on the same account', () => {
  const both = { account_name: 'Both', issues: ['missing_ledger_account', 'trial_balance_mismatch'],
    trial_balance_debit_net: 0 };
  r.eq(H.classify(both).severity, 'difference');
});

// -------------------------------------------------------------- the labels

console.log('\n── every issue the archive can raise has words for it ──');

r.test('the placeholder section is no longer shown as raw snake_case', () => {
  // unattributed_ledger_section reached this screen with no label at all.
  r.eq(H.issueLabel('unattributed_ledger_section'), 'QuickBooks’ own “Not Specified” group');
  r.truthy(H.ISSUES.unattributed_ledger_section.meaning.length > 0);
});

r.test('an unknown future code is humanised rather than printed raw', () => {
  r.eq(H.issueLabel('some_new_check'), 'Some new check');
  r.not(H.issueLabel('some_new_check'), '_');
});

r.test('every code the migrations raise is explained here', () => {
  // If the archive gains an issue kind, this fails until it gains words.
  for (const code of ['no_ledger_rows', 'running_balance_gap', 'missing_transaction_reference',
    'movement_total_mismatch', 'missing_trial_balance_account', 'trial_balance_mismatch',
    'missing_ledger_account', 'unattributed_ledger_section']) {
    const def = H.ISSUES[code];
    r.truthy(def, `${code} has no entry`);
    r.truthy(def.label && def.meaning, `${code} has no label or meaning`);
    r.truthy(def.action || (def.zeroAction && def.balanceAction), `${code} tells nobody what to do`);
    r.truthy(['difference', 'coverage', 'detail'].includes(def.severity), `${code} has no severity`);
  }
});

r.test('the placeholder never counts as something to act on', () => {
  const s = H.summarise([placeholder]);
  r.eq(s.balancesAllTie, true, 'it is proved all-zero before admission');
  r.eq(s.groups[0].severity, 'detail');
});

// ------------------------------------------------------------- robustness

console.log('\n── a malformed or empty reconciliation says nothing false ──');

r.test('an empty reconciliation claims nothing', () => {
  const s = H.summarise([]);
  r.eq([s.total, s.matched, s.flagged], [0, 0, 0]);
  r.eq(s.groups, []);
});

r.test('a non-array is tolerated rather than throwing on the page', () => {
  r.eq(H.summarise(null).total, 0);
  r.eq(H.summarise(undefined).flagged, 0);
});

r.test('a row with no issues array is treated as matched, not as an exception', () => {
  r.eq(H.classify({ account_name: 'x' }).severity, 'matched');
  r.eq(H.summarise([{ account_name: 'x' }]).flagged, 0);
});

r.test('a non-numeric balance never becomes a fabricated number', () => {
  r.eq(H.classify({ issues: ['missing_ledger_account'], trial_balance_debit_net: 'n/a' }).balance, 0);
  r.eq(H.classify({ issues: ['missing_ledger_account'], trial_balance_debit_net: null }).balance, 0);
});

r.test('groups are ordered with what must be acted on first', () => {
  const mixed = H.summarise([
    { account_name: 'a', issues: ['missing_transaction_reference'] },
    missingLedger('b', 0),
    { account_name: 'c', issues: ['trial_balance_mismatch'], difference: 5, trial_balance_debit_net: 5 },
  ]);
  r.eq(mixed.groups.map((g) => g.severity), ['difference', 'coverage', 'detail']);
});

process.exit(r.summary().fail ? 1 : 0);
