-- Rebuild the seven SILO report tie-outs left STALE by 20260925193100/193200.
--
-- 20260925150000 wrote the Creative Performance (c3..0a) and Inventory
-- Summary (c1..01) checks with an md5 guard pinned to each report's SQL, and
-- each check embeds a copy of that SQL. Later the same day, two migrations
-- replaced a semicolon inside a status label in those reports (the read-only
-- runner rejects any ';'). That moved both fingerprints, so since 2026-09-25
-- all seven checks have blanked their own left side -- run_report_tieouts()
-- read them as NO DATA, indistinguishable from an empty company. The nightly
-- tie-out run (report-tieouts-nightly.yml, #901) classifies them STALE.
--
-- This regenerates exactly those seven with the SAME generator 20260925150000
-- used (copied verbatim, restricted to the two reports and their branches), so each check embeds
-- and pins the reports as they are now. Nothing about what is compared
-- changes. Idempotent: re-running deletes and rebuilds the same rows.
--
-- RULE THIS RE-LEARNS: a migration that edits a SILO report's queries_run or
-- parameters must regenerate that report's tie-outs in the same migration,
-- or the next nightly run goes red.

delete from public.silo_report_tieouts
 where report_id in ('c3000000-0000-4000-a000-00000000000a', 'c1000000-0000-4000-a000-000000000001');

do $checks$
declare
  from_sql constant text := '((select public.silo_business_today()) - 28)';
  to_sql constant text := '((select public.silo_business_today()) - 1)';
  co constant text := '(select public.active_company_id())';
  note constant text := 'Uses deployed default SQL. NO DATA can mean no source rows or a changed definition requiring a refreshed check; never a certification of completeness.';
  r record;
  q text[];
  guard text;
  n int;
begin
  for r in select * from public.silo_chat_saved_reports
            where id in ('c3000000-0000-4000-a000-00000000000a', 'c1000000-0000-4000-a000-000000000001')
              and source = 'system' and company_entity_id is null loop
    q := array[]::text[];
    for n in 1 .. coalesce(array_length(r.queries_run, 1), 0) loop
      q := q || replace(replace(replace(replace(replace(r.queries_run[n],
             '{{date_from}}', from_sql), '{{date_to}}', to_sql),
             '{{platform}}', '''all'''), '{{min_weeks}}', '52'), '{{trend}}', '''all''');
    end loop;
    guard := format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                    md5(r.queries_run::text || r.parameters::text), r.id);

    if r.id = 'c3000000-0000-4000-a000-00000000000a' then
      insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
      (r.id, 'Ad-level spend agrees with campaign-level paid spend', 'reconciliation',
       format('with report as materialized (%s) select case when %s then sum(spend) end as left_value, '
         || '(select round(sum(spend), 2) from public.marketing_kpis_daily where company_entity_id = %s and platform in (''meta_ads'', ''google_ads'') '
         || 'and day_date between %s and %s) as right_value from report', q[3], guard, co, from_sql, to_sql),
       1.00, note || ' Meta ad rows are summed from the ad-level table and compared with the campaign-level table, a second route; $1 allows per-row rounding.'),
      (r.id, 'Meta credited revenue agrees with the ad-level base table', 'reconciliation',
       format('with report as materialized (%s) select case when %s then sum(platform_credited_revenue) filter (where platform = ''meta_ads'') end as left_value, '
         || '(select round(sum(conversion_value), 2) from public.meta_ad_performance_daily where company_entity_id = %s '
         || 'and day_date between %s and %s) as right_value from report', q[3], guard, co, from_sql, to_sql),
       1.00, note || ' Ad-level credited revenue can differ from Meta''s campaign-level figure; this compares like with like.'),
      (r.id, 'Campaign, ad, platform and daily views add to the same spend', 'sanity',
       format('with p as materialized (%s), c as materialized (%s), a as materialized (%s), d as materialized (%s) '
         || 'select case when %s and abs((select sum(spend) from c) - (select sum(spend) from a)) < 1 '
         || 'and abs((select sum(spend) from d) - (select sum(spend) from a)) < 1 then (select sum(spend) from p) end as left_value, '
         || '(select sum(spend) from a) as right_value', q[1], q[2], q[3], q[4], guard),
       1.00, note);

    elsif r.id = 'c1000000-0000-4000-a000-000000000001' then
      insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
      (r.id, 'On-hand units agree with live inventory', 'reconciliation',
       format('with report as materialized (%s) select case when %s then sum(units_on_hand) end as left_value, '
         || '(select sum(total_available_quantity) from public.inventory_on_hand_current_v where company_entity_id = %s '
         || 'and nullif(product_type, '''') is not null) as right_value from report', q[1], guard, co),
       0, note),
      (r.id, 'Product-type rows add up to the total', 'sanity',
       format('with t as materialized (%s), b as materialized (%s) select case when %s '
         || 'and (select sum(units_on_order) from b) = (select units_on_order from t) then (select sum(units_on_hand) from b) end as left_value, '
         || '(select units_on_hand from t) as right_value', q[1], q[2], guard),
       0, note || ' On order must also agree, or the check reads NO DATA.'),
      (r.id, 'SKU on-hand agrees with live inventory', 'reconciliation',
       format('with s as materialized (%s) select case when %s then (select sum(units_on_hand) from s where product_type <> ''(no product type)'') end as left_value, '
         || '(select sum(total_available_quantity) from public.inventory_on_hand_current_v where company_entity_id = %s '
         || 'and nullif(product_type, '''') is not null and nullif(variant_sku, '''') is not null) as right_value', q[3], guard, co),
       0, note || ' Rows without a SKU cannot appear in a SKU list.'),
      (r.id, 'SKU on-order agrees with open PO lines', 'reconciliation',
       format('with s as materialized (%s) select case when %s then (select sum(units_on_order) from s) end as left_value, '
         || '(select sum(pl.qty) from public.po_lines pl join public.po_headers h on h.id = pl.po_header_id '
         || 'where pl.company_entity_id = %s and h.status in (''Confirmed'', ''Sent to Factory'', ''In Production'', ''In Transit'') '
         || 'and nullif(pl.sku_snapshot, '''') is not null) as right_value', q[3], guard, co),
       0, note);

    end if;
  end loop;
end $checks$;
