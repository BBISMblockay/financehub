// LOCAL SYNTHETIC ONLY. Actual finance migrations; auth/catalog fixtures match the existing mode suite.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export const root = new URL('../../', import.meta.url);
export const dependencies = [
  '20260826070000_quickbooks_integration.sql', '20260826090000_quickbooks_locations.sql', '20260827210000_quickbooks_reports.sql',
  '20260831180000_card_coding.sql', '20260831190000_card_name_and_holder.sql', '20260831200000_qbo_entities_and_line_entity.sql',
  '20260831210000_apply_card_coding_rpc.sql', '20260831220000_void_card_posting.sql', '20260831230000_rule_hits_and_conflicts.sql',
  '20260901000000_journal_adjustments.sql', '20260901010000_void_journal_adjustment.sql',
  '20260901020000_posted_status_not_client_writable.sql', '20260912000000_finance_v1_posting_controls.sql',
  '20260912052930_plaid_bank_feed.sql', '20260912203725_bank_feed_workspace_history.sql', '20260912231606_accounting_foundation.sql',
  '20260913022606_qbo_historical_ledger.sql', '20260915100000_card_transaction_splits.sql', '20260915220000_plaid_removed_from_status.sql',
  '20260923120000_card_coding_suggestions.sql', '20260923130000_card_coding_background_preparation.sql',
  '20260923140000_card_coding_evidence_and_rules.sql',
];
export const afterwards = [
  '20261004120000_on_deck_coding_review.sql',
  '20261005120000_silo_daily_ledger.sql', '20261007180000_card_import_entity_kind_on_approve.sql',
  '20261015020000_card_posting_start.sql',
];

export const stubs = `
create or replace function public.attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
                 create or replace function public.silo_business_today() returns date language sql stable as $$ select date '2026-10-15' $$;

    create table public.on_deck_proposals(id uuid primary key default gen_random_uuid(), company_entity_id uuid not null, status text not null);
    alter table public.on_deck_proposals enable row level security;
    create function public.on_deck_can_review() returns boolean language sql stable security definer set search_path='' as $$
      select exists(select 1 from public.profiles p join public.entity_memberships m on m.user_id=p.id
        where p.id=auth.uid() and p.is_active and m.entity_id=public.active_company_id() and m.role in ('owner_admin','admin')) $$;
    create policy on_deck_read on public.on_deck_proposals for select to authenticated
      using (company_entity_id = public.active_company_id() and public.on_deck_can_review());
    grant select on public.on_deck_proposals to authenticated;
`;
export async function migrationSql(name) { return readFile(new URL('supabase/migrations/' + name, root), 'utf8'); }
export async function baseSql() {
  const bootstrap = await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8');
  return [bootstrap, ...await Promise.all(dependencies.map(migrationSql)), stubs,
    ...await Promise.all(afterwards.map(migrationSql)), await migrationSql('20261015190000_bookkeeping_mode.sql')].join('\n');
}
export function fixtureIds() { return Object.fromEntries(['co','other','empty','finance','member','admin','otherFinance','emptyFinance','conn','otherConn','source'].map(k => [k,randomUUID()])); }
export function seedSql(c) {
  return `insert into entities(id,title) values ('${c.co}','A'),('${c.other}','B'),('${c.empty}','Empty');
  insert into auth.users(id) values ('${c.finance}'),('${c.member}'),('${c.admin}'),('${c.otherFinance}'),('${c.emptyFinance}');
  insert into profiles(id,name,role,department,active_company_id) values
  ('${c.finance}','Finance','user','finance','${c.co}'),('${c.member}','Member','user','marketing','${c.co}'),
  ('${c.admin}','Ordinary admin','admin','marketing','${c.co}'),('${c.otherFinance}','Other finance','user','finance','${c.other}'),
  ('${c.emptyFinance}','Empty finance','user','finance','${c.empty}');
  insert into entity_memberships(entity_id,user_id,role) values
  ('${c.co}','${c.finance}','member'),('${c.co}','${c.member}','member'),('${c.co}','${c.admin}','admin'),
  ('${c.other}','${c.otherFinance}','member'),('${c.empty}','${c.emptyFinance}','member');
  insert into quickbooks_connections(id,company_entity_id,realm_id,access_token) values ('${c.conn}','${c.co}','synthetic-a','x'),('${c.otherConn}','${c.other}','synthetic-b','x');
  insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values ('${c.co}','${c.conn}','bank','Bank','Bank',true),('${c.co}','${c.conn}','supplies','Supplies','Expense',true);
  insert into accounting_settings(company_entity_id,qbo_connection_id,base_currency,fiscal_year_start_month,accounting_start_date,accounting_basis)
  values ('${c.co}','${c.conn}','USD',1,'2026-08-01','Accrual'),('${c.other}','${c.otherConn}','USD',1,'2026-08-01','Accrual');
  insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active,posting_enabled)
  values ('${c.source}','${c.co}','${c.conn}','synthetic','Synthetic bank','bank','bank','bank',true,true);`;
}
export function claimSql(c, { status='submitting', source='journal_entry', id=randomUUID(), company=c.co, connection=c.conn, sourceRef=randomUUID(), hash='h', payload={}, periodStart=null, periodEnd=null }={}) {
  const date = (value) => (value ? `'${value}'` : 'null');
  return `insert into quickbooks_journal_postings(id,company_entity_id,connection_id,source,source_ref,status,payload,request_key,payload_hash,period_start,period_end)
  values ('${id}','${company}','${connection}','${source}','${sourceRef}','${status}','${JSON.stringify(payload).replaceAll("'","''")}','${randomUUID()}','${hash}',${date(periodStart)},${date(periodEnd)});`;
}

