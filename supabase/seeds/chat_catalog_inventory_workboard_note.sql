-- Teach Ask SILO that inventory_workboard_v's velocity columns can be lying.
--
-- The catalog's auto-refresh regenerates `columns` from pg_catalog but leaves
-- `description` alone, so this survives refresh_chat_schema_catalog(). It is
-- the only channel that reaches the model -- a comment in CLAUDE.md or the
-- migration does not.
--
-- Why it is needed: 20260821170000 made the velocity join require
-- inventory_on_hand.product_title = sales_by_day.product_name. Those are
-- different things (current title vs as-sold title frozen at order time), it
-- is a LEFT JOIN, and coalesce turns the resulting NULL into a hard 0. On
-- 2026-08-27 that produced a slow-moving-inventory list for an exec made
-- almost entirely of products that sell fine -- every one of the top 40
-- offenders was title drift, not a real SKU collision, including ~$19k of
-- Hardball Hunter tees (706 units sold in 365d) reading as zero.
--
-- velocity_matched (added 20260827180000) marks those rows. This note is what
-- makes the model actually check it. It is a guardrail over data that is still
-- wrong, not a fix -- the join repair is separate and still pending.
--
-- Idempotent: strips any previously appended copy of this note before adding
-- it, so re-running does not stack duplicates.

update public.silo_chat_schema_catalog
   set description = nullif(btrim(
         regexp_replace(coalesce(description, ''), E'\n*CRITICAL: check velocity_matched.*$', '', 'n')
       ), '')
 where relname = 'inventory_workboard_v';

update public.silo_chat_schema_catalog
   set description = btrim(concat_ws(E'\n\n', nullif(description, ''),
     'CRITICAL: check velocity_matched before using ANY qty_* or avg_day_* column '
     'from this view. The velocity join requires inventory_on_hand.product_title to '
     'exactly equal sales_by_day.product_name, but those are different things -- the '
     'first is Shopify''s CURRENT title, the second is the AS-SOLD title frozen at '
     'order time. It is a LEFT JOIN, so a title mismatch returns NULL velocity and '
     'coalesce renders it as a hard 0. velocity_matched = false means every qty/avg on '
     'that row means UNKNOWN, not NONE. Never call a row slow-moving, dead, or '
     'never-sold on a false -- exclude those rows and state how many you excluded. '
     'Confirmed 2026-08-27: products with thousands of units sold and real on-hand '
     'value read as 0 units here. last_sold_date is NULL on the same rows for the same '
     'reason, so "never" there also means unknown.'))
 where relname = 'inventory_workboard_v';

select relname, left(description, 120) as description_head
from public.silo_chat_schema_catalog
where relname = 'inventory_workboard_v';
