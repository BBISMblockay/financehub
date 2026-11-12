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
  assert.match(M.validate('silo', '2026-12-01', TODAY, BOOKS), /Latest is October 15, 2026/,
    'a date ahead of the window would stop SILO posting the months being worked on now');
  assert.match(M.validate('silo', '2026-07-01', TODAY, BOOKS), /Earliest is August 1, 2026/,
    'before the window opens it would read as a setting that did not take');
  assert.match(M.validate('silo', 'september', TODAY, BOOKS), /YYYY-MM-DD/);
  assert.equal(M.validate('qbo', '2026-12-01', TODAY, BOOKS), '',
    'the date belongs to the other answer and is not judged here');
});

test('the takeover window is the company\u2019s own, not a rule written twice', () => {
  /* The server enforces accounting_settings.takeover_earliest_on /
     takeover_latest_on, falling back to the books start and the business day.
     The picker reads the same two columns, so it cannot offer a date the save
     will refuse. */
  const plain = (w) => [w.earliest, w.latest];
  assert.deepEqual(plain(M.windowFor({ accounting_start_date: BOOKS }, TODAY, BOOKS)), [BOOKS, TODAY]);
  assert.deepEqual(
    plain(M.windowFor({ takeover_earliest_on: '2026-09-01', takeover_latest_on: '2026-09-30' }, TODAY, BOOKS)),
    ['2026-09-01', '2026-09-30']);
  assert.equal(M.validate('silo', '2026-09-15', '2026-09-30', '2026-09-01'), '', 'inside a narrowed window');
  assert.match(M.validate('silo', '2026-08-15', '2026-09-30', '2026-09-01'), /Earliest is September 1, 2026/);
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
  assert.match(dated, /own date still wins/, 'an account that came onboard later keeps its own date');
  assert.match(M.confirmText('silo', ''), /every period/);
  assert.match(M.confirmText('silo', ''), /Nothing is sent by saving this/,
    'saving a setting must never read as a send');
});

