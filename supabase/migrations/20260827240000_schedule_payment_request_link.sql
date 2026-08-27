-- Links a schedule item to the payment request it was paid through, so the
-- invoice proving the term is one click away rather than a filename someone
-- remembers.
--
-- Nullable on purpose: four of the seven 2026 prepaid payments went through
-- Bill.com or direct wire and have no request in SILO at all. An item without a
-- request is normal, not incomplete.
--
-- Matching on AMOUNT ALONE is wrong and demonstrably so. In the live data a
-- $20,000 Universal Studios licensing payment matches, on amount, a $20,000
-- employee reimbursement to a colleague for postage. Same number, unrelated
-- transactions. So the page treats amount as the necessary condition and scores
-- vendor and date proximity to decide whether it is actually the same thing --
-- and proposes rather than applies, because linking the wrong invoice as support
-- for a schedule is worse than having no invoice at all.
alter table public.schedule_items
  add column if not exists payment_request_id uuid
    references public.payment_requests(id) on delete set null;

comment on column public.schedule_items.payment_request_id is
  'The Request Manager entry this item was paid through, when there is one. Carries the invoice number and attached PDF. Null is expected -- payments made via Bill.com or direct wire never pass through Request Manager.';

create index if not exists idx_schedule_items_payment_request
  on public.schedule_items (payment_request_id)
  where payment_request_id is not null;
