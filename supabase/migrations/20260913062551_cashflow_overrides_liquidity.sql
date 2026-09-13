-- Forecast assumptions only. No bank transaction, journal or posting mutation.
create extension if not exists btree_gist with schema extensions;

alter table public.cash_forecast_items
  add column if not exists account_id uuid,
  add column if not exists counter_account_id uuid;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='cash_plan_account_company_fk') then
    alter table public.cash_forecast_items add constraint cash_plan_account_company_fk
      foreign key(account_id,company_entity_id) references public.plaid_accounts(id,company_entity_id);
    alter table public.cash_forecast_items add constraint cash_plan_counter_company_fk
      foreign key(counter_account_id,company_entity_id) references public.plaid_accounts(id,company_entity_id);
  end if;
end $$;

create table if not exists public.cash_forecast_overrides (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  scope_group text not null check(scope_group in ('coa','cashflow')),
  category_key text not null check(length(category_key)>0),
  category_label text not null check(length(category_label)>0),
  flow_key text not null,
  direction text not null check(direction in ('in','out')),
  start_date date not null,
  end_date date not null check(end_date>=start_date),
  payment_date date not null check(payment_date between start_date and end_date),
  amount numeric(14,2) not null check(amount>=0), -- zero deliberately suppresses an estimate
  account_id uuid,
  counter_account_id uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  foreign key(account_id,company_entity_id) references public.plaid_accounts(id,company_entity_id),
  foreign key(counter_account_id,company_entity_id) references public.plaid_accounts(id,company_entity_id)
);
-- Database-enforced even for simultaneous clients; adjacent ranges are allowed.
do $$ begin
  if not exists(select 1 from pg_constraint where conname='cash_override_no_overlap') then
    alter table public.cash_forecast_overrides add constraint cash_override_no_overlap
      exclude using gist(company_entity_id with =,currency with =,scope_group with =,
        category_key with =,direction with =,daterange(start_date,end_date,'[]') with &&)
      where(is_active);
  end if;
end $$;
alter table public.cash_forecast_overrides enable row level security;
revoke all on public.cash_forecast_overrides from anon,authenticated;
grant select,insert,update on public.cash_forecast_overrides to authenticated;
drop policy if exists cash_overrides_finance on public.cash_forecast_overrides;
create policy cash_overrides_finance on public.cash_forecast_overrides for all to authenticated
  using(company_entity_id=(select public.active_company_id()) and
    ((select public.can_manage_journal_entries()) or (select public.is_exec_or_owner())))
  with check(company_entity_id=(select public.active_company_id()) and
    ((select public.can_manage_journal_entries()) or (select public.is_exec_or_owner())));

-- Keep the existing company policy and add the finance gate used by this page.
drop policy if exists cash_plans_finance on public.cash_forecast_items;
create policy cash_plans_finance on public.cash_forecast_items as restrictive for all to authenticated
  using((select public.can_manage_journal_entries()) or (select public.is_exec_or_owner()))
  with check((select public.can_manage_journal_entries()) or (select public.is_exec_or_owner()));

create or replace function public.cashflow_validate_assumption()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_currency text; v_account public.plaid_accounts; v_counter public.plaid_accounts;
begin
  if tg_op='UPDATE' and new.company_entity_id is distinct from old.company_entity_id then
    raise exception 'A cashflow assumption cannot change company';
  end if;
  if tg_op='INSERT' then new.created_at:=clock_timestamp();new.created_by:=auth.uid();
  else new.created_at:=old.created_at;new.created_by:=old.created_by; end if;
  new.updated_at:=clock_timestamp();new.updated_by:=auth.uid();
  if not new.is_active then return new; end if;
  select coalesce((select base_currency from public.accounting_settings where company_entity_id=new.company_entity_id),'USD') into v_currency;
  if tg_table_name='cash_forecast_overrides' and to_jsonb(new)->>'currency' is distinct from v_currency then
    raise exception 'Forecast assumptions use the company base currency';
  end if;
  if new.account_id is not null then
    select * into v_account from public.plaid_accounts where id=new.account_id and company_entity_id=new.company_entity_id;
    if v_account.id is null or v_account.type<>'depository' or v_account.iso_currency_code is distinct from v_currency
      or not exists(select 1 from public.plaid_connections where id=v_account.connection_id and status<>'disconnected') then
      raise exception 'Choose a connected cash account in the company base currency';
    end if;
  end if;
  if new.counter_account_id is not null then
    if new.account_id is null or new.account_id=new.counter_account_id then
      raise exception 'An account movement needs two different accounts';
    end if;
    select * into v_counter from public.plaid_accounts where id=new.counter_account_id and company_entity_id=new.company_entity_id;
    if v_counter.id is null or v_counter.iso_currency_code is distinct from v_currency
      or v_counter.type not in ('depository','credit','loan','investment')
      or not exists(select 1 from public.plaid_connections where id=v_counter.connection_id and status<>'disconnected') then
      raise exception 'Choose a connected counterpart in the same currency';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.cashflow_validate_assumption() from public,anon,authenticated;
do $$ declare t text; begin
  foreach t in array array['cash_forecast_items','cash_forecast_overrides'] loop
    execute format('drop trigger if exists cashflow_validate on public.%I',t);
    execute format('create trigger cashflow_validate before insert or update on public.%I for each row execute function public.cashflow_validate_assumption()',t);
    execute format('drop trigger if exists finance_audit_event on public.%I',t);
    execute format('create trigger finance_audit_event after insert or update or delete on public.%I for each row execute function public.finance_append_audit_event()',t);
  end loop;
end $$;
