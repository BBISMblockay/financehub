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
  const num = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) ? Number(v) : null;
  const periodName = value => new Date(value+'-01T12:00:00Z').toLocaleDateString('en-US',{month:'long',year:'numeric',timeZone:'UTC'});
  const state = (text, kind = '') => `<span class="aw-state${kind ? ' aw-state--'+kind : ''}">${esc(text)}</span>`;
  const kpi = (label, value, note) => `<div class="aw-kpi"><div class="aw-kpi-label">${esc(label)}</div><div class="aw-kpi-value">${esc(value)}</div><div class="aw-kpi-note">${esc(note)}</div></div>`;
  const link = (href, title, detail) => `<li><a href="${esc(href)}"><span>${esc(title)}<small>${esc(detail)}</small></span><span aria-hidden="true">→</span></a></li>`;
  const batchLink = row => 'transactions.html?batch='+encodeURIComponent(row.id)+'&company='+encodeURIComponent(current.company.id);
  const modeLabel = model => model.mode === 'bookkeeping' ? 'Bookkeeping in SILO' : model.mode === 'reporting_only' ? 'Reporting only' : 'Bookkeeping mode unavailable';

  // ── Charts ────────────────────────────────────────────────────────────
  // Drawn with plain elements and Beacon tokens: no chart library, no new CSS
  // variables, correct in both themes, and every figure is also written out
  // beside its bar, so no number here can only be read as a picture.
  const share = (value, total) => total > 0 && Number.isFinite(value) ? Math.max(value > 0 ? 3 : 0, Math.round((value / total) * 100)) : 0;

  function cashBars(model) {
    const rows = model.banks.rows;
    if (!rows.length) return '';
    const peak = rows.reduce((max, b) => {
      const value = b.iso_currency_code ? num(b.current_balance) : null;
      return value === null ? max : Math.max(max, Math.abs(value));
    }, 0);
    return `<div class="aw-bars">` + rows.map(b => {
      const value = b.iso_currency_code ? num(b.current_balance) : null;
      const credit = b.type && b.type !== 'depository';
      // Freshness belongs beside the figure: a balance is only as true as the
      // day it was reported.
      const meta = [b.institutionName || 'Institution unavailable', b.mask ? '•'+b.mask : '', b.type || 'type unknown',
        b.connectionStatus || 'status unknown', 'updated '+date(b.balance_updated_at),
        b.mapped === false ? 'mapping needed' : b.mapped == null ? 'mapping unknown' : '']
        .filter(Boolean).join(' · ');
      return `<div class="aw-bar"><div class="aw-bar-label"><strong>${esc(b.name || b.official_name || 'Bank account')}</strong><small>${esc(meta)}</small></div>`
        + `<div class="aw-bar-fig${value !== null && value < 0 ? ' aw-neg' : ''}">${esc(value === null ? 'Unavailable' : money(value, b.iso_currency_code))}</div>`
        + `<div class="aw-bar-track"><span class="aw-bar-fill${credit ? ' aw-bar-fill--credit' : ''}${value !== null && value < 0 ? ' aw-bar-fill--neg' : ''}" style="width:${value === null ? 0 : share(Math.abs(value), peak)}%"></span></div></div>`;
    }).join('') + `</div>`;
  }

  const SEGMENTS = [['draft','Draft','draft'],['categorized','Categorized','categorized'],['approved','Approved','approved'],['posted','Posted','posted']];
  function statusStack(summaryObj) {
    if (summaryObj.state === 'unknown') return `<div class="aw-empty">Status could not be read.</div>`;
    const total = summaryObj.count || 0;
    if (!total) return '';
    const parts = SEGMENTS.map(([key, label, tone]) => ({ label, tone, value: summaryObj[key] || 0 }));
    const other = total - parts.reduce((sum, part) => sum + part.value, 0);
    if (other > 0) parts.push({ label: 'Other', tone: 'other', value: other });
    const shown = parts.filter(part => part.value > 0);
    return `<div class="aw-stack">${shown.map(part => `<span class="aw-seg aw-seg--${part.tone}" style="width:${share(part.value, total)}%"></span>`).join('')}</div>`
      + `<div class="aw-legend">${shown.map(part => `<span class="aw-legend-item"><i class="aw-dot aw-seg--${part.tone}"></i>${esc(part.label)} <b>${esc(count(part.value))}</b></span>`).join('')}</div>`;
  }

  function journalColumns(model) {
    const days = model.journals.byDay;
    if (!Array.isArray(days) || !days.length) return '';
    const peak = days.reduce((max, day) => Math.max(max, day.count), 0);
    if (!peak) return `<div class="aw-empty">No journals recorded in this month yet.</div>`;
    const columns = days.map(day => `<span class="aw-col${day.count ? '' : ' aw-col--none'}" style="height:${day.count ? share(day.count, peak) : 0}%" title="${esc(day.date)}: ${esc(count(day.count))}"></span>`).join('');
    const label = day => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { month:'short', day:'numeric', timeZone:'UTC' });
    return `<div class="aw-cols" role="img" aria-label="Journals recorded each day, peak ${count(peak)} on one day">${columns}</div>`
      + `<div class="aw-axis"><span>${esc(label(days[0].date))}</span><span>Peak ${esc(count(peak))}</span><span>${esc(label(days[days.length-1].date))}</span></div>`;
  }

  function chartCard(title, href, linkText, body, foot) {
    return `<section class="aw-card"><div class="aw-section-head"><h2>${esc(title)}</h2>${href ? `<a href="${esc(href)}">${esc(linkText)} →</a>` : ''}</div>`
      + `<div class="aw-chart">${body}</div>${foot ? `<div class="aw-card-foot">${esc(foot)}</div>` : ''}</section>`;
  }

  function bankCard(model) {
    const banks = model.banks;
    // A balance is a provider snapshot, never a ledger balance or P&L total.
    const totals = banks.balances.filter(b => b.type === 'depository').map(b => `<div><span>${esc(b.currency || 'Unknown currency')} cash</span><strong>${esc(b.currency ? money(b.total,b.currency) : 'Unavailable')}</strong><span>${b.total == null ? `${b.missing} balance(s) unavailable` : `${b.count} account(s)`}</span></div>`).join('');
    const empty = banks.state === 'unknown' ? 'Bank accounts could not be read. Refresh or open bank activity.' : 'No bank accounts yet. Connect an account in Books & setup.';
    return `<section class="aw-card"><div class="aw-section-head"><h2>Cash on hand</h2><a href="transactions.html">Bank activity →</a></div>${totals ? `<div class="aw-balance-totals">${totals}</div>` : ''}${banks.rows.length ? cashBars(model) : `<div class="aw-empty">${empty}</div>`}<div class="aw-card-foot">Bank-reported snapshots, not reconciled ledger balances. Cash totals cover depository accounts only, and currencies stay separate.</div></section>`;
  }

  function journalsCard(model) {
    const rows = model.journals.rows.map(row => `<tr><td class="aw-num">${esc(date(row.entry_date))}</td><td>${esc(row.memo || row.source || 'Journal entry')}<small>${esc(row.source || row.kind || '')}</small></td><td>${state(row.status || 'Unknown')}</td><td>${state(row.posting_status || 'Check delivery', row.posting_status === 'posted' ? 'good' : '')}</td></tr>`).join('');
    const empty = model.journals.state === 'unknown' ? 'Journal status could not be read.' : 'No recorded journals in this month.';
    return `<section class="aw-card"><div class="aw-section-head"><h2>Recent journals</h2><a href="accounting-books.html#register">Register →</a></div>${rows ? `<div class="aw-scroll"><table class="aw-table"><thead><tr><th>Date</th><th>Description</th><th>SILO review</th><th>QBO delivery</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="aw-empty">${empty}</div>`}<div class="aw-card-foot">Delivery is SILO’s recorded status, not a live QuickBooks check.</div></section>`;
  }

  function setupCard(model) {
    const qbo = model.qbo.state === 'known' ? model.qbo.count ? `${model.qbo.count} saved connection(s)` : 'Connect QuickBooks' : 'Connection status unavailable';
    const accounts = model.accounts.state === 'known' ? `${model.accounts.count} SILO accounts` : 'Account count unavailable';
    return `<section class="aw-card"><div class="aw-section-head"><h2>Books &amp; setup</h2><a href="accounting-books.html#setup">Manage →</a></div><ul class="aw-list">${link('integrations.html','QuickBooks',qbo)}${link('accounting-books.html#accounts','Chart of accounts',accounts)}${link('accounting-books.html#openingSetup','Opening history',model.opening.status === 'accepted' ? 'Accepted · starts '+model.opening.startDate : model.opening.status === 'unknown' ? 'Status unavailable' : 'Review your starting balances')}${link('transactions.html?view=cards','Bank mappings',model.banks.unmapped == null ? 'Mapping status unavailable' : model.banks.unmapped ? `${model.banks.unmapped} bank account(s) need mapping` : 'No unmapped bank accounts found')}</ul></section>`;
  }

  function renderOverview(model) {
    const q = model.queues;
    const needs = q.needsReview;
    const title = needs == null ? 'Period review status is unavailable' : needs ? `${count(needs)} bank period${needs === 1 ? '' : 's'} need review` : 'Keep your day-to-day books moving';
    const note = needs == null ? 'Open bank activity to check the underlying records.' : 'Categorizing, approving and posting are separate steps.';
    const periods = q.state === 'unknown' || !q.count
      ? `<div class="aw-empty">${q.state === 'unknown' ? 'Period status could not be read.' : 'No bank periods recorded in this month.'}</div>`
      : statusStack(q);
    return `<div class="aw-kpis">${kpi('Bank accounts',count(model.banks.count),'Connected')}${kpi('Periods to review',count(needs),'This month')}${kpi('Draft journals',count(model.journals.draft),'Awaiting review')}${kpi('QuickBooks',model.qbo.count == null ? 'Unknown' : model.qbo.count ? 'Linked' : 'Not linked','Saved connection')}</div>
      <section class="aw-callout"><div><h2>${esc(title)}</h2><p>${esc(note)}</p></div><a class="bcn-btn bcn-btn--primary" href="transactions.html">Review bank activity →</a></section>
      <div class="aw-grid"><div>${bankCard(model)}${chartCard('Journals by day','accounting-books.html#register','Register',journalColumns(model) || `<div class="aw-empty">Journal activity could not be read.</div>`,`${esc(periodName(model.period))} · ${count(model.journals.count)} recorded`)}${journalsCard(model)}</div><aside>${chartCard('Bank periods','transactions.html','Open',periods,'Import and review status for the selected month.')}<section class="aw-card"><div class="aw-section-head"><h2>Next up</h2></div><ul class="aw-list">${link('transactions.html','Review bank activity',`${count(q.needsReview)} period(s) need review`)}${link('accounting-month-end.html?month='+model.period,'Review month-end',periodName(model.period))}${link('accounting-books.html#register','Check journal delivery',`${count(model.journals.approved)} approved journal(s)`) }${link('qbo-reports.html','Run financial reports','Profit & loss, balance sheet and more')}</ul></section>${setupCard(model)}</aside></div>`;
  }

  function checks(model) {
    const q = model.queues, j = model.journals;
    return [
      {id:'activity',title:'Review bank activity',summary:q.state === 'unknown' ? 'Period status could not be read' : `${count(q.needsReview)} need review · ${count(q.count)} recorded periods`,tag:q.needsReview == null ? 'Unknown' : q.needsReview ? 'Review' : 'Inspect',href:'transactions.html',action:'Open bank activity',body:'The count covers recorded imports, not every bank transaction.',detail:'Each period opens its own review screen. Nothing is approved or posted from this page.'},
      {id:'journals',title:'Check journal delivery',summary:j.state === 'unknown' ? 'Journal status could not be read' : `${count(j.draft)} draft · ${count(j.approved)} approved · ${count(j.posted)} posted`,tag:j.state === 'unknown' ? 'Unknown' : j.draft || j.approved ? 'Review' : 'Inspect',href:'accounting-books.html#register',action:'Open journal register',body:'Approved in SILO is not the same as posted to QuickBooks. Uncertain submissions use the register’s existing recovery controls.',detail:'The register keeps its Open, Discard, Reopen and Void controls.'},
      {id:'reports',title:'Compare your books',summary:'Run statements and compare closing balances',tag:'Manual review',href:'accounting-books.html#ledger',action:'Open ledger',body:'Compare opening balances, SILO activity and QuickBooks closing balances, and resolve differences first.',detail:'A clean queue is not reconciliation. This page does not certify or lock a period.'},
      {id:'specialists',title:'Review recurring and sales entries',summary:'Shopify journal, schedules and fixed assets',tag:'Manual review',href:'accounting-export.html',action:'Open Shopify journal',body:'Sales journals, scheduled entries and depreciation stay in their own workspaces, separate from bank categorization.',detail:'Open Shopify journal, Schedules or Fixed assets from the tabs above.'},
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
    return `<section class="aw-callout"><div><h2>${esc(periodName(model.period))} review</h2><p>Review and posting stay in their own workspaces.</p></div><a class="bcn-btn bcn-btn--primary" href="qbo-reports.html">Open financial reports →</a></section>
      <div class="aw-kpis">${kpi('Bank periods',count(model.queues.count),'Recorded imports')}${kpi('Need review',count(model.queues.needsReview),'In this month')}${kpi('Approved journals',count(model.journals.approved),'Check delivery')}${kpi('Posted journals',count(model.journals.posted),'Recorded in SILO')}</div>
      ${chartCard('Bank periods','transactions.html','Open',model.queues.state === 'unknown' || !model.queues.count ? `<div class="aw-empty">${model.queues.state === 'unknown' ? 'Period status could not be read.' : 'No bank periods recorded in this month.'}</div>` : statusStack(model.queues),'Import and review status for the selected month.')}
      <div class="aw-grid"><section class="aw-card"><div class="aw-section-head"><h2>Month-end checks</h2></div><ol class="aw-checks">${items.map((c,i) => `<li><button type="button" class="aw-check" data-check="${c.id}" aria-pressed="${selected === c.id}" aria-controls="reviewDetail"><span class="aw-check-number">${i+1}</span><span><strong>${esc(c.title)}</strong><small>${esc(c.summary)}</small></span>${state(c.tag,c.tag === 'Review' ? 'attention' : '')}</button></li>`).join('')}</ol><div class="aw-card-foot">A review hub: it does not close or lock the month, or replace bank reconciliation.</div></section><section class="aw-card" id="reviewDetail" aria-live="polite">${renderDetail(model)}</section></div>${journalsCard(model)}`;
  }
  const sourceLabels = {today:'company date',settings:'book settings',opening:'opening balances',qbo:'QuickBooks connection',accountCount:'chart of accounts',bankConnections:'bank connections',bankAccounts:'bank accounts',sources:'account mappings',batches:'bank periods',claims:'unresolved bank posting attempts',journals:'journals'};
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
