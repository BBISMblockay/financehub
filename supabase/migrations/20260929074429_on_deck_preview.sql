-- On Deck is an opt-in preview. No seed enables spending. No external writes.
create table if not exists public.on_deck_settings (
 company_entity_id uuid primary key references public.entities(id),
 enabled boolean not null default false,
 monthly_cap_usd numeric(8,2) not null default 100 check(monthly_cap_usd between 0 and 100),
 buy_budget numeric check(buy_budget > 0),
 workflows text[] not null default array['restock','launch','seo','ads']
   check(workflows <@ array['restock','launch','seo','ads']),
 requested_at timestamptz, last_screen_at timestamptz, last_status text,
 diagnostics jsonb not null default '{}', updated_at timestamptz not null default now()
);
create table if not exists public.on_deck_proposals (
 id uuid primary key default gen_random_uuid(), company_entity_id uuid not null references public.entities(id),
 kind text not null check(kind in ('restock','launch','seo','ads')),
 source_key text not null check(length(source_key) between 1 and 300),
 source_id uuid, source jsonb not null, source_version text not null,
 title text not null check(length(title) between 1 and 240),
 score numeric not null default 0, selection_reason text not null,
 status text not null default 'preparing' check(status in ('preparing','ready','needs_info','revision','failed','dismissed','completed','screened')),
 content jsonb not null default '{}', version integer not null default 1,
 revision_request text, user_edited boolean not null default false,
 output jsonb, approved_by uuid references auth.users(id), approved_at timestamptz,
 dismiss_reason text, revisit_at timestamptz,
 value_minutes integer check(value_minutes between 0 and 100000), value_note text,
 value_recorded_by uuid references auth.users(id), value_recorded_at timestamptz,
 valid_until timestamptz not null default now()+interval '48 hours',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists on_deck_open_source on public.on_deck_proposals(company_entity_id,kind,source_key)
 where status not in ('dismissed','completed','screened');
create index if not exists on_deck_queue on public.on_deck_proposals(company_entity_id,status,updated_at desc);
create table if not exists public.on_deck_attempts (
 id uuid primary key, company_entity_id uuid not null references public.entities(id),
 proposal_id uuid not null references public.on_deck_proposals(id), proposal_version integer not null,
 state text not null default 'reserved' check(state in ('reserved','succeeded','failed','unknown')),
 reserved_usd numeric(10,6) not null default 0.25 check(reserved_usd=0.25),
 cost_usd numeric(10,6) check(cost_usd>=0), input_tokens integer, output_tokens integer,
 model text not null default 'claude-sonnet-5', pricing jsonb not null default '{"input_per_million":2,"output_per_million":10}',
 error_code text, created_at timestamptz not null default now(), finished_at timestamptz
);
create unique index if not exists on_deck_one_attempt on public.on_deck_attempts(proposal_id) where state='reserved';
create table if not exists public.on_deck_events (
 id uuid primary key default gen_random_uuid(), company_entity_id uuid not null references public.entities(id),
 proposal_id uuid not null references public.on_deck_proposals(id), event_type text not null,
 actor_id uuid references auth.users(id), detail jsonb not null default '{}', created_at timestamptz not null default now()
);

-- Explicit membership, no legacy global-role fallback. New preview is admin-only.
create or replace function public.on_deck_can_review() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p join public.entity_memberships m on m.user_id=p.id
 where p.id=auth.uid() and p.is_active and m.entity_id=public.active_company_id() and m.role in ('owner_admin','admin'))
