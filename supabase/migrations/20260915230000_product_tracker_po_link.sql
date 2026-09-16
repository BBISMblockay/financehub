-- product_tracker.po_header_id
--
-- A Pipeline item in /v2/products.html is routinely created from an incoming
-- PO: the drawer already offers a "PO / Incoming" search, and its Expected
-- Units field is literally labelled "(from the originating PO)". There was
-- nowhere to store WHICH PO, so picking one could not be saved at all --
-- product_samples has had po_header_id since the table was created, this is
-- its counterpart on the pipeline side.
--
-- Additive and nullable: every existing row keeps meaning exactly what it
-- meant, and "no PO recorded" stays distinguishable from "PO recorded as
-- nothing". `on delete set null` rather than cascade -- deleting a purchase
-- order must not delete the pipeline item that came from it, and must not be
-- blocked by it either.
--
-- Safe to re-run.

alter table public.product_tracker
  add column if not exists po_header_id uuid references public.po_headers(id) on delete set null;

create index if not exists product_tracker_po_header_idx
  on public.product_tracker (po_header_id);

comment on column public.product_tracker.po_header_id is
  'Purchase order this pipeline item came from. expected_units is read from that PO''s total across every size line (v_launch_po_product_lookup.total_units), never one line''s qty.';
