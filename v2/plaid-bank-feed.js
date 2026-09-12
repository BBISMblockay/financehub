/* Plaid imports into Card Coding. Credentials and posting remain server-side. */
(function () {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LINK_KEY = 'silo-plaid-link';
  const directionOf = (transaction) => Number(transaction.amount) < 0 ? 'inflow' : 'outflow';
  const isAvailable = (transaction) => transaction.origin !== 'plaid' || transaction.provider_status === 'posted';
  const canEditBatch = (batch) => !!batch && ['draft', 'categorized'].includes(batch.status);
  function eligibleForAi(transaction, source) {
    if (transaction.status !== 'uncoded' || transaction.qbo_account_id || !isAvailable(transaction) || !Number(transaction.amount)) return false;
    if (source?.source_type === 'bank') return transaction.currency === 'USD';
    return Number(transaction.amount) > 0
      && (transaction.origin !== 'plaid' || transaction.accounting_treatment === 'purchase');
  }
  function ruleScopeMatches(rule, transaction, source) {
    if (!source || !isAvailable(transaction)) return false;
    const direction = directionOf(transaction);
    if (transaction.origin === 'plaid' || source.ingest_mode === 'plaid' || source.source_type === 'bank') {
      return rule.source_id === source.id && rule.direction === direction;
    }
    return (!rule.source_id || rule.source_id === source.id)
      && (!rule.direction || rule.direction === 'any' || rule.direction === direction);
  }
  function csvOverlaps(source, rows) {
    return source?.ingest_mode === 'plaid' && rows.some((row) =>
      !row.txn_date || !source.authoritative_from || row.txn_date >= source.authoritative_from);
  }
  function create({ db, company, references, dirty, changed, openBatch, status, document: doc = document,
    window: win = window, storage = sessionStorage }) {
    let connections = [], accounts = [], exceptions = [], busy = false, syncing = null, linkHandler = null;
    const previews = new Map();
    const byId = (id) => doc.getElementById(id);
    async function context() {
      const { data, error } = await db.auth.getSession();
      if (error || !data?.session?.user?.id || !company()?.id) throw new Error('Sign in and choose a company first.');
      return { userId: data.session.user.id, companyId: company().id };
    }
    async function invoke(action, values = {}) {
      await context();
      const { data, error } = await db.functions.invoke('plaid-finance', { body: { action, ...values } });
      if (error || data?.error) {
        let detail=data;
        if(error?.context?.json) {try {detail=await error.context.json();} catch { /* gateway supplied no JSON */ }}
        throw new Error((detail?.error || error?.message || 'Bank feed request failed.')+' Check the account status and retry.');
      }
      if (!data || typeof data !== 'object') throw new Error('Bank feed returned an invalid response.');
      return data;
    }
    function requireSaved() {
      if (dirty()) throw new Error('Save your coding changes before changing or refreshing bank feeds.');
    }
    async function run(action) {
      if (busy) return;
      busy = true;
      byId('btnLinkBank').disabled = true;
      try { requireSaved(); await action(); }
      catch (error) { status(error.message, 'neg'); }
      finally { busy = false; byId('btnLinkBank').disabled = false; }
    }
    async function load() {
      const current = await context();
      const results = await Promise.all([
        db.from('plaid_connections').select('id,institution_name,environment,status,last_error_code,history_days_requested').eq('company_entity_id', current.companyId).order('created_at'),
        db.from('plaid_accounts').select('id,connection_id,name,mask,type,subtype,iso_currency_code,current_balance,available_balance,balance_updated_at,source_id,last_synced_at,last_error_code,cursor,sync_lease_expires_at').eq('company_entity_id', current.companyId).order('name'),
        db.from('plaid_sync_exceptions').select('id,account_id,transaction_id,external_transaction_id,status,previous_payload,provider_payload,created_at').eq('company_entity_id', current.companyId).eq('status', 'open').order('created_at'),
      ]);
      for (const result of results) {
        if (result.error) throw new Error(`Bank feeds are unavailable: ${result.error.message}`);
      }
      if (company()?.id !== current.companyId) throw new Error('Company changed. Refresh bank feeds.');
      [connections, accounts, exceptions] = results.map((result) => result.data || []);
      render();
      win.dispatchEvent?.(new win.Event('silo-bank-feeds-updated'));
    }
    const money = (value, currency) => value == null ? 'Not supplied' : `${currency || 'Unknown currency'} ${Number(value).toFixed(2)}`;
    function render() {
      const { sources, allAccounts } = references();
      byId('bankConnections').innerHTML = connections.length ? connections.map((connection) => `
        <div class="cc-foot"><b>${esc(connection.institution_name || 'Bank connection')}</b>
          <span class="cc-chip">${esc(connection.environment)} · ${esc(connection.status)}</span>
          ${connection.last_error_code ? `<span class="cc-note">${esc(connection.last_error_code)}</span>` : ''}
          ${connection.status !== 'disconnected' ? `<button class="bcn-btn" data-bank-refresh="${esc(connection.id)}">Refresh accounts</button>
          <button class="bcn-btn" data-bank-repair="${esc(connection.id)}">Reconnect</button>
          <button class="bcn-btn" data-bank-disconnect="${esc(connection.id)}">Stop syncing</button>` : `<button class="bcn-btn" data-bank-repair="${esc(connection.id)}">Resume syncing</button>`}</div>`).join('')
        : '<div class="cc-empty">Connect a bank or card, then choose which accounts feed this coding queue.</div>';
      byId('bankAccounts').innerHTML = accounts.map((account) => {
        const source = sources.find((value) => value.id === account.source_id);
        const connection = connections.find((value) => value.id === account.connection_id);
        const supported = ['depository', 'credit'].includes(account.type) && account.iso_currency_code === 'USD';
        const chart = allAccounts.filter((value) => account.type === 'depository' ? value.type === 'Bank'
          : ['Credit Card', 'Accounts Payable'].includes(value.type));
        const sourceOptions = sources.filter((value) => value.id === account.source_id ||
          (value.is_active && value.ingest_mode !== 'plaid' && !accounts.some((other) => other.source_id === value.id)))
          .map((value) => `<option value="${esc(value.id)}" ${value.id === account.source_id ? 'selected' : ''}>${esc(value.display_name)}</option>`).join('');
        const qboOptions = chart.map((value) => `<option value="${esc(value.connectionId)}:${esc(value.id)}"
          ${value.connectionId === source?.qbo_connection_id && value.id === source?.credit_qbo_account_id ? 'selected' : ''}>${esc(value.name)} · ${esc(value.type)} · ${esc(String(value.connectionId || '').slice(0, 8))}</option>`).join('');
        const disabled = !supported || source || connection?.status === 'disconnected';
        return `<div class="cc-card" data-bank-account="${esc(account.id)}"><div class="cc-card-head"><div>
          <div class="cc-title">${esc(account.name)}${account.mask ? ` · ${esc(account.mask)}` : ''}</div>
          <div class="cc-sub">${esc(account.type)} / ${esc(account.subtype || '')} · ${esc(connection?.institution_name || '')}</div></div>
          <span class="cc-chip">${source ? (account.last_synced_at ? 'Mapped' : 'Mapped · not yet synced') : 'Not mapped'}</span></div><div class="cc-pad">
          <div class="cc-note">Current: ${esc(money(account.current_balance, account.iso_currency_code))} · Available: ${esc(money(account.available_balance, account.iso_currency_code))}
          · Balance supplied ${esc(account.balance_updated_at || 'not yet')} · Last synced ${esc(account.last_synced_at || 'never')}
          ${account.last_error_code ? ` · ${esc(account.last_error_code)}` : ''}</div>
          ${!supported ? '<div class="cc-hint cc-warn">V1 supports US dollar checking, savings, and credit card accounts.</div>' : ''}
          <div class="cc-grid" style="margin-top:12px">
            <label class="cc-field">Statement account<select class="bcn-field" data-bank-source ${disabled ? 'disabled' : ''}><option value="">Create an account</option>${sourceOptions}</select></label>
            <label class="cc-field">QBO balancing account<select class="bcn-field" data-bank-qbo ${disabled ? 'disabled' : ''}><option value="">Choose an account…</option>${qboOptions}</select></label>
            <label class="cc-field">Plaid starts on<input type="date" class="bcn-field" data-bank-cutover value="${esc(source?.authoritative_from || '')}" ${disabled ? 'disabled' : ''} /></label>
          </div><div class="bcn-status bcn-status--info" style="margin-top:8px">${source ? 'Permanent import start: '+esc(source.authoritative_from) : 'This start date cannot be changed after mapping. Transactions dated before it will never be imported for this account. Choose a date after your last already-accounted-for statement.'}
            Item history requested: ${connection?.history_days_requested ? esc(connection.history_days_requested)+' days' : 'not recorded for this older connection'}. The institution may return less history.</div>
          ${!source ? `<div class="cc-note" data-bank-history>${previews.get(account.id)?.unavailable ? 'Available history is unknown. Retry preview or explicitly acknowledge unknown history when saving mapping.' : previews.has(account.id) ? 'Earliest date actually returned: '+esc(previews.get(account.id).earliest_date || 'No transactions returned yet') : 'Preview provider history before confirming this account.'}</div>
            <button class="bcn-btn" data-bank-preview ${disabled?'disabled':''}>Preview available history</button>` : ''}
          </div><div class="cc-foot">
          ${!source ? `<button class="bcn-btn" data-bank-map ${disabled ? 'disabled' : ''}>Review account mapping</button>` : ''}
          <button class="bcn-btn bcn-btn--primary" data-bank-sync ${!source || connection?.status !== 'active' ? 'disabled' : ''}>Sync transactions</button>
          <span class="cc-note">${source ? `Uses ${esc(source.display_name)}. Review activity in Transactions.` : 'Mapping does not enable QBO posting.'}</span></div></div>`;
      }).join('');
      byId('bankExceptions').innerHTML = exceptions.length ? `<div class="cc-card-head"><div class="cc-title">${exceptions.length} bank changes need review</div></div>`
        + exceptions.map((exception) => `<div class="cc-pad" data-bank-exception="${esc(exception.id)}">
          <b>${esc(accounts.find((account) => account.id === exception.account_id)?.name || 'Account')}</b>
          <div class="cc-note">A bank transaction changed after approval. The approved entry is preserved. Reopen an unposted batch before applying the bank change; a posted entry requires a posted correction journal.</div>
          <details><summary>View the bank change</summary><div class="cc-grid"><div><b>Previously imported</b><pre style="white-space:pre-wrap">${esc(JSON.stringify(exception.previous_payload, null, 2))}</pre></div><div><b>Bank now reports</b><pre style="white-space:pre-wrap">${esc(JSON.stringify(exception.provider_payload, null, 2))}</pre></div></div></details>
          <div class="cc-foot"><button class="bcn-btn" data-bank-open-exception>Open original batch</button>
          <button class="bcn-btn" data-bank-correction>Create correction journal</button></div>
          <label class="cc-field">Posted correction journal ID (only if original is posted)<input class="bcn-field" data-bank-correction-id /></label>
          <label class="cc-field">Resolution reason<input class="bcn-field" data-bank-reason /></label>
          <button class="bcn-btn" data-bank-resolve>Resolve bank change</button></div>`).join('') : '';
      byId('bankExceptions').hidden = !exceptions.length;
    }
    async function ensureLink() {
      if (win.Plaid?.create) return;
      await new Promise((resolve, reject) => {
        const script = doc.createElement('script');
        script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Plaid Link could not load. Try again.'));
        doc.head.appendChild(script);
      });
      if (!win.Plaid?.create) throw new Error('Plaid Link is unavailable.');
    }
    async function launch(record, receivedRedirectUri) {
      await ensureLink();
      const current = await context();
      if (record.userId !== current.userId || record.companyId !== current.companyId
        || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.now()) throw new Error('This bank connection session expired or belongs to another company. Start again.');
      linkHandler?.destroy?.();
      linkHandler = win.Plaid.create({
        token: record.token,
        ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
        onSuccess: async (publicToken, metadata) => {
          await run(async () => {
            const now = await context();
            if (now.userId !== record.userId || now.companyId !== record.companyId) throw new Error('Company or user changed. Start the bank connection again.');
            const result = record.connectionId
              ? await invoke('refresh_accounts', { connection_id: record.connectionId, resume: true, link_state: record.linkState })
              : await invoke('exchange', { public_token: publicToken, link_state: record.linkState, institution_name: metadata?.institution?.name || null });
            if (!result.connection_id || (record.connectionId && result.connection_id !== record.connectionId)) throw new Error('Bank connection result could not be confirmed. Refresh accounts before retrying.');
            storage.removeItem(LINK_KEY);
            if (new URL(win.location.href).searchParams.has('oauth_state_id')) {
              const cleanUrl = new URL(win.location.href); cleanUrl.searchParams.delete('oauth_state_id');
              win.history.replaceState(null, '', cleanUrl.href);
            }
            await load();
            if (result.account_refresh_required) return status('Bank linked. Account details could not be refreshed. Use Refresh accounts to continue.', 'info');
            status(record.connectionId ? 'Bank reconnected. Sync its mapped accounts below.' : 'Bank connected. Map the accounts you want to import below.', 'pos');
          });
        },
        onExit: (error) => {
          storage.removeItem(LINK_KEY);
          if (error) status('Bank connection was not completed. Reopen Link to try again.', 'neg');
        },
      });
      linkHandler.open();
    }
    async function connect(connectionId) {
      const current = await context();
      const result = await invoke('link_token', connectionId ? { connection_id: connectionId } : {});
      if (!result.link_token || !result.link_state || !result.expires_at || !Number.isFinite(Date.parse(result.expires_at))) throw new Error('Plaid did not return a valid Link session.');
      const record = { ...current, token: result.link_token, linkState: result.link_state, connectionId: connectionId || null, expiresAt: result.expires_at };
      storage.setItem(LINK_KEY, JSON.stringify(record));
      await launch(record);
    }
    async function resume() {
      const url = new URL(win.location.href);
      if (!url.searchParams.has('oauth_state_id')) return false;
      let record;
      try { record = JSON.parse(storage.getItem(LINK_KEY)); } catch { /* expired/corrupt state */ }
      if (!record?.token || !record?.linkState) throw new Error('No matching bank connection session. Start Connect bank or card again.');
      await launch(record, url.href);
      return true;
    }
    byId('btnLinkBank').addEventListener('click', () => run(() => connect()));
    byId('bankConnections').addEventListener('click', (event) => {
      const refresh = event.target.closest('[data-bank-refresh]');
      if (refresh) return run(async () => {
        const result = await invoke('refresh_accounts', { connection_id: refresh.dataset.bankRefresh });
        if (result.connection_id !== refresh.dataset.bankRefresh) throw new Error('Account refresh could not be confirmed.');
        await load(); status('Bank accounts refreshed.', 'pos');
      });
      const repair = event.target.closest('[data-bank-repair]');
      const disconnect = event.target.closest('[data-bank-disconnect]');
      if (repair) return run(() => connect(repair.dataset.bankRepair));
      if (disconnect) return run(async () => {
        await invoke('disconnect', { connection_id: disconnect.dataset.bankDisconnect });
        await load();
        status('Syncing stopped. Imported transactions and approvals remain available.', 'pos');
      });
    });
    byId('bankAccounts').addEventListener('change', (event) => {
      if (!event.target.matches('[data-bank-source]')) return;
      const row = event.target.closest('[data-bank-account]');
      const source = references().sources.find((value) => value.id === event.target.value);
      row.querySelector('[data-bank-qbo]').value = source?.qbo_connection_id && source.credit_qbo_account_id
        ? `${source.qbo_connection_id}:${source.credit_qbo_account_id}` : '';
    });
    byId('bankAccounts').addEventListener('click', (event) => {
      const row = event.target.closest('[data-bank-account]');
      if (!row) return;
      const accountId = row.dataset.bankAccount;
      if (event.target.closest('[data-bank-preview]')) return run(async () => {
        let preview;
        try { preview = await invoke('history_preview', { account_id: accountId }); }
        catch (error) {
          const account = accounts.find(value => value.id === accountId);
          previews.set(accountId, { unavailable: true, history_days_requested: connections.find(value => value.id === account?.connection_id)?.history_days_requested ?? null });
          row.querySelector('[data-bank-history]').textContent = 'Available history is unknown: the preview could not finish. Retry the preview, or save mapping after acknowledging the unknown history and permanent cutover.';
          throw error;
        }
        if (preview.account_id !== accountId) throw new Error('History preview could not be confirmed. Try again.');
        previews.set(accountId, preview);
        row.querySelector('[data-bank-history]').textContent = `Earliest date actually returned: ${preview.earliest_date || 'No transactions returned yet'}. ${preview.returned_count} transactions returned; checked ${preview.checked_at}. More history may still be loading.`;
      });
      if (event.target.closest('[data-bank-map]')) return run(async () => {
        const [connectionId, qboAccountId] = row.querySelector('[data-bank-qbo]').value.split(':');
        const cutover = row.querySelector('[data-bank-cutover]').value;
        if (!connectionId || !qboAccountId || !/^\d{4}-\d{2}-\d{2}$/.test(cutover)) throw new Error('Choose a QBO account and Plaid cutover date first.');
        const preview = previews.get(accountId);
        if (!preview) throw new Error('Preview available history first, then review the mapping.');
        const confirmed = await win.SiloFinanceDialog.ask({ title:'Confirm permanent import start',
          message:`Transactions dated before ${cutover} will never be imported for this account. This date cannot be changed after mapping.\nEarliest date actually returned: ${preview.unavailable ? 'UNKNOWN — the preview could not complete. Older transactions may be permanently excluded by your chosen date' : preview.earliest_date || 'No transactions returned yet; history may still be loading'}.\nItem history requested: ${preview.history_days_requested ? preview.history_days_requested+' days' : 'not recorded'}. More history may arrive later within the provider window.`,
          confirmation:`${preview.unavailable ? 'I acknowledge that available history is unknown and older transactions may be lost. ' : ''}I confirm ${cutover} as this account’s permanent import start date.`, label:'Save account mapping' });
        if (!window.SiloBankWorkspace.cutoverConfirmed(cutover, confirmed === true, row.querySelector('[data-bank-cutover]').value)) return;
        const { data, error } = await db.rpc('configure_plaid_account', {
          p_account_id: accountId, p_qbo_connection_id: connectionId, p_qbo_account_id: qboAccountId,
          p_authoritative_from: cutover, p_source_id: row.querySelector('[data-bank-source]').value || null,
        });
        if (error) throw new Error(error.message);
        if (!data?.source_id) throw new Error('Account mapping could not be confirmed. Refresh bank feeds.');
        await changed(); await load(); status('Account mapped. Sync its transactions when you are ready.', 'pos');
      });
      if (event.target.closest('[data-bank-sync]')) return sync(accountId);
    });
    byId('bankExceptions').addEventListener('click', (event) => {
      const row = event.target.closest('[data-bank-exception]');
      if (!row) return;
      const exception = exceptions.find((value) => value.id === row.dataset.bankException);
      if (!exception) return;
      if (event.target.closest('[data-bank-open-exception]')) return run(async () => {
        const { data, error } = await db.from('card_transactions').select('batch_id').eq('id', exception.transaction_id).eq('company_entity_id', company().id).single();
        if (error) throw new Error(error.message);
        await openBatch(data.batch_id);
      });
      if (event.target.closest('[data-bank-correction]')) {
        if (dirty()) return status('Save coding before opening a correction.', 'neg');
        return win.SiloJE.open({ db, companyId: company().id, context: `plaid-exception:${exception.id}`,
          accountingSource: 'manual_adjustment', accountingSourceRef: `plaid-exception:${exception.id}`,
          prefill: { memo: `Bank transaction correction (${exception.external_transaction_id})` },
          onStaged: (id) => { row.querySelector('[data-bank-correction-id]').value = id; },
          onPosted: () => status('Correction posted. Enter its journal ID and a reason to resolve this bank change.', 'info'),
        });
      }
      if (event.target.closest('[data-bank-resolve]')) return run(async () => {
        const reason = row.querySelector('[data-bank-reason]').value.trim();
        if (!reason) throw new Error('Explain how this bank change was handled.');
        const { error } = await db.rpc('resolve_plaid_exception', { p_exception_id: exception.id, p_reason: reason,
          p_correction_adjustment_id: row.querySelector('[data-bank-correction-id]').value.trim() || null });
        if (error) throw new Error(error.message);
        await changed(); await load(); status('Bank change resolved and recorded.', 'pos');
      });
    });
    async function sync(accountId) {
      return run(async () => {
        syncing = accountId; win.dispatchEvent?.(new win.Event('silo-bank-feeds-updated'));
        try {
          const result = await invoke('sync', { account_id: accountId });
          if (!Array.isArray(result.batch_ids) || !Number.isFinite(Number(result.exceptions))) throw new Error('Sync result could not be confirmed. Refresh accounts before retrying.');
          await changed(); await load();
          status(`Sync finished. ${Number(result.exceptions || 0)} change(s) need review. Choose a period in Transactions.`, 'pos');
          if (result.batch_ids?.length === 1) await openBatch(result.batch_ids[0]);
        } catch(error) {try {await load();}catch{/* Keep the original failure and last known metadata. */}throw error;}
        finally { syncing = null; win.dispatchEvent?.(new win.Event('silo-bank-feeds-updated')); }
      });
    }
    return { load, resume, sync, repair: id => run(() => connect(id)),
      snapshot: () => ({ connections, accounts, exceptions, syncing }) };
  }
  window.SiloBankFeeds = { create, directionOf, isAvailable, canEditBatch, eligibleForAi, ruleScopeMatches, csvOverlaps };
})();