$$;
revoke all on function public.on_deck_can_review() from public,anon;
grant execute on function public.on_deck_can_review() to authenticated;
do $$declare t text; begin
 foreach t in array array['on_deck_settings','on_deck_proposals','on_deck_attempts','on_deck_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
  execute format('drop policy if exists on_deck_read on public.%I',t);
  execute format('create policy on_deck_read on public.%I for select to authenticated using(company_entity_id=(select public.active_company_id()) and (select public.on_deck_can_review()))',t);
 end loop;
end $$;

create or replace function public.on_deck_configure(p_enabled boolean,p_cap numeric,p_buy_budget numeric,p_workflows text[])
returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(public.on_deck_can_review(),false) or not exists(
 select 1 from public.entity_memberships where user_id=auth.uid() and entity_id=public.active_company_id() and role='owner_admin') then
 raise exception 'Company owner permission required' using errcode='42501'; end if;
 insert into public.on_deck_settings(company_entity_id,enabled,monthly_cap_usd,buy_budget,workflows)
 values(public.active_company_id(),p_enabled,p_cap,p_buy_budget,p_workflows)
 on conflict(company_entity_id) do update set enabled=excluded.enabled,monthly_cap_usd=excluded.monthly_cap_usd,
 buy_budget=excluded.buy_budget,workflows=excluded.workflows,updated_at=now();
end $$;
create or replace function public.on_deck_request_preparation() returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(public.on_deck_can_review(),false) then raise exception 'Company admin required' using errcode='42501'; end if;
 update public.on_deck_settings set requested_at=now() where company_entity_id=public.active_company_id() and enabled;
 if not found then raise exception 'An owner must enable preparation first'; end if;
end $$;

-- Service-only source epoch. Any changed feed/catalog/PO invalidates old recommendations.
-- No impersonation of an owner session by the scheduled worker.
create or replace function public.on_deck_source_version(p_company uuid,p_kind text) returns text
language plpgsql stable security definer set search_path='' as $$
declare v text; begin
 if p_kind='restock' then
 select concat_ws('|',(select concat(count(*),':',max(updated_at)) from public.products_master where company_entity_id=p_company),
 (select concat(count(*),':',max(last_seen_at)) from public.shopify_product_skus where company_entity_id=p_company),
 (select max(finished_at)::text from public.sync_jobs where company_entity_id=p_company and status='success' and job_type in ('inventory_snapshot','incremental_sales','history_import')),
 (select concat(count(*),':',max(updated_at)) from public.po_headers where company_entity_id=p_company),
 (select concat(count(*),':',max(updated_at)) from public.po_lines where company_entity_id=p_company),
 (select concat(count(*),':',max(synced_at)) from public.sales_by_day where company_entity_id=p_company and day_date>=(now() at time zone public.silo_company_timezone(p_company))::date-90),
 (select concat(count(*),':',max(snapshot_at),':',sum(total_available_quantity)) from public.inventory_on_hand_current_mv where company_entity_id=p_company)) into v;
 elsif p_kind='launch' then
 select concat_ws('|',(select concat(count(*),':',max(updated_at)) from public.launch_calendar where company_entity_id=p_company),
 (select concat(count(*),':',max(updated_at)) from public.launch_product_readiness where company_entity_id=p_company),
 (select concat(count(*),':',max(updated_at)) from public.launch_tasks where company_entity_id=p_company and not is_private)) into v;
 elsif p_kind='seo' then
 select concat_ws('|',(select concat(count(*),':',max(synced_at)) from public.search_console_page_daily where company_entity_id=p_company),
 (select concat(count(*),':',max(fetched_at)) from public.page_inspections where company_entity_id=p_company)) into v;
 elsif p_kind='ads' then
 select concat_ws('|',(select concat(count(*),':',max(synced_at)) from public.meta_ad_performance_daily where company_entity_id=p_company),
 (select concat(count(*),':',max(synced_at)) from public.meta_ad_creatives where company_entity_id=p_company)) into v;
 else raise exception 'Unknown workflow'; end if;
 return md5(p_kind||':'||(now() at time zone public.silo_company_timezone(p_company))::date::text||':'||coalesce(v,'')||':'||coalesce((select updated_at::text from public.on_deck_settings where company_entity_id=p_company),''));
end $$;

-- Serialized admission: at most three open proposals/workflow, six/company.
-- Completed and dismissed decisions cool down; reviewed edits aren't overwritten.
create or replace function public.on_deck_stage(p_company uuid,p_candidate jsonb,p_source_version text)
returns uuid language plpgsql security definer set search_path='' as $$
declare r public.on_deck_proposals; k text:=p_candidate->>'kind'; key text:=p_candidate->>'key'; begin
 perform pg_advisory_xact_lock(hashtextextended('on-deck:'||p_company::text,0));
 if not exists(select 1 from public.on_deck_settings where company_entity_id=p_company and enabled and k=any(workflows)) then return null; end if;
 if p_source_version is distinct from public.on_deck_source_version(p_company,k) then raise exception 'Source changed during screening'; end if;
 select * into r from public.on_deck_proposals where company_entity_id=p_company and kind=k and source_key=key order by created_at desc limit 1 for update;
 if found then
  if r.status in ('completed','dismissed','screened') and coalesce(r.revisit_at,'infinity'::timestamptz)>now() then return null; end if;
  if r.status not in ('completed','dismissed','screened') then
   if r.status in ('preparing','revision') or r.user_edited or r.source_version=p_source_version then return null; end if;
   if exists(select 1 from public.on_deck_attempts where proposal_id=r.id and state='reserved') then return null; end if;
   insert into public.on_deck_events(company_entity_id,proposal_id,event_type,detail) values(p_company,r.id,'evidence_changed',jsonb_build_object('previous_content',r.content));
   update public.on_deck_proposals set source=p_candidate->'source',source_id=nullif(p_candidate->>'source_id','')::uuid,title=p_candidate->>'title',source_version=p_source_version,status='preparing',version=version+1,
    score=(p_candidate->>'score')::numeric,selection_reason=p_candidate->>'reason',valid_until=now()+interval '48 hours',updated_at=now() where id=r.id;
   return r.id;
  end if;
 end if;
 if (select count(*) from public.on_deck_proposals where company_entity_id=p_company and status not in ('completed','dismissed','screened'))>=6
 or (select count(*) from public.on_deck_proposals where company_entity_id=p_company and kind=k and status not in ('completed','dismissed','screened'))>=3 then return null; end if;
 insert into public.on_deck_proposals(company_entity_id,kind,source_key,source_id,source,source_version,title,score,selection_reason)
 values(p_company,k,key,nullif(p_candidate->>'source_id','')::uuid,p_candidate->'source',p_source_version,p_candidate->>'title',(p_candidate->>'score')::numeric,p_candidate->>'reason') returning id into r.id;
 return r.id;
end $$;

create or replace function public.on_deck_reserve(p_id uuid,p_version integer,p_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.on_deck_proposals; s public.on_deck_settings; spent numeric; a public.on_deck_attempts; begin
 select * into r from public.on_deck_proposals where id=p_id;
 if not found then raise exception 'Proposal missing'; end if;
 perform pg_advisory_xact_lock(hashtextextended('on-deck:'||r.company_entity_id::text,0));
 select * into a from public.on_deck_attempts where id=p_request;
 if found then return jsonb_build_object('run',a.id,'claimed',false,'state',a.state); end if;
 select * into r from public.on_deck_proposals where id=p_id for update;
 select * into s from public.on_deck_settings where company_entity_id=r.company_entity_id for update;
 if s.enabled is distinct from true or not r.kind=any(s.workflows) then return jsonb_build_object('claimed',false,'reason','disabled'); end if;
 if r.version is distinct from p_version or r.status not in ('preparing','revision','failed') then return jsonb_build_object('claimed',false,'reason','changed'); end if;
 if r.source_version<>public.on_deck_source_version(r.company_entity_id,r.kind) or r.valid_until<now() then return jsonb_build_object('claimed',false,'reason','stale'); end if;
 if exists(select 1 from public.on_deck_attempts where proposal_id=p_id and state='reserved') then return jsonb_build_object('claimed',false,'reason','in_progress'); end if;
 select coalesce(sum(coalesce(cost_usd,reserved_usd)),0) into spent from public.on_deck_attempts
 where company_entity_id=r.company_entity_id and created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC';
 if spent+0.25>s.monthly_cap_usd then return jsonb_build_object('claimed',false,'reason','budget_cap'); end if;
 if (select count(*) from public.on_deck_attempts where company_entity_id=r.company_entity_id and created_at>=now()-interval '24 hours')>=20 then return jsonb_build_object('claimed',false,'reason','daily_cap'); end if;
 insert into public.on_deck_attempts(id,company_entity_id,proposal_id,proposal_version) values(p_request,r.company_entity_id,p_id,p_version);
 return jsonb_build_object('claimed',true,'run',p_request);
end $$;

create or replace function public.on_deck_valid_content(p_content jsonb,p_kind text) returns boolean
language plpgsql immutable set search_path='' as $$
declare field text; item jsonb; begin
 if jsonb_typeof(p_content) is distinct from 'object' or jsonb_typeof(p_content->'recommend') is distinct from 'boolean' then return false; end if;
 foreach field in array array['subject','summary','body','reason'] loop
  if jsonb_typeof(p_content->field) is distinct from 'string' then return false; end if;
 end loop;
 if length(p_content->>'subject')>200 or length(p_content->>'summary')>500 or length(p_content->>'body')>5000 or length(p_content->>'reason')>2000 then return false; end if;
 if p_content->>'recommend'='true' and (length(btrim(p_content->>'subject'))=0 or length(btrim(p_content->>'body'))=0) then return false; end if;
 if jsonb_typeof(p_content->'missing') is distinct from 'array' or jsonb_typeof(p_content->'tasks') is distinct from 'array' then return false; end if;
 if jsonb_array_length(p_content->'missing')>10 or jsonb_array_length(p_content->'tasks')>5 then return false; end if;
 for item in select value from jsonb_array_elements(p_content->'missing') loop
  if jsonb_typeof(item)<>'string' or length(item#>>'{}')>500 then return false; end if;
 end loop;
 if p_kind='launch' and p_content->>'recommend'='true' and jsonb_array_length(p_content->'tasks')<1 then return false; end if;
 for item in select value from jsonb_array_elements(p_content->'tasks') loop
  if jsonb_typeof(item->'title') is distinct from 'string' or coalesce(length(btrim(item->>'title')),0) not between 1 and 200 or jsonb_typeof(item->'detail') is distinct from 'string' or length(item->>'detail')>1500 then return false; end if;
 end loop;
 return true;
end $$;
create or replace function public.on_deck_stats() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare co uuid:=public.active_company_id(); start_at timestamptz:=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'; result jsonb; begin
 if auth.uid() is null or not coalesce(public.on_deck_can_review(),false) then raise exception 'Company admin required' using errcode='42501'; end if;
 select jsonb_build_object('spent',coalesce(sum(coalesce(cost_usd,reserved_usd)),0),
  'unknown_or_reserved',coalesce(sum(coalesce(cost_usd,reserved_usd)) filter(where state in ('unknown','reserved')),0),
  'failed_attempts',count(*) filter(where state in ('failed','unknown')),'attempts',count(*)) into result
 from public.on_deck_attempts where company_entity_id=co and created_at>=start_at;
 return result || jsonb_build_object(
  'actions',(select count(*) from public.on_deck_proposals where company_entity_id=co and approved_at>=start_at),
  'edited_actions',(select count(*) from public.on_deck_proposals where company_entity_id=co and approved_at>=start_at and user_edited),
  'dismissed',(select count(*) from public.on_deck_proposals where company_entity_id=co and status='dismissed' and updated_at>=start_at),
  'minutes',(select sum(value_minutes) from public.on_deck_proposals where company_entity_id=co and value_recorded_at>=start_at),
  'workflow_spend',(select coalesce(jsonb_object_agg(kind,usd),'{}') from (select p.kind,sum(coalesce(a.cost_usd,a.reserved_usd)) usd
    from public.on_deck_attempts a join public.on_deck_proposals p on p.id=a.proposal_id and p.company_entity_id=co where a.company_entity_id=co and a.created_at>=start_at group by p.kind) costs));
end $$;

create or replace function public.on_deck_finish(p_request uuid,p_content jsonb,p_input integer,p_output integer,p_error text)
returns void language plpgsql security definer set search_path='' as $$
declare a public.on_deck_attempts; r public.on_deck_proposals; cost numeric; next_status text; begin
 select * into a from public.on_deck_attempts where id=p_request for update;
 if not found then raise exception 'Unknown attempt'; end if;
 if a.state<>'reserved' then return; end if;
 if p_input is null or p_output is null then cost:=a.reserved_usd;
 else
  if p_input<0 or p_output<0 then raise exception 'Invalid usage'; end if;
  cost:=p_input*0.000002+p_output*0.000010;
  if cost>a.reserved_usd then raise exception 'Usage exceeds reserved bound; keep hold for reconciliation'; end if;
 end if;
 update public.on_deck_attempts set state=case when p_input is null or p_output is null then 'unknown' when p_error is not null then 'failed' else 'succeeded' end,
 cost_usd=cost,input_tokens=p_input,output_tokens=p_output,error_code=p_error,finished_at=now() where id=p_request;
 select * into r from public.on_deck_proposals where id=a.proposal_id for update;
 if r.version<>a.proposal_version or r.status not in ('preparing','revision','failed') then return; end if;
 if p_error is not null or p_content is null then next_status:='failed';
 elsif not public.on_deck_valid_content(p_content,r.kind) then raise exception 'Invalid prepared content';
 elsif p_content->>'recommend'='false' then next_status:='screened';
 elsif jsonb_array_length(coalesce(p_content->'missing','[]'::jsonb))>0 then next_status:='needs_info';
 else next_status:='ready'; end if;
 insert into public.on_deck_events(company_entity_id,proposal_id,event_type,detail)
 values(r.company_entity_id,r.id,case when r.revision_request is null then 'prepared' else 'revised' end,
 jsonb_build_object('previous_content',r.content,'instruction',r.revision_request,'attempt',p_request,'error',p_error));
 update public.on_deck_proposals set content=coalesce(p_content,content),status=next_status,version=version+1,
 revisit_at=case when next_status='screened' then now()+interval '14 days' else revisit_at end,
 valid_until=now()+interval '48 hours',updated_at=now(),revision_request=case when p_error is null then null else revision_request end where id=r.id;
end $$;

-- The user decides on the exact displayed version. All mutations are RPC-only.
create or replace function public.on_deck_decide(p_id uuid,p_version integer,p_action text,p_note text default null,p_content jsonb default null,p_minutes integer default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.on_deck_proposals; oid uuid; pid uuid; family jsonb; c jsonb; v_output jsonb; item jsonb; taskids jsonb:='[]'; begin
 if auth.uid() is null or not coalesce(public.on_deck_can_review(),false) then raise exception 'Company admin required' using errcode='42501'; end if;
 select * into r from public.on_deck_proposals where id=p_id and company_entity_id=public.active_company_id() for update;
 if not found then raise exception 'Proposal unavailable' using errcode='42501'; end if;
 if p_action='approve' and r.status='completed' and r.output is not null then return to_jsonb(r); end if;
 if r.version is distinct from p_version then raise exception 'Proposal changed. Reload before deciding' using errcode='40001'; end if;
 if p_action='value' then
  if r.status<>'completed' or p_minutes is null or p_minutes not between 0 and 100000 or coalesce(length(btrim(p_note)),0)=0 then raise exception 'Record minutes and an observed outcome after completion'; end if;
  update public.on_deck_proposals set value_minutes=p_minutes,value_note=left(p_note,4000),value_recorded_by=auth.uid(),value_recorded_at=now(),version=version+1 where id=r.id;
 elsif p_action='dismiss' then
  if r.status='completed' then raise exception 'Completed actions cannot be dismissed'; end if;
  if coalesce(length(btrim(p_note)),0)=0 then raise exception 'Give a reason for dismissal'; end if;
  update public.on_deck_proposals set status='dismissed',dismiss_reason=left(p_note,2000),revisit_at=now()+interval '30 days',version=version+1,updated_at=now() where id=r.id;
 elsif p_action in ('revise','edit') then
  if r.status in ('completed','dismissed','screened','preparing','revision') then raise exception 'Wait for preparation or open a new decision'; end if;
  if p_action='revise' and coalesce(length(btrim(p_note)),0) not between 1 and 2000 then raise exception 'Describe the revision'; end if;
  if r.source_version<>public.on_deck_source_version(r.company_entity_id,r.kind) then raise exception 'Evidence changed. Request a fresh preparation first'; end if;
  if p_action='edit' and (not public.on_deck_valid_content(p_content,r.kind) or p_content->>'recommend'<>'true' or octet_length(p_content::text)>24000) then raise exception 'Invalid draft'; end if;
  if p_action='edit' and coalesce(r.content->'missing','[]') is distinct from p_content->'missing' and coalesce(length(btrim(p_note)),0)<12 then raise exception 'Explain how the missing evidence was resolved'; end if;
  insert into public.on_deck_events(company_entity_id,proposal_id,event_type,actor_id,detail) values(r.company_entity_id,r.id,p_action,auth.uid(),jsonb_build_object('previous_content',r.content,'note',p_note));
  update public.on_deck_proposals set status=case when p_action='revise' then 'revision' when jsonb_array_length(p_content->'missing')>0 then 'needs_info' else 'ready' end,
   content=case when p_action='edit' then p_content else content end,revision_request=case when p_action='revise' then p_note end,
   user_edited=true,version=version+1,updated_at=now() where id=r.id;
  if p_action='revise' then update public.on_deck_settings set requested_at=now() where company_entity_id=r.company_entity_id; end if;
 elsif p_action='cancel_revision' then
  if r.status<>'revision' then raise exception 'No pending revision'; end if;
  insert into public.on_deck_events(company_entity_id,proposal_id,event_type,actor_id,detail) values(r.company_entity_id,r.id,'revision_cancelled',auth.uid(),jsonb_build_object('instruction',r.revision_request));
  update public.on_deck_proposals set status=case when not public.on_deck_valid_content(r.content,r.kind) then 'failed' when jsonb_array_length(r.content->'missing')>0 then 'needs_info' else 'ready' end,
   revision_request=null,version=version+1,updated_at=now() where id=r.id;
 elsif p_action='refresh' then
  if r.status in ('completed','dismissed','screened','preparing','revision') then raise exception 'This decision cannot be refreshed'; end if;
  update public.on_deck_proposals set user_edited=false,source_version='',status='failed',version=version+1,updated_at=now() where id=r.id;
  update public.on_deck_settings set requested_at=now() where company_entity_id=r.company_entity_id;
 elsif p_action='approve' then
  if r.status<>'ready' then raise exception 'Review a prepared proposal first'; end if;
  if r.valid_until<now() or r.source_version<>public.on_deck_source_version(r.company_entity_id,r.kind) then raise exception 'Evidence changed or expired. Refresh and review again'; end if;
  if not public.on_deck_valid_content(r.content,r.kind) or r.content->>'recommend'<>'true' or coalesce(length(btrim(r.content->>'body')),0)=0 or jsonb_array_length(coalesce(r.content->'missing','[]'::jsonb))>0 then raise exception 'Resolve missing information first'; end if;
  if r.kind='restock' then
   if not coalesce(public.po_builder_can_write(),false) then raise exception 'Purchasing permission required'; end if;
   if coalesce(length(btrim(p_note)),0)<12 then raise exception 'Record product-level vetting: demand, margin, seasonality, incoming stock and cash'; end if;
   -- This approves product investigation, NOT size quantities or a purchase.
   family:=public.product_workflow_catalog_source(r.company_entity_id,r.source_id,r.source->'catalog_group');
   c:=jsonb_build_object('title',r.title,'design_intent',r.content->>'body','catalog_scope','product',
    'catalog_group',r.source->'catalog_group','source_updated_at',family->'updated_at',
    'source_variant_identity',public.product_workflow_variant_identity(family),
    'source_variant_versions',(select jsonb_agg(jsonb_build_object('id',v->'id','updated_at',v->'updated_at') order by v->>'id') from jsonb_array_elements(family->'variants') v),
    'lines',(select jsonb_agg(jsonb_build_object('product_master_id',v->'id','sku',v->'sku','size',v->'variant_title','qty',null) order by v->>'id') from jsonb_array_elements(family->'variants') v),
    'decision_note',p_note,'on_deck_proposal_id',r.id,'product_vetting',r.source->'vetting');
   oid:=gen_random_uuid();
   perform public.save_product_workflow_brief(r.company_entity_id,oid,0,'restock',r.source_id,c,'draft');
   v_output:=jsonb_build_object('kind','product_brief','id',oid,'url','/v3/product-workflow.html?brief='||oid::text,'label','Product brief created — size allocation and PO approval remain');
  elsif r.kind='seo' then
   if not coalesce(public.can_approve_seo_tasks(),false) then raise exception 'SEO approval permission required'; end if;
   -- One ordinary project per approved decision; no ambiguous title-based singleton.
   insert into public.seo_projects(company_entity_id,name,status,evidence_note,created_by) values(r.company_entity_id,left(r.title,200),'active',r.selection_reason,auth.uid()) returning id into pid;
   insert into public.seo_tasks(company_entity_id,project_id,title,target_type,target_url,rationale,proposed_title,proposed_meta_description,proposed_body,approval_status,created_by)
   values(r.company_entity_id,pid,left(r.title,200),'page',r.source->>'url',r.content->>'reason',left(r.content->>'subject',200),left(r.content->>'summary',500),r.content->>'body','draft',auth.uid()) returning id into oid;
   v_output:=jsonb_build_object('kind','seo_task','id',oid,'url','/v2/seo-tasks.html','label','SEO draft created — publishing requires separate review');
  elsif r.kind='ads' then
   insert into public.ad_ideas(company_entity_id,title,hook,angle,body_draft,objective,baseline_ad_ids,baseline_snapshot,source,created_by,status)
   values(r.company_entity_id,left(r.title,200),left(r.content->>'subject',500),left(r.content->>'summary',2000),left(r.content->>'body',5000),r.source->>'objective',array[r.source->>'ad_id'],r.source->'baseline','from_ad',auth.uid(),'idea') returning id into oid;
   v_output:=jsonb_build_object('kind','ad_idea','id',oid,'url','/v2/ad-studio.html','label','Ad idea created — no campaign or budget changed');
  elsif r.kind='launch' then
   if not exists(select 1 from public.launch_calendar where id=r.source_id and company_entity_id=r.company_entity_id) then raise exception 'Launch unavailable'; end if;
   if jsonb_typeof(r.content->'tasks') is distinct from 'array' or jsonb_array_length(r.content->'tasks') not between 1 and 5 then raise exception 'Review one to five launch tasks'; end if;
   for item in select value from jsonb_array_elements(r.content->'tasks') loop
    if coalesce(length(btrim(item->>'title')),0) not between 1 and 200 then raise exception 'Invalid launch task'; end if;
    insert into public.launch_tasks(company_entity_id,launch_id,task_title,task_type,status,notes,created_by,is_private)
    values(r.company_entity_id,r.source_id,item->>'title','marketing','open',concat_ws(E'\n',item->>'detail','On Deck '||r.id::text,'Approved draft copy: '||(r.content->>'body')),auth.uid(),false) returning id into oid;
    taskids:=taskids||to_jsonb(oid);
   end loop;
   v_output:=jsonb_build_object('kind','launch_tasks','ids',taskids,'url','/v2/launch-calendar.html','label','Launch tasks created — copy is not published');
  end if;
  update public.on_deck_proposals set status='completed',output=v_output,approved_at=now(),approved_by=auth.uid(),version=version+1,updated_at=now(),revisit_at=now()+interval '30 days' where id=r.id;
  insert into public.on_deck_events(company_entity_id,proposal_id,event_type,actor_id,detail)
   values(r.company_entity_id,r.id,'action_confirmed',auth.uid(),jsonb_build_object('approved_content',r.content,'product_review',p_note,'output',v_output));
 else raise exception 'Unknown action'; end if;
 if p_action in ('dismiss','refresh','value') then
  insert into public.on_deck_events(company_entity_id,proposal_id,event_type,actor_id,detail) values(r.company_entity_id,r.id,p_action,auth.uid(),jsonb_build_object('note',p_note,'minutes',p_minutes,'previous_status',r.status));
 end if;
 select * into r from public.on_deck_proposals where id=p_id;
 return to_jsonb(r);
end $$;

-- Company-bound preparation facts. Never expose these service queries to browsers.
-- Aggregate only the selected catalog page, keeping the RPC response bounded.
create or replace function public.on_deck_product_facts(p_company uuid,p_offset integer default 0)
returns setof jsonb language sql stable security definer set search_path='' as $$
 with day as (select (now() at time zone public.silo_company_timezone(p_company))::date d),
 catalog as (select p.* from public.products_master p where company_entity_id=p_company order by id limit 500 offset greatest(p_offset,0))
 select to_jsonb(p)||jsonb_build_object('sales',to_jsonb(s),'stock',to_jsonb(i),'incoming',to_jsonb(o))
 from catalog p cross join day
 left join lateral (
  select coalesce(sum(total_quantity_sold) filter(where day_date>=d-30),0) units30,
   coalesce(sum(total_quantity_sold),0) units90,coalesce(sum(total_net_sales),0) net90,
   count(distinct day_date) filter(where total_quantity_sold>0) selling_days,
   min(day_date) filter(where total_quantity_sold>0) first_day,max(day_date) filter(where total_quantity_sold>0) last_day,max(synced_at) synced_at
  from public.sales_by_day where company_entity_id=p_company and sku=p.sku and day_date>=d-90 and day_date<d
 ) s on true
 left join lateral (
  select sum(total_available_quantity) units,min(snapshot_at) snapshot_at,count(distinct shop_domain) shops
  from public.inventory_on_hand_current_mv where company_entity_id=p_company and variant_sku=p.sku
 ) i on true
 left join lateral (
  select coalesce(sum(l.qty),0) units,
   count(*) filter(where h.status='Partially Received' or h.expected_arrival_date is null or h.expected_arrival_date<d) uncertain
  from public.po_lines l join public.po_headers h on h.id=l.po_header_id and h.company_entity_id=p_company
  where l.company_entity_id=p_company and l.sku_snapshot=p.sku
   and h.status in ('Approved','Sent to Factory','Confirmed','In Production','Shipped','In Transit','Partially Received')
 ) o on true
$$;
create or replace function public.on_deck_seo_facts(p_company uuid,p_offset integer default 0)
returns setof jsonb language sql stable security definer set search_path='' as $$
 with day as (select (now() at time zone public.silo_company_timezone(p_company))::date d),
 -- Multiple connected properties can repeat a page/day. Choose one observation,
 -- never add overlapping domain/URL-prefix properties together.
 daily as (select distinct on (page,day_date) page,day_date,clicks,impressions,position,synced_at
  from public.search_console_page_daily,day where company_entity_id=p_company and day_date between d-29 and d-2
  order by page,day_date,impressions desc,synced_at desc),
 pages as (select page url,sum(clicks) clicks,sum(impressions) impressions,
   sum(position*impressions)/nullif(sum(impressions),0) position,count(*) days,
   max(day_date) last_day,max(synced_at) synced_at
  from daily group by page order by page limit 500 offset greatest(p_offset,0))
 select to_jsonb(p)||jsonb_build_object('inspection',to_jsonb(i)) from pages p
 left join lateral (select title,meta_description,h1,word_count,final_url,http_status,fetch_error,fetched_at
  from public.page_inspections where company_entity_id=p_company and requested_url=p.url order by fetched_at desc limit 1) i on true
$$;
create or replace function public.on_deck_ad_facts(p_company uuid,p_offset integer default 0)
returns setof jsonb language sql stable security definer set search_path='' as $$
 with day as (select (now() at time zone public.silo_company_timezone(p_company))::date d),
 ads as (select ad_id,max(ad_name) ad_name,public.meta_campaign_group(max(campaign_name)) objective,
  count(distinct public.meta_campaign_group(campaign_name)) objective_count,
  sum(spend) spend,sum(impressions) impressions,sum(clicks) clicks,sum(conversions) conversions,
  sum(conversion_value) conversion_value,sum(thruplays) thruplays,sum(leads) leads,
  min(day_date) first_day,max(day_date) last_day,max(synced_at) synced_at
  from public.meta_ad_performance_daily,day where company_entity_id=p_company and day_date>=d-30 and day_date<d
  group by ad_id order by ad_id limit 500 offset greatest(p_offset,0))
 select to_jsonb(a)||jsonb_build_object('creative',to_jsonb(c)) from ads a
 left join lateral(select body,title,link_url,effective_status,synced_at from public.meta_ad_creatives
  where company_entity_id=p_company and ad_id=a.ad_id order by synced_at desc limit 1) c on true
$$;
create or replace function public.on_deck_launch_facts(p_company uuid,p_offset integer default 0)
returns setof jsonb language sql stable security definer set search_path='' as $$
 with day as (select (now() at time zone public.silo_company_timezone(p_company))::date d),
 launches as (select l.* from public.launch_calendar l,day where company_entity_id=p_company and launch_date between d and d+30
  and lower(coalesce(status,'')) not in ('cancelled','canceled','complete','completed','archived') order by id limit 500 offset greatest(p_offset,0))
 select jsonb_build_object('id',l.id,'title',l.title,'launch_date',l.launch_date,'design_intent',l.design_intent,
  'audience',l.audience,'marketing_angle',l.marketing_angle,'product_callouts',l.product_callouts,'copy_dos',l.copy_dos,'copy_donts',l.copy_donts,
  'readiness',coalesce((select jsonb_agg(jsonb_build_object('product',r.product_title,'status',r.readiness_status))
    from public.launch_product_readiness r where r.company_entity_id=p_company and r.launch_id=l.id),'[]'::jsonb),
  'tasks',coalesce((select jsonb_agg(jsonb_build_object('title',t.task_title,'status',t.status))
    from public.launch_tasks t where t.company_entity_id=p_company and t.launch_id=l.id and not t.is_private),'[]'::jsonb))
 from launches l
$$;

-- New functions have EXECUTE to PUBLIC by default: revoke all then allow explicitly.
do $$declare f record; begin
 for f in select p.oid::regprocedure as signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'on_deck_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if f.proname in ('on_deck_can_review','on_deck_stats','on_deck_configure','on_deck_request_preparation','on_deck_decide') then
   execute format('grant execute on function %s to authenticated',f.signature);
  else execute format('grant execute on function %s to service_role',f.signature); end if;
 end loop;
end $$;
select public.attach_stamp_company_entity_id_triggers();
