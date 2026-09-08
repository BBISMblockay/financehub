/* ==========================================================================
   SILO v3 — the dashboard filter bar
   --------------------------------------------------------------------------
   One control per parameter key, driving every tile that declares it.

   This used to be ~90 lines inside dashboard.html that rebuilt the whole
   bar's innerHTML on every apply. That is what made a text filter unusable:
   a <select> commits the moment you pick, but a text input commits on
   `change` -- which is blur or Enter -- so a value that had been TYPED but
   not committed sat in the DOM looking applied, changed no results, and was
   then wiped by the next re-render when some other control fired. Three
   symptoms, one cause: the control's visible state and the applied state
   were different things and nothing kept them together.

   So the rules here are:

     1. A field is built ONCE and updated in place. A re-render never
        replaces a control the user is typing into, and never discards a
        value that has not been applied yet.
     2. Typing is a pending state with a NAME. The field is marked, the
        chip row says "not applied yet", and it commits on Enter, on blur,
        or after a short pause -- whichever comes first.
     3. Every applied value is visible as a chip, with dates resolved to
        the real calendar date behind a relative token.
     4. A control says how many tiles it moves, and the ones it does not
        move are marked on the tile itself rather than left looking stale.

   Values are still turned into SQL by report-params.js and nowhere else;
   this file produces strings and hands them over.
   ========================================================================== */
