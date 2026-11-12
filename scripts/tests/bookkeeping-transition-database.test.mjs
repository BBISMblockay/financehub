// First accounting safety slice: execute real migrations, not a model of the RPC.
// Mutations are applied only to local SQL by the shared fixture. Each must fail:
// BOOKKEEPING_TRANSITION_MUTATION=claim-check-removed|stale-version-bypass
//   |company-boundary-bypass|date-bypass|window-not-configurable|pending-claims-ignored
//   |claim-judged-by-date|setup-imports-block|update-guard-removed
//   |sibling-guards-insert-only
// Production auth helpers are represented by finance-db/bootstrap.sql; this is
// regression evidence for the real finance SQL, not production policy parity.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { readFile } from 'node:fs/promises';
import { baseSql, transitionSql, fixtureIds, seedSql, claimSql, batchSeedSql, root } from './bookkeeping-transition-fixture.mjs';
const db = new PGlite({ extensions: { pgcrypto } });
const c = fixtureIds();
const q = async (sql, args=[]) => (await db.query(sql,args)).rows;
const day=(v)=>(v instanceof Date ? v.toISOString() : String(v??'')).slice(0,10);
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
  await test('CAS rejects stale/null versions on a change; an identical write stays connected',async()=>{
    /* An identical write is how the card resumes a ledger catch-up it could
       not finish in one pass. It changes nothing, so neither a version another
       tab has moved on nor a window tightened since may refuse it -- otherwise
       the reader cannot finish reversing or reconciling the ledger. Every
       write that DOES change something is still compare-and-set. */
    assert.equal((await save('silo',null,null))[0].bookkeeping_mode,'silo');
    await save('silo'); assert.equal(Number((await state()).bookkeeping_version),0);
    await save('silo','2026-09-01'); assert.equal(Number((await state()).bookkeeping_version),1);
    assert.ok((await save('silo','2026-09-01',0))[0].silo_takeover_on,'an identical write returns the committed row');
    assert.equal(Number((await state()).bookkeeping_version),1);
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
        /* Re-entry into submitting is refused. For a card import the three
           sibling guards now cover the UPDATE too and speak first, so what
           matters is that the row cannot move, not which guard says so. */
        if(source==='card_import') await assert.rejects(()=>q("update quickbooks_journal_postings set status='submitting' where id=$1",[id]),/not found for posting claim|QuickBooks keeps the books|approved entry changed/);
        else await denied(()=>q("update quickbooks_journal_postings set status='submitting' where id=$1",[id]),'P0PS2');
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
  await test('a post already in progress blocks whatever the dates say later',async()=>{
    await reset();
    for (const t of await q("select id from card_import_batches where status in ('approved','posted')")) {
      await as(c.finance,()=>q('select reopen_card_import_batch($1,$2)',[t.id,'Synthetic cleanup before the handover tests']));
      await q('delete from card_transactions where batch_id=$1',[t.id]);
      await q('delete from card_import_batches where id=$1',[t.id]);
    }
    /* THE SAFETY CASE. Every submitting/unknown row is an attempted send:
       quickbooks-post-journal stamps attempt_count and last_attempt_at and
       inserts it immediately before the Intuit write, so the entry may be in
       QuickBooks right now. No date can settle that -- and an earlier draft
       read a July period as "setup history", so moving the takeover date
       forward would have quietly stopped a live send from blocking. */
    const old=randomUUID();
    await db.exec(claimSql(c,{status:'unknown',id:old,periodStart:'2026-07-01',periodEnd:'2026-07-31'}));
    for (const takeover of [null,'2026-09-01','2026-10-15']) {
      await q('update accounting_settings set silo_takeover_on=$2 where company_entity_id=$1',[c.co,takeover]);
      const e=await save('qbo',null,Number((await state()).bookkeeping_version)).catch((err)=>err);
      assert.equal(e.code,'P0BM3',`a takeover of ${takeover} must not release an unresolved post`);
      const listed=await as(c.finance,()=>q("select * from silo_handover_blockers() where kind='post'"));
      assert.equal(listed[0].blocks_handover,true);
      assert.match(listed[0].reason,/may be in QuickBooks/);
      assert.equal(listed[0].action_label,'Review this post');
      assert.match(listed[0].review_path,/accounting-books\.html#register/);
    }
    assert.equal((await q('select status from quickbooks_journal_postings where id=$1',[old]))[0].status,'unknown',
      'an uncertain post is never released');
    await q('update accounting_settings set silo_takeover_on=null where company_entity_id=$1',[c.co]);
    await reset();
  });
  await test('an import approved during setup does not strand the company, and links to itself',async()=>{
    /* Where the Plaid backfill and the trial-balance era really do overlap the
       handover dates: an approved period before SILO started posting the
       account can never be sent (card_posting_start_refusal refuses it), so
       "post it or reopen it" is impossible advice and counting it would block
       normal accounting for good. */
    const batch=randomUUID();
    await db.exec(batchSeedSql(c,batch));
    await as(c.finance,()=>q('select approve_card_import_batch($1)',[batch]));
    await denied(()=>save('qbo',null,0),'P0BM2');
    let listed=await as(c.finance,()=>q("select * from silo_handover_blockers() where kind='import'"));
    assert.equal(listed[0].blocks_handover,true);
    assert.ok(String(listed[0].review_path).includes(`transactions.html?batch=${batch}`),listed[0].review_path);
    assert.equal(listed[0].action_label,'Review this import');
    // The account comes under SILO later: the same import is now unsendable.
    await q("update card_sources set posting_start_on='2026-10-01' where id=$1",[c.source]);
    listed=await as(c.finance,()=>q("select * from silo_handover_blockers() where kind='import'"));
    assert.equal(listed[0].blocks_handover,false);
    assert.match(listed[0].reason,/Approved during setup/);
    await save('qbo',null,0);
    assert.equal((await state()).bookkeeping_mode,'qbo','setup history must not strand the company');
    assert.equal((await q('select status from card_import_batches where id=$1',[batch]))[0].status,'approved',
      'the import is left exactly as it is');
    await q('update card_sources set posting_start_on=null where id=$1',[c.source]);
    await reset();
    await as(c.finance,()=>q('select reopen_card_import_batch($1,$2)',[batch,'Synthetic cleanup']));
    await q('delete from card_transactions where batch_id=$1',[batch]);
    await q('delete from card_import_batches where id=$1',[batch]);
  });
  await test('the takeover window comes from the company row, and the floor agrees with the live posting start',async()=>{
    const window=async()=>(await q('select * from silo_takeover_window($1)',[c.co]))[0];
    assert.equal(day((await window()).earliest),'2026-08-01');
    assert.equal(day((await window()).latest),'2026-10-15');
    await q("update accounting_settings set takeover_earliest_on='2026-09-01',takeover_latest_on='2026-09-30' where company_entity_id=$1",[c.co]);
    assert.equal(day((await window()).earliest),'2026-09-01');
    await denied(()=>save('silo','2026-08-15',0),'22023');
    await denied(()=>save('silo','2026-10-01',0),'22023');
    await save('silo','2026-09-15',0);
    assert.equal(Number((await state()).bookkeeping_version),1);
    await q('update accounting_settings set takeover_earliest_on=null,takeover_latest_on=null where company_entity_id=$1',[c.co]);
    /* The floor silo_claim_blocks_handover uses mirrors the ELSE branch of
       silo_posting_start_for_source on purpose: the whole function answers
       infinity in reporting-only, which would make every claim look
       pre-takeover exactly when the question is asked. In 'silo' mode the two
       must agree, or the claim and the ledger disagree about one date. */
    await save('silo',null,1);
    const live=(await q('select silo_posting_start_for_source(s.*) as d from card_sources s where s.id=$1',[c.source]))[0].d;
    assert.equal(day(live),'2026-08-01','the floor is the books start when no later date is set');
    const batch=randomUUID(); await db.exec(batchSeedSql(c,batch));
    await as(c.finance,()=>q('select approve_card_import_batch($1)',[batch]));
    const listed=await as(c.finance,()=>q("select * from silo_handover_blockers() where kind='import'"));
    assert.equal(listed[0].blocks_handover,true,"an import whose activity is on or after the posting start is SILO's to send");
    await as(c.finance,()=>q('select reopen_card_import_batch($1,$2)',[batch,'Synthetic cleanup']));
    await q('delete from card_transactions where batch_id=$1',[batch]);
    await q('delete from card_import_batches where id=$1',[batch]);
    await reset();
  });
  await test('a claim moved back into submitting after a reapproval is refused by the approval match',async()=>{
    /* The gap the sibling guards leave if they stay INSERT-only: the mode
       guard would pass this row while the approval it claims no longer
       exists. Finance approval remains the authority -- a claim that still
       matches its approval is not slowed down by any of this. */
    const batch=randomUUID(); await db.exec(batchSeedSql(c,batch));
    await as(c.finance,()=>q('select approve_card_import_batch($1)',[batch]));
    const first=(await q('select approval_hash,approval_snapshot from card_import_batches where id=$1',[batch]))[0];
    const id=randomUUID();
    await db.exec(claimSql(c,{source:'card_import',status:'failed',id,sourceRef:batch,hash:first.approval_hash,payload:first.approval_snapshot.payload}));
    await as(c.finance,()=>q('select reopen_card_import_batch($1,$2)',[batch,'Reviewed again before sending']));
    // Recoded while it was open: this is the entry nobody now approves.
    await q("update card_transactions set qbo_account_id='bank',qbo_account_name='Bank' where batch_id=$1",[batch]);
    await as(c.finance,()=>q('select approve_card_import_batch($1)',[batch]));
    const again=(await q('select approval_hash from card_import_batches where id=$1',[batch]))[0];
    assert.notEqual(again.approval_hash,first.approval_hash,'reapproval must move the hash');
    await denied(()=>q("update quickbooks_journal_postings set status='submitting' where id=$1",[id]),'P0OD1');
    assert.equal((await q('select status from quickbooks_journal_postings where id=$1',[id]))[0].status,'failed');
    await q('delete from quickbooks_journal_postings where id=$1',[id]);
  });
  await test('the production schema check agrees with this migration: both blocks read ok',async()=>{
    /* Nothing else runs these before production does, so a check that no
       longer matches the migration first shows up as a red drift run. */
    await reset();
    const verify=await readFile(new URL('supabase/verify_v2_schema.sql',root),'utf8');
    for (const name of ['Bookkeeping mode','Bookkeeping checked transition safety']) {
      const from=verify.indexOf(`select '${name}' as check_name`);
      assert.ok(from>=0,`the ${name} check exists`);
      const statement=verify.slice(from,verify.indexOf(';\n',from)+1);
      assert.equal((await q(statement))[0].status,'ok',name);
    }
  });
  console.log(`\n${passed} bookkeeping transition database tests passed.`);
} finally { await db.close(); }
