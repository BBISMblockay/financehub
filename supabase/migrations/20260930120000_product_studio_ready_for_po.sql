-- Product Studio: an explicit, server-enforced "Ready for PO" gate on concepts.
--
-- One flow: Ask SILO -> Product Studio -> review -> Ready for PO -> draft PO.
-- It reuses what exists rather than adding a second workflow:
--   * product_concepts stays the idea record Ask SILO drafts and revises.
--   * product_workflow_briefs (20260926082115) stays the reviewed purchasing
--     record. For a CONCEPT brief, "Save as reviewed" now IS "Mark ready for
--     PO": it is refused unless the purchasing details pass the readiness
--     rules below, and it stamps po_ready_* with who, when, and a fingerprint
--     of the concept's purchasing fields at that moment.
--   * handoff_product_workflow_brief() stays the only code that turns a
--     concept into PO rows. generate_po_from_concept() (20260930000000, the
--     legacy Generate PO deep link) no longer builds its own lines from the
--     concept's AI suggestions: it hands off the concept's ready brief, so
--     both entry points produce the same PO from the same reviewed snapshot.
--
-- Readiness is deliberately NOT product_concepts.status = 'approved'. Approval
-- predates these rules (Bat Bros Youth Hoodie was approved with no size
-- breakdown and produced one unsized 1,400-unit line), so no existing concept
-- is treated as ready. Nothing in this migration writes to product_concepts,
-- po_headers or po_lines rows that already exist.
--
-- What makes the gate hold:
--   1. The readiness rules run in the database at mark-ready AND again at PO
--      creation (product_concept_po_readiness_issues). The page's checklist is
--      a mirror for the person, never the authority.
--   2. The PO is generated from the brief content that was reviewed. A
--      reviewed brief is frozen (existing rule); editing it means reopening,
--      which clears po_ready_*.
--   3. If Ask SILO (or anyone) changes the CONCEPT's purchasing suggestions
--      after it was marked ready, the stored fingerprint no longer matches and
--      PO creation is refused until someone reviews it again.
--   4. Every concept-to-PO path goes through a SECURITY DEFINER function.
--      Direct client writes of po_lines.source_concept_id,
--      po_headers.generated_from_concept_id and po_concept_links rows are
--      refused by trigger, so the hidden in-builder concept picker (or a
--      hand-crafted PostgREST request) cannot bypass the gate. Ordinary PO
--      lines, which carry no concept, are untouched.
--   5. One concept has at most one PO from this flow. Every path locks the
--      concept row first (lock order: concept, then brief), and a concept that
--      already has a PO returns or names that PO instead of making another.

alter table public.product_workflow_briefs
  add column if not exists po_ready_at timestamptz,
  add column if not exists po_ready_by uuid,
  add column if not exists po_ready_concept_fingerprint text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'product_workflow_briefs_po_ready_shape'
                   and conrelid = 'public.product_workflow_briefs'::regclass) then
    alter table public.product_workflow_briefs add constraint product_workflow_briefs_po_ready_shape check (
      (po_ready_at is null) = (po_ready_by is null)
      and (po_ready_at is null) = (po_ready_concept_fingerprint is null)
      and (po_ready_at is null or (status = 'reviewed' and source_kind = 'concept')));
  end if;
end $$;

comment on column public.product_workflow_briefs.po_ready_at is
  'Set only by save_product_workflow_brief() when a person marks a concept brief ready for PO. Cleared on reopen. Not the same as product_concepts.status = approved.';
comment on column public.product_workflow_briefs.po_ready_concept_fingerprint is
  'product_concept_purchasing_fingerprint() of the concept when it was marked ready. PO creation refuses if the concept''s purchasing suggestions changed since.';

-- The concept fields that describe WHAT would be bought. A change to any of
-- them after readiness requires a fresh review. Marketing copy, imagery and
-- evidence are not purchasing details and do not invalidate readiness.
create or replace function public.product_concept_purchasing_fingerprint(p_concept public.product_concepts)
returns text language sql immutable security invoker set search_path = '' as $$
  select md5(jsonb_build_array(p_concept.id, p_concept.suggested_product_type, p_concept.suggested_factory_id,
    p_concept.suggested_qty, p_concept.suggested_size_breakdown, p_concept.parent_concept_id,
    p_concept.status = 'archived')::text)
