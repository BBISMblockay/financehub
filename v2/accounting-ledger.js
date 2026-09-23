/* Account roll-forward: opening balance + activity = closing balance.
 *
 * Three independent sources, never blended into one figure:
 *   opening   the ACCEPTED opening trial balance (accounting_opening_balances),
 *             as of the day before Silo's accounting start date
 *   silo      what Silo actually sent to QuickBooks: the Line array of every
 *             POSTED quickbooks_journal_postings payload dated after the
 *             opening date (voided and unposted entries are excluded)
 *   closing   a QuickBooks trial balance saved in quickbooks_report_runs
 *
 * "Other activity in QuickBooks" = closing - opening - silo. It is not an
 * error: it is everything entered directly in QuickBooks (bills, payments,
 * payroll, deposits) that Silo did not originate. Showing it as its own
 * column is the point -- folding it in would make Silo's ledger look complete
 * when it is not.
 *
 * Every amount is in cents and signed debits-minus-credits, the convention
 * the opening snapshot and the QBO history checks already use. Each column
 * sums to zero across all accounts when its source balances, which is shown.
 *
 * Read-only. The only write-adjacent call is "Fetch trial balance", which is
 * the same read-only quickbooks-report fetch Books setup uses to seed.
 */
(function () {
  'use strict';

  const POSTING_PAGE = 1000;
  const cents = (v) => {
    const n = Number(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  };

  // QBO TrialBalance rows: ColData[0] carries the account id and name, [1]
  // debit and [2] credit. Sections nest; summary rows carry no id and are
  // skipped, so a total is never read as an account.
  function parseTrialBalance(raw) {
    const out = new Map();
    const walk = (node) => {
      const rows = node?.Rows?.Row;
      if (!Array.isArray(rows)) return;
      for (const r of rows) {
        const cd = r.ColData;
        if (Array.isArray(cd) && cd[0]?.id) {
          const id = String(cd[0].id);
          const prev = out.get(id) || { name: cd[0].value || '', balance: 0 };
          prev.balance += cents(cd[1]?.value) - cents(cd[2]?.value);
          out.set(id, prev);
        }
        if (r.Rows) walk(r);
      }
    };
    walk(raw);
    return out;
  }

  // Posted payload lines per account, dated strictly after the opening date
  // and on or before the closing date. Returns the per-account net and the
  // lines themselves for drill-down.
  function siloActivity(postings, { after, through }) {
    const byAccount = new Map();
    let skippedBefore = 0;
    for (const p of postings || []) {
      if (p.status !== 'posted') continue;
      const date = p.payload?.TxnDate || p.period_end || '';
      if (!date || date <= after) { skippedBefore++; continue; }
      if (through && date > through) continue;
      for (const line of p.payload?.Line || []) {
        const d = line.JournalEntryLineDetail;
        const id = d?.AccountRef?.value;
        if (!id) continue;
        const amount = (d.PostingType === 'Credit' ? -1 : 1) * cents(line.Amount);
        const entry = byAccount.get(String(id)) || { net: 0, lines: [] };
        entry.net += amount;
        entry.lines.push({
          date, amount, source: p.source, memo: line.Description || p.memo || '',
          doc: p.qbo_doc_number || p.qbo_journal_entry_id || '',
        });
        byAccount.set(String(id), entry);
      }
    }
    return { byAccount, skippedBefore };
  }

  function rollForward({ opening, postings, trialBalance, closingDate }) {
    const snap = opening?.snapshot || {};
    const after = snap.as_of || '';
    const accounts = new Map();
    const row = (id) => {
      if (!accounts.has(id)) accounts.set(id, { id, name: '', type: '', opening: 0, silo: 0, closing: null, lines: [] });
      return accounts.get(id);
    };
    for (const l of snap.lines || []) {
      if (!l.qbo_account_id) continue;
      const r = row(String(l.qbo_account_id));
      r.name = l.name; r.type = l.account_type || '';
      r.opening += cents(l.debit) - cents(l.credit);
    }
    const activity = siloActivity(postings, { after, through: closingDate || null });
    for (const [id, a] of activity.byAccount) {
      const r = row(id);
      r.silo += a.net; r.lines = a.lines;
    }
    if (trialBalance) {
      for (const [id, t] of trialBalance) {
        const r = row(id);
        if (!r.name) r.name = t.name;
        r.closing = t.balance;
      }
      for (const r of accounts.values()) if (r.closing === null) r.closing = 0;
    }
    const rows = [...accounts.values()].map((r) => ({
      ...r,
      other: r.closing === null ? null : r.closing - r.opening - r.silo,
    }));
    const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
    return {
      after, closingDate: closingDate || null, rows,
      totals: { opening: sum('opening'), silo: sum('silo'), closing: trialBalance ? sum('closing') : null, other: trialBalance ? sum('other') : null },
      skippedBefore: activity.skippedBefore,
    };
  }

  // Does the closing date sit in a later fiscal year than the opening date?
  // Profit and loss accounts restart at year end, so their "other" column
  // then also carries the year-end close.
  function crossesFiscalYear(asOf, closingDate, fiscalStartMonth) {
    if (!asOf || !closingDate) return false;
    const fy = (d) => {
      const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
      return m >= (fiscalStartMonth || 1) ? y : y - 1;
    };
    return fy(closingDate) !== fy(asOf);
  }

  // A closing trial balance is only comparable to the opening snapshot when it
  // measures the same thing: same basis (a Cash report drops an Accrual
  // opening's unpaid invoices, which would read as "other activity"), same
  // currency, unfiltered, and the Debit/Credit shape the opening was seeded
  // from. These are the checks seed_accounting_from_qbo applies to the
  // opening itself. Returns a reason when incompatible, null when usable.
  const PARAM_KEYS = new Set(['start_date', 'end_date', 'accounting_method']);
  function paramsIncompatibility(params, snap) {
    const p = params || {};
    for (const [k, v] of Object.entries(p))
      if (!PARAM_KEYS.has(k) && v !== null && v !== '' && v !== undefined) return 'filtered report';
    if (p.accounting_method && snap?.basis && p.accounting_method !== snap.basis)
      return `${p.accounting_method} basis, opening balances are ${snap.basis}`;
    return null;
  }
  function closingIncompatibility(raw, { endDate, params }, snap) {
    const byParams = paramsIncompatibility(params, snap);
    if (byParams) return byParams;
    const h = raw?.Header || {};
    if (h.ReportName !== 'TrialBalance') return 'not a trial balance';
    if (!snap?.basis || h.ReportBasis !== snap.basis) return `${h.ReportBasis || 'unknown'} basis, opening balances are ${snap?.basis || 'unknown'}`;
    if (!snap?.currency || h.Currency !== snap.currency) return `${h.Currency || 'unknown'} currency, opening balances are ${snap?.currency || 'unknown'}`;
    // Fail closed: QuickBooks itself must state the period, and it must be the
    // date the ledger will print over the closing column.
    if (!endDate || !h.EndPeriod || h.EndPeriod !== endDate) return 'QuickBooks did not confirm the report period';
    const cols = raw?.Columns?.Column || [];
    if (cols.length !== 3 || cols[0]?.ColType !== 'Account'
      || String(cols[1]?.ColTitle).toLowerCase() !== 'debit' || String(cols[2]?.ColTitle).toLowerCase() !== 'credit')
      return 'not an unsummarized Debit/Credit trial balance';
    return null;
  }

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => c === null || c === undefined ? '—'
    : (c < 0 ? '(' : '') + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (c < 0 ? ')' : '');
  const SOURCE = { card_import: 'Transactions', journal_adjustment: 'Sales & journals', manual_adjustment: 'Journal entry',
    prepaid_amortization: 'Schedules', fixed_asset_depreciation: 'Fixed assets' };

  function render(model, { onlyActivity = true, fiscalCrossed = false, closingNote = '' } = {}) {
    const rows = model.rows
      .filter((r) => !onlyActivity || r.opening || r.silo || r.closing || (r.other ?? 0))
      .sort((a, b) => (!a.type - !b.type) || (a.type || '').localeCompare(b.type || '') || a.name.localeCompare(b.name));
    const has = model.closingDate !== null;
    const head = `<tr><th>Account</th><th class="num">Opening ${esc(model.after)}</th><th class="num">Posted by Silo</th>`
      + `<th class="num">Other activity in QuickBooks</th><th class="num">Closing per QuickBooks${has ? ' ' + esc(model.closingDate) : ''}</th></tr>`;
    const body = rows.map((r) => `<tr><td>${esc(r.name || 'QBO account ' + r.id)}<small>${esc(r.type)}</small></td>`
      + `<td class="num">${money(r.opening)}</td>`
      + `<td class="num">${r.lines.length ? `<button type="button" class="ledger-drill" data-ledger-account="${esc(r.id)}">${money(r.silo)}</button>` : money(r.silo)}</td>`
      + `<td class="num">${has ? money(r.other) : '—'}</td>`
      + `<td class="num">${has ? money(r.closing) : '—'}</td></tr>`).join('');
    const t = model.totals;
    const foot = `<tr class="ledger-total"><td>Total (every column nets to zero when its source balances)</td><td class="num">${money(t.opening)}</td>`
      + `<td class="num">${money(t.silo)}</td><td class="num">${has ? money(t.other) : '—'}</td><td class="num">${has ? money(t.closing) : '—'}</td></tr>`;
    const notes = [];
    if (closingNote) notes.push(closingNote);
    else if (!has) notes.push('No QuickBooks trial balance after the opening date is saved yet, so closing balances and other activity cannot be shown. Fetch one above.');
    if (fiscalCrossed) notes.push('The closing date is in a later fiscal year than the opening balances. Profit and loss accounts restart at year end, so their other-activity figure also carries the year-end close.');
    if (model.skippedBefore) notes.push(`${model.skippedBefore} posted entr${model.skippedBefore === 1 ? 'y is' : 'ies are'} dated on or before the opening date and already inside the opening balances, so ${model.skippedBefore === 1 ? 'it is' : 'they are'} not counted again.`);
    return notes.map((n) => `<p class="books-caption">${esc(n)}</p>`).join('')
      + `<div class="books-table-scroll"><table class="ledger-table"><thead>${head}</thead><tbody>${body || '<tr><td colspan="5">No account activity.</td></tr>'}</tbody><tfoot>${foot}</tfoot></table></div>`;
  }

  function renderLines(r) {
    return `<p class="books-caption">${esc(r.name)} · every line Silo posted to QuickBooks for this account after the opening date.</p>`
      + `<div class="books-table-scroll"><table><thead><tr><th>Date</th><th>Source</th><th>Entry</th><th>Description</th><th class="num">Amount</th></tr></thead><tbody>`
      + r.lines.slice().sort((a, b) => a.date.localeCompare(b.date)).map((l) => `<tr><td>${esc(l.date)}</td><td>${esc(SOURCE[l.source] || l.source)}</td><td>${esc(l.doc)}</td><td>${esc(l.memo)}</td><td class="num">${money(l.amount)}</td></tr>`).join('')
      + `</tbody></table></div>`;
  }

  // Wires the Ledger surface. `db` and `companyId` as Books uses them;
  // `opening` is the accepted baseline row (or null); `settings` the
  // accounting_settings row (connection, fiscal month, basis).
  async function mount({ db, companyId, opening, settings, businessToday, el }) {
    const out = el('ledgerTable');
    if (!opening || opening.status !== 'accepted') {
      out.innerHTML = 'Accept your opening balances in Setup first. The ledger rolls forward from them.';
      el('ledgerFetch').hidden = true;
      return;
    }
    const snap = opening.snapshot || {};
    const after = snap.as_of;
    // Account ids are local to one QuickBooks connection, so postings and
    // closing reports are both read for the connection these books were
    // seeded from, never for the company as a whole.
    const connection = settings?.qbo_connection_id || null;
    el('ledgerFetch').hidden = !connection;
    if (!connection) {
      out.textContent = 'These books name no QuickBooks connection, so Silo postings cannot be tied to them. Re-open Setup.';
      return;
    }
    const nextDay = (d) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
    const read = async (q) => { const r = await q; if (r.error) throw new Error(r.error.message); return r.data || []; };
    // Every posted journal for the connection, in ordered pages until an EMPTY
    // one: a single capped page would silently drop later entries and move
    // them into "other activity", and stopping on a short page would do the
    // same wherever the API's own row cap is below the page size.
    async function allPostings() {
      const rows = [];
      for (let offset = 0; ; ) {
        const page = await read(db.from('quickbooks_journal_postings')
          .select('id,source,status,payload,period_end,memo,qbo_doc_number,qbo_journal_entry_id,connection_id')
          .eq('company_entity_id', companyId).eq('connection_id', connection).eq('status', 'posted')
          .order('id').range(offset, offset + POSTING_PAGE - 1));
        if (!page.length) return rows;
        rows.push(...page);
        offset += page.length;
      }
    }
    let model = null, lastOptions = {};
    async function draw() {
      out.textContent = 'Reading posted entries and saved trial balances…';
      const [postings, runs] = await Promise.all([
        allPostings(),
        read(db.from('quickbooks_report_runs').select('id,end_date,fetched_at,connection_id,params').eq('company_entity_id', companyId).eq('connection_id', connection).eq('report_name', 'TrialBalance').eq('status', 'ok').gte('end_date', nextDay(after)).order('end_date', { ascending: false }).order('fetched_at', { ascending: false }).limit(20)),
      ]);
      const usable = runs.filter((r) => r.connection_id === connection && !paramsIncompatibility(r.params, snap));
      const skipped = runs.length - usable.length;
      const pick = el('ledgerRun');
      const chosen = usable.find((r) => r.id === pick.value) || usable[0] || null;
      pick.innerHTML = usable.length
        ? usable.map((r) => `<option value="${esc(r.id)}"${r === chosen ? ' selected' : ''}>Through ${esc(r.end_date)} · fetched ${esc(String(r.fetched_at).slice(0, 10))}</option>`).join('')
        : '<option value="">No matching trial balance after the opening date</option>';
      let tb = null, closingDate = null, closingNote = '';
      if (chosen) {
        const [run] = await read(db.from('quickbooks_report_runs').select('raw_response').eq('id', chosen.id).limit(1));
        const reason = closingIncompatibility(run?.raw_response, { endDate: chosen.end_date, params: chosen.params }, snap);
        if (reason) closingNote = `The selected trial balance cannot be compared with the opening balances (${reason}), so closing balances and other activity are not shown. Fetch a new one above.`;
        else { tb = parseTrialBalance(run?.raw_response); closingDate = chosen.end_date; }
      } else if (skipped) {
        closingNote = `${skipped} saved trial balance${skipped === 1 ? ' was' : 's were'} left out because ${skipped === 1 ? 'it does' : 'they do'} not match the opening balances' ${snap.basis || ''} basis or ${skipped === 1 ? 'is' : 'are'} filtered. Fetch one above.`;
      }
      model = rollForward({ opening, postings, trialBalance: tb, closingDate });
      lastOptions = { fiscalCrossed: crossesFiscalYear(after, closingDate, settings?.fiscal_year_start_month), closingNote };
      out.innerHTML = render(model, { ...lastOptions, onlyActivity: !el('ledgerAll').checked });
    }
    const fail = (e) => { out.textContent = `The ledger could not be read: ${e.message}.`; };
    el('ledgerRun').addEventListener('change', () => draw().catch(fail));
    el('ledgerAll').addEventListener('change', () => { if (model) out.innerHTML = render(model, { ...lastOptions, onlyActivity: !el('ledgerAll').checked }); });
    out.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ledger-account]');
      if (!b || !model) return;
      const r = model.rows.find((x) => x.id === b.dataset.ledgerAccount);
      el('ledgerLines').innerHTML = r ? renderLines(r) : '';
      el('ledgerLines').hidden = !r;
      el('ledgerLines').scrollIntoView?.({ block: 'nearest' });
    });
    el('ledgerFetch').addEventListener('click', () => {
      const end = businessToday;
      const fiscal = Number(settings?.fiscal_year_start_month || 1);
      const year = Number(end.slice(0, 4)) - (Number(end.slice(5, 7)) < fiscal ? 1 : 0);
      const start = `${year}-${String(fiscal).padStart(2, '0')}-01`;
      el('ledgerFetch').disabled = true;
      out.textContent = 'Fetching a read-only trial balance from QuickBooks…';
      // The opening snapshot's basis, so the new report is comparable with it.
      db.functions.invoke('quickbooks-report', { body: { connection_id: connection, report_name: 'TrialBalance', params: { start_date: start, end_date: end, accounting_method: snap.basis || settings.accounting_basis || 'Accrual' } } })
        .then((r) => { if (r.error) throw new Error(r.error.message || String(r.error)); el('ledgerRun').value = r.data?.run_id || ''; return draw(); })
        .catch(fail)
        .finally(() => { el('ledgerFetch').disabled = false; });
    });
    await draw().catch(fail);
  }

  window.SiloLedger = { parseTrialBalance, siloActivity, rollForward, crossesFiscalYear, paramsIncompatibility, closingIncompatibility, render, renderLines, mount, POSTING_PAGE };
})();
