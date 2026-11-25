-- Your customers > Find creators: a decision per find, so worked finds leave
-- the working lists (Blake 2026-11-25: "discovery and customers need an
-- archive style tab - so lists don't just grow on working queues", and bulk
-- actions that mirror Discovery: Shortlist, Not a fit, Add to program, Do
-- not contact).
--
--   review = NULL           still to review (Likely / Check / Under the bar)
--   review = 'shortlisted'  added to a program's outreach (Shortlisted tab)
--   review = 'not_fit'      Not a fit (Archive; Restore puts it back)
--   review = 'suppressed'   Do not contact (Archive; the do-not-contact list
--                           itself is affiliate_suppressions, unchanged)
-- "Not them" stays status = 'rejected' (affiliate_customer_social_reject) and
-- shows on Archive too.
--
-- Additive only: three nullable columns, one check, one RPC, and a backfill
-- that only fills review where it is NULL. The scan (affiliate-research)
-- never writes these columns. Writes stay behind can_manage_affiliate_programs().
-- Idempotent.

alter table public.affiliate_customer_social add column if not exists review text;
alter table public.affiliate_customer_social add column if not exists reviewed_at timestamptz;
alter table public.affiliate_customer_social add column if not exists reviewed_by uuid;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_customer_social_review_check') then
    alter table public.affiliate_customer_social add constraint affiliate_customer_social_review_check
      check (review is null or review in ('shortlisted', 'not_fit', 'suppressed'));
  end if;
end $$;

create index if not exists affiliate_customer_social_review_idx
  on public.affiliate_customer_social (company_entity_id, review)
  where review is not null;

comment on column public.affiliate_customer_social.review is
  'The decision on this find: NULL to review, shortlisted (added to a program), not_fit, or suppressed (do not contact). Set by affiliate_customer_social_review(); the scan never writes it.';

-- One decision on many finds, by customer_key, for the caller's active
-- company. p_review NULL is Restore, and only undoes Not a fit (shortlisted
-- is a prospect row now; do not contact is the suppression list). Returns how
-- many rows changed.
create or replace function public.affiliate_customer_social_review(p_keys text[], p_review text)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_co uuid := public.active_company_id();
  v_n integer;
begin
  if v_co is null then
    raise exception 'no active company' using errcode = '42501';
  end if;
  if not public.can_manage_affiliate_programs() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_review is not null and p_review not in ('shortlisted', 'not_fit', 'suppressed') then
    raise exception 'unknown decision %', p_review using errcode = '22023';
  end if;
  if coalesce(array_length(p_keys, 1), 0) = 0 then
    return 0;
  end if;
  if coalesce(array_length(p_keys, 1), 0) > 1000 then
    raise exception 'at most 1000 at a time' using errcode = '22023';
  end if;
  if p_review is null then
    update public.affiliate_customer_social
      set review = null, reviewed_at = now(), reviewed_by = auth.uid()
      where company_entity_id = v_co and customer_key = any(p_keys) and review = 'not_fit';
  else
    update public.affiliate_customer_social
      set review = p_review, reviewed_at = now(), reviewed_by = auth.uid()
      where company_entity_id = v_co and customer_key = any(p_keys)
        and review is distinct from p_review
        -- Do not contact is final here; only removing them from the list undoes it.
        and review is distinct from 'suppressed';
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end $function$;

revoke all on function public.affiliate_customer_social_review(text[], text) from public;
revoke all on function public.affiliate_customer_social_review(text[], text) from anon;
grant execute on function public.affiliate_customer_social_review(text[], text) to authenticated;

-- Backfill, so the working lists start clean: a find already added to a
-- program is Shortlisted, one on the do-not-contact list by email is Archive.
update public.affiliate_customer_social s
  set review = 'shortlisted', reviewed_at = now()
  where s.review is null and s.email_lc is not null
    and exists (select 1 from public.affiliate_prospects p
                where p.company_entity_id = s.company_entity_id and p.source = 'customer'
                  and lower(p.contact_email) = s.email_lc);

update public.affiliate_customer_social s
  set review = 'suppressed', reviewed_at = now()
  where s.review is distinct from 'suppressed' and s.email_lc is not null
    and exists (select 1 from public.affiliate_suppressions x
                where x.company_entity_id = s.company_entity_id and x.kind = 'email'
                  and lower(x.value_normalized) = s.email_lc);

select public.refresh_chat_schema_catalog();