(function (global) {
  'use strict';

  const esc = (s) => global.SiloChart.esc(s);
  const P = () => global.SiloReportParams;

  /* Relative tokens, not dates. A board saved with "28 days ago" must still
     mean 28 days ago next month -- storing the resolved date freezes it. */
  const DATE_PRESETS = [
    { value: 'today', label: 'Today' },
    { value: 'today-1d', label: 'Yesterday' },
    { value: 'today-7d', label: '7 days ago' },
    { value: 'today-28d', label: '28 days ago' },
    { value: 'today-30d', label: '30 days ago' },
    { value: 'today-90d', label: '90 days ago' },
    { value: 'today-365d', label: '365 days ago' },
    { value: 'month_start', label: 'Start of this month' },
    { value: 'month_end', label: 'End of this month' },
    { value: 'year_start', label: 'Start of this year' },
    { value: 'year_end', label: 'End of this year' },
  ];

  /* A range preset sets BOTH ends at once. Every one is INCLUSIVE of both
     endpoints, which is stated in the UI: "last 7 days" meaning 6 days plus
     today is the single most common off-by-one in a hand-built dashboard.
     `today` is included on purpose for the presets that name it -- a
     partial day is a real thing a person may want to look at, and the bar
     says the window's end date so nobody has to infer it. */
  const RANGE_PRESETS = [
    { id: 'last_7', label: 'Last 7 days', from: 'today-6d', to: 'today' },
    { id: 'last_28', label: 'Last 28 days', from: 'today-27d', to: 'today' },
    { id: 'last_30', label: 'Last 30 days', from: 'today-29d', to: 'today' },
    { id: 'last_90', label: 'Last 90 days', from: 'today-89d', to: 'today' },
    { id: 'mtd', label: 'Month to date', from: 'month_start', to: 'today' },
    { id: 'this_month', label: 'This month', from: 'month_start', to: 'month_end' },
    { id: 'ytd', label: 'Year to date', from: 'year_start', to: 'today' },
  ];

  const START_RE = /^(.*?)(_?)(start|from|begin|since)(_date)?$/i;
  const END_RE = /^(.*?)(_?)(end|to|through|until)(_date)?$/i;

  /**
   * Pair date declarations that are two ends of one window.
   *
   * `start_date` + `end_date`, `sales_from` + `sales_to`. Only when both
   * sides share a prefix and both are dates -- a lone `end_date` stays its
   * own control rather than being half a range nobody can set.
   *
   * Returns [{kind:'range', key, from, to} | {kind:'single', decl}] in the
   * declaration order they arrived in, so the bar's layout is stable.
   */
  function groupDeclarations(decls) {
    const byKey = new Map(decls.map((d) => [d.key, d]));
    const consumed = new Set();
    const out = [];
    for (const d of decls) {
      if (consumed.has(d.key)) continue;
      if (d.type === 'date' && !d.conflict) {
        const m = START_RE.exec(d.key);
        if (m) {
          const prefix = m[1];
          const partner = decls.find((o) => o !== d && o.type === 'date' && !o.conflict
            && !consumed.has(o.key) && (END_RE.exec(o.key) || [])[1] === prefix);
          if (partner && byKey.has(partner.key)) {
            consumed.add(d.key); consumed.add(partner.key);
            out.push({
              kind: 'range',
              key: `${d.key}__${partner.key}`,
              label: (prefix || 'date').replace(/_/g, ' ').trim() || 'Date range',
              from: d,
              to: partner,
            });
            continue;
          }
        }
      }
      consumed.add(d.key);
      out.push({ kind: 'single', key: d.key, decl: d });
    }
    return out;
  }

  /** Which range preset, if any, a (from,to) pair currently expresses. */
  function matchRangePreset(from, to) {
    const hit = RANGE_PRESETS.find((p) => p.from === from && p.to === to);
    return hit ? hit.id : '';
  }

  const resolved = (v) => P().resolveDateExpr(v);

  /* A relative token reads as an instruction; the reader needs the date it
     currently means. Both are shown, always -- never one or the other. */
  function dateNote(v) {
    const iso = resolved(v);
    if (!iso) return '';
    return DATE_PRESETS.some((p) => p.value === v) || /^today/.test(String(v)) || /_(start|end)$/.test(String(v))
      ? iso : '';
  }

  function create(options) {
    const root = options.root;                     // element holding the fields
    const chipsEl = options.chipsEl || null;       // element holding applied chips
    const getDeclarations = options.getDeclarations;
    const getValues = options.getValues;
    const participation = options.participation || (() => ({ supported: [], unsupported: [] }));
    const onApply = options.onApply;               // (patch) => Promise
    const onPendingChange = options.onPendingChange || function () {};

    /** key -> { wrap, input, decl } for fields currently mounted. */
    const fields = new Map();
    /** key -> string. Typed but not yet applied. */
    const pending = new Map();
    const timers = new Map();
    let groups = [];

    const hasPending = () => pending.size > 0;

    function clearTimer(key) {
      if (timers.has(key)) { clearTimeout(timers.get(key)); timers.delete(key); }
    }

    function markPending(key, value) {
      const cur = getValues()[key];
      if (String(cur == null ? '' : cur) === String(value)) pending.delete(key);
      else pending.set(key, value);
      paint();
      onPendingChange(hasPending());
    }

    async function commit(patch) {
      for (const k of Object.keys(patch)) { pending.delete(k); clearTimer(k); }
      onPendingChange(hasPending());
      await onApply(patch);
      paint();
    }

    /* ── Field builders ────────────────────────────────────────────────
       Each returns a wrapper element and registers its own listeners. The
       element is then only ever UPDATED, never rebuilt, which is what keeps
       focus and a half-typed value alive across an apply. */

    function fieldWrap(id, labelText, forId) {
      const wrap = document.createElement('div');
      wrap.className = 'bcn-field-group v3-slicer-field';
      wrap.dataset.filterKey = id;
      const label = document.createElement('label');
      label.className = 'bcn-label';
      label.setAttribute('for', forId);
      label.textContent = labelText;
      wrap.appendChild(label);
      return wrap;
    }

    function buildConflict(decl) {
      const wrap = fieldWrap(decl.key, decl.label, `slicer_${decl.key}`);
      wrap.classList.add('v3-slicer-field--bad');
      const span = document.createElement('span');
      span.className = 'v3-slicer-conflict';
      span.title = 'Reports on this dashboard disagree about this filter';
      span.textContent = decl.conflict;
      wrap.appendChild(span);
      return { wrap, update() {} };
    }

    function buildEnum(decl) {
      const id = `slicer_${decl.key}`;
      const wrap = fieldWrap(decl.key, decl.label, id);
      // Past a handful of options a native select stops being browsable.
      // A datalist-backed input keeps it one control, keyboard-operable and
      // screen-reader-labelled, without a bespoke listbox to get wrong.
      const searchable = (decl.options || []).length > 8;
      if (!searchable) {
        const sel = document.createElement('select');
        sel.className = 'bcn-field';
        sel.id = id;
        sel.dataset.param = decl.key;
        for (const o of decl.options) {
          const opt = document.createElement('option');
          opt.value = o; opt.textContent = o;
          sel.appendChild(opt);
        }
        sel.addEventListener('change', () => commit({ [decl.key]: sel.value }));
        wrap.appendChild(sel);
        // No focus guard on a SELECT: its value is a committed choice, not
        // something half-typed. Skipping the update while it happens to
        // hold focus is what made Reset leave the control showing the value
        // it had just reset away from.
        return { wrap, update(v) { sel.value = v == null ? '' : v; } };
      }
      const list = document.createElement('datalist');
      list.id = `${id}_list`;
      for (const o of decl.options) {
        const opt = document.createElement('option'); opt.value = o; list.appendChild(opt);
      }
      const input = document.createElement('input');
      input.className = 'bcn-field';
      input.id = id;
      input.type = 'text';
      input.setAttribute('list', list.id);
      input.autocomplete = 'off';
      input.dataset.param = decl.key;
      const err = document.createElement('span');
      err.className = 'v3-slicer-error';
      err.hidden = true;
      const tryCommit = () => {
        const v = input.value.trim();
        if (!decl.options.includes(v)) {
          // An option list is an allowlist -- report-params compares rather
          // than sanitises. Say so here instead of letting every tile
          // render the same rejection.
          err.hidden = false;
          err.textContent = `Not one of the ${decl.options.length} available values.`;
          return;
        }
        err.hidden = true;
        commit({ [decl.key]: v });
      };
      input.addEventListener('input', () => { err.hidden = true; markPending(decl.key, input.value.trim()); });
      input.addEventListener('change', tryCommit);
      input.addEventListener('blur', tryCommit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tryCommit(); } });
      wrap.appendChild(input);
      wrap.appendChild(list);
      wrap.appendChild(err);
      // Guarded on PENDING, not on focus: an uncommitted value must
      // survive a repaint, and a committed one must always be shown.
      return { wrap, update(v) { if (!pending.has(decl.key)) input.value = v == null ? '' : v; } };
    }

    function buildText(decl) {
      const id = `slicer_${decl.key}`;
      const wrap = fieldWrap(decl.key, decl.label, id);
      const input = document.createElement('input');
      input.className = 'bcn-field';
      input.type = decl.type === 'number' ? 'number' : 'text';
      input.id = id;
      input.autocomplete = 'off';
      input.dataset.param = decl.key;
      const note = document.createElement('span');
      note.className = 'v3-slicer-pending';
      note.hidden = true;
      note.textContent = 'Not applied — press Enter';

      const doCommit = () => {
        clearTimer(decl.key);
        const v = input.value.trim();
        const cur = getValues()[decl.key];
        if (String(cur == null ? '' : cur) === v) { pending.delete(decl.key); paint(); return; }
        commit({ [decl.key]: v });
      };
      input.addEventListener('input', () => {
        markPending(decl.key, input.value.trim());
        clearTimer(decl.key);
        // A typed filter that only ever commits on blur is the bug this
        // file exists to fix. Debounced so it does not fire per keystroke,
        // and Enter/blur still commit immediately.
        timers.set(decl.key, setTimeout(doCommit, 700));
      });
      input.addEventListener('change', doCommit);
      input.addEventListener('blur', doCommit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doCommit(); } });
      wrap.appendChild(input);
      wrap.appendChild(note);
      return {
        wrap,
        update(v) {
          if (!pending.has(decl.key)) input.value = v == null ? '' : v;
          note.hidden = !pending.has(decl.key);
          wrap.classList.toggle('is-pending', pending.has(decl.key));
        },
      };
    }

    function buildDate(decl) {
      const id = `slicer_${decl.key}`;
      const wrap = fieldWrap(decl.key, decl.label, id);
      const row = document.createElement('div');
      row.className = 'v3-slicer-date';
      const sel = document.createElement('select');
      sel.className = 'bcn-field';
      sel.id = id;
      // Every control carries data-param, whatever its shape. It is how the
      // page, and the test suite, address "the control for this key".
      sel.dataset.param = decl.key;
      for (const p of DATE_PRESETS) {
        const o = document.createElement('option'); o.value = p.value; o.textContent = p.label; sel.appendChild(o);
      }
      const custom = document.createElement('option');
      custom.value = '__custom'; custom.textContent = 'Specific date…';
      sel.appendChild(custom);
      const input = document.createElement('input');
      input.className = 'bcn-field';
      input.type = 'date';
      input.dataset.paramDate = decl.key;
      input.setAttribute('aria-label', `${decl.label}: specific date`);
      const note = document.createElement('span');
      note.className = 'v3-slicer-hint bcn-mono';

      sel.addEventListener('change', () => {
        if (sel.value === '__custom') { input.hidden = false; input.focus(); return; }
        input.hidden = true;
        commit({ [decl.key]: sel.value });
      });
      input.addEventListener('change', () => { if (input.value) commit({ [decl.key]: input.value }); });

      row.appendChild(sel); row.appendChild(input);
      wrap.appendChild(row); wrap.appendChild(note);
      return {
        wrap,
        update(v) {
          const isPreset = DATE_PRESETS.some((p) => p.value === v);
          sel.value = isPreset ? v : '__custom';
          const iso = resolved(v);
          input.value = iso || '';
          input.hidden = isPreset;
          // The resolved date is shown for BOTH shapes: a preset needs it
          // because 'today-7d' is not a date, and a literal one shows it in
          // the input itself.
          note.textContent = iso || '';
        },
      };
    }

    function buildRange(group) {
      const id = `slicer_${group.from.key}`;
      const wrap = fieldWrap(group.key, group.label ? `${group.label} range` : 'Date range', id);
      wrap.classList.add('v3-slicer-field--range');
      const row = document.createElement('div');
      row.className = 'v3-slicer-date';
      const sel = document.createElement('select');
      sel.className = 'bcn-field';
      sel.id = id;
      for (const p of RANGE_PRESETS) {
        const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; sel.appendChild(o);
      }
      const custom = document.createElement('option');
      custom.value = '__custom'; custom.textContent = 'Custom range…';
      sel.appendChild(custom);
      const a = document.createElement('input'); a.type = 'date'; a.className = 'bcn-field';
      a.dataset.param = group.from.key;
      a.setAttribute('aria-label', `${group.from.label} (start, inclusive)`);
      const dash = document.createElement('span'); dash.className = 'v3-slicer-dash'; dash.textContent = '→';
      const b = document.createElement('input'); b.type = 'date'; b.className = 'bcn-field';
      b.dataset.param = group.to.key;
      b.setAttribute('aria-label', `${group.to.label} (end, inclusive)`);
      const note = document.createElement('span');
      note.className = 'v3-slicer-hint bcn-mono';

      const showCustom = (on) => { a.hidden = !on; b.hidden = !on; dash.hidden = !on; };

      sel.addEventListener('change', () => {
        if (sel.value === '__custom') { showCustom(true); a.focus(); return; }
        const p = RANGE_PRESETS.find((x) => x.id === sel.value);
        if (p) { showCustom(false); commit({ [group.from.key]: p.from, [group.to.key]: p.to }); }
      });
      const commitCustom = () => {
        if (!a.value || !b.value) return;
        // Both ends inclusive, so a start after an end is empty by
        // construction. Swap rather than run it -- nobody means that.
        const from = a.value <= b.value ? a.value : b.value;
        const to = a.value <= b.value ? b.value : a.value;
        commit({ [group.from.key]: from, [group.to.key]: to });
      };
      a.addEventListener('change', commitCustom);
      b.addEventListener('change', commitCustom);

      row.appendChild(sel); row.appendChild(a); row.appendChild(dash); row.appendChild(b);
      wrap.appendChild(row); wrap.appendChild(note);
      return {
        wrap,
        update(values) {
          const fv = values[group.from.key];
          const tv = values[group.to.key];
          const preset = matchRangePreset(fv, tv);
          sel.value = preset || '__custom';
          showCustom(!preset);
          a.value = resolved(fv) || '';
          b.value = resolved(tv) || '';
          const f = resolved(fv); const t = resolved(tv);
          note.textContent = f && t ? `${f} → ${t} (inclusive)` : '';
        },
      };
    }

    /* ── Mounting ─────────────────────────────────────────────────────── */
    function build(group) {
      if (group.kind === 'range') return buildRange(group);
      const d = group.decl;
      if (d.conflict) return buildConflict(d);
      if (d.type === 'enum') return buildEnum(d);
      if (d.type === 'date') return buildDate(d);
      return buildText(d);
    }

    /**
     * Reconcile the mounted controls with the current declarations.
     *
     * Fields that are still declared keep their DOM node -- so adding a
     * widget mid-session cannot wipe a half-typed value out of an unrelated
     * control, which is exactly what a full innerHTML rebuild did.
     */
    function sync() {
      const decls = getDeclarations();
      groups = groupDeclarations(decls);
      const wanted = new Set(groups.map((g) => g.key));
      for (const [key, f] of Array.from(fields)) {
        if (!wanted.has(key)) { f.wrap.remove(); fields.delete(key); }
      }
      let prev = null;
      for (const g of groups) {
        let f = fields.get(g.key);
        // A declaration can CHANGE shape (a report edited from text to
        // enum). Rebuild only that one field, not the bar.
        const sig = g.kind === 'range' ? 'range'
          : `${g.decl.type}:${(g.decl.options || []).join('|')}:${g.decl.conflict || ''}`;
        if (f && f.sig !== sig) { f.wrap.remove(); fields.delete(g.key); f = null; }
        if (!f) {
          f = build(g);
          f.sig = sig;
          f.group = g;
          fields.set(g.key, f);
        }
        // Keep DOM order matching declaration order without re-creating.
        if (prev ? prev.nextSibling !== f.wrap : root.firstChild !== f.wrap) {
          root.insertBefore(f.wrap, prev ? prev.nextSibling : root.firstChild);
        }
        prev = f.wrap;
      }
      paint();
      return groups.length;
    }

    /** Refresh every mounted control's displayed value + the chip row. */
    function paint() {
      const values = getValues();
      for (const [key, f] of fields) {
        if (f.group && f.group.kind === 'range') f.update(values);
        else f.update(values[key]);
      }
      if (chipsEl) paintChips(values);
    }

    /**
     * How many tiles a control actually moves.
     *
     * Stated on the chip because "this filter drives 6 of 9 tiles" is the
     * honest sentence, and a header control that silently misses three of
     * them teaches the reader that all nine are filtered. The three are
     * ALSO marked on their own faces; this is the count, not a substitute
     * for that.
     */
    function reachNote(keys) {
      const supported = new Set();
      const all = new Set();
      for (const k of keys) {
        const part = participation(k) || { supported: [], unsupported: [] };
        for (const id of part.supported) { supported.add(id); all.add(id); }
        for (const id of part.unsupported) all.add(id);
      }
      if (!all.size || supported.size === all.size) return '';
      return `${supported.size} of ${all.size} tiles`;
    }

    function chipHtml(label, value, extra) {
      return `<span class="v3-filter-chip">
          <span class="v3-filter-chip-key">${esc(label)}</span>
          <span class="v3-filter-chip-val bcn-mono">${esc(value)}</span>
          ${extra ? `<span class="v3-filter-chip-note">${esc(extra)}</span>` : ''}
        </span>`;
    }

    function paintChips(values) {
      const parts = [];
      for (const g of groups) {
        if (g.kind === 'range') {
          const f = resolved(values[g.from.key]);
          const t = resolved(values[g.to.key]);
          const reach = reachNote([g.from.key, g.to.key]);
          if (f && t) {
            parts.push(chipHtml(g.label || 'Dates', `${f} → ${t}`,
              reach ? `inclusive · ${reach}` : 'inclusive'));
          }
          continue;
        }
        const d = g.decl;
        if (d.conflict) continue;
        const v = values[d.key];
        if (v === undefined || v === '') continue;
        const note = [d.type === 'date' ? dateNote(v) : '', reachNote([d.key])]
          .filter(Boolean).join(' · ');
        parts.push(chipHtml(d.label, v, note));
      }
      for (const [key, v] of pending) {
        const g = groups.find((x) => x.kind === 'single' && x.key === key);
        parts.push(`<span class="v3-filter-chip v3-filter-chip--pending">
            <span class="v3-filter-chip-key">${esc(g ? g.decl.label : key)}</span>
            <span class="v3-filter-chip-val bcn-mono">${esc(v)}</span>
            <span class="v3-filter-chip-note">not applied yet</span>
          </span>`);
      }
      chipsEl.innerHTML = parts.join('');
      chipsEl.hidden = !parts.length;
    }

    /** Commit anything typed but not yet applied (used before Save). */
    function flush() {
      const patch = {};
      for (const [k, v] of pending) patch[k] = v;
      if (!Object.keys(patch).length) return Promise.resolve(false);
      return commit(patch).then(() => true);
    }

    return { sync, paint, flush, hasPending, groupDeclarations, DATE_PRESETS, RANGE_PRESETS };
  }

  global.SiloFilterBar = { create, groupDeclarations, DATE_PRESETS, RANGE_PRESETS, matchRangePreset };
})(window);
