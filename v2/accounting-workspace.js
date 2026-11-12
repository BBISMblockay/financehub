/* Presentation only. Financial actions stay in their existing review screens. */
(function () {
  'use strict';
  const root = document.querySelector('[data-accounting-view]');
  if (!root) return;
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const monthEnd = root.dataset.accountingView === 'month-end';
  let controller, current, selected = 'activity';
  const count = n => n == null ? 'Unknown' : Number(n).toLocaleString('en-US');
  const money = (n, currency) => n == null || String(n).trim() === '' || !Number.isFinite(Number(n)) ? 'Unavailable' :
    Number(n).toLocaleString('en-US', { style:'currency', currency:/^[A-Z]{3}$/.test(currency || '') ? currency : 'USD' }) + (!currency ? ' · currency unknown' : '');
  const date = value => value ? String(value).slice(0,10) : 'Not available';
  const periodName = value => new Date(value+'-01T12:00:00Z').toLocaleDateString('en-US',{month:'long',year:'numeric',timeZone:'UTC'});
  const state = (text, kind = '') => `<span class="aw-state${kind ? ' aw-state--'+kind : ''}">${esc(text)}</span>`;
  const kpi = (label, value, note) => `<div class="aw-kpi"><div class="aw-kpi-label">${esc(label)}</div><div class="aw-kpi-value">${esc(value)}</div><div class="aw-kpi-note">${esc(note)}</div></div>`;
  const link = (href, title, detail) => `<li><a href="${esc(href)}"><span>${esc(title)}<small>${esc(detail)}</small></span><span aria-hidden="true">→</span></a></li>`;
  const batchLink = row => 'transactions.html?batch='+encodeURIComponent(row.id)+'&company='+encodeURIComponent(current.company.id);
  const modeLabel = model => model.mode === 'bookkeeping' ? 'Bookkeeping in SILO' : model.mode === 'reporting_only' ? 'Reporting only' : 'Bookkeeping mode unavailable';

  function bankCard(model) {
    const banks = model.banks;
    // A balance is a provider snapshot, never a ledger balance or P&L total.
    const totals = banks.balances.filter(b => b.type === 'depository').map(b => `<div><span>${esc(b.currency || 'Unknown currency')} · cash accounts</span><strong>${esc(b.currency ? money(b.total,b.currency) : 'Unavailable')}</strong><span>${b.total == null ? `${b.missing} balance(s) unavailable` : `${b.count} account(s)`}</span></div>`).join('');
    const rows = banks.rows.map(b => `<li><div class="aw-bank-row"><div><strong>${esc(b.name || b.official_name || 'Bank account')}</strong><small>${esc(b.institutionName || 'Institution unavailable')}${b.mask ? ' · •'+esc(b.mask) : ''} · ${esc(b.type || 'Account type unknown')}</small></div><span class="aw-amount">${esc(b.iso_currency_code ? money(b.current_balance,b.iso_currency_code) : 'Unavailable')}</span></div><small>Balance updated ${esc(date(b.balance_updated_at))} · ${esc(b.connectionStatus || 'Status unknown')}${b.mapped === false ? ' · mapping needed' : b.mapped == null ? ' · mapping unknown' : ''}</small></li>`).join('');
    return `<section class="aw-card"><div class="aw-section-head"><h2>Connected accounts</h2><a href="transactions.html">Open bank activity →</a></div>${totals ? `<div class="aw-balance-totals">${totals}</div>` : ''}${rows ? `<ul class="aw-list">${rows}</ul>` : `<div class="aw-empty">${banks.state === 'unknown' ? 'Bank accounts could not be read. Refresh or open bank activity.' : 'No bank accounts yet. Connect an account in Books & setup.'}</div>`}<div class="aw-card-foot">Bank-reported snapshots, not reconciled ledger balances. Cash totals exclude credit cards and other account types. Currencies stay separate.</div></section>`;
  }

  function journalsCard(model) {
    const rows = model.journals.rows.map(row => `<tr><td>${esc(date(row.entry_date))}</td><td>${esc(row.memo || row.source || 'Journal entry')}<small>${esc(row.source || row.kind || '')}</small></td><td>${state(row.status || 'Unknown')}</td><td>${state(row.posting_status || 'Check delivery', row.posting_status === 'posted' ? 'good' : '')}</td></tr>`).join('');
    return `<section class="aw-card"><div class="aw-section-head"><h2>Recent journals</h2><a href="accounting-books.html#register">View register →</a></div>${rows ? `<div class="aw-scroll"><table class="aw-table"><thead><tr><th>Date</th><th>Description</th><th>SILO review</th><th>QBO delivery</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="aw-empty">${model.journals.state === 'unknown' ? 'Journal status could not be read.' : 'No recorded journals in this month.'}</div>`}<div class="aw-card-foot">Latest recorded entries for ${esc(periodName(model.period))}. Delivery is SILO’s recorded status, not a live QuickBooks check.</div></section>`;
  }

  function setupCard(model) {
    const qbo = model.qbo.state === 'known' ? model.qbo.count ? `${model.qbo.count} saved connection(s)` : 'Connect QuickBooks' : 'Connection status unavailable';
    const accounts = model.accounts.state === 'known' ? `${model.accounts.count} SILO accounts` : 'Account count unavailable';
    return `<section class="aw-card"><div class="aw-section-head"><h2>Books &amp; setup</h2><a href="accounting-books.html#setup">Manage →</a></div><ul class="aw-list">${link('integrations.html','QuickBooks',qbo)}${link('accounting-books.html#accounts','Chart of accounts',accounts)}${link('accounting-books.html#setup','Opening history',model.opening.status === 'accepted' ? 'Accepted · starts '+model.opening.startDate : model.opening.status === 'unknown' ? 'Status unavailable' : 'Review your starting balances')}${link('transactions.html?view=cards','Bank mappings',model.banks.unmapped == null ? 'Mapping status unavailable' : model.banks.unmapped ? `${model.banks.unmapped} bank account(s) need mapping` : 'No unmapped bank accounts found')}</ul></section>`;
  }

  function renderOverview(model) {
    const q = model.queues;
    const needs = q.needsReview;
    const title = needs == null ? 'Period review status is unavailable' : needs ? `${count(needs)} bank period${needs === 1 ? '' : 's'} need review` : 'Keep your day-to-day books moving';
    const note = needs == null ? 'Open bank activity to check the underlying records.' : 'Categorizing, approving and posting are separate steps. Review the details before posting.';
    return `<div class="aw-kpis">${kpi('Bank accounts',count(model.banks.count),'Connected bank and card accounts')}${kpi('Periods to review',count(needs),'Imports in the selected month')}${kpi('Draft journals',count(model.journals.draft),'Recorded journal review status')}${kpi('QuickBooks',model.qbo.count == null ? 'Unknown' : model.qbo.count ? 'Linked' : 'Not linked','Saved connection, not a live health check')}</div>
      <section class="aw-callout"><div><h2>${esc(title)}</h2><p>${esc(note)}</p></div><a class="bcn-btn bcn-btn--primary" href="transactions.html">Review bank activity →</a></section>
      <div class="aw-grid"><div>${bankCard(model)}${journalsCard(model)}</div><aside><section class="aw-card"><div class="aw-section-head"><h2>Next up</h2></div><ul class="aw-list">${link('transactions.html','Review bank activity',`${count(q.needsReview)} period(s) need review`)}${link('accounting-month-end.html?month='+model.period,'Review month-end',periodName(model.period))}${link('accounting-books.html#register','Check journal delivery',`${count(model.journals.approved)} approved journal(s)`) }${link('qbo-reports.html','Run financial reports','Profit & loss, balance sheet and more')}</ul></section>${setupCard(model)}</aside></div>`;
  }

  function checks(model) {
    const q = model.queues, j = model.journals;
    return [
      {id:'activity',title:'Review bank activity',summary:q.state === 'unknown' ? 'Period status could not be read' : `${count(q.needsReview)} need review · ${count(q.count)} recorded periods`,tag:q.needsReview == null ? 'Unknown' : q.needsReview ? 'Review' : 'Inspect',href:'transactions.html',action:'Open bank activity',body:'Check each account and period for missing categories, pending bank activity and the approval requirements shown on its review screen. The count here covers recorded imports, not every possible bank transaction.',detail:'Each period opens its existing review workspace. No approval or posting happens from this page.'},
      {id:'journals',title:'Check journal delivery',summary:j.state === 'unknown' ? 'Journal status could not be read' : `${count(j.draft)} draft · ${count(j.approved)} approved · ${count(j.posted)} posted`,tag:j.state === 'unknown' ? 'Unknown' : j.draft || j.approved ? 'Review' : 'Inspect',href:'accounting-books.html#register',action:'Open journal register',body:'Review staged adjustments and recorded QuickBooks delivery. A journal approved in SILO is not the same as a journal posted to QuickBooks. Uncertain submissions must use their existing recovery controls.',detail:'The register keeps the existing Open, Discard, Reopen and Void controls and their safeguards.'},
      {id:'reports',title:'Compare your books',summary:'Run statements and compare closing balances',tag:'Manual review',href:'accounting-books.html#ledger',action:'Open ledger',body:'Use the ledger roll-forward and financial reports to compare opening balances, SILO activity and QuickBooks closing balances. Resolve differences before treating the month as reviewed.',detail:'A clean activity queue is not evidence of reconciliation. This workspace does not certify or lock a period.'},
      {id:'specialists',title:'Review recurring and sales entries',summary:'Shopify journal, schedules and fixed assets',tag:'Manual review',href:'accounting-export.html',action:'Open Shopify journal',body:'Review sales journals, scheduled entries and asset depreciation in their existing workspaces. These checks remain separate from bank categorization.',detail:'Use More in the accounting navigation to open Schedules or Fixed assets. Review and post through the existing controls.'},
    ];
  }
  function renderDetail(model) {
    const check = checks(model).find(c => c.id === selected) || checks(model)[0];
    const rows = selected === 'activity' ? model.queues.rows : [];
    const list = rows.length ? `<h3>Recorded periods</h3><ul class="aw-list">${rows.map(row => link(batchLink(row),row.source_name || row.label || 'Bank period',`${date(row.period_start || row.entry_date)} · ${row.status || 'Unknown'} · QBO: ${row.posting_status || 'Check delivery'}`)).join('')}</ul>` : '';
    return `<div class="aw-section-head"><h2>${esc(check.title)}</h2>${state(check.tag)}</div><div class="aw-card-body aw-detail"><p>${esc(check.body)}</p><a class="bcn-btn" href="${check.href}">${esc(check.action)} →</a><p class="aw-review-note">${esc(check.detail)}</p></div>${list}`;
  }
  function renderMonthEnd(model) {
    const items = checks(model);
    return `<section class="aw-callout"><div><h2>${esc(periodName(model.period))} review</h2><p>Work through the checks below. Review and posting stay in their existing workspaces.</p></div><a class="bcn-btn bcn-btn--primary" href="qbo-reports.html">Open financial reports →</a></section>
      <div class="aw-kpis">${kpi('Bank periods',count(model.queues.count),'Recorded imports in this month')}${kpi('Need review',count(model.queues.needsReview),'Not an automatic close checklist')}${kpi('Approved journals',count(model.journals.approved),'Review delivery in the register')}${kpi('Posted journals',count(model.journals.posted),'Recorded in SILO')}</div>
      <div class="aw-grid"><section class="aw-card"><div class="aw-section-head"><h2>Month-end checks</h2></div><ol class="aw-checks">${items.map((c,i) => `<li><button type="button" class="aw-check" data-check="${c.id}" aria-pressed="${selected === c.id}" aria-controls="reviewDetail"><span class="aw-check-number">${i+1}</span><span><strong>${esc(c.title)}</strong><small>${esc(c.summary)}</small></span>${state(c.tag,c.tag === 'Review' ? 'attention' : '')}</button></li>`).join('')}</ol><div class="aw-card-foot">This is a review hub. It does not close or lock the month, mark checks complete, or replace bank reconciliation.</div></section><section class="aw-card" id="reviewDetail" aria-live="polite">${renderDetail(model)}</section></div>${journalsCard(model)}`;
  }
  const sourceLabels = {today:'company date',settings:'book settings',opening:'opening balances',qbo:'QuickBooks connection',accountCount:'chart of accounts',bankConnections:'bank connections',bankAccounts:'bank accounts',sources:'account mappings',batches:'bank periods',journals:'journals'};
  function render(model) {
    current = model;
    el('reviewMonth').value = model.period;
    const url = new URL(location.href);
    if (url.searchParams.get('month') !== model.period) { url.searchParams.set('month',model.period); history.replaceState(history.state,'',url.pathname+url.search+url.hash); }
    el('workspaceDate').textContent = `As of ${model.today || 'an unavailable company date'} · ${model.company.title || model.company.name || 'Your company'}`;
    el('workspaceContent').innerHTML = monthEnd ? renderMonthEnd(model) : renderOverview(model);
    el('workspaceContent').setAttribute('aria-busy','false');
    el('bookkeepingMode').textContent = `${modeLabel(model)}${model.opening.status === 'accepted' && model.opening.startDate ? ' · Starts '+model.opening.startDate : ''}`;
    el('status').hidden = !model.errors.length;
    el('status').className = 'bcn-status' + (model.errors.length ? ' bcn-status--neg' : '');
    el('status').textContent = model.errors.length ? 'Some information could not be read: '+model.errors.map(e => sourceLabels[e.source] || 'accounting information').join(', ')+'. Refresh to try again. Open the linked workspace for details.' : '';
    el('reviewMonth').disabled = false;el('refreshOverview').disabled = false;
  }
  function showError(error) {
    el('status').hidden = false;el('status').className = 'bcn-status bcn-status--neg';
    el('status').textContent = error.message || 'Accounting could not be loaded. Refresh to try again.';
    el('workspaceContent').setAttribute('aria-busy','false');
    // Never leave a previous company's financial information visible on failure.
    el('workspaceContent').innerHTML = '<div class="aw-empty">Accounting information is unavailable. Reload after checking your company and finance access.</div>';
    el('bookkeepingMode').textContent = 'Bookkeeping settings unavailable';
    el('refreshOverview').disabled = !controller;
  }
  async function refresh() {
    if (!controller || !/^\d{4}-(0[1-9]|1[0-2])$/.test(el('reviewMonth').value)) return;
    el('status').hidden = false;el('status').className = 'bcn-status';el('status').textContent = 'Refreshing accounting…';
    el('workspaceContent').setAttribute('aria-busy','true');el('refreshOverview').disabled = true;
    try { await controller.refresh(el('reviewMonth').value); } catch { /* onError renders the failure; event handlers must not reject. */ }
  }
  el('reviewMonth').addEventListener('change',refresh);
  el('refreshOverview').addEventListener('click',refresh);
  el('workspaceContent').addEventListener('click',event => {
    const button = event.target.closest('[data-check]');
    if (!button || !current) return;
    selected = button.dataset.check;
    root.querySelectorAll('[data-check]').forEach(b => b.setAttribute('aria-pressed',String(b === button)));
    el('reviewDetail').innerHTML = renderDetail(current);
  });
  const month = new URLSearchParams(location.search).get('month');
  window.SiloAccountingOverview.boot({active:monthEnd ? 'finance/month-end' : 'finance/accounting-home',crumbs:['Finance','Accounting',monthEnd ? 'Month-end' : 'Overview'],period:/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') ? month : undefined,onModel:render,onError:showError}).then(value => {controller=value;}).catch(showError);
})();
