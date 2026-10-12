import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSpend,summarizeSpend,knownSpend,spendNote,SPEND_SOURCES} from '../../v2/silo-attribution-spend.js';
const company='00000000-0000-0000-0000-000000000001',period={start:'2026-09-01',end:'2026-09-30',currency:'USD'};
const synced=day=>Object.fromEntries(SPEND_SOURCES.map(s=>[s.channel,day]));

test('spend sums per channel; a source synced past the period with no rows is $0',()=>{
  const out=summarizeSpend({kpi:[{platform:'meta_ads',day_date:'2026-09-01',spend:'100.10'},{platform:'meta_ads',day_date:'2026-09-30',spend:200.2},{platform:'google_ads',day_date:'2026-09-02',spend:'5'}],
    redo:Array.from({length:1000},()=>({channel:'SMS',day_date:'2026-09-03',spend:0.0075,spend_currency:'USD'})),latest:synced('2026-10-08')},period);
  assert.equal(out.get('Meta Ads').cents,30030);assert.equal(out.get('Google Ads').cents,500);
  assert.equal(out.get('Redo SMS').cents,750,'fractional sending costs sum before rounding');
  assert.equal(out.get('TikTok Ads').cents,0);assert.equal(out.get('TikTok Ads').status,'complete');
  assert.equal(knownSpend(out).reduce((s,x)=>s+x.cents,0),31280);
});
test('never synced is unknown, not $0; synced short of the period is partial',()=>{
  const out=summarizeSpend({kpi:[{platform:'meta_ads',day_date:'2026-09-01',spend:10}],redo:[],latest:{...synced('2026-10-01'),'TikTok Ads':null,'Meta Ads':'2026-09-15'}},period);
  assert.equal(out.get('TikTok Ads').status,'not_connected');assert.equal(out.get('TikTok Ads').cents,null);
  assert.match(spendNote(out.get('TikTok Ads')),/No spend has synced/);
  assert.equal(out.get('Meta Ads').status,'partial');assert.equal(out.get('Meta Ads').cents,1000);assert.match(spendNote(out.get('Meta Ads')),/through 2026-09-15/);
  assert.ok(!knownSpend(out).some(s=>s.channel==='TikTok Ads'));
});
test('currency: ad spend needs a USD store; Redo rows in another currency are excluded',()=>{
  const raw={kpi:[{platform:'meta_ads',day_date:'2026-09-01',spend:10}],redo:[{channel:'EMAIL',day_date:'2026-09-01',spend:2,spend_currency:'CAD'},{channel:'EMAIL',day_date:'2026-09-01',spend:1,spend_currency:'USD'}],latest:synced('2026-10-01')};
  const cad=summarizeSpend(raw,{...period,currency:'CAD'});
  assert.equal(cad.get('Meta Ads').status,'currency');assert.equal(cad.get('Meta Ads').cents,null);
  assert.equal(cad.get('Redo Email').cents,200);assert.equal(cad.get('Redo Email').excluded,1);
  const usd=summarizeSpend(raw,period);assert.equal(usd.get('Redo Email').cents,100);assert.match(spendNote(usd.get('Redo Email')),/1 rows in another currency/);
});
test('invalid or out-of-period rows fail instead of skewing spend',()=>{
  assert.throws(()=>summarizeSpend({kpi:[{platform:'meta_ads',day_date:'2026-09-01',spend:'abc'}],latest:synced('2026-10-01')},period),/Invalid spend/);
  assert.throws(()=>summarizeSpend({kpi:[{platform:'meta_ads',day_date:'2026-10-01',spend:1}],latest:synced('2026-10-01')},period),/outside/);
});
test('loader scopes every query to the company, pages past 1,000 rows and surfaces errors',async()=>{
  const calls=[];
  const db=(fail)=>({from(table){const q={table,eq:{},range:null};const chain={select(){return chain;},eq(k,v){q.eq[k]=v;return chain;},in(){return chain;},gte(){return chain;},lte(){return chain;},order(){return chain;},
    limit(){calls.push(q);return Promise.resolve({data:[{day_date:'2026-10-01'}],error:null});},
    range(a,b){q.range=[a,b];calls.push(q);if(fail&&table==='redo_marketing_daily')return Promise.resolve({data:null,error:Error('denied')});
      // The server caps pages at 400 rows, below the 1,000 asked for.
      const total=table==='redo_marketing_daily'?1500:0,n=Math.max(0,Math.min(400,b-a+1,total-a));return Promise.resolve({data:Array.from({length:n},()=>({channel:'SMS',day_date:'2026-09-02',spend:1,spend_currency:'USD'})),error:null,count:total});}};return chain;}});
  const raw=await loadSpend(db(false),company,'2026-09-01','2026-09-30');
  assert.equal(raw.redo.length,1500);assert.deepEqual(calls.filter(c=>c.table==='redo_marketing_daily'&&c.range).map(c=>c.range[0]),[0,400,800,1200]);
  assert.ok(calls.length>0&&calls.every(c=>c.eq.company_entity_id===company));
  assert.equal(summarizeSpend(raw,period).get('Redo SMS').cents,150000);
  await assert.rejects(loadSpend(db(true),company,'2026-09-01','2026-09-30'),/denied/);
  await assert.rejects(loadSpend(db(false),'not-a-company','2026-09-01','2026-09-30'),/Invalid/);
  await assert.rejects(loadSpend(db(false),company,'2026-09-30','2026-09-01'),/Invalid/);
});
test('a row count that moves or a read that stops short fails instead of undercounting',async()=>{
  const db=(pagesOut)=>({from(table){const chain={select(){return chain;},eq(){return chain;},in(){return chain;},gte(){return chain;},lte(){return chain;},order(){return chain;},
    limit:()=>Promise.resolve({data:[],error:null}),range(a){const r=table==='redo_marketing_daily'?pagesOut(a):{data:[],count:0};return Promise.resolve({error:null,...r});}};return chain;}});
  const row={channel:'SMS',day_date:'2026-09-02',spend:1,spend_currency:'USD'};
  await assert.rejects(loadSpend(db(a=>({data:Array(400).fill(row),count:a?900:800})),company,'2026-09-01','2026-09-30'),/changed while loading/);
  await assert.rejects(loadSpend(db(a=>({data:a?[]:Array(400).fill(row),count:800})),company,'2026-09-01','2026-09-30'),/ended early/);
  await assert.rejects(loadSpend(db(()=>({data:[row],count:undefined})),company,'2026-09-01','2026-09-30'),/Unexpected/);
});
