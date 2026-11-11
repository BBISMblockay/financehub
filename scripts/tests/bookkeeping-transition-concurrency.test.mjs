// Real PostgreSQL sessions only. PGlite cannot establish this locking evidence.
// Point SILO_PG_CONN at a disposable LOCAL server with CREATE DATABASE permission.
// Creates/drops ONLY its uniquely named synthetic database. No DATABASE_URL fallback.
// SILO_PG_REQUIRED=1 makes unavailable PostgreSQL fail CI instead of skipping.
// BOOKKEEPING_TRANSITION_MUTATION=claim-lock-removed|mode-lock-removed
//   |stale-version-bypass|trigger-order-first must fail this suite.
// BOOKKEEPING_TRANSITION_RACE_ONLY=1..8 isolates each race for mutation evidence. Locks are observed through
// pg_stat_activity, never inferred from a sleep or a single-connection test.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from './finance-db/node_modules/pg/lib/index.js';
import { baseSql, transitionSql, fixtureIds, seedSql, claimSql, batchSeedSql } from './bookkeeping-transition-fixture.mjs';
const { Client } = pg;
function skip(reason) {
  if (process.env.SILO_PG_REQUIRED==='1') throw new Error(`PostgreSQL required: ${reason}`);
  console.log(`SKIP bookkeeping transition concurrency: ${reason}`); process.exit(0);
}
if (!process.env.SILO_PG_CONN) skip('set SILO_PG_CONN to a disposable local PostgreSQL');
const url=new URL(process.env.SILO_PG_CONN);
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname), 'Synthetic race tests refuse non-local PostgreSQL hosts');
const admin=new Client({connectionString:url.href,connectionTimeoutMillis:5000});
try { await admin.connect(); } catch(e) { skip(e.message); }
const name=`bookkeeping_transition_${randomUUID().replaceAll('-','')}`;
const databaseUrl=new URL(url); databaseUrl.pathname=`/${name}`;
const sessions=[];
async function connect(application_name) {
  const s=new Client({connectionString:databaseUrl.href,application_name,connectionTimeoutMillis:5000,statement_timeout:10000});
  await s.connect(); sessions.push(s); return s;
}
let passed=0, caseNumber=0;
const only=process.env.BOOKKEEPING_TRANSITION_RACE_ONLY;
assert.ok(!only || /^[1-8]$/.test(only), 'BOOKKEEPING_TRANSITION_RACE_ONLY must be 1..8');
async function test(title, fn) { caseNumber++; if(only && Number(only)!==caseNumber) return; await fn(); console.log(`ok ${++passed} - ${title}`); }
const c=fixtureIds();
let created=false;
try {
  await admin.query(`create database ${name}`); created=true;
  const ctl=await connect('transition-ctl');
  const base=(await baseSql()).replace(/create role (\w+) ([^;]*);/g,(_,role,opts)=>`do $r$ begin create role ${role} ${opts}; exception when duplicate_object then null; end $r$;`);
  await ctl.query(base); await ctl.query(await transitionSql()); await ctl.query(seedSql(c));
  const a=await connect('transition-a'), b=await connect('transition-b'), observer=await connect('transition-observer');
  const user=async(s,id=c.finance)=>{await s.query("select set_config('request.jwt.claim.sub',$1,false)",[id]); await s.query('set role authenticated');};
  await user(a); await user(b);
  const save=(s,mode='qbo',version=0)=>s.query('select * from set_bookkeeping_mode_checked($1,null,$2,$3)',[mode,c.co,version]);
  const reset=()=>ctl.query(`delete from quickbooks_journal_postings; update accounting_settings set bookkeeping_mode='silo',silo_takeover_on=null,bookkeeping_version=0;`);
  const state=async()=> (await ctl.query('select bookkeeping_mode,bookkeeping_version,books_authority from accounting_settings where company_entity_id=$1',[c.co])).rows[0];
  const result=p=>p.then(value=>({value}),error=>({error}));
  async function blocked(app) {
    for(let i=0;i<100;i++) {
      const rows=(await observer.query("select wait_event from pg_stat_activity where datname=$1 and application_name=$2 and wait_event_type='Lock'",[name,app])).rows;
      if(rows.length) return rows[0].wait_event;
      await new Promise(r=>setTimeout(r,25));
    }
    return null;
  }
  await test('claim first: mode switch waits then refuses the committed submitting claim',async()=>{
    await ctl.query('begin');
    await ctl.query(claimSql(c));
    const pending=result(save(a));
    const waited=await blocked('transition-a');
    await ctl.query('commit');
    const outcome=await pending;
    assert.equal(waited,'advisory','mode handover did not wait for claim transaction');
    assert.equal(outcome.error?.code,'P0BM3');
    assert.deepEqual(await state(),{bookkeeping_mode:'silo',bookkeeping_version:'0',books_authority:'qbo'});
    await reset();
  });
  await test('mode first: new claim waits then reads committed qbo mode and is refused',async()=>{
    await a.query('begin'); await save(a);
    await b.query('reset role');
    const pending=result(b.query(claimSql(c)));
    const waited=await blocked('transition-b');
    await a.query('commit');
    const outcome=await pending;
    assert.equal(waited,'advisory'); assert.equal(outcome.error?.code,'P0PS2');
    assert.equal((await ctl.query('select count(*) from quickbooks_journal_postings')).rows[0].count,'0');
    assert.equal((await state()).bookkeeping_mode,'qbo');
    await user(b); await reset();
  });
  await test('mode first: terminal claim retry UPDATE also waits and cannot send',async()=>{
    const id=randomUUID(); await ctl.query(claimSql(c,{id,status:'failed'}));
    await a.query('begin'); await save(a);
    await b.query('reset role');
    const pending=result(b.query("update quickbooks_journal_postings set status='submitting' where id=$1",[id]));
    const waited=await blocked('transition-b');
    await a.query('commit'); const outcome=await pending;
    assert.equal(waited,'advisory'); assert.equal(outcome.error?.code,'P0PS2');
    assert.equal((await ctl.query('select status from quickbooks_journal_postings where id=$1',[id])).rows[0].status,'failed');
    await user(b); await reset();
  });
  await test('two editors with same expected version: exactly one commits, loser reloads',async()=>{
    await a.query('begin'); await save(a);
    const pending=result(save(b,'silo',0));
    const waited=await blocked('transition-b');
    await a.query('commit'); const outcome=await pending;
    assert.equal(waited,'advisory'); assert.equal(outcome.error?.code,'P0BM4');
    assert.deepEqual(await state(),{bookkeeping_mode:'qbo',bookkeeping_version:'1',books_authority:'qbo'});
    await reset();
  });
  for (const plaid of [false,true]) for (const stale of [false,true]) {
    await test(`${plaid?'Plaid account→batch':'Card batch'} claim vs reapproval: ${stale?'stale snapshot refused':'matching snapshot accepted'} without deadlock`,async()=>{
      const batch=randomUUID(), plaidConnection=randomUUID(), plaidAccount=randomUUID();
      if(plaid) await ctl.query(`insert into plaid_connections(id,company_entity_id,item_id,environment) values ('${plaidConnection}','${c.co}','${plaidConnection}','sandbox');
        insert into plaid_accounts(id,company_entity_id,connection_id,provider_account_id,name,type,source_id)
        values ('${plaidAccount}','${c.co}','${plaidConnection}','synthetic','Bank','depository','${c.source}');`);
      await ctl.query(batchSeedSql(c,batch));
      await a.query('select approve_card_import_batch($1)',[batch]);
      const snapshot=(await ctl.query('select approval_hash,approval_snapshot from card_import_batches where id=$1',[batch])).rows[0];
      await a.query('begin');
      // This is the production reopen→reapprove path, with the batch row held.
      await a.query('select reopen_card_import_batch($1,$2)',[batch,'Synthetic reapproval race']);
      if(stale) await a.query("update card_import_batches set label='Changed review' where id=$1",[batch]);
      await b.query('reset role');
      const pending=result(b.query(claimSql(c,{source:'card_import',sourceRef:batch,hash:snapshot.approval_hash,payload:snapshot.approval_snapshot.payload})));
      const waited=await blocked('transition-b');
      const approved=await result(a.query('select approve_card_import_batch($1)',[batch]));
      await a.query(approved.error?'rollback':'commit');
      const claimed=await pending;
      assert.ok(waited,'claim must wait on the batch held by reapproval');
      assert.equal(approved.error,undefined,`reapproval failed: ${approved.error?.code} ${approved.error?.message}`);
      if(stale) {
        assert.equal(claimed.error?.code,plaid?'P0001':'P0OD1',claimed.error?.message);
        assert.match(claimed.error.message,plaid?/match the approved bank batch/:/approved entry changed/);
      } else assert.equal(claimed.error,undefined,`claim failed: ${claimed.error?.code} ${claimed.error?.message}`);
      assert.equal((await ctl.query('select count(*) from quickbooks_journal_postings where source_ref=$1',[batch])).rows[0].count,stale?'0':'1');
      await reset();
      await a.query('select reopen_card_import_batch($1,$2)',[batch,'Synthetic cleanup']);
      await ctl.query('delete from card_transactions where batch_id=$1',[batch]);
      await ctl.query('delete from card_import_batches where id=$1',[batch]);
      if(plaid) { await ctl.query('delete from plaid_accounts where id=$1',[plaidAccount]); await ctl.query('delete from plaid_connections where id=$1',[plaidConnection]); }
      await user(b);
    });
  }
  console.log(`\n${passed} bookkeeping transition races passed against real PostgreSQL.`);
} finally {
  await Promise.all(sessions.map(s=>s.end().catch(()=>{})));
  if(created) await admin.query(`drop database ${name} with (force)`);
  await admin.end();
}
