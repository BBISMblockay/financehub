/* Launch measurement link: the rules behind the launch form's MEASUREMENT
 * section and the "needs products" follow-up markers on /v2/launch-calendar.html.
 *
 * A launch is measured ONLY through what is attached to it: a linked PO
 * (launch_calendar.linked_po_id -> po_lines.sku_snapshot, read by
 * launch_actuals_v) or products attached in its Products tab
 * (launch_product_readiness, read by launch_product_actuals_v). Launches
 * overlap heavily, so a date window cannot separate one launch's sales from
 * another's, and a link nobody recorded at the time cannot be reconstructed
 * afterwards. 43 of 61 launches were unmeasurable for exactly that reason
 * (docs/ops/roadmap.md, "Launch capture discipline").
 *
 * So the form refuses to save a launch with no link until the person says
 * which of two things is true:
 *   attach_next  products will be attached right after saving (the page opens
 *                the Products tab for a new launch, as it always has)
 *   unknown      products are genuinely not known yet. Recorded on the row
 *                (launch_calendar.products_unknown_at / _note, 20260922150000)
 *                so it stays visible for follow-up rather than being
 *                indistinguishable from nobody having asked.
 *
 * Nothing here estimates a result or reads a date window. It only decides
 * what the page SAYS about a launch's link and what the save may write.
 */
(function (root) {
  'use strict';

  var STATE = { PO: 'po', PRODUCTS: 'products', UNKNOWN: 'unknown', MISSING: 'missing' };
  var CHOICE = { ATTACH_NEXT: 'attach_next', UNKNOWN: 'unknown' };
  var DEFERRAL_COLUMNS = ['products_unknown_at', 'products_unknown_note'];

  function hasText(v) { return v != null && String(v).trim() !== ''; }

  /** Where a launch stands. A PO link wins over attached products, which win
   *  over a recorded "not known yet" -- once something is linked, the earlier
   *  "not known" no longer describes the launch. */
  function linkState(launch, attachedCount) {
    var x = launch || {};
    if (hasText(x.linked_po_id)) return STATE.PO;
    if (Number(attachedCount) > 0) return STATE.PRODUCTS;
    if (hasText(x.products_unknown_at)) return STATE.UNKNOWN;
    return STATE.MISSING;
  }

  /** The follow-up marker for a saved launch, or null when it is linked. */
  function followUp(launch, attachedCount) {
    var s = linkState(launch, attachedCount);
    if (s === STATE.UNKNOWN) {
      var note = hasText(launch.products_unknown_note) ? ' — ' + String(launch.products_unknown_note).trim() : '';
      return { state: s, label: 'Products not known yet',
        title: 'Marked "products not known yet". Attach products or link a PO so this launch can be measured' + note };
    }
    if (s === STATE.MISSING) {
      return { state: s, label: 'No products or PO',
        title: 'Nothing is attached, so this launch cannot be measured. Attach products or link a PO.' };
    }
    return null;
  }

  /**
   * Decide whether the launch form may save, and what it writes about the
   * deferral.
   *
   *   linkedPoId     the form's hidden linked PO id
   *   attachedCount  launch_product_readiness rows for this launch (0 for new)
   *   choice         '' | 'attach_next' | 'unknown'
   *   note           the optional "not known yet" note
   *   existing       the stored row being edited, or null for a new launch
   *   now            ISO timestamp to stamp a new deferral with
   *
   * Returns { ok, message, patch }. `patch` names ONLY the deferral columns
   * that must change, and is empty when none do, so a save that has nothing
   * to say about the deferral never names those columns at all -- which is
   * what keeps the page saving normally before 20260922150000 is applied.
   */
  function decideSave(input) {
    var o = input || {};
    var existing = o.existing || null;
    var wasUnknown = !!(existing && hasText(existing.products_unknown_at));
    var linked = hasText(o.linkedPoId) || Number(o.attachedCount) > 0;
    var note = hasText(o.note) ? String(o.note).trim() : null;

    if (linked || o.choice === CHOICE.ATTACH_NEXT) {
      // Linked now, or the person has said products are coming: a stored
      // "not known yet" would be stale, so clear it.
      return { ok: true, message: '', patch: wasUnknown ? { products_unknown_at: null, products_unknown_note: null } : {} };
    }
    if (o.choice === CHOICE.UNKNOWN) {
      if (!wasUnknown) return { ok: true, message: '', patch: { products_unknown_at: o.now || new Date().toISOString(), products_unknown_note: note } };
      var prevNote = hasText(existing.products_unknown_note) ? String(existing.products_unknown_note).trim() : null;
      // Keep the original date: it is when the follow-up started, and
      // re-stamping it on every edit would make an old gap look new.
      return { ok: true, message: '', patch: prevNote === note ? {} : { products_unknown_note: note } };
    }
    return {
      ok: false,
      message: 'This launch has no products or PO attached, so its sales cannot be measured. '
        + 'Link a PO, choose "I\'ll attach products after saving", or mark products as not known yet.',
      patch: {},
    };
  }

  /** The choice the form should start on for a stored row. */
  function initialChoice(existing) {
    return existing && hasText(existing.products_unknown_at) ? CHOICE.UNKNOWN : '';
  }

  /** True when a save failed because 20260922150000 is not applied yet. */
  function isMissingDeferralColumn(err) {
    if (!err) return false;
    var code = String(err.code || '');
    var msg = String(err.message || '');
    if (code !== '42703' && code !== 'PGRST204') return false;
    return DEFERRAL_COLUMNS.some(function (c) { return msg.indexOf(c) !== -1; });
  }

  root.SiloLaunchLink = {
    STATE: STATE,
    CHOICE: CHOICE,
    DEFERRAL_COLUMNS: DEFERRAL_COLUMNS,
    linkState: linkState,
    followUp: followUp,
    decideSave: decideSave,
    initialChoice: initialChoice,
    isMissingDeferralColumn: isMissingDeferralColumn,
  };
})(typeof window !== 'undefined' ? window : this);
