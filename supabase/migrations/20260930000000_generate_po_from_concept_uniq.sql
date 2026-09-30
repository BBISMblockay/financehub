-- Generate PO from a concept: close the duplicate-PO race (PR #830
-- supplemental review, 2026-09-30).
--
-- v2/po-builder.html?fromConcept=<id> checked po_concept_links for an
-- existing link, and if none, created a NEW po_headers row, inserted lines,
-- then inserted the link -- three separate client-driven statements, none
-- of them atomic with each other. Two concurrent callers (two tabs, or a
-- double-click) that both read "no link yet" before either writes each
-- independently create their OWN po_headers row and their OWN lines; the
-- LATER po_concept_links insert only de-duplicates the LINK (its unique
-- constraint is (po_header_id, concept_id), which differs across the two
-- headers and so does not fire), leaving two real, wasteful POs with real
-- (duplicated) quantities. Reproduced by the supplemental reviewer running
-- the committed functions against a mocked store enforcing that exact
-- constraint: two concurrent first requests produced two POs / two lines /
-- two links for one concept.
--
-- The fix closes the race at the EARLIEST possible point -- the po_headers
-- INSERT itself -- rather than trying to make three separate client round
-- trips atomic after the fact (which would need a claims table spanning
-- multiple HTTP calls, the pattern used elsewhere in this schema for
-- exactly that harder problem -- e.g. stripe_connect_setup_claims,
-- billing_checkout_claims -- but unnecessary here because the FIRST write
-- in this sequence, the po_headers insert, can itself carry the claim).
-- generated_from_concept_id records which concept a PO was the PRIMARY
-- generation target for. A PARTIAL unique index (only where non-null) means
-- inserting a second po_headers row for the same concept via this path
-- fails with a 23505 unique-violation -- Postgres decides the race, not a
-- client-side check-then-act sequence, and whichever insert loses can look
-- up the winner's row directly rather than creating a duplicate.
--
-- The index alone was not enough: the page still wrote the header, then the
-- lines, then the link, so a failure in between left a claimed EMPTY PO.
-- generate_po_from_concept() at the end of this file makes all three in one
-- transaction; the index stays as the backstop for any other writer.
--
-- Deliberately NOT a constraint on po_concept_links (that table's
-- many-to-many model -- several concepts combined into one PO via the
-- existing modal picker -- is correct and unrelated; a concept added to an
-- open PO through that picker never sets this column). Deliberately NOT
-- scoped by company_entity_id: a product_concepts.id is already unique to
-- exactly one company, so a bare unique index on the column is sufficient
-- and correct -- no two companies can ever legitimately share a concept id.

alter table public.po_headers
  add column if not exists generated_from_concept_id uuid references public.product_concepts(id);

create unique index if not exists po_headers_generated_from_concept_uniq
  on public.po_headers (generated_from_concept_id)
  where generated_from_concept_id is not null;

comment on column public.po_headers.generated_from_concept_id is
  'Set only by generate_po_from_concept() (the Generate PO button, via /v2/po-builder.html?fromConcept=). '
  'The partial unique index above is the idempotency guard against a '
  'concurrent duplicate generation for the same concept -- see '
  '20260930000000_generate_po_from_concept_uniq.sql.';

