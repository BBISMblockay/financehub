-- Any Windsor source syncs on connect, so the catalog text for
-- connected_source_metrics_daily_v is no longer true: it says ad platforms are
-- in marketing_kpis_daily and not here. From 2026-11-05 a platform SILO syncs
-- natively (Google Ads, Meta, GA4) lands HERE when it also arrives through a
-- connected source, precisely so that it is never counted twice in
-- marketing_kpis_daily. A reader has to be told, or they will add the two.
--
-- Catalog text only: no table, view, policy, grant or data changes.
begin;

update public.silo_chat_schema_catalog set
  keywords = array['connected source','email','reviews','analytics','metrics','connector','pinterest',
                   'klaviyo','google ads','meta','facebook','ga4','second copy','duplicate'],
  description = $d$Daily numbers from connected data sources that have no table of their own (email, reviews, analytics, ad platforms SILO also syncs itself, and similar). One row per data_source x account x object x day. object_type 'account' is the account's daily total; 'campaign' rows are parts of it, so never add the two together. The typed columns (impressions, clicks, spend, conversions, revenue, sends, delivered, opens, sessions, users, orders) are filled only when the source has a field meaning that; NULL means not reported, never zero. metrics holds every numeric field the source returned, by the source's field id. revenue and conversions are what the source CLAIMS: they overlap net sales and each other, so never add them to either. A platform SILO syncs directly (Google Ads, Meta, GA4) is in marketing_kpis_daily; if the same platform is ALSO connected as a data source its second copy is here, under that data_source, so NEVER add this table's rows for those platforms to marketing_kpis_daily -- use one or the other, and marketing_kpis_daily is the one SILO's reports use. An ad platform SILO does not sync itself (TikTok, Pinterest, Microsoft and so on) is in marketing_kpis_daily, not here. For the newest days or a field not stored here, use the live connection tools.$d$,
  updated_at = now()
where relname = 'connected_source_metrics_daily_v';

-- The update above is a no-op if the catalog row is missing, which would leave
-- readers with the old text and no sign of it, so say so instead.
do $$
begin
  if not exists (select 1 from public.silo_chat_schema_catalog
                  where relname = 'connected_source_metrics_daily_v'
                    and is_hidden = false
                    and description like '%NEVER add this table%') then
    raise exception 'connected_source_metrics_daily_v is missing, hidden, or kept its old description';
  end if;
end $$;

commit;
