(function(){
'use strict';
const M=window.SiloCashflow,cfg=window.__SILO_CONFIG__||{},el=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let db,company,today,data,model,userId,editing=null,busy=false,ready=false;
let filters={currency:'USD',selected:'all',unit:'week',group:'coa',horizon:3,lookback:90,trend:true};
const result=async q=>{const r=await q;if(r.error)throw r.error;return r.data;};
async function pages(table,fields,refine=q=>q){const rows=[];for(let offset=0;;offset+=500){const part=await result(refine(db.from(table).select(fields).eq('company_entity_id',company.id)).order('id').range(offset,offset+499));rows.push(...part);if(part.length<500)return rows;}}
const money=n=>n===null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:filters.currency,maximumFractionDigits:2}).format(n/100);
const short=d=>new Date(d+'T00:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});
const status=s=>{el('status').textContent=s;};
function persist(){try{localStorage.setItem('silo-cashflow:'+company.id,JSON.stringify(filters));}catch{}}
function restore(){try{const f=JSON.parse(localStorage.getItem('silo-cashflow:'+company.id)||'{}');for(const [key,allowed] of Object.entries({unit:['day','week','month'],group:['coa','cashflow'],horizon:[3,6],lookback:[30,90],trend:[true,false]}))if(allowed.includes(f[key]))filters[key]=f[key];if(/^[A-Z]{3}$/.test(f.currency))filters.currency=f.currency;if(typeof f.selected==='string')filters.selected=f.selected;}catch{}}
async function load(){
 if(busy||el('planDialog').open)return;busy=true;ready=false;el('refresh').disabled=true;el('add').disabled=true;status('Loading saved Plaid balances and transactions…');el('matrix').setAttribute('aria-busy','true');
 // Clear previous conclusions immediately: failed reloads must not look like fresh forecasts.
 el('summary').innerHTML='';el('matrix').innerHTML='';
 try{
  const active=await cfg.ensureActiveCompany(db);if(active?.id!==company.id)throw new Error('Company changed. Reload this page.');
  today=await result(db.rpc('silo_business_today'));if(!M.validDate(today))throw new Error('Company date is unavailable');
  const [accounts,connections,sources,chart,plans,settings]=await Promise.all([
   pages('plaid_accounts','id,connection_id,name,mask,type,subtype,iso_currency_code,current_balance,balance_updated_at,last_synced_at,source_id'),
   pages('plaid_connections','id,institution_name,status'),pages('card_sources','id,qbo_connection_id'),
   pages('quickbooks_accounts','id,qbo_account_id,name,fully_qualified_name,account_type,connection_id'),
   pages('cash_forecast_items','id,label,category,amount,kind,cadence,start_date,end_date,is_active,updated_at',q=>q.eq('is_active',true)),
   result(db.from('accounting_settings').select('base_currency').eq('company_entity_id',company.id).maybeSingle())]);
  const conn=new Map(connections.map(c=>[c.id,c]));accounts.forEach(a=>{a.connection_status=conn.get(a.connection_id)?.status||'disconnected';a.institution=conn.get(a.connection_id)?.institution_name||'';});
  const ids=accounts.filter(a=>a.type==='depository'&&a.connection_status!=='disconnected').map(a=>a.id),transactions=[];
  for(let i=0;i<ids.length;i+=100)transactions.push(...await pages('card_transactions','id,plaid_account_id,external_transaction_id,batch_id,txn_date,description,clean_merchant,amount,currency,origin,provider_status,status,qbo_account_id,qbo_account_name,accounting_treatment',q=>q.eq('origin','plaid').in('plaid_account_id',ids.slice(i,i+100)).gte('txn_date',M.addDays(today,-89)).lte('txn_date',today)));
  data={accounts,sources,chart,plans,transactions,baseCurrency:settings?.base_currency||'USD'};
  const currencies=[...new Set(accounts.filter(a=>a.type==='depository'&&a.connection_status!=='disconnected').map(a=>a.iso_currency_code).filter(c=>/^[A-Z]{3}$/.test(c)))].sort();
  if(!currencies.length)currencies.push(data.baseCurrency);if(!currencies.includes(filters.currency))filters.currency=currencies.includes(data.baseCurrency)?data.baseCurrency:currencies[0];
  el('currency').innerHTML=currencies.map(c=>`<option>${esc(c)}</option>`).join('');
  ready=true;render();status(`Saved Plaid data · company date ${today}. Refresh reloads the latest saved sync.`);
 }catch(e){status('Cashflow unavailable: '+e.message);el('accounts').innerHTML='';el('plans').innerHTML='';el('coverage').textContent='';el('planScope').textContent='';}
 finally{busy=false;el('refresh').disabled=false;el('matrix').setAttribute('aria-busy','false');}
}
function allCashBalance(){const balances=data.accounts.filter(a=>a.type==='depository'&&a.iso_currency_code===filters.currency&&a.connection_status!=='disconnected').map(a=>M.cents(a.current_balance));return balances.length&&balances.every(n=>n!==null)?balances.reduce((a,b)=>a+b,0):null;}
function render(){
 if(!ready)return;
 const scrollLeft=el('matrix').scrollLeft,scrollTop=el('matrix').scrollTop;
 if(filters.selected!=='all'&&!data.accounts.some(a=>a.id===filters.selected&&a.type==='depository'&&a.iso_currency_code===filters.currency&&a.connection_status!=='disconnected'))filters.selected='all';
 model=M.build({...data,...filters,today});persist();
 for(const key of ['currency','group','unit','horizon','lookback'])el(key).value=filters[key];el('trend').checked=filters.trend;
 el('accounts').innerHTML=`<button class="cf-account" data-account="all" aria-pressed="${filters.selected==='all'}">All cash accounts<strong>${money(allCashBalance())}</strong><small>${esc(filters.currency)} · saved current balances</small></button>`+data.accounts.map(a=>{
  const selectable=a.type==='depository'&&a.iso_currency_code===filters.currency&&a.connection_status!=='disconnected';
  const value=M.cents(a.current_balance),formatted=value===null?'—':/^[A-Z]{3}$/.test(a.iso_currency_code)?new Intl.NumberFormat('en-US',{style:'currency',currency:a.iso_currency_code}).format(value/100):'—';
  return `<button class="cf-account" data-account="${esc(a.id)}" aria-pressed="${filters.selected===a.id}" ${selectable?'':'disabled'}>${esc(a.name)} ${a.mask?'· '+esc(a.mask):''}<strong>${esc(formatted)}</strong><small>${esc(a.type==='depository'?'Cash':a.type+' · not cash')} · ${esc(a.connection_status)}</small><small>Balance as of ${esc(a.balance_updated_at?.slice(0,16).replace('T',' ')||'unknown')} UTC</small></button>`;
 }).join('');
 const end=model.ending.at(-1),stats=[['Saved cash balance',model.currentCash,`${model.cash.length} cash accounts · ${filters.currency}`],['Projected ending cash',end,short(model.futureEnd)],['Lowest projected cash',model.low,short(model.lowDate)],['Uncategorized activity',String(model.uncategorized),'Included in cash movements']];
 el('summary').innerHTML=stats.map(([label,value,note])=>`<div class="cf-stat"><small>${label}</small><strong class="${typeof value==='number'&&value<0?'cf-neg':''}">${typeof value==='string'?value:money(value)}</strong><span>${esc(note)}</span></div>`).join('');
 const first=model.cols.findIndex(c=>c.kind==='forecast');
 const cls=(c,i)=>`${c.kind==='forecast'?'cf-future':''} ${i===first?'cf-boundary':''}`;
 const total=(label,values)=>`<tr class="cf-total"><th scope="row">${label}</th>${model.cols.map((c,i)=>`<td class="${cls(c,i)} ${values[i]<0?'cf-neg':''}">${money(values[i])}</td>`).join('')}</tr>`;
 let body='';for(const direction of ['in','out']){body+=total(direction==='in'?'Money in':'Money out',direction==='in'?model.inflow:model.outflow);model.rows.forEach((r,index)=>{if(r.direction!==direction)return;body+=`<tr><th scope="row">${esc(r.label)}</th>${model.cols.map((c,i)=>{const amount=c.kind==='actual'?r.actual[i]:r.forecast[i];return `<td class="${cls(c,i)}"><button data-cell="${index}:${i}" aria-label="${esc(r.label+' '+c.start+' to '+c.end)}" title="${c.kind==='forecast'?esc('Trend '+money(r.trend[i])+' · planned '+money(r.planned[i])):'View bank movements'}">${money(amount)}</button></td>`;}).join('')}</tr>`;});}
 body+=total('Net cash movement',model.net)+total('Projected ending cash',model.ending);
 el('matrix').innerHTML=model.cash.length?`<table><thead><tr><th scope="col">${filters.group==='coa'?'COA bucket':'Cashflow category'}<small>${filters.currency}</small></th>${model.cols.map((c,i)=>`<th scope="col" class="${cls(c,i)}" ${i===first?'id="forecastStart"':''}>${short(c.start)}${c.end!==c.start?' – '+short(c.end):''}<small>${c.kind==='actual'?'Actual':'Forecast'} · ${c.start.slice(0,4)}</small></th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`:'<div class="cf-empty">Connect a Plaid checking or savings account to see cashflow. Credit cards and investments are outside cash balances.</div>';
 el('matrix').scrollLeft=scrollLeft;el('matrix').scrollTop=scrollTop;
 const days=model.coverage.map(c=>c.days);el('coverage').textContent=`${model.postedCount} posted movements · ${model.pending} pending omitted · ${model.excluded} excluded from coding included. Trend history: ${days.length?Math.min(...days)+'–'+Math.max(...days)+' completed days':'none'}${days.some(d=>d<30)?' · Limited history':''}.`;
 el('add').disabled=!model.companyPlans||!model.cash.length;el('planScope').textContent=`Company plans · ${data.baseCurrency}${model.companyPlans?'':' · switch to All cash accounts / '+data.baseCurrency+' to include and edit'}`;
 el('plans').innerHTML=data.plans.length?data.plans.map(p=>`<div class="cf-plan"><span>${esc(p.label)}<small>${esc(categoryName(p.category))} · ${esc(p.kind==='recurring'?p.cadence:'One-time')} · ${esc(p.start_date)}${p.end_date?' → '+esc(p.end_date):''}</small></span><b>${esc(new Intl.NumberFormat('en-US',{style:'currency',currency:data.baseCurrency}).format(Number(p.amount)))}</b><button class="bcn-btn" data-plan="${esc(p.id)}" ${model.companyPlans?'':'disabled'}>Edit</button></div>`).join(''):'<p class="cf-empty">Add known payments and receipts to shape the forecast.</p>';
}
function categoryName(key){return M.catalog(data.chart).get(key)?.name||(key==='uncategorized'?'Uncategorized':key?.startsWith('flow|')?key.slice(5):key?.startsWith('coa|')?'Saved COA bucket':key||'Planning');}
function openPlan(id){
 if(!ready||!model.companyPlans)return;editing=data.plans.find(p=>p.id===id)||null;
 const options=[['uncategorized','Uncategorized'],...['Operating','Investing','Financing','Transfers'].map(s=>['flow|'+s,s+' (cashflow category)']),...[...M.catalog(data.chart)].map(([key,c])=>[key,c.name])];
 if(editing?.category&&!options.some(o=>o[0]===editing.category))options.push([editing.category,categoryName(editing.category)]);
 el('category').innerHTML=options.map(([key,label])=>`<option value="${esc(key)}">${esc(label)}</option>`).join('');
 el('planTitle').textContent=editing?'Edit planned movement':'Add planned movement';el('label').value=editing?.label||'';el('category').value=editing?.category||'uncategorized';el('direction').value=Number(editing?.amount)>0?'in':'out';el('amount').value=editing?Math.abs(Number(editing.amount)):'';el('kind').value=editing?.kind||'one_time';el('cadence').value=editing?.cadence||'monthly';el('start').value=editing?.start_date||model.futureStart;el('end').value=editing?.end_date||'';el('archive').hidden=!editing;el('planError').textContent='';kindChanged();el('planDialog').showModal();
}
function kindChanged(){const one=el('kind').value==='one_time';el('cadence').disabled=one;el('end').disabled=one;}
async function save(archive=false){
 if(busy)return;const start=el('start').value,end=el('kind').value==='recurring'?el('end').value||null:null,amount=Number(el('amount').value);
 if(!archive&&(!el('label').value.trim()||!M.validDate(start)||(end&&(!M.validDate(end)||end<start))||!Number.isFinite(amount)||amount<=0)){el('planError').textContent='Enter a name, positive amount and valid date range.';return;}
 busy=true;for(const button of el('planForm').querySelectorAll('button'))button.disabled=true;
 try{
  const current=await cfg.ensureActiveCompany(db);if(current?.id!==company.id)throw new Error('Company changed. Reload this page before saving.');
  const payload=archive?{is_active:false}:{label:el('label').value.trim(),category:el('category').value,amount:(el('direction').value==='out'?-1:1)*Math.round(amount*100)/100,kind:el('kind').value,cadence:el('kind').value==='recurring'?el('cadence').value:null,start_date:start,end_date:end};
  payload.updated_at=new Date().toISOString();payload.updated_by=userId;
  if(editing){let query=db.from('cash_forecast_items').update(payload).eq('company_entity_id',company.id).eq('id',editing.id);if(editing.updated_at)query=query.eq('updated_at',editing.updated_at);await result(query.select('id').single());}
  else await result(db.from('cash_forecast_items').insert({...payload,company_entity_id:company.id}).select('id').single());
  el('planDialog').close();busy=false;await load();
 }catch(e){el('planError').textContent='Could not save plan: '+e.message;}
 finally{busy=false;for(const button of el('planForm').querySelectorAll('button'))button.disabled=false;}
}
function detail(cell){const [r,i]=cell.split(':').map(Number),row=model.rows[r],col=model.cols[i];if(!row||!col)return;el('detailTitle').textContent=row.label+' · '+short(col.start)+' – '+short(col.end);el('detailBody').innerHTML=col.kind==='actual'?(row.transactions[i].map(t=>`<div class="cf-plan"><span>${esc(t.clean_merchant||t.description)}<small>${esc(t.txn_date)} · ${esc(t.category)}</small></span><b>${money(t.movement)}</b>${t.batch_id?`<a href="transactions.html?batch=${encodeURIComponent(t.batch_id)}&amp;company=${encodeURIComponent(company.id)}">Review</a>`:''}</div>`).join('')||'<p>No posted movements in this cell.</p>'):`<p>Bank trend: ${money(row.trend[i])}</p><p>Planned movements: ${money(row.planned[i])}</p><p>Projected total: ${money(row.forecast[i])}</p>`;el('detailDialog').showModal();}
async function boot(){
 if(!cfg.SUPABASE_URL||!cfg.SUPABASE_ANON_KEY)throw new Error('Missing application configuration');db=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);
 const session=await result(db.auth.getSession());if(!session.session){location.href='/pages/login.html?next='+encodeURIComponent(location.pathname);return;}
 userId=session.session.user.id;company=await cfg.ensureActiveCompany(db);if(!company?.id)throw new Error('Select a company first');
 const [finance,executive]=await Promise.all([result(db.rpc('can_manage_journal_entries')),result(db.rpc('is_exec_or_owner'))]);if(!finance&&!executive)throw new Error('Finance access is required');
 window.SiloChrome?.mount({appEl:'#silo-app',active:'finance/cash-forecast',user:{email:session.session.user.email},crumbs:['Accounting','Cashflow'],supabaseClient:db});restore();
 el('refresh').addEventListener('click',load);el('add').addEventListener('click',()=>openPlan());
 el('controls').addEventListener('change',e=>{const key=e.target.id;if(!Object.hasOwn(filters,key)||!ready)return;filters[key]=key==='trend'?e.target.checked:['horizon','lookback'].includes(key)?Number(e.target.value):e.target.value;render();});
 el('accounts').addEventListener('click',e=>{const button=e.target.closest('[data-account]');if(button&&!button.disabled&&ready){filters.selected=button.dataset.account;render();}});
 el('plans').addEventListener('click',e=>{const button=e.target.closest('[data-plan]');if(button&&!button.disabled)openPlan(button.dataset.plan);});
 el('matrix').addEventListener('click',e=>{const button=e.target.closest('[data-cell]');if(button&&ready)detail(button.dataset.cell);});
 el('jump').addEventListener('click',()=>{const start=el('forecastStart');if(start)el('matrix').scrollLeft=Math.max(0,start.offsetLeft-230);});
 document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>{if(!busy)el(b.dataset.close).close();}));el('kind').addEventListener('change',kindChanged);el('planForm').addEventListener('submit',e=>{e.preventDefault();save();});el('archive').addEventListener('click',()=>save(true));el('planDialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')load();});await load();
}
boot().catch(e=>status('Cashflow unavailable: '+e.message));
})();
