-- A product the company SHARED needs no second yes (Blake, 2026-11-20:
-- "if product is shared by the company the claim product discount code
-- shouldn't require approval").
--
-- Sharing a product to the affiliate feed is already the decision: the company
-- picked that product, for these affiliates, at the seeding terms it set in
-- Setup. Asking a person to approve each request against it was the same yes a
-- second time, with the affiliate waiting in between.
--
-- So a request for a SHARED product is created already approved, with its code
-- and the address it is locked to, exactly as affiliate_seed_decide would have
-- written them. What makes the code in Shopify is unchanged: the id goes
-- straight to affiliate-invite, and the nightly sweep still picks up anything
-- that could not be made then.
--
-- A request for a product the affiliate names themselves (no feed item) is
-- NOT covered: nobody chose that product, so it still waits for a person.
-- Neither is a request from someone with no email on file -- a seed code is
-- locked to an address, and without one there is nothing to lock it to.
create or replace function public.affiliate_portal_seed_request(
  p_token_hash text, p_feed_item_id uuid, p_title text, p_note text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok   record;
  v_prog  record;
  v_item_id   uuid;
  v_item_path text;
  v_title text;
  v_open  integer;
  v_id    uuid;
  v_auto  boolean := false;
  v_code  text;
  v_email text;
  v_stem  text;
  v_tries integer;
  v_name  text;
begin
  select t.company_entity_id, t.program_id, t.affiliate_id, a.display_name, a.contact_email into v_tok
    from public.affiliate_access_tokens t
    join public.affiliates a
      on a.id = t.affiliate_id and a.company_entity_id = t.company_entity_id and a.program_id = t.program_id
   where t.token_hash = p_token_hash
     and t.purpose = 'portal'
     and t.revoked_at is null
     and t.expires_at > now()
     and a.status = 'active';
  if not found then
    raise exception 'affiliate_portal_seed_request: link is not valid' using errcode = '42501';
  end if;

  select p.* into v_prog from public.affiliate_programs p
   where p.id = v_tok.program_id and p.company_entity_id = v_tok.company_entity_id;
  if not v_prog.seeding_enabled or v_prog.status <> 'active' then
    raise exception 'affiliate_portal_seed_request: this program is not offering products right now' using errcode = '22023';
  end if;

  if p_feed_item_id is not null then
    select f.id, f.title, f.product_path into v_item_id, v_title, v_item_path
      from public.affiliate_feed_items f
     where f.id = p_feed_item_id
       and f.company_entity_id = v_tok.company_entity_id
       and f.program_id = v_tok.program_id
       and f.kind = 'product';
    if not found then
      raise exception 'affiliate_portal_seed_request: no such product' using errcode = '42501';
    end if;
  else
    v_title := left(btrim(coalesce(p_title, '')), 200);
    if v_title = '' then
      raise exception 'affiliate_portal_seed_request: name the product you want' using errcode = '22023';
    end if;
  end if;

  -- Two tabs pressing the same button used to be harmless: both rows said
  -- 'requested' and a person answered one. Now that a shared product is
  -- approved as it is asked for, two rows would be two usable one-use codes,
  -- so the affiliate's own row is locked for the rest of this function and
  -- the second caller reads the first one's claim and replays it.
  perform 1 from public.affiliates
   where id = v_tok.affiliate_id and company_entity_id = v_tok.company_entity_id
     for update;

  -- As many as they like (Blake), but not a flood: a person answers each one
  -- that is not for a product the company shared.
  select count(*) into v_open from public.affiliate_seed_claims c
   where c.company_entity_id = v_tok.company_entity_id and c.affiliate_id = v_tok.affiliate_id
     and c.state = 'requested';
  if v_open >= 25 then
    raise exception 'affiliate_portal_seed_request: you have 25 requests waiting; wait for the brand to answer' using errcode = '22023';
  end if;

  -- The same shared product asked twice while still open is the same request.
  if v_item_id is not null then
    select c.id into v_id from public.affiliate_seed_claims c
     where c.company_entity_id = v_tok.company_entity_id and c.affiliate_id = v_tok.affiliate_id
       and c.feed_item_id = v_item_id and c.state in ('requested', 'approved', 'code_ready');
    if v_id is not null then
      return jsonb_build_object('id', v_id, 'state', (select state from public.affiliate_seed_claims where id = v_id), 'replayed', true);
    end if;
  end if;

  -- Shared product + an address to lock the code to = approved on the spot.
  if v_item_id is not null then
    select nullif(btrim(pa.payout_email), '') into v_email
      from public.affiliate_payout_accounts pa
     where pa.affiliate_id = v_tok.affiliate_id and pa.company_entity_id = v_tok.company_entity_id
       and nullif(btrim(pa.payout_email), '') is not null
     order by pa.created_at desc limit 1;
    v_email := lower(coalesce(v_email, nullif(btrim(v_tok.contact_email), '')));
    if v_email is not null then
      v_name := coalesce(v_tok.display_name, '');
      v_stem := left(upper(regexp_replace(v_name, '[^A-Za-z0-9]', '', 'g')), 10);
      v_tries := 0;
      loop
        v_code := v_stem || 'SEED' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 5));
        exit when not exists (select 1 from public.affiliate_seed_claims s where s.company_entity_id = v_tok.company_entity_id and s.code = v_code)
              and not exists (select 1 from public.affiliate_codes ac where ac.company_entity_id = v_tok.company_entity_id and ac.code = v_code);
        v_tries := v_tries + 1;
        -- Not an error for the affiliate: it simply waits for a person, the
        -- way every request did before this change.
        if v_tries > 5 then v_code := null; exit; end if;
      end loop;
      v_auto := v_code is not null;
    end if;
  end if;

  insert into public.affiliate_seed_claims
    (company_entity_id, program_id, affiliate_id, feed_item_id, product_title, product_path, note,
     discount_percent, multiple, refund_days, goal_days,
     state, code, customer_email, decided_at)
  values (v_tok.company_entity_id, v_tok.program_id, v_tok.affiliate_id, v_item_id, v_title,
          v_item_path,
          nullif(left(btrim(coalesce(p_note, '')), 500), ''),
          v_prog.seed_discount_percent, v_prog.seed_multiple, v_prog.seed_refund_days, v_prog.seed_goal_days,
          case when v_auto then 'approved' else 'requested' end,
          case when v_auto then v_code else null end,
          case when v_auto then v_email else null end,
          case when v_auto then now() else null end)
  returning id into v_id;

  -- `decided_by` stays null on an automatic one: nobody pressed anything, and
  -- the record should not claim they did.
  return jsonb_build_object('id', v_id, 'state', case when v_auto then 'approved' else 'requested' end, 'replayed', false);
end;
$$;

revoke all on function public.affiliate_portal_seed_request(text, uuid, text, text) from public, anon, authenticated;

comment on function public.affiliate_portal_seed_request(text, uuid, text, text) is
  'Portal (service role): an affiliate asks for a product at the seeding price. A product the COMPANY shared is approved as it is asked for, with its one-use code and the address it is locked to (20261120030000); a product the affiliate names themselves, or one from an affiliate with no email on file, waits for a manager in affiliate_seed_decide.';
