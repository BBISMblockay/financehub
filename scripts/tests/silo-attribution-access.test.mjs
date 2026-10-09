import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const base=new URL('../../',import.meta.url);
const navSource=await readFile(new URL('v2/nav-config.js',base),'utf8');
const pageSource=(await readFile(new URL('v2/silo-attribution-page.js',base),'utf8')).replace(/^import[^\n]+\n/gm,'').replace('boot().catch(e=>fail(e.message||String(e)));','globalThis.start=boot;');
const bb={id:'3bd934c9-4cdd-429b-9076-f8f6b45d4eb7',entity_key:'baseballism'};
const other={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',meta:{nav_profile:'grandfathered'}};
function nav(){const w={};new Function('window',navSource)(w);return w.SiloNav;}
const visible=(n,c)=>n.navSectionsForCompany(c).some(s=>s.items.some(i=>i.id==='reports/silo-attribution'));
test('navigation requires exact Baseballism ID and non-standard resolved profile',()=>{
 const n=nav();assert.equal(visible(n,bb),true);
 for(const c of [other,null,{}, {...bb,meta:{nav_profile:'standard'}},{...bb,_staleReconcile:true}])assert.equal(visible(n,c),false);
 assert.equal(n.navSectionsForProfile('grandfathered').some(s=>s.items.some(i=>i.id==='reports/silo-attribution')),false);
 assert.equal(visible(n,other),false);assert.equal(visible(n,bb),true);
});
function harness(company=bb,active=company?.id){
 let activeId=active,callbacks,reads=0,profileError=null,afterLoad=()=>{};
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:true,value:'',append(){},close(){}});return nodes.get(id);};
 const db={auth:{getSession:async()=>({data:{session:{user:{id:'user'}}}})},from(table){const q={select(){return q;},eq(){return q;},order(){return table==='shopify_connections'?Promise.resolve({data:[{id:'store',shop_domain:'baseballism'}]}):q;},limit:async()=>({data:[{day:'2026-09-30'}]}),single:async()=>table==='profiles'?{data:{active_company_id:activeId,role:'admin'},error:profileError}:{data:{evidence:{}}}};return q;}};
 const w={SiloNav:nav(),__SILO_CONFIG__:{SUPABASE_URL:'test',SUPABASE_ANON_KEY:'test',SILO_ATTRIBUTION_ENABLED:true,ensureActiveCompany:async()=>company},supabase:{createClient:()=>db}};
 const context={URLSearchParams,location:{search:""},window:w,document:{querySelector:()=>({querySelector:node}),createElement:()=>({})},mountReport:(root,c)=>{callbacks=c;return {refresh:async()=>{}};},loadRows:async()=>{reads++;afterLoad();return 'rows';}};
 vm.createContext(context);vm.runInContext(pageSource,context);
 return {start:()=>context.start(),node,setActive:id=>activeId=id,setError:err=>profileError=err,setAfterLoad:fn=>afterLoad=fn,get callbacks(){return callbacks;},get reads(){return reads;}};
}
test('direct page accepts Baseballism and uses persisted September period',async()=>{const h=harness();await h.start();assert.equal(h.node('#start').value,'2026-09-01');assert.equal(h.node('#end').value,'2026-09-30');assert.equal(await h.callbacks.load({}),'rows');});
test('direct page denies other, standard, missing and stale company even with global flag true',async()=>{for(const c of [other,null,{}, {...bb,meta:{nav_profile:'standard'}},{...bb,_staleReconcile:true}]){const h=harness(c);await assert.rejects(h.start());assert.equal(h.callbacks,undefined);}});
test('server active company overrides cached Baseballism',async()=>{const h=harness(bb,other.id);await assert.rejects(h.start());assert.equal(h.callbacks,undefined);});
test('switch before loading denies reads and evidence; switch during loading discards result',async()=>{
 const h=harness();await h.start();h.setActive(other.id);await assert.rejects(h.callbacks.load({}));await assert.rejects(h.callbacks.evidence({}));assert.equal(h.reads,0);
 const pending=harness();await pending.start();pending.setAfterLoad(()=>pending.setActive(other.id));await assert.rejects(pending.callbacks.load({}));assert.equal(pending.node('#results').hidden,true);
});
test('profile lookup errors fail closed on initial and subsequent access',async()=>{const h=harness();h.setError(Error('unavailable'));await assert.rejects(h.start());const loaded=harness();await loaded.start();loaded.setError(Error('unavailable'));await assert.rejects(loaded.callbacks.load({}));assert.equal(loaded.reads,0);});
