-- View as rep (Blake 2026-11-24): staff open an affiliate's own portal, with
-- their real codes, links, earnings and posts, READ-ONLY.
--
-- A preview is its own kind of link, purpose 'preview', not a portal link
-- with a flag. That makes it read-only BY CONSTRUCTION: every portal write
-- function (claim, seed_request, content_start, content_finish, switch_token)
-- and the renewal lookup already demand purpose = 'portal', so a preview
-- token is refused by the database itself whatever the edge function does,
-- deployed or not. The handler's own direct writes (photo, payout email)
-- check t.purpose = 'portal' in the handler, and an older handler refuses
-- EVERY action for a purpose it does not know, so the failure mode of a
-- half-shipped release is "the preview shows an error", never "staff wrote
-- into a rep's account".
--
-- Only the four READS a portal makes widen to accept 'preview' (content,
-- feed, orders, seeds). affiliate_portal_statement has no purpose test and
-- reads by the token's own affiliate already. affiliate_portal_brands stays
-- portal-only: a preview opens this one brand, never the rep's other brands.
--
-- A preview never touches the rep's own links: it is a new row, it revokes
-- nothing, and it is not renewable (renew_subject is portal-only), so an
-- expired preview cannot make SILO mail the rep. It lives one hour.
--
-- Idempotent.

-- 1. The purpose check admits 'preview'.
do $$
declare v_name text;
begin
  select conname into v_name from pg_constraint
   where conrelid = 'public.affiliate_access_tokens'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%purpose%';
  if v_name is not null and (select pg_get_constraintdef(oid) from pg_constraint
                              where conrelid = 'public.affiliate_access_tokens'::regclass and conname = v_name) not ilike '%preview%' then
    execute format('alter table public.affiliate_access_tokens drop constraint %I', v_name);
    v_name := null;
  end if;
  if v_name is null then
    alter table public.affiliate_access_tokens
      add constraint affiliate_access_tokens_purpose_check check (purpose in ('signup', 'portal', 'preview'));
  end if;
end $$;

-- 2. The four portal READS accept a preview. Rewritten from their LIVE
-- definitions (some portal functions were last changed by hand-applied SQL),
-- changing exactly one predicate in each and refusing to guess if that
-- predicate is not there exactly once. create or replace keeps the grants
-- (service_role only).
do $$
declare
  fn text;
  def text;
  old_p constant text := 't.purpose = ''portal''';
  new_p constant text := 't.purpose in (''portal'', ''preview'')';
  n int;
begin
  foreach fn in array array['affiliate_portal_content', 'affiliate_portal_feed', 'affiliate_portal_orders', 'affiliate_portal_seeds'] loop
    select pg_get_functiondef(p.oid) into def
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = fn;
    if def is null then
      raise exception 'view as rep: % is missing', fn;
    end if;
    if position(new_p in def) > 0 then
      continue;   -- already widened
    end if;
    n := (length(def) - length(replace(def, old_p, ''))) / length(old_p);
    if n <> 1 then
      raise exception 'view as rep: expected one "%" in %, found %', old_p, fn, n;
    end if;
    execute replace(def, old_p, new_p);
  end loop;
end $$;

-- 3. Staff mint a preview for one affiliate of the company they are in. The
-- browser makes the token and sends only its sha256; the raw token never
-- reaches the database. The caller must be able to manage that affiliate's
-- program (the same gate as every other Studio action on it).
create or replace function public.affiliate_issue_preview_token(p_affiliate_id uuid, p_token_hash text)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_co  uuid := public.active_company_id();
  v_a   record;
  v_exp timestamptz := now() + interval '1 hour';
begin
  if auth.uid() is null or v_co is null then
    raise exception 'affiliate_issue_preview_token: sign in first' using errcode = '42501';
  end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'affiliate_issue_preview_token: a sha-256 token hash is required';
  end if;
  select a.id, a.program_id, a.status, a.terms_accepted_at into v_a
    from public.affiliates a
   where a.id = p_affiliate_id and a.company_entity_id = v_co;
  if not found or not public.can_manage_affiliate_program(v_a.program_id) then
    raise exception 'affiliate_issue_preview_token: not allowed' using errcode = '42501';
  end if;
  if v_a.status not in ('active', 'paused') or v_a.terms_accepted_at is null then
    raise exception 'affiliate_issue_preview_token: this affiliate has no portal yet';
  end if;
  insert into public.affiliate_access_tokens
    (company_entity_id, program_id, affiliate_id, purpose, token_hash, expires_at, created_by)
  values (v_co, v_a.program_id, v_a.id, 'preview', p_token_hash, v_exp, auth.uid());
  return v_exp;
end;
$$;

revoke all on function public.affiliate_issue_preview_token(uuid, text) from public, anon;
grant execute on function public.affiliate_issue_preview_token(uuid, text) to authenticated;
