-- silo_chat_audit_log.request_id: give a chat request an identity of its own,
-- so the client's crash-recovery path can ask for THAT answer instead of
-- "the newest answer to a question with this text".
--
-- Why the text match was not enough. /v2/silo-chat.html recovers a completed
-- answer out of this table whenever the fetch dies (a gateway 504 on a long
-- concept draft, a backgrounded mobile tab) but the edge function actually
-- finished and logged a row. It matched on `question = <the last user
-- message>` plus status='ok' plus a recency window. Two ways that lands on
-- the wrong row:
--   * The question text is not unique. A conversation turns on short replies
--     -- "yes", "keep going", "now by month" -- and the same words recur
--     within the recovery window, so a dropped request can recover the answer
--     to an EARLIER turn of the same conversation and present it as the reply
--     to this one.
--   * The select policy on this table is `created_by = auth.uid() OR
--     is_exec_or_owner()`. For an exec the match is not even scoped to their
--     own rows, so a colleague's answer to an identically worded question is
--     matchable.
--
-- A uuid minted by the client per request removes both: the client asks for
-- the row IT started, or gets nothing and shows the error. The column is
-- nullable and unindexed-unique on purpose:
--   * NULLABLE because every row written before this migration has no id, and
--     because a cached browser tab keeps posting without one until it
--     reloads. Recovery simply does not fire for those -- which is the right
--     failure (no answer beats someone else's answer).
--   * NOT UNIQUE because a unique violation would make the audit INSERT fail,
--     and as of the same change the edge function reports insert failures
--     instead of swallowing them. A duplicate id is a logging curiosity; it
--     must not become a user-visible error on an otherwise good answer.
alter table public.silo_chat_audit_log
  add column if not exists request_id uuid;

-- Recovery reads (request_id, created_by, status) and orders by created_at.
-- Partial: rows without a request_id are never looked up this way.
create index if not exists silo_chat_audit_log_request_idx
  on public.silo_chat_audit_log (request_id, created_at desc)
  where request_id is not null;

comment on column public.silo_chat_audit_log.request_id is
  'Client-minted uuid identifying ONE chat request. Used by the crash-recovery path in /v2/silo-chat.html to find the answer to the request it actually started, instead of matching on question text (which repeats within a conversation, and which the exec-visibility select policy does not scope to the reader). Null on rows written before 20260916121000 and on requests from a browser tab cached before it; recovery does not fire for those.';

-- The view carries an explicit column list, so a new column has to be named
-- into it or every reader keeps seeing the old shape with no error at all.
create or replace view public.silo_chat_audit_log_v
with (security_invoker = true) as
select
  l.id,
  l.company_entity_id,
  l.created_by,
  p.name as created_by_name,
  p.email as created_by_email,
  l.question,
  l.answer,
  l.queries_run,
  l.tool_rounds,
  l.status,
  l.error_message,
  l.model,
  l.created_at,
  -- Appended at the END deliberately: `create or replace view` can only add
  -- columns after the existing ones. Inserting it next to `id`, where it
  -- reads better, fails with "cannot change name of view column".
  l.request_id
from public.silo_chat_audit_log l
left join public.profiles p on p.id = l.created_by;

revoke all on public.silo_chat_audit_log_v from anon;
grant select on public.silo_chat_audit_log_v to authenticated;
