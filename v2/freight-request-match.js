/* Which inventory-freight payment request belongs to a PO, and what Costing
 * may prefill from it. Used by /v2/po-costing.html; pure, so node can test it
 * (v2/tests/unit/freight-request-match.test.js).
 *
 * payment_requests.internal_po_number is TEXT. Both intake pages write the
 * selected POs joined with ", " (purchase_request.html's picker,
 * payment-request2-core.js), and the manual fallback / legacy import may hold
 * anything typed. One freight invoice is often shared across several POs, so
 * the column can read "Creytex-329-s, Creytex-330, Creytex-331".
 *
 * Costing used to match that column with = against ONE PO name, so a shared
 * request never matched and its PO got no prefill. Matching it with a
 * substring would be worse: it would prefill the WHOLE shared invoice into
 * every PO on it and overstate landed cost N times. So:
 *
 *   - a request naming only this PO      -> prefill amount, ref and carrier
 *   - a request naming this PO and others -> prefill ref and carrier only,
 *     and say the invoice is shared; the amount is this PO's SHARE, which a
 *     person sets -- with the page's existing Combined shipment wizard (it
 *     splits one bill across POs and previews each share before saving) or
 *     by hand. Nothing records which request an allocation came from yet.
 *
 * PO names are compared exactly after trimming: "PO-33" never matches a
 * request for "PO-330". Nothing here writes; the page's Save is unchanged.
 *
 * Browser: window.SiloFreightMatch. */
(function (root) {
  /** The PO names a request's text names, trimmed, empty pieces dropped, in order, once each. */
  function poNamesOf(text) {
    const out = [];
    String(text == null ? '' : text).split(',').forEach((piece) => {
      const name = piece.trim();
      if (name && out.indexOf(name) === -1) out.push(name);
    });
    return out;
  }

  /** The newest request (rows are newest first) naming poName, or null.
   *  { request, poNames, shared, others } */
  function pickFreightRequest(rows, poName) {
    const want = String(poName == null ? '' : poName).trim();
    if (!want) return null;
    for (const row of rows || []) {
      const names = poNamesOf(row && row.internal_po_number);
      if (names.indexOf(want) === -1) continue;
      return {
        request: row,
        poNames: names,
        shared: names.length > 1,
        others: names.filter((n) => n !== want),
      };
    }
    return null;
  }

  const filled = (v) => v != null && String(v).trim() !== '' && Number(v) !== 0;
  const blank = (v) => v == null || String(v).trim() === '';

  /** What to put in the form. `current` is read when the answer arrives, so a
   *  value typed meanwhile is never overwritten. Every key is optional. */
  function prefillPlan(match, current) {
    const cur = current || {};
    if (!match || !match.request) return {};
    const req = match.request;
    const plan = {};
    if (!match.shared && req.amount_due != null && isFinite(Number(req.amount_due)) && !filled(cur.freight)) {
      plan.freight = Number(req.amount_due).toFixed(2);
    }
    if (req.invoice_number && blank(cur.ref)) plan.ref = String(req.invoice_number);
    if (req.vendor_name && blank(cur.carrier)) plan.carrier = String(req.vendor_name);
    if (match.shared) {
      const amount = req.amount_due != null && isFinite(Number(req.amount_due))
        ? ' ($' + Number(req.amount_due).toFixed(2) + ')' : '';
      const ref = req.invoice_number ? ' ' + req.invoice_number : '';
      plan.notice = 'Freight invoice' + ref + amount + ' is shared with ' + match.others.join(', ')
        + '. Split it with Combined shipment (it previews each PO’s share before saving), or enter this PO’s share here. The amount is not filled in automatically.';
    }
    return plan;
  }

  /** Page through a company's freight requests, newest first, until one names
   *  poName or the rows run out. fetchPage(from, to) resolves to the rows in
   *  that inclusive range ({ data, error } as supabase-js returns it). A cap
   *  would turn "beyond the cap" into "no request exists", silently, for every
   *  older PO -- so there is none: a short page ends the walk, not a count.
   *  Resolves to { match, pages }; a page error rejects. */
  async function findFreightRequest(fetchPage, poName, pageSize) {
    const size = Math.max(1, Number(pageSize) || 500);
    let pages = 0;
    for (let from = 0; ; from += size) {
      const res = await fetchPage(from, from + size - 1);
      pages += 1;
      if (res && res.error) throw res.error;
      const rows = (res && res.data) || [];
      const match = pickFreightRequest(rows, poName);
      if (match || rows.length < size) return { match: match, pages: pages };
    }
  }

  root.SiloFreightMatch = {
    poNamesOf: poNamesOf, pickFreightRequest: pickFreightRequest, prefillPlan: prefillPlan,
    findFreightRequest: findFreightRequest,
  };
})(typeof window !== 'undefined' ? window : this);
