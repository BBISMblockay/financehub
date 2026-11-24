-- Customer consent rollup, in resumable batches.
--
-- refresh_company_customer_consent(company) copies Shopify consent onto
-- company_customer_profiles in ONE statement. For a company with ~1.1M
-- shopify_customers rows and ~365k profiles it is cancelled by the 8s
-- statement timeout every run (seen 2026-11-24 in shopify-sync), so the
-- Affiliate Studio customer list shows "not checked yet" for nearly everyone.
--
-- refresh_company_customer_consent_step(company, limit) does the same work
-- for the next `limit` profile emails after a cursor kept in
-- company_customer_profile_state, and moves the cursor. The sync calls it in
-- a loop under a time budget; a pass that does not finish resumes on the next
-- run. Same consent rule as the one-statement function: a MEASURED state
-- beats an unmeasured one, then the latest consent date, then the latest
-- profile edit. Same clearing rule: a profile whose email has no customer
-- record behind it any more loses its copied consent (back to NULL = not
-- measured). Matching is by email only, as before.
--
-- The covering index lets each batch read consent straight from the index
-- instead of one random heap read per customer row (the measured cost of a
-- 1,000-profile batch without it was ~1.3s cold).
--
-- Idempotent. Additive: the old function is kept unchanged.

create index if not exists shopify_customers_co_email_consent_cover_idx
  on public.shopify_customers (company_entity_id, email_lc)
  include (email_consent_state, email_consent_updated_at,
           sms_consent_state, sms_consent_updated_at, shopify_updated_at)
  where email_lc is not null;

alter table public.company_customer_profile_state
  add column if not exists consent_cursor         text,
  add column if not exists consent_pass_started_at timestamptz,
  add column if not exists consent_pass_done_at    timestamptz;

create or replace function public.refresh_company_customer_consent_step(
  p_company uuid,
  p_limit   integer default 2000
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_after   text;
  v_emails  text[];
  v_last    text;
  v_n       integer;
  v_rows    integer := 0;
  v_cleared integer := 0;
  v_done    boolean;
begin
  if p_company is null then
    raise exception 'refresh_company_customer_consent_step: company is required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 20000 then
    raise exception 'refresh_company_customer_consent_step: limit must be 1..20000';
  end if;

  insert into public.company_customer_profile_state (company_entity_id)
  values (p_company)
  on conflict (company_entity_id) do nothing;

  -- Row lock: two overlapping syncs take turns instead of both moving the cursor.
  select consent_cursor into v_after
    from public.company_customer_profile_state
   where company_entity_id = p_company
   for update;

  if v_after is null then
    update public.company_customer_profile_state
       set consent_pass_started_at = now()
     where company_entity_id = p_company;
  end if;

  select array_agg(e order by e) into v_emails
    from (
      select distinct p.email_lc as e
        from public.company_customer_profiles p
       where p.company_entity_id = p_company
         and p.email_lc is not null
         and (v_after is null or p.email_lc > v_after)
       order by p.email_lc
       limit p_limit
    ) b;

  v_n    := coalesce(array_length(v_emails, 1), 0);
  v_last := case when v_n > 0 then v_emails[v_n] end;
  v_done := v_n < p_limit;

  if v_n > 0 then
    with src as (
      select c.email_lc,
             (array_agg(c.email_consent_state order by (c.email_consent_state is not null) desc, c.email_consent_updated_at desc nulls last, c.shopify_updated_at desc nulls last))[1] as email_consent_state,
             (array_agg(c.email_consent_updated_at order by (c.email_consent_state is not null) desc, c.email_consent_updated_at desc nulls last, c.shopify_updated_at desc nulls last))[1] as email_consent_updated_at,
             (array_agg(c.sms_consent_state order by (c.sms_consent_state is not null) desc, c.sms_consent_updated_at desc nulls last, c.shopify_updated_at desc nulls last))[1] as sms_consent_state,
             (array_agg(c.sms_consent_updated_at order by (c.sms_consent_state is not null) desc, c.sms_consent_updated_at desc nulls last, c.shopify_updated_at desc nulls last))[1] as sms_consent_updated_at
        from public.shopify_customers c
       where c.company_entity_id = p_company
         and c.email_lc is not null
         and c.email_lc = any (v_emails)
       group by c.email_lc
    )
    update public.company_customer_profiles p
       set email_consent_state = src.email_consent_state,
           sms_consent_state   = src.sms_consent_state,
           consent_updated_at  = greatest(src.email_consent_updated_at, src.sms_consent_updated_at),
           consent_checked_at  = now(),
           updated_at          = now()
      from src
     where p.company_entity_id = p_company
       and p.email_lc = src.email_lc
       and (
         p.email_consent_state is distinct from src.email_consent_state
         or p.sms_consent_state is distinct from src.sms_consent_state
         or p.consent_updated_at is distinct from greatest(src.email_consent_updated_at, src.sms_consent_updated_at)
         or p.consent_checked_at is null
       );
    get diagnostics v_rows = row_count;

    update public.company_customer_profiles p
       set email_consent_state = null,
           sms_consent_state   = null,
           consent_updated_at  = null,
           consent_checked_at  = now(),
           updated_at          = now()
     where p.company_entity_id = p_company
       and p.email_lc = any (v_emails)
       and (p.email_consent_state is not null or p.sms_consent_state is not null)
       and not exists (
         select 1 from public.shopify_customers c
          where c.company_entity_id = p_company
            and c.email_lc is not null
            and c.email_lc = p.email_lc
       );
    get diagnostics v_cleared = row_count;
  end if;

  update public.company_customer_profile_state
     set consent_cursor       = case when v_done then null else v_last end,
         consent_pass_done_at = case when v_done then now() else consent_pass_done_at end
   where company_entity_id = p_company;

  return jsonb_build_object(
    'company_entity_id', p_company,
    'emails', v_n,
    'profiles_updated', v_rows,
    'profiles_cleared', v_cleared,
    'pass_done', v_done
  );
end $$;

revoke all on function public.refresh_company_customer_consent_step(uuid, integer) from public, anon, authenticated;
grant execute on function public.refresh_company_customer_consent_step(uuid, integer) to service_role;
