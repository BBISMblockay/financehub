/* The split editor: the arithmetic first, the drawer second.
 *
 * The rule these tests hold down is the one the whole feature rests on -- a
 * split must total its transaction to the cent, and a saved split rule must
 * never supply an amount. Everything else here exists so that those two can
 * be trusted: cent-exact parsing (no floats), a remainder that refuses to
 * write a zero, and a drawer that never reports a save the database did not
 * accept. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const code = await readFile(new URL('../../v2/card-splits.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

const ACCOUNTS = [
  { id: 'loan', name: 'Columbia Bank LOC', type: 'Long Term Liability' },
  { id: 'interest', name: 'Interest Expense', type: 'Expense' },
  { id: 'fees', name: 'Bank Charges', type: 'Expense' },
  { id: 'ar', name: 'Sugar Hill Receivable', type: 'Accounts Receivable' },
];
const refs = {
  accountName: (id) => ACCOUNTS.find((a) => a.id === id)?.name || '',
  accountType: (id) => ACCOUNTS.find((a) => a.id === id)?.type || null,
  locationName: (id) => (id === 'hq' ? 'HQ' : ''),
  entityName: (type, id) => (id === 'sugar' ? 'Sugar Hill' : ''),
};

/* Evaluated in THIS realm, not a fresh vm context: a value built inside a new
   context has a different Array/Object prototype, and deepStrictEqual then
   fails on two structurally identical arrays. The file is an IIFE that hangs
   an object off `window`, so it only needs `window` and `document` supplied. */
const factory = vm.runInThisContext(`(function(window, document){${code}\n})`, { filename: 'v2/card-splits.js' });
function load(document) {
  const window = {};
  factory(window, document || { getElementById: () => { throw new Error('no DOM in this test'); } });
  return window.SiloCardSplits;
}
const S = load();

// ── amounts ─────────────────────────────────────────────────────────────
test('an amount box reads what a statement actually looks like, and refuses what it does not', () => {
  assert.equal(S.parseAmount('25187.68'), 2518768);
  assert.equal(S.parseAmount('$25,187.68'), 2518768);
  assert.equal(S.parseAmount('.68'), 68, 'a leading decimal is a real QBO shape, not a typo');
  assert.equal(S.parseAmount('(500)'), -50000);
  assert.equal(S.parseAmount('-500'), -50000);
  assert.equal(S.parseAmount('+12.5'), 1250);
  assert.equal(S.parseAmount('0'), 0, 'zero parses; it is refused later as a line, not here');
  for (const bad of ['', '  ', 'abc', '1.234', '1,2,3.4.5', '12-3', null, undefined, '$']) {
    assert.equal(S.parseAmount(bad), null, `${JSON.stringify(bad)} must not be read as a number`);
  }
});

test('cents never go through a float: sums that drift in binary still tie', () => {
  // 0.1 + 0.2 is 0.30000000000000004 and 0.07 * 3 is 0.21000000000000002. A
  // running total carrying either would tell someone their split is short by
  // a fraction of a cent they cannot enter.
  for (const [total, parts] of [[0.3, ['0.10', '0.20']], [0.21, ['0.07', '0.07', '0.07']],
                                [1.03, ['0.29', '0.36', '0.38']]]) {
    const m = S.createSplitModel(total, parts.map((p) => ({ qbo_account_id: 'fees', amountText: p })), refs);
    assert.equal(m.enteredCents(), Math.round(total * 100));
    assert.equal(m.remainderCents(), 0, `${parts.join(' + ')} must tie to ${total}`);
    assert.deepEqual(m.problems(), []);
  }
});

// ── the loan payment this feature exists for ────────────────────────────
test('a $25,187.68 loan payment splits into principal and interest and ties', () => {
  const m = S.createSplitModel(25187.68, null, refs);
  m.set(0, 'account', 'loan').set(0, 'amount', '21,453.19');
  m.set(1, 'account', 'interest');
  assert.deepEqual(m.problems().filter((p) => p.includes('Line 2 needs an amount')).length, 1);
  const rest = m.useRemainder(1);
  assert.equal(rest.ok, true);
  assert.equal(rest.cents, 373449);
  assert.equal(m.lines()[1].amountText, '3734.49');
  assert.deepEqual(m.problems(), []);
  assert.equal(m.ready(), true);
  assert.deepEqual(m.payload(), [
    { amount: '21453.19', qbo_account_id: 'loan', qbo_location_id: null, entity_qbo_id: null, entity_type: null, memo: null },
    { amount: '3734.49', qbo_account_id: 'interest', qbo_location_id: null, entity_qbo_id: null, entity_type: null, memo: null },
  ]);
});

