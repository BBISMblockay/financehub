-- On Deck's freshness fingerprint stops scanning the two multi-million-row fact
-- tables, and the review payload computes it once per workflow instead of once
-- per draft.
--
-- Measured on production 2026-10-16, as Blake's own user:
--   on_deck_review_state()            4379 ms, 4409 ms, 8569 ms
-- `authenticated` carries statement_timeout=8s, so the call had begun to fail
-- outright and /v2/on-deck-next.html showed every draft as "Status
-- unavailable". The page was reporting the failure correctly; the RPC was the
-- fault.
--
-- The cost is on_deck_source_version, which built its fingerprint by counting
-- whole fact tables and was called once per proposal row:
--   seo     count(*) + max(synced_at) over search_console_page_daily
--           -- 1,505,403 rows / 1499 MB, and NO index on synced_at, so a full
--           scan: 1358 ms cold, 84k buffers, 33k read from disk.
--   restock count(*) + max(synced_at) over 90 days of sales_by_day
--           -- 1,318,364 rows / 2500 MB: 5291 ms cold for the whole branch.
--           This is the restock-query timeout the 2026-10-15 22:29Z
--           preparation run hit; scripts/on-deck-prepare.mjs calls the same
--           function twice per kind.
-- Both tables grow every day, so this was getting worse daily and was never
-- going to recover on its own. The ads (28k rows) and launch (tiny) branches
-- are 29 ms and 4 ms and are left exactly as they are.
--
-- The replacement token is the sync_jobs row the importer already writes, which
-- is how the restock branch already reports its inventory and sales freshness.
-- For search_console_page_daily that is sound rather than approximate: every
-- writer of that table in this repo records job_type 'search_console_daily'
-- (scripts/lib/search-console-sync-core.mjs SEARCH_CONSOLE_JOB_TYPE, used by
-- both the daily sync and scripts/search-console-backfill.mjs). For
-- sales_by_day the restock branch ALREADY carries
-- ('inventory_snapshot','incremental_sales','history_import'), the job types
-- that write it, so dropping the table read loses no signal that line did not
-- already carry.
--   seo branch: 1358 ms -> 24 ms, and ~0 ms once the index below exists.
--
-- What this does NOT change: the fingerprint is still per (company, kind, local
-- calendar date, on_deck_settings.updated_at), the 48-hour expiry gate, the
-- absent-evidence gate, blockers, versions and every permission gate. A change
-- to the fingerprint's inputs only moves what counts as drift, and since
-- 20261015013000 drift is a notice and never blocks an approval.

-- The token read is a 53,966-row sequential scan today (23 ms) and the restock
-- branch already pays it on every call.
create index if not exists sync_jobs_company_type_status_finished
  on public.sync_jobs (company_entity_id, job_type, status, finished_at desc);

-- Body copied verbatim from 20261009171424_on_deck_source_date_once.sql, whose
-- normalised prosrc md5 (eca6472bd88911afc3fe4019f110b9aa) was confirmed to be
-- what production is running, with exactly two lines changed: the seo
-- search_console_page_daily read becomes the sync token, and the restock
-- sales_by_day read is dropped as redundant with the sync token above it.
create or replace function public.on_deck_source_version(p_company uuid,p_kind text) returns text
language plpgsql stable security definer set search_path='' as $$
declare v text; company_today date:=(now() at time zone public.silo_company_timezone(p_company))::date; begin
 if p_kind='restock' then
 select concat_ws('|',(select concat(count(*),':',max(updated_at)) from public.products_master where company_entity_id=p_company),
 (select concat(count(*),':',max(last_seen_at)) from public.shopify_product_skus where company_entity_id=p_company),
 (select max(finished_at)::text from public.sync_jobs where company_entity_id=p_company and status='success' and job_type in ('inventory_snapshot','incremental_sales','history_import')),
 (select concat(count(*),':',max(updated_at)) from public.po_headers where company_entity_id=p_company),
 (select concat(count(*),':',max(updated_at)) from public.po_lines where company_entity_id=p_company),
 (select concat(count(*),':',max(snapshot_at),':',sum(total_available_quantity)) from public.inventory_on_hand_current_mv where company_entity_id=p_company)) into v;
 elsif p_kind='launch' then
 select concat_ws('|',(select concat(count(*),':',max(updated_at)) from public.launch_calendar where company_entity_id=p_company),
 (select concat(count(*),':',max(updated_at)) from public.launch_product_readiness where company_entity_id=p_company),
 (select concat(count(*),':',max(updated_at)) from public.launch_tasks where company_entity_id=p_company and not is_private)) into v;
 elsif p_kind='seo' then
 select concat_ws('|',(select max(finished_at)::text from public.sync_jobs where company_entity_id=p_company and status='success' and job_type='search_console_daily'),
 (select concat(count(*),':',max(fetched_at)) from public.page_inspections where company_entity_id=p_company),
 (select concat(count(*),':',max(updated_at)) from public.seo_tasks where company_entity_id=p_company)) into v;
 elsif p_kind='ads' then
 select concat_ws('|',(select concat(count(*),':',max(synced_at)) from public.meta_ad_performance_daily where company_entity_id=p_company),
 (select concat(count(*),':',max(synced_at)) from public.meta_ad_creatives where company_entity_id=p_company),
 (select concat(count(*),':',max(fetched_at)) from public.page_inspections where company_entity_id=p_company)) into v;
 else raise exception 'Unknown workflow'; end if;
 return md5(p_kind||':'||company_today::text||':'||coalesce(v,'')||':'||coalesce((select updated_at::text from public.on_deck_settings where company_entity_id=p_company),''));
