-- Direct-link preview only. No existing policies, approvals or menus change.
-- Client writes are RPC-only so review/output IDs cannot be forged by PATCH.
create table if not exists public.product_workflow_briefs (
  id uuid primary key,
  company_entity_id uuid not null references public.entities(id),
  source_kind text not null check (source_kind in ('concept','product','idea','restock')),
  source_id uuid,
  source_snapshot jsonb not null default '{}',
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  status text not null default 'draft' check (status in ('draft','reviewed','dismissed')),
  version integer not null default 1,
  created_by uuid not null,
  reviewed_by uuid,
  reviewed_at timestamptz,
  po_header_id uuid,
  launch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((source_kind = 'idea') = (source_id is null)),
  check ((status = 'reviewed') = (reviewed_by is not null and reviewed_at is not null))
);
-- Soft source/output references deliberately survive deletion in the existing
-- modules. The RPCs validate company ownership and refuse to recreate a deleted
-- output; a deleted PO is not permission to repeat a purchasing decision.
comment on table public.product_workflow_briefs is
  'Reviewed product workflow drafts. Source snapshot is historical; output IDs are durable retry keys, not approval of the resulting PO or publication of a launch.';
create index if not exists product_workflow_briefs_company_updated_idx
  on public.product_workflow_briefs(company_entity_id, updated_at desc, id);
alter table public.product_workflow_briefs enable row level security;
revoke all on public.product_workflow_briefs from public, anon, authenticated;
grant select on public.product_workflow_briefs to authenticated;
drop policy if exists product_workflow_briefs_read on public.product_workflow_briefs;
create policy product_workflow_briefs_read on public.product_workflow_briefs
  for select to authenticated using (company_entity_id = (select public.active_company_id()));

create or replace function public.save_product_workflow_brief(
  p_company uuid, p_id uuid, p_version integer, p_kind text, p_source_id uuid,
  p_content jsonb, p_status text default 'draft'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.product_workflow_briefs; snapshot jsonb := '{}';
begin
  if auth.uid() is null or p_company is null
     or p_company is distinct from public.active_company_id()
     or not coalesce(public.po_builder_can_write(), false) then
    raise exception 'Purchasing permission and the active company are required' using errcode='42501';
  end if;
  if p_id is null or p_version is null or p_version < 0
     or p_kind is null or p_kind not in ('concept','product','idea','restock')
     or p_status is null or p_status not in ('draft','reviewed','dismissed')
     or p_content is null or jsonb_typeof(p_content) <> 'object'
     or octet_length(p_content::text) > 100000 then
    raise exception 'Invalid brief';
  end if;
  if coalesce(length(btrim(p_content->>'title')),0) not between 1 and 240 then
    raise exception 'A title of 1–240 characters is required';
  end if;
  if p_status='reviewed' and coalesce(length(btrim(p_content->>'design_intent')),0)=0 then
    raise exception 'Add the product intent before review';
  end if;
  -- Includes first creation; SELECT FOR UPDATE alone cannot lock a missing row.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('product-brief:' || p_id::text, 0));
  select * into b from public.product_workflow_briefs where id=p_id for update;
  if found then
    if b.company_entity_id <> p_company then raise exception 'Brief not found' using errcode='42501'; end if;
    if b.source_kind is distinct from p_kind or b.source_id is distinct from p_source_id then
      raise exception 'The source of a saved brief cannot change';
    end if;
    -- Lost-response replay only when it describes precisely the saved version.
    if b.version=p_version+1 and b.content=p_content and b.status=p_status then return to_jsonb(b); end if;
    if b.version <> p_version then raise exception 'Brief changed. Reload before saving' using errcode='40001'; end if;
    if b.po_header_id is not null or b.launch_id is not null then raise exception 'This brief has been handed off and is frozen'; end if;
    if b.status='reviewed' and (p_status <> 'draft' or p_content <> b.content) then
      raise exception 'Reopen the reviewed brief before editing';
    end if;
  else
    if p_version <> 0 then raise exception 'Brief not found'; end if;
    if p_kind='concept' then
      select to_jsonb(c) into snapshot from public.product_concepts c
        where c.id=p_source_id and c.company_entity_id=p_company and c.status <> 'archived';
    elsif p_kind in ('product','restock') then
      select to_jsonb(p) into snapshot from public.products_master p
        where p.id=p_source_id and p.company_entity_id=p_company;
    elsif p_source_id is not null then raise exception 'A manual idea cannot claim a catalog source';
    end if;
    if snapshot is null then raise exception 'Source not found in the active company'; end if;
    if p_kind <> 'idea' and (snapshot->>'updated_at')::timestamptz is distinct from (p_content->>'source_updated_at')::timestamptz then
      raise exception 'Source changed. Select the source again before saving';
    end if;
    insert into public.product_workflow_briefs(id,company_entity_id,source_kind,source_id,source_snapshot,content,created_by)
      values(p_id,p_company,p_kind,p_source_id,snapshot,p_content,auth.uid()) returning * into b;
    -- New records get version 1 below, not 2.
    b.version := 0;
  end if;
  update public.product_workflow_briefs set content=p_content,status=p_status,version=b.version+1,
    reviewed_by=case when p_status='reviewed' then auth.uid() end,
    reviewed_at=case when p_status='reviewed' then now() end,updated_at=now()
    where id=p_id returning * into b;
  return to_jsonb(b);