test('a split that does not total the transaction is refused, and says by how much', () => {
  const m = S.createSplitModel(100, [
    { qbo_account_id: 'loan', amountText: '60' }, { qbo_account_id: 'interest', amountText: '30' },
  ], refs);
  assert.equal(m.ready(), false);
  assert.match(m.problems().join(' '), /\$10\.00 of this transaction is not allocated/);
  m.set(1, 'amount', '50');
  assert.match(m.problems().join(' '), /over by \$10\.00/);
  m.set(1, 'amount', '40');
  assert.deepEqual(m.problems(), []);
});

test('the parts a person must supply are each named', () => {
  const m = S.createSplitModel(100, [{ amountText: '' }, { qbo_account_id: 'interest', amountText: '0' }], refs);
  const problems = m.problems().join(' | ');
  assert.match(problems, /Line 1 needs an account/);
  assert.match(problems, /Line 1 needs an amount/);
  assert.match(problems, /Line 2 is zero/);
});

test('one line is not a split and is refused rather than quietly saved', () => {
  const m = S.createSplitModel(100, [{ qbo_account_id: 'loan', amountText: '100' }], refs);
  assert.match(m.problems().join(' '), /at least two lines/);
  m.remove(0);
  assert.equal(m.count(), 0);
  assert.match(m.problems().join(' '), /at least two lines/);
});

test('an unreadable amount is reported as unreadable, not silently treated as zero', () => {
  const m = S.createSplitModel(100, [
    { qbo_account_id: 'loan', amountText: '60' }, { qbo_account_id: 'interest', amountText: 'forty' },
  ], refs);
  const problems = m.problems().join(' | ');
  assert.match(problems, /"forty" is not a number/);
  assert.ok(!/not allocated yet/.test(problems),
    'a total computed over a box nobody could read would name a false shortfall');
});

test('a receivable line needs its customer before the round trip, as QuickBooks will demand', () => {
  const m = S.createSplitModel(100, [
    { qbo_account_id: 'ar', amountText: '60' }, { qbo_account_id: 'interest', amountText: '40' },
  ], refs);
  assert.match(m.problems().join(' '), /receivable or payable account, so QuickBooks needs a customer or vendor/);
  m.set(0, 'entity', 'Customer:sugar');
  assert.deepEqual(m.problems(), []);
  assert.equal(m.lines()[0].entity_name, 'Sugar Hill');
  // Moving that line to an expense account drops an entity that no longer belongs.
  m.set(0, 'account', 'interest');
  assert.equal(m.lines()[0].entity_qbo_id, '');
});

test('the remainder refuses to write a zero line', () => {
  const m = S.createSplitModel(100, [
    { qbo_account_id: 'loan', amountText: '100' }, { qbo_account_id: 'interest', amountText: '' },
  ], refs);
  const result = m.useRemainder(1);
  assert.equal(result.ok, false);
  assert.match(result.error, /nothing left/);
  assert.equal(m.lines()[1].amountText, '');
});

// ── the rule contract ───────────────────────────────────────────────────
test('applying a saved split fills the accounts and leaves EVERY amount blank', () => {
  const m = S.createSplitModel(25187.68, null, refs);
  m.applyShape([
    { line_no: 2, qbo_account_id: 'interest', qbo_account_name: 'Interest Expense', memo_template: 'interest' },
    { line_no: 1, qbo_account_id: 'loan', qbo_account_name: 'Columbia Bank LOC', amount: 21453.19 },
  ]);
  assert.deepEqual(m.lines().map((l) => l.qbo_account_id), ['loan', 'interest'], 'ordered by line_no');
  assert.deepEqual(m.lines().map((l) => l.amountText), ['', ''],
    'a remembered amount would be wrong every month and look authoritative');
  assert.equal(m.lines()[1].memo, 'interest');
  assert.equal(m.ready(), false);
  assert.match(m.problems().join(' '), /Line 1 needs an amount/);
});

// ── one definition of a posted line ─────────────────────────────────────
test('effectiveLines mirrors card_coding_effective_lines: split lines, or the row itself', () => {
  const txn = { id: 't1', amount: 100, qbo_account_id: 'fees', qbo_account_name: 'Bank Charges', qbo_location_id: 'hq' };
  assert.deepEqual(S.effectiveLines(txn, []).map((l) => [l.qbo_account_id, l.amount, l.is_split]), [['fees', 100, false]]);
  const lines = S.effectiveLines({ ...txn, qbo_account_id: null }, [
    { line_no: 2, amount: '40.00', qbo_account_id: 'interest' },
    { line_no: 1, amount: '60.00', qbo_account_id: 'loan' },
  ]);
  assert.deepEqual(lines.map((l) => [l.line_no, l.qbo_account_id, l.amount, l.is_split]),
    [[1, 'loan', 60, true], [2, 'interest', 40, true]]);
});

