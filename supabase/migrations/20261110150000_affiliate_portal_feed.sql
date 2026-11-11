-- Affiliate portal feed, and affiliate links that carry the affiliate's code.
--
-- WHY. Blake, 2026-11-10: "the affiliate portal: should show upcoming launch
-- calendar and products for a 'feed' along with some recent marketing ads
-- from ad studio". On the decision card he chose "Brand picks what to share":
-- nothing reaches an affiliate unless someone who manages the program shares
-- it. And on links: "wouldn't want to double count code and link ... but i
-- think affiliate links are desired" -- so every link the portal offers
-- carries the affiliate's own discount code (Shopify's /discount/CODE
-- address applies it at checkout), and commission still comes ONLY from the
-- code on the order. A link never adds a second credit.
--
-- WHAT CHANGES.
--   1. affiliate_programs.store_url: the brand's storefront address (host
--      only), which affiliate links open. Optional; without it the
--      program's Shopify domain is used.
--   2. affiliate_feed_items: what a program shares with its affiliates.
--      Each row is a SNAPSHOT of just the fields an affiliate may see
--      (title, a short note, an image, a date, a store page path), taken
--      when it is shared -- never a live join to the launch calendar,
--      products or Ad Studio, whose other columns (budgets, notes, copy
--      rules) are the brand's own. Read by the company; written only by
--      someone who may manage affiliate programs, for a program of the
--      active company.
--   3. affiliate_portal_feed(token hash): service role only, for the
--      affiliate-portal function. For a valid PORTAL link of an active or
--      paused affiliate it returns the shared items, the store address and
--      the affiliate's codes in effect today (company calendar); the
--      function builds the links. Anything else returns nothing.
-- Nothing is backfilled. A program that shares nothing shows no feed.

-- ── 1. Store address ──────────────────────────────────────────────────────
alter table public.affiliate_programs add column if not exists store_url text;