$$;

-- The PO a concept already has, if any: the one this flow generated first,
-- otherwise the most recent PO it is linked to. Company-scoped explicitly.
create or replace function public.product_concept_po_header(p_company uuid, p_concept_id uuid)
returns uuid language sql stable security invoker set search_path = '' as $$
  select h.id from public.po_concept_links l
    join public.po_headers h on h.id = l.po_header_id and h.company_entity_id = p_company
   where l.concept_id = p_concept_id and l.company_entity_id = p_company
   order by (h.generated_from_concept_id = p_concept_id) desc nulls last, l.created_at desc, h.id
   limit 1
$$;

-- THE readiness rules. Returns every missing item (empty = ready). Mirrored in
-- v3/product-workflow-model.js readinessIssues() for the on-page checklist;
-- scripts/tests/product-studio-ready-for-po-database.test.mjs runs the same
-- cases through both.
create or replace function public.product_concept_po_readiness_issues(p_company uuid, p_concept_id uuid, p_content jsonb)
returns text[] language plpgsql stable security invoker set search_path = '' as $$
declare
  issues text[] := '{}';
  concept public.product_concepts;
  r jsonb; lines jsonb; line jsonb; mode text;
  stated integer; total bigint := 0; n integer;
  bad_qty boolean := false; bad_size boolean := false; bad_money boolean := false;
  actual jsonb; confirmed jsonb;
  num_re constant text := '^\s*[0-9]+(\.[0-9]+)?\s*$';
  uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  select * into concept from public.product_concepts where id = p_concept_id and company_entity_id = p_company;
  if not found or concept.status = 'archived' then
    return array['The concept is archived or not in the active company'];
  end if;
  if exists (select 1 from public.product_concepts ch where ch.parent_concept_id = concept.id
               and ch.company_entity_id = p_company and ch.status <> 'archived') then
    return array['This is a collection. Mark each product in it ready for PO separately'];
  end if;
  if p_content is null or jsonb_typeof(p_content) <> 'object' then
    return array['Save the purchasing details first'];
  end if;

  if coalesce(btrim(p_content->>'title'), '') = '' then issues := array_append(issues, 'Add a product title'); end if;
  if coalesce(btrim(p_content->>'product_type'), '') = '' then issues := array_append(issues, 'Choose a product type'); end if;
  -- CASE, not OR: Postgres does not promise to short-circuit before the cast.
  -- Parenthesised: PL/pgSQL's IF otherwise stops at the CASE's own THEN.
  if (case when coalesce(p_content->>'factory_id', '') !~ uuid_re then true
           else not exists (select 1 from public.factories f
                            where f.id = (p_content->>'factory_id')::uuid and f.company_entity_id = p_company) end) then
    issues := array_append(issues, 'Choose a factory in the active company');
  end if;

  r := case when jsonb_typeof(p_content->'po_readiness') = 'object' then p_content->'po_readiness' else '{}'::jsonb end;
  if (case when coalesce(r->>'total_qty', '') ~ '^[0-9]{1,7}$' then (r->>'total_qty')::integer between 1 and 1000000 else false end) then
    stated := (r->>'total_qty')::integer;
  else
    issues := array_append(issues, 'Enter a positive whole-unit total quantity');
  end if;
  mode := r->>'size_mode';
  if mode is null or mode not in ('sized', 'one_size') then
    issues := array_append(issues, 'Choose whether the product is sized or one size');
  end if;

  lines := case when jsonb_typeof(p_content->'lines') = 'array' then p_content->'lines' else '[]'::jsonb end;
  n := jsonb_array_length(lines);
  if n = 0 then
    issues := array_append(issues, 'Add the size/variant range');
  elsif n > 100 then
    issues := array_append(issues, 'Use at most 100 sizes/variants');
  else
    for line in select value from jsonb_array_elements(lines) loop
      if jsonb_typeof(line) <> 'object' then bad_qty := true; bad_size := true; continue; end if;
      if (case when coalesce(line->>'qty', '') ~ '^[0-9]{1,7}$' then (line->>'qty')::integer < 1 else true end) then bad_qty := true;
      else total := total + (line->>'qty')::integer; end if;
      if coalesce(btrim(line->>'size'), '') = '' then bad_size := true; end if;
      if (case when line->>'unit_cost' is null then false when line->>'unit_cost' !~ num_re then true
               else (line->>'unit_cost')::numeric > 1000000 end)
         or (case when line->>'retail_price' is null then false when line->>'retail_price' !~ num_re then true
               else (line->>'retail_price')::numeric > 1000000 end) then
        bad_money := true;
      end if;
    end loop;
    if bad_qty then issues := array_append(issues, 'Give every size a whole quantity of at least 1 (remove sizes you are not buying)'); end if;
    if bad_size then issues := array_append(issues, 'Name every size/variant');
    elsif (select count(distinct lower(btrim(l->>'size'))) from jsonb_array_elements(lines) l) <> n then
      issues := array_append(issues, 'List each size/variant once');
    end if;
    if bad_money then issues := array_append(issues, 'Unit cost and retail price must be blank or 0-1,000,000'); end if;
    if mode = 'one_size' and n <> 1 then issues := array_append(issues, 'A one-size product has exactly one line'); end if;
    if not bad_qty and stated is not null and total <> stated then
      issues := array_append(issues, format('Sizes total %s units but the confirmed total is %s', total, stated));
    end if;
  end if;

  -- The confirmation must describe exactly these lines, in this order. The
  -- page clears it whenever a size or quantity changes; this refuses a
  -- payload whose confirmation describes something else.
  actual := (select jsonb_agg(jsonb_build_array(btrim(e.v->>'size'), e.v->>'qty') order by e.o)
               from jsonb_array_elements(lines) with ordinality e(v, o));
  confirmed := (select jsonb_agg(jsonb_build_array(btrim(e.v->>0), e.v->>1) order by e.o)
                  from jsonb_array_elements(case when jsonb_typeof(r->'confirmed_lines') = 'array'
                                                 then r->'confirmed_lines' else '[]'::jsonb end) with ordinality e(v, o));
  if (r->'range_confirmed') is distinct from 'true'::jsonb or actual is null or confirmed is distinct from actual then
    issues := array_append(issues, 'Confirm the size/variant range and quantities');
  end if;
  return issues;
