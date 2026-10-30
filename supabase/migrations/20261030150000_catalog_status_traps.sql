-- Tell the model about the four status traps that are not SILO's to fix.
--
-- Companion to 20261030130000 and 20261030140000. The audit behind those two
-- (/mnt/project-files/audits/status-flag-mismatches-2026-10-30.md) found six
-- discrepancies; two were SILO failing to write something and are fixed in
-- code. These four are not defects at all -- a column nobody maintains, a
-- date column that does not exist, Shopify's own behaviour, and two
-- legitimate grains -- so there is nothing to repair. What there is, is a bot
-- reading them and stating something false.
--
-- Nothing here changes a row. It is text in the catalog that describe_tables
-- and Ask SILO's schema map serve, which is the only thing standing between a
-- raw-SQL question and a confident wrong answer. All six updates append once
-- and are guarded on their own marker, so re-applying is a no-op.
--
-- Deliberately NOT covered: ad_platform_connections, where 3 of 4 active
-- connections hold an expired token and `is_active` means the operator's
-- intent rather than reachability. That table is is_hidden in this catalog,
-- so no bot can reach it and a description would go unread. It stays a
-- human-facing concern.

begin;

-- ── 1. launch_calendar.status is never advanced ────────────────────────────
-- 114 of 116 rows read 'planned', including 60 launches whose launch_date has
-- already passed. Nothing moves it when a launch ships. The existing
-- description warns that the brief fields are empty but says nothing about
-- status, so "what launched this year" is currently answerable only by
-- accident.
update public.silo_chat_schema_catalog set
  description = coalesce(description, '') || $d$ STATUS IS NOT MAINTAINED -- DO NOT ANSWER "WHAT LAUNCHED" FROM IT: nothing advances status when a launch ships, so on 2026-10-30 it read 'planned' on 114 of 116 rows INCLUDING 60 launches whose launch_date is already past. A bot trusting it reports the whole year as upcoming. Use the DATE: launch_date < today is what has launched, launch_date >= today is what is upcoming (launch_end_date, where set, closes the window). The same goes for launch_readiness, which reads 'not_reviewed' almost everywhere because nobody reviews it -- say "not reviewed", never "not ready".$d$
where relname = 'launch_calendar'
  and coalesce(description, '') not like '%STATUS IS NOT MAINTAINED%';

-- ── 2. po_headers has no arrival date ──────────────────────────────────────
-- Receipt lives in two places that disagree: the header status, and
-- incoming_shipments.received_date. 34 of 39 Received/Closed POs have no
-- shipment row with a received date (15 predate the shipments feature, 19 do
-- not). Measured 2026-10-30: ALL 39 have a po_status_history row into
-- Received or Closed, so changed_at answers the question for every one of
-- them -- which is why this is a description and not a new column.
update public.silo_chat_schema_catalog set
  description = coalesce(description, '') || $d$ NO ARRIVAL DATE ON THIS TABLE: there is no received_date or arrival column on the header -- expected_arrival_date is a FORECAST, not what happened. For when a PO actually arrived, read po_status_history: the changed_at of its row into 'Received' (or 'Closed'), which on 2026-10-30 existed for all 39 Received/Closed POs. Do not use incoming_shipments alone for this: 34 of those 39 have no shipment row carrying a received_date, so "arrived" counted that way is understated by about that many. Status values seen: Draft, Sent to Factory, Confirmed, In Production, Received, Closed, Cancelled -- Received and Closed both mean it came in, and status is the only arrival signal on the header itself.$d$
where relname = 'po_headers'
  and coalesce(description, '') not like '%NO ARRIVAL DATE ON THIS TABLE%';

-- po_status_history had no description and no keywords at all, so the table
-- the note above points at was not findable. It also joins the report
-- builder's allowlist, beside po_headers and po_lines: a PO lead-time or
-- arrival report cannot be built without it.
update public.silo_chat_schema_catalog set
  keywords = array['po status','po history','status change','arrived','arrival date','received date',
                   'lead time','when did it arrive','po timeline'],
  description = $d$Every status change a purchase order has been through: one row per transition, with po_header_id, old_status, new_status, changed_at and changed_by. THIS IS WHERE PO DATES THAT ACTUALLY HAPPENED LIVE -- po_headers carries only forecast dates and its current status, with no arrival column, so the changed_at of the row into 'Received' (or 'Closed') is when a PO came in, and the gap between the row into 'Sent to Factory' and that one is its real lead time. Recorded from 2026-04-28, so a PO closed before that has no history and is NOT MEASURABLE rather than instant. Join po_headers on po_status_history.po_header_id = po_headers.id (not po_id). A PO can re-enter a status, so take the most recent row into it unless the question is about the first time.$d$
