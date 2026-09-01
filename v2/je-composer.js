/**
 * window.SiloJE — a journal entry composer, opened from wherever the problem
 * was noticed.
 *
 * The point is proximity: you are reconciling a report, you see something, and
 * the entry gets written without leaving the page. Nothing here posts on its
 * own — the composer stages a journal_adjustments row, then calls the same
 * quickbooks-post-journal function the card batches use, so the guarantees are
 * the shared ones (rebuilt from the database, claimed before Intuit is called,
 * read back afterwards).
 *
 *   SiloJE.open({
 *     db, companyId,
 *     context: 'qbo-reports:GeneralLedger',   // where it was raised from
 *     prefill: { entryDate, memo, lines: [{ accountId, postingType, amount }] },
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
      .je-tbl input.je-amt { text-align: right; font-family: var(--bcn-mono, monospace);
        font-variant-numeric: tabular-nums; }
      .je-note { font-family: var(--bcn-mono, monospace); font-size: 10px;
        color: var(--bcn-ink-3, #74857d); }
      .je-req { color: var(--bcn-neg, #9b3b2e); font-weight: 600; }
      .je-totals { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 12px;
        font-family: var(--bcn-mono, monospace); font-size: 12px;
        font-variant-numeric: tabular-nums; }
      .je-totals b { font-weight: 700; }
      .je-ok { color: var(--bcn-pos, #1f6f5c); }
      .je-bad { color: var(--bcn-neg, #9b3b2e); }
      .je-msg { flex: 1; font-size: 12px; min-width: 200px; }
    `;
    document.head.appendChild(el);
  }

  function open(opts) {
    const { db, companyId, context, prefill, onPosted } = opts;
    injectStyles();

    const state = {
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
            <div class="je-title">Post adjustment</div>
            <div class="je-sub" id="jeContext"></div>
          </div>
          <button class="bcn-btn" id="jeClose">Close</button>
        </div>
        <div class="je-body">
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
        <div class="je-foot">
          <button class="bcn-btn" id="jeAddLine">Add line</button>
          <button class="bcn-btn bcn-btn--dark" id="jePost">Post to QuickBooks</button>
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
    // locations, 422 entities on Baseballism's chart). Measured in Chromium:
    // building 2 lines takes 104ms, 10 takes 458ms, 30 takes 1,559ms. That is
    // fine ONCE and not fine on every account pick, which used to rebuild the
    // whole table. So structural changes (open, add, delete) rebuild and
    // everything else edits in place: one account change went 113ms -> 22ms at
    // 4 lines and 738ms -> 22ms at 30, flat instead of growing. Same lesson as
    // the coding table, where a select per row cost 5.1s to open a batch.
    const entityCell = (l) => lineNeedsEntity(l)
      ? `<select class="bcn-field bcn-field--mono" data-f="entity">
           <option value="">— required —</option>${entOpts}</select>`
      : '<span class="je-note">not needed</span>';

    const rowHtml = (l, i) => `
      <tr data-i="${i}">
        <td><select class="bcn-field bcn-field--mono" data-f="accountId">
          <option value="">— pick an account —</option>${acctOpts}</select></td>
        <td><select class="bcn-field bcn-field--mono" data-f="postingType">
          <option value="Debit">Debit</option><option value="Credit">Credit</option>
        </select></td>
        <td><input class="bcn-field je-amt" data-f="amount" inputmode="decimal"
          placeholder="0.00" value="${esc(l.amount)}" /></td>
        <td><select class="bcn-field bcn-field--mono" data-f="locationId">
          <option value="">— none —</option>${locOpts}</select></td>
        <td>${entityCell(l)}</td>
        <td><input class="bcn-field" data-f="description" value="${esc(l.description)}" /></td>
        <td><button class="bcn-btn" data-del title="Remove line">×</button></td>
      </tr>`;

    // A <select>'s value cannot be set in its own markup without marking an
    // option, so it is applied after the row is in the DOM.
    function applyValues(tr, l) {
      for (const f of ['accountId', 'postingType', 'locationId', 'entity']) {
        const e = tr.querySelector(`[data-f="${f}"]`);
        if (e) e.value = l[f] || (f === 'postingType' ? 'Debit' : '');
      }
    }

    function renderLines() {
      $('jeLines').innerHTML = state.lines.map(rowHtml).join('');
      state.lines.forEach((l, i) =>
        applyValues($('jeLines').querySelector(`tr[data-i="${i}"]`), l));
      renderTotals();
    }

    function appendLine(seed) {
      addLine(seed);
      const i = state.lines.length - 1;
      $('jeLines').insertAdjacentHTML('beforeend', rowHtml(state.lines[i], i));
      applyValues($('jeLines').querySelector(`tr[data-i="${i}"]`), state.lines[i]);
      renderTotals();
    }

    function totals() {
      let dr = 0, cr = 0;
      for (const l of state.lines) {
        const a = Math.abs(Number(String(l.amount).replace(/[^0-9.\-]/g, '')) || 0);
        if (l.postingType === 'Credit') cr += a; else dr += a;
      }
      return { dr: Math.round(dr * 100) / 100, cr: Math.round(cr * 100) / 100 };
    }

    function blockers() {
      const out = [];
      const { dr, cr } = totals();
      if (state.lines.length < 2) out.push('an entry needs at least two lines');
      if (state.lines.some((l) => !l.accountId)) out.push('every line needs an account');
      if (state.lines.some((l) => !(Number(String(l.amount).replace(/[^0-9.\-]/g, '')) > 0))) {
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
      $('jePost').disabled = b.length > 0;
      $('jeMsg').textContent = b.length ? `Blocked: ${b.join('; ')}.` : 'Ready to post.';
      $('jeMsg').className = 'je-msg' + (b.length ? ' je-bad' : ' je-ok');
    }

    $('jeLines').addEventListener('change', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (!tr) return;
      const l = state.lines[Number(tr.dataset.i)];
      const f = e.target.dataset.f;
      if (!f) return;
      l[f] = e.target.value;
      if (f === 'accountId') {
        // Changing the account can change whether an entity is required, and a
        // stale entity on a line that no longer takes one would ride along.
        if (!lineNeedsEntity(l)) l.entity = '';
        // Only this row's entity cell changes -- rebuilding the table here
        // would re-parse every option list on every account pick.
        const cell = tr.children[4];
        cell.innerHTML = entityCell(l);
        const sel = cell.querySelector('[data-f="entity"]');
        if (sel) sel.value = l.entity || '';
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
      if (!e.target.closest('[data-del]')) return;
      state.lines.splice(Number(e.target.closest('tr[data-i]').dataset.i), 1);
      renderLines();
    });

    $('jeAddLine').addEventListener('click', () => appendLine());
    $('jeMemo').addEventListener('input', renderTotals);
    $('jeDate').addEventListener('change', renderTotals);

    const close = () => scrim.remove();
    $('jeClose').addEventListener('click', close);
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape' && document.body.contains(scrim)) { close(); }
      if (!document.body.contains(scrim)) document.removeEventListener('keydown', onEsc);
    });

    $('jePost').addEventListener('click', async () => {
      const { dr, cr } = totals();
      if (!confirm(
        `Post this adjustment to QuickBooks?\n\n`
        + `${state.lines.length} lines, ${money(dr)} each side, dated ${$('jeDate').value}.\n\n`
        + `This writes a journal entry to the live books.`)) return;

      $('jePost').disabled = true;
      $('jeMsg').textContent = 'Posting…';
      $('jeMsg').className = 'je-msg';

      try {
        const { data: adj, error: aErr } = await db.from('journal_adjustments').insert({
          company_entity_id: companyId,
          entry_date: $('jeDate').value,
          memo: $('jeMemo').value.trim(),
          source_context: context || null,
        }).select('id').single();
        if (aErr) throw new Error(aErr.message);

        const rows = state.lines.map((l, i) => {
          const a = acct(l.accountId);
          const loc = ref.locations.find((x) => x.id === l.locationId);
          const [etype, eid] = (l.entity || '').split(':');
          const ent = eid ? ref.entities.find((x) => x.id === eid && x.type === etype) : null;
          return {
            company_entity_id: companyId,
            adjustment_id: adj.id,
            line_no: i + 1,
            qbo_account_id: l.accountId,
            qbo_account_name: a?.name || null,
            posting_type: l.postingType === 'Credit' ? 'Credit' : 'Debit',
            amount: Math.abs(Number(String(l.amount).replace(/[^0-9.\-]/g, ''))).toFixed(2),
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

        const { error: apErr } = await db.from('journal_adjustments').update({
          status: 'approved',
          approved_at: new Date().toISOString(),
          approved_by: (await db.auth.getUser()).data.user?.id || null,
        }).eq('id', adj.id);
        if (apErr) throw new Error(apErr.message);

        const { data: { session } } = await db.auth.getSession();
        const url = (window.__SILO_CONFIG__?.SUPABASE_URL || '') + '/functions/v1/quickbooks-post-journal';
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({ adjustment_id: adj.id }),
        });
        const out = await res.json();
        // The staged adjustment survives a failed post on purpose: it keeps the
        // reason and the lines, so a fixed entry is a retry rather than a retype.
        if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);

        $('jeMsg').textContent = `Posted as journal entry ${out.doc_number || out.qbo_journal_entry_id}.`;
        $('jeMsg').className = 'je-msg je-ok';
        setTimeout(() => { close(); if (onPosted) onPosted(out); }, 900);
      } catch (e) {
        $('jeMsg').textContent = `Post failed — ${e.message}`;
        $('jeMsg').className = 'je-msg je-bad';
        $('jePost').disabled = false;
      }
    });

    // Reference data, then the opening lines.
    loadReference(db).then((r) => {
      acctOpts = r.accounts
        .map((a) => `<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.type)}</option>`).join('');
      locOpts = r.locations
        .map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
      entOpts = r.entities
        .map((e) => `<option value="${esc(e.type)}:${esc(e.id)}">${esc(e.name)} · ${esc(e.type)}</option>`)
        .join('');

      state.lines = [];
      const seeds = prefill?.lines?.length ? prefill.lines : [{}, {}];
      seeds.forEach(addLine);
      renderLines();   // one build for the opening rows; edits go in place
    }).catch((e) => {
      $('jeMsg').textContent = `Could not load the chart of accounts — ${e.message}`;
      $('jeMsg').className = 'je-msg je-bad';
    });
  }

  window.SiloJE = { open };
})();
