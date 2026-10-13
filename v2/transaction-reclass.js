/* window.SiloReclass — reclassify a transaction whose period is already posted
 * to QuickBooks.
 *
 * A posted period is frozen (its rows cannot be recoded and its QuickBooks
 * entry is the approved snapshot), so a category change after posting is a
 * small journal adjustment instead: debit the new account, credit the old one
 * (the other way round for a refund). stage_card_transaction_reclass() writes
 * that adjustment as a DRAFT plus the reclass record; this module then opens
 * the composer on the stored draft in review-only mode, so what is approved is
 * what the database holds, and only "Approve & post" reaches QuickBooks.
 *
 * The transaction row and the posted entry never change. The page shows where
 * the amount sits now: the latest POSTED reclass's target, else the coding.
 *
 *   SiloReclass.load(db, companyId, transactionIds) -> Map(txnId -> [reclass…])
 *   SiloReclass.section(t, batch, list, esc)        -> detail-panel HTML
 *   SiloReclass.open({ db, companyId, t, batch, list, accounts, locations,
 *                      entities, onChanged, setStatus })
 */
(function () {
  'use strict';

  const OPEN = new Set(['draft', 'approved']);

  async function load(db, companyId, ids) {
    const byTxn = new Map();
    if (!ids?.length || !companyId) return byTxn;
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db.from('card_transaction_reclasses_v')
        .select('*').eq('company_entity_id', companyId)
        .in('transaction_id', ids.slice(i, i + 200)).order('created_at');
      if (error) throw new Error(error.message);
      for (const r of data || []) {
        if (!byTxn.has(r.transaction_id)) byTxn.set(r.transaction_id, []);
        byTxn.get(r.transaction_id).push(r);
      }
    }
    return byTxn;
  }

  // The latest posted reclass is where the amount sits in QuickBooks now.
  const current = (list) => (list || []).filter((r) => r.adjustment_status === 'posted').at(-1) || null;
  const pending = (list) => (list || []).find((r) => OPEN.has(r.adjustment_status)) || null;

  // Why this row cannot be reclassified here, or null. Mirrors the RPC's
  // refusals so the button is not offered where it would only fail; the RPC
  // remains the authority.
  function blocker(t, batch, list) {
    if (!t || !batch || batch.status !== 'posted') return 'not-posted';
    if (t.status !== 'coded') return 'Only a categorized transaction can be reclassified.';
    if (!t.qbo_account_id) return 'A split transaction needs a journal entry instead.';
    if (!Number(t.amount)) return 'A zero-amount transaction has nothing to reclassify.';
    if (t.origin === 'plaid' && !['purchase', 'refund'].includes(t.accounting_treatment)) {
      return 'Only a purchase or refund is reclassified here; transfers, payments and settlements need a journal entry.';
    }
    if (pending(list)) return 'A reclassification is awaiting review or posting.';
    return null;
  }

  const STATUS = { draft: 'Draft — not in QuickBooks', approved: 'Approved — not posted yet', posted: 'Posted to QuickBooks' };

  function section(t, batch, list, esc) {
    if (!batch || batch.status !== 'posted') return '';
    const why = blocker(t, batch, list);
    const now = current(list);
    const open = pending(list);
    const rows = (list || []).map((r) => `<tr><td>${esc(r.from_qbo_account_name || r.from_qbo_account_id)} → <b>${esc(r.to_qbo_account_name || r.to_qbo_account_id)}</b>`
      + `<div class="cc-note">${esc(r.reason)}</div></td><td class="bcn-mono">${esc(String(r.entry_date || '').slice(0, 10))}</td>`
      + `<td><span class="bcn-pill">${esc(STATUS[r.adjustment_status] || r.adjustment_status)}</span>`
      + `${r.qbo_doc_number ? ` <span class="bcn-mono">JE ${esc(r.qbo_doc_number)}</span>` : ''}</td></tr>`).join('');
    return `<section data-reclass-section><h3>Reclassify after posting</h3>
      <p class="cc-note">This period is posted to QuickBooks, so its coding is locked. A reclass posts a small adjusting entry moving this amount to another category; the original entry is untouched.</p>
      ${now ? `<p>In QuickBooks now: <b>${esc(now.to_qbo_account_name || now.to_qbo_account_id)}</b> (originally ${esc(t.qbo_account_name || t.qbo_account_id)})</p>` : ''}
      ${rows ? `<table class="bcn-table txn-dimensions"><tbody>${rows}</tbody></table>` : ''}
      <div class="txn-detail-actions">
        ${open ? `<button class="bcn-btn bcn-btn--primary" type="button" data-reclass-review="${esc(open.adjustment_id)}">${open.adjustment_status === 'draft' ? 'Review and post' : 'Post approved reclass'}</button>`
          + (open.adjustment_status === 'draft' ? `<button class="bcn-btn bcn-btn--ghost" type="button" data-reclass-discard="${esc(open.adjustment_id)}">Discard draft</button>` : '') : ''}
        ${!open ? `<button class="bcn-btn" type="button" data-reclass${why ? ` disabled title="${esc(why)}"` : ''}>Reclassify…</button>` : ''}
      </div>
      ${why && why !== 'not-posted' && !open ? `<p class="cc-note">${esc(why)}</p>` : ''}
    </section>`;
  }

  function option(value, label, selected) {
    const o = document.createElement('option');
    o.value = value; o.textContent = label; o.selected = !!selected;
    return o;
  }
  function field(labelText, control, note) {
    const label = document.createElement('label');
    label.className = 'bcn-field-label';
    label.style.cssText = 'display:block;margin:12px 0 0;font-size:12px';
    label.append(document.createTextNode(labelText), control);
    control.style.cssText = 'display:block;width:100%;margin-top:6px';
    if (note) { const n = document.createElement('div'); n.className = 'cc-note'; n.textContent = note; label.append(n); }
    return label;
  }

  // The staging dialog. Resolves with the RPC result, or null when cancelled.
  function ask({ db, t, list, accounts, locations, entities, connectionId }) {
    const from = current(list);
    const fromAccount = from?.to_qbo_account_id || t.qbo_account_id;
    const fromLocation = from ? from.to_qbo_location_id : t.qbo_location_id;
    const fromEntity = from ? (from.to_entity_qbo_id ? `${from.to_entity_type}:${from.to_entity_qbo_id}` : '')
      : (t.entity_qbo_id && t.entity_type ? `${t.entity_type}:${t.entity_qbo_id}` : '');
    const inConn = (x) => !connectionId || x.connectionId === connectionId;
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'bcn-card';
      dialog.style.cssText = 'width:560px;max-width:calc(100vw - 32px);padding:20px;color:var(--bcn-ink);background:var(--bcn-surface);border:1px solid var(--bcn-border);border-radius:12px';
      const heading = document.createElement('h2'); heading.textContent = 'Reclassify posted transaction';
      const intro = document.createElement('p');
      intro.textContent = `${t.txn_date} · ${t.clean_merchant || t.description || ''} · $${Math.abs(Number(t.amount)).toFixed(2)}. `
        + `Currently ${(accounts.find((a) => a.id === fromAccount) || {}).name || fromAccount}. `
        + 'This stages an adjusting entry for review. Nothing reaches QuickBooks until you approve it.';
      const form = document.createElement('form'); form.method = 'dialog';

      const account = document.createElement('select'); account.className = 'bcn-field'; account.required = true;
      account.append(option('', 'Choose the correct category…'));
      for (const a of accounts.filter(inConn)) account.append(option(a.id, `${a.name} · ${a.type}`, false));
      const location = document.createElement('select'); location.className = 'bcn-field';
      location.append(option('', 'No location'));
      for (const l of locations.filter(inConn)) location.append(option(l.id, l.name, l.id === fromLocation));
      const entity = document.createElement('select'); entity.className = 'bcn-field';
      entity.append(option('', 'None'));
      for (const e of entities.filter(inConn)) entity.append(option(`${e.type}:${e.id}`, `${e.name} · ${e.type}`, `${e.type}:${e.id}` === fromEntity));
      // Defaults keep the current location and entity; only the category must be chosen.
      location.value = locations.some((l) => inConn(l) && l.id === fromLocation) ? fromLocation : '';
      entity.value = entities.some((e) => inConn(e) && `${e.type}:${e.id}` === fromEntity) ? fromEntity : '';
      const date = document.createElement('input'); date.type = 'date'; date.className = 'bcn-field bcn-field--mono';
      const reason = document.createElement('textarea'); reason.className = 'bcn-field'; reason.required = true; reason.minLength = 3; reason.maxLength = 500;
      reason.placeholder = 'Why the category is wrong — travels to QuickBooks in the memo';

      const status = document.createElement('div'); status.className = 'bcn-status bcn-status--neg'; status.hidden = true;
      const actions = document.createElement('div'); actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'bcn-btn'; cancel.textContent = 'Cancel';
      const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'bcn-btn bcn-btn--primary'; submit.textContent = 'Stage for review';
      let result = null;
      cancel.addEventListener('click', () => dialog.close());
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        status.hidden = true;
        if (!account.value) { status.textContent = 'Choose the correct category.'; status.hidden = false; return; }
        if (reason.value.trim().length < 3) { status.textContent = 'Give a reason.'; status.hidden = false; return; }
        const [etype, eid] = entity.value ? entity.value.split(':') : [null, null];
        submit.disabled = true; submit.textContent = 'Staging…';
        const { data, error } = await db.rpc('stage_card_transaction_reclass', {
          p_transaction_id: t.id, p_to_account_id: account.value, p_to_location_id: location.value || null,
          p_to_entity_type: etype, p_to_entity_id: eid, p_entry_date: date.value || null, p_reason: reason.value.trim(),
        });
        submit.disabled = false; submit.textContent = 'Stage for review';
        if (error) { status.textContent = error.message; status.hidden = false; return; }
        result = data; dialog.close();
      });
      dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
      actions.append(cancel, submit);
      form.append(
        field('Correct category', account),
        field('Location', location),
        field('Customer or vendor', entity, 'Required for a receivable (customer) or payable (vendor) account.'),
        field('Entry date', date, 'Blank = the original entry date, or the first open day if that month is locked.'),
        field('Reason', reason),
        status, actions);
      dialog.append(heading, intro, form);
      document.body.append(dialog); dialog.showModal(); account.focus();
    });
  }

  function review({ db, companyId, adjustmentId, t, onChanged }) {
    window.SiloJE.open({
      db, companyId, adjustmentId, reviewOnly: true,
      context: `transactions:reclass:${t.id}`,
      onPosted: () => onChanged?.('Reclass posted to QuickBooks.'),
    });
  }

  async function open(opts) {
    const { db, companyId, t, onChanged, setStatus } = opts;
    const staged = await ask({ ...opts, db });
    if (!staged) return;
    // Refresh first so the panel shows the staged draft (and offers Review)
    // even if the composer is closed without posting.
    await onChanged?.(null);
    setStatus?.('Reclass staged as a draft — nothing is in QuickBooks until you approve and post it.', 'info', 8000);
    review({ db, companyId, adjustmentId: staged.adjustment_id, t, onChanged });
  }

  async function discard({ db, companyId, adjustmentId }) {
    // RLS deletes only a DRAFT adjustment in the active company; the reclass
    // record goes with it (foreign key cascade). Zero rows = it was not a draft.
    const { data, error } = await db.from('journal_adjustments').delete()
      .eq('id', adjustmentId).eq('company_entity_id', companyId).eq('status', 'draft').select('id');
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error('Only a draft reclass can be discarded. Reload to see its current state.');
  }

  window.SiloReclass = { load, current, pending, blocker, section, open, review, discard };
})();
