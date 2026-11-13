-- Automatic backward history walk for Shopify attribution coverage.
--
-- Idempotent and additive: one nullable column on the service-only scheduling table. The
-- cursor is the next day the nightly coverage run will attempt BELOW the store's frozen
-- enrolment day, and it moves past every day it attempts, success or failure, so one
-- unreadable old day cannot wedge the walk. NULL means the walk has not started; the
-- coverage script treats a checkpoint row without this column as "walk disabled", so
-- merging the script before this migration is applied changes nothing.
alter table public.shopify_attribution_coverage
 add column if not exists history_day date;

comment on column public.shopify_attribution_coverage.history_day is
 'Next day the automatic backward history walk will attempt, below start_day. Advances past attempted days, success or failure. NULL = not started.';
