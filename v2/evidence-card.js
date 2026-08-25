// window.SiloEvidenceCard -- a shared renderer for AI-drafted business
// artifacts that carry evidence metadata.
//
// Extracted from v2/silo-chat.html's Product Concept card. The framing
// that motivated pulling it out: a product concept is not a chat artifact
// that happens to have a card, it is the CONTAINER the rest of the SILO
// lifecycle unpacks -- an approved concept pre-fills a PO, a launch
// calendar row, a marketing brief, product records. Each of those
// downstream views needs to show the same thing this card shows: the
// numbers, and how solid each one actually is.
//
// What is general here (and why this file exists at all) is the EVIDENCE
// model, not the concept: any AI-drafted artifact needs to distinguish
// "the user told us this" from "we queried this" from "we assumed this"
// from "we recommend this." A PO reviewer approving a buy quantity should
// be able to see it was an ASSUMPTION-grade number before signing.
// Everything concept-specific -- which columns become "Buy qty", the
// economics keys, the forecast scenario names -- lives in the caller's
// spec, not here.
//
// Deliberately NOT a framework: no state, no data fetching, no lifecycle,
// no dependency on Supabase or the page it renders into. One pure
// function from (row, spec) to an HTML string, plus the formatting
// helpers a spec needs. Load it with a plain <script> tag like avatar.js;
// styles live in evidence-card.css.
//
// Usage:
//   <link rel="stylesheet" href="evidence-card.css" />
//   <script src="evidence-card.js"></script>
//   el.innerHTML = SiloEvidenceCard.render(row, MY_SPEC);

