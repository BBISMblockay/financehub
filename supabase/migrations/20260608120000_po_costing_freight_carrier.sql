-- Add freight_carrier to po_costing to store the carrier / forwarder name.
alter table public.po_costing
  add column if not exists freight_carrier text;
