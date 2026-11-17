-- Affiliate Studio: codes named after the creator, and the seed-code email.
--
-- 1. affiliate_suggest_code(): the code a new affiliate gets is their handle
--    (or, without one, their whole name) plus the program's percent, e.g.
--    BLAKETESTINGS10 -- never the first word of a display name ("SILO10" for
--    "SILO Flow Test", Blake 2026-11-17). A text another code in the company
--    already uses gets a letter, BLAKETESTINGS10B, C, ...: no dash, nothing
--    that reads like a date or a bigger percent. Same signature and grants;
--    `create or replace` keeps them.
-- 2. affiliate_queue_first_code(): passes the handle first. Body otherwise the
--    20261110180000 one, verbatim.
-- 3. affiliate_notifications.kind gains 'seed_code' (SILO makes a seed code in
--    Shopify itself and emails it to that affiliate only) and 'earnings' (the
--    nightly "you earned $X" notice).
-- 4. affiliate_autoshare_launch_trg(): a shared launch FOLLOWS a date change
--    (Blake 2026-11-17: "nimble"). The card an affiliate sees moves to the new
--    day -- shared automatically or by hand, same row. It still never re-shares
--    a launch someone unshared: it only updates a card that is there. Otherwise
--    the 20261113080000 body, verbatim.
--
-- Idempotent. No data changes: codes already made keep their text.

create or replace function public.affiliate_suggest_code(p_company uuid, p_name text, p_percent integer)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_base text := left(upper(regexp_replace(coalesce(p_name, ''), '[^A-Za-z0-9]', '', 'g')), 14);
  v_code text;
  v_tail text := 'BCDEFGHJKLMNPQRSTUVWXYZ';
  i      integer;
begin
  if length(v_base) < 2 then v_base := 'PARTNER'; end if;
  v_base := v_base || coalesce(p_percent::text, '');
  if not exists (select 1 from public.affiliate_codes c
                  where c.company_entity_id = p_company and lower(c.code) = lower(v_base)) then
    return v_base;
  end if;
  for i in 1..length(v_tail) loop
    v_code := v_base || substr(v_tail, i, 1);
    if not exists (select 1 from public.affiliate_codes c
                    where c.company_entity_id = p_company and lower(c.code) = lower(v_code)) then
      return v_code;
    end if;
  end loop;
  return v_base || upper(substr(md5(random()::text), 1, 4));
end;
$$;

create or replace function public.affiliate_queue_first_code()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pct   integer;
  v_today date;
begin
  if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then
    return null;
  end if;
  if exists (select 1 from public.affiliate_codes c
              where c.company_entity_id = new.company_entity_id
                and c.affiliate_id = new.id
                and c.status in ('active', 'pending')) then
    return null;
  end if;
  select p.default_discount_percent into v_pct
    from public.affiliate_programs p where p.id = new.program_id;
  if v_pct is null then return null; end if;

  -- Joining must never fail because of the code: any refusal (a name that
  -- collides after all, a guard) leaves the affiliate active and codeless,
  -- which the Studio To do list shows.
  begin
    v_today := (now() at time zone public.silo_company_timezone(new.company_entity_id))::date;
    insert into public.affiliate_codes
      (company_entity_id, program_id, affiliate_id, code, starts_on, status, discount_percent)
    values
      (new.company_entity_id, new.program_id, new.id,
       public.affiliate_suggest_code(new.company_entity_id,
         coalesce(nullif(btrim(regexp_replace(coalesce(new.handle, ''), '^@', '')), ''), new.display_name), v_pct),
       v_today, 'pending', v_pct);
  exception when others then
    raise warning 'affiliate_queue_first_code: no code queued for affiliate %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function public.affiliate_suggest_code(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.affiliate_queue_first_code() from public, anon, authenticated;

alter table public.affiliate_notifications drop constraint if exists affiliate_notifications_kind_check;
alter table public.affiliate_notifications add constraint affiliate_notifications_kind_check
  check (kind in ('signup_confirmation', 'portal_link', 'codes_and_links', 'payout_status', 'link_renewal', 'signup_invite', 'seed_code', 'earnings'));

create or replace function public.affiliate_autoshare_launch_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A launch is shared once: when it is created, or when a launch saved
  -- without a date first gets one. A later date change moves the card that
  -- is already shared; it never brings back one someone unshared.
  if tg_op = 'UPDATE' and old.launch_date is not null then
    if new.launch_date is not null and new.launch_date is distinct from old.launch_date then
      begin
        update public.affiliate_feed_items f
           set event_on = new.launch_date
         where f.company_entity_id = new.company_entity_id
           and f.kind = 'launch'
           and f.source_id = new.id::text;
      exception when others then
        raise warning 'affiliate_autoshare_launch date follow skipped for launch %: %', new.id, sqlerrm;
      end;
    end if;
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

revoke all on function public.affiliate_autoshare_launch_trg() from public, anon, authenticated;