export async function transitionSql() {
  let sql=await migrationSql('20261111201400_bookkeeping_transition_safety.sql');
  const mutations = {
    'trigger-order-first': ['create trigger zz_bookkeeping_mode_claim', 'create trigger bookkeeping_mode_claim'],
    'claim-lock-removed': ['  perform public.bookkeeping_mode_lock(new.company_entity_id);', ''],
    'mode-lock-removed': ['  perform public.bookkeeping_mode_lock(v_company);', ''],
    'claim-check-removed': ["  if coalesce(v_mode, 'silo') <> 'qbo' then return new; end if;", '  return new;'],
    'stale-version-bypass': ['if p_expected_version is null or p_expected_version <> v_row.bookkeeping_version then', 'if false then'],
    'company-boundary-bypass': ['if p_company is null or p_company <> v_company then', 'if false then'],
    'date-bypass': ['    if not isfinite(v_takeover) or v_takeover > v_window.latest or v_takeover < v_window.earliest then', '    if false then'],
    // The configurable bounds are ignored and the old fixed rule is restored.
    'window-not-configurable': ['  select coalesce(st.takeover_earliest_on, st.accounting_start_date),\n         coalesce(st.takeover_latest_on, public.silo_business_today())',
      '  select st.accounting_start_date, public.silo_business_today()'],
    'pending-claims-ignored': ['       and public.silo_claim_blocks_handover(p.*) is not null;', '       and false;'],
    // Everything open blocks again, including the pre-takeover history the
    // approval trigger can no longer produce a send for.
    // A date test is put back into the in-progress question, so moving the
    // takeover date forward silently stops a live send from blocking.
    'claim-judged-by-date': ["  select case p_claim.status when 'submitting' then 'sending' when 'unknown' then 'unknown' end;", "  select case when p_claim.period_end < (select coalesce(st.silo_takeover_on, st.accounting_start_date) from public.accounting_settings st where st.company_entity_id = p_claim.company_entity_id) then null else case p_claim.status when 'submitting' then 'sending' when 'unknown' then 'unknown' end end;"],
    // Setup imports count again, so a company that approved a pre-cut-over
    // period during setup can never hand the books back.
    'setup-imports-block': ['  if v_last < v_floor then return null; end if;', ''],
    'update-guard-removed': ['create trigger zz_bookkeeping_mode_claim before insert or update of status', 'create trigger zz_bookkeeping_mode_claim before insert'],
    // The three sibling guards go back to covering INSERT only, so a row moved
    // back into submitting skips the approval match, the posting start date and
    // the open bank feed exception.
    'sibling-guards-insert-only': ['create trigger qbo_card_claim_matches_approval before insert or update of status', 'create trigger qbo_card_claim_matches_approval before insert'],
  };
  const mutation=process.env.BOOKKEEPING_TRANSITION_MUTATION || '';
  if(mutation) {
    assert.ok(mutations[mutation], `Unknown mutation ${mutation}`);
    const [from,to]=mutations[mutation];
    assert.ok(sql.includes(from), `Mutation ${mutation} is stale`);
    sql=sql.replace(from,to);
    if(mutation==='trigger-order-first') sql=sql.replace('drop trigger if exists zz_bookkeeping_mode_claim', 'drop trigger if exists bookkeeping_mode_claim');
  }
  return sql;
}

export function batchSeedSql(c, id) {
  return `insert into card_import_batches(id,company_entity_id,source_id,label,entry_date,period_start,period_end,status,origin,qbo_connection_id)
    values ('${id}','${c.co}','${c.source}','Real approval','2026-09-30','2026-09-01','2026-09-30','draft','csv','${c.conn}');
    insert into card_transactions(company_entity_id,batch_id,row_no,txn_date,description,merchant,clean_merchant,card_name,amount,currency,status,qbo_account_id,qbo_account_name,coding_source)
    values ('${c.co}','${id}',1,'2026-09-10','OFFICE DEPOT','OFFICE DEPOT','Office Depot','Ops',42,'USD','coded','supplies','Supplies','manual');`;
}
