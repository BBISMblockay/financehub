-- Affiliate launch claims, the products a claimed launch asks for, and the
-- affiliate's own order list.
--
-- WHY. Blake, 2026-11-13, from a session in Affiliate Studio with his boss:
--   "coming up give option to flag ... like they claim the launch or release,
--    tells them products they can push etc ... which drives also to launch
--    container 'affiliates' tab that is going to be pushing the launch"
--   "showing orders in their portal" / "yes with drill down"
--
-- WHAT CHANGES.
--   1. affiliate_feed_items.parent_source_id -- a product shared UNDER a
--      launch. The portal lists these as "what to push" on the launch the
--      affiliate claimed; they are the launch's attached products
--      (launch_product_readiness), snapshotted exactly like every other feed
--      row, so nothing live is joined into an affiliate-facing read.
--   2. affiliate_launch_claims -- one row per affiliate per shared launch
--      they put their hand up for. It grants nothing: commission still comes
--      only from the code on the order. It is a signal, in both directions --
--      the affiliate gets the product list, the brand's launch drawer gets
--      an Affiliates tab naming who is pushing it.
--   3. affiliate_portal_feed: each item now carries its id, its claim state
--      and, for a launch, the products shared under it.
--   4. affiliate_portal_claim(token hash, item, claim) -- the portal's write.
--   5. affiliate_portal_orders(token hash, limit, offset) -- one row per
--      order the affiliate's code was credited on.
--
-- THE LINE ON ORDER DATA. 20261110086000 deliberately withheld the order
-- list: "the merchant's per-order customer data is not theirs to read".
-- Blake has now asked for the orders, so this opens exactly the columns that
-- are the affiliate's own side of the transaction -- the day, the order
-- number, what the order was worth, what they earned on it and whether it is
-- paid -- and nothing that identifies the customer. No name, no email, no
-- address, no line items. The read is built on affiliate_commission_ledger,
-- which holds only those fields; it never touches shopify_orders.

-- ── 1. A product shared under a launch ────────────────────────────────────
alter table public.affiliate_feed_items add column if not exists parent_source_id text;

alter table public.affiliate_feed_items drop constraint if exists affiliate_feed_items_parent_check;
alter table public.affiliate_feed_items add constraint affiliate_feed_items_parent_check check (
  parent_source_id is null or (length(btrim(parent_source_id)) between 1 and 100 and kind <> 'launch'));

create index if not exists affiliate_feed_items_parent
  on public.affiliate_feed_items (company_entity_id, program_id, parent_source_id)
  where parent_source_id is not null;

comment on column public.affiliate_feed_items.parent_source_id is
  'The source_id of the LAUNCH this item was shared under (affiliate_feed_items.source_id of kind launch). Set on the products a launch asks affiliates to push; NULL for anything shared on its own. A launch itself can never carry one. 20261113070000.';

-- ── 2. Claims ─────────────────────────────────────────────────────────────
create table if not exists public.affiliate_launch_claims (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  program_id        uuid not null references public.affiliate_programs(id) on delete cascade,
  affiliate_id      uuid not null references public.affiliates(id) on delete cascade,
  -- The shared row, not the launch: an affiliate can only claim something
  -- their program actually shared with them. Unsharing the launch withdraws
  -- the claims with it, which is the same thing the affiliate sees.
  feed_item_id      uuid not null references public.affiliate_feed_items(id) on delete cascade,
  -- Denormalised so the launch calendar can ask "who is pushing launch X"
  -- without reading the affiliate feed. It is launch_calendar.id as text,
  -- copied from the feed row.
  launch_source_id  text not null,
  claimed_at        timestamptz not null default now(),
  constraint affiliate_launch_claims_source check (length(btrim(launch_source_id)) between 1 and 100),
  constraint affiliate_launch_claims_once unique (feed_item_id, affiliate_id)
);

create index if not exists affiliate_launch_claims_launch
  on public.affiliate_launch_claims (company_entity_id, launch_source_id);
create index if not exists affiliate_launch_claims_affiliate
  on public.affiliate_launch_claims (company_entity_id, affiliate_id, claimed_at desc);

alter table public.affiliate_launch_claims enable row level security;

-- Read: any member of the company, because the launch calendar's Affiliates
-- tab is for whoever runs the launch, not only for the affiliate manager.
drop policy if exists affiliate_launch_claims_select on public.affiliate_launch_claims;
create policy affiliate_launch_claims_select on public.affiliate_launch_claims
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Write: only a program manager, and only to withdraw or correct one. The
-- claim itself is the affiliate's own act, made through the portal function
-- under the service role.
drop policy if exists affiliate_launch_claims_write on public.affiliate_launch_claims;
create policy affiliate_launch_claims_write on public.affiliate_launch_claims
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs())
  with check (
    company_entity_id = public.active_company_id()
    and public.can_manage_affiliate_programs()
    and exists (select 1 from public.affiliate_programs p
                 where p.id = program_id and p.company_entity_id = affiliate_launch_claims.company_entity_id));

