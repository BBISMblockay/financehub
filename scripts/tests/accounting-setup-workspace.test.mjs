import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../../v2/accounting-books.js',import.meta.url),'utf8');
const html=await readFile(new URL('../../v2/accounting-books.html',import.meta.url),'utf8');
const settle=async()=>{for(let i=0;i<30;i++)await new Promise(setImmediate);};
async function boot({hash='#setup',failure='',connections=[{id:'qbo',company_name:'Example & Co',environment:'sandbox'}],sources}={}){
 const elements=new Map(),reads=[],calls=[],events={};
 const el=id=>{if(!elements.has(id))elements.set(id,{id,tagName:'SECTION',open:false,hidden:false,dataset:{},events:{},value:'',innerHTML:'',textContent:'',setAttribute(k,v){this[k]=v;},addEventListener(k,v){this.events[k]=v;},insertAdjacentHTML(_,s){this.innerHTML+=s;},querySelector(){return this.fold||null;},closest(){return ['setup','ledger','register','history','accounts','locations'].includes(id)?this:null;},scrollIntoView(){this.scrolled=true;}});return elements.get(id);};
 const surfaces=['setup','ledger','register','history','accounts','locations'].map(el);
 for(const id of ['history','accounts','locations'])el(id).fold={open:false};
 const tabs=['ledger','register','setup'].map(id=>({dataset:{surface:id,owns:id==='setup'?'setup accounts locations history':id},setAttribute(k,v){this[k]=v;},addEventListener(){}}));
 const records={accounting_settings:null,accounting_opening_balances:null,plaid_connections:[{id:'bank',institution_name:'Test bank',status:'active'}],card_sources:sources||[{id:'a',display_name:'Checking',is_active:true,qbo_connection_id:'qbo',credit_qbo_account_id:'cash'},{id:'b',display_name:'Card',is_active:true,qbo_connection_id:null,credit_qbo_account_id:null}]};
 const db={auth:{getSession:async()=>({data:{session:{user:{email:'test@example.invalid'}}}})},from(table){const filters=[];let start=0,end=499;return {select(){return this;},eq(k,v){filters.push([k,v]);return this;},order(){return this;},range(a,b){start=a;end=b;return this;},limit(){return this;},maybeSingle(){return this;},then(resolve){reads.push({table,filters,start,end});return Promise.resolve(table===failure?{error:{message:'Synthetic denied read'}}:{data:Array.isArray(records[table])?records[table].slice(start,end+1):records[table]??(['accounting_settings','accounting_opening_balances'].includes(table)?null:[])}).then(resolve);}};},rpc:async(name)=>{calls.push(name);return {data:name==='accounting_qbo_connections'?connections:name==='silo_business_today'?'2026-11-12':true};}};
 const location={hash,pathname:'/v2/accounting-books.html'};
 const window={__SILO_CONFIG__:{SUPABASE_URL:'https://offline.invalid',SUPABASE_ANON_KEY:'synthetic',ensureActiveCompany:async()=>({id:'company'})},supabase:{createClient:()=>db},SiloChrome:{mount(){}},addEventListener(k,v){events[k]=v;}};
 vm.runInNewContext(code,{window,location,document:{getElementById:el,querySelectorAll:s=>s==='.books-surface'?surfaces:tabs},console});await settle();
 return {el,reads,calls,window,events,location};
}
test('setup opens connection-first and preserves the retained opening controls behind a disclosure',async()=>{
 const h=await boot();assert.equal(h.el('openingSetup').open,false);
 assert.match(h.el('setupQboStatus').innerHTML,/Example &amp; Co/);
 assert.match(h.el('setupBankStatus').innerHTML,/Test bank.*active/);
 assert.match(h.el('setupMappingStatus').innerHTML,/1 of 2 active accounts mapped/);
 assert.ok(html.indexOf('id="setupQboStatus"')<html.indexOf('id="openingSetup"'));
 for(const id of ['seedForm','seed','accept','opening','postingStart','accounts','locations','history','ledger','register'])assert.ok(html.includes(`id="${id}"`),id);
 assert.ok(!h.calls.some(n=>/seed|accept|set_|post|resync/.test(n)),'boot never changes financial state');
 for(const r of h.reads)assert.ok(r.filters.some(([k,v])=>k==='company_entity_id'&&v==='company'),r.table);
});
test('provider errors remain unknown, never a false connected or mapped success',async()=>{
 const h=await boot({failure:'card_sources',connections:[]});
 assert.match(h.el('setupQboStatus').innerHTML,/not connected/);
 assert.match(h.el('setupMappingStatus').innerHTML,/could not be read/);
 assert.doesNotMatch(h.el('setupMappingStatus').innerHTML,/0 of 0|links are saved/);
 assert.match(h.el('setupBankStatus').innerHTML,/Test bank/);
});
test('mapping reads paginate and reject stale connection links',async()=>{
 const sources=Array.from({length:501},(_,i)=>({id:String(i),is_active:true,qbo_connection_id:i?'qbo':'disconnected',credit_qbo_account_id:'bank'}));
 const h=await boot({sources});assert.match(h.el('setupMappingStatus').innerHTML,/500 of 501/);
 assert.ok(h.reads.some(r=>r.table==='card_sources'&&r.start===500));
});
test('legacy hashes and migration jumps expose the owning tab and disclosure',async()=>{
 for(const id of ['accounts','locations','history','ledger','register']){const h=await boot({hash:'#'+id});assert.equal(h.el(id).hidden,false,id);if(h.el(id).fold)assert.equal(h.el(id).fold.open,true);}
 const h=await boot();h.window.SiloBooks.showSurface('setup');assert.equal(h.el('openingSetup').open,true,'migration setup jump reveals the required action');
 h.location.hash='#accounts';h.events.hashchange();assert.equal(h.el('accounts').fold.open,true,'same-page chart link works after boot');
});
test('mode blockers and save failure feedback are not inside the folded editor',async()=>{
 const mode=await readFile(new URL('../../v2/accounting-mode.js',import.meta.url),'utf8');
 assert.match(html,/<details data-mode-disclosure>[\s\S]*?<\/details>\s*<div data-mode-blockers hidden><\/div><div class="books-caption" data-mode-status/);
 assert.match(mode,/if \(bad\)[\s\S]*?disclosure.open = true/);
 assert.doesNotMatch(mode,/You’ve connected QuickBooks and SILO has your history/);
});
