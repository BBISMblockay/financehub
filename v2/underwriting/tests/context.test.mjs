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
