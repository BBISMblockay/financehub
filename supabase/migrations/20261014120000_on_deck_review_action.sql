-- Forward-only review contract. Client writes remain RPC-only.
alter table public.on_deck_proposals add column if not exists preparation_state jsonb not null default '{}';

create or replace function public.on_deck_input_plan(c jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select case when jsonb_typeof(c->'review_inputs')='array' then c->'review_inputs' else
 coalesce((select jsonb_agg(jsonb_build_object('id','required:'||(n-1),'label',v,'requirement','required','answer','','mode','unanswered') order by n) from jsonb_array_elements_text(coalesce(c->'missing','[]')) with ordinality x(v,n)),'[]') ||
 coalesce((select jsonb_agg(jsonb_build_object('id','optional:'||(n-1),'label',v,'requirement','optional','answer','','mode','unanswered') order by n) from jsonb_array_elements_text(coalesce(c->'optional_context','[]')) with ordinality x(v,n)),'[]') end
$$;

create or replace function public.on_deck_draft_blockers(c jsonb,k text) returns jsonb
language plpgsql immutable set search_path='' as $$
declare blockers jsonb:='[]'; item jsonb; begin
 if c->>'recommend' is distinct from 'true' then blockers:=blockers||jsonb_build_array('Review a recommended draft.'); end if;
 if coalesce(length(btrim(c->>'subject')),0)=0 then blockers:=blockers||jsonb_build_array('Draft title is required.'); end if;
 if coalesce(length(btrim(c->>'body')),0)=0 then blockers:=blockers||jsonb_build_array('Draft copy is required.'); end if;
 for item in select value from jsonb_array_elements(public.on_deck_input_plan(c)) loop
  if item->>'requirement'='required' and (item->>'mode' is distinct from 'answered' or coalesce(length(btrim(item->>'answer')),0)<4) then blockers:=blockers||jsonb_build_array(item->>'label'); end if;
 end loop;
 if k='seo' then
  if coalesce(length(btrim(c->>'proposed_title')),0)=0 then blockers:=blockers||jsonb_build_array('Proposed SEO title is required.'); end if;
  if coalesce(length(btrim(c->>'proposed_meta_description')),0)=0 then blockers:=blockers||jsonb_build_array('Proposed meta description is required.'); end if;
 end if;
 if k='launch' and jsonb_array_length(coalesce(c->'tasks','[]')) not between 1 and 5 then blockers:=blockers||jsonb_build_array('Review one to five launch tasks.'); end if;
 return blockers;
end $$;

-- Validate edits against the saved requirement identities. No required fact can
-- be removed, reclassified or carried as optional research. There is no dismiss
-- requirement operation; the existing admin opportunity dismissal needs a reason.
create or replace function public.on_deck_review_content(previous jsonb,c jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare original jsonb:=public.on_deck_input_plan(previous); inputs jsonb:=coalesce(c->'review_inputs',public.on_deck_input_plan(previous)); item jsonb; old jsonb; pending jsonb:='[]'; begin
 if jsonb_typeof(inputs) is distinct from 'array' or jsonb_array_length(inputs)<>jsonb_array_length(original) then raise exception 'Keep all saved requirements; answer or reopen them'; end if;
 for item,old in select a.value,b.value from jsonb_array_elements(inputs) with ordinality a(value,n) join jsonb_array_elements(original) with ordinality b(value,n) using(n) loop
  if (item-'answer'-'mode') is distinct from (old-'answer'-'mode') then raise exception 'Required facts cannot be removed or reclassified'; end if;
  if jsonb_typeof(item->'answer') is distinct from 'string' or length(item->>'answer')>1200 or item->>'mode' not in ('answered','unanswered','carry') or item->>'mode' is null then raise exception 'Invalid saved answer'; end if;
  if item->>'mode'='answered' and length(btrim(item->>'answer'))<4 then raise exception 'An answer needs at least four characters'; end if;
  if item->>'mode'='carry' and item->>'requirement'<>'optional' then raise exception 'Essential facts must be answered before creation'; end if;
  if item->>'requirement'='required' and item->>'mode'<>'answered' then pending:=pending||jsonb_build_array(item->>'label'); end if;
 end loop;
 return c||jsonb_build_object('review_inputs',inputs,'missing',pending);
end $$;

create or replace function public.on_deck_creation_body(c jsonb) returns text
language plpgsql immutable set search_path='' as $$
declare result text:=c->>'body'; answers text; research text; begin
 select string_agg((i->>'label')||': '||(i->>'answer'),E'\n' order by n) into answers from jsonb_array_elements(public.on_deck_input_plan(c)) with ordinality x(i,n) where i->>'mode'='answered';
 select string_agg('- '||(i->>'label'),E'\n' order by n) into research from jsonb_array_elements(public.on_deck_input_plan(c)) with ordinality x(i,n) where i->>'requirement'='optional' and i->>'mode'='carry';
 result:=concat_ws(E'\n\n',result,case when answers is not null then E'Confirmed task context:\n'||answers end,case when research is not null then E'Research to complete before publishing or implementing:\n'||research end);
 if length(result)>5000 then raise exception 'Draft and saved answers exceed 5000 characters; shorten the copy or answers'; end if;
 return result;
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
 if p_content ? 'review_inputs' then
  if jsonb_typeof(p_content->'review_inputs') is distinct from 'array' or jsonb_array_length(p_content->'review_inputs')>20 then return false; end if;
  for item in select value from jsonb_array_elements(p_content->'review_inputs') loop
   if jsonb_typeof(item->'id') is distinct from 'string' or jsonb_typeof(item->'label') is distinct from 'string' or length(item->>'label')>500 or item->>'requirement' not in ('required','optional') or item->>'requirement' is null or jsonb_typeof(item->'answer') is distinct from 'string' or length(item->>'answer')>1200 or item->>'mode' not in ('answered','unanswered','carry') or item->>'mode' is null then return false; end if;
  end loop;
 end if;
 return true;
end $$;

create or replace function public.on_deck_preparation_state(p public.on_deck_proposals) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.on_deck_settings; begin
 select * into s from public.on_deck_settings where company_entity_id=p.company_entity_id;
 if exists(select 1 from public.on_deck_attempts where proposal_id=p.id and company_entity_id=p.company_entity_id and proposal_version=p.version and state='reserved') then return jsonb_build_object('state','running','reason','reserved'); end if;
 if exists(select 1 from public.on_deck_attempts where proposal_id=p.id and company_entity_id=p.company_entity_id and state='reserved') then return jsonb_build_object('state','paused','reason','previous_attempt'); end if;
 if p.context_work->>'state'='open' and p.source_version='' then return jsonb_build_object('state','paused','reason','context_open'); end if;
 if p.status not in ('preparing','revision','failed') then return jsonb_build_object('state','idle'); end if;
 if s.enabled is distinct from true or not p.kind=any(s.workflows) then return jsonb_build_object('state','paused','reason','disabled'); end if;
 if (select coalesce(sum(coalesce(cost_usd,reserved_usd)),0) from public.on_deck_attempts where company_entity_id=p.company_entity_id and created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC')+0.25>s.monthly_cap_usd then return jsonb_build_object('state','paused','reason','budget_cap'); end if;
 if (select count(*) from public.on_deck_attempts where company_entity_id=p.company_entity_id and created_at>=now()-interval '24 hours')>=20 then return jsonb_build_object('state','paused','reason','daily_cap'); end if;
 if p.preparation_state->>'version'=p.version::text and p.preparation_state->>'state' in ('paused','failed') then return p.preparation_state; end if;
 if p.status='failed' and p.source_version<>'' then return jsonb_build_object('state','failed','reason','preparation_failed'); end if;
 return jsonb_build_object('state','queued','reason',case when p.source_version='' then 'screening' else 'drafting' end);
end $$;

create or replace function public.on_deck_review_state() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare co uuid:=public.active_company_id(); begin
 if auth.uid() is null or not coalesce(public.on_deck_can_review(),false) then raise exception 'Company admin required' using errcode='42501'; end if;
 return jsonb_build_object(
 'review_contract',2,'purchasing',coalesce(public.po_builder_can_write(),false),
 'seo',coalesce(public.can_approve_seo_tasks(),false),
 'context_tasks',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'notes',left(public.on_deck_context_findings(t.notes,p.context_work),4000),'notes_truncated',length(public.on_deck_context_findings(t.notes,p.context_work))>4000,'notes_are_request',public.on_deck_context_findings(t.notes,p.context_work)='','status',t.status,'title',t.task_title,'owner',coalesce(u.name,u.email))),'[]') from public.on_deck_proposals p join public.launch_tasks t on t.id=nullif(p.context_work->>'task_id','')::uuid and t.company_entity_id=co and not t.is_private left join public.profiles u on u.id=t.assigned_to_user_id where p.company_entity_id=co and p.status not in ('completed','dismissed','screened')),
 'proposals',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'source_current',p.source_version=public.on_deck_source_version(co,p.kind),'expired',p.valid_until<=now(),'blockers',public.on_deck_draft_blockers(p.content,p.kind),'preparation',public.on_deck_preparation_state(p))),'[]') from public.on_deck_proposals p where p.company_entity_id=co and p.status not in ('completed','dismissed','screened')),
 'assignees',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',coalesce(p.name,p.email)) order by coalesce(p.name,p.email)),'[]') from public.profiles p join public.entity_memberships m on m.user_id=p.id and m.entity_id=co where p.is_active and m.role in ('owner_admin','admin','member')),
 'tasks',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from (select t.id,t.task_title,t.assigned_to_user_id,t.status from public.launch_tasks t where t.company_entity_id=co and not t.is_private and t.status<>'done' and exists(select 1 from public.profiles p join public.entity_memberships m on m.user_id=p.id where p.id=t.assigned_to_user_id and p.is_active and m.entity_id=co and m.role in ('owner_admin','admin','member')) order by t.updated_at desc,t.id limit 100) t));
