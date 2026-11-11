/* Who keeps this company's books (accounting_settings.bookkeeping_mode).
 *
 * The card asks one question with two answers and no third, and one of those
 * answers switches off every send SILO makes. So the tests pin what could do
 * quiet harm: a company that never answered reported as something other than
 * what SILO actually does, a takeover date accepted that stops the month in
 * hand, and a confirmation that does not say what handing the books back
 * actually costs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const window = {};
vm.runInNewContext(await readFile(new URL('../../v2/accounting-posting-start.js', import.meta.url), 'utf8'),
  { window, CSS: { escape: (s) => String(s) } });
vm.runInNewContext(await readFile(new URL('../../v2/accounting-mode.js', import.meta.url), 'utf8'),
  { window, CSS: { escape: (s) => String(s) } });
const M = window.SiloBooksMode;

const TODAY = '2026-10-15';
const BOOKS = '2026-08-01';

test('a company that never answered reads as what SILO actually does, not as unset', () => {
  assert.equal(M.stateLabel(null), 'SILO keeps the books');
  assert.equal(M.stateLabel({ bookkeeping_mode: 'silo' }), 'SILO keeps the books');
  assert.doesNotMatch(M.stateLabel(null), /not set|missing|unknown|choose|configure/i,
    'the default is a position, not a gap for the reader to fill');
  assert.match(M.stateLabel({ bookkeeping_mode: 'silo', silo_takeover_on: '2026-09-01' }),
    /from September 1, 2026/, 'a date in a sentence reads as a day, never as 2026-09-01');
  assert.match(M.stateLabel({ bookkeeping_mode: 'qbo' }), /QuickBooks keeps the books/);
  assert.match(M.stateLabel({ bookkeeping_mode: 'qbo' }), /sends nothing/,
    'the consequence is the half the reader needs');
});

test('a takeover date that would stop the month in hand is refused before anything is written', () => {
  assert.equal(M.validate('silo', '2026-09-01', TODAY, BOOKS), '', 'the real case must pass');
  assert.equal(M.validate('silo', '', TODAY, BOOKS), '', 'no date means every period is SILO’s');
  assert.equal(M.validate('silo', TODAY, TODAY, BOOKS), '', 'today itself is a legitimate takeover day');
  assert.match(M.validate('silo', '2026-12-01', TODAY, BOOKS), /in the future/,
    'a date ahead of today would stop SILO posting the months being worked on now');
  assert.match(M.validate('silo', '2026-07-01', TODAY, BOOKS), /books start/,
    'before the books start it would read as a setting that did not take');
  assert.match(M.validate('silo', 'september', TODAY, BOOKS), /YYYY-MM-DD/);
  assert.equal(M.validate('qbo', '2026-12-01', TODAY, BOOKS), '',
    'the date belongs to the other answer and is not judged here');
});

test('handing the books back says what it costs, in full, before it happens', () => {
  const text = M.confirmText('qbo', '');
  for (const surface of [/bank and card coding/, /revenue journals/, /schedules/, /fixed assets/, /adjustments/]) {
    assert.match(text, surface, 'every surface that stops sending is named');
  }
  assert.match(text, /recorded but never sent is reversed/,
    'the reversal promise is true only for what was never sent: an approved or posted month is not reversed');
  assert.match(text, /already posted to QuickBooks stay exactly as they are/);
  assert.match(text, /Nothing is deleted/);
  assert.match(text, /nothing is sent/i);
  assert.doesNotMatch(text, /QuickBooks will be changed|removed from QuickBooks/,
    'nothing already in QuickBooks is touched, and the text must not suggest it is');
});

test('choosing SILO says what the date does, and what it does not override', () => {
  const dated = M.confirmText('silo', '2026-09-01');
  assert.match(dated, /from September 1, 2026/);
  assert.match(dated, /cannot be approved or posted/);
  assert.match(dated, /leave On Deck/);
  assert.match(dated, /explicit date.*overrides this default/, 'an account that came onboard later keeps its own date');
  assert.match(M.confirmText('silo', ''), /every period/);
  assert.match(M.confirmText('silo', ''), /Nothing is sent by saving this/,
    'saving a setting must never read as a send');
});

// Run the mounted event/RPC path, not only exported wording helpers. Database
// responses are synthetic here; enforcement is exercised in the SQL suites.
async function mounted({ version = 4, rpc, confirm = async () => true, oldSchema = false } = {}) {
  const calls = [];
  const listeners = {};
  const controls = {
    '[data-mode-status]': { innerHTML: '' },
    '[data-mode-form]': { innerHTML: '' },
    '[data-mode-label]': { textContent: '' },
    'input[name="booksMode"]:checked': { value: 'silo' },
    '[data-takeover]': { value: '' },
  };
  const host = { hidden: false, querySelector: (s) => controls[s] ||= { innerHTML: '' }, addEventListener: (type, fn) => { listeners[type] = fn; } };
  const saved = { bookkeeping_mode: 'silo', silo_takeover_on: null, accounting_start_date: BOOKS,
    ...(oldSchema ? {} : { bookkeeping_version: version }) };
  const db = {
    from(table) {
      const result = { data: table === 'accounting_settings' ? saved : [{ id: 'source-a', display_name: 'Bank' }] };
      return { select() { return this; }, eq() { return this; }, maybeSingle: async () => result, order: async () => result };
    },
    async rpc(name, args) {
      calls.push({ name, args: { ...args } });
      if (rpc) return rpc(name, args, calls);
      if (name === 'silo_ledger_resync_posting_start') return { data: 0 };
      return { data: { ...saved, bookkeeping_mode: args.p_mode, silo_takeover_on: args.p_takeover,
        ...(oldSchema ? {} : { bookkeeping_version: args.p_expected_version + (args.p_expected_version === version ? 1 : 0) }) } };
    },
  };
  const localWindow = { SiloFinanceDialog: { ask: confirm } };
  vm.runInNewContext(await readFile(new URL('../../v2/accounting-mode.js', import.meta.url), 'utf8'),
    { window: localWindow, CSS: { escape: String } });
  await localWindow.SiloBooksMode.mount({ db, companyId: 'company-a', el: () => host, businessToday: TODAY, booksStart: BOOKS });
  const click = () => {
    const button = { disabled: false };
    listeners.click({ target: { closest: () => button } });
    return button;
  };
  const drain = async () => { for (let i = 0; i < 15; i++) await new Promise(setImmediate); };
  return { calls, controls, click, drain, text: () => controls['[data-mode-status]'].innerHTML };
}

test('mounted save binds the reviewed company/version and checks again after ledger catch-up', async () => {
  const ui = await mounted();
  ui.controls['input[name="booksMode"]:checked'].value = 'qbo';
  ui.click(); await ui.drain();
  assert.equal(ui.calls[0].name, 'set_bookkeeping_mode_checked');
  assert.deepEqual(ui.calls[0].args, { p_mode: 'qbo', p_takeover: null, p_company: 'company-a', p_expected_version: 4 });
  assert.equal(ui.calls[1].name, 'silo_ledger_resync_posting_start');
  assert.equal(ui.calls[2].name, 'set_bookkeeping_mode_checked');
  assert.equal(ui.calls[2].args.p_expected_version, 5);
  assert.match(ui.text(), /Saved/);
});

test('stale or refused checked save never falls back or starts catch-up', async () => {
  const ui = await mounted({ rpc: async () => ({ error: { code: 'P0BM4', message: 'The setting changed since review' } }) });
  ui.controls['input[name="booksMode"]:checked'].value = 'qbo';
  ui.click(); await ui.drain();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].name, 'set_bookkeeping_mode_checked');
  assert.match(ui.text(), /Reload/);
  assert.doesNotMatch(ui.text(), /Saved\./);
});

test('unchanged Save still checks the reviewed version before catch-up', async () => {
  const ui = await mounted({ confirm: async () => { throw new Error('unchanged must not reconfirm'); } });
  ui.click(); await ui.drain();
  assert.equal(ui.calls[0].name, 'set_bookkeeping_mode_checked');
  assert.equal(ui.calls[0].args.p_expected_version, 4);
});

test('assets before migration preserve the old RPC without downgrading checked failures', async () => {
  const ui = await mounted({ oldSchema: true });
  ui.controls['input[name="booksMode"]:checked'].value = 'qbo';
  ui.click(); await ui.drain();
  assert.equal(ui.calls[0].name, 'set_bookkeeping_mode');
  assert.equal('p_expected_version' in ui.calls[0].args, false);
  assert.equal(ui.calls[1].name, 'silo_ledger_resync_posting_start');
});

test('cancel and rapid repeated clicks do not dispatch duplicate decisions', async () => {
  let release;
  const ui = await mounted({ confirm: () => new Promise((r) => { release = r; }) });
  ui.controls['input[name="booksMode"]:checked'].value = 'qbo';
  const first = ui.click(); ui.click();
  await ui.drain();
  assert.equal(ui.calls.length, 0);
  release(false); await ui.drain();
  assert.equal(ui.calls.length, 0);
  assert.equal(first.disabled, false);
});

test('a setting changed during catch-up is not reported as current', async () => {
  let checks = 0;
  const ui = await mounted({ rpc: async (name, args) => {
    if (name === 'silo_ledger_resync_posting_start') return { data: 0 };
    if (++checks === 1) return { data: { bookkeeping_mode: args.p_mode, silo_takeover_on: null, bookkeeping_version: 5 } };
    return { error: { code: 'P0BM4', message: 'Changed in another tab' } };
  } });
  ui.controls['input[name="booksMode"]:checked'].value = 'qbo';
  ui.click(); await ui.drain();
  assert.match(ui.text(), /could not be confirmed after ledger catch-up/);
  assert.doesNotMatch(ui.text(), /Nothing was sent to QuickBooks/);
});