where relname = 'po_status_history';

update public.silo_chat_schema_catalog set
  reportable = true
where relname = 'po_status_history';

-- incoming_shipments had no description either, and the po_headers note now
-- names it. Saying what it does NOT cover is the point.
update public.silo_chat_schema_catalog set
  keywords = array['shipment','shipments','container','freight','in transit','delivered',
                   'received','warehouse','tracking','carrier'],
  description = $d$Inbound shipments against a purchase order: one row per shipment, with po_header_id, shipment_status, ship_date, eta, received_date, tracking_number, carrier, container_ref and warehouse_location. Lines are in incoming_shipment_lines. COVERAGE: this is NOT a complete record of what has arrived. Only POs shipped since the feature existed have rows, so 34 of the 39 POs whose status says Received or Closed have no shipment row with a received_date (measured 2026-10-30) -- counting arrivals here alone understates them by about that many, and a PO with no shipment row has not necessarily not arrived. For whether and when a PO arrived, use po_headers.status with po_status_history.changed_at; use this table for the logistics detail (carrier, container, tracking, warehouse) and for partial or multi-shipment POs. shipment_status is title-cased free text: 'Not Shipped', 'In Transit', 'Shipped', 'Delivered'.$d$
where relname = 'incoming_shipments';

-- ── 3. Cancelled Shopify orders keep their financial status ────────────────
-- Shopify's behaviour, not a SILO bug: 636 of 4,358 cancelled Baseballism
-- orders still read 'paid', 'pending' or 'authorized'. The reports that
-- matter already exclude them (the Redo MCA note says so explicitly); the
-- exposure is a bot writing its own SQL.
update public.silo_chat_schema_catalog set
  description = coalesce(description, '') || $d$ CANCELLED ORDERS KEEP THEIR FINANCIAL STATUS: cancelling an order in Shopify does not reset financial_status, so on 2026-10-30, 636 of 4,358 cancelled Baseballism orders still read 'paid', 'pending' or 'authorized'. Any revenue sum or paid-order count filtered on financial_status alone silently includes them. Add `cancelled_at is null` to every such query, and treat cancelled_at -- not financial_status -- as whether the order stands. financial_status values seen: paid, pending, authorized, partially_refunded, refunded, voided.$d$
where relname = 'shopify_orders'
  and coalesce(description, '') not like '%CANCELLED ORDERS KEEP THEIR FINANCIAL STATUS%';

-- ── 4. Returns carry a status at two grains ────────────────────────────────
-- 558 items sit at open/pending/approved under a parent that is complete,
-- rejected or deleted. That is legitimate -- an item rejected inside an
-- otherwise complete return is real -- but it makes "how many returns are
-- open" 209 at the return grain and 1,326 at the item grain, and a bot that
-- does not say which it used produces a number six times the other.
update public.silo_chat_schema_catalog set
  description = coalesce(description, '') || $d$ STATUS EXISTS AT TWO GRAINS -- SAY WHICH ONE YOU COUNTED: redo_returns.status is the whole return and redo_return_items.status is one item within it, and they legitimately disagree (an item rejected inside an otherwise complete return is real). On 2026-10-30, 558 items read open/pending/approved under a parent that was complete, rejected or deleted, so "open returns" is 209 counting returns and 1,326 counting items -- neither is wrong and the difference is six-fold. Count returns for "how many returns", items for "how many units came back", and name the grain in the answer. Statuses: returns open / in_transit / delivered / flagged / complete / rejected / deleted; items open / pending / approved / complete / rejected.$d$
where relname = 'redo_returns'
  and coalesce(description, '') not like '%STATUS EXISTS AT TWO GRAINS%';

-- redo_return_items had no description at all.
update public.silo_chat_schema_catalog set
  keywords = array['return items','returned units','return lines','exchange items',
                   'units returned','green return'],
  description = $d$The line items of a Redo return: one row per returned unit, with return_id, status, is_exchange and green_return. Join redo_returns on redo_return_items.return_id = redo_returns.id. STATUS EXISTS AT TWO GRAINS -- SAY WHICH ONE YOU COUNTED: this status is the item's and redo_returns.status is the whole return's, and they legitimately disagree (an item rejected inside an otherwise complete return is real). On 2026-10-30, 558 items read open/pending/approved under a parent that was complete, rejected or deleted, so "open returns" is 209 counting returns and 1,326 counting items. Count returns for "how many returns", items for "how many units came back", and name the grain in the answer. Coverage follows redo_returns: a recent slice of Shopify refund volume, not complete history.$d$
where relname = 'redo_return_items';

commit;
