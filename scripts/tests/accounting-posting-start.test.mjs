/* When SILO starts posting an account (card_sources.posting_start_on).
 *
 * The control writes a date that silences a month: earlier periods can no
 * longer be approved or posted, and SILO's ledger reverses what it recorded for
 * them. So the tests pin the three things that could do quiet harm -- a date
 * accepted that changes nothing or stops the current month, a save reported as
 * done when RLS refused it, and a paged reversal reported as finished when it
 * stopped partway.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const window = {};
const CSS = { escape: (s) => String(s) };
vm.runInNewContext(await readFile(new URL('../../v2/accounting-posting-start.js', import.meta.url), 'utf8'),
  { window, CSS });
const P = window.SiloPostingStart;

const SOURCE = { id: 's1', source_key: 'bbism_operating', display_name: 'Baseballism Operating',
  is_active: true, posting_enabled: true, authoritative_from: '2026-07-01', posting_start_on: null };
const TODAY = '2026-10-15';
const BOOKS = '2026-08-01';

test('an account with no cut-over says so plainly: it is the normal state, not a warning', () => {
  assert.equal(P.stateLabel(SOURCE), 'Every period is SILO’s to post');
  assert.doesNotMatch(P.stateLabel(SOURCE), /not set|missing|unknown|configure/i);
  assert.match(P.stateLabel({ posting_start_on: '2026-09-01' }), /SILO posts from September 1, 2026/);
  assert.match(P.stateLabel({ posting_start_on: '2026-09-01' }), /handled outside SILO/,
    'the whole point of the date is what it says about the earlier months');
});

test('a date that would change nothing, or stop the month in hand, is refused before anything is written', () => {
  assert.equal(P.validate('2026-09-01', SOURCE, TODAY, BOOKS), '', 'the real case must pass');
  assert.equal(P.validate('', SOURCE, TODAY, BOOKS), '', 'clearing it is allowed');
  assert.match(P.validate('2026-12-01', SOURCE, TODAY, BOOKS), /in the future/,
    'a cut-over ahead of today would silently stop the months being worked on now');
  assert.match(P.validate(TODAY, SOURCE, TODAY, BOOKS), /^$/, 'today itself is a legitimate cut-over');
  assert.match(P.validate('2026-08-01', SOURCE, TODAY, BOOKS), /change nothing/,
    'silo_ledger_start takes the greatest of the two, so on the books start it is a no-op');
  assert.match(P.validate('2026-07-01', SOURCE, TODAY, BOOKS), /change nothing/);
  assert.match(P.validate('09/01/2026', SOURCE, TODAY, BOOKS), /YYYY-MM-DD/);
  // A missing business date must not become a licence to set anything.
  assert.equal(P.validate('2026-09-01', SOURCE, '', ''), '');
});

test('the confirmation names both halves of what saving does, and that QuickBooks is untouched', () => {
  const text = P.confirmText(SOURCE, '2026-09-01', null);
  assert.match(text, /Baseballism Operating/);
  assert.match(text, /September 1, 2026/);
  assert.match(text, /no longer be approved or posted/);
  assert.match(text, /already recorded for them is reversed/);
  assert.match(text, /roll-forward/, 'what the reversal is FOR is the half that answers "why does my ledger change"');
  assert.match(text, /On Deck/);
  assert.match(text, /[Nn]othing is sent to or changed in QuickBooks/);
  assert.match(text, /nothing is deleted/i, 'ledger_entries is append-only; say so');
  const cleared = P.confirmText(SOURCE, '', '2026-09-01');
  assert.match(cleared, /Every period becomes SILO’s again/);
  assert.match(cleared, /currently September 1, 2026/);
});

/* ── The save path, against a stubbed Supabase and a stub of the two DOM
      pieces the control touches. ───────────────────────────────────────────── */
