/**
 * window.SiloJE — a journal entry composer, opened from wherever the problem
 * was noticed.
 *
 * The point is proximity: you are reconciling a report, you see something, and
 * the entry gets written without leaving the page.
 *
 * Composing and posting are two acts, deliberately. The composer STAGES a
 * journal_adjustments row and then shows you that row read back FROM THE
 * DATABASE before anything reaches Intuit — so what you approve is what will
 * post, not what the form happened to hold. A staged entry is a draft you can
 * close, sleep on, reopen and edit; only "Approve & post" writes to the books,
 * and it hands off to the same quickbooks-post-journal function the card
 * batches use, keeping the shared guarantees (rebuilt from the database,
 * claimed before Intuit is called, read back afterwards).
 *
 *   SiloJE.open({
 *     db, companyId,
 *     context: 'qbo-reports:GeneralLedger',   // where it was raised from
 *     prefill: { entryDate, memo, lines: [{ accountId, postingType, amount }] },
 *     adjustmentId: '...',                    // resume a staged draft instead
 *     onStaged: (id) => { ... },              // refresh a drafts list
 *     onPosted: (result) => { ... }           // refresh the report here
 *   });
 */
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const money = (n) => {
    const v = Number(n || 0);
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const num = (v) => Number(String(v ?? '').replace(/[^0-9.\-]/g, '')) || 0;

  // QuickBooks rejects a line on one of these without an Entity, and refuses
  // the WHOLE entry over it -- so it is checked while composing, not at post.
  const NEEDS_ENTITY = new Set(['Accounts Receivable', 'Accounts Payable']);

  let ref = null;   // accounts / locations / entities, loaded once per page

  async function loadReference(db) {
    if (ref) return ref;
    const [acct, loc, cust, vend] = await Promise.all([
      db.from('quickbooks_accounts')
        .select('qbo_account_id, name, fully_qualified_name, account_type')
        .eq('is_active', true).order('fully_qualified_name'),
      db.from('quickbooks_locations')
        .select('qbo_location_id, name, fully_qualified_name')
        .eq('is_active', true).order('name'),
      db.from('quickbooks_customers')
        .select('qbo_customer_id, display_name').eq('is_active', true).order('display_name'),
      db.from('quickbooks_vendors')
        .select('qbo_vendor_id, display_name').eq('is_active', true).order('display_name'),
    ]);

    ref = {
      accounts: (acct.data || []).map((a) => ({
        id: a.qbo_account_id, name: a.fully_qualified_name || a.name, type: a.account_type,
      })),
      locations: (loc.data || []).map((l) => ({
        id: l.qbo_location_id, name: l.fully_qualified_name || l.name,
      })),
      entities: [
        ...(cust.data || []).map((c) => ({ id: c.qbo_customer_id, name: c.display_name, type: 'Customer' })),
        ...(vend.data || []).map((v) => ({ id: v.qbo_vendor_id, name: v.display_name, type: 'Vendor' })),
      ],
    };
    return ref;
  }

  function injectStyles() {
    if (document.getElementById('silo-je-styles')) return;
    const el = document.createElement('style');
    el.id = 'silo-je-styles';
    el.textContent = `
      .je-scrim { position: fixed; inset: 0; z-index: 90; background: rgba(15,23,42,.45);
        display: flex; align-items: flex-start; justify-content: center; padding: 32px 16px;
        overflow: auto; }
      .je-modal { background: var(--bcn-panel, #fff); color: var(--bcn-ink, #16211e);
        border: 1px solid var(--bcn-border, #dde3e0); border-radius: 12px;
        width: min(1040px, 100%); box-shadow: 0 18px 48px rgba(15,23,42,.22);
        display: flex; flex-direction: column; max-height: calc(100vh - 64px); }
      .je-head { flex: none; display: flex; align-items: center; justify-content: space-between;
        gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--bcn-border, #dde3e0); }
      .je-title { font-size: 14px; font-weight: 750; }
      .je-sub { font-family: var(--bcn-mono, monospace); font-size: 10.5px;
        color: var(--bcn-ink-3, #74857d); }
      .je-body { flex: 1; min-height: 0; overflow: auto; padding: 14px; }
      .je-foot { flex: none; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
        padding: 11px 14px; border-top: 1px solid var(--bcn-border, #dde3e0);
        background: var(--bcn-sunken, #f7f8f7); }
      .je-grid { display: grid; gap: 10px 14px;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); margin-bottom: 14px; }
      .je-field { display: flex; flex-direction: column; gap: 4px; }
      .je-field label { font-family: var(--bcn-mono, monospace); font-size: 10px;
        text-transform: uppercase; letter-spacing: .04em; color: var(--bcn-ink-3, #74857d); }
      .je-tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
      .je-tbl th { text-align: left; font-family: var(--bcn-mono, monospace); font-size: 9.5px;
        text-transform: uppercase; letter-spacing: .04em; color: var(--bcn-ink-3, #74857d);
        padding: 6px 6px 5px 0; border-bottom: 1px solid var(--bcn-border-strong, #c3cdc8);
        white-space: nowrap; }
      .je-tbl td { padding: 4px 6px 4px 0; border-bottom: 1px solid var(--bcn-border, #dde3e0);
        vertical-align: middle; }
      .je-tbl select, .je-tbl input { width: 100%; font-size: 11.5px; }
      /* A cell that reads as a field until clicked, then becomes a real
         select -- looks like the fields around it, not a button. */
      .je-tbl .je-cell-btn { width: 100%; font-size: 11.5px; text-align: left;
        background: var(--bcn-panel, #fff); border: 1px solid var(--bcn-border, #dde3e0);
        border-radius: 6px; padding: 5px 8px; color: var(--bcn-ink, #16211e);
        font-family: inherit; cursor: pointer; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; }
      .je-tbl .je-cell-btn:hover { border-color: var(--bcn-accent, #2f6fdb); }
      .je-tbl input.je-amt { text-align: right; font-family: var(--bcn-mono, monospace);
        font-variant-numeric: tabular-nums; }
      .je-tbl td.je-amt, .je-tbl th.je-amt { text-align: right;
        font-family: var(--bcn-mono, monospace); font-variant-numeric: tabular-nums; }
      .je-note { font-family: var(--bcn-mono, monospace); font-size: 10px;
        color: var(--bcn-ink-3, #74857d); }
      .je-totals { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 12px;
        font-family: var(--bcn-mono, monospace); font-size: 12px;
        font-variant-numeric: tabular-nums; }
      .je-totals b { font-weight: 700; }
      .je-ok { color: var(--bcn-pos, #1f6f5c); }
      .je-bad { color: var(--bcn-neg, #9b3b2e); }
      .je-msg { flex: 1; font-size: 12px; min-width: 200px; }
      /* The review step. Visually distinct from the form on purpose: this is
         the last screen before the books change. */
      .je-banner { border: 1px solid var(--bcn-border-strong, #c3cdc8);
        border-left: 3px solid var(--bcn-accent, #2f6fdb); border-radius: 8px;
        padding: 10px 12px; margin-bottom: 14px; font-size: 12px; line-height: 1.5;
        background: var(--bcn-sunken, #f7f8f7); }
      .je-banner b { font-weight: 700; }
      .je-meta { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 12px; }
      .je-meta div { display: flex; flex-direction: column; gap: 2px; }
      .je-meta span { font-family: var(--bcn-mono, monospace); font-size: 9.5px;
        text-transform: uppercase; letter-spacing: .04em; color: var(--bcn-ink-3, #74857d); }
      .je-meta strong { font-size: 12.5px; font-weight: 650; }
    `;
    document.head.appendChild(el);
  }

  function open(opts) {
    const { db, companyId, context, prefill, adjustmentId, onPosted, onStaged } = opts;
    injectStyles();

    const state = {
      id: adjustmentId || null,      // set once staged; re-staging updates it
      step: 'edit',
      entryDate: prefill?.entryDate || new Date().toISOString().slice(0, 10),
      memo: prefill?.memo || '',
      lines: [],
    };

    const scrim = document.createElement('div');
    scrim.className = 'je-scrim';
    scrim.innerHTML = `
      <div class="je-modal" role="dialog" aria-modal="true" aria-label="Post adjustment">
        <div class="je-head">
          <div>
            <div class="je-title" id="jeTitle">Post adjustment</div>
            <div class="je-sub" id="jeContext"></div>
          </div>
          <button class="bcn-btn" id="jeClose">Close</button>
        </div>

        <div class="je-body" id="jeEdit">
          <div class="je-grid">
            <div class="je-field">
              <label for="jeDate">Entry date</label>
              <input type="date" class="bcn-field bcn-field--mono" id="jeDate" />
            </div>
            <div class="je-field" style="grid-column: span 2">
              <label for="jeMemo">Memo — travels to QuickBooks with the entry</label>
              <input class="bcn-field" id="jeMemo" placeholder="Why this adjustment exists" />
            </div>
          </div>
          <table class="je-tbl">
            <thead><tr>
              <th style="min-width:220px">Account</th>
              <th style="width:96px">Side</th>
              <th style="width:120px">Amount</th>
              <th style="min-width:150px">Location</th>
              <th style="min-width:150px">Entity</th>
              <th style="min-width:160px">Description</th>
              <th style="width:34px"></th>
            </tr></thead>
            <tbody id="jeLines"></tbody>
          </table>
          <div class="je-totals" id="jeTotals"></div>
        </div>

        <div class="je-body" id="jeReview" hidden></div>

        <div class="je-foot">
          <button class="bcn-btn" id="jeAddLine">Add line</button>
          <button class="bcn-btn" id="jeSaveDraft">Save draft</button>
          <button class="bcn-btn bcn-btn--primary" id="jeStage">Review entry →</button>
          <button class="bcn-btn" id="jeBack" hidden>← Back to editing</button>
          <button class="bcn-btn bcn-btn--dark" id="jePost" hidden>Approve &amp; post to QuickBooks</button>
          <span class="je-msg" id="jeMsg"></span>
        </div>
      </div>`;
    document.body.appendChild(scrim);

    const $ = (id) => scrim.querySelector('#' + id);
    $('jeContext').textContent = context || '';
    $('jeDate').value = state.entryDate;
    $('jeMemo').value = state.memo;

    let acctOpts = '', locOpts = '', entOpts = '';

    const acct = (id) => ref.accounts.find((a) => a.id === id) || null;
    const lineNeedsEntity = (l) => NEEDS_ENTITY.has(acct(l.accountId)?.type || '');

    function setMsg(text, kind) {
      $('jeMsg').textContent = text;
      $('jeMsg').className = 'je-msg' + (kind ? ` je-${kind}` : '');
    }

    function addLine(seed) {
      state.lines.push({
        accountId: seed?.accountId || '',
        postingType: seed?.postingType || 'Debit',
        amount: seed?.amount != null ? String(seed.amount) : '',
        locationId: seed?.locationId || '',
        entity: seed?.entity || '',
        description: seed?.description || '',
      });
    }

    // Each line carries ~936 options across three selects (450 accounts, 64
    // locations, 422 entities on Baseballism's chart). A card batch is at
    // most a couple dozen lines by hand, but Accounting Export's "Build &
    // post journal entry" stages a real month's sales journal in one shot --
    // 106 lines for August 2026 -- and building all three selects live for
    // every row measured 5,594ms in Chromium, the exact 5.1s-to-open-a-batch
    // failure the coding table already had to fix once. So account/location/
    // entity render as a plain button showing the current label, becoming a
    // real <select> only on click (openEditor) and collapsing back to a
    // button the moment a value is picked -- the table stays light both
    // before AND after editing, not just before. postingType stays a live
    // select (two options, free) and amount/description stay plain inputs.
    // Measured after the fix, same 106 lines: opening the composer is 74ms
    // (was 5,594ms) and a single cell edit is 29ms, flat regardless of row
    // count -- the same shape of fix as the coding table's 5.1s -> 0.65s.
    function acctLabel(id) {
      if (!id) return '— pick an account —';
      const a = acct(id);
      return a ? `${a.name} · ${a.type}` : id;
    }
    function locLabel(id) {
      if (!id) return '— none —';
      const l = ref.locations.find((x) => x.id === id);
      return l ? l.name : id;
    }
    function entLabel(v) {
      if (!v) return '— required —';
      const [etype, eid] = v.split(':');
      const e = ref.entities.find((x) => x.id === eid && x.type === etype);
      return e ? `${e.name} · ${e.type}` : v;
    }
    const FIELD_LABEL = { accountId: acctLabel, locationId: locLabel, entity: entLabel };
    const FIELD_OPTS = { accountId: () => acctOpts, locationId: () => locOpts, entity: () => entOpts };
    const FIELD_PLACEHOLDER = {
      accountId: '— pick an account —', locationId: '— none —', entity: '— required —',
    };

    const cellBtn = (field, value) =>
      `<button type="button" class="bcn-btn je-cell-btn" data-edit="${field}">`
      + `${esc(FIELD_LABEL[field](value))}</button>`;

    // Swaps a label button for a real <select>, populated from the cached
    // option string (built once in loadReference, not re-parsed per cell).
    function openEditor(field, i, td) {
      const l = state.lines[i];
      const sel = document.createElement('select');
      sel.className = 'bcn-field bcn-field--mono';
      sel.dataset.f = field;
      sel.innerHTML = `<option value="">${FIELD_PLACEHOLDER[field]}</option>${FIELD_OPTS[field]()}`;
      sel.value = l[field] || '';
      td.innerHTML = '';
      td.appendChild(sel);
      sel.focus();
    }

    const entityCell = (l) => lineNeedsEntity(l)
      ? cellBtn('entity', l.entity)
      : '<span class="je-note">not needed</span>';

    const rowHtml = (l, i) => `
      <tr data-i="${i}">
        <td>${cellBtn('accountId', l.accountId)}</td>
        <td><select class="bcn-field bcn-field--mono" data-f="postingType">
          <option value="Debit"${l.postingType !== 'Credit' ? ' selected' : ''}>Debit</option>
          <option value="Credit"${l.postingType === 'Credit' ? ' selected' : ''}>Credit</option>
        </select></td>
        <td><input class="bcn-field je-amt" data-f="amount" inputmode="decimal"
          placeholder="0.00" value="${esc(l.amount)}" /></td>
        <td>${cellBtn('locationId', l.locationId)}</td>
        <td>${entityCell(l)}</td>
        <td><input class="bcn-field" data-f="description" value="${esc(l.description)}" /></td>
        <td><button class="bcn-btn" data-del title="Remove line">×</button></td>
      </tr>`;

    function renderLines() {
      $('jeLines').innerHTML = state.lines.map(rowHtml).join('');
      renderTotals();
    }

    function appendLine(seed) {
      addLine(seed);
      const i = state.lines.length - 1;
      $('jeLines').insertAdjacentHTML('beforeend', rowHtml(state.lines[i], i));
      renderTotals();
    }

    function totals() {
      let dr = 0, cr = 0;
      for (const l of state.lines) {
        const a = Math.abs(num(l.amount));
        if (l.postingType === 'Credit') cr += a; else dr += a;
      }
      return { dr: Math.round(dr * 100) / 100, cr: Math.round(cr * 100) / 100 };
    }

    function blockers() {
      const out = [];
      const { dr, cr } = totals();
      if (state.lines.length < 2) out.push('an entry needs at least two lines');
      if (state.lines.some((l) => !l.accountId)) out.push('every line needs an account');
      if (state.lines.some((l) => !(num(l.amount) > 0))) {
        out.push('every line needs an amount above zero');
      }
      const noEntity = state.lines.filter((l) => lineNeedsEntity(l) && !l.entity).length;
      if (noEntity) {
        out.push(`${noEntity} line${noEntity === 1 ? '' : 's'} on a receivable or payable account `
          + `need${noEntity === 1 ? 's' : ''} an entity`);
      }
      if (Math.abs(dr - cr) >= 0.005) out.push('the entry does not balance');
      if (!$('jeMemo').value.trim()) out.push('a memo is required');
      if (!$('jeDate').value) out.push('an entry date is required');
      return out;
    }

    function renderTotals() {
      const { dr, cr } = totals();
      const balanced = Math.abs(dr - cr) < 0.005 && dr > 0;
      $('jeTotals').innerHTML =
        `<span>Debits <b>${money(dr)}</b></span>`
        + `<span>Credits <b>${money(cr)}</b></span>`
        + `<span class="${balanced ? 'je-ok' : 'je-bad'}">`
        + (balanced ? 'Balanced' : `Out by <b>${money(dr - cr)}</b>`) + '</span>';

      const b = blockers();
      $('jeStage').disabled = b.length > 0;
      setMsg(b.length ? `Not ready: ${b.join('; ')}.` : 'Ready to review.', b.length ? 'bad' : 'ok');
    }

    $('jeLines').addEventListener('change', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (!tr) return;
      const i = Number(tr.dataset.i);
      const l = state.lines[i];
      const f = e.target.dataset.f;
      if (!f) return;
      l[f] = e.target.value;
      if (f === 'accountId') {
        // Changing the account can change whether an entity is required, and a
        // stale entity on a line that no longer takes one would ride along.
        // Only this row's entity cell changes -- rebuilding the table here
        // would re-parse every option list on every account pick.
        if (!lineNeedsEntity(l)) l.entity = '';
        tr.children[4].innerHTML = entityCell(l);
      }
      if (f === 'accountId' || f === 'locationId' || f === 'entity') {
        // Collapse this one cell back to a label -- editing in place means
        // the table stays light AFTER the pick too, not just before it.
        e.target.closest('td').innerHTML = cellBtn(f, l[f]);
      }
      renderTotals();
    });
    $('jeLines').addEventListener('input', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (!tr || !e.target.dataset.f) return;
      state.lines[Number(tr.dataset.i)][e.target.dataset.f] = e.target.value;
      renderTotals();
    });
    $('jeLines').addEventListener('click', (e) => {
      const editBtn = e.target.closest('[data-edit]');
      if (editBtn) {
        const tr = editBtn.closest('tr[data-i]');
        openEditor(editBtn.dataset.edit, Number(tr.dataset.i), editBtn.closest('td'));
        return;
      }
      if (e.target.closest('[data-del]')) {
        state.lines.splice(Number(e.target.closest('tr[data-i]').dataset.i), 1);
        renderLines();
      }
    });

    $('jeAddLine').addEventListener('click', () => appendLine());
    $('jeMemo').addEventListener('input', renderTotals);
    $('jeDate').addEventListener('change', renderTotals);

    const close = () => scrim.remove();
    $('jeClose').addEventListener('click', close);
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape' && document.body.contains(scrim)) close();
      if (!document.body.contains(scrim)) document.removeEventListener('keydown', onEsc);
    });

    // ---- staging ------------------------------------------------------------
    // Writes the entry to journal_adjustments as a DRAFT. Nothing here touches
    // QuickBooks. Re-staging an already-staged entry replaces its lines rather
    // than minting a second adjustment, so editing a draft twice does not
    // scatter one entry across several rows.
    async function stage() {
      const payload = {
        entry_date: $('jeDate').value,
        memo: $('jeMemo').value.trim(),
        source_context: context || null,
      };

      if (state.id) {
        const { error } = await db.from('journal_adjustments')
          .update({ ...payload, updated_at: new Date().toISOString() }).eq('id', state.id);
        if (error) throw new Error(error.message);
        const { error: dErr } = await db.from('journal_adjustment_lines')
          .delete().eq('adjustment_id', state.id);
        if (dErr) throw new Error(dErr.message);
      } else {
        const { data, error } = await db.from('journal_adjustments')
          .insert({ company_entity_id: companyId, ...payload }).select('id').single();
        if (error) throw new Error(error.message);
        state.id = data.id;
      }

      const rows = state.lines.map((l, i) => {
        const a = acct(l.accountId);
        const loc = ref.locations.find((x) => x.id === l.locationId);
        const [etype, eid] = (l.entity || '').split(':');
        const ent = eid ? ref.entities.find((x) => x.id === eid && x.type === etype) : null;
        return {
          company_entity_id: companyId,
          adjustment_id: state.id,
          line_no: i + 1,
          qbo_account_id: l.accountId,
          qbo_account_name: a?.name || null,
          posting_type: l.postingType === 'Credit' ? 'Credit' : 'Debit',
          amount: Math.abs(num(l.amount)).toFixed(2),
          description: l.description || null,
          qbo_location_id: l.locationId || null,
          qbo_location_name: loc?.name || null,
          entity_qbo_id: ent?.id || null,
          entity_name: ent?.name || null,
          entity_type: ent?.type || null,
        };
      });

      const { error: lErr } = await db.from('journal_adjustment_lines').insert(rows);
      if (lErr) throw new Error(lErr.message);

      if (onStaged) onStaged(state.id);
      return state.id;
    }

    // ---- the review step ----------------------------------------------------
    // Rendered from what the DATABASE holds, re-read after staging, not from
    // the form's own state. That is the whole point of the step: the thing you
    // approve is the thing quickbooks-post-journal will rebuild and send.
    async function renderReview() {
      const [{ data: adj, error: aErr }, { data: rows, error: lErr }] = await Promise.all([
        db.from('journal_adjustments_v').select('*').eq('id', state.id).single(),
        db.from('journal_adjustment_lines').select('*')
          .eq('adjustment_id', state.id).order('line_no'),
      ]);
      if (aErr) throw new Error(aErr.message);
      if (lErr) throw new Error(lErr.message);

      const dr = rows.filter((r) => r.posting_type === 'Debit')
        .reduce((n, r) => n + Number(r.amount), 0);
      const cr = rows.filter((r) => r.posting_type === 'Credit')
        .reduce((n, r) => n + Number(r.amount), 0);
      const balanced = Math.abs(dr - cr) < 0.005;

      $('jeReview').innerHTML = `
        <div class="je-banner">
          <b>Staged as a draft — nothing has been sent to QuickBooks.</b><br />
          This is the entry read back from the database, which is exactly what
          gets rebuilt and posted. Close this window and it stays a draft you can
          reopen; only <b>Approve &amp; post</b> writes to the books.
        </div>
        <div class="je-meta">
          <div><span>Entry date</span><strong>${esc(adj.entry_date)}</strong></div>
          <div><span>Memo</span><strong>${esc(adj.memo)}</strong></div>
          <div><span>Lines</span><strong>${rows.length}</strong></div>
          <div><span>Raised from</span><strong>${esc(adj.source_context || '—')}</strong></div>
        </div>
        <table class="je-tbl">
          <thead><tr>
            <th>Account</th><th>Location</th><th>Entity</th><th>Description</th>
            <th class="je-amt">Debit</th><th class="je-amt">Credit</th>
          </tr></thead>
          <tbody>${rows.map((r) => `
            <tr>
              <td>${esc(r.qbo_account_name || r.qbo_account_id)}</td>
              <td>${esc(r.qbo_location_name || '—')}</td>
              <td>${esc(r.entity_name || '—')}</td>
              <td>${esc(r.description || '—')}</td>
              <td class="je-amt">${r.posting_type === 'Debit' ? money(r.amount) : ''}</td>
              <td class="je-amt">${r.posting_type === 'Credit' ? money(r.amount) : ''}</td>
            </tr>`).join('')}
          </tbody>
          <tfoot><tr>
            <th colspan="4" style="text-align:right">Totals</th>
            <th class="je-amt">${money(dr)}</th><th class="je-amt">${money(cr)}</th>
          </tr></tfoot>
        </table>
        <div class="je-totals">
          <span class="${balanced ? 'je-ok' : 'je-bad'}">
            ${balanced ? 'Balanced' : `Out by <b>${money(dr - cr)}</b>`}</span>
        </div>`;

      // Belt and braces: the form already refuses to stage an unbalanced entry,
      // but this screen reports what the database holds, so it checks that too
      // rather than trusting the check that ran a moment ago.
      $('jePost').disabled = !balanced || rows.length < 2;
      setMsg(balanced ? 'Review the entry, then approve to post.'
        : 'The staged entry does not balance — go back and fix it.',
      balanced ? null : 'bad');
    }

    function showStep(step) {
      state.step = step;
      const editing = step === 'edit';
      $('jeEdit').hidden = !editing;
      $('jeReview').hidden = editing;
      $('jeAddLine').hidden = !editing;
      $('jeSaveDraft').hidden = !editing;
      $('jeStage').hidden = !editing;
      $('jeBack').hidden = editing;
      $('jePost').hidden = editing;
      // Only a review that actually rendered may enable posting. Otherwise a
      // renderReview() failure would leave a live Post button over a blank
      // screen -- approving an entry nobody managed to read.
      if (!editing) $('jePost').disabled = true;
      $('jeTitle').textContent = editing
        ? (state.id ? 'Edit staged adjustment' : 'Post adjustment')
        : 'Review before posting';
    }

    $('jeStage').addEventListener('click', async () => {
      $('jeStage').disabled = true;
      setMsg('Staging…');
      try {
        await stage();
        showStep('review');
        await renderReview();
      } catch (e) {
        // Back to the form either way: a half-rendered review is not something
        // to post from.
        showStep('edit');
        renderTotals();
        setMsg(`Could not stage the entry — ${e.message}`, 'bad');
      }
    });

    $('jeSaveDraft').addEventListener('click', async () => {
      $('jeSaveDraft').disabled = true;
      setMsg('Saving…');
      try {
        await stage();
        setMsg('Saved as a draft. It is listed under Adjustments until posted.', 'ok');
        setTimeout(close, 900);
      } catch (e) {
        setMsg(`Could not save — ${e.message}`, 'bad');
        $('jeSaveDraft').disabled = false;
      }
    });

    $('jeBack').addEventListener('click', () => {
      showStep('edit');
      renderTotals();
    });

    $('jePost').addEventListener('click', async () => {
      const { dr } = totals();
      if (!confirm(
        `Post this adjustment to QuickBooks?\n\n`
        + `${state.lines.length} lines, ${money(dr)} each side, dated ${$('jeDate').value}.\n\n`
        + `This writes a journal entry to the live books.`)) return;

      $('jePost').disabled = true;
      setMsg('Posting…');

      try {
        // Approving is a separate write from posting so a failure at Intuit
        // leaves a retryable approved entry rather than an untouched draft.
        const { error: apErr } = await db.from('journal_adjustments').update({
          status: 'approved',
          approved_at: new Date().toISOString(),
          approved_by: (await db.auth.getUser()).data.user?.id || null,
        }).eq('id', state.id);
        if (apErr) throw new Error(apErr.message);

        const { data: { session } } = await db.auth.getSession();
        const url = (window.__SILO_CONFIG__?.SUPABASE_URL || '') + '/functions/v1/quickbooks-post-journal';
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({ adjustment_id: state.id }),
        });
        const out = await res.json();
        // The staged adjustment survives a failed post on purpose: it keeps the
        // reason and the lines, so a fixed entry is a retry rather than a retype.
        if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);

        setMsg(`Posted as journal entry ${out.doc_number || out.qbo_journal_entry_id}.`, 'ok');
        setTimeout(() => { close(); if (onPosted) onPosted(out); }, 900);
      } catch (e) {
        setMsg(`Post failed — ${e.message}. The entry is still staged; fix it and try again.`, 'bad');
        $('jePost').disabled = false;
      }
    });

    // ---- boot ---------------------------------------------------------------
    loadReference(db).then(async (r) => {
      acctOpts = r.accounts
        .map((a) => `<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.type)}</option>`).join('');
      locOpts = r.locations
        .map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
      entOpts = r.entities
        .map((e) => `<option value="${esc(e.type)}:${esc(e.id)}">${esc(e.name)} · ${esc(e.type)}</option>`)
        .join('');

      state.lines = [];

      if (adjustmentId) {
        // Resuming a staged draft: the form is filled from the database, so
        // what you edit is what was actually stored.
        const [{ data: adj }, { data: rows }] = await Promise.all([
          db.from('journal_adjustments').select('*').eq('id', adjustmentId).single(),
          db.from('journal_adjustment_lines').select('*')
            .eq('adjustment_id', adjustmentId).order('line_no'),
        ]);
        if (adj) {
          state.entryDate = adj.entry_date;
          state.memo = adj.memo || '';
          $('jeDate').value = state.entryDate;
          $('jeMemo').value = state.memo;
          $('jeContext').textContent = adj.source_context || context || '';
        }
        (rows || []).forEach((r) => addLine({
          accountId: r.qbo_account_id,
          postingType: r.posting_type,
          amount: r.amount,
          locationId: r.qbo_location_id || '',
          entity: r.entity_qbo_id ? `${r.entity_type}:${r.entity_qbo_id}` : '',
          description: r.description || '',
        }));
        if (!state.lines.length) { addLine(); addLine(); }
      } else {
        const seeds = prefill?.lines?.length ? prefill.lines : [{}, {}];
        seeds.forEach(addLine);
      }

      showStep('edit');
      renderLines();   // one build for the opening rows; edits go in place
    }).catch((e) => {
      setMsg(`Could not load the chart of accounts — ${e.message}`, 'bad');
    });
  }

  window.SiloJE = { open };
})();
