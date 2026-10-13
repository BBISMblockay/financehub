import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSpend,summarizeSpend,knownSpend,spendTotal,spendNote} from '../../v2/silo-attribution-spend.js';
const company='00000000-0000-0000-0000-000000000001',period={start:'2026-09-01',end:'2026-09-30',currency:'USD'};
const win=(job_type,startDate,endDate)=>({job_type,window:{startDate,endDate}});
const allJobs=['meta_ads_kpis','google_ads_kpis','tiktok_ads_kpis','redo_marketing'];
const fullWindows=allJobs.map(j=>win(j,'2026-08-31','2026-10-01'));
const attemptedAll=Object.fromEntries(allJobs.map(j=>[j,true]));
// What an admin sees: one connection per platform in use.
const admin={ads:[{id:'m',platform:'meta_ads'},{id:'g',platform:'google_ads'}],redo:[{id:'r'}]};

test('spend sums per channel; a fully synced source with no rows is $0',()=>{
  const out=summarizeSpend({kpi:[{platform:'meta_ads',day_date:'2026-09-01',spend:'100.10'},{platform:'meta_ads',day_date:'2026-09-30',spend:200.2},{platform:'google_ads',day_date:'2026-09-02',spend:'5'}],
    redo:Array.from({length:1000},()=>({channel:'SMS',day_date:'2026-09-03',spend:0.0075,spend_currency:'USD'})),windows:fullWindows,attempted:attemptedAll,connections:admin},period);
  assert.equal(out.get('Meta Ads').cents,30030);assert.equal(out.get('Google Ads').cents,500);
  assert.equal(out.get('Redo SMS').cents,750,'fractional sending costs sum before rounding');
  assert.equal(out.get('TikTok Ads').cents,0);assert.equal(out.get('TikTok Ads').status,'complete');
  const t=spendTotal(out);assert.equal(t.cents,31280);assert.equal(t.complete,true);
});
test('a later row does not prove the period was synced: history before the first sync is unknown, not $0',()=>{
  // Redo connected Oct 1: its only completed window starts after September.
  const out=summarizeSpend({redo:[],windows:[...allJobs.filter(j=>j!=='redo_marketing').map(j=>win(j,'2026-09-01','2026-09-30')),win('redo_marketing','2026-10-01','2026-10-10')],attempted:attemptedAll,connections:admin},period);
  for(const c of ['Redo Email','Redo SMS']){assert.equal(out.get(c).status,'unknown');assert.equal(out.get(c).cents,null);assert.match(spendNote(out.get(c)),/no completed sync covers/);}
  const t=spendTotal(out);assert.equal(t.complete,false);assert.deepEqual(t.gaps.map(g=>g.channel),['Redo Email','Redo SMS']);
});
test('a window covering part of the period is partial: subtotal kept, total not complete',()=>{
  const out=summarizeSpend({kpi:[{platform:'meta_ads',day_date:'2026-09-02',spend:100}],windows:[win('meta_ads_kpis','2026-08-20','2026-09-15'),...allJobs.slice(1).map(j=>win(j,'2026-09-01','2026-09-30'))],attempted:attemptedAll,connections:admin},period);
  const meta=out.get('Meta Ads');assert.equal(meta.status,'partial');assert.equal(meta.cents,10000);assert.equal(meta.covered,15);assert.match(spendNote(meta),/15 of 30 days/);
  const t=spendTotal(out);assert.equal(t.complete,false);assert.equal(t.anyKnown,true);assert.equal(t.cents,10000);
});
test('windows join: two runs that together cover the period make it complete',()=>{
  const out=summarizeSpend({windows:[win('meta_ads_kpis','2026-09-01','2026-09-14'),win('meta_ads_kpis','2026-09-15','2026-09-30')],attempted:attemptedAll,connections:admin},period);
  assert.equal(out.get('Meta Ads').status,'complete');assert.equal(out.get('Google Ads').status,'unknown');
});
test('all sources connected but none synced for the period: spend is unknown, not $0',()=>{
  const t=spendTotal(summarizeSpend({windows:[],attempted:attemptedAll,connections:admin},period));
  assert.equal(t.anyKnown,false);assert.equal(t.complete,false);assert.equal(t.gaps.length,5);
});
test('a source with no connection, run or rows is untracked and does not block the total',()=>{
  const out=summarizeSpend({windows:allJobs.filter(j=>j!=='tiktok_ads_kpis').map(j=>win(j,'2026-09-01','2026-09-30')),attempted:{...attemptedAll,tiktok_ads_kpis:false},connections:admin},period);
  assert.equal(out.get('TikTok Ads').status,'none');assert.equal(out.get('TikTok Ads').cents,null);assert.equal(spendTotal(out).complete,true);
  // A failed run alone still means connected: no rows is then unknown, never untracked.
  assert.equal(summarizeSpend({windows:[],attempted:{tiktok_ads_kpis:true},connections:admin},period).get('TikTok Ads').status,'unknown');
});
test('more than one connection cannot be confirmed from company-level windows',()=>{
  const fresh={platform:'meta_ads',day_date:'2026-09-02',spend:5,connection_id:'a'};
  const viaRows=summarizeSpend({kpi:[fresh,{...fresh,connection_id:'b'}],windows:fullWindows,attempted:attemptedAll,connections:admin},period).get('Meta Ads');
  assert.equal(viaRows.status,'unverified');assert.equal(viaRows.cents,1000);assert.match(spendNote(viaRows),/2 connections/);
  // A stale second connection with no rows is still seen when the connection list is readable.
  const viaList=summarizeSpend({kpi:[fresh],windows:fullWindows,attempted:attemptedAll,connections:{ads:[{id:'a',platform:'meta_ads'},{id:'b',platform:'meta_ads'}]}},period);
  assert.equal(viaList.get('Meta Ads').status,'unverified');assert.equal(spendTotal(viaList).complete,false);
});
test('a non-admin cannot see the connection list, so coverage fails closed: no return',()=>{
  // Meta has accounts A and B; only A has rows and a full window. RLS hides both
  // connection rows from a non-admin, which must not read as "one connection".
  const a={platform:'meta_ads',day_date:'2026-09-02',spend:5,connection_id:'a'};
  for(const connections of [{ads:null,redo:null},undefined]){
    const out=summarizeSpend({kpi:[a],windows:fullWindows,attempted:attemptedAll,connections},period);
    const meta=out.get('Meta Ads');assert.equal(meta.status,'unverified');assert.equal(meta.cents,500);assert.match(spendNote(meta),/Only admins can see the connection list/);
    const t=spendTotal(out);assert.equal(t.complete,false);assert.equal(t.anyKnown,true);
  }
  // The same data seen by an admin with both accounts listed is also unverified; with one, complete.
  assert.equal(summarizeSpend({kpi:[a],windows:fullWindows,attempted:attemptedAll,connections:{...admin,ads:[{id:'a',platform:'meta_ads'},{id:'b',platform:'meta_ads'}]}},period).get('Meta Ads').status,'unverified');
  assert.equal(summarizeSpend({kpi:[a],windows:fullWindows,attempted:attemptedAll,connections:{...admin,ads:[{id:'a',platform:'meta_ads'}]}},period).get('Meta Ads').status,'complete');
});
test('currency: ad spend needs a USD store; Redo rows in another currency are excluded',()=>{
  const raw={kpi:[{platform:'meta_ads',day_date:'2026-09-01',spend:10}],redo:[{channel:'EMAIL',day_date:'2026-09-01',spend:2,spend_currency:'CAD'},{channel:'EMAIL',day_date:'2026-09-01',spend:1,spend_currency:'USD'}],windows:fullWindows,attempted:attemptedAll,connections:admin};
  const cad=summarizeSpend(raw,{...period,currency:'CAD'});
  assert.equal(cad.get('Meta Ads').status,'currency');assert.equal(cad.get('Meta Ads').cents,null);
  assert.equal(cad.get('Redo Email').cents,200);assert.equal(cad.get('Redo Email').excluded,1);
  const usd=summarizeSpend(raw,period);assert.equal(usd.get('Redo Email').cents,100);assert.match(spendNote(usd.get('Redo Email')),/1 rows in another currency/);
  assert.ok(!knownSpend(cad).some(s=>s.channel==='Meta Ads'));
});
test('invalid or out-of-period rows fail instead of skewing spend',()=>{
  assert.throws(()=>summarizeSpend({kpi:[{platform:'meta_ads',day_date:'2026-09-01',spend:'abc'}],windows:fullWindows},period),/Invalid spend/);
  assert.throws(()=>summarizeSpend({kpi:[{platform:'meta_ads',day_date:'2026-10-01',spend:1}],windows:fullWindows},period),/outside/);
});

