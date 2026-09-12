-- Finance V1 prerequisites: server-owned approval snapshots, immutable approved
-- inputs, explicit QBO connection binding, durable posting claims/recovery, and
-- stable accounting-source identity for generated journal entries.

create extension if not exists pgcrypto with schema extensions;

alter table public.card_sources
  add column if not exists qbo_connection_id uuid;

alter table public.card_import_batches
  add column if not exists qbo_connection_id uuid,
  add column if not exists approval_version bigint not null default 0,
  add column if not exists approval_snapshot jsonb,
  add column if not exists approval_hash text,
  add column if not exists approval_reopened_at timestamptz,
  add column if not exists approval_reopened_by uuid references auth.users(id) on delete set null,
  add column if not exists approval_reopen_reason text;

alter table public.journal_adjustments
  add column if not exists qbo_connection_id uuid,
  add column if not exists accounting_source text,
  add column if not exists accounting_source_ref text,
  add column if not exists approval_version bigint not null default 0,
  add column if not exists approval_snapshot jsonb,
  add column if not exists approval_hash text,
  add column if not exists approval_reopened_at timestamptz,
  add column if not exists approval_reopened_by uuid references auth.users(id) on delete set null,
  add column if not exists approval_reopen_reason text;

alter table public.quickbooks_journal_postings
  add column if not exists request_key text,
  add column if not exists payload_hash text,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists confirmed_at timestamptz,
  add column if not exists recovery_note text;

-- Bind legacy rows only when the tenant has exactly one active connection.
-- An ambiguous tenant is deliberately left null and approval refuses it.
with only_connection as (
  select company_entity_id, (array_agg(id order by id))[1] as id
  from public.quickbooks_connections
  where is_active
  group by company_entity_id
  having count(*) = 1
)
update public.card_sources s
set qbo_connection_id = c.id
from only_connection c
where s.company_entity_id = c.company_entity_id
  and s.qbo_connection_id is null;

update public.card_import_batches b
set qbo_connection_id = s.qbo_connection_id
from public.card_sources s
where s.id = b.source_id
  and s.company_entity_id = b.company_entity_id
  and b.qbo_connection_id is null;

with only_connection as (
  select company_entity_id, (array_agg(id order by id))[1] as id
  from public.quickbooks_connections
  where is_active
  group by company_entity_id
  having count(*) = 1
)
update public.journal_adjustments a
set qbo_connection_id = c.id
from only_connection c
where a.company_entity_id = c.company_entity_id
  and a.qbo_connection_id is null;

with only_connection as (
  select company_entity_id, (array_agg(id order by id))[1] as id
  from public.quickbooks_connections
  where is_active
  group by company_entity_id
  having count(*) = 1
)
update public.quickbooks_journal_postings p
set connection_id = c.id
from only_connection c
where p.company_entity_id = c.company_entity_id
  and p.connection_id is null;

create unique index if not exists uq_quickbooks_connections_id_company
  on public.quickbooks_connections (id, company_entity_id);
create unique index if not exists uq_card_sources_id_company
  on public.card_sources (id, company_entity_id);
create unique index if not exists uq_card_batches_id_company
  on public.card_import_batches (id, company_entity_id);
create unique index if not exists uq_journal_adjustments_id_company
  on public.journal_adjustments (id, company_entity_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'card_sources_qbo_connection_company_fkey') then
    alter table public.card_sources add constraint card_sources_qbo_connection_company_fkey
      foreign key (qbo_connection_id, company_entity_id)
      references public.quickbooks_connections (id, company_entity_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'card_batches_source_company_fkey') then
    alter table public.card_import_batches add constraint card_batches_source_company_fkey
      foreign key (source_id, company_entity_id)
      references public.card_sources (id, company_entity_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'card_batches_qbo_connection_company_fkey') then
    alter table public.card_import_batches add constraint card_batches_qbo_connection_company_fkey
      foreign key (qbo_connection_id, company_entity_id)
      references public.quickbooks_connections (id, company_entity_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'card_transactions_batch_company_fkey') then
    alter table public.card_transactions add constraint card_transactions_batch_company_fkey
      foreign key (batch_id, company_entity_id)
      references public.card_import_batches (id, company_entity_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'journal_adjustments_qbo_connection_company_fkey') then
    alter table public.journal_adjustments add constraint journal_adjustments_qbo_connection_company_fkey
      foreign key (qbo_connection_id, company_entity_id)
      references public.quickbooks_connections (id, company_entity_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'journal_lines_adjustment_company_fkey') then
    alter table public.journal_adjustment_lines add constraint journal_lines_adjustment_company_fkey
      foreign key (adjustment_id, company_entity_id)
      references public.journal_adjustments (id, company_entity_id);
  end if;
