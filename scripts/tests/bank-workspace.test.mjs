import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const window={};
let source=await readFile(new URL('../../v2/bank-workspace.js',import.meta.url),'utf8');
if(process.env.BANK_WORKSPACE_MUTATION==='confirmation')source=source.replace('checked === true','true');
if(process.env.BANK_WORKSPACE_MUTATION==='stale')source=source.replace('now - Date.parse(account.last_synced_at) > 24*60*60*1000','false');
vm.runInNewContext(source,{window,Date,Intl});
const {accountState,cutoverConfirmed}=window.SiloBankWorkspace;
const now=Date.parse('2026-09-12T12:00:00Z');
const account={source_id:'source',cursor:'position',last_synced_at:'2026-09-12T11:00:00Z'};
test('every feed state identifies the next action',()=>{
  const scenarios=[
    [{last_synced_at:null,cursor:null},{}, {}, 'mapped-never-synced','sync','Sync first transactions'],
    [{},{},{syncing:true},'syncing','wait','Syncing…'],
    [{},{},{},'synced-recently','sync','Sync transactions'],
    [{last_synced_at:'2026-09-10T00:00:00Z'},{},{},'stale','sync','Sync transactions'],
    [{sync_lease_expires_at:'2026-09-12T12:04:00Z'},{},{},'lease-held','refresh','Check sync status'],
    [{},{status:'login_required'},{},'login_required','repair','Reconnect bank'],
    [{},{status:'disconnected'},{},'disconnected','repair','Resume syncing'],
  ];
  for(const [a,c,options,key,action,cta] of scenarios){
    const state=accountState({...account,...a},{status:'active',...c},{now,...options});
    assert.equal(state.key,key);assert.equal(state.action,action);assert.equal(state.cta,cta);assert.ok(state.help.length>10);
  }
});
test('cutover confirmation binds to the exact date and defaults to refused',()=>{
  assert.equal(cutoverConfirmed('2026-08-01',false,'2026-08-01'),false);
  assert.equal(cutoverConfirmed('2026-08-01',true,'2026-09-01'),false);
  assert.equal(cutoverConfirmed('',true,''),false);
  assert.equal(cutoverConfirmed('2026-08-01',true,'2026-08-01'),true);
});
test('account headers render state actions and CSV upload is secondary and CSV-only',()=>{
  for(const state of ['never','stale','recent','lease','login','disconnected','syncing','csv']){
    const elements=new Map();const doc={getElementById(id){if(!elements.has(id))elements.set(id,{value:'',innerHTML:'',addEventListener(){}});return elements.get(id);}};
    const a={id:'account',...account,...(state==='never'?{last_synced_at:null,cursor:null}:{}),...(state==='stale'?{last_synced_at:'2020-01-01'}:{}),...(state==='recent'?{last_synced_at:new Date().toISOString()}:{}),...(state==='lease'?{sync_lease_expires_at:'2099-01-01'}:{})};
    const c={id:'connection',status:state==='login'?'login_required':state==='disconnected'?'disconnected':'active'};a.connection_id=c.id;
    const data={accounts:state==='csv'?[]:[a],connections:[c],exceptions:[],syncing:state==='syncing'?a.id:null};
    const expected=state==='csv'?{action:'upload',cta:'Upload statement'}:accountState(a,c,{syncing:state==='syncing'});
    const workspace=window.SiloBankWorkspace.create({document:doc,references:()=>({sources:[{id:'source',is_active:true,display_name:'Synthetic account',ingest_mode:state==='csv'?'csv':'plaid'}],batches:[]}),feeds:()=>({snapshot:()=>data})});
    workspace.render();const html=doc.getElementById('workspaceSummary').innerHTML;
    assert.ok(html.includes('data-workspace-action="'+expected.action+'"'),state);assert.ok(html.includes(expected.cta),state);
    assert.equal(html.includes('Upload statement'),state==='csv');
  }
});
