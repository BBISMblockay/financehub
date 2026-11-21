-- Affiliate Studio: per-program staff scope, and a per-creator audience on a
-- share. Both are additive and both mean "everything", the behaviour today,
-- when left null -- so applying this changes nobody's access until somebody
-- deliberately narrows it (Blake 2026-11-21, "want all gaps closed").
--
-- Two gaps this closes:
--   1. `affiliate_program_managers` was keyed by COMPANY only, so a program
--      manager could manage every program the company had.
--   2. `affiliate_feed_items` had `program_id` and no audience, so every
--      active affiliate in a program saw every share in it.

begin;

-- ── 1. A manager row may name one program ────────────────────────────────
alter table public.affiliate_program_managers
  add column if not exists program_id uuid references public.affiliate_programs(id) on delete cascade;

-- A grant must not be able to point at another company's program, and nor
-- can an audience row below. Both twin keys are attached in section 4 by the
-- function every affiliate migration calls (20261111181000), rather than by
-- hand, so their names match what verify looks for.

-- The old rule was one row per person per company, which would make a second
-- grant impossible and so leave nobody able to be scoped to two of three
-- programs. The two partial indexes below cover everything it covered: one
-- row per person per program, plus one unscoped row per person.
drop index if exists public.affiliate_program_managers_identity;

-- A partial unique index is how "program_id is null" gets a rule of its own.
create unique index if not exists affiliate_program_managers_user_program_uq
  on public.affiliate_program_managers (company_entity_id, user_id, program_id)
  where program_id is not null;
create unique index if not exists affiliate_program_managers_user_all_uq
  on public.affiliate_program_managers (company_entity_id, user_id)
  where program_id is null;
create index if not exists affiliate_program_managers_program_idx
  on public.affiliate_program_managers (company_entity_id, program_id)
  where program_id is not null;

comment on column public.affiliate_program_managers.program_id is
  'The one program this grant covers. NULL means every program in the company, which is what every grant made before 2026-11-21 means.';

-- ── 2. Who is scoped, and to what ────────────────────────────────────────
-- A person is SCOPED when every grant they hold names a program. Holding one
-- unscoped grant, or being an exec or owner, means the whole company as
-- before. Nobody is scoped until somebody is given a program-only grant, so
-- this function returns false for every user on the day it is applied.
create or replace function public.affiliate_manager_scoped()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select not public.is_exec_or_owner()
     and exists (
       select 1 from public.affiliate_program_managers g
        join public.profiles p on p.id = g.user_id
       where g.user_id = auth.uid()
         and g.company_entity_id = public.active_company_id()
         and p.is_active = true
         and g.program_id is not null)
     and not exists (
       select 1 from public.affiliate_program_managers g
       where g.user_id = auth.uid()
         and g.company_entity_id = public.active_company_id()
         and g.program_id is null);
$$;

