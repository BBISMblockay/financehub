-- The handle's name is matched against customers too.
-- Follow-up to #1355 (20261123210000), the Affiliate Studio past-customer badge.
--
-- The badge shipped matching a prospect's PROFILE NAME against the company's
-- customer names, with the handle only as a supporting signal. Blake's own
-- worked example breaks on exactly that: the prospect row reads
-- "Emily | Baseball Mama" -- a person-shaped name that normalizes to
-- "emily baseball mama" -- while "emily durrance", the name that matches a
-- real customer, exists only in the handle "@emily_durrance". Discovered
-- creators are named by their channel far more often than by their legal
-- name, so the handle is where the matchable name usually lives.
--
-- So: extract a name from the handle (separators and digits out, letters in),
-- require it to read as a PERSON's name by the same test the profile name
-- faces -- two or more alphabetic tokens and no trade marker -- and match it
-- against `company_customer_profiles.name_lc`, through the index that is
-- already there (`company_customer_profiles_name_idx`). Scores sit in Blake's
-- "name plus a supporting signal" band: 0.75 when the profile name carries one
-- of the handle's name words too (two fields agreeing), 0.65 for the handle
-- alone, and the same namesake discount, 24-month recency weakening and
-- short-history cap as every other path.
--
-- Only when the email and profile-name passes found nothing, so this can never
-- weaken a stronger match. A handle match DOES override the profile name's
-- "brand or channel name" verdict, because a person's name in the handle is
-- evidence about a person whatever the channel is called.
--
-- `create or replace` of one function plus one new IMMUTABLE helper: no table,
-- column, policy or index changes, and re-running the file changes nothing.

begin;

-- A name extracted from a handle: "@emily_durrance" -> "emily durrance",
-- "instagram.com/emily.durrance22" -> "emily durrance". Separators, digits and
-- any URL prefix become whitespace; apostrophes and hyphens are kept because
-- they belong to names. Whether the result reads as a person's name is
-- `silo_looks_like_person_name`'s job, not this one's: a handle that reduces to
-- one token, or to trade vocabulary, is rejected there.
create or replace function public.silo_handle_name_key(p_handle text)
returns text language sql immutable as $$
  select public.silo_name_key(
    regexp_replace(regexp_replace(coalesce(p_handle, ''), '^.*/', ' '), '[^A-Za-z''\-]+', ' ', 'g')
  )
$$;

-- The helper is read by the matcher (SECURITY DEFINER) and by tests. It
-- touches no table, but the browser has no reason to call it.
revoke all on function public.silo_handle_name_key(text) from public, anon, authenticated;
grant execute on function public.silo_handle_name_key(text) to service_role;