// Run the mounted event/RPC path, not only exported wording helpers. Database
// responses are synthetic here; enforcement is exercised in the SQL suites.
async function mounted({ version = 4, rpc, confirm = async () => true, oldSchema = false, after = null, readFails = false, stored = null } = {}) {
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
    ...(oldSchema ? {} : { bookkeeping_version: version }), ...(stored || {}) };
  let settingsReads = 0;
  let committed = null;
  const db = {
    from(table) {
      if (table === 'accounting_settings') settingsReads += 1;
      // `after` is what a LATER read of the row returns: the catch-up loop can
      // run for minutes and another finance tab can commit inside it.
      const row = table === 'accounting_settings'
        ? (settingsReads > 1 ? (after || committed || saved) : saved) : null;
      const result = (table === 'accounting_settings' && readFails && settingsReads > 1)
        ? { data: null, error: { message: 'network' } }
        : { data: row || [{ id: 'source-a', display_name: 'Bank' }] };
      return { select() { return this; }, eq() { return this; }, maybeSingle: async () => result, order: async () => result };
    },
    async rpc(name, args) {
      calls.push({ name, args: { ...args } });
      if (rpc) return rpc(name, args, calls);
      if (name === 'silo_ledger_resync_posting_start') return { data: 0 };
      committed = { ...saved, bookkeeping_mode: args.p_mode, silo_takeover_on: args.p_takeover,
        ...(oldSchema ? {} : { bookkeeping_version: args.p_expected_version + (args.p_expected_version === version ? 1 : 0) }) };
      return { data: committed };
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
  return { calls, controls, click, drain, reads: () => settingsReads,
    text: () => controls['[data-mode-status]'].innerHTML,
    state: () => controls['[data-mode-state]'].textContent,
    list: () => controls['[data-mode-blockers]']?.innerHTML || '' };
}

test('mounted save binds the reviewed company/version and reports the committed setting', async () => {
  const ui = await mounted();
  ui.controls['input[name="booksMode"]:checked'].value = 'qbo';
  ui.click(); await ui.drain();
  assert.equal(ui.calls[0].name, 'set_bookkeeping_mode_checked');
  assert.deepEqual(ui.calls[0].args, { p_mode: 'qbo', p_takeover: null, p_company: 'company-a', p_expected_version: 4 });
  assert.equal(ui.calls[1].name, 'silo_ledger_resync_posting_start');
  assert.equal(ui.calls.length, 2, 'the catch-up is followed by a read, not a second write');
  assert.ok(ui.reads() > 1, 'the setting in force is read back after the catch-up');
  assert.match(ui.text(), /Saved/);
  assert.match(ui.text(), /Nothing was sent to QuickBooks/);
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

test('unchanged Save resumes the ledger catch-up and writes nothing', async () => {
  /* Pressing Save with nothing changed is the documented way to resume a
     catch-up that could not finish in one pass. It must not depend on the mode
     version, or a tab that saved in between leaves the ledger half reconciled
     with no way to carry on. */
  const ui = await mounted({ version: 4, confirm: async () => { throw new Error('unchanged must not reconfirm'); } });
  ui.click(); await ui.drain();
  assert.deepEqual(ui.calls.map((c) => c.name), ['silo_ledger_resync_posting_start']);
  assert.match(ui.text(), /Ledger checked/);
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

test('a setting changed during catch-up is reported as what is now in force', async () => {
  const ui = await mounted({ after: { bookkeeping_mode: 'silo', silo_takeover_on: null,
    accounting_start_date: BOOKS, bookkeeping_version: 6 } });
  ui.controls['input[name="booksMode"]:checked'].value = 'qbo';
  ui.click(); await ui.drain();
  assert.match(ui.text(), /Changed in another tab/);
  assert.match(ui.text(), /SILO keeps the books/, 'the setting in force, not the one this press chose');
  assert.doesNotMatch(ui.text(), /QuickBooks keeps the books/);
});

test('a refused handover offers the item, not an id', async () => {
  /* A count, or a uuid, asks the reader to go and find something. Each row
     carries the page that reviews it, so the card offers the action. */
  const ui = await mounted({ rpc: async (name) => {
    if (name === 'silo_handover_blockers') {
      return { data: [
        { kind: 'post', reference: 'batch-1', title: 'September bank coding', status: 'unknown',
          period_end: '2026-09-30', blocks_handover: true, account: 'Synthetic bank',
          reason: 'Check in QuickBooks',
          action_label: 'Review', review_path: '/v2/transactions.html?batch=batch-1' },
        { kind: 'import', reference: 'old-1', title: 'July setup import', status: 'approved',
          period_end: '2026-07-31', blocks_handover: false, account: 'Synthetic bank',
          reason: 'Approved during setup. Not in the way.',
          action_label: 'Review', review_path: '/v2/transactions.html?batch=old-1' },
      ] };
    }
    return { error: { code: 'P0BM3', message: 'SILO has 1 QuickBooks post(s) still in progress: Synthetic bank was sent with no answer from QuickBooks (Sep 2026).' } };
  } });
  ui.controls['input[name="booksMode"]:checked'].value = 'qbo';
  ui.click(); await ui.drain();
  assert.deepEqual(ui.calls.map((c) => c.name), ['set_bookkeeping_mode_checked', 'silo_handover_blockers'],
    'no ledger catch-up runs after a refused handover');
  assert.match(ui.list(), /September bank coding/);
  assert.match(ui.list(), /Review/);
  assert.match(ui.list(), /href="\/v2\/transactions\.html\?batch=batch-1&amp;company=company-a"/,
    'a direct link to the item, carrying the company');
  assert.doesNotMatch(ui.list(), /July setup import/, 'setup history is not what the reader has to go and clear');
  assert.match(ui.text(), /Nothing was saved or sent/);
  assert.doesNotMatch(ui.text(), /Reload Books/, 'reloading does not clear an unresolved post');
});

test('an old stored date never blocks resuming the ledger catch-up', async () => {
  /* The input is prefilled with what is stored, and a stored date can sit
     outside a window tightened since. Judging it on a press that changes
     nothing would take away the only way to finish the reconciliation. */
  // Stored two months before the window this company now accepts.
  const ui = await mounted({ stored: { silo_takeover_on: '2026-07-01', takeover_earliest_on: '2026-09-01' } });
  // The real card renders the input with value="2026-07-01"; the synthetic
  // controls do not parse HTML, so the prefill is set here.
  ui.controls['[data-takeover]'].value = '2026-07-01';
  ui.controls['input[name="booksMode"]:checked'].value = 'silo';
  ui.click(); await ui.drain();
  assert.deepEqual(ui.calls.map((c) => c.name), ['silo_ledger_resync_posting_start'],
    'it resumes the catch-up and writes nothing');
  assert.match(ui.text(), /Ledger checked/);
  // Choosing a NEW date out of the window is still refused.
  ui.controls['[data-takeover]'].value = '2026-07-15';
  ui.click(); await ui.drain();
  // The mounted harness has no SiloPostingStart, so dates stay unformatted here.
  assert.match(ui.text(), /Earliest is (September 1, 2026|2026-09-01)/);
});

test('a setting that could not be read back is never shown as current', async () => {
  const ui = await mounted({ readFails: true });
  ui.controls['input[name="booksMode"]:checked'].value = 'qbo';
  ui.click(); await ui.drain();
  assert.match(ui.text(), /[Cc]ould not read the setting back/);
  assert.match(ui.state(), /not confirmed/i, 'the headline state says so too');
  assert.doesNotMatch(ui.text(), /QuickBooks keeps the books · SILO sends nothing/,
    'a state SILO could not confirm is not asserted');
});