end $$;

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
 elsif jsonb_array_length(public.on_deck_draft_blockers(p_content,r.kind))>0 then next_status:='needs_info';
 else next_status:='ready'; end if;
 insert into public.on_deck_events(company_entity_id,proposal_id,event_type,detail)
 values(r.company_entity_id,r.id,case when r.revision_request is null then 'prepared' else 'revised' end,
 jsonb_build_object('previous_content',r.content,'instruction',r.revision_request,'attempt',p_request,'error',p_error));
 update public.on_deck_proposals set content=case when p_content is null then content else p_content||jsonb_build_object('review_inputs',public.on_deck_input_plan(p_content)) end,preparation_state='{}',status=next_status,version=version+1,
 revisit_at=case when next_status='screened' then now()+interval '14 days' else revisit_at end,
 valid_until=now()+interval '48 hours',updated_at=now(),revision_request=case when p_error is null then null else revision_request end where id=r.id;
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
  if r.valid_until<=now() or r.source_version<>public.on_deck_source_version(r.company_entity_id,r.kind) then raise exception 'Evidence changed or expired. Request a fresh preparation first'; end if;
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
  if r.valid_until<=now() or r.source_version<>public.on_deck_source_version(r.company_entity_id,r.kind) then raise exception 'Evidence changed or expired. Refresh and review again'; end if;
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
   values(r.company_entity_id,r.id,'action_confirmed',auth.uid(),jsonb_build_object('approved_content',r.content,'product_review',p_note,'output',v_output));
 else raise exception 'Unknown action'; end if;
 if p_action in ('dismiss','refresh','value') then
  insert into public.on_deck_events(company_entity_id,proposal_id,event_type,actor_id,detail) values(r.company_entity_id,r.id,p_action,auth.uid(),jsonb_build_object('note',p_note,'minutes',p_minutes,'previous_status',r.status));
 end if;
 select * into r from public.on_deck_proposals where id=p_id;
 return to_jsonb(r);
end $$;
revoke all on function public.on_deck_input_plan(jsonb) from public,anon,authenticated;
revoke all on function public.on_deck_draft_blockers(jsonb,text) from public,anon,authenticated;
revoke all on function public.on_deck_review_content(jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.on_deck_creation_body(jsonb) from public,anon,authenticated;
revoke all on function public.on_deck_preparation_state(public.on_deck_proposals) from public,anon,authenticated;
select public.attach_stamp_company_entity_id_triggers();

-- Existing incomplete ready rows need review, not a misleading ready label.
update public.on_deck_proposals set status='needs_info',version=version+1,updated_at=now()
where status='ready' and public.on_deck_valid_content(content,kind)
 and jsonb_array_length(public.on_deck_draft_blockers(content,kind))>0;
