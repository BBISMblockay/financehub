// Shared stand-in schema for the Product Studio Ready-for-PO database tests
// (PGlite suite and the real-PostgreSQL concurrency check). Minimal columns;
// RLS is not modelled -- every writer under test is SECURITY DEFINER.
export function schemaSql({ A, B, ADMIN, VIEWER, FACTORY, FOREIGN_FACTORY }) {
  return `
 create role anon; create role authenticated;
 create schema auth; grant usage on schema public, auth to authenticated, anon;
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 create table public.entities(id uuid primary key);
 insert into public.entities values('${A}'),('${B}');
 create table public.profiles(id uuid primary key, role text);
 insert into public.profiles values('${ADMIN}','admin'),('${VIEWER}','viewer');
 create function public.active_company_id() returns uuid language sql stable as $$ select nullif(current_setting('test.company',true),'')::uuid $$;
 create function public.po_builder_can_write() returns boolean language sql stable security definer as $$ select exists(select 1 from public.profiles where id=auth.uid() and role='admin') $$;
 create function public.silo_business_today() returns date language sql stable as $$ select date '2026-09-30' $$;
 create function public.silo_business_yesterday() returns date language sql stable as $$ select date '2026-09-29' $$;
 create function public.silo_business_timezone() returns text language sql stable as $$ select 'UTC'::text $$;
 create function public.attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
 create table public.factories(id uuid primary key, company_entity_id uuid, factory_name text);
 create table public.product_concepts(id uuid primary key default gen_random_uuid(), company_entity_id uuid, title text, status text not null default 'draft',
   phase text, concept_summary text, suggested_factory_id uuid, parent_concept_id uuid references public.product_concepts(id),
   suggested_qty integer, suggested_product_type text, suggested_size_breakdown jsonb, economics jsonb,
   reference_image_urls text[], evidence_strength text, created_at timestamptz default now(), updated_at timestamptz default '2026-09-30T00:00:00Z');
 create table public.products_master(id uuid primary key, company_entity_id uuid, sku text, product_title text, product_type text, variant_title text, updated_at timestamptz default now());
 create sequence public.po_seq;
 create function public.generate_next_po_name(uuid) returns text language sql as $$ select 'PO-'||nextval('public.po_seq') $$;
 create table public.po_headers(id uuid primary key default gen_random_uuid(), company_entity_id uuid, po_name text not null default 'MANUAL', factory_id uuid,
   order_date date, req_ship_date date, status text not null default 'Draft', is_new_product_po boolean, wholesale_triggered boolean,
   created_by uuid, internal_notes text, expected_arrival_date date, created_at timestamptz default now());
 create table public.po_lines(id uuid primary key default gen_random_uuid(), company_entity_id uuid, po_header_id uuid references public.po_headers on delete cascade,
   product_master_id uuid, source_concept_id uuid, title_snapshot text, product_type_snapshot text, variant_title_snapshot text, sku_snapshot text,
   qty integer not null check(qty>=0), unit_cost numeric, retail_price numeric, retail_value numeric, line_notes text);
 create table public.po_concept_links(id uuid primary key default gen_random_uuid(), company_entity_id uuid, po_header_id uuid references public.po_headers on delete cascade,
   concept_id uuid references public.product_concepts, created_by uuid, created_at timestamptz default now(), unique(po_header_id, concept_id));
 create table public.launch_calendar(id uuid primary key default gen_random_uuid(), company_entity_id uuid, title text not null, launch_date date not null,
   time_zone text, status text, created_by uuid, linked_po_id uuid, linked_product_id uuid, source_concept_id uuid, design_intent text, product_callouts text,
   marketing_angle text, audience text, special_callouts text, copy_dos text, copy_donts text, creative_dos text, creative_donts text, notes text,
   products_unknown_at timestamptz, products_unknown_note text);
 create table public.launch_product_readiness(id uuid primary key default gen_random_uuid(), company_entity_id uuid, launch_id uuid, product_title text, product_type text, created_by uuid, notes text);
 create table public.sales_by_day(company_entity_id uuid, sku text, day_date date, total_quantity_sold integer, product_name text);
 create table public.inventory_on_hand_current_v(company_entity_id uuid, variant_sku text, total_available_quantity integer, snapshot_at timestamptz);
 create table public.shopify_product_skus(company_entity_id uuid, shop_domain text, shopify_product_id text, shopify_variant_id text, sku text, product_title text, variant_title text, last_seen_at timestamptz default now());
 -- Emulate PostgREST reach: the browser can write these tables directly
 -- (RLS is not modelled; the guard triggers are what is under test).
 grant select, insert, update, delete on public.po_headers, public.po_lines, public.po_concept_links, public.product_concepts to authenticated;
 grant select on all tables in schema public to authenticated;
 alter default privileges in schema public grant all on tables to authenticated, anon;
 alter default privileges in schema public grant execute on functions to authenticated, anon;
 insert into public.factories values('${FACTORY}','${A}','Factory A'),('${FOREIGN_FACTORY}','${B}','Factory B');
`;
}
