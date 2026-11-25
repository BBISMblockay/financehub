-- Your Customers > Find: a 0-100 match score on every find, a niche-word
-- signal, and a follower-count lookup for a profile matched without one.
--
-- Blake, 2026-11-24, after the audit ("need scores"): every find over the
-- 750 bar was tied to the customer by the name alone, and the biggest ones
-- (324K, 223K, 107K followers) were famous strangers who share the name. So
-- each find now carries how sure SILO is (match_score, computed in
-- lib/affiliate-customer-scan-core.mjs matchScore), and only a find at the
-- "Likely" score counts toward the number of finds asked for. The rest show
-- under "Check" for a person to look at.
--
-- Additive only, idempotent:
--   * match_score smallint, 0-100, NULL on rows scored before this existed
--     (the page shows those as "Check" -- never promoted by a guess);
--   * match_basis may also be 'niche' (the profile's own text uses one of
--     the company's niche words);
--   * serp_task_kind may also be 'count' (the one search for a matched
--     profile's own handle, to read the follower count it states).
-- Writes stay service-role only (the affiliate-research function).

alter table public.affiliate_customer_social add column if not exists match_score smallint;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_customer_social_match_score_check') then
    alter table public.affiliate_customer_social add constraint affiliate_customer_social_match_score_check
      check (match_score is null or (match_score between 0 and 100));
  end if;
end $$;

alter table public.affiliate_customer_social drop constraint if exists affiliate_customer_social_match_basis_check;
alter table public.affiliate_customer_social add constraint affiliate_customer_social_match_basis_check
  check (match_basis is null or match_basis in ('email_handle', 'city', 'niche', 'name_only'));

alter table public.affiliate_customer_social drop constraint if exists affiliate_customer_social_serp_task_kind;
alter table public.affiliate_customer_social add constraint affiliate_customer_social_serp_task_kind
  check (serp_task_kind is null or serp_task_kind in ('name', 'handle', 'count'));

-- Readable by the page like every other column of the row (RLS still scopes
-- it to the active company).
grant select (match_score) on public.affiliate_customer_social to authenticated;

comment on column public.affiliate_customer_social.match_score is
  'How sure SILO is that the profile is this customer, 0-100: 40 for the name, plus email username 50, city 30, niche word 30, name in the handle 10; minus 5 when the model chose between namesakes; a name-only profile with 5K/20K/100K+ followers loses 10/20/30. 70+ is Likely and counts toward the finds asked for. NULL = scored before 20261124235000.';
comment on column public.affiliate_customer_social.serp_task_kind is
  '''name'' (the first search), ''handle'' (the email-username search, only when the name search did not settle it) or ''count'' (the matched profile''s own handle, to read its follower count).';

select public.refresh_chat_schema_catalog();
