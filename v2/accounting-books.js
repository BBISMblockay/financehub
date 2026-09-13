/* QBO-seeded opening history is never a journal-composer prefill. */
(function () {
  'use strict';
  const el=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const amount=n=>Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const cfg=window.__SILO_CONFIG__||{};
  let db,company,baseline,busy=false,registerOffset=0;
  function status(message,error=false){el('status').textContent=message;el('status').className='bcn-status'+(error?' bcn-status--neg':'');}
  async function result(query){const r=await query;if(r.error)throw new Error(r.error.message);return r.data;}
  async function work(fn){if(busy)return;busy=true;el('seedForm').inert=true;el('seed').disabled=true;el('accept').disabled=true;
    try{await fn();}catch(e){status(`${e.message}. Review the setup values and retry; refresh the page if the problem continues.`,true);}
    finally{busy=false;el('seedForm').inert=baseline?.status==='accepted';el('seed').disabled=baseline?.status==='accepted';el('accept').disabled=!baseline||baseline.status==='accepted';}}
  function table(headers,rows){return '<div class="books-table-scroll"><table><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';}
  async function allRows(name,columns,order){let rows=[];for(let offset=0;;offset+=500){const page=await result(db.from(name).select(columns).eq('company_entity_id',company.id).order(order).order('id').range(offset,offset+499));rows.push(...page);if(page.length<500)return rows;}}
  async function load(){
    const [settings,opening,accounts,reports]=await Promise.all([
      result(db.from('accounting_settings').select('*').eq('company_entity_id',company.id).maybeSingle()),
      result(db.from('accounting_opening_balances').select('*').eq('company_entity_id',company.id).maybeSingle()),
      allRows('accounting_accounts','id,name,account_type,qbo_account_id,is_active','name'),
      result(db.from('quickbooks_report_runs').select('id,end_date,fetched_at,connection_id').eq('company_entity_id',company.id).eq('report_name','TrialBalance').eq('status','ok').order('fetched_at',{ascending:false}).limit(100))]);
    baseline=opening;
    if(settings){el('connection').value=settings.qbo_connection_id;el('connection').disabled=true;}
    el('report').innerHTML='<option value="">Select a saved trial balance</option>'+reports.filter(r=>r.connection_id===el('connection').value).map(r=>`<option value="${esc(r.id)}">${esc(r.end_date)} · fetched ${esc(r.fetched_at)}</option>`).join('');
    el('accountsTable').innerHTML=accounts.length?table(['Account','Type','QBO mapping','Status at import'],accounts.map(a=>`<tr><td title="Silo ID: ${esc(a.id)}">${esc(a.name)}</td><td>${esc(a.account_type)}</td><td>${esc(a.qbo_account_id)}</td><td>${a.is_active?'Active':'Inactive'}</td></tr>`)):'Fetch and prepare a QBO trial balance in Setup to seed your chart of accounts.';
    if(settings){el('fiscal').value=settings.fiscal_year_start_month;el('basis').value=settings.accounting_basis;el('connection').value=settings.qbo_connection_id;}
    el('opening').hidden=!opening;
    if(opening){const s=opening.snapshot;el('baselineTitle').textContent=opening.status==='accepted'?'Your starting balances are accepted.':'Review before you begin.';
      el('settingsSummary').innerHTML=`<p>Balances as of <strong>${esc(s.as_of)}</strong> · Silo starts <strong>${esc(s.accounting_start_date)}</strong></p><p>${esc(s.currency)} · ${esc(s.basis)} · ${s.lines.length} accounts</p><p>Fetched ${esc(s.fetched_at)}</p><div class="books-totals"><span><small>Debits</small>${amount(s.debits)}</span><span><small>Credits</small>${amount(s.credits)}</span><span><small>Difference</small>${amount(Number(s.debits)-Number(s.credits))}</span></div>`+(opening.accepted_at?`<p>Accepted ${esc(opening.accepted_at)}<br>${esc(opening.review_note)}</p>`:'');
      el('opening').innerHTML='<h2>Opening trial balance</h2>'+table(['Account','Debit','Credit'],s.lines.map(l=>`<tr><td>${esc(l.name)}</td><td class="num">${amount(l.debit)}</td><td class="num">${amount(l.credit)}</td></tr>`));
    }
    el('accept').disabled=!opening||opening.status==='accepted';el('seed').disabled=opening?.status==='accepted';el('seedForm').inert=opening?.status==='accepted';
  }
  async function prepare(reportId){if(!reportId)throw new Error('Select a trial balance first');
    await result(db.rpc('seed_accounting_from_qbo',{p_report_id:reportId,p_fiscal_month:Number(el('fiscal').value)}));await load();status('Opening balances prepared. Review every account below before accepting. Nothing was posted to QuickBooks.');}
  async function register(reset=false){if(reset){registerOffset=0;el('registerTable').innerHTML='';}
    const rows=await result(db.from('accounting_journal_register').select('*').eq('company_entity_id',company.id).order('entry_date',{ascending:false}).order('kind').order('id').range(registerOffset,registerOffset+49));
    if(!registerOffset)el('registerTable').innerHTML=rows.length?'':'No journal entries yet. Review Transactions or create a journal entry.';
    el('registerTable').insertAdjacentHTML('beforeend',rows.length?table(['Date','Source','Description','Review','QBO delivery','Action'],rows.map(r=>`<tr><td>${esc(r.entry_date)}</td><td>${esc(r.source||r.kind)}</td><td>${esc(r.memo)}</td><td>${esc(r.status)}</td><td>${esc(r.posting_status||'Not sent')}</td><td>${r.kind==='journal_adjustment'?`<button class="bcn-btn" data-journal="${esc(r.id)}">Open</button>`:'<a href="transactions.html">Review transactions</a>'}</td></tr>`)):'');
    registerOffset+=rows.length;el('more').hidden=rows.length<50;
  }
  async function boot(){
    if(!cfg.SUPABASE_URL||!cfg.SUPABASE_ANON_KEY)throw new Error('Missing configuration; contact your Silo administrator');
    db=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);
    const {data,error}=await db.auth.getSession();if(error)throw error;
    if(!data.session){location.href='/pages/login.html?next='+encodeURIComponent(location.pathname);return;}
    company=await cfg.ensureActiveCompany(db);if(!company?.id)throw new Error('Select a company first');
    const permitted=await result(db.rpc('can_manage_journal_entries'));const executive=await result(db.rpc('is_exec_or_owner'));if(!permitted&&!executive)throw new Error('Finance access is required; ask your company owner for access');
    window.SiloChrome.mount({appEl:'#silo-app',active:'finance/books',user:{email:data.session.user.email},crumbs:['Accounting','Books & setup'],supabaseClient:db});
    const connections=await result(db.rpc('accounting_qbo_connections'));
    el('connection').innerHTML=connections.length?connections.map(c=>`<option value="${esc(c.id)}">${esc(c.company_name||c.realm_id)} · ${esc(c.environment)}</option>`).join(''):'<option value="">Connect QuickBooks first</option>';
    el('fiscal').innerHTML=Array.from({length:12},(_,i)=>`<option value="${i+1}">${new Date(2000,i,1).toLocaleString('en-US',{month:'long'})}</option>`).join('');
    // Use Silo's business date, not the browser's UTC date near Pacific midnight.
    const businessToday=await result(db.rpc('silo_business_today'));
    if(!/^\d{4}-\d{2}-\d{2}$/.test(businessToday))throw new Error('Could not resolve the company business date');
    const yesterday=new Date(businessToday+'T00:00:00Z');yesterday.setUTCDate(yesterday.getUTCDate()-1);el('cutoff').value=yesterday.toISOString().slice(0,10);
    await load();await register(true);
    status(connections.length?'Start from QuickBooks, then review your opening balances.':'Ask your company administrator to connect QuickBooks, then return here.');
    el('seedForm').addEventListener('submit',e=>{e.preventDefault();work(async()=>{status('Fetching a read-only trial balance from QuickBooks…');
      const cutoff=el('cutoff').value;const fiscal=Number(el('fiscal').value);const year=Number(cutoff.slice(0,4))-(Number(cutoff.slice(5,7))<fiscal?1:0);
      const startDate=String(year)+'-'+String(fiscal).padStart(2,'0')+'-01';
      const response=await result(db.functions.invoke('quickbooks-report',{body:{connection_id:el('connection').value,report_name:'TrialBalance',params:{start_date:startDate,end_date:cutoff,accounting_method:el('basis').value}}}));
      if(!response?.run_id)throw new Error(response?.error||'QBO did not store a report');await prepare(response.run_id);});});
    el('seed').addEventListener('click',()=>work(()=>prepare(el('report').value)));
    el('connection').addEventListener('change',()=>work(load));
    el('accept').addEventListener('click',()=>work(async()=>{const reviewed=baseline;const reason=await window.SiloFinanceDialog.ask({title:'Accept Silo opening balances',message:`Accept ${reviewed.snapshot.currency} ${amount(reviewed.snapshot.debits)} of balanced opening history as of ${reviewed.snapshot.as_of}. This freezes the baseline. It does not post a journal to QBO or switch ledger ownership.`,label:'Accept opening balances',reason:true,minLength:10,confirmation:'I reviewed the accounts, balances, cutover date and accounting basis against QuickBooks.'});if(!reason)return;
      await result(db.rpc('accept_accounting_opening_balances',{p_id:reviewed.id,p_expected_hash:reviewed.snapshot_hash,p_reason:reason}));await load();status('Opening history accepted and retained in Silo. No QBO journal was created.');}));
    document.querySelectorAll('[data-surface]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.books-surface').forEach(s=>s.hidden=s.id!==button.dataset.surface);document.querySelectorAll('[data-surface]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));}));
    const openJournal=id=>window.SiloJE.open({db,companyId:company.id,context:'accounting:register',adjustmentId:id,onStaged:()=>work(()=>register(true)),onPosted:()=>work(()=>register(true))});
    el('newJournal').addEventListener('click',()=>openJournal());el('registerTable').addEventListener('click',e=>{const b=e.target.closest('[data-journal]');if(b)openJournal(b.dataset.journal);});el('more').addEventListener('click',()=>work(()=>register()));
    // History loading must not delay or disable the existing Books controls.
    window.SiloQboHistory?.mount({db,companyId:company.id}).catch(e=>{el('historyStatus').textContent=`History could not load: ${e.message}. Refresh saved history or contact your administrator.`;});
  }
  boot().catch(e=>{status(`${e.message}. Reload after the accounting foundation migration is applied, or contact your administrator.`,true);el('seedForm').inert=true;});
})();