end $$;

alter table public.quickbooks_journal_postings
  drop constraint if exists quickbooks_journal_postings_status_check;
alter table public.quickbooks_journal_postings
  add constraint quickbooks_journal_postings_status_check
  check (status in ('draft', 'submitting', 'unknown', 'posted', 'failed', 'voided'));

drop index if exists public.uq_quickbooks_postings_source_ref_posted;
create unique index if not exists uq_quickbooks_postings_active_claim
  on public.quickbooks_journal_postings
    (company_entity_id, source, source_ref)
  where status in ('submitting', 'unknown', 'posted');

create unique index if not exists uq_journal_adjustments_active_source
  on public.journal_adjustments (company_entity_id, accounting_source, accounting_source_ref)
  where accounting_source is not null
    and accounting_source_ref is not null
    and status in ('draft', 'approved', 'posted');

-- Approval is a privileged state transition, not a client-authored field edit.
drop policy if exists card_import_batches_write on public.card_import_batches;
drop policy if exists card_import_batches_insert on public.card_import_batches;
drop policy if exists card_import_batches_update_draft on public.card_import_batches;
drop policy if exists card_import_batches_delete_draft on public.card_import_batches;
create policy card_import_batches_insert on public.card_import_batches
  for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner())
    and status = 'draft'
    and approved_at is null and approved_by is null
    and approval_snapshot is null and approval_hash is null
  );
create policy card_import_batches_update_draft on public.card_import_batches
  for update to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner())
    and status in ('draft', 'categorized')
  )
  with check (
    company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner())
    and status in ('draft', 'categorized')
    and approved_at is null and approved_by is null
    and approval_snapshot is null and approval_hash is null
  );
create policy card_import_batches_delete_draft on public.card_import_batches
  for delete to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner())
    and status in ('draft', 'categorized')
  );

drop policy if exists card_transactions_write on public.card_transactions;
drop policy if exists card_transactions_write_draft on public.card_transactions;
create policy card_transactions_write_draft on public.card_transactions
  for all to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner())
    and exists (
      select 1 from public.card_import_batches b
      where b.id = card_transactions.batch_id
        and b.company_entity_id = card_transactions.company_entity_id
        and b.status in ('draft', 'categorized')
    )
  )
  with check (
    company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner())
    and exists (
      select 1 from public.card_import_batches b
      where b.id = card_transactions.batch_id
        and b.company_entity_id = card_transactions.company_entity_id
        and b.status in ('draft', 'categorized')
    )
  );

drop policy if exists journal_adjustments_write on public.journal_adjustments;
drop policy if exists journal_adjustments_insert on public.journal_adjustments;
drop policy if exists journal_adjustments_update_draft on public.journal_adjustments;
drop policy if exists journal_adjustments_delete_draft on public.journal_adjustments;
create policy journal_adjustments_insert on public.journal_adjustments
  for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner())
    and status = 'draft'
    and approved_at is null and approved_by is null
    and approval_snapshot is null and approval_hash is null
  );
create policy journal_adjustments_update_draft on public.journal_adjustments
  for update to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner())
    and status = 'draft'
  )
  with check (
    company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner())
    and status = 'draft'
    and approved_at is null and approved_by is null
    and approval_snapshot is null and approval_hash is null
  );
create policy journal_adjustments_delete_draft on public.journal_adjustments
  for delete to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner())
    and status = 'draft'
  );

drop policy if exists journal_adjustment_lines_write on public.journal_adjustment_lines;
drop policy if exists journal_adjustment_lines_write_draft on public.journal_adjustment_lines;
create policy journal_adjustment_lines_write_draft on public.journal_adjustment_lines
  for all to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner())
    and exists (
      select 1 from public.journal_adjustments a
      where a.id = journal_adjustment_lines.adjustment_id
        and a.company_entity_id = journal_adjustment_lines.company_entity_id
        and a.status = 'draft'
    )
  )
  with check (
    company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner())
    and exists (
      select 1 from public.journal_adjustments a
      where a.id = journal_adjustment_lines.adjustment_id
        and a.company_entity_id = journal_adjustment_lines.company_entity_id
        and a.status = 'draft'
    )
  );

