-- On Deck: a routine data sync no longer disables a draft.
--
-- Before: on_deck_context (create/link), on_deck_decide (revise/edit) and
-- on_deck_decide (approve) each required r.source_version to equal
-- on_deck_source_version(company,kind) exactly. That fingerprint is built from
-- whole-table sync timestamps plus the company's calendar date, so ANY sync of
-- an input table invalidated every draft of that workflow. Measured on
-- production 2026-10-15: Baseballism's five open proposals were all
-- source_current=false. They were prepared 2026-10-14 20:49-20:50Z; page
-- inspections fetched at 21:39Z and the Meta sync ran at 23:05Z, which moved
-- both the ads and the seo fingerprints. Every proposal had Review draft
-- disabled, and the only recovery (Refresh evidence) blanks source_version and
-- waits for the hourly preparation job, which GitHub Actions throttles to about
-- one run in six.
--
-- After: drift is a notice, not a gate. These three paths block only when the
-- proposal has NO evidence basis (source_version='', which an explicit Refresh
-- sets) or when it is past its 48-hour valid_until. Unanswered required facts,
-- version conflicts, content validity and every permission gate are unchanged.
-- on_deck_review_state still reports source_current, so the page can say the
-- data has refreshed since the draft, and approval now records
-- detail.evidence_drifted on its action_confirmed event.
--
-- Idempotent: create or replace only; no data change, no new object.

