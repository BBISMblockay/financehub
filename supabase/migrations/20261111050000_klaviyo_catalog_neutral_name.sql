-- 20261111050000 -- A connected AI never reads the data vendor's name.
--
-- 20261103233717 established the rule: bots see SILO's connected sources under
-- neutral names, and the vendor-named tables are hidden from the catalog (which
-- is also the MCP query allowlist). 20261109040000 then introduced
-- klaviyo_message_performance_v with a description ending "...prefer this over
-- klaviyo_performance_daily, which is the Windsor.ai copy." That view is NOT
-- hidden, so the sentence is bot-facing, and `verify_v2_schema.sql`'s
-- "connected sources neutral names" check has failed on it since 2026-11-09.
--
-- The sentence is worth keeping -- a bot choosing between the two tables needs
-- to know which is the direct feed -- so only the vendor's name goes. Nothing
-- about the data, the grain or the caveats changes.
--
-- Idempotent: an UPDATE to a known value, matched on the one relname.

begin;

update public.silo_chat_schema_catalog set
  description = 'Klaviyo email and SMS performance per message, straight from Klaviyo''s own '
    'API. One row per message x channel x REPORTING WINDOW (timeframe_start, '
    'timeframe_end) -- NOT per day, because Klaviyo publishes no daily series '
    'for campaigns. kind = ''campaign'' or ''flow_message''; send_time is when a '
    'campaign went out, and parent_name is the campaign or the flow. NEVER sum '
    'rows from different windows: overlapping windows measure the same sends '
    'twice. No rate is stored -- divide counts after pooling, because Klaviyo''s '
    'rates are counts over counts. conversion_value is revenue Klaviyo '
    'ATTRIBUTES to email/SMS: it overlaps net sales and ad-platform revenue, so '
    'never add it to either, and it is only comparable across rows sharing one '
    'conversion_metric_id. text_message_spend is SMS sending cost, not ad spend. '
    'NULL means not reported, not zero (SMS statistics are null before '
    '2025-10-01). For a company that syncs Klaviyo directly, prefer this over '
    'klaviyo_performance_daily, which is SILO''s connected-source copy.',
  updated_at = now()
where relname = 'klaviyo_message_performance_v';

-- The rule itself, asserted here so this migration cannot be the one that
-- reintroduces what it is removing.
do $$
begin
  if exists (select 1 from public.silo_chat_schema_catalog
              where not is_hidden
                and (relname ilike '%windsor%' or description ilike '%windsor%'
                  or keywords::text ilike '%windsor%')) then
    raise exception 'a catalogued relation a bot can see still names the data vendor';
  end if;
end $$;

commit;
