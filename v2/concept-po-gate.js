/* Whether a product concept can become a PO, as shown on
   /v2/product-concepts.html.

   PRESENTATION ONLY. The rule itself is product_concept_po_missing() in the
   database (20260930120000), which product_concepts_v exposes as
   `po_missing`: an empty array means ready, otherwise the names of what is
   missing. This file never decides readiness itself. It only turns that
   answer, plus the two rules that need other rows (archived, a collection
   parent), into what the page draws, and writes the Ask SILO request that
   fills the gaps.

   `po_missing` absent (the page shipped before the migration) reads as
   UNKNOWN, not ready and not blocked: the button stays live and
   generate_po_from_concept() gives the refusal, so the page is right in
   either deploy order. */
(function (root) {
  function gate(c) {
    const concept = c || {};
    if (concept.status === 'archived') {
      return { ready: false, reason: 'Archived concepts cannot generate a PO.', missing: [] };
    }
    if (Number(concept.child_count) > 0) {
      return { ready: false, reason: 'A collection is purchased product by product. Generate a PO from each product in it.', missing: [] };
    }
    if (!Array.isArray(concept.po_missing)) return { ready: true, reason: '', missing: [], unknown: true };
    const missing = concept.po_missing.map(String).filter(Boolean);
    if (missing.length) return { ready: false, reason: 'Not ready for a PO yet.', missing };
    return { ready: true, reason: '', missing: [] };
  }

  // A request for Ask SILO to fill the gaps. The page only PREFILLS it:
  // silo-chat.html never sends a ?q= question on its own, so nothing is
  // asked on anyone's behalf.
  function completionPrompt(c, missing) {
    const concept = c || {};
    const list = (missing || []).filter(Boolean);
    const approval = list.some((m) => /^approval$/i.test(m));
    const fields = list.filter((m) => !/^approval$/i.test(m));
    const lines = [`Get "${concept.title || 'this concept'}" ready for a purchase order.`];
    if (fields.length) {
      lines.push(`It is missing: ${fields.join('; ')}.`);
      if (fields.some((m) => /size/i.test(m))) {
        lines.push('Base the size breakdown on the size curve of a comparable product we have sold, in whole units, adding up to the suggested quantity.');
      }
      if (fields.some((m) => /cost|retail/i.test(m))) {
        lines.push('Put the unit cost (FOB) and retail price in economics as unit_cost and msrp, from prior POs and comparable products.');
      }
      lines.push('Anything you cannot ground in our data, leave blank and tell me why rather than estimating it.');
    }
    if (approval) lines.push(fields.length ? 'Once it is complete, ask me whether to approve it.' : 'It only needs approval. Ask me whether to approve it.');
    return lines.join(' ');
  }

  const api = { gate, completionPrompt };
  if (root) root.SiloConceptPoGate = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
