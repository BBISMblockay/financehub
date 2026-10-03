import test from 'node:test';
import assert from 'node:assert/strict';
import { readContext,createLoadGuard } from '../context.js';
function fixture({signedIn=true,active=true,finance=true,executive=false,company='company-a',after=company,profileError=null,stale=false}={}) {
 let reads=0;
 const db={auth:{getUser:async()=>({data:{user:signedIn?{id:'user',email:'test@example.invalid'}:null}})},from(name){assert.equal(name,'profiles');return{select(){return this;},eq(){return this;},async single(){reads++;return{error:profileError,data:{is_active:active,active_company_id:reads===1?company:after}};}};},rpc:async(name)=>({data:name==='can_manage_journal_entries'?finance:executive})};
 return {db,cfg:{ensureActiveCompany:async()=>({id:company,_staleReconcile:stale})}};
}
test('existing finance and active-company context is required',async()=>{const f=fixture();assert.equal((await readContext(f.db,f.cfg)).key,'user:company-a');});
test('anonymous, disabled, denied and stale company all fail closed',async()=>{for(const options of [{signedIn:false},{active:false},{finance:false},{stale:true},{profileError:{message:'offline'}}]){const f=fixture(options);await assert.rejects(()=>readContext(f.db,f.cfg));}});
test('existing executive gate also grants access',async()=>{const f=fixture({finance:false,executive:true});assert.equal((await readContext(f.db,f.cfg)).company.id,'company-a');});
test('company change between asynchronous gates is rejected',async()=>{const f=fixture({after:'company-b'});await assert.rejects(()=>readContext(f.db,f.cfg),/company changed/i);});
test('starting or invalidating a load cancels old work',()=>{const guard=createLoadGuard(),first=guard.begin(),second=guard.begin();assert.equal(first.signal.aborted,true);assert.equal(guard.current(first),false);assert.equal(guard.current(second),true);guard.invalidate();assert.equal(guard.current(second),false);assert.equal(second.signal.aborted,true);});

// Transient (a read did not come back) vs definitive (the server excluded this
// person). Only the second may clear an unsaved scenario; see workspace.js.
function flaky({authError=null,profileError=null,confirmError=null,financeError=null,execError=null,finance=false,executive=false,active=true,company='company-a'}={}) {
 let reads=0;
 const db={auth:{getUser:async()=>({error:authError,data:{user:authError?null:{id:'user',email:'test@example.invalid'}}})},
  from(){return{select(){return this;},eq(){return this;},async single(){reads++;const error=reads===1?profileError:confirmError;return error?{error}:{data:{is_active:active,active_company_id:company}};}};},
  rpc:async(name)=>name==='can_manage_journal_entries'?(financeError?{error:financeError}:{data:finance}):(execError?{error:execError}:{data:executive})};
 return {db,cfg:{ensureActiveCompany:async()=>({id:company})}};
}
const transient=async options=>{const f=flaky(options);let caught;try{await readContext(f.db,f.cfg);}catch(error){caught=error;}assert.ok(caught,'rejects');return caught.transient===true;};
test('reads that did not come back are transient failures, never verdicts',async()=>{
 const offline={message:'TypeError: Failed to fetch'};
 assert.equal(await transient({authError:offline}),true,'auth read');
 assert.equal(await transient({profileError:offline,finance:true}),true,'profile read');
 assert.equal(await transient({confirmError:offline,finance:true}),true,'confirming read');
 assert.equal(await transient({financeError:offline,execError:offline}),true,'both gates unanswered');
 assert.equal(await transient({financeError:offline,executive:false}),true,'one gate unanswered, the other false');
});
test('a gate that answered true passes even when the other gate failed to answer',async()=>{
 const f=flaky({financeError:{message:'offline'},executive:true});
 assert.equal((await readContext(f.db,f.cfg)).key,'user:company-a');
});
test('server answers that exclude this person are definitive',async()=>{
 assert.equal(await transient({finance:false,executive:false}),false,'both gates false');
 assert.equal(await transient({active:false,finance:true}),false,'disabled account');
 assert.equal(await transient({profileError:{code:'PGRST116',message:'no rows'},finance:true}),false,'a profile row that does not exist is a server answer');
 assert.equal(await transient({confirmError:{code:'PGRST116',message:'no rows'},finance:true}),false,'same on the confirming read');
 assert.equal(await transient({company:null,finance:true}),false,'no active company');
 const f=fixture({signedIn:false});let caught;try{await readContext(f.db,f.cfg);}catch(error){caught=error;}assert.equal(caught.transient,false,'signed out');
});
