/* Account-first navigation over the existing sources, batches and coding grid. */
(function () {
  'use strict';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  function accountState(account, connection, { syncing = false, now = Date.now() } = {}) {
    if (!connection) return { key:'unavailable', label:'Connection unavailable', action:'refresh', cta:'Refresh accounts', help:'Refresh to load this connection. If it remains unavailable, ask your finance administrator.' };
    if (connection.status === 'disconnected') return { key:'disconnected', label:'Syncing stopped', action:'repair', cta:'Resume syncing', help:'Reconnect to resume. Imported activity stays available.' };
    if (connection.status === 'login_required' || account.last_error_code === 'ITEM_LOGIN_REQUIRED') return { key:'login_required', label:'Bank login required', action:'repair', cta:'Reconnect bank', help:'Sign in with your bank to restore access.' };
    if (syncing) return { key:'syncing', label:'Syncing transactions', action:'wait', cta:'Syncing…', help:'Keep reviewing saved activity while this sync finishes.' };
    if (Date.parse(account.sync_lease_expires_at || '') > now) return { key:'lease-held', label:'Another sync is running', action:'refresh', cta:'Check sync status', help:'Wait until ' + new Date(account.sync_lease_expires_at).toLocaleTimeString() + ', then check status. Do not reset the cursor.' };
    if (!account.source_id) return { key:'unmapped', label:'Choose import start', action:'map', cta:'Set up account', help:'Preview available history and confirm the permanent import start date.' };
    if (connection.status === 'error' || account.last_error_code) return { key:'error', label:'Sync needs attention', action:'sync', cta:'Retry sync', help:'Retry using the saved position. If it fails again, contact your finance administrator. ' + (account.last_error_code || connection.last_error_code || '') };
    if (!account.last_synced_at || !account.cursor) return { key:'mapped-never-synced', label:'Mapped · not yet synced', action:'sync', cta:'Sync first transactions', help:'Your mapping is saved. Start the first sync to see transactions here.' };
    if (now - Date.parse(account.last_synced_at) > 24*60*60*1000) return { key:'stale', label:'Sync is overdue', action:'sync', cta:'Sync transactions', help:'Last successful sync was over 24 hours ago. Retrieve available bank updates.' };
    return { key:'synced-recently', label:'Recently synced', action:'sync', cta:'Sync transactions', help:'Review the transactions below. Sync retrieves available updates; it does not force a bank refresh.' };
  }
  function cutoverConfirmed(date, checked, confirmedDate) {
    return /^\d{4}-\d{2}-\d{2}$/.test(date || '') && checked === true && date === confirmedDate;
  }
  // Preference only: the existing scheduler prepares suggestions; people
  // still accept, approve and post. No model call is made from this control.
  async function saveAutoPreparation(db, company, source, enabled) {
    if (!company || !source?.id || source.company_entity_id !== company)
      throw new Error('Account changed. Refresh before changing automatic suggestions.');
    if (typeof source.auto_prepare_coding !== 'boolean' || typeof enabled !== 'boolean')
      throw new Error('Automatic preparation is not available for this account yet.');
    if (enabled && (!source.is_active || !source.qbo_connection_id))
      throw new Error('Set up an active account and its QuickBooks mapping first.');
    const query = db.from('card_sources').update({ auto_prepare_coding: enabled })
      .eq('id', source.id).eq('company_entity_id', company)
      .eq('auto_prepare_coding', source.auto_prepare_coding);
    if (enabled) query.eq('is_active', true).eq('qbo_connection_id', source.qbo_connection_id);
    const { data, error } = await query.select('id,company_entity_id,auto_prepare_coding');
    if (error) throw new Error(error.message);
    if (data?.length !== 1 || data[0].id !== source.id || data[0].company_entity_id !== company
        || data[0].auto_prepare_coding !== enabled)
      throw new Error('The account setting changed or could not be saved. Refresh and try again.');
    return data[0].auto_prepare_coding;
  }
  function preparationSetting(source, canSave) {
    if (!source) return '';
    const known = typeof source.auto_prepare_coding === 'boolean';
    const enabled = source.auto_prepare_coding === true;
    return `<section class="workspace-preparation" aria-label="Automatic coding suggestions">
      <strong>Automatic coding suggestions</strong>
      <p>${known ? (enabled ? 'Requested for this account.' : 'Off for this account.') : 'Unavailable until background preparation is set up.'}
      Prepares categories for review; never accepts, approves or posts them.</p>
      <p>Uses paid AI calls on eligible uncoded transactions, including existing backlog. Runs after scheduled bank syncs and during the nightly catch-up only when background preparation is enabled by your administrator. Manual preparation remains available.</p>
      ${canSave && known ? `<button class="bcn-btn" data-workspace-action="${enabled ? 'disable-preparation' : 'enable-preparation'}" ${!enabled && (!source.is_active || !source.qbo_connection_id) ? 'disabled' : ''}>${enabled ? 'Turn off automatic suggestions' : 'Enable automatic suggestions'}</button>` : ''}
      ${known && !enabled && !source.qbo_connection_id ? '<p>Choose this account’s QuickBooks mapping first.</p>' : ''}
    </section>`;
  }
  function create({ document: doc = document, references, feeds, selectSource, openBatch, upload, manage, status, dirty, db, company }) {
    let selected = null, generation = 0, navigating = false, savingPreparation = false;
    const el = id => doc.getElementById(id);
    const money = (n, currency) => n == null ? 'Not supplied' : new Intl.NumberFormat('en-US', {style:'currency',currency:currency || 'USD'}).format(n);
    const time = v => v ? new Date(v).toLocaleString() : 'Never';
    function render() {
      const { sources, batches, batch } = references(), data = feeds()?.snapshot() || { accounts:[], connections:[], exceptions:[] };
      const choices = [...sources.filter(s => s.is_active).map(s => ({id:s.id,name:s.display_name,source:s,account:data.accounts.find(a=>a.source_id===s.id)})),
        ...data.accounts.filter(a=>!a.source_id).map(a=>({id:'plaid:'+a.id,name:a.name,account:a}))];
      if (!choices.some(c=>c.id===selected)) selected = batch?.source_id || choices.find(c=>c.account)?.id || choices[0]?.id || null;
      // The tile strip in transactions-tiles.js renders FROM these options, so the
      // facts it shows travel as data-* here. Value and text are unchanged, which
      // keeps this a plain <select> for anything that already reads it.
      const pending = id => batches.filter(b=>b.source_id===id && b.status!=='posted' && b.status!=='voided')
        .reduce((n,b)=>n+(b.uncoded_count||0),0);
      el('workspaceAccount').innerHTML = choices.map(c=>{
        const conn = data.connections.find(x=>x.id===c.account?.connection_id);
        const st = c.account ? accountState(c.account,conn,{syncing:data.syncing===c.account.id})
          : c.source?.ingest_mode==='plaid' ? accountState({},null) : null;
        const bal = c.account ? (c.account.available_balance ?? c.account.current_balance) : null;
        return `<option value="${esc(c.id)}" ${c.id===selected?'selected':''}`
          + ` data-name="${esc(c.name)}"`
          + ` data-mask="${esc(c.account?.mask || '')}"`
          + ` data-institution="${esc(conn?.institution_name || (c.account?'Bank':'Statement account'))}"`
          + ` data-balance="${bal==null?'':esc(money(bal,c.account?.iso_currency_code))}"`
          + ` data-balance-label="${c.account ? (c.account.available_balance!=null?'Available':'Balance') : 'Import method'}"`
          + ` data-balance-fallback="${c.account?'Not supplied':'Statement upload'}"`
          + ` data-health="${esc(st?.key || 'csv')}"`
          + ` data-health-label="${esc(st?.label || 'Statement uploads')}"`
          + ` data-synced="${esc(c.account?.last_synced_at || '')}"`
          + ` data-pending="${pending(c.source?.id || '')}"`
          + `>${esc(c.name)}${c.account?.mask?' · '+esc(c.account.mask):''}</option>`;
      }).join('');
      el('workspaceAccount').disabled = !choices.length || navigating;
      const choice = choices.find(c=>c.id===selected);
      if (!choice) { el('workspaceSummary').innerHTML='<div class="bcn-status bcn-status--info">Connect a bank to see its transactions, or add a statement account in Accounts.</div>'; el('workspacePeriod').innerHTML=''; return; }
      const {source,account} = choice;
      const connection = data.connections.find(c=>c.id===account?.connection_id);
      const s = account ? accountState(account,connection,{syncing:data.syncing===account.id})
        : source?.ingest_mode==='plaid' ? accountState({},null) : null;
      const exceptionCount = data.exceptions.filter(e=>e.account_id===account?.id).length;
      el('workspaceSummary').innerHTML = `<section class="workspace-account" aria-label="Account overview">
        <div class="workspace-overview"><div class="workspace-identity"><span class="workspace-bank-icon" aria-hidden="true">${account?'▤':'▧'}</span><div><h2>${esc(choice.name)}${account?.mask?' <span>••'+esc(account.mask)+'</span>':''}</h2><p>${account ? esc(connection?.institution_name || 'Bank')+' · '+esc(account.subtype || account.type) : 'Statement account · CSV upload'}</p></div></div>
        <div class="workspace-balances">${account ? `<div><span>Current balance</span><strong>${esc(money(account.current_balance,account.iso_currency_code))}</strong></div><div><span>Available</span><b>${esc(money(account.available_balance,account.iso_currency_code))}</b></div>` : '<div><span>Import method</span><b>Statement upload</b></div>'}</div>
        <div class="workspace-sync"><span class="workspace-health" data-health="${esc(s?.key || 'csv')}">${esc(s?.label || 'Statement uploads')}</span><button class="bcn-btn" data-workspace-action="${esc(s?.action || 'upload')}" ${s?.action==='wait'?'disabled':''}>${esc(s?.cta || 'Upload statement')}</button></div></div>
        <div class="workspace-context"><span>${account?'Importing from <b>'+esc(source?.authoritative_from || 'Not confirmed')+'</b>':'CSV statements'}${exceptionCount?' · <b>'+exceptionCount+' open exceptions</b>':''}</span><span>QBO posting <b>${source?.posting_enabled?'enabled · approval required':'off'}</b></span>
        <details class="workspace-details"><summary>Account details</summary><div class="workspace-facts">
        <div><span>Balancing account</span><b>${esc(source?.credit_qbo_account_name || 'Choose in Accounts')}</b></div>
        ${account ? `<div><span>Balance updated</span><b>${esc(time(account.balance_updated_at))}</b></div><div><span>Last synced</span><b>${esc(time(account.last_synced_at))}</b></div><div><span>Connection / saved position</span><b>${esc(connection?.status || 'Unavailable')} · ${account.cursor?'Cursor saved':'No cursor yet'}</b></div><div><span>Open exceptions</span><b>${exceptionCount}</b></div><div><span>Item history requested</span><b>${connection?.history_days_requested ? esc(connection.history_days_requested)+' days' : 'Not recorded for this connection'}</b></div>` : ''}
        </div><p>${esc(s?.help || 'Upload a statement, review its transactions, then approve a journal when ready.')}</p><button class="bcn-btn" data-workspace-action="manage">Account settings</button>${preparationSetting(source, !!db && typeof company === 'function')}</details></div>
        ${s && !['synced-recently','csv'].includes(s.key) ? `<div class="${['syncing','lease-held'].includes(s.key)?'workspace-progress':'workspace-attention'}">${esc(s.help)}</div>` : ''}</section>`;
      const periods = batches.filter(b=>b.source_id===source?.id).sort((a,b)=>String(b.period_start).localeCompare(String(a.period_start)) || String(b.created_at).localeCompare(String(a.created_at)));
      el('workspacePeriod').innerHTML = periods.length ? periods.map(b=>`<option value="${esc(b.id)}" ${b.id===batch?.id?'selected':''}`
        + ` data-label="${esc(b.label || b.period_start || '')}"`
        + ` data-start="${esc(b.period_start || '')}"`
        + ` data-status="${esc(b.status)}"`
        + ` data-pending="${b.uncoded_count || 0}"`
        + `>${esc(b.label || b.period_start)} · ${esc(b.status)} · ${b.uncoded_count || 0} to review</option>`).join('') : '<option value="">No transactions yet — sync or upload a statement</option>';
      el('workspacePeriod').disabled = !periods.length || navigating;
    }
    async function choose(id) {
      if (navigating) return;
      if (dirty()) { render(); return status('Save or discard your edits before switching accounts.', 'neg'); }
      const request = ++generation;
      selected = id; navigating=true; render();
      try { await selectSource(id.startsWith('plaid:') ? null : id); }
      finally {navigating=false;if (request===generation) render();}
    }
    el('workspaceAccount').addEventListener('change',e=>choose(e.target.value).catch(error=>status(error.message,'neg')));
    el('workspacePeriod').addEventListener('change',async e=>{
      if(navigating)return;
      const id=e.target.value;navigating=true;render();
      try { await openBatch(id); } catch(error){status(error.message,'neg');}finally{navigating=false;render();}
    });
    el('workspaceSummary').addEventListener('click',async e=>{
      const action = e.target.closest('[data-workspace-action]')?.dataset.workspaceAction;
      if (!action || savingPreparation) return;
      try {
        if (dirty()) throw new Error('Save or discard your edits before changing this account.');
        const data=feeds()?.snapshot(), source=references().sources.find(s=>s.id===selected);
        const account=data?.accounts.find(a=>a.source_id===selected || 'plaid:'+a.id===selected);
        if(action==='enable-preparation' || action==='disable-preparation') {
          const savedCompany = company?.(), sourceId = selected;
          const button = e.target.closest('[data-workspace-action]');
          savingPreparation = true; button.disabled = true;
          try {
            const enabled = await saveAutoPreparation(db, savedCompany, source, action==='enable-preparation');
            if (company?.() !== savedCompany || selected !== sourceId) return;
            const current = references().sources.find(s=>s.id===sourceId && s.company_entity_id===savedCompany);
            if (current) current.auto_prepare_coding = enabled;
            render();
            el('workspaceSummary').querySelector?.('.workspace-details')?.setAttribute('open', '');
            status(enabled ? 'Automatic suggestions requested for this account. Background preparation must be enabled by your administrator. Review and posting stay with your team.' : 'Automatic suggestions turned off. Prepared suggestions remain available for review.', 'pos');
          } finally { savingPreparation = false; button.disabled = false; }
          return;
        }
        if(action==='upload') return upload(source?.id);
        if(action==='manage' || action==='map') return manage(account?.id);
        if(action==='refresh') await feeds().load();
        if(action==='repair') await feeds().repair(account.connection_id);
        if(action==='sync') {await feeds().sync(account.id);if(!dirty())await choose(selected);}
        render();
      } catch(error){status(error.message,'neg');}
    });
    return { render, choose, followBatch(){selected=references().batch?.source_id || selected;render();}, selected:()=>selected };
  }
  window.SiloBankWorkspace = { create, accountState, cutoverConfirmed, saveAutoPreparation, preparationSetting };
})();
