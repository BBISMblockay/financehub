-- Reach and frequency on the Meta marketing tables.
--
-- Frequency is the number Ads Manager shows beside CPM and the one a buyer
-- reads to decide whether an audience is being worn out; SILO stored neither
-- it nor the reach it is computed from, so the question could not be asked
-- here at all. Both come from the insights request the sync already makes.
--
-- ADDITIVE. Two nullable columns on each table, defaulting to NULL. No
-- existing column changes type, no row is rewritten, no policy moves, and
-- every reader that does not name them is unaffected. The sync requests the
-- fields behind the same all-or-nothing guard as thruplays, so an account that
-- refuses them loses the frequency column and nothing else.
--
-- NULL, NOT 0. An ad Meta did not report reach for has not reached nobody. The
-- sync preserves the distinction all the way to these columns.
--
-- HOW NOT TO READ THEM. reach is UNIQUE PEOPLE and frequency is a RATIO
-- (impressions / reach). Neither is additive:
--   * summing reach across days, campaigns or ads counts the same person once
--     per row they appear in;
--   * averaging frequency weights a day with 10 impressions the same as a day
--     with 10,000.
-- A roll-up recomputes frequency as sum(impressions) / reach-of-the-widest-row
-- available, and a true de-duplicated reach over a period can only come from
-- Meta for that period -- it cannot be derived from daily rows. The catalog
-- text below says this, because a bot reading the column names alone would
-- guess wrong.

alter table public.marketing_kpis_daily
  add column if not exists reach bigint,
  add column if not exists frequency numeric(10,4);

alter table public.meta_ad_performance_daily
  add column if not exists reach bigint,
  add column if not exists frequency numeric(10,4);

comment on column public.marketing_kpis_daily.reach is
  'Unique people reached on this day (Meta). NOT additive: summing across days or campaigns counts the same person more than once. NULL means the platform did not report it.';
comment on column public.marketing_kpis_daily.frequency is
  'Impressions per person reached on this day (Meta). A RATIO: never average or sum it -- recompute as impressions / reach over the rows being rolled up.';
comment on column public.meta_ad_performance_daily.reach is
  'Unique people reached by this ad on this day. NOT additive across days, ads or campaigns. NULL means Meta did not report it.';
comment on column public.meta_ad_performance_daily.frequency is
  'Impressions per person reached for this ad on this day. A RATIO: recompute from impressions / reach rather than averaging.';

-- Tell the bots the same thing. refresh_chat_schema_catalog() picks the new
-- columns up automatically; the trap it cannot pick up is that two of them
-- must not be summed, so that is appended to the curated description -- and
-- only once, so a re-apply is a no-op.
do $$
begin
  if to_regclass('public.silo_chat_schema_catalog') is not null then
    perform public.refresh_chat_schema_catalog();

    update public.silo_chat_schema_catalog
       set description = coalesce(description, '')
             || ' reach is unique people and frequency is impressions / reach: '
             || 'never sum reach or average frequency across days, campaigns or '
             || 'ads -- recompute frequency as impressions / reach instead.',
           updated_at = now()
     where relname in ('marketing_kpis_daily', 'meta_ad_performance_daily')
       and description is not null
       and description not like '%reach is unique people%';
  end if;
end $$;