create or replace function public.on_deck_context(p_id uuid,p_version integer,p_action text,p_assignee uuid default null,p_task uuid default null,p_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.on_deck_proposals; t public.launch_tasks; work jsonb; begin
 if auth.uid() is null or not coalesce(public.on_deck_can_review(),false) then raise exception 'Company admin required' using errcode='42501'; end if;
 select * into r from public.on_deck_proposals where id=p_id and company_entity_id=public.active_company_id() for update;
 if not found then raise exception 'Proposal unavailable' using errcode='42501'; end if;
 if p_action='detach' then
  if r.context_work='{}'::jsonb then return to_jsonb(r); end if;
  if r.version is distinct from p_version then raise exception 'Proposal changed. Reload before deciding' using errcode='40001'; end if;
  if r.status in ('completed','dismissed','screened','preparing','revision') then raise exception 'Wait for preparation or open an active decision'; end if;
  if coalesce(length(btrim(p_note)),0) not between 12 and 2000 then raise exception 'Explain why you are detaching this context link (12-2000 characters)'; end if;
  -- Do not read or mutate the linked task. It may be private or deleted.
  insert into public.on_deck_events(company_entity_id,proposal_id,event_type,actor_id,detail) values(r.company_entity_id,r.id,'context_detached',auth.uid(),jsonb_build_object('note',p_note));
  update public.on_deck_proposals set context_work='{}',version=version+1,updated_at=now() where id=r.id returning * into r;
  -- A refresh taken while context work was open leaves the proposal invalidated
  -- (failed, no source_version) and staging skips it while the link is open, so
  -- the screening request that refresh made can be spent by a run that never
  -- re-screened it. Renew the request here, or the reviewer sees "queued" with
  -- nothing due for up to 24 hours. Ordinary detach with current evidence does
  -- not enqueue anything.
  if r.status='failed' and r.source_version='' then
   update public.on_deck_settings set requested_at=now() where company_entity_id=r.company_entity_id;
  end if;
  return to_jsonb(r);
 end if;
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
  -- Evidence DRIFT no longer blocks. The fingerprint moves whenever any source
  -- table is synced, so a draft prepared at 13:49 was unusable by 16:05 the same
  -- afternoon and every draft was dead by the next morning, with Refresh handing
  -- it back to a throttled hourly job. What still blocks is a draft with no
  -- evidence basis at all (source_version='', set by an explicit Refresh) and one
  -- past its 48-hour window. Drift is surfaced in the UI and recorded on approval.
  if r.valid_until<=now() or coalesce(r.source_version,'')='' then raise exception 'Evidence expired or refreshed. Wait for the fresh draft before assigning context work'; end if;
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

create or replace function public.on_deck_decide(p_id uuid,p_version integer,p_action text,p_note text default null,p_content jsonb default null,p_minutes integer default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.on_deck_proposals; oid uuid; pid uuid; family jsonb; c jsonb; v_output jsonb; item jsonb; taskids jsonb:='[]'; created_body text; begin
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
  if r.valid_until<=now() or coalesce(r.source_version,'')='' then raise exception 'Evidence expired or refreshed. Wait for the fresh draft before editing'; end if;
  if p_action='edit' then p_content:=public.on_deck_review_content(r.content,p_content); end if;
  if p_action='edit' and (not public.on_deck_valid_content(p_content,r.kind) or p_content->>'recommend'<>'true' or octet_length(p_content::text)>24000) then raise exception 'Invalid draft'; end if;
  if p_action='edit' and (public.on_deck_input_plan(r.content) is distinct from p_content->'review_inputs' or coalesce(r.content->'missing','[]') is distinct from p_content->'missing') and coalesce(length(btrim(p_note)),0)<12 then raise exception 'Explain how the missing evidence was resolved'; end if;
  if p_action='edit' then perform public.on_deck_creation_body(p_content); end if;
  insert into public.on_deck_events(company_entity_id,proposal_id,event_type,actor_id,detail) values(r.company_entity_id,r.id,p_action,auth.uid(),jsonb_build_object('previous_content',r.content,'note',p_note));
  update public.on_deck_proposals set status=case when p_action='revise' then 'revision' when jsonb_array_length(public.on_deck_draft_blockers(p_content,r.kind))>0 then 'needs_info' else 'ready' end,
   content=case when p_action='edit' then p_content else content end,revision_request=case when p_action='revise' then p_note end,
   user_edited=true,version=version+1,updated_at=now() where id=r.id;
  if p_action='revise' then update public.on_deck_settings set requested_at=now() where company_entity_id=r.company_entity_id; end if;
 elsif p_action='cancel_revision' then
  if r.status<>'revision' then raise exception 'No pending revision'; end if;
  insert into public.on_deck_events(company_entity_id,proposal_id,event_type,actor_id,detail) values(r.company_entity_id,r.id,'revision_cancelled',auth.uid(),jsonb_build_object('instruction',r.revision_request));
  update public.on_deck_proposals set status=case when not public.on_deck_valid_content(r.content,r.kind) then 'failed' when jsonb_array_length(public.on_deck_draft_blockers(r.content,r.kind))>0 then 'needs_info' else 'ready' end,
   revision_request=null,version=version+1,updated_at=now() where id=r.id;
 elsif p_action='refresh' then
  if r.status in ('completed','dismissed','screened','preparing','revision') then raise exception 'This decision cannot be refreshed'; end if;
  update public.on_deck_proposals set preparation_state='{}',user_edited=false,source_version='',status='failed',version=version+1,updated_at=now() where id=r.id;
  update public.on_deck_settings set requested_at=now() where company_entity_id=r.company_entity_id;
 elsif p_action='approve' then
  if r.status<>'ready' then raise exception 'Review a prepared proposal first'; end if;
  if r.valid_until<=now() or coalesce(r.source_version,'')='' then raise exception 'Evidence expired or refreshed. Wait for the fresh draft before creating work'; end if;
  if not public.on_deck_valid_content(r.content,r.kind) or r.content->>'recommend'<>'true' or coalesce(length(btrim(r.content->>'body')),0)=0 or jsonb_array_length(public.on_deck_draft_blockers(r.content,r.kind))>0 then raise exception 'Resolve missing information first'; end if;
  created_body:=public.on_deck_creation_body(r.content);
  if r.kind='restock' then
   if not coalesce(public.po_builder_can_write(),false) then raise exception 'Purchasing permission required'; end if;
   if coalesce(length(btrim(p_note)),0)<12 then raise exception 'Record product-level vetting: demand, margin, seasonality, incoming stock and cash'; end if;
   -- This approves product investigation, NOT size quantities or a purchase.
   family:=public.product_workflow_catalog_source(r.company_entity_id,r.source_id,r.source->'catalog_group');
   c:=jsonb_build_object('title',r.content->>'subject','design_intent',created_body,'catalog_scope','product',
    'catalog_group',r.source->'catalog_group','source_updated_at',family->'updated_at',
    'source_variant_identity',public.product_workflow_variant_identity(family),
    'source_variant_versions',(select jsonb_agg(jsonb_build_object('id',v->'id','updated_at',v->'updated_at') order by v->>'id') from jsonb_array_elements(family->'variants') v),
    'lines',(select jsonb_agg(jsonb_build_object('product_master_id',v->'id','sku',v->'sku','size',v->'variant_title','qty',null) order by v->>'id') from jsonb_array_elements(family->'variants') v),
    'decision_note',p_note,'on_deck_proposal_id',r.id,'product_vetting',r.source->'vetting');
   oid:=gen_random_uuid();
   perform public.save_product_workflow_brief(r.company_entity_id,oid,0,'restock',r.source_id,c,'draft');
   v_output:=jsonb_build_object('kind','product_brief','id',oid,'url','/v3/product-workflow.html?brief='||oid::text,'label','Product brief created — size allocation and PO approval remain');
  elsif r.kind='seo' then
   if jsonb_typeof(r.content->'proposed_title') is distinct from 'string' or jsonb_typeof(r.content->'proposed_meta_description') is distinct from 'string' or coalesce(length(btrim(r.content->>'proposed_title')),0) not between 1 and 200 or coalesce(length(btrim(r.content->>'proposed_meta_description')),0) not between 1 and 500 then raise exception 'Fill the proposed SEO title and meta description in Review draft'; end if;
   if not coalesce(public.can_approve_seo_tasks(),false) then raise exception 'SEO approval permission required'; end if;
   -- One ordinary project per approved decision; no ambiguous title-based singleton.
   insert into public.seo_projects(company_entity_id,name,status,evidence_note,created_by) values(r.company_entity_id,left(r.content->>'subject',200),'active',r.selection_reason,auth.uid()) returning id into pid;
   insert into public.seo_tasks(company_entity_id,project_id,title,target_type,target_url,rationale,proposed_title,proposed_meta_description,proposed_body,approval_status,created_by)
   values(r.company_entity_id,pid,left(r.content->>'subject',200),'page',r.source->>'url',r.content->>'reason',r.content->>'proposed_title',r.content->>'proposed_meta_description',created_body,'draft',auth.uid()) returning id into oid;
   v_output:=jsonb_build_object('kind','seo_task','id',oid,'url','/v2/seo-tasks.html?task='||oid::text,'label','SEO draft created — publishing requires separate review');
  elsif r.kind='ads' then
   insert into public.ad_ideas(company_entity_id,title,hook,angle,body_draft,objective,baseline_ad_ids,baseline_snapshot,source,created_by,status)
   values(r.company_entity_id,left(r.content->>'subject',200),left(r.content->>'subject',500),left(r.content->>'summary',2000),created_body,r.source->>'objective',array[r.source->>'ad_id'],r.source->'baseline','from_ad',auth.uid(),'idea') returning id into oid;
   v_output:=jsonb_build_object('kind','ad_idea','id',oid,'url','/v2/ad-studio.html?view=ideas&idea='||oid::text,'label','Ad idea created — no campaign or budget changed');
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
     values(r.company_entity_id,r.source_id,item->>'title','marketing','open',concat_ws(E'\n',item->>'detail','On Deck '||r.id::text,'Reviewed draft title: '||(r.content->>'subject'),'Approved draft copy: '||created_body),auth.uid(),false) returning id into oid;
    else
     update public.launch_tasks set notes=concat_ws(E'\n',notes,'On Deck approved draft: '||r.id::text,'Reviewed draft title: '||(r.content->>'subject'),item->>'detail',created_body) where id=oid;
    end if;
    taskids:=taskids||to_jsonb(oid);
   end loop;
   v_output:=jsonb_build_object('kind','launch_tasks','ids',taskids,'url','/v2/tasks.html?task='||(taskids->>0),'label','Launch tasks created or linked — reviewed copy is saved in On Deck; nothing published');
  end if;
  update public.on_deck_proposals set status='completed',output=v_output,approved_at=now(),approved_by=auth.uid(),version=version+1,updated_at=now(),revisit_at=now()+interval '30 days' where id=r.id;
  insert into public.on_deck_events(company_entity_id,proposal_id,event_type,actor_id,detail)
   values(r.company_entity_id,r.id,'action_confirmed',auth.uid(),jsonb_build_object('approved_content',r.content,'product_review',p_note,'output',v_output,'evidence_drifted',r.source_version<>public.on_deck_source_version(r.company_entity_id,r.kind)));
 else raise exception 'Unknown action'; end if;
 if p_action in ('dismiss','refresh','value') then
  insert into public.on_deck_events(company_entity_id,proposal_id,event_type,actor_id,detail) values(r.company_entity_id,r.id,p_action,auth.uid(),jsonb_build_object('note',p_note,'minutes',p_minutes,'previous_status',r.status));
 end if;
 select * into r from public.on_deck_proposals where id=p_id;
 return to_jsonb(r);
end $$;

-- The page must not offer a drifted draft before this migration is applied: the
-- gates above would still refuse it, and the user would get an error instead of a
-- notice. So the payload carries drift_warns, which is absent until this runs; the
-- page treats drift as blocking while it is absent, exactly as it does today.
create or replace function public.on_deck_review_state() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare co uuid:=public.active_company_id(); begin
 if auth.uid() is null or not coalesce(public.on_deck_can_review(),false) then raise exception 'Company admin required' using errcode='42501'; end if;
 return jsonb_build_object(
 'review_contract',2,'drift_warns',true,'purchasing',coalesce(public.po_builder_can_write(),false),
 'seo',coalesce(public.can_approve_seo_tasks(),false),
 'context_tasks',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'notes',left(public.on_deck_context_findings(t.notes,p.context_work),4000),'notes_truncated',length(public.on_deck_context_findings(t.notes,p.context_work))>4000,'notes_are_request',public.on_deck_context_findings(t.notes,p.context_work)='','status',t.status,'title',t.task_title,'owner',coalesce(u.name,u.email))),'[]') from public.on_deck_proposals p join public.launch_tasks t on t.id=nullif(p.context_work->>'task_id','')::uuid and t.company_entity_id=co and not t.is_private left join public.profiles u on u.id=t.assigned_to_user_id where p.company_entity_id=co and p.status not in ('completed','dismissed','screened')),
 'proposals',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'source_current',p.source_version=public.on_deck_source_version(co,p.kind),'expired',p.valid_until<=now(),'blockers',public.on_deck_draft_blockers(p.content,p.kind),'preparation',public.on_deck_preparation_state(p))),'[]') from public.on_deck_proposals p where p.company_entity_id=co and p.status not in ('completed','dismissed','screened')),
 'assignees',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',coalesce(p.name,p.email)) order by coalesce(p.name,p.email)),'[]') from public.profiles p join public.entity_memberships m on m.user_id=p.id and m.entity_id=co where p.is_active and m.role in ('owner_admin','admin','member')),
 'tasks',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from (select t.id,t.task_title,t.assigned_to_user_id,t.status from public.launch_tasks t where t.company_entity_id=co and not t.is_private and t.status<>'done' and exists(select 1 from public.profiles p join public.entity_memberships m on m.user_id=p.id where p.id=t.assigned_to_user_id and p.is_active and m.entity_id=co and m.role in ('owner_admin','admin','member')) order by t.updated_at desc,t.id limit 100) t));
end $$;