create or replace function public.finance_approval_snapshot_hash(p_snapshot jsonb)
returns text
language sql
immutable
security invoker
set search_path to 'extensions', 'pg_temp'
as $$
  select encode(extensions.digest(convert_to(p_snapshot::text, 'UTF8'), 'sha256'), 'hex');
$$;

revoke all on function public.finance_approval_snapshot_hash(jsonb) from public, anon;
grant execute on function public.finance_approval_snapshot_hash(jsonb) to authenticated, service_role;

-- Verify the stored jsonb value inside Postgres. Sending the snapshot through
-- JavaScript first loses numeric scale (35.00 -> 35) and changes jsonb::text's
-- hash despite unchanged accounting values. The caller supplies only the row
-- identity and revision it loaded, never a reserialized snapshot.
create or replace function public.finance_approval_hash_matches(
  p_source_type text,
  p_source_id uuid,
  p_expected_hash text,
  p_expected_version bigint
)
returns boolean
language plpgsql
stable
security invoker
set search_path to 'public', 'pg_temp'
as $$
begin
  if p_source_id is null or p_expected_hash is null or p_expected_version is null then
    return false;
  end if;
  if p_source_type = 'card_import_batches' then
    return exists (
      select 1 from public.card_import_batches b
      where b.id = p_source_id and b.status = 'approved'
        and b.approval_hash = p_expected_hash
        and b.approval_version = p_expected_version
        and b.approval_snapshot is not null
        and public.finance_approval_snapshot_hash(b.approval_snapshot) = b.approval_hash
    );
  elsif p_source_type = 'journal_adjustments' then
    return exists (
      select 1 from public.journal_adjustments a
      where a.id = p_source_id and a.status = 'approved'
        and a.approval_hash = p_expected_hash
        and a.approval_version = p_expected_version
        and a.approval_snapshot is not null
        and public.finance_approval_snapshot_hash(a.approval_snapshot) = a.approval_hash
    );
  end if;
  return false;
end;
$$;

-- Supabase default privileges include anon/authenticated; revoke both explicitly.
revoke all on function public.finance_approval_hash_matches(text, uuid, text, bigint)
  from public, anon, authenticated;
grant execute on function public.finance_approval_hash_matches(text, uuid, text, bigint)
  to service_role;

create or replace function public.approve_card_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid := public.active_company_id();
  v_batch public.card_import_batches%rowtype;
  v_source public.card_sources%rowtype;
  v_connection uuid;
  v_connection_count integer;
  v_balancing_type text;
  v_lines jsonb;
  v_net numeric(14,2);
  v_snapshot jsonb;
  v_hash text;