-- May this user see this program at all? Everyone who is not scoped sees
-- every program, which is today's answer for everyone.
create or replace function public.affiliate_visible_program(p_program uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select not public.affiliate_manager_scoped()
      or exists (
        select 1 from public.affiliate_program_managers g
        where g.user_id = auth.uid()
          and g.company_entity_id = public.active_company_id()
          and g.program_id = p_program);
$$;

-- The write gate for one program: the company-wide gate, narrowed.
create or replace function public.can_manage_affiliate_program(p_program uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.can_manage_affiliate_programs()
     and public.affiliate_visible_program(p_program);
$$;

-- EXECUTE on a new function is granted to PUBLIC, which anon inherits, so a
-- revoke naming only anon leaves it callable. Revoke from PUBLIC and grant
-- back to authenticated, which needs these: the policies below call them as
-- the signed-in caller.
revoke all on function public.affiliate_manager_scoped() from public, anon;
revoke all on function public.affiliate_visible_program(uuid) from public, anon;
revoke all on function public.can_manage_affiliate_program(uuid) from public, anon;
grant execute on function public.affiliate_manager_scoped() to authenticated;
grant execute on function public.affiliate_visible_program(uuid) to authenticated;
grant execute on function public.can_manage_affiliate_program(uuid) to authenticated;

comment on function public.can_manage_affiliate_programs() is
  'May this user manage AT LEAST ONE affiliate program in the active company. Unchanged, and still the right gate for a table with no program to point at. Where a row names a program, use can_manage_affiliate_program(program_id).';

commit;

-- ── 3. The policies that have a program to point at ──────────────────────
-- Fourteen tables carry `program_id`; five others (payout_accounts,
-- payout_items, payout_sends, programs' own managers, prospect_observations)
-- reach a program only through a parent row or not at all, and keep the
-- company-wide gate. Each policy below is the live definition read from
-- pg_policy on 2026-11-21 with the program clause added -- nothing else in
-- them is changed.
begin;

-- Reads: a scoped manager sees their own programs. Everyone else, which is
-- everyone today, sees the company as before.
drop policy if exists affiliate_codes_select on public.affiliate_codes;
create policy affiliate_codes_select on public.affiliate_codes for select to authenticated
  using (company_entity_id = public.active_company_id() and public.affiliate_visible_program(program_id));

drop policy if exists affiliate_commission_periods_select on public.affiliate_commission_periods;
create policy affiliate_commission_periods_select on public.affiliate_commission_periods for select to authenticated
  using (company_entity_id = public.active_company_id() and public.affiliate_visible_program(program_id));

drop policy if exists affiliate_content_submissions_select on public.affiliate_content_submissions;
create policy affiliate_content_submissions_select on public.affiliate_content_submissions for select to authenticated
  using (company_entity_id = public.active_company_id() and public.affiliate_visible_program(program_id));

drop policy if exists affiliate_feed_items_select on public.affiliate_feed_items;
create policy affiliate_feed_items_select on public.affiliate_feed_items for select to authenticated
  using (company_entity_id = public.active_company_id() and public.affiliate_visible_program(program_id));

drop policy if exists affiliate_launch_claims_select on public.affiliate_launch_claims;
create policy affiliate_launch_claims_select on public.affiliate_launch_claims for select to authenticated
  using (company_entity_id = public.active_company_id() and public.affiliate_visible_program(program_id));

drop policy if exists affiliate_links_select on public.affiliate_links;
create policy affiliate_links_select on public.affiliate_links for select to authenticated
  using (company_entity_id = public.active_company_id() and public.affiliate_visible_program(program_id));

drop policy if exists affiliate_outreach_batches_select on public.affiliate_outreach_batches;
create policy affiliate_outreach_batches_select on public.affiliate_outreach_batches for select to authenticated
  using (company_entity_id = public.active_company_id() and public.affiliate_visible_program(program_id));

drop policy if exists affiliate_outreach_drafts_select on public.affiliate_outreach_drafts;
create policy affiliate_outreach_drafts_select on public.affiliate_outreach_drafts for select to authenticated
  using (company_entity_id = public.active_company_id() and public.affiliate_visible_program(program_id));

drop policy if exists affiliate_programs_select on public.affiliate_programs;
create policy affiliate_programs_select on public.affiliate_programs for select to authenticated
  using (company_entity_id = public.active_company_id() and public.affiliate_visible_program(id));

drop policy if exists affiliate_prospect_sources_select on public.affiliate_prospect_sources;
create policy affiliate_prospect_sources_select on public.affiliate_prospect_sources for select to authenticated
  using (company_entity_id = public.active_company_id() and public.affiliate_visible_program(program_id));

drop policy if exists affiliate_prospects_select on public.affiliate_prospects;
create policy affiliate_prospects_select on public.affiliate_prospects for select to authenticated
  using (company_entity_id = public.active_company_id() and public.affiliate_visible_program(program_id));

drop policy if exists affiliate_seed_claims_select on public.affiliate_seed_claims;
create policy affiliate_seed_claims_select on public.affiliate_seed_claims for select to authenticated
  using (company_entity_id = public.active_company_id() and public.affiliate_visible_program(program_id));

drop policy if exists affiliate_suppressions_select on public.affiliate_suppressions;
create policy affiliate_suppressions_select on public.affiliate_suppressions for select to authenticated
  using (company_entity_id = public.active_company_id() and public.affiliate_visible_program(program_id));

drop policy if exists affiliates_select on public.affiliates;
create policy affiliates_select on public.affiliates for select to authenticated
  using (company_entity_id = public.active_company_id() and public.affiliate_visible_program(program_id));

-- The two reads that were already gated keep their money gate as well.
drop policy if exists affiliate_commission_ledger_select on public.affiliate_commission_ledger;
create policy affiliate_commission_ledger_select on public.affiliate_commission_ledger for select to authenticated
  using (company_entity_id = public.active_company_id()
         and (public.can_manage_affiliate_programs() or public.can_approve_affiliate_commissions())
         and public.affiliate_visible_program(program_id));

drop policy if exists affiliate_payouts_select on public.affiliate_payouts;
create policy affiliate_payouts_select on public.affiliate_payouts for select to authenticated
  using (company_entity_id = public.active_company_id()
         and (public.can_manage_affiliate_programs() or public.can_approve_affiliate_commissions())
         and public.affiliate_visible_program(program_id));

-- Writes.
drop policy if exists affiliate_codes_write on public.affiliate_codes;
create policy affiliate_codes_write on public.affiliate_codes for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id))
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id));

