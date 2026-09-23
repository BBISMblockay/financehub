/* QBO-seeded opening history is never a journal-composer prefill. */
(function () {
  'use strict';
  const el=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const amount=n=>Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  // A stored timestamp, to the day. '2026-09-14T00:00:00Z' beside a date is the
  // same overlong label the saved-snapshot dropdown carried; nobody reads the
  // seconds off an acceptance.
  const day=value=>String(value??'').slice(0,10);
  const cfg=window.__SILO_CONFIG__||{};
  let db,company,baseline,booksSettings=null,busy=false,registerOffset=0;
  function status(message,error=false){el('status').textContent=message;el('status').className='bcn-status'+(error?' bcn-status--neg':'');}
  async function result(query){const r=await query;if(r.error)throw new Error(r.error.message);return r.data;}
  async function work(fn){if(busy)return;busy=true;el('seedForm').inert=true;el('seed').disabled=true;el('accept').disabled=true;
    try{await fn();}catch(e){status(`${e.message}. Review the setup values and retry; refresh the page if the problem continues.`,true);}
    finally{busy=false;el('seedForm').inert=baseline?.status==='accepted';el('seed').disabled=baseline?.status==='accepted';el('accept').disabled=!baseline||baseline.status==='accepted';}}
  function table(headers,rows){return '<div class="books-table-scroll"><table><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';}
  async function allRows(name,columns,order){let rows=[];for(let offset=0;;offset+=500){const page=await result(db.from(name).select(columns).eq('company_entity_id',company.id).order(order).order('id').range(offset,offset+499));rows.push(...page);if(page.length<500)return rows;}}
  // QuickBooks only accepts a line on an AR or AP account with a customer or
  // vendor on it, so that is the one per-line requirement an account carries.
  const LINE_NEEDS={'Accounts Receivable':'Customer on every line','Accounts Payable':'Vendor on every line'};
  // Reads that only enrich a surface: a failure leaves that surface saying so
  // rather than taking the page down.
  const soft=query=>Promise.resolve(query).then(r=>r.error?{error:r.error.message,data:[]}:{data:r.data||[]},e=>({error:e.message,data:[]}));
  async function load(){
    const [settings,opening,accounts,reports,liveAccounts,qboLocations,locationMap]=await Promise.all([
      result(db.from('accounting_settings').select('*').eq('company_entity_id',company.id).maybeSingle()),
      result(db.from('accounting_opening_balances').select('*').eq('company_entity_id',company.id).maybeSingle()),
      allRows('accounting_accounts','id,name,account_type,qbo_account_id,is_active','name'),
      result(db.from('quickbooks_report_runs').select('id,end_date,fetched_at,connection_id').eq('company_entity_id',company.id).eq('report_name','TrialBalance').eq('status','ok').order('fetched_at',{ascending:false}).limit(100)),
      soft(db.from('quickbooks_accounts').select('qbo_account_id,is_active,account_type').eq('company_entity_id',company.id).range(0,4999)),
      soft(db.from('quickbooks_locations').select('qbo_location_id,name,fully_qualified_name,is_active').eq('company_entity_id',company.id).order('fully_qualified_name')),
      soft(db.from('accounting_location_map').select('location_tag,qbo_location_id').eq('company_entity_id',company.id))]);
    baseline=opening;booksSettings=settings;
    const accepted=opening?.status==='accepted';
    el('booksTitle').textContent=accepted?'Books & setup':'Set up your books';
    el('booksIntro').textContent=accepted?'Your accounts, opening balances and journal history.':'Start with QuickBooks. Review your opening balances before accepting.';
    el('booksBadge').textContent=accepted?'Opening balances accepted':opening?'Review opening balances':'Setup needed';
    el('setupInputs').open=!accepted;
    el('setupInputsLabel').textContent=accepted?'Connection & opening settings':'Prepare opening balances';
    el('accept').hidden=accepted;
    if(opening?.snapshot?.as_of)el('cutoff').value=opening.snapshot.as_of;
    if(settings){el('connection').value=settings.qbo_connection_id;el('connection').disabled=true;}
    el('report').innerHTML='<option value="">Select a saved trial balance</option>'+reports.filter(r=>r.connection_id===el('connection').value).map(r=>`<option value="${esc(r.id)}">${esc(r.end_date)} · fetched ${esc(day(r.fetched_at))}</option>`).join('');
    const live=new Map(liveAccounts.data.map(a=>[String(a.qbo_account_id),a]));
    const nowStatus=a=>{if(liveAccounts.error)return 'Unknown';const q=live.get(String(a.qbo_account_id));return !q?'Not in last QBO sync':q.is_active?'Active':'Inactive';};
    el('accountsTable').innerHTML=accounts.length?(liveAccounts.error?`<p class="books-caption">Current QuickBooks status could not be read: ${esc(liveAccounts.error)}</p>`:'')+table(['Account','Type','QBO ID','At seeding','In QuickBooks now','Each journal line needs'],accounts.map(a=>{const n=nowStatus(a);return `<tr><td title="Silo ID: ${esc(a.id)}">${esc(a.name)}</td><td>${esc(a.account_type)}</td><td>${esc(a.qbo_account_id)}</td><td>${a.is_active?'Active':'Inactive'}</td><td${n==='Active'?'':' class="books-flag"'}>${esc(n)}</td><td>${esc(LINE_NEEDS[a.account_type]||'—')}</td></tr>`;})):'Fetch and prepare a QBO trial balance in Setup to seed your chart of accounts.';
    const tags=new Map();for(const m of locationMap.data){if(!m.qbo_location_id)continue;const k=String(m.qbo_location_id);if(!tags.has(k))tags.set(k,[]);tags.get(k).push(m.location_tag);}
    const unmapped=locationMap.data.filter(m=>!m.qbo_location_id).map(m=>m.location_tag);
    el('locationsTable').innerHTML=qboLocations.error?`Locations could not be read: ${esc(qboLocations.error)}`:qboLocations.data.length
      ?table(['Location','QBO ID','In QuickBooks','Silo sales locations mapped'],qboLocations.data.map(l=>`<tr><td>${esc(l.fully_qualified_name||l.name)}</td><td>${esc(l.qbo_location_id)}</td><td${l.is_active?'':' class="books-flag"'}>${l.is_active?'Active':'Inactive'}</td><td>${esc((tags.get(String(l.qbo_location_id))||[]).join(', ')||'—')}</td></tr>`))
        +(locationMap.error?`<p class="books-caption">Location mappings could not be read: ${esc(locationMap.error)}</p>`:unmapped.length?`<p class="books-caption books-flag">Not mapped to a QuickBooks location: ${esc(unmapped.join(', '))}</p>`:'')
      :'No QuickBooks locations synced. Location tracking may be off in QuickBooks, or the account sync has not run.';
    if(settings){el('fiscal').value=settings.fiscal_year_start_month;el('basis').value=settings.accounting_basis;el('connection').value=settings.qbo_connection_id;}
    el('opening').hidden=!opening;
    if(opening){const s=opening.snapshot;el('baselineTitle').textContent=opening.status==='accepted'?'Your starting balances are accepted.':'Review before you begin.';
      // Four lines became two: what the snapshot covers, and what it is made of.
      // The fetch date joins the line it belongs to rather than taking one of
      // its own, and the acceptance keeps its review note, which is the half a
      // reader actually came for.
      el('settingsSummary').innerHTML=`<p>Balances as of <strong>${esc(s.as_of)}</strong> · Silo starts <strong>${esc(s.accounting_start_date)}</strong></p>`
        +`<p class="books-caption">${esc(s.currency)} · ${esc(s.basis)} · ${s.lines.length} accounts · fetched ${esc(day(s.fetched_at))}</p>`
        +`<div class="books-totals"><span><small>Debits</small>${amount(s.debits)}</span><span><small>Credits</small>${amount(s.credits)}</span><span><small>Difference</small>${amount(Number(s.debits)-Number(s.credits))}</span></div>`
        +(opening.accepted_at?`<p class="books-caption">Accepted ${esc(day(opening.accepted_at))}${opening.review_note?` · ${esc(opening.review_note)}`:''}</p>`:'');
      // Once accepted the lines are reference, not a task: they fold away
      // behind a summary line, still one click from every account.
      const lines=table(['Account','Debit','Credit'],s.lines.map(l=>`<tr><td>${esc(l.name)}</td><td class="num">${amount(l.debit)}</td><td class="num">${amount(l.credit)}</td></tr>`));
      el('opening').innerHTML=opening.status==='accepted'
        ?`<details><summary><strong>Opening trial balance</strong> · ${s.lines.length} accounts · accepted ${esc(day(opening.accepted_at))}</summary>${lines}</details>`
        :'<h2>Opening trial balance</h2>'+lines;
    }
    el('accept').disabled=!opening||opening.status==='accepted';el('seed').disabled=opening?.status==='accepted';el('seedForm').inert=opening?.status==='accepted';
  }
  async function prepare(reportId){if(!reportId)throw new Error('Select a trial balance first');
    await result(db.rpc('seed_accounting_from_qbo',{p_report_id:reportId,p_fiscal_month:Number(el('fiscal').value)}));await load();status('Opening balances prepared. Review every account below before accepting. Nothing was posted to QuickBooks.');}
  // Discard and Void live here (moved from Reports) so the register is the one
  // place a close is checked: Discard only a draft adjustment (RLS refuses the
  // rest), Void only a posted entry, through the same RPCs the source pages use.
  function registerActions(r){
    const open=r.kind==='journal_adjustment'?`<button class="bcn-btn" data-journal="${esc(r.id)}">Open</button>`:`<a href="transactions.html?batch=${encodeURIComponent(r.id)}&amp;company=${encodeURIComponent(company.id)}">Review transactions</a>`;
    const discard=r.kind==='journal_adjustment'&&r.status==='draft'?` <button class="bcn-btn" data-discard="${esc(r.id)}">Discard</button>`:'';
    const voided=r.status==='posted'?` <button class="bcn-btn" data-void="${esc(r.id)}" data-void-kind="${esc(r.kind)}">Void</button>`:'';
    return open+discard+voided;}
  async function discardJournal(id){
    const ok=await window.SiloFinanceDialog.ask({title:'Discard staged journal entry',message:'This draft has not been posted, so nothing in QuickBooks changes. Its lines are deleted with it.',label:'Discard'});
    if(!ok)return;
    const rows=await result(db.from('journal_adjustments').delete().eq('id',id).eq('status','draft').select('id'));
    if(!rows.length)throw new Error('The entry is no longer a draft and was not discarded');
    await register(true);status('Staged journal entry discarded. Nothing changed in QuickBooks.');}
  async function voidJournal(id,kind){
    const card=kind==='card_batch';
    const reason=await window.SiloFinanceDialog.ask({title:'Void posted journal entry',message:'Void only after the entry has been deleted in QuickBooks. This changes what Silo records, not what QuickBooks holds. The '+(card?'batch':'entry')+' returns to approved and can be posted again.',label:'Void',reason:true,confirmation:'The entry has been deleted in QuickBooks'});
    if(!reason)return;
    const data=await result(db.rpc(card?'void_card_posting':'void_journal_adjustment',card?{p_batch_id:id,p_reason:reason}:{p_adjustment_id:id,p_reason:reason}));
    await register(true);status(`Voided entry ${data?.doc_number||data?.qbo_journal_entry_id||''}. It is back to approved and can be posted again.`.replace('  ',' '));}
  async function register(reset=false){if(reset){registerOffset=0;el('registerTable').innerHTML='';}
    const rows=await result(db.from('accounting_journal_register').select('*').eq('company_entity_id',company.id).order('entry_date',{ascending:false}).order('kind').order('id').range(registerOffset,registerOffset+49));
    if(!registerOffset)el('registerTable').innerHTML=rows.length?'':'No journal entries yet. Review Transactions or create a journal entry.';
    el('registerTable').insertAdjacentHTML('beforeend',rows.length?table(['Date','Source','Description','Review','QBO delivery','Action'],rows.map(r=>`<tr><td>${esc(r.entry_date)}</td><td>${esc(r.source||r.kind)}</td><td>${esc(r.memo)}</td><td>${esc(r.status)}</td><td>${esc(r.posting_status||'Not sent')}</td><td>${registerActions(r)}</td></tr>`)):'');
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
    status(baseline?.status==='accepted'?`Opening balances accepted · Silo starts ${baseline.snapshot.accounting_start_date}.`:connections.length?'Fetch a trial balance, then review and accept your opening balances.':'Ask your company administrator to connect QuickBooks, then return here.');
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
    // Reports links here as "Journals"; a #surface hash opens that tab.
    // Before acceptance the work is Setup; after it, the ledger comes first.
    const surface=String(location.hash||'').slice(1)||(baseline?.status==='accepted'?'ledger':''),hashTab=/^[a-z]+$/.test(surface)?document.querySelector(`[data-surface="${surface}"]`):null;
    const linked=location.hash?hashTab:null;
    hashTab?.click();linked?.scrollIntoView?.({block:'start'});
    const openJournal=id=>window.SiloJE.open({db,companyId:company.id,context:'accounting:register',adjustmentId:id,onStaged:()=>work(()=>register(true)),onPosted:()=>work(()=>register(true))});
    el('newJournal').addEventListener('click',()=>openJournal());el('registerTable').addEventListener('click',e=>{const b=e.target.closest('[data-journal]');if(b){openJournal(b.dataset.journal);return;}
      const d=e.target.closest('[data-discard]');if(d){discardJournal(d.dataset.discard).catch(err=>status(`Could not discard: ${err.message}.`,true));return;}
      const v=e.target.closest('[data-void]');if(v)voidJournal(v.dataset.void,v.dataset.voidKind).catch(err=>status(`Void failed: ${err.message}.`,true));});el('more').addEventListener('click',()=>work(()=>register()));
    // The migration flow is read-only and self-contained: it must never delay
    // or disable the Books controls, and a failure in it degrades to a visible
    // "could not be read" rather than taking the page down.
    // The migration steps can fold to their headline; the choice is kept per
    // company in this browser, and the headline always stays on screen.
    const migrationKey='silo-books-migration:'+company.id;
    const setMigration=open=>{el('migrationBody').hidden=!open;el('migrationToggle').setAttribute('aria-expanded',String(open));el('migrationToggle').textContent=open?'Hide steps':'Show steps';
      try{localStorage.setItem(migrationKey,open?'open':'closed');}catch{}};
    try{if(localStorage.getItem(migrationKey)==='closed')setMigration(false);}catch{}
    el('migrationToggle').addEventListener('click',()=>setMigration(el('migrationBody').hidden));
    // It draws above the tabs, so a #register landing is re-scrolled once it has.
    window.SiloMigrationStatus?.mount({db,companyId:company.id}).catch(e=>{console.warn('Migration status unavailable:',e.message);}).finally(()=>linked?.scrollIntoView?.({block:'start'}));
    // Same rule for the ledger: read-only, and it degrades to its own message.
    window.SiloLedger?.mount({db,companyId:company.id,opening:baseline,settings:booksSettings,businessToday,el}).catch(e=>{el('ledgerTable').textContent=`The ledger could not be read: ${e.message}.`;});
    // History loading must not delay or disable the existing Books controls.
    window.SiloQboHistory?.mount({db,companyId:company.id}).catch(e=>{el('historyStatus').textContent=`History could not load: ${e.message}. Refresh saved history or contact your administrator.`;});
  }
  boot().catch(e=>{status(`${e.message}. Reload after the accounting foundation migration is applied, or contact your administrator.`,true);el('seedForm').inert=true;});
})();
