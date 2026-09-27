-- Product-level catalog briefs; legacy single-SKU briefs retain their contract.
-- Store mappings, not products_master's last-sync store/title, define membership.
create or replace function public.product_workflow_catalog_source(p_company uuid,p_product uuid,p_group jsonb default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb; variants jsonb; n integer; matched integer; unique_skus integer;
begin
  if auth.uid() is null or p_company is null or p_company is distinct from public.active_company_id() then
    raise exception 'Active company required' using errcode='42501';
  end if;
  select to_jsonb(p) into result from public.products_master p where p.company_entity_id=p_company and p.id=p_product;
  if result is null then raise exception 'Catalog product not found'; end if;
  if p_group is null or p_group='null'::jsonb then
    if exists(select 1 from public.shopify_product_skus s where s.company_entity_id=p_company and s.sku=result->>'sku') then
      raise exception 'Choose the mapped product and store';
    end if;
    if nullif(btrim(result->>'sku'),'') is null then raise exception 'Catalog SKU is missing'; end if;
    variants := jsonb_build_array(result);
  else
    if jsonb_typeof(p_group)<>'object' or coalesce(p_group->>'shop_domain','')='' or coalesce(p_group->>'shopify_product_id','')='' then
      raise exception 'Invalid catalog group';
    end if;
    select count(*),count(p.id),count(distinct nullif(btrim(s.sku),'')),
      jsonb_agg(to_jsonb(p) || jsonb_build_object('mapped_variant_title',s.variant_title,'mapped_product_title',s.product_title,
        'shopify_variant_id',s.shopify_variant_id,'mapping_last_seen_at',s.last_seen_at) order by p.id)
    into n,matched,unique_skus,variants
    from public.shopify_product_skus s left join public.products_master p on p.company_entity_id=p_company and p.sku=s.sku
    where s.company_entity_id=p_company and s.shop_domain=p_group->>'shop_domain' and s.shopify_product_id=p_group->>'shopify_product_id';
    if n not between 1 and 100 or matched<>n or unique_skus<>n then
      raise exception 'Product mapping is incomplete, duplicated, or exceeds 100 variants. Resolve the mapping before buying';
    end if;
    if not exists(select 1 from jsonb_array_elements(variants) v where v->>'id'=p_product::text) then
      raise exception 'Catalog source is outside the selected product';
    end if;
    -- A SKU reused by two products in one shop is ambiguous for demand and POs.
    if exists(select 1 from public.shopify_product_skus s where s.company_entity_id=p_company
      and s.shop_domain=p_group->>'shop_domain' and s.shopify_product_id<>p_group->>'shopify_product_id'
      and s.sku in (select v->>'sku' from jsonb_array_elements(variants) v)) then
      raise exception 'A SKU belongs to multiple products in this store. Resolve the mapping before buying';
    end if;
  end if;
  return result || jsonb_build_object('product_title',coalesce(variants#>>'{0,mapped_product_title}',result->>'product_title'),'catalog_group',p_group,'variants',variants);
end $$;

create or replace function public.product_workflow_catalog_search(p_company uuid,p_term text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or p_company is null or p_company is distinct from public.active_company_id() then
    raise exception 'Active company required' using errcode='42501';
  end if;
  if length(btrim(coalesce(p_term,''))) not between 1 and 240 then raise exception 'Enter a product title or SKU'; end if;
  -- Group before LIMIT. Search is literal (%, _ are not wildcards).
  with groups as (
    select s.shop_domain,s.shopify_product_id,min(p.id::text)::uuid id,min(s.product_title) title,count(*) variant_count
    from public.shopify_product_skus s left join public.products_master p on p.company_entity_id=p_company and p.sku=s.sku
    where s.company_entity_id=p_company
    group by s.shop_domain,s.shopify_product_id
    having bool_or(strpos(lower(coalesce(s.product_title,'')),lower(btrim(p_term)))>0 or strpos(lower(coalesce(s.sku,'')),lower(btrim(p_term)))>0)
  ), candidates as (
    select coalesce(to_jsonb(p),'{}'::jsonb) || jsonb_build_object('product_title',g.title,'catalog_group',jsonb_build_object('shop_domain',g.shop_domain,'shopify_product_id',g.shopify_product_id),'variant_count',g.variant_count) row
    from groups g left join public.products_master p on p.company_entity_id=p_company and p.id=g.id
    union all
    select to_jsonb(p) || jsonb_build_object('catalog_group',null,'variant_count',1)
    from public.products_master p where p.company_entity_id=p_company
      and not exists(select 1 from public.shopify_product_skus s where s.company_entity_id=p_company and s.sku=p.sku)
      and (strpos(lower(coalesce(p.product_title,'')),lower(btrim(p_term)))>0 or strpos(lower(coalesce(p.sku,'')),lower(btrim(p_term)))>0)
  ) select coalesce(jsonb_agg(row),'[]'::jsonb) into result from (select row from candidates order by row->>'product_title',row#>>'{catalog_group,shop_domain}',row->>'id' limit 30) limited;
  return result;
end $$;

-- Canonical consumed identity. Sync timestamps can advance without changing it.
create or replace function public.product_workflow_variant_identity(p_source jsonb)
returns jsonb language sql immutable set search_path = '' as $$
 select jsonb_agg(jsonb_build_object('id',v->'id','sku',v->'sku','product_title',v->'product_title',
   'product_type',v->'product_type','variant_title',v->'variant_title','mapped_variant_title',v->'mapped_variant_title',
   'mapped_product_title',v->'mapped_product_title','shopify_variant_id',v->'shopify_variant_id') order by v->>'id')
 from jsonb_array_elements(p_source->'variants') v
$$;

create or replace function public.product_workflow_check_spread(p_source jsonb,p_content jsonb)
returns void language plpgsql set search_path = '' as $$
declare line jsonb;
begin
  if jsonb_typeof(p_content->'lines') is distinct from 'array' then raise exception 'Keep the full SKU spread'; end if;
  if jsonb_array_length(p_content->'lines') <> jsonb_array_length(p_source->'variants')
    or exists(select 1 from jsonb_array_elements(p_content->'lines') l group by l->>'product_master_id' having count(*)<>1)
    or exists(select 1 from jsonb_array_elements(p_content->'lines') l where not exists(
      select 1 from jsonb_array_elements(p_source->'variants') v where v->>'id'=l->>'product_master_id')) then
    raise exception 'Keep each SKU in this product exactly once; use zero units to exclude a size';
  end if;
  for line in select value from jsonb_array_elements(p_content->'lines') loop
    if line->>'qty' is not null and (line->>'qty' !~ '^[0-9]{1,7}$' or (line->>'qty')::numeric > 1000000) then
      raise exception 'Quantities must be 0–1,000,000 whole units';
    end if;
  end loop;
end $$;

-- One bounded request; exact same per-SKU evidence contract as the existing worksheet.
create or replace function public.product_workflow_product_basis(p_company uuid,p_product uuid,p_group jsonb,p_horizon integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare source jsonb; v jsonb; result jsonb := '[]';
begin
  if not coalesce(public.po_builder_can_write(),false) then raise exception 'Purchasing permission required' using errcode='42501'; end if;
  source := public.product_workflow_catalog_source(p_company,p_product,p_group);
  for v in select value from jsonb_array_elements(source->'variants') loop
    result := result || jsonb_build_array(public.product_workflow_restock_basis(p_company,(v->>'id')::uuid,p_horizon));
  end loop;
  return result;
end $$;

create or replace function public.product_workflow_check_restock_spread(p_company uuid,p_source jsonb,p_content jsonb)
returns void language plpgsql set search_path = '' as $$
declare r jsonb:=p_content->'restock'; v jsonb; line jsonb; basis jsonb; fresh jsonb;
  field text; lead_days integer; cover_days integer; safety integer; suggested numeric; needs_note boolean;
begin
  foreach field in array array['lead_days','cover_days','safety_units'] loop
    if coalesce(r->>field,'') !~ '^[0-9]{1,7}$' then raise exception 'Enter whole restock lead days, cover days and safety units'; end if;
  end loop;
  lead_days:=(r->>'lead_days')::integer; cover_days:=(r->>'cover_days')::integer; safety:=(r->>'safety_units')::integer;
  if lead_days+cover_days>730 or safety>1000000 then raise exception 'Invalid restock horizon or safety units'; end if;
  if jsonb_typeof(r->'bases') is distinct from 'array' then raise exception 'Refresh evidence for every SKU'; end if;
  if jsonb_array_length(r->'bases')<>jsonb_array_length(p_source->'variants') then raise exception 'Refresh evidence for every SKU'; end if;
  for v in select value from jsonb_array_elements(p_source->'variants') loop
    select value into line from jsonb_array_elements(p_content->'lines') where value->>'product_master_id'=v->>'id';
    if line->>'qty' is null then raise exception 'Choose units for every SKU; use zero to exclude a size'; end if;
    if (select count(*) from jsonb_array_elements(r->'bases') b where b->>'product_id'=v->>'id')<>1 then raise exception 'Refresh evidence for every SKU'; end if;
    select value into basis from jsonb_array_elements(r->'bases') where value->>'product_id'=v->>'id';
    fresh:=public.product_workflow_restock_basis(p_company,(v->>'id')::uuid,lead_days+cover_days);
    if (basis-'observed_at') is distinct from (fresh-'observed_at') then raise exception 'Restock evidence changed. Refresh the basis before review'; end if;
    suggested:=null;
    if (fresh->>'units_90d')::numeric>=0 and (fresh->>'on_hand')::numeric>=0 and (fresh->>'incoming_units')::numeric>=0 then
      suggested:=greatest(0,ceil((fresh->>'units_90d')::numeric/90*(lead_days+cover_days)+safety-(fresh->>'on_hand')::numeric-(fresh->>'incoming_units')::numeric));
    end if;
    needs_note:=suggested is null or suggested<>(line->>'qty')::numeric or (fresh->>'sales_names')::int>1
      or (fresh->>'uncertain_po_lines')::int>0 or (fresh->>'stock_as_of') is null
      or (fresh->>'stock_as_of')::timestamptz<now()-interval '48 hours'
      or (basis->>'observed_at') is null or (basis->>'observed_at')::timestamptz<now()-interval '24 hours'
      or (basis->>'observed_at')::timestamptz>now();
    if needs_note and coalesce(length(btrim(p_content->>'decision_note')),0)=0 then
      raise exception 'Explain the restock override or evidence warnings in the decision note (SKU %)',v->>'sku';
    end if;
  end loop;
end $$;

create or replace function public.save_product_workflow_brief(
  p_company uuid, p_id uuid, p_version integer, p_kind text, p_source_id uuid,
  p_content jsonb, p_status text default 'draft'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.product_workflow_briefs; family jsonb; snapshot jsonb := '{}';
  r jsonb; basis jsonb; fresh jsonb; lead_days integer; cover_days integer;
  safety integer; suggested numeric; needs_note boolean; field text;
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
     or octet_length(p_content::text) > 256000 then
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
    if b.content->>'catalog_scope' is distinct from p_content->>'catalog_scope' or b.content->'catalog_group' is distinct from p_content->'catalog_group' then
      raise exception 'The saved product group cannot change';
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
    if p_kind in ('product','restock') and p_content->>'catalog_scope'='product' then
      snapshot:=public.product_workflow_catalog_source(p_company,p_source_id,p_content->'catalog_group');
      if public.product_workflow_variant_identity(snapshot) is distinct from p_content->'source_variant_identity'
        or (select jsonb_agg(jsonb_build_object('id',v->'id','updated_at',v->'updated_at') order by v->>'id') from jsonb_array_elements(snapshot->'variants') v) is distinct from p_content->'source_variant_versions' then
        raise exception 'Product variants changed. Select the source again before saving';
      end if;
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
  -- The review boundary verifies client evidence against company-scoped facts.
  -- Keep p_content unchanged so an exact lost-response retry stays idempotent.
  if p_kind in ('product','restock') and p_content->>'catalog_scope'='product' then
    perform public.product_workflow_check_spread(b.source_snapshot,p_content);
    if p_status='reviewed' then
      if exists(select 1 from jsonb_array_elements(p_content->'lines') l where l->>'qty' is null) then
        raise exception 'Choose units for every SKU; use zero to exclude a size';
      end if;
      family:=public.product_workflow_catalog_source(p_company,p_source_id,p_content->'catalog_group');
      if public.product_workflow_variant_identity(family) is distinct from public.product_workflow_variant_identity(b.source_snapshot) then
        raise exception 'Catalog source changed. Start a fresh brief';
      end if;
      if p_kind='restock' then perform public.product_workflow_check_restock_spread(p_company,family,p_content); end if;
    end if;
  end if;
  if p_status='reviewed' and p_kind='restock' and (p_content->>'catalog_scope') is distinct from 'product' then
    r := p_content->'restock';
    foreach field in array array['lead_days','cover_days','safety_units'] loop
      if coalesce(r->>field,'') !~ '^[0-9]{1,7}$' then
        raise exception 'Enter whole restock lead days, cover days and safety units';
      end if;
    end loop;
    lead_days := (r->>'lead_days')::integer;
    cover_days := (r->>'cover_days')::integer;
    safety := (r->>'safety_units')::integer;
    if lead_days+cover_days > 730 or safety > 1000000 then raise exception 'Invalid restock horizon or safety units'; end if;
    basis := r->'basis';
    if jsonb_typeof(basis) is distinct from 'object' then
      raise exception 'Restock evidence is missing. Refresh the basis before review';
    end if;
    fresh := public.product_workflow_restock_basis(p_company,p_source_id,lead_days+cover_days);
    if (basis - 'observed_at') is distinct from (fresh - 'observed_at') then
      raise exception 'Restock evidence changed or is missing. Refresh the basis before review';
    end if;
    if jsonb_typeof(p_content->'lines') is distinct from 'array' then raise exception 'Use one restock purchase line'; end if;
    if jsonb_array_length(p_content->'lines') <> 1 then raise exception 'Use one restock purchase line'; end if;
    if coalesce(p_content#>>'{lines,0,qty}','') !~ '^[0-9]{1,7}$'
       or (p_content#>>'{lines,0,qty}')::numeric not between 1 and 1000000 then
      raise exception 'Restock quantity must be 1–1,000,000 whole units';
    end if;
    needs_note := (fresh->>'units_90d') is null or (fresh->>'on_hand') is null
      or (fresh->>'units_90d')::numeric < 0 or (fresh->>'on_hand')::numeric < 0
      or (fresh->>'incoming_units')::numeric < 0
      or (fresh->>'sales_names')::integer > 1 or (fresh->>'uncertain_po_lines')::integer > 0
      or (fresh->>'stock_as_of') is null or (fresh->>'stock_as_of')::timestamptz < now()-interval '48 hours'
      or (basis->>'observed_at') is null or (basis->>'observed_at')::timestamptz < now()-interval '24 hours'
      or (basis->>'observed_at')::timestamptz > now();
    if (fresh->>'units_90d')::numeric >= 0 and (fresh->>'on_hand')::numeric >= 0
       and (fresh->>'incoming_units')::numeric >= 0 then
      suggested := greatest(0,ceil((fresh->>'units_90d')::numeric / 90 * (lead_days+cover_days)
        + safety - (fresh->>'on_hand')::numeric - (fresh->>'incoming_units')::numeric));
    end if;
    if (coalesce(needs_note,true) or suggested is null or suggested <> (p_content#>>'{lines,0,qty}')::numeric)
       and coalesce(length(btrim(p_content->>'decision_note')),0)=0 then
      raise exception 'Explain the restock override or evidence warnings in the decision note';
    end if;
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
  family jsonb; variant jsonb; quantity integer; cost numeric; retail numeric; total_qty bigint := 0;
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
    select * into product from public.products_master where id=b.source_id and company_entity_id=p_company for share;
    if not found then raise exception 'Catalog product is missing'; end if;
    -- Lock through output creation so a concurrent catalog edit cannot race this check.
    -- Sync advances updated_at even when identity is unchanged. Compare consumed fields.
    if (c->>'catalog_scope') is distinct from 'product' and row(product.product_title,product.product_type,product.variant_title,product.sku)
       is distinct from row(b.source_snapshot->>'product_title',b.source_snapshot->>'product_type',
         b.source_snapshot->>'variant_title',b.source_snapshot->>'sku') then
      raise exception 'Catalog source changed. Start a fresh brief and review before handoff';
    end if;
  end if;
  if b.source_kind in ('product','restock') and c->>'catalog_scope'='product' then
    -- Lock existing mapping and catalog rows through creation; a changed spread is rejected.
    perform 1 from public.shopify_product_skus s where s.company_entity_id=p_company
      and s.shop_domain=c#>>'{catalog_group,shop_domain}' and s.shopify_product_id=c#>>'{catalog_group,shopify_product_id}' for share;
    perform 1 from public.products_master p where p.company_entity_id=p_company
      and p.id in (select (v->>'id')::uuid from jsonb_array_elements(b.source_snapshot->'variants') v) order by p.id for share;
    family:=public.product_workflow_catalog_source(p_company,b.source_id,c->'catalog_group');
    if public.product_workflow_variant_identity(family) is distinct from public.product_workflow_variant_identity(b.source_snapshot) then
      raise exception 'Catalog source changed. Start a fresh brief and review before handoff';
    end if;
    perform public.product_workflow_check_spread(family,c);
    if b.source_kind='restock' then perform public.product_workflow_check_restock_spread(p_company,family,c); end if;
    -- Zero-quantity variants remain in the brief, never become purchase lines.
    c:=jsonb_set(c,'{lines}',coalesce((select jsonb_agg(l) from jsonb_array_elements(c->'lines') l where (l->>'qty')::numeric>0),'[]'));
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
    if b.source_kind in ('product','restock') and (c->>'catalog_scope') is distinct from 'product' and jsonb_array_length(c->'lines') <> 1 then
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
      if family is not null then
        select value into variant from jsonb_array_elements(family->'variants') where value->>'id'=line->>'product_master_id';
        select * into product from public.products_master where id=(variant->>'id')::uuid and company_entity_id=p_company;
      end if;
      insert into public.po_lines(company_entity_id,po_header_id,product_master_id,source_concept_id,
        title_snapshot,product_type_snapshot,variant_title_snapshot,sku_snapshot,qty,unit_cost,retail_price,line_notes)
      values(p_company,output_id,product.id,concept.id,
        coalesce(product.product_title,c->>'title'),coalesce(product.product_type,c->>'product_type'),
        coalesce(variant->>'mapped_variant_title',product.variant_title,nullif(line->>'size','')),product.sku,(line->>'qty')::integer,
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

revoke all on function public.product_workflow_catalog_source(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.product_workflow_catalog_source(uuid,uuid,jsonb) to authenticated;
revoke all on function public.product_workflow_catalog_search(uuid,text) from public,anon,authenticated;
grant execute on function public.product_workflow_catalog_search(uuid,text) to authenticated;
revoke all on function public.product_workflow_product_basis(uuid,uuid,jsonb,integer) from public,anon,authenticated;
grant execute on function public.product_workflow_product_basis(uuid,uuid,jsonb,integer) to authenticated;
revoke all on function public.product_workflow_variant_identity(jsonb) from public,anon,authenticated;
revoke all on function public.product_workflow_check_spread(jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.product_workflow_check_restock_spread(uuid,jsonb,jsonb) from public,anon,authenticated;