end $$;

create or replace function public.handoff_product_workflow_brief(
  p_company uuid, p_id uuid, p_version integer, p_target text, p_launch_date date default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.product_workflow_briefs; c jsonb; line jsonb; output_id uuid;
  factory uuid; product public.products_master; concept public.product_concepts;
  quantity integer; cost numeric; retail numeric; total_qty bigint := 0;
begin
  if auth.uid() is null or p_company is null
     or p_company is distinct from public.active_company_id()
     or not coalesce(public.po_builder_can_write(), false) then
    raise exception 'Purchasing permission and the active company are required' using errcode='42501';
  end if;
  if p_target is null or p_target not in ('po','launch') then raise exception 'Unknown handoff'; end if;
  select * into b from public.product_workflow_briefs
    where id=p_id and company_entity_id=p_company for update;
  if not found then raise exception 'Brief not found'; end if;
  output_id := case when p_target='po' then b.po_header_id else b.launch_id end;
  if output_id is not null then
    if (p_target='po' and not exists(select 1 from public.po_headers where id=output_id and company_entity_id=p_company))
       or (p_target='launch' and not exists(select 1 from public.launch_calendar where id=output_id and company_entity_id=p_company)) then
      raise exception 'The original output was deleted or moved. This brief cannot create another';
    end if;
    return to_jsonb(b);
  end if;
  if p_version is distinct from b.version then raise exception 'Brief changed. Reload before handoff' using errcode='40001'; end if;
  if b.status <> 'reviewed' then raise exception 'Review the brief before handoff'; end if;
  c := b.content;
  if b.source_kind='concept' then
    select * into concept from public.product_concepts where id=b.source_id and company_entity_id=p_company and status <> 'archived';
    if not found then raise exception 'Concept is missing or archived'; end if;
  elsif b.source_kind in ('product','restock') then
    select * into product from public.products_master where id=b.source_id and company_entity_id=p_company;
    if not found then raise exception 'Catalog product is missing'; end if;
  end if;
  if b.po_header_id is not null and not exists(select 1 from public.po_headers where id=b.po_header_id and company_entity_id=p_company) then
    raise exception 'The linked PO is missing';
  end if;
  if p_target='po' then
    if b.launch_id is not null then raise exception 'Launch already created. Start a new brief for a later purchasing decision'; end if;
    if concept.id is not null and exists(select 1 from public.product_concepts child
      where child.parent_concept_id=concept.id and child.company_entity_id=p_company and child.status <> 'archived') then
      raise exception 'This concept is a collection. Create a brief from each child product';
    end if;
    factory := nullif(c->>'factory_id','')::uuid;
    if not exists(select 1 from public.factories where id=factory and company_entity_id=p_company) then
      raise exception 'Choose a factory in the active company';
    end if;
    if b.source_kind='concept' and concept.suggested_factory_id is not null
       and factory <> concept.suggested_factory_id and coalesce(length(btrim(c->>'decision_note')),0)=0 then
      raise exception 'Explain the change from the suggested factory';
    end if;
    if jsonb_typeof(c->'lines') is distinct from 'array' then raise exception 'Add purchase quantities'; end if;
    if jsonb_array_length(c->'lines') not between 1 and 100 then raise exception 'Use 1–100 purchase lines'; end if;
    if b.source_kind in ('product','restock') and jsonb_array_length(c->'lines') <> 1 then
      raise exception 'A catalog brief is for one variant';
    end if;
    -- Validate before allocating a PO name. Integer cast alone rounds decimals.
    for line in select value from jsonb_array_elements(c->'lines') loop
      if coalesce(line->>'qty','') !~ '^[0-9]{1,7}$' then raise exception 'Quantities must be whole units'; end if;
      quantity := (line->>'qty')::integer;
      if quantity < 1 or quantity > 1000000 then raise exception 'Quantity must be 1–1,000,000'; end if;
      total_qty := total_qty+quantity;
      cost := nullif(line->>'unit_cost','')::numeric;
      retail := nullif(line->>'retail_price','')::numeric;
      if (cost is not null and not (cost between 0 and 1000000))
         or (retail is not null and not (retail between 0 and 1000000)) then raise exception 'Invalid cost or retail price'; end if;
    end loop;
    insert into public.po_headers(company_entity_id,po_name,factory_id,order_date,status,is_new_product_po,created_by,internal_notes)
      values(p_company,public.generate_next_po_name(factory),factory,public.silo_business_today(),'Draft',
        b.source_kind in ('concept','idea'),auth.uid(),'Product workflow brief ' || b.id::text)
      returning id into output_id;
    for line in select value from jsonb_array_elements(c->'lines') loop
      insert into public.po_lines(company_entity_id,po_header_id,product_master_id,source_concept_id,
        title_snapshot,product_type_snapshot,variant_title_snapshot,sku_snapshot,qty,unit_cost,retail_price,line_notes)
      values(p_company,output_id,product.id,concept.id,
        coalesce(product.product_title,c->>'title'),coalesce(product.product_type,c->>'product_type'),
        coalesce(product.variant_title,nullif(line->>'size','')),product.sku,(line->>'qty')::integer,
        nullif(line->>'unit_cost','')::numeric,nullif(line->>'retail_price','')::numeric,
        'Reviewed draft from workflow brief ' || b.id::text);
    end loop;
    if concept.id is not null then
      insert into public.po_concept_links(company_entity_id,po_header_id,concept_id,created_by)
        values(p_company,output_id,concept.id,auth.uid());
    end if;
    update public.product_workflow_briefs set po_header_id=output_id,version=version+1,updated_at=now()
      where id=b.id returning * into b;
  else
    if coalesce(p_launch_date,nullif(c->>'launch_date','')::date) is null then raise exception 'Choose a planned launch date'; end if;
    insert into public.launch_calendar(company_entity_id,title,launch_date,time_zone,status,created_by,
      linked_po_id,linked_product_id,source_concept_id,design_intent,product_callouts,marketing_angle,audience,
      special_callouts,copy_dos,copy_donts,creative_dos,creative_donts,notes,
      products_unknown_at,products_unknown_note)
    values(p_company,c->>'title',coalesce(p_launch_date,nullif(c->>'launch_date','')::date),public.silo_business_timezone(),'planned',auth.uid(),
      b.po_header_id,product.id,concept.id,c->>'design_intent',c->>'product_callouts',c->>'marketing_angle',c->>'audience',
      c->>'special_callouts',c->>'copy_dos',c->>'copy_donts',c->>'creative_dos',c->>'creative_donts',
      concat_ws(E'\n','Product workflow brief ' || b.id::text,c->>'decision_note',
        case when nullif(c->>'draft_copy','') is not null then 'Suggested copy (not approved): ' || (c->>'draft_copy') end),
      case when b.po_header_id is null and product.id is null then now() end,
      case when b.po_header_id is null and product.id is null then 'Concept or idea: attach measurable products when known' end)
      returning id into output_id;
    if product.id is not null then
      insert into public.launch_product_readiness(company_entity_id,launch_id,product_title,product_type,created_by,notes)
        values(p_company,output_id,product.product_title,product.product_type,auth.uid(),
          'Catalog source ' || product.id::text || '; variant ' || product.sku || '. Launch measurement covers the product, not this variant alone.');
    end if;
    update public.product_workflow_briefs set launch_id=output_id,version=version+1,updated_at=now()
      where id=b.id returning * into b;
  end if;
  return to_jsonb(b);
end $$;

-- Bounded to one catalog SKU; no client-side row cap can truncate the basis.
-- Invoker retains PO header visibility and reads inventory through its scoped
-- materialized-view wrapper. No blanket matview grants.
create or replace function public.product_workflow_restock_basis(p_company uuid,p_product uuid,p_horizon integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare p public.products_master; last_day date; result jsonb;
begin
  if auth.uid() is null or p_company is null or p_company is distinct from public.active_company_id()
     or not coalesce(public.po_builder_can_write(),false) then raise exception 'Purchasing permission required' using errcode='42501'; end if;
  if p_horizon is null or p_horizon not between 0 and 730 then raise exception 'Horizon must be 0–730 days'; end if;
  select * into p from public.products_master where id=p_product and company_entity_id=p_company;
  if not found then raise exception 'Catalog product not found'; end if;
  last_day := public.silo_business_yesterday();
  select jsonb_build_object(
    'product_id',p.id,'sku',p.sku,'observed_at',now(),'window_start',last_day-89,'window_end',last_day,'lookback_days',90,
    'horizon_days',p_horizon,'incoming_cutoff',public.silo_business_today()+p_horizon,
    'units_90d',(select sum(s.total_quantity_sold) from public.sales_by_day s where s.company_entity_id=p_company and s.sku=p.sku and s.day_date between last_day-89 and last_day),
    'sales_names',(select count(distinct s.product_name) from public.sales_by_day s where s.company_entity_id=p_company and s.sku=p.sku and s.day_date between last_day-89 and last_day),
    'last_sale',(select max(s.day_date) from public.sales_by_day s where s.company_entity_id=p_company and s.sku=p.sku and s.day_date<=last_day),
    'on_hand',(select sum(i.total_available_quantity) from public.inventory_on_hand_current_v i where i.company_entity_id=p_company and i.variant_sku=p.sku),
    'stock_as_of',(select min(i.snapshot_at) from public.inventory_on_hand_current_v i where i.company_entity_id=p_company and i.variant_sku=p.sku),
    'incoming_units',coalesce((select sum(l.qty) from public.po_lines l join public.po_headers h on h.id=l.po_header_id and h.company_entity_id=p_company
      where l.company_entity_id=p_company and l.sku_snapshot=p.sku
        and h.status in ('Approved','Sent to Factory','Confirmed','In Production','Shipped','In Transit')
        and h.expected_arrival_date between public.silo_business_today() and public.silo_business_today()+p_horizon),0),
    'uncertain_po_lines',(select count(*) from public.po_lines l join public.po_headers h on h.id=l.po_header_id and h.company_entity_id=p_company
      where l.company_entity_id=p_company and l.sku_snapshot=p.sku and
        (h.status='Partially Received' or (h.status in ('Approved','Sent to Factory','Confirmed','In Production','Shipped','In Transit')
          and (h.expected_arrival_date is null or h.expected_arrival_date < public.silo_business_today()))))
  ) into result;
  return result;
end $$;

revoke all on function public.save_product_workflow_brief(uuid,uuid,integer,text,uuid,jsonb,text) from public,anon;
revoke all on function public.handoff_product_workflow_brief(uuid,uuid,integer,text,date) from public,anon;
revoke all on function public.product_workflow_restock_basis(uuid,uuid,integer) from public,anon;
grant execute on function public.save_product_workflow_brief(uuid,uuid,integer,text,uuid,jsonb,text) to authenticated;
grant execute on function public.handoff_product_workflow_brief(uuid,uuid,integer,text,date) to authenticated;
grant execute on function public.product_workflow_restock_basis(uuid,uuid,integer) to authenticated;
select public.attach_stamp_company_entity_id_triggers();