end $$;

-- Body copied verbatim from 20261015013000_on_deck_evidence_drift_warns.sql
-- (normalised prosrc md5 14e9ed30061f966b579d425c102e3719, confirmed installed),
-- with one change: the fingerprint is resolved once per DISTINCT KIND into
-- `vers` and read from there, instead of being called once per proposal row.
-- Six open drafts over three workflows meant six calls where three answer the
-- same question: the fingerprint reads the company's sync state, which is
-- identical for every draft of a kind within one statement.
create or replace function public.on_deck_review_state() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare co uuid:=public.active_company_id(); vers jsonb; begin
 if auth.uid() is null or not coalesce(public.on_deck_can_review(),false) then raise exception 'Company admin required' using errcode='42501'; end if;
 select coalesce(jsonb_object_agg(k,public.on_deck_source_version(co,k)),'{}'::jsonb) into vers
 from (select distinct kind k from public.on_deck_proposals where company_entity_id=co and status not in ('completed','dismissed','screened')) s;
 return jsonb_build_object(
 'review_contract',2,'drift_warns',true,'purchasing',coalesce(public.po_builder_can_write(),false),
 'seo',coalesce(public.can_approve_seo_tasks(),false),
 'context_tasks',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'notes',left(public.on_deck_context_findings(t.notes,p.context_work),4000),'notes_truncated',length(public.on_deck_context_findings(t.notes,p.context_work))>4000,'notes_are_request',public.on_deck_context_findings(t.notes,p.context_work)='','status',t.status,'title',t.task_title,'owner',coalesce(u.name,u.email))),'[]') from public.on_deck_proposals p join public.launch_tasks t on t.id=nullif(p.context_work->>'task_id','')::uuid and t.company_entity_id=co and not t.is_private left join public.profiles u on u.id=t.assigned_to_user_id where p.company_entity_id=co and p.status not in ('completed','dismissed','screened')),
 'proposals',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'source_current',p.source_version=vers->>p.kind,'expired',p.valid_until<=now(),'blockers',public.on_deck_draft_blockers(p.content,p.kind),'preparation',public.on_deck_preparation_state(p))),'[]') from public.on_deck_proposals p where p.company_entity_id=co and p.status not in ('completed','dismissed','screened')),
 'assignees',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',coalesce(p.name,p.email)) order by coalesce(p.name,p.email)),'[]') from public.profiles p join public.entity_memberships m on m.user_id=p.id and m.entity_id=co where p.is_active and m.role in ('owner_admin','admin','member')),
 'tasks',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from (select t.id,t.task_title,t.assigned_to_user_id,t.status from public.launch_tasks t where t.company_entity_id=co and not t.is_private and t.status<>'done' and exists(select 1 from public.profiles p join public.entity_memberships m on m.user_id=p.id where p.id=t.assigned_to_user_id and p.is_active and m.entity_id=co and m.role in ('owner_admin','admin','member')) order by t.updated_at desc,t.id limit 100) t));
end $$;

-- CREATE OR REPLACE preserves the existing grants: on_deck_source_version stays
-- service_role-only (it is called from inside definer functions, never by the
-- browser) and on_deck_review_state stays callable by authenticated.
-- No timeout changes.
