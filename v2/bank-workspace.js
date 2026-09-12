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
  function create({ document: doc = document, references, feeds, selectSource, openBatch, upload, manage, status, dirty }) {
    let selected = null, generation = 0, navigating = false;
    const el = id => doc.getElementById(id);
    const money = (n, currency) => n == null ? 'Not supplied' : new Intl.NumberFormat('en-US', {style:'currency',currency:currency || 'USD'}).format(n);
    const time = v => v ? new Date(v).toLocaleString() : 'Never';
    function render() {
      const { sources, batches, batch } = references(), data = feeds()?.snapshot() || { accounts:[], connections:[], exceptions:[] };
      const choices = [...sources.filter(s => s.is_active).map(s => ({id:s.id,name:s.display_name,source:s,account:data.accounts.find(a=>a.source_id===s.id)})),
        ...data.accounts.filter(a=>!a.source_id).map(a=>({id:'plaid:'+a.id,name:a.name,account:a}))];
      if (!choices.some(c=>c.id===selected)) selected = batch?.source_id || choices.find(c=>c.account)?.id || choices[0]?.id || null;
      el('workspaceAccount').innerHTML = choices.map(c=>`<option value="${esc(c.id)}" ${c.id===selected?'selected':''}>${esc(c.name)}${c.account?.mask?' · '+esc(c.account.mask):''}</option>`).join('');
      el('workspaceAccount').disabled = !choices.length || navigating;
      const choice = choices.find(c=>c.id===selected);
      if (!choice) { el('workspaceSummary').innerHTML='<div class="bcn-status bcn-status--info">Connect a bank to see its transactions, or add a statement account in Accounts.</div>'; el('workspacePeriod').innerHTML=''; return; }
      const {source,account} = choice;
      const connection = data.connections.find(c=>c.id===account?.connection_id);
      const s = account ? accountState(account,connection,{syncing:data.syncing===account.id})
        : source?.ingest_mode==='plaid' ? accountState({},null) : null;
      el('workspaceSummary').innerHTML = `<div class="cc-card"><div class="cc-card-head"><div><div class="cc-title">${esc(choice.name)}${account?.mask?' · '+esc(account.mask):''}</div>
        <div class="cc-sub">${account ? esc(connection?.institution_name || 'Bank')+' · '+esc(account.type)+' / '+esc(account.subtype || '') : 'Statement account · CSV upload'}</div></div>
        <span class="bcn-pill">${esc(s?.label || 'Statement uploads')}</span></div><div class="cc-pad workspace-facts">
        ${account ? `<div><span>Current balance</span><strong>${esc(money(account.current_balance,account.iso_currency_code))}</strong></div><div><span>Available balance</span><strong>${esc(money(account.available_balance,account.iso_currency_code))}</strong></div>
          <div><span>Balance updated</span><b>${esc(time(account.balance_updated_at))}</b></div><div><span>Last synced</span><b>${esc(time(account.last_synced_at))}</b></div>` : ''}
        <div><span>Balancing account</span><b>${esc(source?.credit_qbo_account_name || 'Choose in Accounts')}</b></div><div><span>QBO posting</span><b>${source?.posting_enabled?'Enabled · approval required':'Off'}</b></div>
        ${account ? `<div><span>Permanent import start</span><b>${esc(source?.authoritative_from || 'Not confirmed')}</b></div><div><span>Connection / saved position</span><b>${esc(connection?.status || 'Unavailable')} · ${account.cursor?'Cursor saved':'No cursor yet'}</b></div>
          <div><span>Open exceptions</span><b>${data.exceptions.filter(e=>e.account_id===account.id).length}</b></div><div><span>Item history requested</span><b>${connection?.history_days_requested ? esc(connection.history_days_requested)+' days' : 'Not recorded for this connection'}</b></div>` : ''}
        </div><div class="cc-foot"><button class="bcn-btn bcn-btn--primary" data-workspace-action="${esc(s?.action || 'upload')}" ${s?.action==='wait'?'disabled':''}>${esc(s?.cta || 'Upload statement')}</button>
        <button class="bcn-btn" data-workspace-action="manage">Account settings</button><span class="cc-note">${esc(s?.help || 'Upload a statement, review its transactions, then approve a journal when ready.')}</span></div></div>`;
      const periods = batches.filter(b=>b.source_id===source?.id).sort((a,b)=>String(b.period_start).localeCompare(String(a.period_start)) || String(b.created_at).localeCompare(String(a.created_at)));
      el('workspacePeriod').innerHTML = periods.length ? periods.map(b=>`<option value="${esc(b.id)}" ${b.id===batch?.id?'selected':''}>${esc(b.label || b.period_start)} · ${esc(b.status)} · ${b.uncoded_count || 0} to review</option>`).join('') : '<option value="">No transactions yet — sync or upload a statement</option>';
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
      if (!action) return;
      try {
        if (dirty()) throw new Error('Save or discard your edits before changing this account.');
        const data=feeds()?.snapshot(), source=references().sources.find(s=>s.id===selected);
        const account=data?.accounts.find(a=>a.source_id===selected || 'plaid:'+a.id===selected);
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
  window.SiloBankWorkspace = { create, accountState, cutoverConfirmed };
})();
