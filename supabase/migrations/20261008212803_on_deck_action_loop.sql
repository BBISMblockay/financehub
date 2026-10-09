-- Context work is not approval. Existing Tasks owns assignment and execution.
alter table public.on_deck_proposals add column if not exists context_work jsonb not null default '{}';

-- Every task writer participates in evidence freshness, including Task Manager.
create or replace function public.on_deck_touch_launch_task() returns trigger
language plpgsql set search_path='' as $$
begin new.updated_at:=now(); return new; end $$;
revoke all on function public.on_deck_touch_launch_task() from public,anon,authenticated;
drop trigger if exists on_deck_touch_launch_task on public.launch_tasks;
create trigger on_deck_touch_launch_task before update on public.launch_tasks
for each row execute function public.on_deck_touch_launch_task();

-- Store only a digest and length of the immutable request, never a large notes snapshot.
-- Preview and save use the same extraction; reviewers still verify factual adequacy.
create or replace function public.on_deck_context_findings(p_note text,p_work jsonb) returns text
language plpgsql immutable set search_path='' as $$
declare note text:=btrim(replace(coalesce(p_note,''),E'\r\n',E'\n'),E' \n\r\t'); prefix_length integer:=coalesce((p_work->>'request_notes_length')::integer,0); words text; begin
 if md5(note)=p_work->>'request_notes_hash' then return ''; end if;
 if prefix_length>0 and md5(left(note,prefix_length))=p_work->>'request_notes_hash' then note:=btrim(substr(note,prefix_length+1),E' \n\r\t'); end if;
 -- Edited request templates cannot silently become evidence. Enter clean findings instead.
 if note ~* '(On Deck (proposal|context request):|/v2/on-deck[.]html[?]proposal=)' then return ''; end if;
 words:=btrim(regexp_replace(lower(note),'[^[:alnum:]]+',' ','g'));
 if length(regexp_replace(words,' ','','g'))<12 or words ~ '^(tbd|todo|pending|awaiting|still|review|in|progress|not|yet|done|complete|completed|status|update|updated|waiting|for|the|evidence|findings|sources|to|be|confirmed|unknown)( (tbd|todo|pending|awaiting|still|review|in|progress|not|yet|done|complete|completed|status|update|updated|waiting|for|the|evidence|findings|sources|to|be|confirmed|unknown))*$' then return ''; end if;
 return note;
end $$;
revoke all on function public.on_deck_context_findings(text,jsonb) from public,anon,authenticated;

create or replace function public.on_deck_review_state() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare co uuid:=public.active_company_id(); begin
 if auth.uid() is null or not coalesce(public.on_deck_can_review(),false) then raise exception 'Company admin required' using errcode='42501'; end if;
 return jsonb_build_object(
 'seo',coalesce(public.can_approve_seo_tasks(),false),
 'context_tasks',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'notes',left(public.on_deck_context_findings(t.notes,p.context_work),4000),'notes_truncated',length(public.on_deck_context_findings(t.notes,p.context_work))>4000,'notes_are_request',public.on_deck_context_findings(t.notes,p.context_work)='','status',t.status,'owner',coalesce(u.name,u.email))),'[]') from public.on_deck_proposals p join public.launch_tasks t on t.id=nullif(p.context_work->>'task_id','')::uuid and t.company_entity_id=co and not t.is_private left join public.profiles u on u.id=t.assigned_to_user_id where p.company_entity_id=co and p.status not in ('completed','dismissed','screened')),
 'proposals',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'source_current',p.source_version=public.on_deck_source_version(co,p.kind),'expired',p.valid_until<now())),'[]') from public.on_deck_proposals p where p.company_entity_id=co and p.status not in ('completed','dismissed','screened')),
 'assignees',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',coalesce(p.name,p.email)) order by coalesce(p.name,p.email)),'[]') from public.profiles p join public.entity_memberships m on m.user_id=p.id and m.entity_id=co where p.is_active and m.role in ('owner_admin','admin','member')),
 'tasks',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from (select t.id,t.task_title,t.assigned_to_user_id,t.status from public.launch_tasks t where t.company_entity_id=co and not t.is_private and t.status<>'done' and exists(select 1 from public.profiles p join public.entity_memberships m on m.user_id=p.id where p.id=t.assigned_to_user_id and p.is_active and m.entity_id=co and m.role in ('owner_admin','admin','member')) order by t.updated_at desc,t.id limit 100) t));