drop policy if exists affiliate_commission_periods_write on public.affiliate_commission_periods;
create policy affiliate_commission_periods_write on public.affiliate_commission_periods for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id))
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id));

drop policy if exists affiliate_feed_items_write on public.affiliate_feed_items;
create policy affiliate_feed_items_write on public.affiliate_feed_items for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id))
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id)
              and exists (select 1 from public.affiliate_programs p
                           where p.id = affiliate_feed_items.program_id
                             and p.company_entity_id = affiliate_feed_items.company_entity_id));

drop policy if exists affiliate_launch_claims_write on public.affiliate_launch_claims;
create policy affiliate_launch_claims_write on public.affiliate_launch_claims for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id))
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id)
              and exists (select 1 from public.affiliate_programs p
                           where p.id = affiliate_launch_claims.program_id
                             and p.company_entity_id = affiliate_launch_claims.company_entity_id));

drop policy if exists affiliate_links_write on public.affiliate_links;
create policy affiliate_links_write on public.affiliate_links for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id))
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id));

drop policy if exists affiliate_outreach_batches_write on public.affiliate_outreach_batches;
create policy affiliate_outreach_batches_write on public.affiliate_outreach_batches for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id))
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id));

drop policy if exists affiliate_outreach_drafts_write on public.affiliate_outreach_drafts;
create policy affiliate_outreach_drafts_write on public.affiliate_outreach_drafts for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id))
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id));

drop policy if exists affiliate_programs_write on public.affiliate_programs;
create policy affiliate_programs_write on public.affiliate_programs for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(id))
  -- A NEW program has no grant naming it yet, so a scoped manager cannot
  -- create one. That is the point of being scoped.
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(id));

drop policy if exists affiliate_prospect_sources_write on public.affiliate_prospect_sources;
create policy affiliate_prospect_sources_write on public.affiliate_prospect_sources for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id))
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id));

drop policy if exists affiliate_prospects_write on public.affiliate_prospects;
create policy affiliate_prospects_write on public.affiliate_prospects for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id))
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id));

drop policy if exists affiliate_suppressions_delete on public.affiliate_suppressions;
create policy affiliate_suppressions_delete on public.affiliate_suppressions for delete to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id));

drop policy if exists affiliates_write on public.affiliates;
create policy affiliates_write on public.affiliates for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id))
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_program(program_id));

commit;

-- ── 4. A share may name who it is for ────────────────────────────────────
-- No rows means the whole program, which is every share that exists today.
-- A table rather than a column, so a share can name several creators without
-- being rewritten.
begin;

