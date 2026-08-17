-- 20260817200000_product_samples_request_source.sql
--
-- From the Slack thread that shipped 20260817190000_sample_notifications.sql:
-- Chris pointed out the SAMPLE_SIZE_REQUEST notification reads the same
-- regardless of context, but Baseballism actually receives samples for three
-- distinct reasons — pre-production samples, photo sample size runs pulled
-- from bulk/on-hand inventory, and bulk itself — and the notification should
-- say which one this is. Blake: "request from catalog flows into new
-- samples well" — track it as data on the row rather than guessing the
-- context from other columns after the fact.
--
-- Only one value exists today: 'catalog_photo_request', set by the "+
-- Request Sample" button on the Catalog tab (shipped in the same PR as
-- 20260817190000). A sample created from Pipeline, or the plain "+ New
-- Sample" button, leaves this null — that is the pre-production case Chris
-- described, and needs no special phrasing.

alter table public.product_samples
  add column if not exists request_source text;

comment on column public.product_samples.request_source is
  'Which flow created this sample draft. Currently only ''catalog_photo_request'' (set by the Catalog tab''s "+ Request Sample" button, for pulling sizes of an existing/live product from bulk stock, e.g. for a reshoot or QC) vs null (pipeline/blank "+ New Sample", i.e. a pre-production sample). Read by sample-notify to phrase the size-request notification correctly per Chris/Blake, 2026-08-17.';
