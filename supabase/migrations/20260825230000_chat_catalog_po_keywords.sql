-- Make the PO tables findable by the words people actually use.
--
-- A live demand-planning question ("...given current on hand by category,
-- PO's placed in system, and define gap needed to fill") scored po_headers
-- and po_lines at ZERO, so both fell to the one-line index with no column
-- list. The model spent three of its eight queries on information_schema
-- discovering their columns, then guessed a non-existent total_units on
-- po_headers and had to retry -- four of eight rounds gone before any real
-- analysis ran. The analysis it eventually produced was sound; it just had
-- half the budget to do it in.
--
-- Two causes, and the second is the interesting one:
--   1. The keywords ('purchase','order','po','factory','incoming','buy')
--      did not include the vocabulary of the question -- "placed",
--      "in system", "committed", "on order", "pipeline".
--   2. buildSchemaSection tokenises on [a-z0-9_]{4,}, so the token "po" is
--      DROPPED before scoring happens. A keyword shorter than four
--      characters can never match anything -- it is dead weight in the
--      array, and "po" was the one keyword most likely to be typed.
--
-- Verified against the real scoring for that exact question:
--   po_headers                   0 -> 11   (index only -> full detail)
--   po_lines                     0 -> 16   (index only -> full detail)
--   inventory_on_hand_current_v 10 -> 25   (now top-ranked)
--   v_po_incoming_summary   absent -> 8    (now surfaced at all)
--
-- po_headers' description also now names the total_units trap directly, so
-- the wrong guess is avoided even when it lands in the index rather than
-- in full detail.

update public.silo_chat_schema_catalog set
  keywords = array['purchase','purchases','order','orders','ordered','placed','committed','incoming','inbound','pipeline','open orders','on order','buy','buying','factory','vendor','supplier','arrival','demand','planning'],
  description = $d$Purchase order headers -- what has been ORDERED but may not have arrived yet, which is what "POs placed", "on order", "committed" and "incoming" all mean. po_lines joins on po_lines.po_header_id = po_headers.id (NOT po_id). Real columns: id, po_name, factory_id, order_date, req_ship_date, expected_arrival_date, date_bucket, status, wholesale_triggered, is_new_product_po, notes, internal_notes, created_at, updated_at, created_by. There is NO total_units or unit/quantity column on the header -- quantities live on po_lines.qty, and the rolled-up totals are on v_po_header_summary / v_po_incoming_summary. expected_arrival_date is what makes a PO usable for demand planning and for judging whether a launch date is reachable given real lead times.$d$
where relname = 'po_headers';

update public.silo_chat_schema_catalog set
  keywords = array['purchase','order','orders','ordered','placed','committed','incoming','on order','lines','line items','sku','qty','quantity','units','product type','demand','planning','buy'],
  description = $d$PO line items -- the actual quantities on order. Joins to po_headers on po_header_id. The SKU column is sku_snapshot (there is no sku column); quantity is qty (NOT quantity_ordered); titles are title_snapshot / variant_title_snapshot; category is product_type_snapshot, which is what to group by for "units on order by product type". unit_cost and retail_price are per line. source_concept_id records which product concept a line came from, when it was built from one.$d$
where relname = 'po_lines';

update public.silo_chat_schema_catalog set
  keywords = array['open','outstanding','purchase','order','orders','placed','incoming','on order','pipeline','not received','committed'],
  description = coalesce(nullif(description,''), $d$Open (not yet received) purchase orders -- the inbound pipeline. Use for "what is still on order" without filtering po_headers by status yourself.$d$)
where relname = 'v_open_pos';

update public.silo_chat_schema_catalog set
  keywords = array['incoming','inbound','on order','arriving','pipeline','purchase','order','units','rollup','demand','planning'],
  description = coalesce(nullif(description,''), $d$Rolled-up incoming PO units -- the fastest way to see how many units are already on order, without aggregating po_lines yourself. Pair with current on-hand to compute a demand gap.$d$)
where relname in ('v_po_incoming_summary');

update public.silo_chat_schema_catalog set
  keywords = array['inventory','on hand','on-hand','stock','current','available','category','product type','snapshot'],
  description = coalesce(nullif(description,''), $d$Current on-hand inventory per SKU/location -- the latest snapshot only, one row per variant. total_available_quantity is units on hand and total_available_inventory_value is its value; group by product_type for on-hand by category. Prefer this over inventory_on_hand (3.5M+ rows of history) for anything about "right now".$d$)
where relname = 'inventory_on_hand_current_v';