// ── the drawer ──────────────────────────────────────────────────────────
class El {
  constructor() { this.value = ''; this.events = {}; this.hidden = false; this.disabled = false; this.checked = false; this._html = ''; this.textContent = ''; }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  addEventListener(name, fn) { this.events[name] = fn; }
  querySelectorAll(selector) {
    if (selector !== '[data-selected]') return [];
    const known = new Set(['', 'loan', 'interest', 'fees', 'ar', 'hq', 'Customer:sugar']);
    return [...this._html.matchAll(/data-selected="([^"]*)"/g)].map((m) => ({
      dataset: { selected: m[1] }, extra: '', _v: '',
      set value(v) { this._v = known.has(v) ? v : ''; },
      get value() { return this._v; },
      insertAdjacentHTML(_, html) { this.extra += html; known.add(this.dataset.selected); },
    }));
  }
}

function harness({ splits = [], suggestion = { lines: [] }, saveError = '', onSavedError = '', amount = 25187.68 } = {}) {
  const nodes = new Map();
  const el = (id) => { if (!nodes.has(id)) nodes.set(id, new El()); return nodes.get(id); };
  const calls = [];
  const db = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'suggest_card_transaction_splits') return { data: suggestion };
      if (saveError && args.p_splits && args.p_splits.length) return { error: { message: saveError } };
      return { data: { lines: (args.p_splits || []).length, total: amount, status: (args.p_splits || []).length ? 'coded' : 'uncoded' } };
    },
  };
  const api = load({ getElementById: el });
  api.mount({ el });
  const saved = [];
  const txn = { id: 'txn-1', amount, txn_date: '2026-09-01', description: 'COLUMBIA BANK <script>x</script>' };
  const open = () => api.open({
    db, el, txn, splits,
    options: { accounts: '<option value="loan">Columbia Bank LOC</option><option value="interest">Interest Expense</option>', locations: '', entities: '' },
    refs,
    onSaved: (result) => {
      if (onSavedError) throw new Error(onSavedError);
      saved.push(result);
    },
  });
  const fire = (id, event, target) => el(id).events[event]({ target });
  const lineTarget = (index, { field, button } = {}) => ({
    dataset: field ? { field } : {},
    value: '',
    closest: (sel) => (sel === '[data-line]' ? { dataset: { line: String(index) } }
      : sel === `[${button}]` ? {} : null),
  });
  return { el, calls, saved, open, fire, lineTarget, api };
}

