-- Ask SILO deferred replies: scope to the ACTIVE COMPANY, not only the asker.
--
-- 20260928140000 let the asker read and write their replies by created_by
-- alone. The row carries company_entity_id, but nothing checked it, so a person
-- in two companies could ask in A, switch to B, and still read A's answer --
-- against the rule every operational table follows (20260616020000: a
-- multi-company user sees only the company they selected). The insert policy
-- also accepted an explicitly supplied foreign company, since the stamp trigger
-- only fills a NULL. Found in review of #821 after merge.
--
-- Now both policies require the row's company to be the caller's active one.
-- silo-chat sends the company it read at the START of the request, so an asker
-- who switched mid-request has the insert refused (the page falls back to its
-- error path) rather than A's answer filed under B.
--
-- Safe whether or not 20260928140000 has been applied separately: this file
-- re-creates both policies by name.

drop policy if exists silo_chat_responses_select on public.silo_chat_responses;
create policy silo_chat_responses_select on public.silo_chat_responses
  for select to authenticated
  using (created_by = auth.uid() and company_entity_id = public.active_company_id());

drop policy if exists silo_chat_responses_insert on public.silo_chat_responses;
create policy silo_chat_responses_insert on public.silo_chat_responses
  for insert to authenticated
  with check (created_by = auth.uid() and company_entity_id = public.active_company_id());