begin
  if v_user is null or v_company is null
     or not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then
    raise exception 'Finance access required';
  end if;

  select * into v_batch from public.card_import_batches
  where id = p_batch_id and company_entity_id = v_company for update;
  if not found then raise exception 'Batch not found'; end if;
  if v_batch.status = 'approved' and v_batch.approval_snapshot is not null
     and v_batch.approval_hash is not null then
    return jsonb_build_object('id', p_batch_id, 'approval_hash', v_batch.approval_hash,
      'approval_version', v_batch.approval_version, 'already_approved', true);
  end if;
  if v_batch.status not in ('draft', 'categorized') then
    raise exception 'Batch cannot be approved from status %', v_batch.status;
  end if;
  if v_batch.entry_date is null then raise exception 'Batch has no entry date'; end if;

  select * into v_source from public.card_sources
  where id = v_batch.source_id and company_entity_id = v_company;
  if not found or not v_source.is_active then raise exception 'Card source is not active'; end if;
  if not v_source.posting_enabled then raise exception 'Posting is disabled for this card source'; end if;

  v_connection := coalesce(v_source.qbo_connection_id, v_batch.qbo_connection_id);
  if v_connection is null then
    select count(*), (array_agg(id order by id))[1] into v_connection_count, v_connection
    from public.quickbooks_connections
    where company_entity_id = v_company and is_active;
    if v_connection_count <> 1 then
      raise exception 'Select one active QuickBooks connection before approval';
    end if;
  end if;
  if not exists (
    select 1 from public.quickbooks_connections
    where id = v_connection and company_entity_id = v_company and is_active
  ) then raise exception 'QuickBooks connection is not active for this company'; end if;

  if v_source.credit_qbo_account_id is null then raise exception 'Balancing account is required'; end if;
  select account_type into v_balancing_type
  from public.quickbooks_accounts
    where connection_id = v_connection and company_entity_id = v_company
      and qbo_account_id = v_source.credit_qbo_account_id and is_active;
  if not found then raise exception 'Balancing account is not active on the selected QuickBooks connection'; end if;

  if exists (select 1 from public.card_transactions where batch_id = p_batch_id and status = 'uncoded') then
    raise exception 'Every transaction must be coded or excluded before approval';
  end if;
  if not exists (select 1 from public.card_transactions where batch_id = p_batch_id and status = 'coded') then
    raise exception 'No coded transactions to approve';
  end if;
  if exists (
    select 1 from public.card_transactions t
    left join public.quickbooks_accounts a
      on a.connection_id = v_connection and a.company_entity_id = v_company
     and a.qbo_account_id = t.qbo_account_id and a.is_active
    where t.batch_id = p_batch_id and t.status = 'coded'
      and (t.qbo_account_id is null or a.id is null)
  ) then raise exception 'A coded line has an invalid QuickBooks account'; end if;
  if exists (
    select 1 from public.card_transactions t
    where t.batch_id = p_batch_id and t.status = 'coded'
      and t.qbo_location_id is not null
      and not exists (
        select 1 from public.quickbooks_locations l
        where l.connection_id = v_connection and l.company_entity_id = v_company
          and l.qbo_location_id = t.qbo_location_id and l.is_active
      )
  ) then raise exception 'A coded line has an invalid QuickBooks location'; end if;
  if exists (
    select 1 from public.card_transactions t
    join public.quickbooks_accounts a
      on a.connection_id = v_connection and a.company_entity_id = v_company
     and a.qbo_account_id = t.qbo_account_id
    where t.batch_id = p_batch_id and t.status = 'coded'
      and a.account_type in ('Accounts Receivable', 'Accounts Payable')
      and t.entity_qbo_id is null
  ) then raise exception 'Receivable and payable lines require an entity'; end if;
  if exists (
    select 1 from public.card_transactions t
    where t.batch_id = p_batch_id and t.status = 'coded'
      and ((t.entity_qbo_id is null) <> (t.entity_type is null))
  ) then raise exception 'Entity id and type must be supplied together'; end if;
  if exists (
    select 1 from public.card_transactions t
    where t.batch_id = p_batch_id and t.status = 'coded' and t.entity_qbo_id is not null
      and not (
        (t.entity_type = 'Customer' and exists (
          select 1 from public.quickbooks_customers e where e.connection_id = v_connection
            and e.company_entity_id = v_company and e.qbo_customer_id = t.entity_qbo_id and e.is_active
        )) or
        (t.entity_type = 'Vendor' and exists (
          select 1 from public.quickbooks_vendors e where e.connection_id = v_connection
            and e.company_entity_id = v_company and e.qbo_vendor_id = t.entity_qbo_id and e.is_active
        ))
      )
  ) then raise exception 'A coded line has an invalid QuickBooks entity'; end if;

  select coalesce(round(sum(round(t.amount, 2)), 2), 0),
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'DetailType', 'JournalEntryLineDetail',
           'Amount', abs(round(t.amount, 2)),
           'Description', left(concat_ws(' · ', t.txn_date::text, t.description), 4000),
           'JournalEntryLineDetail', jsonb_strip_nulls(jsonb_build_object(
             'PostingType', case when t.amount >= 0 then 'Debit' else 'Credit' end,
             'AccountRef', jsonb_build_object('value', t.qbo_account_id),
             'Entity', case when t.entity_qbo_id is not null then jsonb_build_object(
               'Type', t.entity_type, 'EntityRef', jsonb_build_object('value', t.entity_qbo_id)) end,
             'DepartmentRef', case when coalesce(t.qbo_location_id, v_source.default_qbo_location_id) is not null
               then jsonb_build_object('value', coalesce(t.qbo_location_id, v_source.default_qbo_location_id)) end
           ))
         )) order by t.row_no nulls last, t.id)
    into v_net, v_lines
  from public.card_transactions t
  where t.batch_id = p_batch_id and t.status = 'coded' and round(t.amount, 2) <> 0;
  if v_lines is null then raise exception 'Every coded transaction rounds to zero'; end if;

  if v_source.default_qbo_location_id is not null and not exists (
    select 1 from public.quickbooks_locations
    where connection_id = v_connection and company_entity_id = v_company
      and qbo_location_id = v_source.default_qbo_location_id and is_active
  ) then raise exception 'Default location is not active on the selected QuickBooks connection'; end if;

  if v_net <> 0 then
    if v_balancing_type = 'Accounts Payable' then
      if v_source.credit_vendor_qbo_id is null or not exists (
        select 1 from public.quickbooks_vendors where connection_id = v_connection
          and company_entity_id = v_company and qbo_vendor_id = v_source.credit_vendor_qbo_id and is_active
      ) then raise exception 'The balancing payable account requires a valid vendor'; end if;
    elsif v_balancing_type = 'Accounts Receivable' then
      if v_source.credit_vendor_qbo_id is null or not exists (
        select 1 from public.quickbooks_customers where connection_id = v_connection
          and company_entity_id = v_company and qbo_customer_id = v_source.credit_vendor_qbo_id and is_active
      ) then raise exception 'The balancing receivable account requires a valid customer'; end if;
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'DetailType', 'JournalEntryLineDetail', 'Amount', abs(v_net),
      'Description', left(trim(v_source.display_name || ' ' || coalesce(v_batch.label, '')), 4000),
      'JournalEntryLineDetail', jsonb_strip_nulls(jsonb_build_object(
        'PostingType', case when v_net >= 0 then 'Credit' else 'Debit' end,
        'AccountRef', jsonb_build_object('value', v_source.credit_qbo_account_id),
        'Entity', case when v_source.credit_vendor_qbo_id is not null then jsonb_build_object(
          'Type', case when v_balancing_type = 'Accounts Receivable' then 'Customer' else 'Vendor' end,
          'EntityRef', jsonb_build_object('value', v_source.credit_vendor_qbo_id)) end,
        'DepartmentRef', case when v_source.default_qbo_location_id is not null
          then jsonb_build_object('value', v_source.default_qbo_location_id) end
      ))
    )));
  end if;

  v_snapshot := jsonb_build_object(
    'schema_version', 1, 'kind', 'card_batch', 'qbo_connection_id', v_connection,
    'source', 'card_import', 'source_ref', p_batch_id,
    'period_start', v_batch.period_start, 'period_end', v_batch.period_end,
    'payload', jsonb_build_object(
      'TxnDate', v_batch.entry_date,
      'PrivateNote', left(trim('SILO card coding · ' || v_source.display_name || ' · ' || coalesce(v_batch.label, '')), 4000),
      'Line', v_lines));
  v_hash := public.finance_approval_snapshot_hash(v_snapshot);

  update public.card_sources set qbo_connection_id = v_connection, updated_at = now()
  where id = v_source.id and qbo_connection_id is null;
  update public.card_import_batches set
    status = 'approved', approved_at = now(), approved_by = v_user,
    approval_version = approval_version + 1,
    approval_snapshot = v_snapshot, approval_hash = v_hash,
    qbo_connection_id = v_connection, updated_at = now(),
    approval_reopened_at = null, approval_reopened_by = null, approval_reopen_reason = null
  where id = p_batch_id;
  return jsonb_build_object('id', p_batch_id, 'approval_hash', v_hash,
    'approval_version', v_batch.approval_version + 1);
