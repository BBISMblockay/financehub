// Measures archive_qbo_ledger against synthetic reports on a REAL PostgreSQL
// server (PGlite cannot enforce statement_timeout and runs several times
// slower than a server, so it is the wrong instrument for a timing claim).
// Not run in CI. Needs psql on PATH and a superuser connection in PGHOST /
// PGPORT / PGUSER; builds a throwaway database from the repository's own
// finance bootstrap and migrations, seeds one company, then times the RPC as
// a finance user for each requested row count.
//
//   PGHOST=/home/pgtest PGPORT=54329 PGUSER=postgres \
//     node scripts/tests/qbo-history-benchmark.mjs --rows 2000,4000,8000 [--after] [--batch 5000] [--lock-probe]
//
// --after applies every qbo_history migration in the repository (the bounded
// archive); without it the build stops at 20260914220000, the function that
// timed out in production, so "before" and "after" come from one harness.
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { generateLedgerPair } from './fixtures/qbo-ledger-generator.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const rowsList = String(opt('--rows', '2000,4000,8000')).split(',').map(Number);
const after = args.includes('--after');
const lockProbe = args.includes('--lock-probe');
const batch = opt('--batch', null);
const dbName = process.env.BENCH_DB || 'qbo_history_bench';
const root = new URL('../../', import.meta.url).pathname;

function psql(sql, { db = dbName, timing = false } = {}) {
  const r = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, ...(timing ? ['-c', '\\timing on'] : []), '-c', sql], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout + r.stderr;
}
function psqlFile(path, db = dbName) {
  const r = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', path], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${path}: ${r.stderr}`);
}

const dependencies = [
  '20260826070000_quickbooks_integration.sql', '20260826090000_quickbooks_locations.sql', '20260827210000_quickbooks_reports.sql',
  '20260831180000_card_coding.sql', '20260831190000_card_name_and_holder.sql', '20260831200000_qbo_entities_and_line_entity.sql',
  '20260831210000_apply_card_coding_rpc.sql', '20260831220000_void_card_posting.sql', '20260831230000_rule_hits_and_conflicts.sql',
  '20260901000000_journal_adjustments.sql', '20260901010000_void_journal_adjustment.sql', '20260901020000_posted_status_not_client_writable.sql',
  '20260912000000_finance_v1_posting_controls.sql', '20260912052930_plaid_bank_feed.sql', '20260912203725_bank_feed_workspace_history.sql',
  '20260912231606_accounting_foundation.sql', '20260913022606_qbo_historical_ledger.sql', '20260914220000_qbo_history_number_formats.sql',
];
const afterMigrations = ['20260915000000_qbo_history_bounded_archive.sql'];

psql(`drop database if exists ${dbName}`, { db: 'postgres' });
psql(`create database ${dbName}`, { db: 'postgres' });
// Roles are cluster-wide on a real server: create them once, then apply the
// bootstrap without its role lines so a second database on the same server works.
psql(`do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;`, { db: 'postgres' });
const bootstrapPath = `${process.env.HOME || '/tmp'}/qbo-bench-bootstrap.sql`;
writeFileSync(bootstrapPath, readFileSync(`${root}scripts/tests/finance-db/bootstrap.sql`, 'utf8').split('\n').filter((l) => !/^create role /.test(l)).join('\n'));
psqlFile(bootstrapPath);
for (const m of [...dependencies, ...(after ? afterMigrations : [])]) psqlFile(`${root}supabase/migrations/${m}`);

const co = randomUUID(), finance = randomUUID(), conn = randomUUID();
psql(`insert into entities(id,title) values('${co}','Bench');
insert into auth.users(id) values('${finance}');
insert into profiles(id,name,role,department,active_company_id) values('${finance}','F','user','finance','${co}');
insert into entity_memberships(entity_id,user_id,role) values('${co}','${finance}','member');
insert into quickbooks_connections(id,company_entity_id,realm_id,access_token) values('${conn}','${co}','r','secret');
insert into accounting_settings(company_entity_id,qbo_connection_id,base_currency,fiscal_year_start_month,accounting_start_date,accounting_basis) values('${co}','${conn}','USD',1,'2026-09-01','Accrual');`);

// Files the server can read: pg_read_file needs a path the postgres OS user can open.
const dir = process.env.BENCH_DIR || mkdtempSync(`${process.env.HOME || '/tmp'}/qbo-bench-`);
mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o755);
const asFinance = (sql) => `set role authenticated; select set_config('request.jwt.claim.sub','${finance}',false); ${batch ? `select set_config('silo.qbo_archive_batch_rows','${batch}',false);` : ''} ${sql}`;

