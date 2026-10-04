/* On Deck · transaction coding.

   Prepared item -> preview -> explicit approval -> action -> receipt, on the
   card-coding workflow that already exists. This file adds no coding logic:
     - the queue is on_deck_coding_items() (finance-gated in the database);
     - saving categorizations is accept_card_coding_suggestions, which
       re-checks every row's fingerprint at the moment of the click;
     - the journal preview is card_import_batch_preview(), which runs the real
       approval and rolls it back, so what is shown is what approval freezes;
     - approval is approve_reviewed_card_import_batch(batch, hash), refused if
       the entry changed since the preview. APPROVAL IN SILO IS THE FINISH LINE:
       the entry is frozen in SILO's journal register and leaves the queue;
     - sending to QuickBooks is OPTIONAL and deliberately takes more steps
       (expand, acknowledge, confirm): quickbooks-post-journal with
       expected_approval_hash, refused if the entry was reapproved since review.
   Repeated clicks are harmless server-side (accepted rows are no longer open,
   approval returns the frozen hash, posting is claimed before Intuit) and
   buttons are disabled while a request is in flight.

   Pure decisions are exported for unit tests; mount() draws them. */
(function () {
  'use strict';

  const ACCEPT_BATCH = 500;
  const LOW_CONFIDENCE = 0.6;

  function money(value, currency) {
    const n = Number(value || 0);
    try {
      if (currency) return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
    } catch (_) { /* unknown code: fall through to a plain amount */ }
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  function dayRange(a, b) {
    if (!a) return 'No transaction dates';
    const f = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return a === b || !b ? f(a) : `${f(a)} – ${f(b)}`;
  }
  function transactionsHref(batchId, company) {
    return `/v2/transactions.html?batch=${encodeURIComponent(batchId)}&company=${encodeURIComponent(company || '')}`;
  }

  // Waiting for a person. Since the daily SILO ledger (20261005120000) a saved
  // categorization IS the finish line: the transaction is in SILO's books the
  // moment it is categorized. Preparing and sending the monthly QuickBooks
  // entry is optional and never counted as pending.
  const REVIEWABLE = ['code'];
  // Stages that are done as far as SILO is concerned (shown as receipts).
  const RECORDED = ['approve', 'approved', 'posted'];
  const NEEDS = {
    uncoded_without_suggestion: (i) => ({
      title: `${plural(i.uncoded_count, 'transaction')} need a person`,
      detail: 'SILO has no prepared account for these. Choose one in Transactions; nothing is guessed here.',
    }),
    posting_disabled: () => ({
      title: 'Recorded in SILO',
      detail: 'Every transaction is in the SILO ledger. This card does not send to QuickBooks (its \u201cposting enabled\u201d switch is off), so there is no monthly QuickBooks entry to prepare.',
    }),
    ledger_blocked: (i) => ({
      title: `${plural(i.ledger_unrecorded, 'categorized transaction')} not in the SILO ledger yet`,
      detail: `${i.ledger_reason || 'The coding cannot be recorded as it stands'}. Fix it in Transactions and it is recorded on save.`,
    }),
    posting_unresolved: () => ({
      title: 'Posting outcome needs checking',
      detail: 'A post was sent and its outcome is unknown. SILO has locked the entry so it cannot post twice. Open it in Transactions to check QuickBooks and resolve it.',
    }),
  };

  /* What a queue card says. Every number comes from the item; nothing here is
     estimated. */
  function cardModel(item) {
    const where = [item.source_name, item.label].filter(Boolean).join(' · ');
    const base = { stage: item.stage, subtitle: where, reviewable: REVIEWABLE.includes(item.stage), currency: item.currency };
    switch (item.stage) {
      case 'code':
        return { ...base, pill: 'Prepared', title: `Code ${plural(item.open_suggestions, 'transaction')}`,
          figure: money(item.suggested_amount, item.currency), caption: 'ready to classify', action: 'Review' };
      case 'approve':
        return { ...base, pill: 'In SILO ledger', title: 'Recorded in SILO',
          figure: money(item.coded_amount, item.currency),
          caption: `${plural(item.txn_count - item.excluded_count, 'transaction')} in the SILO ledger · QuickBooks entry not prepared (optional)`, action: 'View' };
      case 'approved':
        return { ...base, pill: 'In SILO ledger', title: 'QuickBooks entry approved',
          figure: money(item.coded_amount, item.currency), caption: 'in the SILO ledger · not sent to QuickBooks (optional)', action: 'View' };
      case 'posted':
        return { ...base, pill: 'In SILO + QuickBooks', title: 'Recorded in SILO and QuickBooks',
          figure: item.qbo_doc_number || item.qbo_journal_entry_id || '—', caption: 'QuickBooks journal entry', action: 'View' };
      default: {
        const n = (NEEDS[item.stage_reason] || (() => ({ title: 'Needs input', detail: 'Open this import in Transactions.' })))(item);
        if (item.stage_reason === 'posting_disabled') {
          return { ...base, stage: 'approve', pill: 'In SILO ledger', title: n.title, detail: n.detail,
            figure: money(item.coded_amount, item.currency), caption: 'in the SILO ledger', action: null, reviewable: false };
        }
        return { ...base, stage: 'needs_input', pill: 'Needs input', title: n.title, detail: n.detail,
          figure: null, caption: null, action: 'Open in Transactions' };
      }
    }
  }

  /* The account bar: top three by count, the rest pooled as "Other". */
  function mixSegments(mix) {
    const rows = (mix || []).filter((m) => m && m.count > 0);
    const total = rows.reduce((s, m) => s + m.count, 0);
    if (!total) return [];
    const top = rows.slice(0, 3).map((m) => ({ label: m.account || 'Unnamed account', count: m.count }));
    const rest = rows.slice(3).reduce((s, m) => s + m.count, 0);
    if (rest) top.push({ label: 'Other', count: rest });
    return top.map((m) => ({ ...m, share: m.count / total }));
  }

  /* A low-confidence suggestion starts unticked: saving it should be a choice. */
  const defaultSelected = (s) => s.confidence == null || Number(s.confidence) >= LOW_CONFIDENCE;

  /* What a posting response means for the person who clicked. */
  function postOutcome(status, body) {
    const b = body || {};
    if (status >= 200 && status < 300 && (b.ok || b.recovered)) return { kind: 'posted', message: 'Sent to QuickBooks.' };
    if (b.code === 'APPROVAL_CHANGED') return { kind: 'changed', message: b.error || 'The entry was reapproved after you reviewed it.' };
    if (status === 409 && /already posted/i.test(b.error || '')) return { kind: 'already', message: 'This entry is already posted.' };
    if (b.code === 'UNKNOWN_OUTCOME' || b.code === 'LOCAL_PERSISTENCE_FAILURE' || status === 0 || status >= 500) {
      return { kind: 'unknown', message: 'The QuickBooks outcome is unknown. The entry is still approved in SILO, and SILO has locked the send so it cannot post twice. Open it in Transactions to check QuickBooks and resolve it.' + (b.error ? ` (${b.error})` : '') };
    }
    return { kind: 'error', message: b.error || `Posting failed (HTTP ${status}).` };
  }

  /* Coded transactions the ledger refused (silo_ledger_batch_status) are not
     done: such an import is needs input, whatever its QuickBooks stage, unless
     it still has suggestions to review (that card comes first) or is posted. */
  function applyLedgerStatus(items, status) {
    const byBatch = new Map((status || []).map((s) => [s.batch_id, s]));
    return (items || []).map((i) => {
      const s = byBatch.get(i.batch_id);
      if (!s || !(s.unrecorded > 0) || i.stage === 'code' || i.stage === 'posted') return i;
      return { ...i, stage: 'needs_input', stage_reason: 'ledger_blocked', ledger_unrecorded: s.unrecorded, ledger_reason: s.reason };
    });
  }

  // Done as far as SILO is concerned: shown under "After approval", never as pending work.
  const isRecorded = (item) => RECORDED.includes(item.stage) || item.stage_reason === 'posting_disabled';

  const API = { money, cardModel, mixSegments, defaultSelected, postOutcome, transactionsHref, dayRange, isRecorded, applyLedgerStatus, REVIEWABLE, RECORDED, LOW_CONFIDENCE };

  // ───────────────────────────────────────────────────────────── UI ──
  function el(tag, text, className) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (className) n.className = className;
    return n;
  }
  function btn(text, fn, kind) {
    const b = el('button', text, `bcn-btn ${kind === 'primary' ? 'bcn-btn--primary' : 'bcn-btn--ghost'}`);
    b.type = 'button'; b.addEventListener('click', fn); return b;
  }
  function link(text, href, className) { const a = el('a', text, className); a.href = href; return a; }

  /* Draws the coding cards and the review panel. ctx:
     { db, co, cfg, access:{review,post}, reviewEl, message(text,bad), stillActive(), onChange() } */
  function mount(ctx) {
    const st = { items: [], active: null, preview: null, rows: [], selected: new Set(), receipt: null, busy: false, token: 0 };
    const rpc = async (name, args) => { const { data, error } = await ctx.db.rpc(name, args); if (error) throw Object.assign(new Error(error.message), { code: error.code }); return data; };

    async function load() {
      st.items = ctx.access.review ? (await rpc('on_deck_coding_items')) || [] : [];
      if (st.items.length) {
        // Before the ledger migration the function does not exist: nothing is
        // recorded by SILO then, so there is nothing to flag.
        let status = [];
        try { status = (await rpc('silo_ledger_batch_status')) || []; }
        catch (e) { if (!['42883', 'PGRST202'].includes(e.code)) throw e; }
        st.items = applyLedgerStatus(st.items, status);
      }
      if (st.active && !st.items.some((i) => i.batch_id === st.active)) close();
      return st.items;
    }
    const item = () => st.items.find((i) => i.batch_id === st.active);

    function card(i) {
      const m = cardModel(i);
      const c = el('article', null, `od-rcard od-rcard--${m.stage}`);
      c.dataset.batch = i.batch_id;
      const top = el('div', null, 'od-rcard-top');
      const mark = el('span', '▤', 'od-mark'); mark.dataset.kind = 'coding'; mark.setAttribute('aria-hidden', 'true');
      top.append(mark, el('span', 'Accounting', 'od-rcard-module'), el('span', m.pill, `od-rpill od-rpill--${m.stage}`));
      c.append(top, el('h3', m.title), el('p', m.subtitle, 'od-rcard-sub'));
      if (m.figure != null) { const fig = el('div', null, 'od-rcard-figure'); fig.append(el('strong', m.figure), el('span', m.caption)); c.append(fig); }
      if (m.detail) c.append(el('p', m.detail, 'od-rcard-detail'));
      const segs = m.stage === 'code' ? mixSegments(i.account_mix) : [];
      if (segs.length) {
        const bar = el('div', null, 'od-mix'); bar.setAttribute('role', 'img');
        bar.setAttribute('aria-label', segs.map((s) => `${s.label} ${s.count}`).join(', '));
        segs.forEach((s, n) => { const seg = el('span', null, `od-mix-seg od-mix-seg--${n}`); seg.style.width = `${(s.share * 100).toFixed(2)}%`; bar.append(seg); });
        const legend = el('ul', null, 'od-mix-legend');
        segs.forEach((s, n) => { const li = el('li', null); li.append(el('i', null, `od-mix-seg--${n}`), el('span', s.label), el('b', String(s.count))); legend.append(li); });
        c.append(bar, legend);
      }
      const ev = el('details', null, 'od-rcard-evidence');
      ev.append(el('summary', `Sources · ${plural(i.txn_count, 'record')} · ${dayRange(i.first_txn, i.last_txn)}`));
      const ul = el('ul');
      [
        `${plural(i.txn_count, 'transaction')} in this import (${i.excluded_count} excluded, ${i.uncoded_count} uncoded)`,
        i.open_suggestions ? `${plural(i.open_suggestions, 'prepared suggestion')} from your rules and coding history` : null,
        i.low_confidence ? `${i.low_confidence} low-confidence (left unticked for you)` : null,
        i.needs_judgment ? `${i.needs_judgment} SILO declined to suggest — a person chooses` : null,
        i.failed ? `${i.failed} not prepared (preparation failed)` : null,
        `Import updated ${new Date(i.updated_at).toLocaleString()}`,
      ].filter(Boolean).forEach((t) => ul.append(el('li', t)));
      ev.append(ul); c.append(ev);
      if (m.action === 'Review') c.append(btn('Review →', () => open(i.batch_id), 'primary'));
      else if (m.action === 'View') c.append(btn('View entry', () => open(i.batch_id)));
      else if (m.action) c.append(link(`${m.action} ↗`, transactionsHref(i.batch_id, ctx.co), 'bcn-btn bcn-btn--ghost'));
      return c;
    }

    // Mark the card whose output is open, so the review reads as "this one".
    function markActive() {
      document.querySelectorAll('.od-rcard[data-batch]').forEach((c) => {
        if (c.dataset.batch === st.active) c.setAttribute('aria-current', 'true'); else c.removeAttribute('aria-current');
      });
    }
    function close() { st.active = null; markActive(); st.preview = null; st.receipt = null; ctx.reviewEl.hidden = true; ctx.reviewEl.replaceChildren(); }

    async function open(batchId, keepReceipt) {
      // One action at a time: switching batches mid-request would let the
      // request's follow-up render (or a selection) belong to the wrong batch.
      if (st.busy && batchId !== st.active) { ctx.message('Wait for the current action to finish before opening another item.'); return; }
      st.active = batchId; st.preview = null; st.rows = []; if (!keepReceipt) st.receipt = null; markActive();
      const token = ++st.token;
      ctx.reviewEl.hidden = false; ctx.reviewEl.replaceChildren(el('div', 'Loading the prepared output…', 'od-empty'));
      ctx.reviewEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
      try {
        const i = item();
        if (!i) { close(); return; }
        // Load into locals and commit only if this is still the current open:
        // a slow load for one batch must never replace another batch's rows,
        // selection or preview (cycle-2 review).
        const loaded = i.stage === 'code' ? await loadSuggestions(i)
          : { preview: await rpc('card_import_batch_preview', { p_batch_id: batchId }) };
        if (token !== st.token || st.active !== batchId) return;
        st.rows = loaded.rows || []; st.selected = loaded.selected || new Set();
        st.unprepared = loaded.unprepared || 0; st.preview = loaded.preview || null;
        render();
      } catch (e) { if (token === st.token) { ctx.reviewEl.replaceChildren(el('div', e.message, 'bcn-status bcn-status--neg')); } }
    }

    async function loadSuggestions(i) {
      const { data, error } = await ctx.db.from('card_transactions')
        .select('id,txn_date,description,clean_merchant,amount,card_name,status,qbo_account_id')
        .eq('company_entity_id', ctx.co).eq('batch_id', i.batch_id).eq('status', 'uncoded')
        .order('txn_date', { ascending: true }).limit(2000);
      if (error) throw new Error(error.message);
      const loaded = await window.SiloCodingSuggestions.load(ctx.db, ctx.co, (data || []).map((t) => t.id));
      if (!loaded.available) throw new Error('Prepared coding suggestions are not installed in this environment.');
      const rows = (data || []).map((t) => ({ t, s: loaded.byTransaction.get(t.id) || null }))
        .filter((r) => r.s && r.s.kind === 'ready' && window.SiloCodingSuggestions.applies(r.t, false));
      return { rows, selected: new Set(rows.filter((r) => defaultSelected(r.s)).map((r) => r.s.id)),
        unprepared: (data || []).length - rows.length };
    }

    function head(i, m) {
      const h = el('div', null, 'od-review-head');
      const left = el('div');
      left.append(el('span', `ACCOUNTING · ${m.pill.toUpperCase()}`, 'od-eyebrow'), el('h2', m.title), el('p', m.subtitle, 'od-meta'));
      h.append(left, btn('Close', close));
      return h;
    }

    function receipt() {
      if (!st.receipt) return null;
      const r = el('div', null, `od-receipt od-receipt--${st.receipt.kind}`);
      r.setAttribute('role', 'status');
      r.append(el('strong', st.receipt.title));
      (st.receipt.lines || []).forEach((t) => r.append(el('p', t)));
      if (st.receipt.link) r.append(link(st.receipt.link[0], st.receipt.link[1]));
      return r;
    }

    function render() {
      const i = item(); if (!i) return close();
      const m = cardModel(i);
      const box = ctx.reviewEl; box.replaceChildren(head(i, m));
      const rec = receipt(); if (rec) box.append(rec);
      if (i.stage === 'code') renderCode(i, box); else renderEntry(i, box);
      const foot = el('p', null, 'od-review-note');
      foot.append(el('span', 'Need to change something? '), link('Edit in Transactions ↗', transactionsHref(i.batch_id, ctx.co)),
        el('span', ' Any change there means this entry must be reviewed again here.'));
      box.append(foot);
    }

    function renderCode(i, box) {
      const panel = el('div', null, 'od-panel');
      if (!st.rows.length) {
        panel.append(el('p', 'No prepared suggestions are current for this import. They may have been saved, dismissed or invalidated by a change to the transaction.'));
        box.append(panel); return;
      }
      const sum = () => st.rows.filter((r) => st.selected.has(r.s.id)).reduce((a, r) => a + Number(r.t.amount || 0), 0);
      const summary = el('p', null, 'od-review-summary');
      const table = el('table', null, 'bcn-table od-review-table');
      const thead = el('thead'); const hr = el('tr');
      ['', 'Date', 'Transaction', 'Amount', 'Suggested account', 'Location', 'Confidence'].forEach((t) => hr.append(el('th', t, t === 'Amount' || t === 'Confidence' ? 'bcn-num' : null)));
      thead.append(hr); table.append(thead);
      const tbody = el('tbody');
      st.rows.forEach(({ t, s }) => {
        const tr = el('tr');
        const box1 = el('input'); box1.type = 'checkbox'; box1.checked = st.selected.has(s.id);
        box1.setAttribute('aria-label', `Include ${t.description}`);
        box1.addEventListener('change', () => { if (box1.checked) st.selected.add(s.id); else st.selected.delete(s.id); update(); });
        const td0 = el('td'); td0.append(box1);
        const desc = el('td'); desc.append(el('span', t.clean_merchant || t.description));
        const why = el('details', null, 'od-why'); why.append(el('summary', 'Evidence'));
        [t.description, s.reasoning, s.evidence ? `History: ${s.evidence}` : null, s.history_status ? `History status: ${s.history_status}` : null]
          .filter(Boolean).forEach((x) => why.append(el('p', x)));
        desc.append(why);
        const conf = s.confidence == null ? '—' : `${Math.round(Number(s.confidence) * 100)}%`;
        const confCell = el('td', conf, `bcn-num${Number(s.confidence) < LOW_CONFIDENCE ? ' od-low' : ''}`);
        tr.append(td0, el('td', t.txn_date, 'bcn-mono'), desc, el('td', money(t.amount, i.currency), 'bcn-num'),
          el('td', s.account_name || s.qbo_account_name || '—'), el('td', s.location_name || '—'), confCell);
        tbody.append(tr);
      });
      table.append(tbody);
      const scroll = el('div', null, 'bcn-matrix-scroll'); scroll.append(table);
      panel.append(summary, scroll);
      if (st.unprepared) panel.append(el('div', `${plural(st.unprepared, 'other uncoded transaction')} have no current suggestion and need a person in Transactions.`, 'od-warning'));
      box.append(panel);
      const footer = el('div', null, 'od-footer');
      const save = btn('', () => saveCoding(i, save), 'primary');
      footer.append(save, el('span', 'Saves these accounts to the transactions in SILO. Nothing is sent to QuickBooks; the journal entry is approved separately.', 'od-meta'));
      box.append(footer);
      function update() {
        const n = st.selected.size;
        summary.textContent = `${n} of ${st.rows.length} selected · ${money(sum(), i.currency)}`;
        save.textContent = `Save ${plural(n, 'categorization')}`;
        save.disabled = st.busy || n === 0;
      }
      update();
    }

    async function saveCoding(i, button) {
      if (st.busy) return;
      // Bind the request to what was on screen at the click, BEFORE any await:
      // the selection and the open batch are shared state (cycle-1 review).
      const ids = st.rows.filter((r) => st.selected.has(r.s.id)).map((r) => r.s.id);
      const batch = st.active;
      if (batch !== i.batch_id || !ids.length) return;
      st.busy = true; button.disabled = true; button.textContent = 'Saving…';
      try {
        await ctx.stillActive();
        if (st.active !== batch) throw new Error('The open item changed. Nothing was saved.');
        const accepted = []; const refused = [];
        for (let n = 0; n < ids.length; n += ACCEPT_BATCH) {
          const out = await window.SiloCodingSuggestions.accept(ctx.db, ids.slice(n, n + ACCEPT_BATCH));
          accepted.push(...out.accepted); refused.push(...out.refused);
        }
        const reasons = {};
        refused.forEach((r) => { const t = window.SiloCodingSuggestions.reasonText(r.reason); reasons[t] = (reasons[t] || 0) + 1; });
        st.receipt = {
          kind: refused.length ? (accepted.length ? 'partial' : 'failed') : 'done',
          title: accepted.length ? `Saved ${plural(accepted.length, 'categorization')} \u2014 recorded in the SILO ledger` : 'Nothing was saved',
          lines: Object.entries(reasons).map(([t, n]) => `${n} not saved: ${t}.`),
        };
      } catch (e) {
        st.receipt = { kind: 'failed', title: 'Nothing was saved', lines: [e.message] };
      } finally { st.busy = false; }
      await refreshAfterAction(i.batch_id);
    }

    function renderEntry(i, box) {
      const p = st.preview || {};
      const panel = el('div', null, 'od-panel');
      if (!p.ready) {
        const needs = el('div', null, 'od-needs');
        needs.append(el('strong', 'The monthly QuickBooks entry needs input'),
          el('p', `${p.blocker || 'It cannot be prepared yet.'} Your SILO ledger is unaffected: categorized transactions are already recorded.`),
          link('Resolve in Transactions ↗', transactionsHref(i.batch_id, ctx.co)));
        panel.append(needs); box.append(panel); return;
      }
      const paper = el('div', null, 'od-paper od-entry');
      paper.append(el('span', p.status === 'draft' || p.status === 'categorized' ? 'MONTHLY QUICKBOOKS ENTRY / OPTIONAL' : 'MONTHLY QUICKBOOKS ENTRY / APPROVED', 'od-paper-label'));
      const facts = el('dl', null, 'od-evidence');
      const fact = (k, v) => { const d = el('div'); d.append(el('dt', k), el('dd', v == null || v === '' ? 'Unknown' : String(v))); facts.append(d); };
      const dest = p.destination || {};
      fact('SILO LEDGER', 'Already recorded, day by day, as each transaction was categorized');
      fact('CHART OF ACCOUNTS', dest.company_name ? `${dest.company_name}${dest.environment === 'sandbox' ? ' (sandbox)' : ''} · from QuickBooks` : 'QuickBooks connection unknown');
      fact('ENTRY DATE', p.entry_date);
      fact('SOURCE DATES', dayRange(p.facts?.first_txn, p.facts?.last_txn));
      fact('TRANSACTIONS', `${p.facts?.coded ?? 0} coded · ${p.facts?.excluded ?? 0} excluded`);
      paper.append(facts);
      if (p.memo) paper.append(el('p', p.memo, 'od-meta'));
      const table = el('table', null, 'bcn-table od-review-table');
      const thead = el('thead'); const hr = el('tr');
      ['Account', 'Location', 'Name', 'Description', 'Debit', 'Credit'].forEach((t) => hr.append(el('th', t, t === 'Debit' || t === 'Credit' ? 'bcn-num' : null)));
      thead.append(hr); table.append(thead);
      const tbody = el('tbody');
      (p.lines || []).forEach((l) => {
        const tr = el('tr');
        tr.append(el('td', l.account_name || `Account ${l.account_id}`), el('td', l.location_name || '—'), el('td', l.entity_name || '—'),
          el('td', l.description || ''), el('td', l.posting_type === 'Debit' ? money(l.amount, p.facts?.currency) : '', 'bcn-num'),
          el('td', l.posting_type === 'Credit' ? money(l.amount, p.facts?.currency) : '', 'bcn-num'));
        tbody.append(tr);
      });
      const tot = el('tr', null, 'od-total');
      tot.append(el('td', 'Total'), el('td'), el('td'), el('td'), el('td', money(p.debits, p.facts?.currency), 'bcn-num'), el('td', money(p.credits, p.facts?.currency), 'bcn-num'));
      tbody.append(tot); table.append(tbody);
      const scroll = el('div', null, 'bcn-matrix-scroll'); scroll.append(table); paper.append(scroll);
      const fp = el('details', null, 'od-rationale');
      fp.append(el('summary', 'Approval fingerprint'), el('p', `${p.hash}${p.approval_version ? ` · approval version ${p.approval_version}` : ''}`, 'bcn-mono'));
      paper.append(fp);
      panel.append(paper); box.append(panel);

      const footer = el('div', null, 'od-footer');
      if (p.status === 'draft' || p.status === 'categorized') {
        const approve = btn('Approve QuickBooks entry', () => approveEntry(i, approve));
        approve.disabled = st.busy || !ctx.access.review;
        footer.append(approve, el('span', 'Optional. Your SILO ledger already has these transactions; this freezes the monthly entry for QuickBooks. Nothing is sent yet.', 'od-meta'));
        box.append(footer);
        return;
      }
      if (p.status === 'posted' || p.posting?.status === 'posted') {
        footer.append(el('span', `In the SILO ledger · also in QuickBooks as entry ${p.posting?.qbo_doc_number || p.posting?.qbo_journal_entry_id || 'recorded'}${p.posting?.posted_at ? ` (${new Date(p.posting.posted_at).toLocaleString()})` : ''}`, 'od-meta'));
        box.append(footer);
        return;
      }
      footer.append(el('span', `QuickBooks entry approved${p.approval_version ? ` · version ${p.approval_version}` : ''}. The transactions are already in the SILO ledger.`, 'od-meta'));
      box.append(footer);
      // Optional and deliberately more work: expand, acknowledge, confirm.
      const qbo = el('details', null, 'od-qbo-optional');
      qbo.append(el('summary', 'Also send to QuickBooks (optional)'));
      qbo.append(el('p', 'SILO keeps this entry either way. Sending writes a copy to the connected QuickBooks books; QuickBooks history otherwise stays read-only in SILO.'));
      if (p.can_post && ctx.access.post) {
        const send = btn('Send to QuickBooks…', () => confirmPost(i, send));
        send.disabled = st.busy;
        qbo.append(send);
      } else {
        qbo.append(el('p', p.can_post ? 'Sending to QuickBooks requires finance access.' : 'Sending to QuickBooks is off for this card.', 'od-meta'));
      }
      box.append(qbo);
    }

    async function approveEntry(i, button) {
      if (st.busy) return; st.busy = true; button.disabled = true; button.textContent = 'Approving…';
      const hash = st.preview.hash;
      try {
        await ctx.stillActive();
        const out = await rpc('approve_reviewed_card_import_batch', { p_batch_id: i.batch_id, p_expected_hash: hash });
        st.receipt = { kind: 'done', title: out.already_approved ? 'QuickBooks entry already approved \u2014 same entry' : 'QuickBooks entry approved',
          lines: [`Frozen for QuickBooks (version ${out.approval_version}). Nothing was sent to QuickBooks.`] };
      } catch (e) {
        st.receipt = { kind: 'failed', title: e.code === '40001' ? 'The entry changed — review it again' : 'Not approved',
          lines: [e.code === '40001' ? 'The preview below has been refreshed with the current entry. Nothing was approved.' : e.message] };
      } finally { st.busy = false; }
      await refreshAfterAction(i.batch_id);
    }

    function confirmPost(i, button) {
      const dialog = document.getElementById('coding-post-dialog');
      const p = st.preview;
      document.getElementById('coding-post-summary').textContent =
        `Send ${money(p.debits, p.facts?.currency)} (${plural((p.lines || []).length, 'line')}) dated ${p.entry_date} to QuickBooks · ${p.destination?.company_name || 'the connected company'}. The transactions are already in the SILO ledger; this only adds a copy to QuickBooks, which can then only be reversed by voiding it there.`;
      const ack = document.getElementById('coding-post-ack');
      ack.checked = false;
      const go = document.getElementById('coding-post-confirm');
      const fresh = go.cloneNode(true); go.replaceWith(fresh);
      fresh.disabled = true;
      ack.onchange = () => { fresh.disabled = !ack.checked; };
      fresh.addEventListener('click', () => { if (!ack.checked) return; dialog.close(); postEntry(i, button, p.hash); }, { once: true });
      dialog.showModal();
    }

    async function postEntry(i, button, hash) {
      if (st.busy) return; st.busy = true; button.disabled = true; button.textContent = 'Posting…';
      let status = 0; let body = {};
      try {
        await ctx.stillActive();
        const { data: { session } } = await ctx.db.auth.getSession();
        const res = await fetch(`${ctx.cfg.SUPABASE_URL}/functions/v1/quickbooks-post-journal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}`, apikey: ctx.cfg.SUPABASE_ANON_KEY },
          body: JSON.stringify({ batch_id: i.batch_id, expected_approval_hash: hash }),
        });
        status = res.status; body = await res.json().catch(() => ({}));
      } catch (e) { body = { error: e.message }; }
      const o = postOutcome(status, body);
      st.receipt = {
        kind: o.kind === 'posted' || o.kind === 'already' ? 'done' : 'failed',
        title: o.kind === 'posted' ? 'Sent to QuickBooks' : o.kind === 'already' ? 'Already in QuickBooks' : o.kind === 'changed' ? 'The approval changed — review it again' : 'Not sent to QuickBooks',
        lines: [o.kind === 'posted' && (body.qbo_journal_entry_id || body.doc_number) ? `QuickBooks entry ${body.doc_number || body.qbo_journal_entry_id}.` : o.message,
          body.warning || null].filter(Boolean),
        link: o.kind === 'unknown' || o.kind === 'error' ? ['Open in Transactions ↗', transactionsHref(i.batch_id, ctx.co)] : null,
      };
      st.busy = false;
      await refreshAfterAction(i.batch_id);
    }

    async function refreshAfterAction(batchId) {
      try { await load(); } catch (e) { ctx.message(e.message, true); }
      await ctx.onChange();
      if (st.items.some((x) => x.batch_id === batchId)) await open(batchId, true);
      else {
        // Left the queue (e.g. posted more than a fortnight ago): keep the receipt visible.
        ctx.reviewEl.hidden = false; ctx.reviewEl.replaceChildren(); const r = receipt(); if (r) ctx.reviewEl.append(r);
      }
    }

    return { load, card, open, close, markActive, items: () => st.items };
  }

  API.mount = mount;
  if (typeof window !== 'undefined') window.SiloOnDeckCoding = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
