import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const ctx={window:{}};
vm.runInNewContext(await readFile(new URL('../../v2/transaction-dates.js',import.meta.url),'utf8'),ctx);
const api=ctx.window.SiloTransactionDates;
test('date shortcuts use calendar dates, including leap February and year rollover',()=>{
 assert.equal(api.preset('last',new Date(2024,2,10)).end,'2024-02-29');
 assert.equal(api.preset('last',new Date(2026,0,5)).start,'2025-12-01');
 assert.equal(api.preset('quarter',new Date(2026,7,20)).start,'2026-07-01');
 assert.equal(api.valid({start:'2026-02-30',end:'2026-03-05'}),false);
 assert.equal(api.valid({start:'2026-09-02',end:'2026-09-01'}),false);
});
test('date reader spans batches, pages completely, scopes company and account, and uses inclusive actual dates',async()=>{
 const calls=[];let page=0;
 const db={from(table){assert.equal(table,'card_transactions');const c={};const chain={};for(const key of ['select','eq','in','gte','lte','order','range'])chain[key]=(...args)=>{(c[key]??=[]).push(args);return chain;};chain.then=resolve=>{calls.push(c);return Promise.resolve({data:page++===0?Array.from({length:500},(_,i)=>({id:String(i),txn_date:'2026-08-31'})):[{id:'last',txn_date:'2026-09-01'}]}).then(resolve);};return chain;}};
 const batches=[{id:'a',company_entity_id:'co',source_id:'s'},{id:'b',company_entity_id:'co',source_id:'s'},{id:'foreign',company_entity_id:'other',source_id:'s'},{id:'other-account',company_entity_id:'co',source_id:'other'},{id:'void',company_entity_id:'co',source_id:'s',status:'voided'}];
 const rows=await api.read(db,'co','s',batches,{start:'2026-08-31',end:'2026-09-01'});
 const fields=calls[0].select[0][0].split(',');
 assert.ok(!fields.includes('*') && !fields.includes('raw') && !fields.includes('ai_reasoning'));
 for(const field of ['batch_id','txn_date','coding_conflict','confidence','clean_merchant','cardholder_email','exclude_reason'])assert.ok(fields.includes(field),field+' stays available for filters and search');
 assert.equal(rows.length,501);assert.equal(rows[0].id,'last');
 assert.equal(JSON.stringify(calls[0].in),JSON.stringify([['batch_id',['a','b']]]));
 assert.deepEqual(calls[0].eq,[['company_entity_id','co']]);assert.deepEqual(calls[0].gte,[['txn_date','2026-08-31']]);assert.deepEqual(calls[0].lte,[['txn_date','2026-09-01']]);assert.deepEqual(calls[1].range,[[500,999]]);
});
test('failed date read never returns a misleading partial result',async()=>{
 const chain={select(){return this},eq(){return this},in(){return this},gte(){return this},lte(){return this},order(){return this},range(){return Promise.resolve({error:{message:'Unavailable'}})}};
 await assert.rejects(api.read({from:()=>chain},'co','s',[{id:'a',company_entity_id:'co',source_id:'s'}],{start:'2026-08-01',end:'2026-08-31'}),/Unavailable/);
});
test('rule coverage counts actual rule coding, not rule match fields',()=>{
 assert.equal(api.summary(['rule','card','merchant','ai','manual',null].map(coding_source=>({coding_source,amount:1}))).rules,1);
});
test('date preferences survive reload and are isolated by company and account, with denied storage harmless',()=>{
 const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 const range={start:'2026-08-01',end:'2026-08-31'};
 api.preferences(storage).set('co','bank',range);
 assert.equal(JSON.stringify(api.preferences(storage).get('co','bank')),JSON.stringify(range));
 assert.equal(api.preferences(storage).get('other','bank'),null);
 assert.equal(api.preferences(storage).get('co','other'),null);
 assert.equal(api.preferences(storage).account('co'),'bank');
 const blocked=api.preferences({getItem(){throw Error('denied')},setItem(){throw Error('denied')}});
 assert.equal(blocked.get('co','bank'),null);assert.doesNotThrow(()=>blocked.set('co','bank',range));
});