end $$;

-- ---------------------------------------------------------------------------
-- save_product_workflow_brief: 20260927074820's body, plus the readiness gate
-- for concept briefs saved as reviewed.
-- ---------------------------------------------------------------------------
create or replace function public.save_product_workflow_brief(
  p_company uuid, p_id uuid, p_version integer, p_kind text, p_source_id uuid,
  p_content jsonb, p_status text default 'draft'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.product_workflow_briefs; family jsonb; snapshot jsonb := '{}';
  r jsonb; basis jsonb; fresh jsonb; lead_days integer; cover_days integer;
  safety integer; suggested numeric; needs_note boolean; field text;
  concept public.product_concepts; marking boolean := false; existing_po uuid; issues text[];
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
  -- Marking a concept ready locks the concept FIRST, the same order as
  -- handoff and generate_po_from_concept, so the three cannot deadlock.
  marking := p_kind = 'concept' and p_status = 'reviewed';
  if marking then
    select * into concept from public.product_concepts
      where id = p_source_id and company_entity_id = p_company for update;
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
  -- Mark ready for PO: the readiness rules, a single PO per concept, and a
  -- single ready brief per concept. All refusals roll the whole save back.
  if marking then
    if concept.id is null or concept.status = 'archived' then
      raise exception 'Concept is missing or archived' using errcode='22023';
    end if;
    existing_po := public.product_concept_po_header(p_company, concept.id);
    if existing_po is not null then
      raise exception 'This concept already has PO %. Open that PO instead of marking the concept ready again',
        (select po_name from public.po_headers where id = existing_po) using errcode='22023';
    end if;
    if exists (select 1 from public.product_workflow_briefs o
               where o.company_entity_id = p_company and o.source_kind = 'concept' and o.source_id = concept.id
                 and o.id <> p_id and o.status = 'reviewed' and o.po_ready_at is not null and o.po_header_id is null) then
      raise exception 'Another brief for this concept is already ready for PO. Reopen or use that brief' using errcode='22023';
    end if;
    issues := public.product_concept_po_readiness_issues(p_company, concept.id, p_content);
    if cardinality(issues) > 0 then
      raise exception 'Not ready for PO: %', array_to_string(issues, '; ') using errcode='22023';
    end if;
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
    reviewed_at=case when p_status='reviewed' then now() end,
    po_ready_at=case when marking then now() end,
    po_ready_by=case when marking then auth.uid() end,
    po_ready_concept_fingerprint=case when marking then public.product_concept_purchasing_fingerprint(concept) end,
    updated_at=now()
    where id=p_id returning * into b;
  return to_jsonb(b);
end $$;

-- ---------------------------------------------------------------------------
-- handoff_product_workflow_brief: 20260927074820's body, plus the readiness
-- gate for concept POs, the concept-first lock order, and the
-- generated_from_concept_id claim so every entry point shares one PO.
-- ---------------------------------------------------------------------------
create or replace function public.handoff_product_workflow_brief(
  p_company uuid, p_id uuid, p_version integer, p_target text, p_launch_date date default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.product_workflow_briefs; c jsonb; line jsonb; output_id uuid;
  factory uuid; product public.products_master; concept public.product_concepts;
  family jsonb; variant jsonb; quantity integer; cost numeric; retail numeric; total_qty bigint := 0;
  src_kind text; src_id uuid; existing_po uuid; issues text[];
begin
  if auth.uid() is null or p_company is null
     or p_company is distinct from public.active_company_id()
     or not coalesce(public.po_builder_can_write(), false) then
    raise exception 'Purchasing permission and the active company are required' using errcode='42501';
  end if;
  if p_target is null or p_target not in ('po','launch') then raise exception 'Unknown handoff'; end if;
  -- Lock order is concept, then brief (as in save and generate_po_from_concept).
  select source_kind, source_id into src_kind, src_id from public.product_workflow_briefs
    where id=p_id and company_entity_id=p_company;
  if not found then raise exception 'Brief not found'; end if;
  if src_kind='concept' and p_target='po' then
    perform 1 from public.product_concepts where id=src_id and company_entity_id=p_company for update;
  end if;
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
    -- Ready for PO, checked again at creation. The PO is built from this
    -- brief's reviewed content, never from the concept's current suggestions.
    if concept.id is not null then
      if b.po_ready_at is null then
        raise exception 'Mark this concept ready for PO before creating a PO' using errcode='22023';
      end if;
      if public.product_concept_purchasing_fingerprint(concept) is distinct from b.po_ready_concept_fingerprint then
        raise exception 'The concept''s purchasing details changed after it was marked ready for PO. Reopen the brief and mark it ready again' using errcode='22023';
      end if;
      issues := public.product_concept_po_readiness_issues(p_company, concept.id, c);
      if cardinality(issues) > 0 then
        raise exception 'Not ready for PO: %', array_to_string(issues, '; ') using errcode='22023';
      end if;
      existing_po := public.product_concept_po_header(p_company, concept.id);
      if existing_po is not null then
        raise exception 'This concept already has PO %', (select po_name from public.po_headers where id=existing_po) using errcode='22023';
      end if;
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
    insert into public.po_headers(company_entity_id,po_name,factory_id,order_date,status,is_new_product_po,created_by,internal_notes,generated_from_concept_id)
      values(p_company,public.generate_next_po_name(factory),factory,public.silo_business_today(),'Draft',
        b.source_kind in ('concept','idea'),auth.uid(),'Product workflow brief ' || b.id::text,concept.id)
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

-- ---------------------------------------------------------------------------
-- generate_po_from_concept: the legacy Generate PO entry point
-- (/v2/po-builder.html?fromConcept=<id>). It no longer turns the concept's
-- AI suggestions into lines. It returns the concept's existing PO, or hands
-- off the concept's ready brief through the same function Product Studio
-- uses, or refuses. Same signature and return shape as 20260930000000, plus
-- brief_id.
-- ---------------------------------------------------------------------------
create or replace function public.generate_po_from_concept(p_concept_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  co uuid := public.active_company_id();
  concept public.product_concepts;
  ready public.product_workflow_briefs;
  existing uuid; po_id uuid; handed jsonb;
begin
  if auth.uid() is null or co is null or not coalesce(public.po_builder_can_write(), false) then
    raise exception 'Purchasing permission and an active company are required' using errcode = '42501';
  end if;
  if p_concept_id is null then raise exception 'Concept not found' using errcode = 'P0002'; end if;

  select * into concept from public.product_concepts
    where id = p_concept_id and company_entity_id = co for update;
  if not found then raise exception 'Concept not found' using errcode = 'P0002'; end if;

  -- A PO made earlier (by either entry point, or before this gate existed)
  -- stays reachable, even if the concept has since been archived.
  existing := public.product_concept_po_header(co, concept.id);
  if existing is not null then
    return jsonb_build_object('po_header_id', existing, 'repeated', true, 'line_count', null);
  end if;

  if concept.status = 'archived' then
    raise exception 'This concept is archived. Restore it before generating a PO' using errcode = '22023';
  end if;
  if exists (select 1 from public.product_concepts ch
             where ch.parent_concept_id = concept.id and ch.company_entity_id = co
               and ch.status <> 'archived') then
    raise exception 'This concept is a collection. Generate a PO from each product in it' using errcode = '22023';
  end if;

  select * into ready from public.product_workflow_briefs
    where company_entity_id = co and source_kind = 'concept' and source_id = concept.id
      and status = 'reviewed' and po_ready_at is not null and po_header_id is null
    order by po_ready_at desc, id limit 1;
  if not found then
    raise exception 'This concept is not ready for PO. Open it in Product Studio, confirm the product type, factory, sizes and quantities, and mark it ready for PO' using errcode = '22023';
  end if;

  handed := public.handoff_product_workflow_brief(co, ready.id, ready.version, 'po', null);
  po_id := (handed->>'po_header_id')::uuid;
  return jsonb_build_object('po_header_id', po_id, 'repeated', false, 'brief_id', ready.id,
    'line_count', (select count(*)::int from public.po_lines where po_header_id = po_id));
end $$;

-- ---------------------------------------------------------------------------
-- No concept-to-PO write except through the functions above.
--
-- SECURITY INVOKER on purpose: inside a SECURITY DEFINER function current_user
-- is the function's owner, so the handoff's own inserts pass; a browser
-- request runs as authenticated (or anon) and is refused. Service-role jobs
-- are not client roles and are unaffected. Only concept-carrying values are
-- guarded: a line with no source_concept_id, a header with no
-- generated_from_concept_id, an unchanged value on update, clearing a value,
-- and deleting a link all pass, so manual PO creation and editing behave as
-- before.
-- ---------------------------------------------------------------------------
create or replace function public.guard_concept_po_writes()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if tg_table_name = 'po_lines' then
    if new.source_concept_id is not null
       and (tg_op = 'INSERT' or new.source_concept_id is distinct from old.source_concept_id) then
      raise exception 'Concept lines are created from Product Studio once the concept is ready for PO' using errcode = '42501';
    end if;
  elsif tg_table_name = 'po_headers' then
    if new.generated_from_concept_id is not null
       and (tg_op = 'INSERT' or new.generated_from_concept_id is distinct from old.generated_from_concept_id) then
      raise exception 'A concept PO is created from Product Studio once the concept is ready for PO' using errcode = '42501';
    end if;
  elsif tg_table_name = 'po_concept_links' then
    raise exception 'Concept links are created from Product Studio once the concept is ready for PO' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_concept_po_writes on public.po_lines;
create trigger trg_guard_concept_po_writes before insert or update of source_concept_id on public.po_lines
  for each row execute function public.guard_concept_po_writes();
drop trigger if exists trg_guard_concept_po_writes on public.po_headers;
create trigger trg_guard_concept_po_writes before insert or update of generated_from_concept_id on public.po_headers
  for each row execute function public.guard_concept_po_writes();
drop trigger if exists trg_guard_concept_po_writes on public.po_concept_links;
create trigger trg_guard_concept_po_writes before insert or update on public.po_concept_links
  for each row execute function public.guard_concept_po_writes();

-- ---------------------------------------------------------------------------
-- Product Studio's three concept views: Ideas / drafts, Ready for PO, PO
-- created. security_invoker, so every branch runs under the caller's RLS.
-- "PO created" reads po_concept_links (company-readable) rather than
-- po_headers, whose select policy is narrower than the company; po_name is
-- therefore null for a member who cannot see that PO, but the stage is right.
-- ---------------------------------------------------------------------------
create or replace view public.product_studio_concepts_v with (security_invoker = true) as
select c.id, c.company_entity_id, c.title, c.status, c.phase, c.parent_concept_id,
  c.suggested_product_type, c.suggested_factory_id, c.suggested_qty, c.reference_image_urls,
  c.evidence_strength, c.created_at, c.updated_at,
  kids.child_count,
  link.po_header_id, h.po_name, h.status as po_status,
  ready.id as ready_brief_id, ready.po_ready_at,
  (ready.id is not null and ready.po_ready_concept_fingerprint
     is distinct from public.product_concept_purchasing_fingerprint(c)) as ready_stale,
  latest.id as latest_brief_id, latest.status as latest_brief_status,
  case when link.po_header_id is not null then 'po_created'
       when kids.child_count > 0 then 'collection'
       when ready.id is not null and ready.po_ready_concept_fingerprint
              is not distinct from public.product_concept_purchasing_fingerprint(c) then 'ready_for_po'
       else 'draft' end as stage
from public.product_concepts c
left join lateral (select count(*)::int as child_count from public.product_concepts k
                   where k.parent_concept_id = c.id and k.company_entity_id = c.company_entity_id
                     and k.status <> 'archived') kids on true
left join lateral (select l.po_header_id from public.po_concept_links l
                   where l.concept_id = c.id and l.company_entity_id = c.company_entity_id
                   order by l.created_at desc, l.id limit 1) link on true
left join public.po_headers h on h.id = link.po_header_id and h.company_entity_id = c.company_entity_id
left join lateral (select b.id, b.po_ready_at, b.po_ready_concept_fingerprint from public.product_workflow_briefs b
                   where b.company_entity_id = c.company_entity_id and b.source_kind = 'concept' and b.source_id = c.id
                     and b.status = 'reviewed' and b.po_ready_at is not null and b.po_header_id is null
                   order by b.po_ready_at desc, b.id limit 1) ready on true
left join lateral (select b.id, b.status from public.product_workflow_briefs b
                   where b.company_entity_id = c.company_entity_id and b.source_kind = 'concept' and b.source_id = c.id
                     and b.status <> 'dismissed'
                   order by b.updated_at desc, b.id limit 1) latest on true
where c.company_entity_id = public.active_company_id() and c.status <> 'archived';

comment on view public.product_studio_concepts_v is
  'Product Studio concept stages. stage: draft (Ideas/Drafts), ready_for_po (a reviewed brief marked ready whose concept purchasing fields are unchanged), po_created (linked to a PO), collection (a parent; its products are staged individually). ready_stale = marked ready but the concept''s purchasing suggestions changed since, so it needs review again. Approved status is NOT readiness.';

revoke all on public.product_studio_concepts_v from public, anon;
grant select on public.product_studio_concepts_v to authenticated;

-- Grants. Supabase's default privileges hand EXECUTE on a new public function
-- to anon and authenticated; the revokes are the boundary (20260904330000).
revoke all on function public.product_concept_purchasing_fingerprint(public.product_concepts) from public, anon;
grant execute on function public.product_concept_purchasing_fingerprint(public.product_concepts) to authenticated;
revoke all on function public.product_concept_po_header(uuid, uuid) from public, anon, authenticated;
revoke all on function public.product_concept_po_readiness_issues(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.guard_concept_po_writes() from public, anon, authenticated;
revoke all on function public.save_product_workflow_brief(uuid,uuid,integer,text,uuid,jsonb,text) from public, anon;
grant execute on function public.save_product_workflow_brief(uuid,uuid,integer,text,uuid,jsonb,text) to authenticated;
revoke all on function public.handoff_product_workflow_brief(uuid,uuid,integer,text,date) from public, anon;
grant execute on function public.handoff_product_workflow_brief(uuid,uuid,integer,text,date) to authenticated;
revoke all on function public.generate_po_from_concept(uuid) from public, anon, authenticated;
grant execute on function public.generate_po_from_concept(uuid) to authenticated;
