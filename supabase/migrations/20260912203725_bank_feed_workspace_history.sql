-- The request is fixed at Item initialization. NULL means not recorded for an
-- older Item; never infer its history from today's environment configuration.
alter table public.plaid_connections add column if not exists history_days_requested integer
  check (history_days_requested between 1 and 730);
comment on column public.plaid_connections.history_days_requested is
  'History requested at Item initialization; nullable for legacy Items. Provider coverage may be shorter.';
select public.refresh_chat_schema_catalog();
