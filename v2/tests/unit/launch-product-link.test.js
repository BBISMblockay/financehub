/* The launch form's measurement-link decision table (v2/launch-product-link.js).
 *
 * What must hold:
 *   - an unlinked launch cannot be saved without an explicit choice
 *   - a PO link or an attached product is enough on its own
 *   - "products not known yet" is RECORDED, and a re-save keeps its original
 *     date rather than making an old gap look new
 *   - once linked, a stored "not known yet" is cleared, never left stale
 *   - a save with nothing to say about the deferral names none of its columns
 *     (so the page keeps saving before 20260922150000 is applied)
 *   - the follow-up marker exists for every unlinked launch and for no linked one
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { loadV2 } = require('../lib/load');

const r = createReporter('launch-product-link');
const L = loadV2(['launch-product-link.js']).SiloLaunchLink;
const NOW = '2026-09-22T18:00:00.000Z';

r.test('an unlinked launch with no choice is refused, and says why', () => {
  const d = L.decideSave({ linkedPoId: '', attachedCount: 0, choice: '', note: '', existing: null, now: NOW });
  r.eq(d.ok, false);
  r.has(d.message, 'no products or PO attached');
  r.has(d.message, 'not known yet');
  r.eq(d.patch, {});
});

r.test('whitespace is not a PO link', () => {
  r.eq(L.decideSave({ linkedPoId: '   ', attachedCount: 0, choice: '' }).ok, false);
});

r.test('a linked PO saves with no choice and no deferral columns', () => {
  const d = L.decideSave({ linkedPoId: 'po-1', attachedCount: 0, choice: '', existing: null, now: NOW });
  r.eq(d.ok, true);
  r.eq(d.patch, {}, 'nothing to write about the deferral');
});

r.test('attached products save with no choice', () => {
  const d = L.decideSave({ linkedPoId: '', attachedCount: 2, choice: '', existing: { id: 'l1' }, now: NOW });
  r.eq(d.ok, true);
  r.eq(d.patch, {});
});

r.test('"attach next" saves a new launch without touching the deferral columns', () => {
  const d = L.decideSave({ linkedPoId: '', attachedCount: 0, choice: 'attach_next', existing: null, now: NOW });
  r.eq(d.ok, true);
  r.eq(d.patch, {});
});

r.test('"not known yet" on a new launch is recorded with its note', () => {
  const d = L.decideSave({ linkedPoId: '', attachedCount: 0, choice: 'unknown', note: '  waiting on Owen  ', existing: null, now: NOW });
  r.eq(d.ok, true);
  r.eq(d.patch, { products_unknown_at: NOW, products_unknown_note: 'waiting on Owen' });
  r.truthy(!('products_unknown_by' in d.patch), 'who is stamped by the database, never sent');
});

r.test('an empty note is stored as null, not an empty string', () => {
  const d = L.decideSave({ choice: 'unknown', note: '   ', existing: null, now: NOW });
  r.eq(d.patch.products_unknown_note, null);
});

const DEFERRED = { id: 'l1', products_unknown_at: '2026-08-01T00:00:00Z', products_unknown_note: 'tbd' };

r.test('re-saving a deferred launch keeps the original date', () => {
  const same = L.decideSave({ choice: 'unknown', note: 'tbd', existing: DEFERRED, now: NOW });
  r.eq(same.ok, true);
  r.eq(same.patch, {}, 'nothing changed, nothing written');
  const edited = L.decideSave({ choice: 'unknown', note: 'factory confirms Friday', existing: DEFERRED, now: NOW });
  r.eq(edited.patch, { products_unknown_note: 'factory confirms Friday' }, 'only the note moves');
});

r.test('linking a PO clears a stored "not known yet"', () => {
  const d = L.decideSave({ linkedPoId: 'po-9', attachedCount: 0, choice: 'unknown', existing: DEFERRED, now: NOW });
  r.eq(d.ok, true);
  r.eq(d.patch, { products_unknown_at: null, products_unknown_note: null });
});

r.test('attached products clear a stored "not known yet"', () => {
  const d = L.decideSave({ linkedPoId: '', attachedCount: 1, choice: 'unknown', existing: DEFERRED, now: NOW });
  r.eq(d.patch, { products_unknown_at: null, products_unknown_note: null });
});

r.test('switching to "attach next" clears a stored "not known yet"', () => {
  const d = L.decideSave({ choice: 'attach_next', existing: DEFERRED, now: NOW });
  r.eq(d.patch, { products_unknown_at: null, products_unknown_note: null });
});

r.test('a deferred launch with the choice removed is refused, not silently cleared', () => {
  r.eq(L.decideSave({ choice: '', existing: DEFERRED, now: NOW }).ok, false);
});

r.test('the form starts on "not known yet" for a deferred row, and on nothing otherwise', () => {
  r.eq(L.initialChoice(DEFERRED), 'unknown');
  r.eq(L.initialChoice({ id: 'x' }), '');
  r.eq(L.initialChoice(null), '');
});

r.test('link state precedence: PO > products > not known yet > missing', () => {
  r.eq(L.linkState({ linked_po_id: 'po', products_unknown_at: NOW }, 3), 'po');
  r.eq(L.linkState({ products_unknown_at: NOW }, 3), 'products');
  r.eq(L.linkState({ products_unknown_at: NOW }, 0), 'unknown');
  r.eq(L.linkState({}, 0), 'missing');
  r.eq(L.linkState(null, 0), 'missing');
});

r.test('follow-up markers: every unlinked launch, no linked one', () => {
  r.eq(L.followUp({ linked_po_id: 'po' }, 0), null);
  r.eq(L.followUp({}, 1), null);
  const miss = L.followUp({}, 0);
  r.eq(miss.state, 'missing');
  r.eq(miss.label, 'No products or PO');
  const unk = L.followUp({ products_unknown_at: NOW, products_unknown_note: 'ask Owen' }, 0);
  r.eq(unk.state, 'unknown');
  r.eq(unk.label, 'Products not known yet');
  r.has(unk.title, 'ask Owen');
});

r.test('nothing in the module speaks of estimating by date window', () => {
  // The measurement rule is attachment-only; a message offering a period
  // estimate would contradict it (docs/ops/roadmap.md, "Decided").
  const d = L.decideSave({ choice: '' });
  r.not(d.message.toLowerCase(), 'estimat');
  r.not(L.followUp({}, 0).title.toLowerCase(), 'estimat');
});

r.test('an unapplied migration is recognised only for the deferral columns', () => {
  r.eq(L.isMissingDeferralColumn({ code: '42703', message: 'column launch_calendar.products_unknown_at does not exist' }), true);
  r.eq(L.isMissingDeferralColumn({ code: 'PGRST204', message: "Could not find the 'products_unknown_note' column" }), true);
  r.eq(L.isMissingDeferralColumn({ code: '42703', message: 'column launch_calendar.title does not exist' }), false);
  r.eq(L.isMissingDeferralColumn({ code: '42501', message: 'products_unknown_at permission denied' }), false);
  r.eq(L.isMissingDeferralColumn(null), false);
});

const out = r.summary();
process.exit(out.fail ? 1 : 0);