function harness({ sources = [SOURCE], update, rpc } = {}) {
  const calls = [];
  const node = (attrs = {}) => ({ ...attrs, textContent: '', innerHTML: '', disabled: false });
  const table = node(); const statusEl = node();
  const input = node({ value: '2026-09-01', dataset: {} });
  const button = node({ dataset: { saveStart: 's1' } });
  let clickHandler = null;
  const host = {
    querySelector(sel) {
      if (sel === '[data-posting-status]') return statusEl;
      if (sel === '[data-posting-table]') return table;
      if (sel.startsWith('[data-start=')) return input;
      return null;
    },
    addEventListener(_type, fn) { clickHandler = fn; },
  };
  const db = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        order: async () => ({ data: sources.map((s) => ({ ...s })), error: null }),
        update(patch) { calls.push(['update', patch]); return { eq() { return this; }, select: async () => update }; },
      };
    },
    rpc: async (name, args) => { calls.push([name, args]); return rpc.shift(); },
  };
  window.SiloFinanceDialog = { ask: async () => true };
  return {
    calls, statusEl,
    mounted: P.mount({ db, companyId: 'c1', el: (id) => (id === 'postingStart' ? host : null), businessToday: TODAY, booksStart: BOOKS }),
    click: () => new Promise((resolve) => {
      clickHandler({ target: { closest: (sel) => (sel === '[data-save-start]' ? button : null) } });
      setTimeout(resolve, 0);
    }),
  };
}

test('the paged reversal runs to zero, and only then is the save called done', async () => {
  const h = harness({ update: { data: [{ id: 's1', posting_start_on: '2026-09-01' }], error: null },
    rpc: [{ data: 240, error: null }, { data: 140, error: null }, { data: 0, error: null }] });
  await h.mounted; await h.click();
  const resyncs = h.calls.filter((c) => c[0] === 'silo_ledger_resync_posting_start');
  assert.equal(resyncs.length, 3, 'the RPC is bounded per call, so the caller must loop until it returns 0');
  assert.equal(JSON.stringify(resyncs[0][1]), JSON.stringify({ p_source_id: 's1', p_limit: 100 }));
  assert.match(h.statusEl.innerHTML, /Saved/);
  assert.match(h.statusEl.innerHTML, /SILO posts from September 1, 2026/);
  assert.doesNotMatch(h.statusEl.innerHTML, /books-flag/, 'a finished save is not an alarm');
});

test('a reversal that stops partway says what is left, and never reads as finished', async () => {
  const h = harness({ update: { data: [{ id: 's1', posting_start_on: '2026-09-01' }], error: null },
    rpc: [{ data: 300, error: null }, { data: null, error: { message: 'canceling statement due to statement timeout' } }] });
  await h.mounted; await h.click();
  assert.match(h.statusEl.innerHTML, /could not be reversed/);
  assert.match(h.statusEl.innerHTML, /statement timeout/);
  assert.match(h.statusEl.innerHTML, /Save the date again/, 'the recovery must be an action they can take');
  assert.match(h.statusEl.innerHTML, /books-flag/, 'an unfinished reversal is shown as unfinished');
  // The date is saved and already governs approval, so the message must not
  // suggest the cut-over did not take effect.
  assert.match(h.statusEl.innerHTML, /SILO posts September 1, 2026 onward/);
});

test('an RLS-refused save is reported as refused, not as saved', async () => {
  const h = harness({ update: { data: [], error: null }, rpc: [] });
  await h.mounted; await h.click();
  assert.match(h.statusEl.innerHTML, /was not saved/);
  assert.match(h.statusEl.innerHTML, /cannot change this one/,
    'an RLS-refused UPDATE succeeds with zero rows; unguarded it reads as a crash, not a refusal');
  assert.match(h.statusEl.innerHTML, /Ask your company owner/);
  assert.match(h.statusEl.innerHTML, /books-flag/);
  assert.equal(h.calls.filter((c) => c[0] === 'silo_ledger_resync_posting_start').length, 0,
    'nothing may be reversed when the date was not written');
});

test('a save that errors outright reverses nothing', async () => {
  const h = harness({ update: { data: null, error: { message: 'permission denied for table card_sources' } }, rpc: [] });
  await h.mounted; await h.click();
  assert.match(h.statusEl.innerHTML, /permission denied/);
  assert.equal(h.calls.filter((c) => c[0] === 'silo_ledger_resync_posting_start').length, 0);
});

test('the account list reads only its own company, and asks for the column it renders', async () => {
  const h = harness({ update: { data: [], error: null }, rpc: [] });
  await h.mounted;
  const src = await readFile(new URL('../../v2/accounting-posting-start.js', import.meta.url), 'utf8');
  assert.match(src, /\.eq\('company_entity_id', companyId\)/, 'company-scoped read, as every SELECT here is');
  assert.match(src, /select\('[^']*posting_start_on/);
  assert.match(src, /\.eq\('company_entity_id', companyId\)[\s\S]{0,200}posting_start_on: next \|\| null|posting_start_on: next \|\| null[\s\S]{0,300}company_entity_id/,
    'the update is company-scoped too');
});