revoke all on public.affiliate_launch_claims from anon;
grant select, insert, update, delete on public.affiliate_launch_claims to authenticated;

comment on table public.affiliate_launch_claims is
  'An affiliate put their hand up to push a launch their program shared with them. It grants nothing and pays nothing -- commission still comes only from the code on the order. It gives the affiliate the launch''s product list in their portal, and the brand the Affiliates tab on that launch. Written by the portal through the service role; a program manager may withdraw one. 20261113070000.';

-- ── 3. The portal's feed, with claims and the launch's products ───────────
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
               'id', f.id,
               'kind', f.kind, 'title', f.title, 'note', f.note, 'image_url', f.image_url,
               'product_path', f.product_path, 'event_on', f.event_on, 'shared_at', f.shared_at,
               -- A launch the affiliate has claimed, and what it asks them to
               -- push. Products shared UNDER a launch are not loose feed
               -- cards: they belong to that launch's row.
               'claimed', f.kind = 'launch' and exists (
                  select 1 from public.affiliate_launch_claims k
                   where k.feed_item_id = f.id and k.affiliate_id = v_tok.affiliate_id),
               'push', case when f.kind = 'launch' then (
                  select coalesce(jsonb_agg(jsonb_build_object(
                           'title', g.title, 'image_url', g.image_url, 'product_path', g.product_path)
                         order by g.title), '[]'::jsonb)
                    from public.affiliate_feed_items g
                   where g.company_entity_id = f.company_entity_id
                     and g.program_id = f.program_id
                     and g.parent_source_id = f.source_id) end)
             order by case f.kind when 'launch' then 0 when 'product' then 1 else 2 end,
                      f.event_on nulls last, f.shared_at desc), '[]'::jsonb)
        from (select * from public.affiliate_feed_items f
               where f.company_entity_id = v_tok.company_entity_id
                 and f.program_id = v_tok.program_id
                 -- A product shared under a launch is shown on that launch.
                 and f.parent_source_id is null
                 -- A launch that has passed drops out of "upcoming" by itself.
                 and not (f.kind = 'launch' and f.event_on is not null and f.event_on < v_today)
               order by f.shared_at desc
               limit 60) f));
end;
$$;

comment on function public.affiliate_portal_feed(text) is
  'For the affiliate-portal function: the feed of a valid portal link of an active or paused affiliate -- the items its program shared (each with its id, whether this affiliate claimed it, and for a launch the products shared under it), the store address, and the affiliate''s codes in effect today. NULL for anything else. Service role only. 20261110150000, claims 20261113070000.';