create or replace function public.affiliate_match_prospect_customers(
  p_program uuid,
  p_limit   integer default 500,
  p_recheck_after interval default interval '7 days'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company       uuid;
  v_recent        timestamptz := now() - interval '24 months';
  v_history_from  timestamptz;
  v_history_short boolean := false;
  r               record;
  m               public.company_customer_profiles;
  v_namesakes     integer;
  v_handle        text;
  v_handle_name   text;
  v_shared        boolean;
  v_name          text;
  v_first         text;
  v_last          text;
  v_score         numeric;
  v_basis         text;
  v_status        text;
  v_checked       integer := 0;
  v_likely        integer := 0;
  v_possible      integer := 0;
begin
  select company_entity_id into v_company from public.affiliate_programs where id = p_program;
  if v_company is null then
    raise exception 'affiliate_match_prospect_customers: unknown program %', p_program;
  end if;

  -- How far the company's own order history actually reaches. Nothing can be
  -- read into a miss before this date, and a short history caps every score.
  select min(first_order_at) into v_history_from
    from public.company_customer_profiles where company_entity_id = v_company;
  v_history_short := v_history_from is null or v_history_from > v_recent;

  for r in
    select p.id, p.display_name, p.handle, p.contact_email, p.customer_match_status
      from public.affiliate_prospects p
     where p.program_id = p_program
       and p.company_entity_id = v_company
       and p.status in ('new', 'qualified', 'approved', 'invited')
       and p.customer_match_status <> 'confirmed'
       and (p.customer_matched_at is null or p.customer_matched_at < now() - p_recheck_after)
     -- Never-matched first: with a cap, a program that keeps adding creators
     -- must not starve the ones that have never been looked at.
     order by p.customer_matched_at asc nulls first, p.collected_at desc
     limit greatest(coalesce(p_limit, 500), 1)
  loop
    v_checked := v_checked + 1;
    v_score := null; v_basis := null; v_status := 'none';
    v_name := public.silo_name_key(r.display_name);
    v_handle := public.silo_name_key(replace(replace(coalesce(r.handle, ''), '@', ' '), '_', ' '));
    v_first := nullif(split_part(coalesce(v_name, ''), ' ', 1), '');
    v_last  := nullif(regexp_replace(coalesce(v_name, ''), '^.* ', ''), '');

    -- 1. The email, when the prospect has one. The only strong signal, and
    --    most discovered creators have no public address at all.
    m := null;
    if r.contact_email is not null then
      select * into m from public.company_customer_profiles c
       where c.company_entity_id = v_company
         and c.email_lc = lower(btrim(r.contact_email))
       order by c.last_order_at desc nulls last limit 1;
      if m.id is not null then
        v_score := 0.95;
        v_basis := 'their public email address is a customer of yours';
      end if;
    end if;

    -- 2. Otherwise the name -- but only a name that reads as a person's.
    if m.id is null and v_name is not null then
      if not public.silo_looks_like_person_name(r.display_name) then
        -- One token is the surname-only (or first-name-only) case Blake
        -- rejected by hand: it is not evidence either way, so it says nothing
        -- rather than claiming the name is a brand.
        if array_length(regexp_split_to_array(v_name, ' '), 1) < 2 then
          v_status := 'none';
        else
          v_status := 'not_matchable';
          v_basis  := 'this is a brand or channel name, so it cannot be matched to a customer';
        end if;
      else
        select count(*)::int into v_namesakes
          from public.company_customer_profiles c
         where c.company_entity_id = v_company and c.name_lc = v_name;

        if v_namesakes > 0 then
          select * into m from public.company_customer_profiles c
           where c.company_entity_id = v_company and c.name_lc = v_name
           order by c.last_order_at desc nulls last limit 1;

          -- A supporting signal: the handle carries the name too.
          if v_handle is not null and v_first is not null and v_last is not null
             and replace(v_handle, ' ', '') like '%' || v_first || v_last || '%' then
            v_score := 0.80;
            v_basis := 'exact name match, and their handle carries the same name';
          elsif v_handle is not null and (
                (length(coalesce(v_last, '')) >= 4 and replace(v_handle, ' ', '') like '%' || v_last || '%')
             or (length(coalesce(v_first, '')) >= 4 and replace(v_handle, ' ', '') like '%' || v_first || '%')) then
            v_score := 0.72;
            v_basis := 'exact name match, with the name in their handle too';
          elsif v_namesakes = 1 then
            v_score := 0.50;
            v_basis := 'exact name match on one customer, name only';
          elsif v_namesakes <= 3 then
            v_score := 0.40;
            v_basis := format('exact name match, but %s customers share that name', v_namesakes);
          else
            v_score := 0.30;
            v_basis := format('exact name match, but %s customers share that name', v_namesakes);
          end if;
        end if;
      end if;
    end if;

    -- 2b. The name in the HANDLE, when the profile name did not match. A
    --     discovered creator's row often carries a nickname or a channel name
    --     ("Emily | Baseball Mama") while the person's real name is only in
    --     the handle ("@emily_durrance"), so a matcher that reads the profile
    --     name alone misses exactly the creator a brand most wants to know
    --     about. Extract the handle's name, require it to read as a person's,
    --     and match THAT against the customer names -- the same index, the
    --     same namesake and recency adjustments, a lower base score, because
    --     one field agreeing is weaker than a name a creator published as
    --     their own.
    if v_score is null then
      v_handle_name := public.silo_handle_name_key(r.handle);
      if v_handle_name is not null
         and v_handle_name <> coalesce(v_name, '')
         and public.silo_looks_like_person_name(v_handle_name) then
        select count(*)::int into v_namesakes
          from public.company_customer_profiles c
         where c.company_entity_id = v_company and c.name_lc = v_handle_name;

        if v_namesakes > 0 then
          select * into m from public.company_customer_profiles c
           where c.company_entity_id = v_company and c.name_lc = v_handle_name
           order by c.last_order_at desc nulls last limit 1;

          -- The supporting signal: the profile name carries one of the
          -- handle's name words too, so two separate fields agree on the same
          -- person rather than one field being read on its own.
          v_shared := v_name is not null and exists (
            select 1 from unnest(regexp_split_to_array(v_handle_name, ' ')) w
             where length(w) >= 4 and (' ' || v_name || ' ') like '% ' || w || ' %');

          if v_namesakes > 3 then
            v_score := 0.30;
            v_basis := format('their handle reads as a customer''s name, but %s customers share that name', v_namesakes);
          elsif v_namesakes > 1 then
            v_score := 0.40;
            v_basis := format('their handle reads as a customer''s name, but %s customers share that name', v_namesakes);
          elsif v_shared then
            v_score := 0.75;
            v_basis := 'their handle reads as a customer''s name, and their profile name carries it too';
          else
            v_score := 0.65;
            v_basis := 'their handle reads as a customer''s name';
          end if;

          -- A handle that carries a real person's name is evidence about a
          -- person, so it outranks the "brand or channel name" verdict the
          -- profile name earned on its own. The status is recomputed from the
          -- score below.
          if v_status = 'not_matchable' then v_status := 'none'; end if;
        end if;
      end if;
    end if;

    -- 3. Recency. Orders inside 24 months count in full; an older last order
    --    is a weaker signal, not a disqualifying one.
    if v_score is not null and m.id is not null and (m.last_order_at is null or m.last_order_at < v_recent) then
      v_score := round(v_score * 0.8, 3);
      v_basis := v_basis || '; last order over 2 years ago';
    end if;

    -- 4. A short order history caps the confidence either way.
    if v_score is not null and v_history_short then
      if v_score > 0.60 then v_score := 0.60; end if;
      v_basis := v_basis || '; history incomplete, your orders do not reach back 2 years';
    end if;

    if v_status <> 'not_matchable' then
      v_status := case
        when v_score is null then 'none'
        when v_score >= 0.70 then 'likely'
        when v_score >= 0.30 then 'possible'
        else 'none' end;
    end if;
    if v_status = 'likely' then v_likely := v_likely + 1;
    elsif v_status = 'possible' then v_possible := v_possible + 1; end if;

    update public.affiliate_prospects p
       set customer_match_status = v_status,
           customer_match_score  = case when v_status in ('possible','likely') then v_score else null end,
           customer_match_basis  = case when v_status in ('possible','likely','not_matchable') then v_basis else null end,
           customer_match_key    = case when v_status in ('possible','likely') then m.customer_key else null end,
           customer_match_customer_id = case when v_status in ('possible','likely') then m.customer_id else null end,
           customer_order_count  = case when v_status in ('possible','likely') then m.order_count else null end,
           customer_last_order_at = case when v_status in ('possible','likely') then m.last_order_at else null end,
           customer_lifetime_spend = case when v_status in ('possible','likely') then m.lifetime_spend else null end,
           customer_matched_at   = now()
     where p.id = r.id;
  end loop;

  return jsonb_build_object(
    'program_id', p_program,
    'prospects_checked', v_checked,
    'likely', v_likely,
    'possible', v_possible,
    'history_from', v_history_from,
    'history_incomplete', v_history_short
  );
end $$;

revoke all on function public.affiliate_match_prospect_customers(uuid, integer, interval) from public, anon, authenticated;
grant execute on function public.affiliate_match_prospect_customers(uuid, integer, interval) to service_role;

commit;
