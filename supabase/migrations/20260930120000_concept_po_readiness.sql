-- A concept must be complete before it can become a PO (2026-09-30).
--
-- The first real Generate PO (Bat Bros Youth Hoodie) produced one flat line
-- of 1,400 units at $0 cost and $0 retail. That was a faithful copy of the
-- concept: it was approved, but held only a title, a product type, a factory
-- and a quantity. No size breakdown, no unit cost, no retail price. Of the 20
-- concepts on production at the time, 3 had a size breakdown and 1 had any
-- economics, so nearly every Generate PO would have done the same.
--
-- Filling the gaps at PO time was considered and rejected. Splitting a
-- quantity by the product type's historical size curve measured ~5s for the
-- largest type (too close to the browser's 8s statement timeout), and more
-- to the point it would have SILO invent a buy nobody decided. The gaps are
-- filled on the concept, where Ask SILO already grounds a size breakdown in
-- a comparable product's curve and records what it could not ground.
--
-- So this migration draws one line:
--
--   product_concept_po_missing(concept) -> text[]
--
-- is the ONE definition of "ready for a PO". An empty array means ready.
-- Each element is a short, human-readable name of what is missing, in the
-- order a person would fix them. Generate PO refuses a concept that returns
-- anything, product_concepts_v exposes it as po_missing so the page can show
-- the same list (never a second copy of the rule in JavaScript), and any
-- other path that hands a concept to purchasing (the Product Studio
-- consolidation in progress) should call it rather than restating it.
--
-- Ready means:
--   * approved (a draft is not a buying decision)
--   * a factory and a product type
--   * a size breakdown: every size a whole number of units (0 allowed, it is
--     skipped), at least one size above 0, and the sizes adding up to
--     suggested_qty when one is set. A fractional size is refused, never
--     rounded: po_lines.qty is an integer column on production, and rounding
--     would change a number someone chose
--   * a unit cost (FOB) and a retail price, both positive, read from
--     economics.unit_cost / economics.msrp (the keys Ask SILO writes)
--
-- Bounds keep every line inside po_lines' numeric(12,2) retail_value: a size
-- is at most 1,000,000 units and retail is under $10,000, so one line is
-- under $10bn. A value outside them reads as missing, not as a guess.
--
-- Deliberately NOT here: the collection rule (a parent with live children
-- buys product by product) needs a query over other rows, so it stays in
-- generate_po_from_concept() and the page's child_count, exactly as before.
-- Approval itself is not tightened -- whether "approved" should require
-- completeness is an open decision, and the Studio consolidation may move
-- where that sign-off lives.

create or replace function public.product_concept_po_missing(p_concept public.product_concepts)
returns text[] language plpgsql stable set search_path = '' as $$
declare
  missing text[] := '{}';
  whole_re constant text := '^\s*[0-9]{1,7}\s*$';
  money_re constant text := '^\s*[0-9]+(\.[0-9]+)?\s*$';
  bd jsonb := p_concept.suggested_size_breakdown;
  econ jsonb := p_concept.economics;
  size_row record; units bigint := 0; positive integer := 0; bad_size boolean := false;
  v text;
begin
  if p_concept.status is distinct from 'approved' then missing := missing || 'Approval'::text; end if;
  if p_concept.suggested_factory_id is null then missing := missing || 'Factory'::text; end if;
  if nullif(btrim(coalesce(p_concept.suggested_product_type, '')), '') is null then
    missing := missing || 'Product type'::text;
  end if;

  if jsonb_typeof(bd) is distinct from 'object' or bd = '{}'::jsonb then
    missing := missing || 'Size breakdown'::text;
  else
    for size_row in select e.key, e.value from jsonb_each(bd) as e(key, value) loop
      v := case when jsonb_typeof(size_row.value) in ('number', 'string') then size_row.value #>> '{}' end;
      -- CASE, not OR: SQL does not promise OR evaluates left to right, and
      -- the cast must never see a value the pattern rejected.
      if (case when v is null or v !~ whole_re or nullif(btrim(size_row.key), '') is null then true
               else v::bigint > 1000000 end) then
        bad_size := true;
      else
        units := units + v::bigint;
        if v::bigint > 0 then positive := positive + 1; end if;
      end if;
    end loop;
    if bad_size then
      missing := missing || 'Whole-unit quantity for every size'::text;
    elsif positive = 0 then
      missing := missing || 'Size breakdown'::text;
    elsif p_concept.suggested_qty is not null and units <> p_concept.suggested_qty then
      missing := missing || format('Sizes adding up to the suggested quantity (%s, sizes total %s)',
        p_concept.suggested_qty, units);
    end if;
  end if;

  v := case when jsonb_typeof(econ) = 'object' and jsonb_typeof(econ->'unit_cost') in ('number', 'string')
            then econ->>'unit_cost' end;
  if (case when v is null or v !~ money_re then true else v::numeric <= 0 or v::numeric >= 100000 end) then
    missing := missing || 'Unit cost (FOB)'::text;
  end if;
  v := case when jsonb_typeof(econ) = 'object' and jsonb_typeof(econ->'msrp') in ('number', 'string')
            then econ->>'msrp' end;
  if (case when v is null or v !~ money_re then true else v::numeric <= 0 or v::numeric >= 10000 end) then
    missing := missing || 'Retail price'::text;
  end if;

  return missing;
end $$;

comment on function public.product_concept_po_missing(public.product_concepts) is
  'The one definition of whether a product concept is ready to become a PO. Empty array = ready; '
  'otherwise the human-readable names of what is missing. Used by generate_po_from_concept() and '
  'exposed as product_concepts_v.po_missing -- see 20260930120000_concept_po_readiness.sql.';

-- Called by the security_invoker view, so authenticated needs EXECUTE. It
-- reads only the row it is handed, so it discloses nothing the caller could
-- not already select. anon gets nothing (Supabase's default privileges would
-- otherwise grant it).
revoke all on function public.product_concept_po_missing(public.product_concepts) from public, anon, authenticated;
grant execute on function public.product_concept_po_missing(public.product_concepts) to authenticated;

-- product_concepts_v, unchanged except for po_missing appended LAST, so
-- `create or replace view` accepts it and no existing reader moves.
create or replace view public.product_concepts_v with (security_invoker = true) as
 SELECT c.id,
    c.company_entity_id,
    c.created_by,
    creator.name AS created_by_name,
    c.approved_by,
    approver.name AS approved_by_name,
    c.approved_at,
    c.title,
    c.concept_summary,
    c.marketing_angle,
    c.audience,
    c.audience_tags,
    c.suggested_qty,
    c.suggested_factory_id,
    f.factory_name AS suggested_factory_name,
    c.suggested_channels,
    c.suggested_retail_dtc_notes,
    c.suggested_launch_date,
    c.suggested_launch_notes,
    c.reasoning,
    c.notes,
    c.status,
    c.phase,
    c.created_at,
    c.updated_at,
    c.reference_image_urls,
    c.resulting_po_header_id,
    po.po_name AS resulting_po_name,
    c.suggested_size_breakdown,
    c.suggested_channel_split,
    c.suggested_launch_time,
    c.suggested_marketing_spend,
    c.suggested_weekly_revenue_projection,
    c.suggested_email_sms_plan,
    c.suggested_marketing_copy,
    c.parent_concept_id,
    parent.title AS parent_title,
    c.suggested_product_type,
    c.objective,
    c.primary_goal,
    c.secondary_audience,
    c.audience_rationale,
    c.historical_evidence,
    c.evidence_strength,
    c.buy_rationale,
    c.supply_notes,
    c.supply_constraints,
    c.economics,
    c.forecast,
    c.creative_story,
    c.visual_direction,
    c.brand_fit,
    c.risks,
    c.unknowns,
    c.recommendation,
    c.recommendation_reasoning,
    c.next_decision,
    c.field_evidence,
    c.provenance,
    c.revision_note,
    c.current_revision_number,
    ( SELECT count(*) AS count
           FROM public.product_concept_revisions r
          WHERE r.concept_id = c.id) AS revision_count,
    ( SELECT count(*) AS count
           FROM public.product_concepts ch
          WHERE ch.parent_concept_id = c.id) AS child_count,
    public.product_concept_po_missing(c) AS po_missing
   FROM public.product_concepts c
     LEFT JOIN public.profiles creator ON creator.id = c.created_by
     LEFT JOIN public.profiles approver ON approver.id = c.approved_by
     LEFT JOIN public.factories f ON f.id = c.suggested_factory_id
     LEFT JOIN public.po_headers po ON po.id = c.resulting_po_header_id
     LEFT JOIN public.product_concepts parent ON parent.id = c.parent_concept_id;

-- generate_po_from_concept(): same function as 20260930000000, with the
-- readiness gate in front of any write and the lines taken ONLY from the
-- size breakdown. The suggested_qty fallback line is gone: it is exactly the
-- flat, sizeless line this migration exists to stop.
create or replace function public.generate_po_from_concept(p_concept_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  co uuid := public.active_company_id();
  concept public.product_concepts;
  existing uuid; po_id uuid; factory uuid;
  missing text[]; cost numeric; retail numeric; qty integer;
  n integer := 0; size_row record;
begin
  if auth.uid() is null or co is null or not coalesce(public.po_builder_can_write(), false) then
    raise exception 'Purchasing permission and an active company are required' using errcode = '42501';
  end if;
  if p_concept_id is null then raise exception 'Concept not found' using errcode = 'P0002'; end if;

  select * into concept from public.product_concepts
    where id = p_concept_id and company_entity_id = co for update;
  if not found then raise exception 'Concept not found' using errcode = 'P0002'; end if;

  -- A repeat returns the PO already made, before any readiness check, so a
  -- PO generated earlier stays reachable whatever the concept is now.
  select h.id into existing from public.po_headers h
    where h.generated_from_concept_id = concept.id and h.company_entity_id = co
    limit 1;
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

  missing := public.product_concept_po_missing(concept);
  if cardinality(missing) > 0 then
    raise exception 'This concept is not ready for a PO. Missing: %', array_to_string(missing, '; ')
      using errcode = '22023';
  end if;

  factory := concept.suggested_factory_id;
  if not exists (select 1 from public.factories f where f.id = factory and f.company_entity_id = co) then
    raise exception 'The concept''s factory is not in the active company' using errcode = '22023';
  end if;

  -- Readiness has already proven these parse and sit inside their bounds.
  cost := (concept.economics->>'unit_cost')::numeric;
  retail := (concept.economics->>'msrp')::numeric;

  insert into public.po_headers(company_entity_id, po_name, factory_id, order_date, req_ship_date,
      status, is_new_product_po, wholesale_triggered, created_by, generated_from_concept_id)
    values (co, public.generate_next_po_name(factory), factory, public.silo_business_today(),
      public.silo_business_today() + 45, 'Draft', true, false, auth.uid(), concept.id)
    returning id into po_id;

  for size_row in
    select e.key, (e.value #>> '{}')::integer as units
    from jsonb_each(concept.suggested_size_breakdown) with ordinality as e(key, value, ord)
    order by e.ord
  loop
    qty := size_row.units;
    continue when qty = 0;
    insert into public.po_lines(company_entity_id, po_header_id, source_concept_id, title_snapshot,
        product_type_snapshot, variant_title_snapshot, qty, unit_cost, retail_price, retail_value, line_notes)
      values (co, po_id, concept.id, concept.title, concept.suggested_product_type, size_row.key,
        qty, cost, retail, round(qty * retail, 2), btrim('From concept: ' || coalesce(concept.title, '')));
    n := n + 1;
  end loop;

  insert into public.po_concept_links(company_entity_id, po_header_id, concept_id, created_by)
    values (co, po_id, concept.id, auth.uid())
    on conflict do nothing;

  return jsonb_build_object('po_header_id', po_id, 'repeated', false, 'line_count', n);
end $$;

revoke all on function public.generate_po_from_concept(uuid) from public, anon, authenticated;
grant execute on function public.generate_po_from_concept(uuid) to authenticated;

-- product_concepts_v gained a column; keep Ask SILO's schema map current.
select public.refresh_chat_schema_catalog();