// Minimal PostgREST-shaped mock: every builder is thenable; range() pages; limit() ends.
function mockDb({fail=false,cap=400,redoTotal=1500,windows=fullWindows,isAdmin=true}={}){
  const calls=[];
  const db={calls,rpc:async name=>(calls.push({rpc:name}),name==='is_admin_user'?(isAdmin==='error'?{data:null,error:{message:'rpc failed'}}:{data:isAdmin,error:null}):{data:null,error:{message:'unexpected rpc'}}),from(table){const q={table,eq:{},filters:[],range:null};const rows=()=>table==='redo_marketing_daily'?Array.from({length:redoTotal},()=>({channel:'SMS',day_date:'2026-09-02',spend:1,spend_currency:'USD',connection_id:'r'})):table==='sync_jobs'?windows:[];
    const chain={select(){return chain;},eq(k,v){q.eq[k]=v;return chain;},in(){return chain;},gte(k,v){q.filters.push(['gte',k,v]);return chain;},lte(k,v){q.filters.push(['lte',k,v]);return chain;},order(){return chain;},
      limit(){calls.push(q);return Promise.resolve({data:table==='sync_jobs'?[{id:1}]:[],error:null});},
      range(a,b){q.range=[a,b];calls.push(q);if(fail&&table==='redo_marketing_daily')return Promise.resolve({data:null,error:Error('denied')});
        // The server caps pages below the 1,000 asked for.
        const all=rows(),n=Math.max(0,Math.min(cap,b-a+1,all.length-a));return Promise.resolve({data:all.slice(a,a+n),error:null,count:all.length});},
      then(resolve){calls.push(q);resolve(table==='ad_platform_connections'?{data:[{id:'m',platform:'meta_ads'}],error:null}:table==='redo_connections'?{data:[{id:'r'}],error:null}:{data:[],error:null});}};
    return chain;}};
  return db;
}
test('loader scopes every query to the company, pages past a server cap, reads completed windows and surfaces errors',async()=>{
  const db=mockDb(),raw=await loadSpend(db,company,'2026-09-01','2026-09-30');
  assert.equal(raw.redo.length,1500);assert.deepEqual(db.calls.filter(c=>c.table==='redo_marketing_daily'&&c.range).map(c=>c.range[0]),[0,400,800,1200]);
  assert.ok(db.calls.length>0&&db.calls.filter(c=>c.table).every(c=>c.eq.company_entity_id===company));
  const jobs=db.calls.find(c=>c.table==='sync_jobs'&&c.range);
  assert.equal(jobs.eq.status,'success');assert.deepEqual(jobs.filters,[['lte','result->window->>startDate','2026-09-30'],['gte','result->window->>endDate','2026-09-01']]);
  assert.deepEqual(raw.connections,{ads:[{id:'m',platform:'meta_ads'}],redo:[{id:'r'}]});
  // A non-admin's (RLS-empty) connection read is never trusted, or even made.
  const viewer=mockDb({isAdmin:false}),seen=await loadSpend(viewer,company,'2026-09-01','2026-09-30');
  assert.deepEqual(seen.connections,{ads:null,redo:null});assert.ok(!viewer.calls.some(c=>/connections$/.test(c.table||'')));
  assert.equal(summarizeSpend(seen,period).get('Redo SMS').status,'unverified');
  // If the admin check itself fails, the list is unknown too: fail closed.
  assert.deepEqual((await loadSpend(mockDb({isAdmin:'error'}),company,'2026-09-01','2026-09-30')).connections,{ads:null,redo:null});
  const out=summarizeSpend(raw,period);assert.equal(out.get('Redo SMS').cents,150000);assert.equal(out.get('Redo SMS').status,'complete');
  await assert.rejects(loadSpend(mockDb({fail:true}),company,'2026-09-01','2026-09-30'),/denied/);
  await assert.rejects(loadSpend(mockDb(),'not-a-company','2026-09-01','2026-09-30'),/Invalid/);
  await assert.rejects(loadSpend(mockDb(),company,'2026-09-30','2026-09-01'),/Invalid/);
});
test('a row count that moves or a read that stops short fails instead of undercounting',async()=>{
  const db=(pagesOut)=>({rpc:async()=>({data:true,error:null}),from(table){const chain={select(){return chain;},eq(){return chain;},in(){return chain;},gte(){return chain;},lte(){return chain;},order(){return chain;},
    limit:()=>Promise.resolve({data:[],error:null}),then(resolve){resolve({data:[],error:null});},range(a){const r=table==='redo_marketing_daily'?pagesOut(a):{data:[],count:0};return Promise.resolve({error:null,...r});}};return chain;}});
  const row={channel:'SMS',day_date:'2026-09-02',spend:1,spend_currency:'USD'};
  await assert.rejects(loadSpend(db(a=>({data:Array(400).fill(row),count:a?900:800})),company,'2026-09-01','2026-09-30'),/changed while loading/);
  await assert.rejects(loadSpend(db(a=>({data:a?[]:Array(400).fill(row),count:800})),company,'2026-09-01','2026-09-30'),/ended early/);
  await assert.rejects(loadSpend(db(()=>({data:[row],count:undefined})),company,'2026-09-01','2026-09-30'),/Unexpected/);
});
