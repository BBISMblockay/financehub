-- Fix the "not synced" note on the Meta paid-media card.
--
-- The note told the reader to pull leads from Ads Manager while 876 of them
-- sat in the Purchase Campaigns row of the same week.
--
-- The cause was asking the wrong question. The old expression checked whether
-- the SUBSCRIBERS GROUP had leads:
--
--   select 'leads' where not exists (
--     select 1 from camp where grp='subscribers' and leads is not null)
--
-- but that group's campaigns are follower buys -- Meta reports `follow` for
-- them, never `lead` -- so it reports no leads even when leads are syncing
-- perfectly. "This group has no leads" and "leads are not synced" are
-- different facts, and only the second one warrants sending someone to
-- another tool.
--
-- The right question is whether ANYTHING in the window reports the metric.
create or replace function public.wow_paid_media_not_synced(p_report_date date)
returns jsonb language sql stable as $$
with w as (select p_report_date as e, p_report_date - 6 as s)
select coalesce(jsonb_agg(m), '[]'::jsonb) from (
  select 'thruplays' as m where not exists (
    select 1 from public.marketing_kpis_daily k cross join w
    where k.platform='meta_ads' and k.company_entity_id = public.active_company_id()
      and k.day_date between w.s and w.e and k.thruplays is not null)
  union all
  select 'leads' where not exists (
    select 1 from public.marketing_kpis_daily k cross join w
    where k.platform='meta_ads' and k.company_entity_id = public.active_company_id()
      and k.day_date between w.s and w.e and k.leads is not null)
) ns;
$$;

grant execute on function public.wow_paid_media_not_synced(date) to authenticated;

-- Point wow_paid_media at the helper by rewriting its deployed definition in
-- place, rather than retyping 130 lines and risking a transcription slip.
-- Raises if the expected block is absent, so it can never reapply an
-- unchanged (or unexpected) definition silently.
do $$
declare def text; newdef text; old_block text; new_block text;
begin
  def := pg_get_functiondef('public.wow_paid_media(date)'::regprocedure);

  old_block :=
E'''not_synced'', (select coalesce(jsonb_agg(m), ''[]''::jsonb) from (\n'
'      select ''thruplays'' as m where not exists (\n'
'        select 1 from camp where grp=''thruplay'' and thruplays is not null)\n'
'      union all\n'
'      select ''leads'' where not exists (\n'
'        select 1 from camp where grp=''subscribers'' and leads is not null)) ns)';

  new_block := E'''not_synced'', public.wow_paid_media_not_synced(p_report_date)';

  if position(old_block in def) = 0 then
    -- Already migrated, or the function changed shape. Either way, do nothing.
    raise notice 'not_synced block not found; leaving wow_paid_media as-is';
    return;
  end if;

  newdef := replace(def, old_block, new_block);
  execute newdef;
end $$;