-- ---------------------------------------------------------------------------
-- generate_po_from_concept(concept): the WHOLE generation in one transaction
-- (PR #830 review, 2026-09-30, finding 2).
--
-- The index above closed the duplicate race, but the page still wrote the
-- claimed header, then the lines, then the link, as three separate requests.
-- A failure after the header (a line insert refused, the tab closed, a
-- dropped connection) left an EMPTY PO holding the claim, and every later
-- Generate PO then opened that empty PO instead of making a real one. The
-- claim was sticky and carried nothing.
--
-- So the header, its lines and the po_concept_links row are one function
-- call. A failure anywhere rolls ALL of it back, which means the claim only
-- exists if the lines do. Checks and ordering mirror
-- handoff_product_workflow_brief():
--   * the caller, the active company and po_builder_can_write() are checked
--     explicitly, because SECURITY DEFINER bypasses RLS
--   * the concept row is locked FOR UPDATE, so concurrent calls for one
--     concept serialise here. The second one sees the first one's PO and
--     returns it (repeated = true) rather than reaching the unique index at
--     all. The index stays as the backstop for any other writer
--   * an archived concept and a collection parent (one that has live
--     children) are refused. A collection is purchased product by product,
--     since one PO is one factory
--   * the factory must be the concept's own suggested factory and must sit
--     in the active company
--
-- The lines follow the same rule as v2/po-builder.html's conceptToLines():
-- one line per size with a positive quantity in suggested_size_breakdown,
-- otherwise one line at suggested_qty (0 allowed, since the buyer sets the
-- real number). A number that fails to parse becomes NULL (unknown) or is
-- left out, never a guess.
create or replace function public.generate_po_from_concept(p_concept_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  co uuid := public.active_company_id();
  concept public.product_concepts;
  existing uuid; po_id uuid; factory uuid;
  econ jsonb; cost numeric; retail numeric; qty numeric;
  bd jsonb; n integer := 0; size_row record;
  num_re constant text := '^\s*-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?\s*$';
begin
  if auth.uid() is null or co is null or not coalesce(public.po_builder_can_write(), false) then
    raise exception 'Purchasing permission and an active company are required' using errcode = '42501';
  end if;
  if p_concept_id is null then raise exception 'Concept not found' using errcode = 'P0002'; end if;

  select * into concept from public.product_concepts
    where id = p_concept_id and company_entity_id = co for update;
  if not found then raise exception 'Concept not found' using errcode = 'P0002'; end if;

  -- A repeat call returns the PO already made. It runs before the archived
  -- and collection checks, so a PO generated earlier stays reachable even if
  -- the concept has since been archived.
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

  factory := concept.suggested_factory_id;
  if factory is null then
    raise exception 'This concept has no suggested factory. Set one before generating a PO' using errcode = '22023';
  end if;
  if not exists (select 1 from public.factories f where f.id = factory and f.company_entity_id = co) then
    raise exception 'The concept''s factory is not in the active company' using errcode = '22023';
  end if;

  econ := case when jsonb_typeof(concept.economics) = 'object' then concept.economics else '{}'::jsonb end;
  cost := case when coalesce(econ->>'unit_cost', '') ~ num_re then nullif((econ->>'unit_cost')::numeric, 0) end;
  retail := case when coalesce(econ->>'msrp', '') ~ num_re then nullif((econ->>'msrp')::numeric, 0) end;
  if cost is not null and not (cost between 0 and 1000000) then cost := null; end if;
  -- Capped below what numeric(14,2) retail_value can hold at the qty cap.
  if retail is not null and not (retail between 0 and 100000) then retail := null; end if;

  insert into public.po_headers(company_entity_id, po_name, factory_id, order_date, req_ship_date,
      status, is_new_product_po, wholesale_triggered, created_by, generated_from_concept_id)
    values (co, public.generate_next_po_name(factory), factory, public.silo_business_today(),
      public.silo_business_today() + 45, 'Draft', true, false, auth.uid(), concept.id)
    returning id into po_id;

  bd := case when jsonb_typeof(concept.suggested_size_breakdown) = 'object'
             then concept.suggested_size_breakdown else '{}'::jsonb end;
  for size_row in
    select e.key, e.value, e.ord from jsonb_each(bd) with ordinality as e(key, value, ord) order by e.ord
  loop
    continue when jsonb_typeof(size_row.value) not in ('number', 'string')
               or coalesce(size_row.value #>> '{}', '') !~ num_re;
    qty := (size_row.value #>> '{}')::numeric;
    continue when qty <= 0;
    if qty > 1000000 then raise exception 'Quantity for size % is out of range', size_row.key using errcode = '22023'; end if;
    insert into public.po_lines(company_entity_id, po_header_id, source_concept_id, title_snapshot,
        product_type_snapshot, variant_title_snapshot, qty, unit_cost, retail_price, retail_value, line_notes)
      values (co, po_id, concept.id, concept.title, concept.suggested_product_type, size_row.key,
        qty, cost, retail, coalesce(qty * retail, 0), btrim('From concept: ' || coalesce(concept.title, '')));
    n := n + 1;
  end loop;

  if n = 0 then
    qty := case when concept.suggested_qty is null then 0 else concept.suggested_qty::numeric end;
    if qty < 0 or qty > 1000000 then qty := 0; end if;
    insert into public.po_lines(company_entity_id, po_header_id, source_concept_id, title_snapshot,
        product_type_snapshot, qty, unit_cost, retail_price, retail_value, line_notes)
      values (co, po_id, concept.id, concept.title, concept.suggested_product_type,
        qty, cost, retail, coalesce(qty * retail, 0), btrim('From concept: ' || coalesce(concept.title, '')));
    n := 1;
  end if;

  insert into public.po_concept_links(company_entity_id, po_header_id, concept_id, created_by)
    values (co, po_id, concept.id, auth.uid())
    on conflict do nothing;

  return jsonb_build_object('po_header_id', po_id, 'repeated', false, 'line_count', n);
end $$;

-- Supabase's default privileges grant EXECUTE on a new public function to
-- anon AND authenticated. The revoke is the boundary (20260904330000).
revoke all on function public.generate_po_from_concept(uuid) from public, anon, authenticated;
grant execute on function public.generate_po_from_concept(uuid) to authenticated;
