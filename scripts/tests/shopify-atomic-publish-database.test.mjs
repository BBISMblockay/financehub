// Executes real importer wiring and SQL RPC in one embedded PGlite session.
// This is NOT separate-backend visibility/concurrency verification.
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {PGlite} from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import {scopesMissingForJob} from '../lib/shopify-scopes.mjs';
import {publishIncrementalWindow,ordersToOrderRows,ordersToSalesRows,compactIncrementalRows} from '../lib/shopify-sync-core.mjs';
const root=new URL('./',import.meta.url),read=p=>fs.readFileSync(new URL(p,root),'utf8');
const NOW='2026-10-10T12:00:00Z';
const source=read('../lib/shopify-sync-core.mjs');
let migration=read('../../supabase/migrations/20261013080000_shopify_atomic_incremental_publish.sql');
const mutation=process.env.SHOPIFY_ATOMIC_MUTATION;
if(mutation==='keep-lines') migration=migration.replace('delete from public.shopify_order_lines where','delete from public.shopify_order_lines where false and');
if(mutation==='keep-sales') migration=migration.replace('delete from public.sales_by_day where','delete from public.sales_by_day where false and');
if(mutation==='public-execute') migration=migration.replace(/revoke all on function[^;]+;/,'');
if(mutation&&!['keep-lines','keep-sales','public-execute'].includes(mutation)) throw Error('Unknown mutation');
const companyA='81000000-0000-4000-8000-000000000001',companyB='81000000-0000-4000-8000-000000000002';
const stores=[1,2,3].map(n=>({id:`82000000-0000-4000-8000-00000000000${n}`,company_entity_id:n===3?companyB:companyA,shop_domain:`synthetic-barrier-${n}.myshopify.com`,access_token:'synthetic-only',api_version:'2025-01',meta:{last_order_sync_at:'2026-10-10T11:00:00Z'},scopes_granted:['read_orders','read_products','read_locations']}));
function orders(epoch=0,price=10){return Array.from({length:600},(_,i)=>{const o={id:10000+i,name:'#SYN-'+i,created_at:'2026-10-07T18:00:00Z',processed_at:'2026-10-07T18:00:00Z',updated_at:NOW,source_name:'web',financial_status:'paid',currency:'USD',tags:'REUSED-TAG',location_id:1,total_price:String(price),subtotal_price:String(price),payment_terms:null,line_items:[{id:50000+i,product_id:i,variant_id:i,sku:'SKU-'+i,title:'Synthetic '+i,quantity:1,price:String(price),tax_lines:[],discount_allocations:[]}]};if(i===4){o.line_items[0].quantity=2;o.total_price=o.subtotal_price=String(price*2);}if(epoch){if(i===0){o.line_items[0].quantity=2;o.total_price=o.subtotal_price=String(price*2);}if(i===1)o.line_items=[];if(i===2)o.cancelled_at='2026-10-10T10:00:00Z';if(i===3)o.line_items[0].gift_card=true;if(i===4){o.financial_status='partially_refunded';o.refunds=[{id:9001,processed_at:'2026-10-08T18:00:00Z',created_at:'2026-10-08T18:00:00Z',refund_line_items:[{line_item_id:50004,quantity:1,subtotal:'2.00',total_tax:'0.00'}]},{id:9002,processed_at:'2026-10-09T18:00:00Z',created_at:'2026-10-09T18:00:00Z',refund_line_items:[{line_item_id:50004,quantity:1,subtotal:'3.00',total_tax:'0.00'}]}];}}return o;});}
function provider(c,epoch,trace){return async(raw,opts)=>{const u=new URL(raw);assert.equal(u.hostname,c.shop_domain);assert.equal(opts.headers['X-Shopify-Access-Token'],'synthetic-only');const name=u.pathname.split('/').at(-1).replace('.json','');let rows=[];
 if(name==='locations')rows=[{id:1,name:'Warehouse'}];else if(name==='variants')rows=Array.from({length:600},(_,i)=>({id:i,product_id:i,sku:'SKU-'+i,price:'10.00'}));else if(name==='products')rows=u.searchParams.get('status')==='active'?Array.from({length:600},(_,i)=>({id:i,title:'Synthetic '+i,product_type:'Fixture',vendor:'Synthetic'})):[];else if(name==='orders'){rows=orders(epoch,c===stores[2]?30:10);const min=u.searchParams.get('created_at_min'),max=u.searchParams.get('created_at_max');if(min)rows=rows.filter(o=>o.created_at>=min&&o.created_at<=max);}else throw Error('UNEXPECTED_PROVIDER');
 const page=Number(u.searchParams.get('page_info')||0),offset=page*250,out=rows.slice(offset,offset+250),headers={};if(offset+250<rows.length){const next=new URL(u);next.searchParams.set('page_info',String(page+1));headers.link=`<${next}>; rel="next"`;}
 trace.push({resource:name,path:u.pathname,query:Object.fromEntries(u.searchParams),returned:out.length,kind:name==='orders'?(u.searchParams.has('updated_at_min')?'touched':'whole_day_refetch'):name});return Response.json({[name]:out},{headers});};}