end;
$$;

create or replace function public.approve_journal_adjustment(p_adjustment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid := public.active_company_id();
  v_adj public.journal_adjustments%rowtype;
  v_connection uuid;
  v_connection_count integer;
  v_lines jsonb;
  v_debits numeric(14,2);
  v_credits numeric(14,2);
  v_source text;
  v_source_ref text;
  v_snapshot jsonb;
  v_hash text;
begin
  if v_user is null or v_company is null
     or not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then
    raise exception 'Finance access required';
  end if;
  select * into v_adj from public.journal_adjustments
  where id = p_adjustment_id and company_entity_id = v_company for update;
  if not found then raise exception 'Adjustment not found'; end if;
  if v_adj.status = 'approved' and v_adj.approval_snapshot is not null
     and v_adj.approval_hash is not null then
    return jsonb_build_object('id', p_adjustment_id, 'approval_hash', v_adj.approval_hash,
      'approval_version', v_adj.approval_version, 'already_approved', true);
  end if;
  if v_adj.status <> 'draft' then raise exception 'Adjustment cannot be approved from status %', v_adj.status; end if;

  v_connection := v_adj.qbo_connection_id;
  if v_connection is null then
    select count(*), (array_agg(id order by id))[1] into v_connection_count, v_connection
    from public.quickbooks_connections where company_entity_id = v_company and is_active;
    if v_connection_count <> 1 then raise exception 'Select one active QuickBooks connection before approval'; end if;
  end if;
  if not exists (select 1 from public.quickbooks_connections where id = v_connection
                 and company_entity_id = v_company and is_active) then
    raise exception 'QuickBooks connection is not active for this company';
  end if;
  if (select count(*) from public.journal_adjustment_lines where adjustment_id = p_adjustment_id) < 2 then
    raise exception 'An entry needs at least two lines';
  end if;
  if exists (
    select 1 from public.journal_adjustment_lines l
    left join public.quickbooks_accounts a on a.connection_id = v_connection
      and a.company_entity_id = v_company and a.qbo_account_id = l.qbo_account_id and a.is_active
    where l.adjustment_id = p_adjustment_id and a.id is null
  ) then raise exception 'An adjustment line has an invalid QuickBooks account'; end if;
  if exists (
    select 1 from public.journal_adjustment_lines l
    where l.adjustment_id = p_adjustment_id and l.qbo_location_id is not null
      and not exists (select 1 from public.quickbooks_locations q where q.connection_id = v_connection
        and q.company_entity_id = v_company and q.qbo_location_id = l.qbo_location_id and q.is_active)
  ) then raise exception 'An adjustment line has an invalid QuickBooks location'; end if;
  if exists (
    select 1 from public.journal_adjustment_lines l
    join public.quickbooks_accounts a on a.connection_id = v_connection
      and a.company_entity_id = v_company and a.qbo_account_id = l.qbo_account_id
    where l.adjustment_id = p_adjustment_id
      and a.account_type in ('Accounts Receivable', 'Accounts Payable') and l.entity_qbo_id is null
  ) then raise exception 'Receivable and payable lines require an entity'; end if;
  if exists (
    select 1 from public.journal_adjustment_lines l
    where l.adjustment_id = p_adjustment_id and ((l.entity_qbo_id is null) <> (l.entity_type is null))
  ) then raise exception 'Entity id and type must be supplied together'; end if;
  if exists (
    select 1 from public.journal_adjustment_lines l
    where l.adjustment_id = p_adjustment_id and l.entity_qbo_id is not null and not (
      (l.entity_type = 'Customer' and exists (select 1 from public.quickbooks_customers e
        where e.connection_id = v_connection and e.company_entity_id = v_company
          and e.qbo_customer_id = l.entity_qbo_id and e.is_active)) or
      (l.entity_type = 'Vendor' and exists (select 1 from public.quickbooks_vendors e
        where e.connection_id = v_connection and e.company_entity_id = v_company
          and e.qbo_vendor_id = l.entity_qbo_id and e.is_active)))
  ) then raise exception 'An adjustment line has an invalid QuickBooks entity'; end if;

  select coalesce(sum(amount) filter (where posting_type = 'Debit'), 0),
         coalesce(sum(amount) filter (where posting_type = 'Credit'), 0),
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'DetailType', 'JournalEntryLineDetail', 'Amount', round(l.amount, 2),
           'Description', left(coalesce(l.description, ''), 4000),
           'JournalEntryLineDetail', jsonb_strip_nulls(jsonb_build_object(
             'PostingType', l.posting_type,
             'AccountRef', jsonb_build_object('value', l.qbo_account_id),
             'Entity', case when l.entity_qbo_id is not null then jsonb_build_object(
               'Type', l.entity_type, 'EntityRef', jsonb_build_object('value', l.entity_qbo_id)) end,
             'DepartmentRef', case when l.qbo_location_id is not null
               then jsonb_build_object('value', l.qbo_location_id) end
           ))
         )) order by l.line_no, l.id)
    into v_debits, v_credits, v_lines
  from public.journal_adjustment_lines l where l.adjustment_id = p_adjustment_id;
  if abs(round(v_debits - v_credits, 2)) >= 0.005 then
    raise exception 'Entry does not balance: debits %, credits %', v_debits, v_credits;
  end if;

  v_source := coalesce(v_adj.accounting_source, 'manual_adjustment');
  v_source_ref := coalesce(v_adj.accounting_source_ref, p_adjustment_id::text);
  v_snapshot := jsonb_build_object(
    'schema_version', 1, 'kind', 'journal_adjustment', 'qbo_connection_id', v_connection,
    'source', v_source, 'source_ref', v_source_ref,
    'period_start', v_adj.entry_date, 'period_end', v_adj.entry_date,
    'payload', jsonb_build_object('TxnDate', v_adj.entry_date,
      'PrivateNote', left('SILO adjustment · ' || v_adj.memo, 4000), 'Line', v_lines));
  v_hash := public.finance_approval_snapshot_hash(v_snapshot);

  update public.journal_adjustments set
    status = 'approved', approved_at = now(), approved_by = v_user,
    approval_version = approval_version + 1,
    approval_snapshot = v_snapshot, approval_hash = v_hash,
    qbo_connection_id = v_connection,
    accounting_source = v_source, accounting_source_ref = v_source_ref,
    updated_at = now(), approval_reopened_at = null,
    approval_reopened_by = null, approval_reopen_reason = null
  where id = p_adjustment_id;
  return jsonb_build_object('id', p_adjustment_id, 'approval_hash', v_hash,
    'approval_version', v_adj.approval_version + 1);