alter table public.affiliate_programs drop constraint if exists affiliate_programs_store_url_check;
alter table public.affiliate_programs add constraint affiliate_programs_store_url_check check (
  store_url is null or (
    length(store_url) <= 200
    and store_url ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'));

comment on column public.affiliate_programs.store_url is
  'The brand''s storefront address, https and host only (e.g. https://shop.example.com). Affiliate links open it with the affiliate''s discount code applied. NULL: the program company''s Shopify domain is used. 20261110150000.';

-- ── 2. Shared items ───────────────────────────────────────────────────────
create table if not exists public.affiliate_feed_items (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  program_id        uuid not null references public.affiliate_programs(id) on delete cascade,
  kind              text not null,
  source_id         text not null,
  title             text not null,
  note              text,
  image_url         text,
  product_path      text,
  event_on          date,
  shared_by         uuid default auth.uid(),
  shared_at         timestamptz not null default now(),
  constraint affiliate_feed_items_kind check (kind in ('launch', 'product', 'ad')),
  constraint affiliate_feed_items_source check (length(btrim(source_id)) between 1 and 100),
  constraint affiliate_feed_items_title check (length(btrim(title)) between 1 and 200),
  constraint affiliate_feed_items_note check (note is null or length(note) <= 1000),
  -- An image an affiliate's browser loads: https, and nothing that could
  -- break out of an attribute.
  constraint affiliate_feed_items_image check (image_url is null or (
    length(image_url) <= 1000 and image_url ~ '^https://[^\s"''<>]+$')),
  -- A page of the brand's own store, as a path: the link is built on the
  -- program's store address, so a feed item can never send an affiliate's
  -- audience to another site.
  constraint affiliate_feed_items_path check (product_path is null or (
    length(product_path) <= 300 and product_path ~ '^/[A-Za-z0-9/_.~%-]*$' and product_path !~ '^//')),
  constraint affiliate_feed_items_once unique (program_id, kind, source_id)
);

create index if not exists affiliate_feed_items_program
  on public.affiliate_feed_items (company_entity_id, program_id, shared_at desc);

alter table public.affiliate_feed_items enable row level security;

drop policy if exists affiliate_feed_items_select on public.affiliate_feed_items;
create policy affiliate_feed_items_select on public.affiliate_feed_items
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists affiliate_feed_items_write on public.affiliate_feed_items;
create policy affiliate_feed_items_write on public.affiliate_feed_items
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs())
  with check (
    company_entity_id = public.active_company_id()
    and public.can_manage_affiliate_programs()
    and exists (select 1 from public.affiliate_programs p
                 where p.id = program_id and p.company_entity_id = affiliate_feed_items.company_entity_id));

revoke all on public.affiliate_feed_items from anon;
grant select, insert, update, delete on public.affiliate_feed_items to authenticated;

comment on table public.affiliate_feed_items is
  'What an affiliate program shares with its affiliates in their portal: upcoming launches, products and ads the brand picked. Each row is a snapshot of only the fields an affiliate may see, taken when shared; the portal builds each product link on the program''s store address with the affiliate''s own discount code, so commission still comes only from the code. 20261110150000.';

-- ── 3. The portal's read ──────────────────────────────────────────────────
create or replace function public.affiliate_portal_feed(p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok   record;
  v_today date;
  v_store text;
begin
  select t.company_entity_id, t.program_id, t.affiliate_id into v_tok
    from public.affiliate_access_tokens t
    join public.affiliates a
      on a.id = t.affiliate_id and a.company_entity_id = t.company_entity_id and a.program_id = t.program_id
   where t.token_hash = p_token_hash
     and t.purpose = 'portal'
     and t.revoked_at is null
     and t.expires_at > now()
     and a.status in ('active', 'paused');
  if not found then
    return null;
  end if;

  v_today := (now() at time zone public.silo_company_timezone(v_tok.company_entity_id))::date;

  select coalesce(p.store_url,
           (select 'https://' || lower(sc.shop_domain)
              from public.shopify_connections sc
             where sc.company_entity_id = v_tok.company_entity_id and coalesce(sc.is_active, true)
               and sc.shop_domain ~ '^[A-Za-z0-9.-]+$'
             order by sc.created_at limit 1))
    into v_store
    from public.affiliate_programs p
   where p.id = v_tok.program_id and p.company_entity_id = v_tok.company_entity_id;

  return jsonb_build_object(
    'store_url', v_store,
    'codes', (
      select coalesce(jsonb_agg(c.code order by c.starts_on desc, c.code), '[]'::jsonb)
        from public.affiliate_codes c
       where c.company_entity_id = v_tok.company_entity_id
         and c.affiliate_id = v_tok.affiliate_id
         and c.status = 'active'
         and c.starts_on <= v_today
         and (c.ends_on is null or c.ends_on >= v_today)),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'kind', f.kind, 'title', f.title, 'note', f.note, 'image_url', f.image_url,
               'product_path', f.product_path, 'event_on', f.event_on, 'shared_at', f.shared_at)
             order by case f.kind when 'launch' then 0 when 'product' then 1 else 2 end,
                      f.event_on nulls last, f.shared_at desc), '[]'::jsonb)
        from (select * from public.affiliate_feed_items f
               where f.company_entity_id = v_tok.company_entity_id
                 and f.program_id = v_tok.program_id
                 -- A launch that has passed drops out of "upcoming" by itself.
                 and not (f.kind = 'launch' and f.event_on is not null and f.event_on < v_today)
               order by f.shared_at desc
               limit 60) f));
end;
$$;

comment on function public.affiliate_portal_feed(text) is
  'For the affiliate-portal function: the feed of a valid portal link of an active or paused affiliate -- the items its program shared, the store address, and the affiliate''s codes in effect today. NULL for anything else. Service role only. 20261110150000.';

revoke all on function public.affiliate_portal_feed(text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_feed(text) to service_role;

select public.attach_stamp_company_entity_id_triggers();
select public.refresh_chat_schema_catalog();
