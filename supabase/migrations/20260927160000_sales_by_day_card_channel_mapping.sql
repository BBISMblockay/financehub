-- Ask SILO: the sales_by_day catalog card stops hardcoding the online channel.
--
-- The card every tenant's Ask SILO reads said:
--   "SCOPE: online-store questions mean lower(btrim(location_tag))='online';
--    other location_tags are retail."
-- That was Baseballism's shape written as a universal rule. It only ever
-- worked because Baseballism named its online location "online"; Test
-- Company's locations are both retail and it has no online store, so the rule
-- sends its online questions to nothing and calls every other tag "retail".
-- The sentence is not in any earlier migration (it was edited on production),
-- so this handles both states: replace it where present, add the new sentence
-- where absent. Re-running is a no-op once the new sentence is there.
--
-- The replacement points at the per-company mapping that already exists
-- (20260920170000_location_channel_resolver.sql): silo_channel_location_tags()
-- derives a channel's location_tags from locations.store_type for the active
-- company, and an empty result means NOT CONFIGURED, never zero sales. The
-- Ask SILO core prompt carries the same rule (prompt-lib.mjs, "WHICH STORES
-- AND CHANNELS A QUESTION MEANS").

do $$
declare
  new_scope constant text :=
    'SCOPE: a channel is THIS company''s configured mapping, possibly several stores: '
    || 'location_tag = any(silo_channel_location_tags(''online'')) (or ''retail'', ''wholesale''). '
    || 'Never filter a literal tag for a channel and never infer one from store names; '
    || 'an empty mapping means the channel is not configured, never zero sales '
    || '(wow_channel_status(''online'') says which). A company-wide question uses every location_tag.';
begin
  update public.silo_chat_schema_catalog
     set description = case
           when description ~ 'SCOPE: online-store questions mean[^.]*\.'
             then regexp_replace(description, 'SCOPE: online-store questions mean[^.]*\.', new_scope)
           else btrim(coalesce(description, '') || ' ' || new_scope)
         end
   where relname = 'sales_by_day'
     and coalesce(description, '') not like '%silo_channel_location_tags%';
end
$$;
