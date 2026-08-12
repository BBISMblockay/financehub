-- Redo returns integration, phase 2: parse the per-item detail that phase 1
-- (20260812120000_redo_returns_integration.sql) left in redo_returns.raw --
-- SKU, return reason, grade/outcome, and exchange item detail are exactly
-- the fields a returns-analytics view needs (top return reasons, which SKUs
-- come back most) and none of it was queryable without picking apart jsonb.
-- Also promotes the returning customer's email/name onto redo_returns
-- itself (single value per return, unlike items -- no child table needed).

alter table public.redo_returns
  add column if not exists customer_email text,
  add column if not exists customer_name text;

create index if not exists idx_redo_returns_company_customer_email
  on public.redo_returns (company_entity_id, customer_email);

-- One row per Redo return line item. Delete+reinsert per return on every
-- webhook event (see redo-webhook), not upserted item-by-item, so removed
-- items don't linger -- return items are set once at creation and rarely
-- change count afterward, so this is cheap and always exactly matches the
-- latest event's item list.
create table if not exists public.redo_return_items (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  return_id uuid not null references public.redo_returns(id) on delete cascade,

  redo_item_id text not null,
  sku text,
  upc text,
  product_id text,
  variant_id text,
  product_name text,
  variant_name text,

  quantity integer,
  status text,
  reason text,
  reason_code text,
  reasons text[] not null default '{}',
  reason_codes text[] not null default '{}',
  customer_comment text,
  grade text,
  outcome text,
  green_return boolean not null default false,

  refund_amount numeric(12,2),
  refund_type text,
  product_value numeric(12,2),

  is_exchange boolean not null default false,
  exchange_product_name text,
  exchange_variant_name text,
  exchange_quantity integer,

  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_redo_return_items_return_item
  on public.redo_return_items (return_id, redo_item_id);
create index if not exists idx_redo_return_items_company_sku
  on public.redo_return_items (company_entity_id, sku);
create index if not exists idx_redo_return_items_company_reason_code
  on public.redo_return_items (company_entity_id, reason_code);

alter table public.redo_return_items enable row level security;
revoke all on public.redo_return_items from anon;

-- Read-only to the app, same trust model as redo_returns -- only the
-- service-role webhook edge function writes this table.
drop policy if exists redo_return_items_active_select on public.redo_return_items;
create policy redo_return_items_active_select
  on public.redo_return_items for select
  to authenticated
  using (company_entity_id = public.active_company_id());
