-- Affiliate Studio: a launch shares itself with the affiliates.
--
-- Blake, 2026-11-13: "I shouldn't have to press so many buttons to move along
-- the flow." Sharing a drop was five clicks in the Share tab, every time, for
-- something the company had already decided to do. It becomes a setting:
-- affiliate_programs.auto_share_launches (ON), and the launch calendar itself
-- puts an upcoming launch -- and the products that launch asks affiliates to
-- push -- into the program's feed.
--
-- What it deliberately does NOT do:
--   * nothing LIVE is joined into an affiliate-facing read. The launch and its
--     products are SNAPSHOT rows in affiliate_feed_items, exactly the rows the
--     Share tab writes by hand, so unsharing still removes them and editing a
--     launch never rewrites what an affiliate was told.
--   * it never shares a launch that has already happened, and never a draft
--     program: only `active` ones.
--   * it shares a launch ONCE (when created, or when it first gets a date).
--     Unsharing it in the Share tab is final: editing the launch later does
--     not bring it back, and its products only ever join a launch card that
--     is still there.
--   * it never fails the write that triggered it. A company saving a launch
--     must not see an error because an affiliate program is misconfigured, so
--     every share is best-effort and a failure leaves the launch untouched.
--     The Share tab remains the way to share one by hand.
--
-- Idempotent: every insert is ON CONFLICT DO NOTHING against
-- affiliate_feed_items_once (program_id, kind, source_id), which is the same
-- key the Share tab uses, so a launch shared by hand is never duplicated and
-- a trigger that fires twice writes once.

alter table public.affiliate_programs
  add column if not exists auto_share_launches boolean not null default true;

comment on column public.affiliate_programs.auto_share_launches is
  'When true (the default), an upcoming launch on the launch calendar is shared with this program''s affiliates as soon as it is saved, with the products attached to it. Turning it off makes sharing a launch a manual step in the Share tab again. 20261113080000.';

-- One launch, shared with every active program of its own company that asks
-- for it. SECURITY DEFINER because the person saving a launch is not
-- necessarily someone who may write the affiliate feed -- the company and the
-- launch are the authority here, not the caller's own grants -- and the insert
-- is confined to that launch's own company by the join.
create or replace function public.affiliate_autoshare_launch(p_launch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The launch card itself.
  insert into public.affiliate_feed_items
    (company_entity_id, program_id, kind, source_id, title, image_url, product_path, event_on)
  select l.company_entity_id, p.id, 'launch', l.id::text,
         left(btrim(coalesce(nullif(btrim(l.title), ''), 'Launch')), 200),
         case when l.launch_image_url ~ '^https://[^\s"''<>]+$' and length(l.launch_image_url) <= 1000
              then l.launch_image_url end,
         -- The landing page as a path on the brand's own store; the portal
         -- turns it into the affiliate's own link. Anything that is not a
         -- plain path is left out rather than guessed at.
         nullif(
           (select case when pth ~ '^/[A-Za-z0-9/_.~%-]*$' and pth !~ '^//' and length(pth) <= 300 then pth end
              from (select regexp_replace(regexp_replace(coalesce(l.landing_page_url, ''), '^https?://[^/]*', ''), '[?#].*$', '') as pth) q),
           ''),
         l.launch_date
    from public.launch_calendar l
    join public.affiliate_programs p
      on p.company_entity_id = l.company_entity_id
     and p.status = 'active'
     and p.auto_share_launches
   where l.id = p_launch_id
     and l.launch_date is not null
     and l.launch_date >= current_date
  on conflict (program_id, kind, source_id) do nothing;

  perform public.affiliate_autoshare_launch_products(p_launch_id);
end;
$$;

-- What that launch asks them to push. One row per distinct product title,
-- carrying parent_source_id, so the portal shows them under the launch and
-- unsharing the launch takes them with it. Never writes the launch card
-- itself: a product added to a launch someone unshared must not share it
-- again, so this only ever adds under a card that is still there.
create or replace function public.affiliate_autoshare_launch_products(p_launch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.affiliate_feed_items
    (company_entity_id, program_id, kind, source_id, title, parent_source_id)
  select l.company_entity_id, p.id, 'product',
         left('launch:' || l.id::text || ':' || t.title, 100), t.title, l.id::text
    from public.launch_calendar l
    join public.affiliate_programs p
      on p.company_entity_id = l.company_entity_id
     and p.status = 'active'
     and p.auto_share_launches
    join lateral (
      select distinct left(btrim(r.product_title), 200) as title
        from public.launch_product_readiness r
       where r.launch_id = l.id
         and r.company_entity_id = l.company_entity_id
         and btrim(coalesce(r.product_title, '')) <> ''
       limit 50
    ) t on true
   where l.id = p_launch_id
     and l.launch_date is not null
     and l.launch_date >= current_date
     -- Only under a launch this program actually has: a product with no
     -- launch card would be an orphan in the feed.
     and exists (select 1 from public.affiliate_feed_items f
                  where f.program_id = p.id and f.kind = 'launch' and f.source_id = l.id::text)
  on conflict (program_id, kind, source_id) do nothing;
end;
$$;

comment on function public.affiliate_autoshare_launch(uuid) is
  'Shares one launch, and the products attached to it, with every active affiliate program of its own company that has auto_share_launches on. Snapshot rows in affiliate_feed_items, idempotent, upcoming launches only. Called by the triggers on launch_calendar and launch_product_readiness. 20261113080000.';

comment on function public.affiliate_autoshare_launch_products(uuid) is
  'Adds the products attached to one launch under that launch''s card in each program that already has the card. Never shares the launch itself. 20261113080000.';

revoke all on function public.affiliate_autoshare_launch(uuid) from public, anon, authenticated;
revoke all on function public.affiliate_autoshare_launch_products(uuid) from public, anon, authenticated;

-- The triggers. Each swallows its own failure: a launch, or a product line on
-- one, must save whatever state an affiliate program is in.
create or replace function public.affiliate_autoshare_launch_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A launch is shared once: when it is created, or when a launch saved
  -- without a date first gets one. Any later edit leaves the feed alone, so a
  -- launch someone unshared by hand never comes back because its title or
  -- date was touched.
  if tg_op = 'UPDATE' and old.launch_date is not null then
    return null;
  end if;
  begin
    perform public.affiliate_autoshare_launch(new.id);
  exception when others then
    raise warning 'affiliate_autoshare_launch skipped for launch %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

create or replace function public.affiliate_autoshare_launch_product_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform public.affiliate_autoshare_launch_products(new.launch_id);
  exception when others then
    raise warning 'affiliate_autoshare_launch skipped for launch %: %', new.launch_id, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function public.affiliate_autoshare_launch_trg() from public, anon, authenticated;
revoke all on function public.affiliate_autoshare_launch_product_trg() from public, anon, authenticated;

drop trigger if exists trg_affiliate_autoshare_launch on public.launch_calendar;
create trigger trg_affiliate_autoshare_launch
  after insert or update of launch_date
  on public.launch_calendar
  for each row execute function public.affiliate_autoshare_launch_trg();

drop trigger if exists trg_affiliate_autoshare_launch_product on public.launch_product_readiness;
create trigger trg_affiliate_autoshare_launch_product
  after insert or update of product_title
  on public.launch_product_readiness
  for each row execute function public.affiliate_autoshare_launch_product_trg();

select public.attach_stamp_company_entity_id_triggers();
select public.attach_affiliate_same_company_twins();
select public.refresh_chat_schema_catalog();
