-- A per-company switch for the open application form, settable from the app.
--
-- 20260921120000 added company_settings.open_customer_applications but left
-- it to a hand-written UPDATE. That does not work multi-tenant, and worse, it
-- fails SILENTLY where it matters most: Baseballism has no company_settings
-- row at all (only companies created through /v2/company-onboarding.html get
-- one, and Baseballism predates it), so `update company_settings set ... where
-- company_entity_id = <baseballism>` matches zero rows and reports success.
-- peek_open_customer_application INNER JOINs that table, so the form could
-- never have opened for the tenant most likely to want it.
--
-- So the RPC has to be able to CREATE the row -- and that row carries two
-- NOT NULL columns this feature has no opinion about:
--
--   business_timezone  is constrained to supported_business_timezones, which
--                      holds exactly one value, so there is nothing to ask.
--   default_currency   is a DECLARED fact, guarded on both sides against
--                      contradicting accounting_settings.base_currency, which
--                      is MEASURED from a connected QuickBooks realm. Writing
--                      a guess here would raise on any company whose books
--                      say something else.
--
-- It therefore takes the currency FROM the books when they exist and falls
-- back to USD only when they do not -- the one case where nothing can
-- contradict it yet.

create or replace function public.set_open_customer_applications(p_enabled boolean)
returns table (enabled boolean, company_key text, created_settings boolean)
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_company uuid;
  v_created boolean := false;
  v_tz text;
  v_currency text;
begin
  -- Owner-admin, not the invoicing gate. Switching this on publishes an
  -- unauthenticated endpoint that creates rows in this company's name; that
  -- is a different kind of decision from issuing one customer an invite.
  if not public.is_owner_admin_of_active_company() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no active company' using errcode = '42501';
  end if;

  if not exists (select 1 from public.company_settings where company_entity_id = v_company) then
    -- Exactly one timezone is honoured end to end, so there is no choice to
    -- offer. Ordered for determinism rather than relying on one row forever.
    select tz_name into v_tz
      from public.supported_business_timezones order by tz_name limit 1;
    if v_tz is null then
      raise exception 'no supported business timezone is configured';
    end if;

    -- The books are the authority where they exist; the two-sided currency
    -- guard would raise on a guess that disagrees with them.
    select base_currency into v_currency
      from public.accounting_settings where company_entity_id = v_company;

    insert into public.company_settings
      (company_entity_id, business_timezone, default_currency, open_customer_applications)
    values (v_company, v_tz, coalesce(v_currency, 'USD'), p_enabled);
    v_created := true;
  else
    update public.company_settings
       set open_customer_applications = p_enabled,
           updated_at = now()
     where company_entity_id = v_company;
  end if;

  return query
    select p_enabled,
           (select e.entity_key from public.entities e where e.id = v_company),
           v_created;
end;
$fn$;

-- Reachable from the browser on purpose -- this is the toggle. The gate is
-- inside the function, which is why it is DEFINER: company_settings' own
-- write policy does not exist (the table is read-only to clients), and adding
-- one would let any member edit the timezone and currency too.
revoke all on function public.set_open_customer_applications(boolean) from public;
revoke all on function public.set_open_customer_applications(boolean) from anon;
grant execute on function public.set_open_customer_applications(boolean) to authenticated;

comment on function public.set_open_customer_applications(boolean) is
  'Turn this company''s public wholesale application form on or off. Owner-admin only: it publishes an unauthenticated endpoint that creates customer_accounts rows. Creates the company_settings row when absent -- taking default_currency from accounting_settings.base_currency where books exist, since a guess would trip the two-sided currency guard.';