const db = new PGlite();
const q = async (sql, params=[]) => (await db.query(sql, params)).rows;
let count=0, lastArgs, failRpc=false, loseResponse=false;
const captured=[], traces=[];
async function test(name, fn) { await fn(); console.log(`ok ${++count} - ${name}`); }
async function publish(a, role='service_role') {
  assert.ok(['service_role','anon','authenticated'].includes(role));
  await db.exec(`set role ${role}`);
  try{return (await q('select public.shopify_publish_incremental_window($1,$2,$3,$4,$5,$6,$7,$8,$9) result',
    [a.p_connection_id,a.p_company_entity_id,a.p_shop_domain,a.p_start,a.p_end,
      JSON.stringify(a.p_orders),JSON.stringify(a.p_lines),JSON.stringify(a.p_sales),JSON.stringify(a.p_metadata)]))[0].result;
  }finally{await db.exec('reset role');}
}
function client(c) {
  return {
    from(table) {
      assert.ok(['locations','shopify_location_mappings'].includes(table), 'no non-atomic persistence');
      let scoped=false;
      return {select(){return this;},eq(k,v){assert.equal(k,'company_entity_id');assert.equal(v,c.company_entity_id);scoped=true;return this;},not(){return this;},then(ok,bad){assert.ok(scoped);return Promise.resolve({data:table==='locations'?[{location_code:'warehouse',location_name:'Warehouse',shopify_location_id:'1'}]:[],error:null}).then(ok,bad);}};
    },
    async rpc(name,args) {
      assert.equal(name,'shopify_publish_incremental_window');
      lastArgs=structuredClone(args); captured.push(lastArgs);
      if(failRpc) return {error:{message:'function does not exist'}};
      const data=await publish(args);
      if(loseResponse){loseResponse=false;throw Error('SIMULATED_RESPONSE_LOSS');}
      return {data,error:null};
    },
  };
}
async function run(c, epoch, fetchOverride=null) {
  const trace=[];
  class FixedDate extends Date {constructor(...a){super(...(a.length?a:[NOW]));}static now(){return Date.parse(NOW);}}
  const syntheticFetch=provider(c,epoch,trace);
  const ctx={crypto,scopesMissingForJob,fetch:fetchOverride?((url,opts)=>fetchOverride(url,opts,syntheticFetch)):syntheticFetch,URL,Response,AbortSignal,setTimeout,clearTimeout,Buffer,Date:FixedDate,console};
  vm.runInNewContext(source.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nglobalThis.entry=runIncrementalSales;',ctx);
  try{return await ctx.entry(client(c),c,{batchId:'synthetic-atomic',daysBack:2});}
  finally{traces.push(trace);}
}
async function snapshot(company=companyA) {
  const sales=await q('select day_date::text as day,sum(total_net_sales)::text net from sales_by_day where company_entity_id=$1 group by day_date order by day_date',[company]);
  const facts=(await q('select count(*)::int orders,count(*) filter(where cancelled_at is null)::int noncancelled from shopify_orders where company_entity_id=$1',[company]))[0];
  const lines=(await q('select count(*)::int n from shopify_order_lines where company_entity_id=$1 and shop_domain=$2',[company,stores[0].shop_domain]))[0].n;
  return {sales,facts,lines};
}
async function untouched() {
  const all={};
  for(const t of ['shopify_orders','shopify_order_lines','sales_by_day']) all[t]=await q(`select to_jsonb(t) r from ${t} t where shop_domain <> $1 order by to_jsonb(t)::text`,[stores[0].shop_domain]);
  return JSON.stringify(all);
}
try {
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(read('shopify-atomic-fixture.sql'));
  await db.exec(migration);
  await db.exec(migration);
  await q('insert into entities values($1),($2)',[companyA,companyB]);
  for(const c of stores) await q("insert into shopify_connections(id,company_entity_id,shop_domain,access_token) values($1,$2,$3,'synthetic-only')",[c.id,c.company_entity_id,c.shop_domain]);
  // Fixture service role gets the existing table/sequence privileges it needs;
  // the production migration grants only execution, not new table access.
  await db.exec('grant usage on schema public to service_role,anon,authenticated; grant all on all tables in schema public to service_role; grant all on all sequences in schema public to service_role;');
  await test('migration is repeatable and execution restricted to service_role',async()=>{
    const sig='public.shopify_publish_incremental_window(uuid,uuid,text,date,date,jsonb,jsonb,jsonb,jsonb)';
    for(const role of ['anon','authenticated']) assert.equal((await q('select has_function_privilege($1,$2,\'EXECUTE\') ok',[role,sig]))[0].ok,false);
    assert.equal((await q('select has_function_privilege(\'service_role\',$1,\'EXECUTE\') ok',[sig]))[0].ok,true);
    assert.equal((await q('select prosecdef from pg_proc where oid=$1::regprocedure',[sig]))[0].prosecdef,false);
  });
  await test('real incremental wiring, 600-order pagination and independent initial ledger',async()=>{
    for(const c of stores) await run(c,0);
    assert.deepEqual(await snapshot(),{sales:[{day:'2026-10-07',net:'12020'}],facts:{orders:1200,noncancelled:1200},lines:600});
    assert.equal(traces[0].filter(t=>t.kind==='touched').length,3);
    assert.ok(captured.some(a=>a.p_orders.length===600&&a.p_lines.length===600));
  });
  const untouchedBefore=await untouched();
  await test('changed/removed/cancelled/giftcard/repeated-refund ledger and scoped replacement',async()=>{
    const result=await run(stores[0],1);
    assert.deepEqual(await snapshot(),{sales:[{day:'2026-10-07',net:'12010'},{day:'2026-10-08',net:'-2'},{day:'2026-10-09',net:'-3'}],facts:{orders:1200,noncancelled:1199},lines:599});
    assert.equal(await untouched(),untouchedBefore);
    assert.ok(result.last_order_sync_at);
    console.log(`measured max_publish_bytes=${result.max_publish_bytes}`);
  });
  const changed=await snapshot();
  const args=structuredClone(captured.findLast(a=>a.p_orders.length===600));
  await test('anon and authenticated cannot actually invoke publication',async()=>{
    for(const role of ['anon','authenticated']) await assert.rejects(()=>publish(args,role),/permission denied/);
  });
  await test('malformed touched/refetch page never publishes a partial or empty replacement',async()=>{
    for(const phase of ['touched','refetch']) {
      const before=captured.length;
      await assert.rejects(()=>run(stores[0],1,(raw,opts,next)=>{
        const u=new URL(raw);
        if(u.pathname.endsWith('/orders.json') && (phase==='touched'?u.searchParams.has('updated_at_min'):u.searchParams.has('created_at_min')))return Response.json({orders:null});
        return next(raw,opts);
      }),/refusing incomplete replacement/);
      assert.equal(captured.length,before);assert.deepEqual(await snapshot(),changed);
    }
  });
  await test('identical replay and lost-response retry converge',async()=>{
    await run(stores[0],1); assert.deepEqual(await snapshot(),changed);
    loseResponse=true; await assert.rejects(()=>run(stores[0],1),/SIMULATED_RESPONSE_LOSS/);
    await run(stores[0],1); assert.deepEqual(await snapshot(),changed);
  });
  await test('RPC missing fails closed, returns no success/watermark, no fallback writes',async()=>{
    failRpc=true;
    try{await assert.rejects(()=>run(stores[0],0),/no non-atomic fallback/);}finally{failRpc=false;}
    assert.deepEqual(await snapshot(),changed);
  });
  await test('deletion and intermediate insertion errors roll back all tables',async()=>{
    const baseline=await snapshot();
    for(const [table,event] of [['sales_by_day','delete'],['shopify_orders','insert'],['shopify_order_lines','insert']]) {
      await db.exec(`create function fail_atomic_test() returns trigger language plpgsql as $$ begin raise exception 'INJECTED_FAILURE'; end $$;
        create trigger fail_atomic_test after ${event} on ${table} for each statement execute function fail_atomic_test();`);
      try{await assert.rejects(()=>publish(args),/INJECTED_FAILURE/);assert.deepEqual(await snapshot(),baseline);assert.equal(await untouched(),untouchedBefore);}
      finally{await db.exec(`drop trigger fail_atomic_test on ${table}; drop function fail_atomic_test();`);}
    }
    const bad=structuredClone(args);bad.p_lines[550].quantity='bad-integer';
    await assert.rejects(()=>publish(bad),/integer/);assert.deepEqual(await snapshot(),baseline);
  });
  await test('paid fields preserve absence and clear explicit null',async()=>{
    await q("update shopify_orders set paid_at='2026-10-06T12:00Z' where shop_domain=$1",[stores[0].shop_domain]);
    await publish(args);
    assert.equal((await q('select count(paid_at)::int n from shopify_orders where shop_domain=$1',[stores[0].shop_domain]))[0].n,600);
    const a=structuredClone(args);a.p_orders[0].paid_at=null;a.p_orders[0].paid_at_checked_at=NOW;
    await publish(a);
    assert.equal((await q('select count(paid_at)::int n from shopify_orders where shop_domain=$1',[stores[0].shop_domain]))[0].n,599);
  });
  await test('late source collision after validation aborts the whole publication',async()=>{
    const before=await snapshot();
    await q("select set_config('test.row_hash',$1,false),set_config('test.company',$2,false),set_config('test.shop',$3,false)",
      [args.p_sales.find(s=>s.total_orders>0).row_hash,companyA,stores[0].shop_domain]);
    await db.exec(`create function inject_source_collision() returns trigger language plpgsql as $$ begin
      insert into public.sales_by_day(company_entity_id,shop_domain,source,row_hash,day_date,total_orders,total_net_sales)
      values(current_setting('test.company')::uuid,current_setting('test.shop'),'better_reports',current_setting('test.row_hash'),'2026-10-07',1,123);
      return null; end $$;
      create trigger inject_source_collision after insert on shopify_orders for each statement execute function inject_source_collision();`);
    try{await assert.rejects(()=>publish(args),/Concurrent Shopify ownership collision/);assert.deepEqual(await snapshot(),before);}
    finally{await db.exec('drop trigger inject_source_collision on shopify_orders;drop function inject_source_collision();');}
  });
  await test('invalid connection, tenant, shop, sales source, columns and orphan lines reject',async()=>{
    const mutations=[a=>a.p_connection_id=stores[1].id,a=>a.p_company_entity_id=companyB,a=>a.p_shop_domain=stores[1].shop_domain,a=>a.p_orders[0].company_entity_id=companyB,a=>a.p_sales[0].source='better_reports',a=>a.p_orders[0].id=99,a=>a.p_lines[0].order_id='missing',a=>a.p_sales[0].day_date='2020-01-01',a=>a.p_orders.push(a.p_orders[0])];
    const baseline=await snapshot();
    for(const mutate of mutations){const a=structuredClone(args);mutate(a);await assert.rejects(()=>publish(a));assert.deepEqual(await snapshot(),baseline);}
    assert.equal(await untouched(),untouchedBefore);
  });
  await test('valid empty window removes positive sales only and preserves refund/history facts',async()=>{
    const empty={...args,p_orders:[],p_lines:[],p_sales:[]};
    assert.deepEqual(await publish(empty),{orders_upserted:0,order_lines_upserted:0,sales_rows_upserted:0});
    assert.deepEqual((await snapshot()).sales,[{day:'2026-10-07',net:'6010'},{day:'2026-10-08',net:'-2'},{day:'2026-10-09',net:'-3'}]);
    assert.equal((await snapshot()).lines,599);assert.equal(await untouched(),untouchedBefore);
  });
  await test('SQL payload count bound refuses before writes',async()=>{
    const a={...args,p_orders:Array(10001).fill(args.p_orders[0])};
    const before=await snapshot();await assert.rejects(()=>publish(a),/exceeds limit/);assert.deepEqual(await snapshot(),before);
  });
  await test('caller byte limit refuses before RPC rather than splitting the window',async()=>{
    let called=false;
    const huge=orders(0).slice(0,1);huge[0].line_items[0].title='x'.repeat(17*1024*1024);
    await assert.rejects(()=>publishIncrementalWindow({rpc(){called=true;}},stores[0],{
      start:'2026-10-07',end:'2026-10-07',orders:huge,skuMeta:new Map(),syncedAt:NOW,
      batchId:'synthetic',salesRows:[],headers:{},base:'https://synthetic.invalid',
    }),/exceeds publish limit/);
    assert.equal(called,false);
  });
  await test('compaction preserves every serialized key, absent/null batch and mixed paid fields',async()=>{
    for(const batchId of [undefined,null,'']) {
      const input={orders:orders(0).slice(0,2),connection:stores[0],skuMeta:new Map(),syncedAt:NOW,batchId};
      const {orderRows,lineRows}=ordersToOrderRows(input);
      orderRows[0].paid_at=null;orderRows[0].paid_at_checked_at=NOW;
      const {salesRows}=ordersToSalesRows({...input,locationMap:new Map()});
      const compact=JSON.parse(JSON.stringify(compactIncrementalRows(orderRows,lineRows,salesRows)));
      for(const [name,rows] of [['orders',orderRows],['lines',lineRows],['sales',salesRows]]) {
        assert.deepEqual(compact['p_'+name].map(row=>({...row,...compact.p_metadata[name]})),JSON.parse(JSON.stringify(rows)));
      }
      assert.equal(Object.hasOwn(compact.p_orders[1],'paid_at'),false);
      assert.equal(compact.p_orders[0].paid_at,null);
      assert.equal(Object.hasOwn(compact.p_metadata.sales,'sync_batch_id'),batchId!==undefined);
    }
  });
  await test('metadata ownership, scalar shape, override and expansion guards reject before mutation',async()=>{
    const before=await snapshot();
    for(const mutate of [
      a=>a.p_metadata.orders.company_entity_id=companyB,
      a=>a.p_metadata.lines.connection_id=stores[1].id,
      a=>a.p_metadata.sales.shop_domain=stores[1].shop_domain,
      a=>a.p_metadata.orders.admin=true,
      a=>a.p_metadata.orders.sync_batch_id={nested:'invalid'},
      a=>a.p_orders[0].synced_at=NOW,
      a=>a.p_metadata.orders.sync_batch_id='x'.repeat(1000000),
    ]) {
      const a=structuredClone(args);mutate(a);await assert.rejects(()=>publish(a));assert.deepEqual(await snapshot(),before);
    }
  });
  console.log(`${count} tests passed; embedded serial PGlite only; separate PostgreSQL reader sessions NOT verified`);
} catch(error) {console.error(error);process.exitCode=1;} finally {await db.close();}
