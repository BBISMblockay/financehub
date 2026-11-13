import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const base=new URL('../../',import.meta.url);
const navSource=await readFile(new URL('v2/nav-config.js',base),'utf8');
const pageSource=(await readFile(new URL('v2/silo-attribution-page.js',base),'utf8')).replace(/^import[^\n]+\n/gm,'').replace('boot().catch(e=>fail(e.message||String(e)));','globalThis.start=boot;');
const {periodRange,matchPeriod}=await import(new URL('v2/silo-attribution-period.js',base));
// Attribution is open to every workspace since 2026-11-13. It was a pilot
// gated on one company's entity id, in the nav AND in this page's own guard;
// what the guard still enforces is that the company is RESOLVED and is the one
// the server says is active. `bb` and `other` are now just two companies, and
// the tests below check that BOTH reach the page and that neither can read the
// other's days.
const bb={id:'3bd934c9-4cdd-429b-9076-f8f6b45d4eb7',entity_key:'baseballism',meta:{nav_profile:'grandfathered'}};
const other={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',meta:{nav_profile:'standard'}};
function nav(){const w={};new Function('window',navSource)(w);return w.SiloNav;}
const visible=(n,c)=>n.navSectionsForCompany(c).some(s=>s.items.some(i=>i.id==='reports/silo-attribution'));
test('navigation offers Attribution to every resolved company, on either profile',()=>{
 const n=nav();
 for(const c of [bb,other,{...bb,meta:{nav_profile:'standard'}},{...bb,_staleReconcile:true}])assert.equal(visible(n,c),true);
 // Both profiles list it, which the pilot companyGate prevented.
 for(const profile of ['grandfathered','standard'])
  assert.equal(n.navSectionsForProfile(profile).some(s=>s.items.some(i=>i.id==='reports/silo-attribution')),true);
 // With no company resolved the menu is the STANDARD one -- which now
 // includes Attribution, so the row appears on a deep link before the real
 // company is known. That is discovery, not access: the page itself refuses
 // an unresolved company (see the direct-page tests below), and the row is a
 // link to a page that then says so, exactly like every other standard row.
 assert.equal(n.resolveNavProfile(null),'standard');
 assert.equal(visible(n,null),true);
 // And nothing in the nav gates on a company identity any more.
 assert.equal(n.isSiloAttributionEnabled,undefined);
});
const oneStore=[{id:'store',shop_domain:'baseballism'}];
const oneCovered=[{connection_id:'store',last_day:'2026-09-30',funded_days:30}];
function harness(company=bb,active=company?.id,{stores=oneStore,coverage=oneCovered,search='',setting=null,settingError=null}={}){
 let activeId=active,callbacks,reads=0,spendReads=[],profileError=null,afterLoad=()=>{},queries=[],settingReads=0;
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:true,value:'',options:[],append(option){this.options.push(option);},close(){},addEventListener(t,f){(this.listeners||={})[t]=f;},closest(){return this.label||={hidden:false};},after(n){this.inserted=n;}});return nodes.get(id);};
 const db={auth:{getSession:async()=>({data:{session:{user:{id:'user'}}}})},rpc:async(fn,args)=>{queries.push({fn,query:args?.query});return {data:coverage};},from(table){const q={select(){return q;},eq(){return q;},order(){return table==='shopify_connections'?Promise.resolve({data:stores}):q;},limit:async()=>({data:[{day:'2026-09-30'}]}),single:async()=>table==='profiles'?{data:{active_company_id:activeId,role:'admin'},error:profileError}:{data:{evidence:{}}},maybeSingle:async()=>{if(table==='company_settings'){settingReads++;return settingError?{data:null,error:settingError}:{data:setting?{attribution_store_ids:setting}:null,error:null};}return {data:null,error:null};}};return q;}};
 const w={SiloNav:nav(),__SILO_CONFIG__:{SUPABASE_URL:'test',SUPABASE_ANON_KEY:'test',SILO_ATTRIBUTION_ENABLED:true,ensureActiveCompany:async()=>company},supabase:{createClient:()=>db}};
 const context={URLSearchParams,location:{search},window:w,document:{querySelector:()=>({querySelector:node}),createElement:()=>({})},mountReport:(root,c)=>{callbacks=c;return {refresh:async()=>{}};},loadRows:async()=>{reads++;afterLoad();return 'rows';},loadSpend:async(db,companyId)=>{spendReads.push(companyId);return 'spend';},periodRange,matchPeriod};
 vm.createContext(context);vm.runInContext(pageSource,context);
 return {start:()=>context.start(),node,setActive:id=>activeId=id,setError:err=>profileError=err,setAfterLoad:fn=>afterLoad=fn,get callbacks(){return callbacks;},get reads(){return reads;},get spendReads(){return spendReads;},get queries(){return queries;},get offered(){return node('#store').options.map(o=>o.value);},get labels(){return node('#store').options.map(o=>o.textContent);},get pickerHidden(){return node('#store').label?.hidden===true;},get settingReads(){return settingReads;},get dateFieldsHidden(){return node('#start').label?.hidden===true&&node('#end').label?.hidden===true;},get dateLine(){return node('#onlystore').inserted;}};
}
test('direct page accepts a company and uses persisted September period',async()=>{const h=harness();await h.start();assert.equal(h.node('#start').value,'2026-09-01');assert.equal(h.node('#end').value,'2026-09-30');assert.equal(await h.callbacks.load({}),'rows');});
test('any resolved company reaches the page, reading only its OWN days',async()=>{
 for(const c of [other,{...bb,meta:{nav_profile:'standard'}}]){
  const h=harness(c);await h.start();
  assert.notEqual(h.callbacks,undefined);
  // The one thing that must never widen: the coverage probe is scoped to the
  // company that was verified, so opening the page as another tenant reads
  // that tenant's days and nobody else's.
  assert.equal(h.queries.length,1);
  assert.ok(h.queries[0].query.includes(`company_entity_id='${c.id}'::uuid`),h.queries[0].query);
  assert.ok(!h.queries[0].query.includes(bb.id)||c.id===bb.id);
 }
});
test('direct page denies a company that is missing, unidentified or unresolved',async()=>{
 // No company at all, a company with no id, and a company whose reconcile
 // failed: an unresolved company is not a company, and every page that reads
 // money refuses it rather than guessing.
 for(const c of [null,{},{...bb,_staleReconcile:true}]){const h=harness(c);await assert.rejects(h.start());assert.equal(h.callbacks,undefined);}
});
test('the server active company overrides the per-tab cache',async()=>{const h=harness(bb,other.id);await assert.rejects(h.start());assert.equal(h.callbacks,undefined);});
test('switch before loading denies reads and evidence; switch during loading discards result',async()=>{
 const h=harness();await h.start();h.setActive(other.id);await assert.rejects(h.callbacks.load({}));await assert.rejects(h.callbacks.evidence({}));assert.equal(h.reads,0);
 const pending=harness();await pending.start();pending.setAfterLoad(()=>pending.setActive(other.id));await assert.rejects(pending.callbacks.load({}));assert.equal(pending.node('#results').hidden,true);
});
test('profile lookup errors fail closed on initial and subsequent access',async()=>{const h=harness();h.setError(Error('unavailable'));await assert.rejects(h.start());const loaded=harness();await loaded.start();loaded.setError(Error('unavailable'));await assert.rejects(loaded.callbacks.load({}));assert.equal(loaded.reads,0);});
test('spend reads use the verified company and stop after a switch',async()=>{
 const h=harness();await h.start();assert.equal(await h.callbacks.spend({start:'2026-09-01',end:'2026-09-30'}),'spend');assert.deepEqual(h.spendReads,[bb.id]);
 h.setActive(other.id);await assert.rejects(h.callbacks.spend({start:'2026-09-01',end:'2026-09-30'}));assert.deepEqual(h.spendReads,[bb.id]);
});
const threeStores=[{id:'online',shop_domain:'baseballism'},{id:'retail',shop_domain:'baseballismchicago'},{id:'fod',shop_domain:'baseballismfod'}];
test('only stores with attributed sales are offered, and the period follows the selected store',async()=>{
 const coverage=[{connection_id:'online',last_day:'2026-10-17',funded_days:47},{connection_id:'retail',last_day:'2026-10-17',funded_days:0},{connection_id:'fod',last_day:'2026-10-15',funded_days:37}];
 const h=harness(bb,bb.id,{stores:threeStores,coverage});await h.start();
 assert.deepEqual(h.offered,['online','fod']);
 assert.equal(h.node('#store').value,'online');
 assert.equal(h.node('#end').value,'2026-10-17');
 assert.equal(h.node('#start').value,'2026-09-18');
 const picked=harness(bb,bb.id,{stores:threeStores,coverage,search:'?store=fod'});await picked.start();
 assert.equal(picked.node('#store').value,'fod');
 assert.equal(picked.node('#end').value,'2026-10-15');
 assert.equal(picked.node('#start').value,'2026-09-16');
});
test('a store with no attributed sales cannot be reached by URL',async()=>{
 const coverage=[{connection_id:'online',last_day:'2026-10-17',funded_days:47},{connection_id:'retail',last_day:'2026-10-17',funded_days:0}];
 const h=harness(bb,bb.id,{stores:threeStores,coverage,search:'?store=retail'});await h.start();
 assert.equal(h.node('#store').value,'online');
});
test('no coverage yet offers every active store rather than an empty picker',async()=>{
 const h=harness(bb,bb.id,{stores:threeStores,coverage:[]});await h.start();
 assert.deepEqual(h.offered,['online','retail','fod']);
 assert.equal(h.node('#store').value,'online');
 assert.equal(h.node('#end').value,new Date(Date.now()-86400000).toISOString().slice(0,10));
});
test('the coverage probe is a scoped read-only aggregate, never an unbounded table scan',async()=>{
 const h=harness();await h.start();
 assert.equal(h.queries.length,1);
 assert.equal(h.queries[0].fn,'chat_run_readonly_query');
 assert.match(h.queries[0].query,/^select connection_id, max\(day\) as last_day, count\(\*\) filter \(where total_cents <> 0 or net_cents <> 0\) as funded_days from public\.shopify_attribution_days where company_entity_id='3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid group by connection_id$/);
});
test('a company that is not resolved, or whose id is not a uuid, never reaches the coverage probe',async()=>{
 // The probe interpolates the company id into SQL. The pilot gate used to be
 // what made that safe (exact equality with one uuid); with the gate gone the
 // shape check in the page is the whole guard, so it is tested directly --
 // including the injection attempt that the old equality check happened to
 // stop.
 for(const c of [null,{},{...bb,_staleReconcile:true},
   {id:"3bd934c9'; drop table x --",entity_key:'baseballism'},
   {id:'not-a-uuid',meta:{nav_profile:'standard'}},
   {id:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' or '1'='1",meta:{nav_profile:'standard'}}]){
   const h=harness(c);await assert.rejects(h.start());assert.deepEqual(h.queries,[]);
 }
});

// Workspace Settings chooses the stores (company_settings.attribution_store_ids, 20261110024500).
const named=[{id:'online',shop_domain:'baseballism.myshopify.com',shop_name:'Baseballism Online'},
 {id:'retail',shop_domain:'baseballismchicago.myshopify.com',shop_name:'Baseballism Chicago'},
 {id:'fod',shop_domain:'baseballismfod.myshopify.com',shop_name:null}];
const namedCoverage=[{connection_id:'online',last_day:'2026-10-17',funded_days:47},
 {connection_id:'retail',last_day:'2026-10-17',funded_days:0},
 {connection_id:'fod',last_day:'2026-10-15',funded_days:37}];
const chose=(setting,extra={})=>harness(bb,bb.id,{stores:named,coverage:namedCoverage,setting,...extra});

test('the chosen stores win over the money heuristic, including one with no attributed sales',async()=>{
 // 'retail' has funded_days 0, so the old heuristic hid it. Choosing it is the whole point of the
 // setting: a human saying this store matters beats a guess from whether it happened to sell.
 const h=chose(['retail','online']);await h.start();
 assert.deepEqual(h.offered,['retail','online']);
 assert.equal(h.node('#store').value,'retail');
});
test('an id whose store is gone or deactivated is dropped, and an all-stale setting falls back',async()=>{
 const partly=chose(['online','deleted-store']);await partly.start();
 assert.deepEqual(partly.offered,['online']);
 const allStale=chose(['deleted-store','another-gone']);await allStale.start();
 // Never an empty picker: an unreachable setting is the same as not configured.
 assert.deepEqual(allStale.offered,['online','fod']);
});
test('an empty setting means NOT CONFIGURED, never "no stores"',async()=>{
 for(const setting of [[],null]){
   const h=chose(setting);await h.start();
   assert.deepEqual(h.offered,['online','fod']); // the funded fallback, unchanged
 }
});
test('the setting is read before the migration is applied without breaking the page',async()=>{
 const missing=chose(['online'],{settingError:{code:'42703'}});await missing.start();
 assert.deepEqual(missing.offered,['online','fod']); // feature-detected, previous behaviour
 // Any OTHER read failure must fail closed rather than silently showing every store.
 const broken=chose(['online'],{settingError:{code:'42501',message:'denied'}});
 await assert.rejects(broken.start());
});
test('one store to report on is stated, not asked',async()=>{
 const one=chose(['online']);await one.start();
 assert.deepEqual(one.offered,['online']);
 assert.equal(one.pickerHidden,true);
 assert.match(String(one.node('.attr-controls').inserted?.textContent||''),/Reporting on Baseballism Online/);
 // More than one is still a choice, so the picker stays.
 const two=chose(['online','fod']);await two.start();
 assert.equal(two.pickerHidden,false);
});
test('stores read as their Shopify name, with the domain only where it adds something',async()=>{
 const h=chose(['online','fod']);await h.start();
 // A name plus the distinguishing part of the domain: two Baseballism stores read alike otherwise.
 assert.deepEqual(h.labels,['Baseballism Online (baseballism)','baseballismfod.myshopify.com']);
});
test('the setting is read once per load, scoped to the active company',async()=>{
 const h=chose(['online']);await h.start();
 assert.equal(h.settingReads,1);
 // A company that is not resolved never reaches it.
 for(const c of [null,{},{...bb,_staleReconcile:true}]){
   const denied=harness(c,c?.id,{stores:named,coverage:namedCoverage,setting:['online']});
   await assert.rejects(denied.start());
   assert.equal(denied.settingReads,0);
 }
 // Another company reaches it scoped to ITSELF.
 const theirs=harness(other,other.id,{stores:named,coverage:namedCoverage,setting:['online']});
 await theirs.start();
 assert.equal(theirs.settingReads,1);
});

test('useless shop names fall back to the domain',async()=>{
 // Shopify has returned a whitespace-only name, and a name identical to the domain. Either one,
 // shown as-is, is a blank or doubled entry in the picker.
 const odd=[{id:'blank',shop_domain:'blankname.myshopify.com',shop_name:'   '},
  {id:'same',shop_domain:'samename.myshopify.com',shop_name:'samename.myshopify.com'},
  {id:'padded',shop_domain:'padded.myshopify.com',shop_name:'  Baseballism Hohokam  '}];
 const coverage=odd.map(s=>({connection_id:s.id,last_day:'2026-10-17',funded_days:5}));
 const h=harness(bb,bb.id,{stores:odd,coverage,setting:['blank','same','padded']});await h.start();
 assert.deepEqual(h.labels,['blankname.myshopify.com','samename.myshopify.com','Baseballism Hohokam (padded)']);
});

// Review cycle 1 of PR #1173, finding 2: the period anchor is per store, so switching store left
// the previous store's dates in place while the control still claimed the old preset. loadRows()
// refuses a period containing uncollected days outright, so that combination did not show less --
// it failed.
const twoDates=[{id:'a',shop_domain:'a.myshopify.com',shop_name:'Store A'},
 {id:'b',shop_domain:'b.myshopify.com',shop_name:'Store B'}];
const twoDatesCoverage=[{connection_id:'a',last_day:'2026-10-17',funded_days:40},
 {connection_id:'b',last_day:'2026-10-15',funded_days:40}];

test('switching store re-anchors an active preset to that store',async()=>{
 const h=harness(bb,bb.id,{stores:twoDates,coverage:twoDatesCoverage,setting:['a','b']});await h.start();
 assert.equal(h.node('#store').value,'a');
 assert.equal(h.node('#period').value,'30');
 assert.equal(h.node('#start').value,'2026-09-18');
 assert.equal(h.node('#end').value,'2026-10-17');
 // Switch to the store collected two days earlier.
 h.node('#store').value='b';
 h.node('#store').listeners.change();
 assert.equal(h.node('#period').value,'30','the preset stays the chosen one');
 assert.equal(h.node('#end').value,'2026-10-15','and follows the new store\'s newest collected day');
 assert.equal(h.node('#start').value,'2026-09-16');
});
test('switching store keeps a custom range as typed and only relabels it',async()=>{
 const h=harness(bb,bb.id,{stores:twoDates,coverage:twoDatesCoverage,setting:['a','b']});await h.start();
 // A range that is nobody's preset.
 h.node('#start').value='2026-10-01';h.node('#end').value='2026-10-09';
 h.node('#start').listeners.change();
 assert.equal(h.node('#period').value,'custom');
 h.node('#store').value='b';
 h.node('#store').listeners.change();
 assert.equal(h.node('#start').value,'2026-10-01','custom dates are the user\'s own, not re-anchored');
 assert.equal(h.node('#end').value,'2026-10-09');
 assert.equal(h.node('#period').value,'custom');
 // The same dates can be a preset for one store and custom for another, so the label is recomputed:
 // store B's newest day is the 15th, so its last 7 days are the 9th to the 15th.
 h.node('#start').value='2026-10-09';h.node('#end').value='2026-10-15';
 h.node('#store').listeners.change();
 assert.equal(h.node('#period').value,'7');
 // ... and the restated range follows it, or the bar would name a period the report is not about.
 assert.equal(h.dateLine.textContent,'Oct 9, 2026 through Oct 15, 2026');
 assert.equal(h.dateFieldsHidden,true,'a range that lands on a preset is shown as one');
});

test('a preset states its range once instead of repeating it in From and To',async()=>{
 const h=harness();await h.start();
 assert.equal(h.node('#period').value,'30');
 assert.equal(h.dateFieldsHidden,true);
 assert.equal(h.dateLine.hidden,false);
 assert.equal(h.dateLine.textContent,'Sep 1, 2026 through Sep 30, 2026');
});

test('choosing Custom brings the date fields back carrying the preset dates',async()=>{
 const h=harness();await h.start();
 h.node('#period').value='custom';h.node('#period').listeners.change();
 assert.equal(h.dateFieldsHidden,false);
 assert.equal(h.dateLine.hidden,true);
 assert.equal(h.node('#start').value,'2026-09-01');
 assert.equal(h.node('#end').value,'2026-09-30');
});

test('switching to a preset hides the fields again and restates the new range',async()=>{
 const h=harness();await h.start();
 h.node('#period').value='custom';h.node('#period').listeners.change();
 h.node('#period').value='7';h.node('#period').listeners.change();
 assert.equal(h.dateFieldsHidden,true);
 assert.equal(h.node('#start').value,'2026-09-24');
 assert.equal(h.dateLine.textContent,'Sep 24, 2026 through Sep 30, 2026');
});

test('typing a custom date keeps the fields visible and clears the restated range',async()=>{
 const h=harness();await h.start();
 h.node('#start').value='2026-09-15';h.node('#start').listeners.change();
 assert.equal(h.node('#period').value,'custom');
 assert.equal(h.dateFieldsHidden,false);
 assert.equal(h.dateLine.hidden,true);
});