end;
$$;

create or replace function public.reopen_card_import_batch(p_batch_id uuid, p_reason text)
returns void language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_company uuid := public.active_company_id();
begin
  if auth.uid() is null or v_company is null
     or not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then
    raise exception 'Finance access required';
  end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A reopen reason is required'; end if;
  if exists (select 1 from public.quickbooks_journal_postings p
    where p.company_entity_id = v_company and p.source = 'card_import'
      and p.source_ref = p_batch_id::text and p.status in ('submitting','unknown','posted')) then
    raise exception 'Resolve the active QuickBooks posting before reopening';
  end if;
  update public.card_import_batches set status = 'categorized', approved_at = null,
    approved_by = null, approval_snapshot = null, approval_hash = null,
    approval_reopened_at = now(), approval_reopened_by = auth.uid(),
    approval_reopen_reason = left(trim(p_reason), 500), updated_at = now()
  where id = p_batch_id and company_entity_id = v_company and status = 'approved';
  if not found then raise exception 'Approved batch not found'; end if;
end;
$$;

create or replace function public.reopen_journal_adjustment(p_adjustment_id uuid, p_reason text)
returns void language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_company uuid := public.active_company_id(); v_adj public.journal_adjustments%rowtype;
begin
  if auth.uid() is null or v_company is null
     or not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then
    raise exception 'Finance access required';
  end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A reopen reason is required'; end if;
  select * into v_adj from public.journal_adjustments where id = p_adjustment_id
    and company_entity_id = v_company and status = 'approved' for update;
  if not found then raise exception 'Approved adjustment not found'; end if;
  if exists (select 1 from public.quickbooks_journal_postings p
    where p.company_entity_id = v_company and p.source = v_adj.accounting_source
      and p.source_ref = v_adj.accounting_source_ref and p.status in ('submitting','unknown','posted')) then
    raise exception 'Resolve the active QuickBooks posting before reopening';
  end if;
  update public.journal_adjustments set status = 'draft', approved_at = null,
    approved_by = null, approval_snapshot = null, approval_hash = null,
    approval_reopened_at = now(), approval_reopened_by = auth.uid(),
    approval_reopen_reason = left(trim(p_reason), 500), updated_at = now()
  where id = p_adjustment_id;
