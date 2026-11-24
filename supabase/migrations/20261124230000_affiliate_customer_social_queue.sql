-- Your Customers > Hunt: searches go through DataForSEO's standard queue, and
-- a press keeps going until it has the number of finds asked for.
--
-- Blake, 2026-11-24: "if silo user ask for 25 or 500 that's what they should
-- receive not a partial or trimmed list", and "Yes" to the cheaper queue mode
-- (about a third of the live price). A queued search is posted, then
-- collected a minute or two later, often by a LATER run of the same scan. So
-- the provider's task id is stored on the customer's row the moment the
-- search is posted, before anything is collected: the next run collects what
-- this one posted and never posts (or pays for) it twice.
--
-- Additive only: three nullable columns and one partial index. Writes stay
-- service-role only (the affiliate-research function). Idempotent.

alter table public.affiliate_customer_social add column if not exists serp_task_id text;
alter table public.affiliate_customer_social add column if not exists serp_task_kind text;
alter table public.affiliate_customer_social add column if not exists serp_posted_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_customer_social_serp_task_kind') then
    alter table public.affiliate_customer_social add constraint affiliate_customer_social_serp_task_kind
      check (serp_task_kind is null or serp_task_kind in ('name', 'handle'));
  end if;
end $$;

-- The searches a scan has in flight, read on every collection pass.
create index if not exists affiliate_customer_social_inflight_idx
  on public.affiliate_customer_social (scan_id, serp_posted_at)
  where serp_task_id is not null;

comment on column public.affiliate_customer_social.serp_task_id is
  'The DataForSEO queue task searching this customer right now (name or email-username search); NULL once collected. Stored before collection so a later run of the same scan collects it instead of posting again.';
comment on column public.affiliate_customer_social.serp_task_kind is
  '''name'' (the first search) or ''handle'' (the email-username search, only when the name search did not settle it).';
comment on column public.affiliate_customer_social.serp_posted_at is
  'When serp_task_id was posted.';

select public.refresh_chat_schema_catalog();
