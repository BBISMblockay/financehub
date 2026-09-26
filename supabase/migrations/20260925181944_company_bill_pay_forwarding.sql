-- A company's bill-pay email inbox, used only to hand a submitted document
-- to its chosen payment service. It does not create a SILO bill or pay it.
alter table public.company_settings
  add column if not exists bill_pay_provider text,
  add column if not exists bill_pay_forward_email text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'company_settings_bill_pay_forward_shape'
                 and conrelid = 'public.company_settings'::regclass) then
    alter table public.company_settings
      add constraint company_settings_bill_pay_forward_shape check (
        (bill_pay_provider is null and bill_pay_forward_email is null)
        or (bill_pay_provider in ('melio', 'bill') and
            bill_pay_forward_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
      );
  end if;
end $$;

comment on column public.company_settings.bill_pay_forward_email is
  'Company-specific, receive-only bill intake email in Melio or BILL. Owner-admin editable; never a global destination for another tenant.';

-- Legacy companies may have no company_settings row. The owner-only setter
-- creates that row with the same timezone/currency defaults used elsewhere;
-- existing rows retain all unrelated settings.
create or replace function public.set_bill_pay_forwarding(p_provider text, p_email text)
returns void language plpgsql security definer set search_path = '' as $fn$
declare
  v_company uuid;
  v_provider text := nullif(trim(p_provider), '');
  v_email text := nullif(trim(p_email), '');
  v_currency text;
begin
  if (select auth.uid()) is null or not public.is_owner_admin_of_active_company() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no active company' using errcode = '42501';
  end if;
  if (v_provider is null) <> (v_email is null)
     or (v_provider is not null and v_provider not in ('melio', 'bill'))
     or (v_email is not null and v_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception 'choose Melio or BILL and enter its bill intake email, or clear both';
  end if;

  select base_currency into v_currency from public.accounting_settings
    where company_entity_id = v_company;
  insert into public.company_settings
    (company_entity_id, business_timezone, default_currency,
     bill_pay_provider, bill_pay_forward_email)
  values (v_company, public.silo_company_timezone(v_company), coalesce(v_currency, 'USD'),
          v_provider, v_email)
  on conflict (company_entity_id) do update
    set bill_pay_provider = excluded.bill_pay_provider,
        bill_pay_forward_email = excluded.bill_pay_forward_email;
end;
$fn$;

revoke all on function public.set_bill_pay_forwarding(text, text) from public, anon;
grant execute on function public.set_bill_pay_forwarding(text, text) to authenticated;

-- Keep historical forwarded_to_melio activity valid. New sends use the
-- provider-neutral event; its message records the actual destination.
alter table public.payment_request_activity
  drop constraint if exists payment_request_activity_activity_type_check;

alter table public.payment_request_activity
  add constraint payment_request_activity_activity_type_check
  check (activity_type = any (array[
    'submitted', 'status_changed', 'assignment_changed', 'priority_changed',
    'payment_type_changed', 'completed_changed', 'note_added', 'file_opened',
    'file_uploaded', 'file_removed', 'notification_sent', 'forwarded_to_melio',
    'forwarded_to_bill_pay', 'amount_changed', 'updated'
  ]::text[]));