end;
$$;

-- Keep the existing reasoned "Mark unposted" path compatible with typed
-- accounting sources. This changes SILO's record only; it never deletes in QBO.
create or replace function public.void_journal_adjustment(p_adjustment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid := public.active_company_id();
  v_adj public.journal_adjustments%rowtype;
  v_posting public.quickbooks_journal_postings%rowtype;
  v_source text;
  v_source_ref text;
  v_connection uuid;
  v_legacy boolean;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_user is null or not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then
    raise exception 'Finance access required to void a posting';
  end if;
  if v_company is null then raise exception 'No active company'; end if;
  if v_reason is null then raise exception 'A reason is required to void a posting'; end if;

  -- Same parent-first lock order as approval/reopen; two voids cannot release
  -- the same claim twice. The posting write also checks its prior status.
  select * into v_adj from public.journal_adjustments
  where id = p_adjustment_id and company_entity_id = v_company for update;
  if not found then raise exception 'Adjustment not found'; end if;
  if v_adj.status not in ('approved', 'posted') then
    raise exception 'Adjustment has no posted entry to void';
  end if;

  v_legacy := v_adj.approval_snapshot is null
    and v_adj.accounting_source is null and v_adj.accounting_source_ref is null;
  v_source := coalesce(v_adj.approval_snapshot->>'source', v_adj.accounting_source,
    case when v_legacy then 'journal_adjustment' end);
  v_source_ref := coalesce(v_adj.approval_snapshot->>'source_ref', v_adj.accounting_source_ref,
    case when v_legacy then p_adjustment_id::text end);
  v_connection := coalesce((v_adj.approval_snapshot->>'qbo_connection_id')::uuid,
    v_adj.qbo_connection_id);
  if v_source is null or v_source_ref is null or (not v_legacy and v_connection is null) then
    raise exception 'Adjustment posting identity is incomplete';
  end if;
  if v_adj.approval_snapshot is not null and (
    v_adj.approval_snapshot->>'kind' is distinct from 'journal_adjustment'
    or v_adj.approval_hash is null
    or public.finance_approval_snapshot_hash(v_adj.approval_snapshot) is distinct from v_adj.approval_hash
    or v_source is distinct from v_adj.accounting_source
    or v_source_ref is distinct from v_adj.accounting_source_ref
    or v_connection is distinct from v_adj.qbo_connection_id
  ) then raise exception 'Approved posting identity is inconsistent'; end if;

  select p.* into v_posting from public.quickbooks_journal_postings p
  where p.company_entity_id = v_company
    and p.source = v_source and p.source_ref = v_source_ref
    and p.status = 'posted'
    and (p.connection_id = v_connection or (v_legacy and v_connection is null))
    and (
      -- A generated source_ref may be only a month. Never substitute another
      -- posting when this adjustment already names its exact posting row.
      (v_adj.posting_id is not null and p.id = v_adj.posting_id)
      or (v_adj.posting_id is null and v_legacy)
      -- QBO succeeded and the posting row was saved, but saving the parent
      -- failed. Only the exact approved payload may bridge that missing link.
      or (v_adj.posting_id is null and v_adj.status = 'approved'
        and v_adj.approval_snapshot is not null
        and p.payload_hash = v_adj.approval_hash)
    )
    and (v_adj.approval_snapshot is null or p.payload_hash = v_adj.approval_hash)
  for update;
  if not found then raise exception 'No posted entry found for this adjustment'; end if;
  if v_posting.connection_id is not null and not exists (
    select 1 from public.quickbooks_connections c
    where c.id = v_posting.connection_id and c.company_entity_id = v_company
  ) then raise exception 'Posting connection belongs to another company'; end if;

  update public.quickbooks_journal_postings
  set status = 'voided',
    error_message = left('Voided in SILO: ' || v_reason, 500),
    recovery_note = concat_ws(E'\n', nullif(recovery_note, ''),
      format('Voided in SILO by %s at %s: %s', v_user, now(), left(v_reason, 500)))
  where id = v_posting.id and company_entity_id = v_company and status = 'posted';
  if not found then raise exception 'Posting changed while it was being voided'; end if;

  update public.journal_adjustments
  set status = 'approved', posting_id = null, updated_at = now()
  where id = p_adjustment_id and company_entity_id = v_company;

  return jsonb_build_object('ok', true,
    'qbo_journal_entry_id', v_posting.qbo_journal_entry_id,
    'doc_number', v_posting.qbo_doc_number);
end;
$$;

revoke all on function public.void_journal_adjustment(uuid, text) from public, anon;
grant execute on function public.void_journal_adjustment(uuid, text) to authenticated;

revoke all on function public.approve_card_import_batch(uuid) from public, anon;
revoke all on function public.approve_journal_adjustment(uuid) from public, anon;
revoke all on function public.reopen_card_import_batch(uuid, text) from public, anon;
revoke all on function public.reopen_journal_adjustment(uuid, text) from public, anon;
grant execute on function public.approve_card_import_batch(uuid) to authenticated;
grant execute on function public.approve_journal_adjustment(uuid) to authenticated;
grant execute on function public.reopen_card_import_batch(uuid, text) to authenticated;
grant execute on function public.reopen_journal_adjustment(uuid, text) to authenticated;

comment on column public.card_import_batches.approval_snapshot is
  'Immutable, server-built QBO-ready payload approved by a human; posting reads only this snapshot.';
comment on column public.journal_adjustments.approval_snapshot is
  'Immutable, server-built QBO-ready payload approved by a human; posting reads only this snapshot.';
comment on column public.quickbooks_journal_postings.recovery_note is
  'Durable operator-facing explanation for ambiguous Intuit outcomes and recovery attempts.';