(function () {
  'use strict';

  const esc = (s) => String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

  // The four evidence classes. Keys are matched case-insensitively against
  // whatever the model wrote, so a lowercase "data" still badges correctly.
  const EVIDENCE_CLASSES = {
    INPUT: 'input',
    DATA: 'data',
    ASSUMPTION: 'assumption',
    RECOMMENDATION: 'recommendation',
  };

  const num = (n) => (n == null || n === '' || isNaN(Number(n)) ? null : Number(n).toLocaleString());

  // Cents only when the figure actually has them -- a unit cost of 12.4
  // must read as $12.40, but an $8,060 inventory line shouldn't grow a
  // pointless ".00".
  const money = (n) => {
    if (n == null || n === '' || isNaN(Number(n))) return null;
    const v = Number(n);
    return '$' + v.toLocaleString(undefined, Number.isInteger(v) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Small mono tag showing which evidence class a value belongs to, with
  // strength/note in the tooltip. Renders nothing when the field has no
  // recorded classification -- which is exactly the state every row
  // created before evidence tracking existed is in, so absence must stay
  // silent rather than showing an "unknown" badge on every field.
  function badge(evidence, key) {
    const info = evidence && evidence[key];
    const cls = info && EVIDENCE_CLASSES[String(info.class || '').toUpperCase()];
    if (!cls) return '';
    const title = [info.strength ? `strength: ${info.strength}` : '', info.note || ''].filter(Boolean).join(' — ');
    return `<span class="ec-badge ec-badge--${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(String(info.class).toUpperCase())}</span>`;
  }

  // A <dl> row, skipped entirely when there is no value -- an artifact
  // with a deliberately-unknown field should omit the row, never show an
  // empty one or a fabricated placeholder.
  const kv = (label, valueHtml) => (valueHtml ? `<dt>${esc(label)}</dt><dd>${valueHtml}</dd>` : '');

  const section = (label, inner, open) =>
    (inner ? `<details${open ? ' open' : ''}><summary>${esc(label)}</summary>${inner}</details>` : '');

  const chip = (text, variant) =>
    (text ? `<span class="ec-chip${variant ? ` ec-chip--${variant}` : ''}">${esc(text)}</span>` : '');

  // Acronyms that should not be sentence-cased into "Dtc" / "Msrp".
  const ACRONYMS = { dtc: 'DTC', msrp: 'MSRP', sms: 'SMS', po: 'PO', sku: 'SKU', roi: 'ROI', moq: 'MOQ' };

  // Turn a record's field name into something a person would say.
  // These artifacts are read by marketing and design, not only analysts,
  // so a label like "suggested_retail_dtc_notes" is noise to most of the
  // audience. Applied at render time as a safety net: the model is also
  // told to write human field names, but display shouldn't depend on it
  // complying -- same reasoning as every other guard here.
  //   suggested_retail_dtc_notes -> Retail DTC notes
  //   economics.unit_cost        -> Unit cost
  //   suggested_factory_id       -> Factory
  // A few identifiers that survive the generic rules but still read badly.
  const FIELD_ALIASES = { qty: 'Buy quantity', dtc: 'DTC split' };

  function humanizeField(key) {
    if (!key) return '';
    const raw = String(key).trim();
    // Already written for a human ("Retail vs. DTC split") -- leave it be.
    // Only bare snake_case/dotted identifiers get rewritten, so this can
    // never damage a label the model wrote properly.
    if (/\s/.test(raw) || !/^[a-z0-9_.]+$/.test(raw)) return raw;
    let s = raw.split('.').pop();                  // economics.unit_cost -> unit_cost
    s = s.replace(/^suggested_/, '').replace(/_id$/, '');
    if (FIELD_ALIASES[s]) return FIELD_ALIASES[s];
    const words = s.split('_').filter(Boolean).map((w) => ACRONYMS[w.toLowerCase()] || w);
    if (!words.length) return '';
    const first = words[0];
    // Only capitalise the first word; an acronym is already upper-case.
    words[0] = ACRONYMS[first.toLowerCase()] ? first : first.charAt(0).toUpperCase() + first.slice(1);
    return words.join(' ');
  }

  // Helpers handed to every spec callback, so a spec never has to import
  // or re-implement escaping/formatting.
  const H = { esc, num, money, badge, kv, section, chip, humanizeField };

  /**
   * Render one artifact as an evidence card.
   *
   * @param {object} row   The record (a product_concepts row today; a PO or
   *                       launch brief later). Never mutated.
   * @param {object} spec  How to present it. Every field optional:
   *   title(row)          -> string   card heading
   *   chips(row, H)       -> string   HTML run of ec-chip pills
   *   exec(row, H)        -> string   HTML shown above the numbers
   *   numbers(row, H)     -> string   HTML <dt>/<dd> pairs (use H.kv)
   *   sections(row, H)    -> array    [{label, html, open}]
   *   foot(row, H)        -> string   HTML for the footer band
   *   evidenceKey         -> string   row property holding field_evidence
   *                                   (default 'field_evidence')
   * @returns {string} HTML, or '' when there is nothing to show.
   */
  function render(row, spec) {
    if (!row || !spec) return '';
    const evidence = row[spec.evidenceKey || 'field_evidence'] || {};
    // Bind the evidence map so a spec calls h.badge('suggested_qty')
    // instead of threading the map through every callback.
    const h = Object.assign({}, H, { badge: (key) => badge(evidence, key), evidence });

    const title = spec.title ? spec.title(row, h) : '';
    const chips = spec.chips ? spec.chips(row, h) : '';
    const exec = spec.exec ? spec.exec(row, h) : '';
    const numbers = spec.numbers ? spec.numbers(row, h) : '';
    const sections = (spec.sections ? spec.sections(row, h) : []) || [];
    const foot = spec.foot ? spec.foot(row, h) : '';

    const sectionsHtml = sections
      .filter(Boolean)
      .map((s) => section(s.label, s.html, s.open))
      .join('');

    // Actions turn the card into a workflow step rather than a readout.
    // Each button carries the record's id in a data attribute, so whatever
    // the host page does with a click, it cannot be ambiguous about which
    // artifact was acted on -- which is precisely the ambiguity that lets
    // a "revise this" request get misread as "create a new one".
    // Presentation only: this component never binds handlers or mutates
    // anything; the host page delegates clicks off [data-ec-action].
    const actions = (spec.actions ? spec.actions(row, h) : []) || [];
    const actionsHtml = actions.filter(Boolean).length
      ? `<div class="ec-actions">${
          actions.filter(Boolean).map((a) => `<button type="button" class="ec-btn${
            a.variant ? ` ec-btn--${esc(a.variant)}` : ''
          }" data-ec-action="${esc(a.action)}" data-ec-id="${esc(row.id ?? '')}"${
            a.title ? ` title="${esc(a.title)}"` : ''
          }${a.disabled ? ' disabled' : ''}>${esc(a.label)}</button>`).join('')
        }</div>`
      : '';

    // An artifact with no title and no content at all renders nothing
    // rather than an empty shell.
    if (!title && !exec && !numbers && !sectionsHtml && !foot && !actionsHtml) return '';

    return `
      <div class="ec-card">
        <div class="ec-head">
          <div class="ec-title">${esc(title || 'Untitled')}</div>
          ${chips ? `<div class="ec-meta">${chips}</div>` : ''}
        </div>
        <div class="ec-body">
          ${exec}
          ${numbers ? `<dl class="ec-kv">${numbers}</dl>` : ''}
          ${sectionsHtml}
        </div>
        ${foot ? `<div class="ec-foot">${foot}</div>` : ''}
        ${actionsHtml}
      </div>`;
  }

  const renderAll = (rows, spec) =>
    (Array.isArray(rows) ? rows.map((r) => render(r, spec)).join('') : '');

  window.SiloEvidenceCard = Object.assign({ render, renderAll, EVIDENCE_CLASSES }, H);
})();