const results = [];
for (const rows of rowsList) {
  const { gl, tb, accounts, expected } = generateLedgerPair({ rows, seed: rows });
  const glPath = `${dir}/gl-${rows}.json`, tbPath = `${dir}/tb-${rows}.json`;
  writeFileSync(glPath, JSON.stringify(gl)); writeFileSync(tbPath, JSON.stringify(tb)); chmodSync(glPath, 0o644); chmodSync(tbPath, 0o644);
  const glRun = randomUUID(), tbRun = randomUUID();
  psql(`insert into accounting_accounts(company_entity_id,qbo_connection_id,qbo_account_id,name,account_type,is_active,source_snapshot)
    select '${co}','${conn}',x.qbo_account_id,x.name,x.account_type,true,'{}' from jsonb_to_recordset('${JSON.stringify(accounts).replace(/'/g, "''")}'::jsonb) as x(qbo_account_id text,name text,account_type text)
    on conflict do nothing;
    insert into quickbooks_report_runs(id,company_entity_id,connection_id,report_name,start_date,end_date,raw_response,status,params)
    values('${glRun}','${co}','${conn}','GeneralLedger','${gl.Header.StartPeriod}','${gl.Header.EndPeriod}',pg_read_file('${glPath}')::jsonb,'ok','{}'),
          ('${tbRun}','${co}','${conn}','TrialBalance','${gl.Header.StartPeriod}','${gl.Header.EndPeriod}',pg_read_file('${tbPath}')::jsonb,'ok','{}');`);
  let calls = 0, ms = 0, out = null, err = null;
  const callMs = [];
  const t0 = Date.now();
  // The bounded archive returns status=in_progress until done; the original
  // returns the archive on its only call. Loop either way and count calls.
  for (;;) {
    calls += 1;
    let text;
    const tc = Date.now();
    try { text = psql(asFinance(`select archive_qbo_ledger('${glRun}','${tbRun}')::text;`)); }
    catch (e) { err = String(e.message).split('\n')[0]; break; }
    finally { callMs.push(Date.now() - tc); }
    const m = text.match(/\{.*\}/s); out = m ? JSON.parse(m[0]) : null;
    if (!out || out.status !== 'in_progress') break;
    if (calls > 5000) { err = 'did not complete'; break; }
  }
  ms = Date.now() - t0;
  let lockWaitMs = null;
  if (lockProbe && !err) {
    // A second session wanting the company row while a fresh archive runs:
    // how long is it blocked? (Only meaningful with a long "before" run.)
    const glRun2 = randomUUID(), tbRun2 = randomUUID();
    psql(`insert into quickbooks_report_runs(id,company_entity_id,connection_id,report_name,start_date,end_date,raw_response,status,params)
      select '${glRun2}',company_entity_id,connection_id,report_name,start_date,end_date,raw_response || jsonb_build_object('bench_copy',2),status,params from quickbooks_report_runs where id='${glRun}';
      insert into quickbooks_report_runs(id,company_entity_id,connection_id,report_name,start_date,end_date,raw_response,status,params)
      select '${tbRun2}',company_entity_id,connection_id,report_name,start_date,end_date,raw_response,status,params from quickbooks_report_runs where id='${tbRun}';`);
    const bg = spawn('psql', ['-X', '-q', '-d', dbName, '-c', asFinance(`select archive_qbo_ledger('${glRun2}','${tbRun2}')::text;`)], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 400));
    const t1 = Date.now();
    try { psql(`select 1 from entities where id='${co}' for update;`); } catch {}
    lockWaitMs = Date.now() - t1;
    await new Promise((r) => bg.on('exit', r));
  }
  const counts = err ? null : psql(`select (select count(*) from qbo_history_lines l join qbo_history_imports i on i.id=l.import_id where i.gl_run_id='${glRun}') lines,
    (select transaction_count from qbo_history_imports where gl_run_id='${glRun}') txns,(select reconciliation_status from qbo_history_imports where gl_run_id='${glRun}') recon;`);
  results.push({ rows, expectedLines: expected.lineRows, glMB: (JSON.stringify(gl).length / 1048576).toFixed(1), calls, ms, sec: (ms / 1000).toFixed(1), maxCallMs: Math.max(...callMs), firstCallMs: callMs[0], lastCallMs: callMs.at(-1), result: err || (out && (out.status === 'failed' ? `failed: ${out.error}` : out.status || 'complete')), stored: counts ? counts.replace(/\s+/g, ' ').trim() : null, lockWaitMs });
  console.log(JSON.stringify(results.at(-1)));
}
console.table(results);
