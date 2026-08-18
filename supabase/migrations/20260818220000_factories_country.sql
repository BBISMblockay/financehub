-- =============================================================================
-- factories.country — powers the shipment status map on /v2/po-report.html
--
-- The map plots each logged shipment (incoming_shipments) at its factory's
-- country (approximate, illustrative — no live GPS/carrier-tracking API is
-- wired up). Free text, matched client-side against a fixed list of known
-- sourcing-country centroids in pages/factories.html (the picker) and
-- v2/po-report.html (the map) — a country string outside that list simply
-- doesn't get a pin and shows up in the "not mapped" list instead.
-- =============================================================================

alter table public.factories add column if not exists country text;