revoke all on function public.affiliate_portal_feed(text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_feed(text) to service_role;

-- ── 4. Claiming ───────────────────────────────────────────────────────────
create or replace function public.affiliate_portal_claim(p_token_hash text, p_feed_item_id uuid, p_claim boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok   record;
  v_item  record;
  v_today date;
begin
  -- Paused is deliberately excluded here, unlike the feed read: a paused
  -- affiliate may look, but putting their hand up for a launch would tell
  -- the brand's launch drawer something that is not true.
  select t.company_entity_id, t.program_id, t.affiliate_id into v_tok
    from public.affiliate_access_tokens t
    join public.affiliates a
      on a.id = t.affiliate_id and a.company_entity_id = t.company_entity_id and a.program_id = t.program_id
   where t.token_hash = p_token_hash
     and t.purpose = 'portal'
     and t.revoked_at is null
     and t.expires_at > now()
     and a.status = 'active';
  if not found then
    raise exception 'affiliate_portal_claim: link is not valid' using errcode = '42501';
  end if;

  v_today := (now() at time zone public.silo_company_timezone(v_tok.company_entity_id))::date;

  select f.id, f.source_id, f.event_on into v_item
    from public.affiliate_feed_items f
   where f.id = p_feed_item_id
     and f.company_entity_id = v_tok.company_entity_id
     and f.program_id = v_tok.program_id
     and f.kind = 'launch';
  if not found then
    raise exception 'affiliate_portal_claim: no such launch' using errcode = '42501';
  end if;

  if coalesce(p_claim, true) then
    -- A launch that has already run cannot be claimed; one already claimed
    -- stays as it was, with its original time.
    if v_item.event_on is not null and v_item.event_on < v_today then
      raise exception 'affiliate_portal_claim: that launch has already happened' using errcode = '22023';
    end if;
    insert into public.affiliate_launch_claims
      (company_entity_id, program_id, affiliate_id, feed_item_id, launch_source_id)
    values (v_tok.company_entity_id, v_tok.program_id, v_tok.affiliate_id, v_item.id, v_item.source_id)
    on conflict (feed_item_id, affiliate_id) do nothing;
  else
    delete from public.affiliate_launch_claims
     where feed_item_id = v_item.id and affiliate_id = v_tok.affiliate_id;
  end if;

  return jsonb_build_object('claimed', exists (
    select 1 from public.affiliate_launch_claims
     where feed_item_id = v_item.id and affiliate_id = v_tok.affiliate_id));
end;
$$;

comment on function public.affiliate_portal_claim(text, uuid, boolean) is
  'The portal''s claim on a shared launch: p_claim true puts this affiliate''s hand up, false takes it down. Active affiliates only, launches their own program shared, and never one that has already run. Returns the resulting state. Service role only. 20261113070000.';

revoke all on function public.affiliate_portal_claim(text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.affiliate_portal_claim(text, uuid, boolean) to service_role;

-- ── 5. The affiliate's orders ─────────────────────────────────────────────
create or replace function public.affiliate_portal_orders(p_token_hash text, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok   record;
  v_lim   integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_off   integer := greatest(coalesce(p_offset, 0), 0);
begin
  select t.company_entity_id, t.program_id, t.affiliate_id into v_tok
    from public.affiliate_access_tokens t
   where t.token_hash = p_token_hash
     and t.purpose = 'portal'
     and t.revoked_at is null
     and t.expires_at > now();
  if not found or v_tok.affiliate_id is null then
    raise exception 'affiliate_portal_orders: link is not valid' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'limit', v_lim,
    'offset', v_off,
    'total', (
      -- Orders, not entries, and not the adjustments that belong to no order
      -- (those are in the earnings totals, which this never restates).
      select count(distinct l.order_id)
        from public.affiliate_commission_ledger l
       where l.company_entity_id = v_tok.company_entity_id
         and l.affiliate_id = v_tok.affiliate_id
         and l.order_id is not null),
    'orders', (
      select coalesce(jsonb_agg(o order by o->>'sort_day' desc nulls last, o->>'order_id'), '[]'::jsonb)
        from (
          select jsonb_build_object(
                   'order_id', g.order_id,
                   -- The shop's own order number when the resolver recorded
                   -- one; never the internal id if a number exists.
                   'order_number', g.order_number,
                   'order_day', g.order_day,
                   'sort_day', g.order_day,
                   -- What the commission was a share of, as the ledger
                   -- recorded it at the time. NULL stays NULL: a fixed-fee
                   -- line has no basis, and that is not zero.
                   'order_value_cents', g.basis_cents,
                   'earned_cents', g.earned_cents,
                   'code', g.code,
                   'paid_cents', g.paid_cents,
                   'entries', g.entries) as o
            from (
              select l.order_id,
                     max(l.order_day) as order_day,
                     max(a.order_number) as order_number,
                     max(a.matched_code) as code,
                     max(l.basis_cents) filter (where l.kind = 'accrual') as basis_cents,
                     sum(l.amount_cents) as earned_cents,
                     coalesce(sum(l.amount_cents) filter (
                       where exists (select 1 from public.affiliate_payout_items i
                                      join public.affiliate_payouts po on po.id = i.payout_id and po.status = 'marked_paid'
                                     where i.ledger_entry_id = l.id)), 0) as paid_cents,
                     jsonb_agg(jsonb_build_object(
                       'kind', l.kind, 'amount_cents', l.amount_cents, 'memo', l.memo,
                       'rate_kind', l.rate_kind, 'rate_value', l.rate_value,
                       'basis_cents', l.basis_cents, 'created_at', l.created_at)
                       order by l.created_at) as entries
                from public.affiliate_commission_ledger l
                left join public.affiliate_attributions a on a.id = l.attribution_id
               where l.company_entity_id = v_tok.company_entity_id
                 and l.affiliate_id = v_tok.affiliate_id
                 and l.order_id is not null
               group by l.order_id
               order by max(l.order_day) desc nulls last, l.order_id
               limit v_lim offset v_off) g) q));
end;
$$;

comment on function public.affiliate_portal_orders(text, integer, integer) is
  'The affiliate''s own orders for their portal: one row per order their code was credited on -- day, the shop''s order number, what the order was worth, what they earned, how much of it is paid, and the ledger entries behind it. Built from affiliate_commission_ledger only; it carries no customer name, email, address or line items, which stay the merchant''s. Service role only. 20261113070000.';

revoke all on function public.affiliate_portal_orders(text, integer, integer) from public, anon, authenticated;
grant execute on function public.affiliate_portal_orders(text, integer, integer) to service_role;

select public.attach_stamp_company_entity_id_triggers();
-- Every affiliate reference needs its same-company twin, or RLS alone lets a
-- row point at another company's program when someone knows the id
-- (20261111181000). affiliate_launch_claims adds three such references.
select public.attach_affiliate_same_company_twins();
select public.refresh_chat_schema_catalog();