end $$;

create or replace function public.on_deck_context(p_id uuid,p_version integer,p_action text,p_assignee uuid default null,p_task uuid default null,p_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.on_deck_proposals; t public.launch_tasks; work jsonb; begin
 if auth.uid() is null or not coalesce(public.on_deck_can_review(),false) then raise exception 'Company admin required' using errcode='42501'; end if;
 select * into r from public.on_deck_proposals where id=p_id and company_entity_id=public.active_company_id() for update;
 if not found then raise exception 'Proposal unavailable' using errcode='42501'; end if;
 if p_action='resolve' then p_note:=public.on_deck_context_findings(p_note,r.context_work); end if;
 -- Durable proposal link survives reloads and unknown client outcomes.
 if p_action in ('create','link') and r.context_work->>'state'='open' then
  select * into t from public.launch_tasks where id=(r.context_work->>'task_id')::uuid and company_entity_id=r.company_entity_id and not is_private;
  if not found then raise exception 'Linked task unavailable; restore its access before continuing'; end if;
  return to_jsonb(r);
 end if;
 if p_action='resolve' and r.context_work->>'state'='resolved' and r.context_work->>'resolution'=btrim(p_note) then return to_jsonb(r); end if;
 if r.version is distinct from p_version then raise exception 'Proposal changed. Reload before deciding' using errcode='40001'; end if;
 if r.status not in ('needs_info','failed','ready') then raise exception 'Wait for preparation or open an active decision'; end if;
 if p_action in ('create','link') then
  if r.valid_until<=now() or r.source_version is distinct from public.on_deck_source_version(r.company_entity_id,r.kind) then raise exception 'Evidence changed or expired. Refresh before assigning context work'; end if;
  if jsonb_array_length(coalesce(r.content->'missing','[]'))=0 then raise exception 'No required context to assign'; end if;
  if p_action='link' then
   select * into t from public.launch_tasks where id=p_task and company_entity_id=r.company_entity_id and not is_private and status<>'done' for update;
   if not found then raise exception 'Choose an open public task in this company'; end if;
  else
   if not exists(select 1 from public.profiles p join public.entity_memberships m on m.user_id=p.id where p.id=p_assignee and p.is_active and m.entity_id=r.company_entity_id and m.role in ('owner_admin','admin','member')) then raise exception 'Choose an active company task owner'; end if;
   insert into public.launch_tasks(company_entity_id,launch_id,task_title,task_type,status,notes,assigned_to_user_id,created_by,is_private)
   values(r.company_entity_id,case when r.kind='launch' then r.source_id end,left('Resolve context: '||r.title,200),'on_deck_context','open',
    concat_ws(E'\n','On Deck proposal: '||r.id::text,'Evidence: '||r.selection_reason,'Required findings:',(select string_agg(value,E'\n') from jsonb_array_elements_text(r.content->'missing')),'Record findings and sources in task notes. An On Deck reviewer will review/import them and queue a fresh draft.','/v2/on-deck.html?proposal='||r.id::text),p_assignee,auth.uid(),false) returning * into t;
  end if;
  if not exists(select 1 from public.profiles p join public.entity_memberships m on m.user_id=p.id where p.id=t.assigned_to_user_id and p.is_active and m.entity_id=r.company_entity_id and m.role in ('owner_admin','admin','member')) then raise exception 'Task needs an active company owner'; end if;
  if p_action='link' then
   update public.launch_tasks set notes=concat_ws(E'\n',notes,'On Deck context request: '||r.id::text,'Required findings:',(select string_agg(value,E'\n') from jsonb_array_elements_text(r.content->'missing')),'Record findings and sources in task notes for an On Deck reviewer.','/v2/on-deck.html?proposal='||r.id::text) where id=t.id returning * into t;
  end if;
  work:=jsonb_build_object('state','open','task_id',t.id,'title',t.task_title,'assigned_to',t.assigned_to_user_id,'missing',r.content->'missing','created_by',auth.uid(),'created_at',now(),'request_notes_hash',md5(btrim(replace(coalesce(t.notes,''),E'\r\n',E'\n'),E' \n\r\t')),'request_notes_length',length(btrim(replace(coalesce(t.notes,''),E'\r\n',E'\n'),E' \n\r\t')));
 elsif p_action='resolve' then
  if r.context_work->>'state' is distinct from 'open' then raise exception 'Create or link an owned context task first'; end if;
  select * into t from public.launch_tasks where id=(r.context_work->>'task_id')::uuid and company_entity_id=r.company_entity_id and not is_private for update;
  if not found then raise exception 'Linked task unavailable'; end if;
  if coalesce(length(btrim(p_note)),0) not between 12 and 4000 then raise exception 'Record actual findings and supporting evidence (12-4000 characters), without request instructions or status-only updates'; end if;
  work:=r.context_work||jsonb_build_object('state','resolved','resolution',btrim(p_note),'resolved_by',auth.uid(),'resolved_at',now());
  -- Findings are durable input, not an assertion that the next draft is safe.
  update public.on_deck_settings set requested_at=now() where company_entity_id=r.company_entity_id;
 else raise exception 'Unknown context action'; end if;
 insert into public.on_deck_events(company_entity_id,proposal_id,event_type,actor_id,detail) values(r.company_entity_id,r.id,'context_'||p_action,auth.uid(),jsonb_build_object('previous_context',r.context_work,'context',work));
 update public.on_deck_proposals set context_work=work,version=version+1,updated_at=now(),
  status=case when p_action='resolve' then 'failed' else status end,
  source_version=case when p_action='resolve' then '' else source_version end,
  user_edited=case when p_action='resolve' then false else user_edited end where id=r.id returning * into r;
 return to_jsonb(r);
end $$;

-- Only already persisted company evidence. No new provider calls or query/page joins.
create or replace function public.on_deck_context_evidence(p_company uuid,p_kind text,p_source jsonb) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
 'seo_work',case when p_kind='seo' then (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select id,title,approval_status,proposed_title,proposed_meta_description,updated_at from public.seo_tasks where company_entity_id=p_company and target_url=p_source->>'url' order by updated_at desc nulls last,id limit 10)x) else '[]'::jsonb end,
 'launch_work',case when p_kind='launch' then (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select id,task_title,status,updated_at,case when length(coalesce(notes,''))<=1000 then notes end notes,length(coalesce(notes,''))>1000 notes_truncated from public.launch_tasks where company_entity_id=p_company and launch_id=(p_source->>'id')::uuid and not is_private order by updated_at desc nulls last,id limit 20)x) else '[]'::jsonb end,
 'seo_work_truncated',p_kind='seo' and (select count(*)>10 from public.seo_tasks where company_entity_id=p_company and target_url=p_source->>'url'),
 'launch_work_truncated',p_kind='launch' and (select count(*)>20 from public.launch_tasks where company_entity_id=p_company and launch_id=(p_source->>'id')::uuid and not is_private),
 'destination_inspection',case when p_kind='ads' then (select jsonb_build_object('title',title,'meta_description',meta_description,'fetched_at',fetched_at,'http_status',http_status) from public.page_inspections where company_entity_id=p_company and requested_url=p_source->>'url' order by fetched_at desc limit 1) else null end,
 'limits','Collections are newest-first bounded samples, not complete history. Truncated notes are withheld entirely; they may contain decisive corrections. Never infer findings or absence of contradictions from withheld notes or omitted work. Request owned context when that missing evidence is necessary. SEO work is saved copy, not proof of publication or a test. Missing history is unknown. Page and query metrics cannot be joined. Old inspections are historical evidence only.');
