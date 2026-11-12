/* Shared read-only Accounting overview / month-end model.
 * No provider calls, approvals, writes, or claims that a review closes books.
 * UNMEASURED is deliberately different from an empty successful read.
 * Preflight: new consumers are accounting.html and accounting-month-end.html.
 * Reads reuse Books' finance gates and safe QBO RPC, bank-feed columns and
 * card_import_batches_v. No grants/policies change. Production grants/RLS and
 * real-company browser behavior remain deployment verification gates; tests
 * use synthetic clients only. A failed page invalidates its entire section.
 */
(function () {
  'use strict';
  const UNMEASURED = Object.freeze({ unmeasured: true });
  const listKnown = value => Array.isArray(value);
  function periodBounds(period) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || '') || period.slice(0,4) === '0000') throw new Error('Choose a valid month');
    const start = period + '-01';
    const next = new Date(start + 'T00:00:00Z');
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(next.getUTCDate() - 1);
    return { start, end: next.toISOString().slice(0,10) };
  }
  const number = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) ? Number(v) : null;
  function balances(rows) {
    const groups = new Map();
    rows.forEach(row => {
      const currency = /^[A-Z]{3}$/.test(row.iso_currency_code || '') ? row.iso_currency_code : null;
      const type = row.type || 'unknown';
      const key = `${currency || 'unknown'}:${type}`;
      if (!groups.has(key)) groups.set(key, { currency, type, total:null, knownTotal:0, missing:0, count:0 });
      const group = groups.get(key), value = number(row.current_balance);
      group.count += 1;
      if (value === null || !currency) group.missing += 1;
      else group.knownTotal += value;
    });
    return Array.from(groups.values()).map(g => ({ ...g, total:g.missing ? null : g.knownTotal }));
  }
  function inPeriod(row, bounds) {
    const start = row.period_start || row.entry_date;
    const end = row.period_end || row.entry_date || start;
    return !!start && !!end && start <= bounds.end && end >= bounds.start;
  }
  function summary(rows) {
    if (!listKnown(rows)) return { state:'unknown', rows:[], count:null, draft:null, needsReview:null, categorized:null, approved:null, posted:null };
    const countStatus = value => rows.filter(r => r.status === value).length;
    return { state:'known', rows, count:rows.length, draft:countStatus('draft'), needsReview:countStatus('draft') + countStatus('categorized'), categorized:countStatus('categorized'), approved:countStatus('approved'), posted:countStatus('posted') };
  }
  // Mirrors on_deck_coding_items() eligibility, without its 500-work-item /
  // 12-receipt caps. Raw period rows remain available as recorded history.
  // Approved attempts awaiting recovery outrank mode/cutover, as Transactions
  // does: turning posting off cannot settle an already-submitted request.
  function reviewCount(rows, settings, claims) {
    if (!listKnown(rows)) return null;
    let count = 0;
    for (const row of rows) {
      if (!(number(row.txn_count) > 0)) continue;
      if (row.status === 'approved') {
        if (!listKnown(claims)) return null;
        if (claims.some(c => c.source_ref === row.id && ['submitting','unknown'].includes(c.status))) count += 1;
        continue;
      }
      if (!['draft','categorized'].includes(row.status)) continue;
      if (settings === undefined || settings?.unmeasured) return null;
      if (settings?.bookkeeping_mode === 'qbo') continue;
      const ends = row.period_end || row.entry_date || row.period_start;
      if (row.source_posting_start_on && ends && ends < row.source_posting_start_on) continue;
      count += 1;
    }
    return count;
  }
  function assess(facts, { company = null, period } = {}) {
    const bounds = periodBounds(period);
    const settingsKnown = facts.settings !== undefined && !facts.settings?.unmeasured;
    const settings = settingsKnown ? facts.settings : null;
    const mode = !settingsKnown ? 'unknown' : settings?.bookkeeping_mode === 'qbo' ? 'reporting_only' : settings?.bookkeeping_mode === 'silo' ? 'bookkeeping' : 'unknown';
    const openingKnown = facts.opening !== undefined && !facts.opening?.unmeasured;
    const opening = { state:openingKnown ? 'known' : 'unknown', status:openingKnown ? (facts.opening?.status || 'not_started') : 'unknown', acceptedAt:openingKnown ? (facts.opening?.accepted_at || null) : null, startDate:settings?.accounting_start_date || null };
    const bankKnown = listKnown(facts.bankAccounts), connectionsKnown = listKnown(facts.bankConnections), sourcesKnown = listKnown(facts.sources);
    const mappingKnown = sourcesKnown && listKnown(facts.qbo);
    const bankRows = bankKnown ? facts.bankAccounts.map(account => {
      const connection = connectionsKnown ? facts.bankConnections.find(c => c.id === account.connection_id) : null;
      const source = sourcesKnown ? facts.sources.find(s => s.id === account.source_id) : null;
      return { ...account, connectionStatus:connection?.status || 'unknown', institutionName:connection?.institution_name || null,
        mapped:mappingKnown ? !!(source && source.credit_qbo_account_id && source.qbo_connection_id && facts.qbo.some(qbo => qbo.id === source.qbo_connection_id)) : null };
    }) : [];
    const queues = summary(listKnown(facts.batches) ? facts.batches.filter(row => inPeriod(row,bounds)) : UNMEASURED);
    queues.needsReview = reviewCount(listKnown(facts.batches) ? queues.rows : UNMEASURED, facts.settings, facts.claims);
    // These are import/review statuses, never transaction totals or proof of
    // ledger inclusion. Unresolved QBO attempts are reviewed in Transactions.
    const journals = summary(listKnown(facts.journals) ? facts.journals.filter(r => r.entry_date >= bounds.start && r.entry_date <= bounds.end) : UNMEASURED);
    journals.rows = journals.rows.slice().sort((a,b) => String(b.entry_date).localeCompare(String(a.entry_date)) || String(a.kind).localeCompare(String(b.kind)) || String(a.id).localeCompare(String(b.id))).slice(0,8);
    return { company, period, today:typeof facts.today === 'string' ? facts.today : null, settings, mode, opening,
      qbo:{ state:listKnown(facts.qbo) ? 'known' : 'unknown', rows:listKnown(facts.qbo) ? facts.qbo : [], count:listKnown(facts.qbo) ? facts.qbo.length : null },
      accounts:{ state:Number.isInteger(facts.accountCount) ? 'known' : 'unknown', count:Number.isInteger(facts.accountCount) ? facts.accountCount : null },
      banks:{ state:bankKnown && connectionsKnown && mappingKnown ? 'known' : 'unknown', rows:bankRows, count:bankKnown ? bankRows.length : null,
        balances:bankKnown ? balances(bankRows) : [], unmapped:bankKnown && mappingKnown ? bankRows.filter(r => !r.mapped).length : null },
      queues, journals, errors:facts.errors || [] };
  }
  async function result(query) {
    const response = await query;
    if (response.error) throw new Error(response.error.message || 'Read failed');
    return response;
  }
  async function allRows(db, companyId, table, columns, configure = q => q, orders = ['id']) {
    const rows = []; let expected = null;
    for (;;) {
      let query = configure(db.from(table).select(columns, { count:'exact' }).eq('company_entity_id',companyId));
      orders.forEach(column => { query = query.order(column); });
      const response = await result(query.range(rows.length,rows.length + 499));
      if (!Array.isArray(response.data) || !Number.isInteger(response.count)) throw new Error('Could not verify the full row count');
      if (expected !== null && expected !== response.count) throw new Error('Records changed during this read. Refresh to retry.');
      expected = response.count;
      const identities = new Set(rows.map(row => `${row.kind || ''}:${row.id}`));
      for (const row of response.data) {
        const identity = `${row.kind || ''}:${row.id}`;
        if (!row.id || identities.has(identity)) throw new Error('Records changed during this read. Refresh to retry.');
        identities.add(identity);
      }
      rows.push(...response.data);
      if (rows.length === expected) return rows;
      if (!response.data.length || rows.length > expected) throw new Error('Incomplete read. Refresh to retry.');
    }
  }
  async function load({ db, config = window.__SILO_CONFIG__, period }) {
    // Resolve on every refresh. Never trust a company ID from URL/sessionStorage.
    const company = await config?.ensureActiveCompany?.(db);
    if (!company?.id) throw new Error('Select a company first');
    if (company._staleReconcile) throw new Error('Company could not be reconciled. Refresh to retry.');
    const [finance, executive] = await Promise.all([result(db.rpc('can_manage_journal_entries')),result(db.rpc('is_exec_or_owner'))]);
    if (finance.data !== true && executive.data !== true) throw new Error('Finance access is required; ask your company owner for access');
    let today = null;
    const errors = [];
    try { today = (await result(db.rpc('silo_business_today'))).data; } catch (error) { errors.push({source:'today',message:error.message}); }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today || '')) {
      today = null;
      if (!errors.some(e => e.source === 'today')) errors.push({source:'today',message:'Company business date is unavailable'});
    }
    if (!period && !today) throw new Error('Could not resolve the company business date. Refresh to retry.');
    period = period || today.slice(0,7);
    const bounds = periodBounds(period);
    const scope = query => query.eq('company_entity_id',company.id);
    const one = async (table,columns) => (await result(scope(db.from(table).select(columns)).maybeSingle())).data;
    const jobs = {
      qbo:async () => { const data = (await result(db.rpc('accounting_qbo_connections'))).data; if (!Array.isArray(data)) throw new Error('Could not read QuickBooks connections'); return data; },
      settings:() => one('accounting_settings','accounting_start_date,base_currency,accounting_basis,bookkeeping_mode,silo_takeover_on'),
      opening:() => one('accounting_opening_balances','id,status,accepted_at'),
      accountCount:async () => { const r = await result(scope(db.from('accounting_accounts').select('id',{count:'exact',head:true}))); if (!Number.isInteger(r.count)) throw new Error('Could not count accounts'); return r.count; },
      bankConnections:() => allRows(db,company.id,'plaid_connections','id,institution_name,environment,status,last_error_code'),
      bankAccounts:() => allRows(db,company.id,'plaid_accounts','id,connection_id,name,mask,type,subtype,iso_currency_code,current_balance,available_balance,balance_updated_at,source_id,last_synced_at,last_error_code'),
      sources:() => allRows(db,company.id,'card_sources','id,display_name,is_active,qbo_connection_id,credit_qbo_account_id,posting_enabled,posting_start_on'),
      // Use the existing view, which resolves source ownership and QBO delivery.
      // All imports are paginated before overlap filtering: a month can span
      // multiple CSV uploads and Plaid feed sequences, and entry_date alone
      // would omit multi-month uploads that need review in the selected month.
      batches:() => allRows(db,company.id,'card_import_batches_v','id,source_id,source_name,label,status,entry_date,period_start,period_end,txn_count,uncoded_count,posting_status,source_posting_enabled,source_posting_start_on'),
      claims:() => allRows(db,company.id,'quickbooks_journal_postings','id,source_ref,status',q => q.eq('source','card_import').in('status',['submitting','unknown'])),
      journals:() => allRows(db,company.id,'accounting_journal_register','id,kind,entry_date,memo,status,source,posting_status',q => q.gte('entry_date',bounds.start).lte('entry_date',bounds.end),['entry_date','kind','id'])
    };
    const facts = { today,errors };
    await Promise.all(Object.entries(jobs).map(async ([key,read]) => {
      try { facts[key] = await read(); } catch (error) { facts[key] = UNMEASURED; errors.push({source:key,message:error.message}); }
    }));
    // A different tab can change the server's active company during parallel
    // reads. Never render a mixed snapshot as if it belonged to this company.
    const current = await config.ensureActiveCompany(db);
    if (current?._staleReconcile) throw new Error('Company could not be reconciled. Refresh to retry.');
    if (current?.id !== company.id) throw new Error('Company changed while loading. Refresh to retry.');
    return assess(facts,{company,period});
  }
  async function boot({ active, crumbs, onModel, onError, period, config = window.__SILO_CONFIG__, db:providedDb } = {}) {
    let errorReported = false;
    try {
      if (!providedDb && (!config?.SUPABASE_URL || !config?.SUPABASE_ANON_KEY)) throw new Error('Missing Supabase config');
      const db = providedDb || window.supabase.createClient(config.SUPABASE_URL,config.SUPABASE_ANON_KEY);
      const session = await result(db.auth.getSession());
      if (!session.data?.session) { window.location.href = '/pages/login.html?next=' + encodeURIComponent(window.location.pathname + window.location.search); return null; }
      let generation = 0, selected = period;
      const controller = { db, company:null, async refresh(nextPeriod) {
        const token = ++generation;
        if (nextPeriod !== undefined) selected = nextPeriod;
        try {
          const model = await load({db,config,period:selected});
          if (token !== generation) return null;
          selected = model.period; controller.company = model.company;
          onModel?.(model);
          return model;
        } catch (error) { if (token === generation) { errorReported = true; onError?.(error); } throw error; }
      } };
      // Gate and resolve before mounting chrome, just as Books does.
      await controller.refresh();
      window.SiloChrome?.mount({appEl:'#silo-app',active,user:{email:session.data.session.user.email},crumbs,supabaseClient:db});
      return controller;
    } catch (error) { if (!errorReported) onError?.(error); throw error; }
  }
  window.SiloAccountingOverview = { UNMEASURED, assess, periodBounds, balances, reviewCount, load, boot };
})();
