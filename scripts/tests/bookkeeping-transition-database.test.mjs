// First accounting safety slice: execute real migrations, not a model of the RPC.
// Mutations are applied only to local SQL by the shared fixture. Each must fail:
// BOOKKEEPING_TRANSITION_MUTATION=claim-check-removed|stale-version-bypass
//   |company-boundary-bypass|date-bypass|pending-claims-ignored|update-guard-removed
// Production auth helpers are represented by finance-db/bootstrap.sql; this is
// regression evidence for the real finance SQL, not production policy parity.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { baseSql, transitionSql, fixtureIds, seedSql, claimSql, batchSeedSql } from './bookkeeping-transition-fixture.mjs';
const db = new PGlite({ extensions: { pgcrypto } });
const c = fixtureIds();
const q = async (sql, args=[]) => (await db.query(sql,args)).rows;
const state = async () => (await q('select * from accounting_settings where company_entity_id=$1',[c.co]))[0];
async function as(uid, fn, role='authenticated') {
  await q("select set_config('request.jwt.claim.sub',$1,false)",[uid || '']);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const save = (mode='qbo', date=null, version=0, company=c.co, user=c.finance) => as(user, () => q('select * from set_bookkeeping_mode_checked($1,$2,$3,$4)',[mode,date,company,version]));
async function denied(fn, code) { await assert.rejects(fn, e => { assert.equal(e.code,code,e.message); return true; }); }
let passed=0;
async function test(name, fn) { await fn(); console.log(`ok ${++passed} - ${name}`); }
async function reset() { await db.exec(`delete from quickbooks_journal_postings; update accounting_settings set bookkeeping_mode='silo',silo_takeover_on=null,bookkeeping_version=0;`); }
try {
  await db.exec(await baseSql());
  const sql=await transitionSql();
  await db.exec(sql); await db.exec(sql); // Idempotent without resetting version.
  await db.exec(seedSql(c));
  await test('default version, narrow gate, explicit active tenant, missing settings and RLS', async () => {
    assert.equal(Number((await state()).bookkeeping_version),0);
    for (const user of [c.member,c.admin,null]) await denied(()=>save('qbo',null,0,c.co,user),'42501');
    await q('update profiles set is_active=false where id=$1',[c.finance]);
    await denied(()=>save(),'42501');
    await q('update profiles set is_active=true,active_company_id=null where id=$1',[c.finance]);
    await denied(()=>save(),'42501');
    await q('update profiles set active_company_id=$1 where id=$2',[c.co,c.finance]);
    for (const company of [c.other,null]) await denied(()=>save('qbo',null,0,company),'P0BM1');
    await denied(()=>save('qbo',null,0,c.co,c.otherFinance),'P0BM1');
    await denied(()=>save('qbo',null,0,c.empty,c.emptyFinance),'P0002');
    assert.deepEqual(await as(c.finance,()=>q('select company_entity_id from accounting_settings')), [{company_entity_id:c.co}]);
    await denied(()=>as(c.finance,()=>q("update accounting_settings set bookkeeping_version=100")),'42501');
    const grants=await q(`select has_function_privilege('anon','public.set_bookkeeping_mode_checked(text,date,uuid,bigint)','EXECUTE') as anon,
      has_function_privilege('authenticated','public.set_bookkeeping_mode_checked(text,date,uuid,bigint)','EXECUTE') as finance`);
    assert.deepEqual(grants,[{anon:false,finance:true}]);
  });
  await test('null and unknown modes rejected; takeover finite, not future, not before books start',async()=>{
    for (const mode of [null,'hybrid','']) await denied(()=>save(mode),'22023');
    for (const date of ['2026-07-31','infinity','-infinity','2999-01-01']) await denied(()=>save('silo',date),'22023');
    assert.equal(Number((await state()).bookkeeping_version),0);
    await save('silo','2026-08-01');
    assert.equal(Number((await state()).bookkeeping_version),1);
    await reset();
  });
  await test('CAS rejects stale/null versions even for no-op; changes increment exactly once',async()=>{
    await denied(()=>save('silo',null,null),'P0BM4');
    await save('silo'); assert.equal(Number((await state()).bookkeeping_version),0);
    await save('silo','2026-09-01'); assert.equal(Number((await state()).bookkeeping_version),1);
    await denied(()=>save('silo','2026-09-01',0),'P0BM4');
    await denied(()=>save('qbo',null,0),'P0BM4');
    await save('silo','2026-09-01',1); assert.equal(Number((await state()).bookkeeping_version),1);
    await save('qbo','infinity',1); assert.equal(Number((await state()).bookkeeping_version),2);
    assert.equal((await state()).silo_takeover_on,null);
    await save('qbo',null,2); assert.equal(Number((await state()).bookkeeping_version),2);
    assert.equal((await state()).books_authority,'qbo');
    await db.exec(sql); assert.equal(Number((await state()).bookkeeping_version),2);
    await reset();
  });
  await test('legacy RPC remains compatible, but shares new posting safety gate',async()=>{
    await as(c.finance,()=>q("select set_bookkeeping_mode('qbo')"));
    assert.equal((await state()).bookkeeping_mode,'qbo');
    await as(c.finance,()=>q("select set_bookkeeping_mode('silo',null,$1)",[c.co]));
    await db.exec(claimSql(c));
    await denied(()=>as(c.finance,()=>q("select set_bookkeeping_mode('qbo')")),'P0BM3');
    await reset();
  });
  const sources=['journal_entry','card_import','schedule','revenue_journal','fixed_asset','journal_adjustment'];
  await test('every surface submitting or unknown prevents handover without changing authority or version',async()=>{
    for (const source of sources) for (const status of ['submitting','unknown']) {
      let batch=null;
      if(source==='card_import') {
        batch=randomUUID(); await db.exec(batchSeedSql(c,batch));
        await as(c.finance,()=>q('select approve_card_import_batch($1)',[batch]));
        const row=(await q('select approval_hash,approval_snapshot from card_import_batches where id=$1',[batch]))[0];
        await db.exec(claimSql(c,{source,status,sourceRef:batch,hash:row.approval_hash,payload:row.approval_snapshot.payload}));
      } else await db.exec(claimSql(c,{source,status}));
      await denied(()=>save(),'P0BM3');
      assert.equal((await state()).bookkeeping_mode,'silo');
      assert.equal(Number((await state()).bookkeeping_version),0);
      assert.equal((await state()).books_authority,'qbo');
      await reset();
      if(batch) { await as(c.finance,()=>q('select reopen_card_import_batch($1,$2)',[batch,'Synthetic cleanup'])); await q('delete from card_transactions where batch_id=$1',[batch]); await q('delete from card_import_batches where id=$1',[batch]); }
    }
  });
  await test('other tenants claims do not block; posted/failed/voided claims are resolved',async()=>{
    await db.exec(claimSql(c,{company:c.other,connection:c.otherConn}));
    for (const status of ['posted','failed','voided']) await db.exec(claimSql(c,{status}));
    await save(); assert.equal((await state()).bookkeeping_mode,'qbo');
    await reset();
  });
  await test('approved batches still block handover',async()=>{
    const id=randomUUID();
    await q(`insert into card_import_batches(id,company_entity_id,source_id,label,entry_date,period_start,period_end,status,origin,qbo_connection_id)
      values($1,$2,$3,'Synthetic','2026-09-30','2026-09-01','2026-09-30','approved','csv',$4)`,[id,c.co,c.source,c.conn]);
    await denied(()=>save(),'P0BM2');
    await q('delete from card_import_batches where id=$1',[id]);
  });
  await test('qbo blocks inserts and terminal/unknown retries but permits receipts and reconciliation',async()=>{
    await save();
    for (const source of sources) {
      if(source==='card_import') await assert.rejects(()=>db.exec(claimSql(c,{source})), /Card batch not found/);
      else await denied(()=>db.exec(claimSql(c,{source})),'P0PS2');
      for (const status of ['failed','voided','unknown']) {
        const id=randomUUID();
        await db.exec(claimSql(c,{source,status,id}));
        await denied(()=>q("update quickbooks_journal_postings set status='submitting' where id=$1",[id]),'P0PS2');
        await q("update quickbooks_journal_postings set status='unknown' where id=$1",[id]);
        await q("update quickbooks_journal_postings set status='posted',qbo_journal_entry_id='receipt' where id=$1",[id]);
        assert.equal((await q('select status from quickbooks_journal_postings where id=$1',[id]))[0].status,'posted');
      }
    }
    assert.equal((await state()).books_authority,'qbo');
  });
  await test('a real approved card snapshot cannot send in a grandfathered qbo-mode fixture',async()=>{
    await reset();
    const batch=randomUUID(); await db.exec(batchSeedSql(c,batch));
    await as(c.finance,()=>q('select approve_card_import_batch($1)',[batch]));
    const row=(await q('select approval_hash,approval_snapshot from card_import_batches where id=$1',[batch]))[0];
    // Synthetic historical state only: the new handover RPC correctly refuses
    // creating this combination, but old deployments may already contain it.
    await q("update accounting_settings set bookkeeping_mode='qbo' where company_entity_id=$1",[c.co]);
    await assert.rejects(()=>db.exec(claimSql(c,{source:'card_import',sourceRef:batch,hash:row.approval_hash,payload:row.approval_snapshot.payload})),e=>{
      assert.ok(['P0PS1','P0PS2'].includes(e.code),e.message);
      assert.match(e.message,/QuickBooks keeps the books/); return true;
    });
    assert.equal(Number((await q('select count(*) as n from quickbooks_journal_postings'))[0].n),0);
  });
  console.log(`\n${passed} bookkeeping transition database tests passed.`);
} finally { await db.close(); }