create table if not exists public.affiliate_feed_audience (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  feed_item_id uuid not null references public.affiliate_feed_items(id) on delete cascade,
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- The same-company twins for every reference this migration adds: the
-- audience's two, and the program a manager grant names.
select public.attach_affiliate_same_company_twins();

create unique index if not exists affiliate_feed_audience_uq
  on public.affiliate_feed_audience (feed_item_id, affiliate_id);
create index if not exists affiliate_feed_audience_aff_idx
  on public.affiliate_feed_audience (company_entity_id, affiliate_id);

-- A new table is granted to anon and authenticated by Supabase's default
-- privileges, and RLS on its own does not undo that. Staff read and write it
-- through the policies below; the portal reads it only inside
-- affiliate_portal_feed, which is SECURITY DEFINER.
revoke all on public.affiliate_feed_audience from anon, authenticated;
grant select, insert, update, delete on public.affiliate_feed_audience to authenticated;
grant all on public.affiliate_feed_audience to service_role;

comment on table public.affiliate_feed_audience is
  'Who a share is for. NO rows for a feed item means everyone in its program, which is what every share made before 2026-11-21 means. Rows mean only those creators.';

alter table public.affiliate_feed_audience enable row level security;

drop policy if exists affiliate_feed_audience_select on public.affiliate_feed_audience;
create policy affiliate_feed_audience_select on public.affiliate_feed_audience for select to authenticated
  using (company_entity_id = public.active_company_id()
         and exists (select 1 from public.affiliate_feed_items f
                      where f.id = affiliate_feed_audience.feed_item_id
                        and public.affiliate_visible_program(f.program_id)));

drop policy if exists affiliate_feed_audience_write on public.affiliate_feed_audience;
create policy affiliate_feed_audience_write on public.affiliate_feed_audience for all to authenticated
  using (company_entity_id = public.active_company_id()
         and exists (select 1 from public.affiliate_feed_items f
                      where f.id = affiliate_feed_audience.feed_item_id
                        and public.can_manage_affiliate_program(f.program_id)))
  with check (company_entity_id = public.active_company_id()
         and exists (select 1 from public.affiliate_feed_items f
                      where f.id = affiliate_feed_audience.feed_item_id
                        and public.can_manage_affiliate_program(f.program_id))
         -- The creator named has to be in the program the share belongs to.
         and exists (select 1 from public.affiliate_feed_items f
                       join public.affiliates a on a.id = affiliate_feed_audience.affiliate_id
                      where f.id = affiliate_feed_audience.feed_item_id
                        and a.program_id = f.program_id
                        and a.company_entity_id = affiliate_feed_audience.company_entity_id));

-- Is this share for this creator? No audience rows means yes, for everyone in
-- the program -- so an unapplied audience, or a read that errors, shows the
-- share rather than hiding it.
create or replace function public.affiliate_feed_item_for(p_item uuid, p_affiliate uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select not exists (select 1 from public.affiliate_feed_audience x where x.feed_item_id = p_item)
      or exists (select 1 from public.affiliate_feed_audience x
                  where x.feed_item_id = p_item and x.affiliate_id = p_affiliate);
$$;
-- Only affiliate_portal_feed calls this, and that is SECURITY DEFINER, so no
-- client role needs it. PUBLIC is named because that is where the default
-- EXECUTE grant lives.
revoke all on function public.affiliate_feed_item_for(uuid, uuid) from public, anon, authenticated;

select public.attach_stamp_company_entity_id_triggers();

commit;

-- ── 5. The portal only shows a creator what is for them ──────────────────
-- The live definition read from the database on 2026-11-21, with one clause
-- added in two places: the feed itself, and the products shown under a
-- launch. Everything else is byte-for-byte what was there.
begin;

create or replace function public.affiliate_portal_feed(p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
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

  -- One rule for where an affiliate link opens, shared with the code tools:
  -- the program's own address, else the company's Shopify domain ONLY when
  -- there is exactly one active store, else NULL. Never picked here.
  v_store := public.affiliate_program_store_url(v_tok.company_entity_id, v_tok.program_id);

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
                           'id', g.id, 'title', g.title, 'image_url', g.image_url, 'product_path', g.product_path)
                         order by g.title), '[]'::jsonb)
                    from public.affiliate_feed_items g
                   where g.company_entity_id = f.company_entity_id
                     and g.program_id = f.program_id
                     and g.parent_source_id = f.source_id
                     -- A product under a launch can be aimed at some creators
                     -- too; with no audience it is for everyone, as before.
                     and public.affiliate_feed_item_for(g.id, v_tok.affiliate_id)) end)
             order by case f.kind when 'launch' then 0 when 'product' then 1 else 2 end,
                      f.event_on nulls last, f.shared_at desc), '[]'::jsonb)
        from (select * from public.affiliate_feed_items f
               where f.company_entity_id = v_tok.company_entity_id
                 and f.program_id = v_tok.program_id
                 -- A product shared under a launch is shown on that launch.
                 and f.parent_source_id is null
                 -- A launch that has passed drops out of "upcoming" by itself.
                 and not (f.kind = 'launch' and f.event_on is not null and f.event_on < v_today)
                 -- A share with no audience is for the whole program, which is
                 -- every share made before 2026-11-21.
                 and public.affiliate_feed_item_for(f.id, v_tok.affiliate_id)
               order by f.shared_at desc
               limit 60) f));
end;
$function$;

-- It was already revoked from both before this migration; a create-or-replace
-- keeps existing grants, and these two lines keep it true if that ever changes.
revoke execute on function public.affiliate_portal_feed(text) from anon, authenticated;

commit;
