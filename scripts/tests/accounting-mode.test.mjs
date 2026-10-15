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
  assert.match(dated, /own later date/, 'an account that came onboard later keeps its own date');
  assert.match(M.confirmText('silo', ''), /every period/);
  assert.match(M.confirmText('silo', ''), /Nothing is sent by saving this/,
    'saving a setting must never read as a send');
});