test('opening renders one row per line, escapes the description, and asks for a saved split', async () => {
  const h = harness();
  h.open();
  await settle();
  assert.equal(h.el('splitDrawer').hidden, false);
  assert.equal((h.el('splitLines').innerHTML.match(/data-line="/g) || []).length, 2, 'a new split starts with two empty lines');
  assert.ok(h.el('splitSub').textContent.includes('<script>x</script>'),
    'the header is set as text, so a description needs no escaping and loses nothing');
  assert.match(h.el('splitTotals').innerHTML, /\$25,187\.68/);
  assert.match(h.el('splitTotals').innerHTML, /Left to allocate/);
  assert.equal(h.el('btnSplitSave').disabled, true, 'nothing is enterable yet, so nothing is savable');
  assert.deepEqual(h.calls.map((c) => c.name), ['suggest_card_transaction_splits']);
});

test('a saved split is applied on open with its amounts blank, and the person is told why', async () => {
  const h = harness({ suggestion: { rule_id: 'r1', conflict: false, lines: [
    { line_no: 1, qbo_account_id: 'loan', qbo_account_name: 'Columbia Bank LOC', amount: null },
    { line_no: 2, qbo_account_id: 'interest', qbo_account_name: 'Interest Expense', amount: null },
  ] } });
  h.open();
  await settle();
  assert.match(h.el('splitStatus').textContent, /never remembers amounts/);
  assert.match(h.el('splitLines').innerHTML, /data-selected="loan"/);
  assert.match(h.el('splitLines').innerHTML, /data-selected="interest"/);
  assert.equal((h.el('splitLines').innerHTML.match(/value="" placeholder="0\.00"/g) || []).length, 2,
    'both amount boxes are empty');
  assert.equal(h.el('btnSplitSave').disabled, true);
});

test('a merchant rule and a card rule that disagree apply nothing and say so', async () => {
  const h = harness({ suggestion: { conflict: true, reason: 'A merchant rule and a card rule split this differently; neither is applied' } });
  h.open();
  await settle();
  assert.match(h.el('splitStatus').textContent, /neither is applied/);
  assert.ok(!h.el('splitLines').innerHTML.includes('data-selected="loan"'));
});

test('typing the two amounts ties the split, enables save, and sends fixed-point strings', async () => {
  const h = harness();
  h.open();
  await settle();
  h.fire('splitLines', 'change', Object.assign(h.lineTarget(0, { field: 'account' }), { value: 'loan' }));
  h.fire('splitLines', 'change', Object.assign(h.lineTarget(1, { field: 'account' }), { value: 'interest' }));
  h.fire('splitLines', 'input', Object.assign(h.lineTarget(0, { field: 'amount' }), { value: '21,453.19' }));
  assert.equal(h.el('btnSplitSave').disabled, true);
  assert.match(h.el('splitTotals').innerHTML, /\$3,734\.49/);
  h.fire('splitLines', 'input', Object.assign(h.lineTarget(1, { field: 'amount' }), { value: '3734.49' }));
  assert.equal(h.el('btnSplitSave').disabled, false);
  assert.match(h.el('splitTotals').innerHTML, /ties/);

  h.el('splitLearn').checked = true;
  h.el('splitMatch').value = 'card_name';
  h.el('btnSplitSave').events.click({});
  await settle();
  const save = h.calls.find((c) => c.name === 'set_card_transaction_splits');
  assert.deepEqual(save.args.p_splits.map((l) => l.amount), ['21453.19', '3734.49']);
  assert.equal(save.args.p_learn_rule, true);
  assert.equal(save.args.p_rule_match, 'card_name');
  assert.equal(h.el('splitDrawer').hidden, true);
  assert.equal(h.saved.length, 1);
});

test('an incomplete split is never written, even if the save button is reached', async () => {
  const h = harness();
  h.open();
  await settle();
  h.fire('splitLines', 'change', Object.assign(h.lineTarget(0, { field: 'account' }), { value: 'loan' }));
  h.fire('splitLines', 'input', Object.assign(h.lineTarget(0, { field: 'amount' }), { value: '20000' }));
  h.el('btnSplitSave').events.click({});
  await settle();
  assert.ok(!h.calls.some((c) => c.name === 'set_card_transaction_splits'),
    'a split that does not total the transaction must not reach the database');
  assert.equal(h.el('splitDrawer').hidden, false);
  assert.equal(h.saved.length, 0);
});

test('a database refusal keeps the drawer open, reports it, and never calls back as saved', async () => {
  const h = harness({ saveError: 'Split lines total 100.00 but the transaction is 25187.68' });
  h.open();
  await settle();
  h.fire('splitLines', 'change', Object.assign(h.lineTarget(0, { field: 'account' }), { value: 'loan' }));
  h.fire('splitLines', 'change', Object.assign(h.lineTarget(1, { field: 'account' }), { value: 'interest' }));
  h.fire('splitLines', 'input', Object.assign(h.lineTarget(0, { field: 'amount' }), { value: '25000' }));
  h.fire('splitLines', 'input', Object.assign(h.lineTarget(1, { field: 'amount' }), { value: '187.68' }));
  h.el('btnSplitSave').events.click({});
  await settle();
  assert.equal(h.el('splitDrawer').hidden, false);
  assert.match(h.el('splitStatus').textContent, /was not saved/);
  assert.equal(h.saved.length, 0);
  assert.equal(h.el('btnSplitSave').disabled, false, 'the save can be retried after the amounts are corrected');
});

test('a save the database accepted is never reported as unsaved when the page cannot reload it', async () => {
  const h = harness({ onSavedError: 'network' });
  h.open();
  await settle();
  h.fire('splitLines', 'change', Object.assign(h.lineTarget(0, { field: 'account' }), { value: 'loan' }));
  h.fire('splitLines', 'change', Object.assign(h.lineTarget(1, { field: 'account' }), { value: 'interest' }));
  h.fire('splitLines', 'input', Object.assign(h.lineTarget(0, { field: 'amount' }), { value: '25000' }));
  h.fire('splitLines', 'input', Object.assign(h.lineTarget(1, { field: 'amount' }), { value: '187.68' }));
  h.el('btnSplitSave').events.click({});
  await settle();
  assert.ok(h.calls.some((c) => c.name === 'set_card_transaction_splits'), 'the write did happen');
  assert.match(h.el('splitStatus').textContent, /was saved, but this page could not reload it/);
  assert.ok(!/was not saved/.test(h.el('splitStatus').textContent),
    'telling someone an accepted split failed sends them to enter it twice');
  assert.match(h.el('splitStatus').textContent, /Reload the page before approving/);
});

test('an existing split opens with its stored amounts and can be removed entirely', async () => {
  const h = harness({ splits: [
    { line_no: 1, amount: '21453.19', qbo_account_id: 'loan', qbo_account_name: 'Columbia Bank LOC' },
    { line_no: 2, amount: '3734.49', qbo_account_id: 'interest', qbo_account_name: 'Interest Expense' },
  ] });
  h.open();
  await settle();
  assert.ok(!h.calls.some((c) => c.name === 'suggest_card_transaction_splits'),
    'an already split row is not offered a rule that would discard its lines');
  assert.match(h.el('splitLines').innerHTML, /value="21453\.19"/);
  assert.match(h.el('splitTotals').innerHTML, /ties/);
  assert.equal(h.el('btnSplitSave').disabled, false);
  h.el('btnSplitClear').events.click({});
  await settle();
  const clear = h.calls.find((c) => c.name === 'set_card_transaction_splits');
  assert.deepEqual(clear.args.p_splits, []);
  assert.equal(clear.args.p_learn_rule, false);
  assert.equal(h.el('splitDrawer').hidden, true);
});

test('the remainder button and add/remove work through the rendered rows', async () => {
  const h = harness();
  h.open();
  await settle();
  h.fire('splitLines', 'change', Object.assign(h.lineTarget(0, { field: 'account' }), { value: 'loan' }));
  h.fire('splitLines', 'input', Object.assign(h.lineTarget(0, { field: 'amount' }), { value: '20000' }));
  h.el('btnSplitAdd').events.click({});
  assert.equal((h.el('splitLines').innerHTML.match(/data-line="/g) || []).length, 3);
  h.fire('splitLines', 'click', h.lineTarget(2, { button: 'data-remainder' }));
  assert.match(h.el('splitLines').innerHTML, /value="5187\.68"/);
  h.fire('splitLines', 'click', h.lineTarget(1, { button: 'data-drop' }));
  assert.equal((h.el('splitLines').innerHTML.match(/data-line="/g) || []).length, 2);
  assert.match(h.el('splitTotals').innerHTML, /ties/);
});

test('a stored account QuickBooks no longer offers is shown, not silently blanked', async () => {
  const h = harness({ splits: [
    { line_no: 1, amount: '100.00', qbo_account_id: 'retired-account', qbo_account_name: 'Old Account' },
    { line_no: 2, amount: '25087.68', qbo_account_id: 'interest' },
  ] });
  h.open();
  await settle();
  const fields = h.el('splitLines').querySelectorAll('[data-selected]');
  assert.equal(fields[0].dataset.selected, 'retired-account');
});

test('a memo cannot inject markup into the editor', async () => {
  const h = harness({ splits: [
    { line_no: 1, amount: '100.00', qbo_account_id: 'loan', memo: '"><img src=x onerror=alert(1)>' },
    { line_no: 2, amount: '25087.68', qbo_account_id: 'interest', memo: '' },
  ] });
  h.open();
  await settle();
  assert.ok(!h.el('splitLines').innerHTML.includes('<img'), 'a memo must not become an element');
  assert.match(h.el('splitLines').innerHTML, /&quot;&gt;&lt;img/);
});

test('an unallocated remainder is reported as a problem a person can read', async () => {
  const h = harness();
  h.open();
  await settle();
  h.fire('splitLines', 'change', Object.assign(h.lineTarget(0, { field: 'account' }), { value: 'loan' }));
  h.fire('splitLines', 'input', Object.assign(h.lineTarget(0, { field: 'amount' }), { value: '20000' }));
  assert.equal(h.el('splitProblems').hidden, false);
  assert.match(h.el('splitProblems').innerHTML, /5,187\.68 of this transaction is not allocated/);
  assert.match(h.el('splitProblems').innerHTML, /Line 2 needs an account/);
});

test('describe names the split for the row that shows no account of its own', () => {
  assert.equal(S.describe([
    { line_no: 2, qbo_account_name: 'Interest Expense' }, { line_no: 1, qbo_account_name: 'Columbia Bank LOC' },
  ]), 'Split · 2 accounts — Columbia Bank LOC, Interest Expense');
  assert.equal(S.describe([]), '');
});