$$;

revoke all on function public.on_deck_review_state() from public,anon,authenticated;
revoke all on function public.on_deck_context(uuid,integer,text,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.on_deck_context_evidence(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.on_deck_review_state(),public.on_deck_context(uuid,integer,text,uuid,uuid,text) to authenticated;
grant execute on function public.on_deck_context_evidence(uuid,text,jsonb) to service_role;

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
  if r.valid_until<=now() or r.source_version<>public.on_deck_source_version(r.company_entity_id,r.kind) then raise exception 'Evidence changed or expired. Request a fresh preparation first'; end if;
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
   if jsonb_typeof(r.content->'proposed_title') is distinct from 'string' or jsonb_typeof(r.content->'proposed_meta_description') is distinct from 'string' or coalesce(length(btrim(r.content->>'proposed_title')),0) not between 1 and 200 or coalesce(length(btrim(r.content->>'proposed_meta_description')),0) not between 1 and 500 then raise exception 'Refresh this legacy SEO draft to prepare structured title and description'; end if;
   if not coalesce(public.can_approve_seo_tasks(),false) then raise exception 'SEO approval permission required'; end if;
   -- One ordinary project per approved decision; no ambiguous title-based singleton.
   insert into public.seo_projects(company_entity_id,name,status,evidence_note,created_by) values(r.company_entity_id,left(r.title,200),'active',r.selection_reason,auth.uid()) returning id into pid;
   insert into public.seo_tasks(company_entity_id,project_id,title,target_type,target_url,rationale,proposed_title,proposed_meta_description,proposed_body,approval_status,created_by)
   values(r.company_entity_id,pid,left(r.title,200),'page',r.source->>'url',r.content->>'reason',r.content->>'proposed_title',r.content->>'proposed_meta_description',r.content->>'body','draft',auth.uid()) returning id into oid;
   v_output:=jsonb_build_object('kind','seo_task','id',oid,'url','/v2/seo-tasks.html','label','SEO draft created — publishing requires separate review');
  elsif r.kind='ads' then
   insert into public.ad_ideas(company_entity_id,title,hook,angle,body_draft,objective,baseline_ad_ids,baseline_snapshot,source,created_by,status)
   values(r.company_entity_id,left(r.title,200),left(r.content->>'subject',500),left(r.content->>'summary',2000),left(r.content->>'body',5000),r.source->>'objective',array[r.source->>'ad_id'],r.source->'baseline','from_ad',auth.uid(),'idea') returning id into oid;
   v_output:=jsonb_build_object('kind','ad_idea','id',oid,'url','/v2/ad-studio.html','label','Ad idea created — no campaign or budget changed');
  elsif r.kind='launch' then
   -- Serialize matching-task reuse across different proposals for this launch.
   perform 1 from public.launch_calendar where id=r.source_id and company_entity_id=r.company_entity_id for update;
   if not found then raise exception 'Launch unavailable'; end if;
   if jsonb_typeof(r.content->'tasks') is distinct from 'array' or jsonb_array_length(r.content->'tasks') not between 1 and 5 then raise exception 'Review one to five launch tasks'; end if;
   for item in select value from jsonb_array_elements(r.content->'tasks') loop
    if coalesce(length(btrim(item->>'title')),0) not between 1 and 200 then raise exception 'Invalid launch task'; end if;
    -- Reuse public work, preserving owner/state and appending approved copy.
    select id into oid from public.launch_tasks where company_entity_id=r.company_entity_id and launch_id=r.source_id and not is_private and status<>'done' and lower(btrim(task_title))=lower(btrim(item->>'title')) order by id limit 1 for update;
    if oid is null then
     insert into public.launch_tasks(company_entity_id,launch_id,task_title,task_type,status,notes,created_by,is_private)
     values(r.company_entity_id,r.source_id,item->>'title','marketing','open',concat_ws(E'\n',item->>'detail','On Deck '||r.id::text,'Approved draft copy: '||(r.content->>'body')),auth.uid(),false) returning id into oid;
    else
     update public.launch_tasks set notes=concat_ws(E'\n',notes,'On Deck approved draft: '||r.id::text,item->>'detail',r.content->>'body') where id=oid;
    end if;
    taskids:=taskids||to_jsonb(oid);
   end loop;
   v_output:=jsonb_build_object('kind','launch_tasks','ids',taskids,'url','/v2/launch-calendar.html','label','Launch tasks created or linked — reviewed copy is saved in On Deck; nothing published');
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


select public.attach_stamp_company_entity_id_triggers();

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
   if r.context_work->>'state'='open' or r.status in ('preparing','revision') or r.user_edited or r.source_version=p_source_version then return null; end if;
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
 if p_kind='launch' and exists(select 1 from jsonb_array_elements(p_content->'tasks') t group by lower(btrim(t->>'title')) having count(*)>1) then return false; end if;
 for item in select value from jsonb_array_elements(p_content->'tasks') loop
  if jsonb_typeof(item->'title') is distinct from 'string' or coalesce(length(btrim(item->>'title')),0) not between 1 and 200 or jsonb_typeof(item->'detail') is distinct from 'string' or length(item->>'detail')>1500 then return false; end if;
 end loop;
 if p_content ? 'optional_context' then
  if jsonb_typeof(p_content->'optional_context') is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_content->'optional_context')>10 then return false; end if;
  for item in select value from jsonb_array_elements(p_content->'optional_context') loop
   if jsonb_typeof(item)<>'string' or length(item#>>'{}')>500 then return false; end if;
  end loop;
 end if;
 foreach field in array array['proposed_title','proposed_meta_description'] loop
  if p_content ? field and (jsonb_typeof(p_content->field) is distinct from 'string' or length(p_content->>field)>case when field='proposed_title' then 200 else 500 end) then return false; end if;
 end loop;
 return true;
end $$;

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
    from public.launch_tasks t where t.company_entity_id=p_company and t.launch_id=l.id and not t.is_private and t.task_type is distinct from 'on_deck_context' and not exists(select 1 from public.on_deck_proposals p where p.company_entity_id=p_company and p.context_work->>'task_id'=t.id::text and p.status not in ('completed','dismissed','screened'))),'[]'::jsonb))
 from launches l
$$;


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
 (select concat(count(*),':',max(fetched_at)) from public.page_inspections where company_entity_id=p_company),
 (select concat(count(*),':',max(updated_at)) from public.seo_tasks where company_entity_id=p_company)) into v;
 elsif p_kind='ads' then
 select concat_ws('|',(select concat(count(*),':',max(synced_at)) from public.meta_ad_performance_daily where company_entity_id=p_company),
 (select concat(count(*),':',max(synced_at)) from public.meta_ad_creatives where company_entity_id=p_company),
 (select concat(count(*),':',max(fetched_at)) from public.page_inspections where company_entity_id=p_company)) into v;
 else raise exception 'Unknown workflow'; end if;
 return md5(p_kind||':'||(now() at time zone public.silo_company_timezone(p_company))::date::text||':'||coalesce(v,'')||':'||coalesce((select updated_at::text from public.on_deck_settings where company_entity_id=p_company),''));
end $$;

-- Serialized admission: at most three open proposals/workflow, six/company.
-- Completed and dismissed decisions cool down; reviewed edits aren't overwritten.
