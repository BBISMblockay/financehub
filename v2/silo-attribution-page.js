import {loadJourneyRecords} from './silo-attribution-overview.js';
import {loadSpend} from './silo-attribution-spend.js';
import {mountReport,loadRows} from './silo-attribution-report.js';
import {periodRange,matchPeriod} from './silo-attribution-period.js';
const cfg=window.__SILO_CONFIG__||{},root=document.querySelector('#attribution'),status=root.querySelector('#status');
function fail(message){status.textContent=message;status.className='bcn-status bcn-status--neg';status.hidden=false;}
async function boot(){
  if(!cfg.SUPABASE_URL||!cfg.SUPABASE_ANON_KEY)throw Error('Missing Supabase configuration');
  const db=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);
  const {data,error}=await db.auth.getSession();if(error)throw error;
  if(!data.session){window.location.href='/pages/login.html';return;}
  const company=await cfg.ensureActiveCompany?.(db);if(!company?.id)throw Error('Select an active company first');
  const profile=await db.from('profiles').select('role,active_company_id').eq('id',data.session.user.id).single();if(profile.error)throw profile.error;
  window.SiloChrome?.mount({appEl:'#silo-app',active:'reports/silo-attribution',user:{email:data.session.user.email,role:profile.data.role},crumbs:['Marketing','Performance','Attribution'],supabaseClient:db});
  function assertCompany(profileData){
   if(profileData?.active_company_id!==company.id || !window.SiloNav?.isSiloAttributionEnabled(company)){
     root.querySelector('#load').disabled=true;root.querySelector('#results').hidden=true;root.querySelector('#journey').close();
     root.querySelectorAll?.('#overview dialog[open]').forEach(d=>d.close());
     throw Error('Silo Attribution is available only in the Baseballism pilot workspace. Select that workspace and reload.');
   }
 }
 assertCompany(profile.data);
 async function withCompany(action){
   const check=async()=>{const current=await db.from('profiles').select('active_company_id').eq('id',data.session.user.id).single();if(current.error)throw current.error;assertCompany(current.data);};
   await check();const result=await action();await check();return result;
 }
  const {data:connected,error:storeError}=await db.from('shopify_connections').select('id,shop_domain,shop_name').eq('company_entity_id',company.id).eq('is_active',true).order('shop_domain');if(storeError)throw storeError;
  if(!connected.length)throw Error('No active Shopify stores');
  // One row per store the attribution sync has collected: its newest collected day, and how many
  // of those days carry money. The funded count is now only a FALLBACK for a workspace that has
  // not chosen its stores yet (below); `last_day` is still what dates the period. Aggregated in the database
  // because the day table grows without bound and the 1000-row page cap would otherwise start
  // dropping stores from this list silently.
  if(!/^[0-9a-f-]{36}$/i.test(company.id))throw Error('Invalid active company');
  const {data:collected,error:collectedError}=await db.rpc('chat_run_readonly_query',{query:`select connection_id, max(day) as last_day, count(*) filter (where total_cents <> 0 or net_cents <> 0) as funded_days from public.shopify_attribution_days where company_entity_id='${company.id}'::uuid group by connection_id`});
  if(collectedError)throw collectedError;
  if(!Array.isArray(collected))throw Error('Unexpected reporting result');
  const coverage=new Map(collected.map(row=>[row.connection_id,row]));
  // Which stores to offer. The workspace's own choice wins, from Workspace Settings
  // (company_settings.attribution_store_ids, 20261110024500). Feature-detected: before that
  // migration is applied the read 42703s and the page keeps its previous behaviour rather than
  // failing. An id whose store is gone or deactivated is dropped, so a stale setting cannot empty
  // the picker.
  const chosenRead=await db.from('company_settings').select('attribution_store_ids').eq('company_entity_id',company.id).maybeSingle();
  if(chosenRead.error && chosenRead.error.code!=='42703')throw chosenRead.error;
  const live=new Map(connected.map(store=>[store.id,store]));
  const chosen=(chosenRead.data?.attribution_store_ids||[]).map(id=>live.get(id)).filter(Boolean);
  // Empty means NOT CONFIGURED, never "no stores": fall back to every store that has collected
  // sales, then to every active store (a new workspace whose first sync has not run). A blank
  // report is never the right answer to a setting nobody has touched yet.
  const funded=connected.filter(store=>Number(coverage.get(store.id)?.funded_days||0)>0);
  const stores=chosen.length?chosen:funded.length?funded:connected;
  // Shopify's shop_name, refreshed on every connection Test, is the current name; several domains
  // are stale because a store moved. Show the name, keep the domain where it adds information.
  const label=store=>store.shop_name&&store.shop_name.trim()&&store.shop_name.trim()!==store.shop_domain
    ? store.shop_name.trim()+' ('+store.shop_domain.replace(/\.myshopify\.com$/,'')+')'
    : store.shop_domain;
  for(const store of stores){const option=document.createElement('option');option.value=store.id;option.textContent=label(store);root.querySelector('#store').append(option);}
  // One store to report on is not a choice: show what it is and stop asking.
  const picker=root.querySelector('#store').closest('label');
  if(stores.length===1&&picker){picker.hidden=true;
    const only=document.createElement('p');only.className='attr-context';only.id='onlystore';
    only.textContent='Reporting on '+label(stores[0])+'.';
    root.querySelector('.attr-controls').after(only);}
  const app=mountReport(root,{journeys:(orders,args)=>withCompany(()=>loadJourneyRecords(db,company.id,args.connectionId,orders)),spend:args=>withCompany(()=>loadSpend(db,company.id,args.start,args.end)),load:args=>withCompany(()=>loadRows(db,company.id,args.connectionId,args.start,args.end,args.windowDays)),evidence:row=>withCompany(async()=>{
    const {data,error}=await db.from('shopify_attribution_orders').select('evidence,fetched_at').eq('company_entity_id',company.id).eq('connection_id',row.connection_id).eq('order_id',row.order_id).single();if(error)throw error;return data;
  })});
  const params=new URLSearchParams(location.search);
  const requested=params.get('store'),selected=stores.some(s=>s.id===requested)?requested:stores[0].id;
  root.querySelector('#store').value=selected;
  // Dates follow the store that is actually selected; reading the first store's newest day dated
  // the period from a store the report was not about.
  const latest=coverage.get(selected)?.last_day;
  const yesterday=latest||new Date(Date.now()-86400000).toISOString().slice(0,10);root.querySelector('#end').value=yesterday;root.querySelector('#start').value=new Date(Date.parse(yesterday)-29*86400000).toISOString().slice(0,10);
  for(const id of ['start','end'])if(/^\d{4}-\d{2}-\d{2}$/.test(params.get(id)||''))root.querySelector('#'+id).value=params.get(id);
  if(['7','14','30','60'].includes(params.get('window')))root.querySelector('#window').value=params.get('window');
  // Date presets. Anchored on the selected store's newest COLLECTED day, not today, so a preset
  // never opens on days the sync has not reached. The control shows what the dates actually are,
  // including when they came from the URL, rather than asserting the default.
  const period=root.querySelector('#period'),startField=root.querySelector('#start'),endField=root.querySelector('#end');
  const anchor=()=>coverage.get(root.querySelector('#store').value)?.last_day||yesterday;
  period.value=matchPeriod(startField.value,endField.value,anchor());
  period.addEventListener('change',()=>{
    const range=periodRange(period.value,anchor());
    // 'Custom' changes no DATES -- it is what the other fields set themselves to -- but it does
    // change which controls are shown, so the fields come back before this returns.
    if(!range){showDates();return;}
    startField.value=range.start;endField.value=range.end;
    showDates();
    app.refresh();
  });
  // Typing a date is choosing a custom range, unless it happens to land on a preset.
  for(const field of [startField,endField])field.addEventListener('change',()=>{
    period.value=matchPeriod(startField.value,endField.value,anchor());
    showDates();
  });
  // The anchor is per store, so switching store has to re-anchor the dates. Leaving them alone
  // kept the previous store's period against a store collected through a different day, which
  // loadRows() REFUSES outright ('Some days have not been backfilled') rather than showing less,
  // while the control still claimed the old preset. An active preset follows the new store; a
  // custom range is kept as typed and only its label is recomputed, since the same dates can be a
  // preset for one store and custom for another.
  root.querySelector('#store').addEventListener('change',()=>{
    const range=periodRange(period.value,anchor());
    if(range){startField.value=range.start;endField.value=range.end;}
    else period.value=matchPeriod(startField.value,endField.value,anchor());
    showDates();
  });
  // From and To repeat what the preset just computed, so the bar stated the same range twice and
  // read as two competing controls. The fields belong to Custom; for a preset the dates are a
  // RESULT, shown as a line of text. Nothing is removed: choosing Custom brings the fields back
  // with the dates the preset left behind, so narrowing a preset is still two clicks.
  const fromLabel=startField.closest('label'),toLabel=endField.closest('label');
  const dateLine=document.createElement('p');dateLine.className='attr-context';dateLine.id='daterange';
  (root.querySelector('#onlystore')||root.querySelector('.attr-controls')).after(dateLine);
  const pretty=day=>/^\d{4}-\d{2}-\d{2}$/.test(day||'')
    ? new Date(Date.parse(day)).toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'})
    : day;
  function showDates(){
    const custom=period.value==='custom';
    if(fromLabel)fromLabel.hidden=!custom;
    if(toLabel)toLabel.hidden=!custom;
    dateLine.hidden=custom;
    dateLine.textContent=custom?'':pretty(startField.value)+' through '+pretty(endField.value);
  }
  showDates();
  await app.refresh();
}
boot().catch(e=>fail(e.message||String(e)));
