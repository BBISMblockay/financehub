-- Ask SILO: finished replies the page collects, instead of holding a connection
-- open while the answer is worked out.
--
-- Why (2026-09-28): PR #820 kept the HTTP response open past Supabase's 150s
-- gateway limit by sending heartbeat whitespace. Live, the connection was
-- closed at ~126s anyway ("Http: connection closed before message completed")
-- while the function finished a complete 227s answer in the background. The
-- answer existed and never reached the screen. Holding a connection open is
-- therefore not a delivery path SILO controls.
--
-- Now a long request answers "pending" within seconds, keeps working under
-- EdgeRuntime.waitUntil, and writes its FINISHED RESPONSE BODY here -- the exact
-- JSON the page would have received (answer, queries_run, concepts, sources,
-- partial flags, or the error and its flags) plus its HTTP status. The page
-- polls this table by its own request id.
--
-- Why not silo_chat_audit_log: the audit row carries the answer text and SQL
-- but not the response -- no concept cards, no web sources, and an error row
-- holds an internal code ("provider_busy: 529") rather than the message the
-- person should read. It is also exec-readable by design; a reply is not.
--
-- Access: the ASKER only, both ways. No exec read (the audit log is the
-- oversight surface), no update, no delete from a client.

create table if not exists public.silo_chat_responses (
  request_id uuid primary key,
  company_entity_id uuid references public.entities(id) on delete cascade,
  created_by uuid default auth.uid() references auth.users(id) on delete cascade,
  http_status integer not null check (http_status between 100 and 599),
  response jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists silo_chat_responses_created_by_idx
  on public.silo_chat_responses (created_by, created_at desc);

alter table public.silo_chat_responses enable row level security;

drop policy if exists silo_chat_responses_select on public.silo_chat_responses;
create policy silo_chat_responses_select on public.silo_chat_responses
  for select using (created_by = auth.uid());

-- Written by the edge function WITH THE CALLER'S OWN TOKEN, so the row is the
-- asker's by construction; a client cannot write one for somebody else.
drop policy if exists silo_chat_responses_insert on public.silo_chat_responses;
create policy silo_chat_responses_insert on public.silo_chat_responses
  for insert with check (created_by = auth.uid());

drop trigger if exists stamp_created_by on public.silo_chat_responses;
create trigger stamp_created_by before insert on public.silo_chat_responses
  for each row execute function public.stamp_created_by();

select public.attach_stamp_company_entity_id_triggers();

revoke all on public.silo_chat_responses from anon;
revoke all on public.silo_chat_responses from authenticated;
grant select, insert on public.silo_chat_responses to authenticated;

comment on table public.silo_chat_responses is
  'Ask SILO finished replies, one per request id, readable only by the asker. '
  'The page polls here for an answer that took longer than a few seconds; see '
  'supabase/functions/silo-chat/keepalive-lib.mjs.';

-- Not something to answer questions from: hidden from Ask SILO's own index.
insert into public.silo_chat_schema_catalog (relname, relkind, columns, description, keywords, is_hidden)
values ('silo_chat_responses', 'r', '[]'::jsonb,
        'Internal delivery table for Ask SILO replies. Not business data.',
        array[]::text[], true)
on conflict (relname) do update
  set is_hidden = true, updated_at = now();

select public.refresh_chat_schema_catalog();
