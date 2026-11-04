-- Up to three live connections per person per APPLICATION, in numbered slots.
--
-- WHY THIS EXISTS
--
-- 20261102180000 made the dedupe key the application rather than the client
-- registration, and Blake chose "always replace": one live grant per
-- (app_key, user_id), reconnecting revokes the previous one. That stopped the
-- orphan pile-up it was written for, and it also means ONE Claude connection
-- in total -- because claude.ai web, the Claude desktop app and Claude on a
-- phone all register the same client_name and the same redirect host, so they
-- all key to `claude|claude.ai`. Connecting on the second surface silently
-- ends the first, and the person is asked to authorize again every time they
-- move between them. Measured on production 2026-11-03/04: Blake re-consented
-- seven times in three hours.
--
-- (The other half of that symptom was not here at all -- SILO's own
-- `supabase.auth.signOut()` defaulted to scope `global`, which deletes every
-- GoTrue session the person has, including the one the connector holds. That
-- is fixed in the frontend in the same change and needs no migration.)
--
-- So the limit becomes a small number instead of one: Blake's decision
-- 2026-11-04, having been shown that one-per-application is what breaks
-- Claude on a second device. Three is the number, in one place
-- (silo_api_app_connection_limit()), because this is a policy number and
-- changing it has to be one edit -- the same reason silo_api_idle_window()
-- exists.
--
-- HOW THE LIMIT IS ENFORCED
--
-- A unique partial index can say "at most one"; it cannot say "at most three".
-- So each live grant carries a SLOT, and the index is unique on
-- (app_key, user_id, slot) where revoked_at is null. The limit is then a
-- property of the schema and not only of the function: a writer that bypasses
-- silo_api_consent() still cannot create a fourth live connection to one
-- application, which is exactly what the old index bought and is not worth
-- giving up. The CHECK keeps slot inside 0..9 so a raised limit needs no
-- constraint change, while the allocator never hands out a slot at or above
-- the current limit.
--
-- WHAT CONSENT NOW REVOKES
--
-- Two rules, and the distinction between them matters:
--
--   1. Live grants for this application that were NEVER BOUND TO A SESSION and
--      never used (auth_session_id is null and last_used_at is null) are
--      revoked outright. No access token was ever issued against them, so they
--      cannot be anybody's working connection -- they are the abandoned or
--      retried authorize attempts that dynamic registration leaves behind. On
--      production 2026-11-03 three of Blake's seven consents were exactly
--      this shape. Without this rule those rows would sit in slots for 30 days
--      and crowd out the real ones.
--
--      `auth_session_id is null` is load-bearing and `last_used_at is null`
--      alone would be WRONG: last_used_at is written by
--      silo_api_touch_grant() on first DATA use, so a connection whose token
--      has been issued and which simply has not run a tool yet still reads
--      NULL there. Judging on use alone would revoke a connection that was
--      working seconds earlier.
--
--   1b. This person's live grant for the SAME client_id, whatever its state.
--      silo_api_grants_one_live (client_id, user_id) from 20261020030000 is
--      still in force and the insert has to satisfy it; the old blanket revoke
--      cleared the way for free and rule 1 does not, because such a grant is
--      bound and used. A client whose registration is NOT dynamic reconnects
--      under the client_id it already holds -- the SILO Test Client and any
--      customer-registered confidential client are exactly that -- so without
--      this, re-approving one while a slot is free fails on a duplicate key
--      and the approval cannot be completed at all. It is a replacement, not a
--      cleanup, which is why state does not matter: an idle or expired grant
--      whose revoked_at is still null blocks the insert just the same.
--
--   2. If every slot is still taken after that, the LEAST RECENTLY USED live
--      grant is revoked and its slot reused. Ordered
--      `last_used_at desc nulls last, consented_at desc` and the bottom row
--      evicted -- not coalesce(last_used_at, consented_at), which compares a
--      never-used row's consent time against another row's actual use and so
--      evicts the WORKING connection in favour of an idle one consented five
--      minutes later. That was review cycle 1 of #1095 and the mistake is not
--      recoverable, because a revocation is monotonic.
--
-- Serialized per (person, application) with a transaction advisory lock, so two
-- consents racing cannot pick the same slot. The unique index is still the
-- backstop if they somehow do: the loser gets a unique violation and approves
-- nothing, which is the right way round.
--
-- WHAT IS NOT CHANGED
--
-- The policy is untouched: two-factor approval (consented_aal = 'aal2'), the
-- 90-day CHECK on expires_at, the 30-day idle window, and fail-closed
-- revocation. silo_api_access_token_hook(), silo_api_grant() and
-- silo_api_touch_grant() all resolve a token by its OWN client_id, which is
-- unique per registration, so three live grants for one application are three
-- separate connections to every later layer and nothing there needs to change.
-- No gate is widened and no role gains anything.
--
-- Idempotent. No deploy. The frontend change beside it is independent of this.
--
-- apply_all_post_merge.sql replays every file in order, so 20261102180000 runs
-- again before this one. Its collapse to a single live grant per application,
-- the index it creates and the two guards that assert that rule are therefore
-- skipped once `slot` exists -- in that file, because a replay must not revoke
-- two of somebody's three connections, monotonically, for doing what this
-- migration intends.

-- ---------------------------------------------------------------------------
-- 1. The number, in one place
-- ---------------------------------------------------------------------------
create or replace function public.silo_api_app_connection_limit()
returns integer
language sql
immutable
set search_path = ''
as $$ select 3 $$;

comment on function public.silo_api_app_connection_limit() is
  'How many live connections one person may hold to one application at the same time: 3 (Blake, 2026-11-04). One per application ended Claude on a second device every time, because claude.ai web, the desktop app and the phone all key to the same app_key. Enforced in the schema by silo_api_grants_one_live_slot, and allocated by silo_api_consent(). 20261104020000.';

revoke all on function public.silo_api_app_connection_limit() from public, anon;
grant execute on function public.silo_api_app_connection_limit()
  to authenticated, silo_api_exec;

-- ---------------------------------------------------------------------------
-- 2. The slot column
-- ---------------------------------------------------------------------------
alter table public.silo_api_grants
  add column if not exists slot smallint not null default 0;

comment on column public.silo_api_grants.slot is
  'Which of this person''s live connections to this application this grant is. Unique among live grants for one (app_key, user_id), so the unique index -- not only silo_api_consent() -- is what caps the number. Assigned at consent and frozen for the life of the row. 20261104020000.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.silo_api_grants'::regclass
      and conname = 'silo_api_grants_slot_range') then
    alter table public.silo_api_grants
      add constraint silo_api_grants_slot_range
      check (slot >= 0 and slot <= 9);
  end if;
end;
$$;

-- Everything live today is the single live grant for its (app_key, user_id) --
-- that is what 20261102180000's index has been enforcing -- so every one of
-- them is slot 0 and the default has already done this. Written as a
-- row_number anyway, because this file must also be correct if it is ever
-- applied to a database where that index was dropped first.
--
-- FIRST RUN ONLY, keyed on the index this migration creates below. On a second
-- apply -- and apply_all_post_merge.sql re-runs every file -- the slots in use
-- are the allocator's, which follow which slot was free and not which
-- connection was used last, so re-ranking them would both renumber live
-- connections and be refused outright by the frozen trigger.
do $$
begin
  if not exists (
    select 1 from pg_class i
    where i.relname = 'silo_api_grants_one_live_slot' and i.relkind = 'i') then
    with ranked as (
      select id,
             row_number() over (
               partition by app_key, user_id
               order by last_used_at desc nulls last, consented_at desc, id) - 1 as rn
      from public.silo_api_grants
      where revoked_at is null
    )
    update public.silo_api_grants g
       set slot = r.rn
      from ranked r
     where r.id = g.id
       and g.slot is distinct from r.rn
       and r.rn <= 9;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The rule, in the schema
-- ---------------------------------------------------------------------------
-- The old one-live-per-application index is what this replaces, so it goes:
-- leaving it would hold the limit at one whatever the allocator decides.
-- silo_api_grants_one_live (client_id, user_id) from 20261020030000 stays --
-- it is about the client registration, which is still one connection each.
create unique index if not exists silo_api_grants_one_live_slot
  on public.silo_api_grants (app_key, user_id, slot) where revoked_at is null;

drop index if exists public.silo_api_grants_one_live_app;

-- ---------------------------------------------------------------------------
-- 4. slot is frozen, like everything else consent decided
-- ---------------------------------------------------------------------------
-- Recreated whole rather than patched, so the function body is the whole rule.
create or replace function public.silo_api_grants_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.client_id        is distinct from old.client_id
     or new.app_key       is distinct from old.app_key
     or new.slot          is distinct from old.slot
     or new.user_id       is distinct from old.user_id
     or new.company_entity_id is distinct from old.company_entity_id
     or new.scopes        is distinct from old.scopes
     or new.consented_aal is distinct from old.consented_aal
     or new.consented_at  is distinct from old.consented_at
     or new.expires_at    is distinct from old.expires_at
     or new.generation    is distinct from old.generation
     or new.created_at    is distinct from old.created_at then
    raise exception 'silo_api_grant_frozen: a granted authorization cannot be changed; approve a new one'
      using errcode = 'check_violation';
  end if;
  -- Revocation is monotonic: it cannot be undone, and it cannot be moved.
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'silo_api_grant_frozen: a revocation cannot be undone or moved'
      using errcode = 'check_violation';
  end if;
  -- The session binding happens once, at first issuance.
  if old.auth_session_id is not null
     and new.auth_session_id is distinct from old.auth_session_id then
    raise exception 'silo_api_grant_frozen: a grant cannot be rebound to another session'
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.silo_api_grants_frozen() is
  'Keeps silo_api_grants revoke-only and bind-once for every writer, not just for the browser: the consented fields, the application, its slot, scopes, company and expiry are frozen, a revocation cannot be undone, and a session binding cannot be moved. 20261020030000, app_key 20261102180000, slot 20261104020000.';

revoke all on function public.silo_api_grants_frozen() from public, anon, authenticated;

drop trigger if exists silo_api_grants_frozen on public.silo_api_grants;
create trigger silo_api_grants_frozen
  before update on public.silo_api_grants
  for each row execute function public.silo_api_grants_frozen();

-- ---------------------------------------------------------------------------
-- 5. Consent allocates a slot instead of replacing the connection
-- ---------------------------------------------------------------------------
-- 20261102180000's version, with the blanket revoke replaced by the two rules
-- in the header. Recreated whole because that is how this function has been
-- carried forward each time, and a diff of the revoke alone would hide which
-- generation it belongs to. Every refusal above it -- integration, signed in,
-- active company, membership, aal2, client named, scope allowlist -- is
-- unchanged and must stay unchanged.
create or replace function public.silo_api_consent(
  p_client_id text,
  p_scopes text[] default array['reports:read'])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- data:read since 20261030110000: the MCP query tool (read-only SQL under
  -- the person's own RLS). Granted alongside reports:read, never instead.
  c_offered constant text[] := array['reports:read', 'data:read'];
  v_user    uuid;
  v_company uuid;
  v_aal     text;
  v_scopes  text[];
  v_app     text;
  v_gen     integer;
  v_limit   integer;
  v_slot    integer;
  v_evict   uuid;
  v_id      uuid;
begin
  -- A connection can never approve anything, least of all itself.
  if public.silo_api_is_integration() then
    raise exception 'integration_not_allowed: a connection cannot approve access'
      using errcode = 'insufficient_privilege';
  end if;

  v_user := auth.uid();
  if v_user is null then
    raise exception 'not_authenticated: sign in to approve access'
      using errcode = 'insufficient_privilege';
  end if;

  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no_active_company: open the company you are approving access for'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.entity_memberships em
    where em.user_id = v_user and em.entity_id = v_company) then
    raise exception 'not_a_member: you are not a member of that company'
      using errcode = 'insufficient_privilege';
  end if;

  -- The assurance of the session doing the approving, as the session itself
  -- reports it. This is the whole reason consented_aal exists: an OAuth token
  -- reads aal1 forever, so the only evidence two-factor approval happened is
  -- what was true HERE, at this moment, recorded by the server. A grant
  -- consented below aal2 can never be used -- mfa_session_satisfied() refuses
  -- it -- so it is refused now, loudly, rather than left to fail silently on
  -- first use.
  v_aal := coalesce(nullif(public.silo_api_claims() ->> 'aal', ''), 'aal1');
  if v_aal <> 'aal2' then
    raise exception 'mfa_required: finish two-step login before approving API access'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(trim(p_client_id), '') = '' then
    raise exception 'invalid_client: no application was named'
      using errcode = 'check_violation';
  end if;

  -- Scopes are an allowlist, deduplicated, and never empty.
  select coalesce(array_agg(distinct sc), '{}')
    into v_scopes
  from unnest(coalesce(p_scopes, '{}'::text[])) sc
  where sc = any(c_offered);
  if array_length(v_scopes, 1) is null then
    raise exception 'invalid_scope: no recognised scope was requested'
      using errcode = 'check_violation';
  end if;

  -- Up to silo_api_app_connection_limit() live connections per person per
  -- APPLICATION. Keyed on the application rather than on the client
  -- registration, because dynamic registration makes a fresh client_id on
  -- every connect and the old key never matched (20261102180000). Keyed on
  -- user_id, never on the company: somebody else in the same company
  -- connecting the same application is a different connection.
  v_app   := public.silo_api_app_key(p_client_id);
  v_limit := public.silo_api_app_connection_limit();

  -- One consent at a time for this person and this application, so two
  -- parallel connects cannot choose the same slot. Transaction-scoped: it is
  -- released however this function ends.
  perform pg_advisory_xact_lock(
    hashtextextended(v_app || ':' || v_user::text, 0));

  select coalesce(max(g.generation), 0) into v_gen
  from public.silo_api_grants g
  where g.app_key = v_app and g.user_id = v_user;

  -- Rule 1: an authorization that never received a token is nobody's
  -- connection. auth_session_id is what proves a token was issued;
  -- last_used_at is only written on first DATA use, so it is NULL for a
  -- working connection that has not run a tool yet and cannot be judged on
  -- its own.
  update public.silo_api_grants
     set revoked_at = now()
   where app_key = v_app
     and user_id = v_user
     and revoked_at is null
     and auth_session_id is null
     and last_used_at is null;

  -- Rule 1b: this person's live grant for THIS SAME client registration, if
  -- there is one. silo_api_grants_one_live (client_id, user_id) from
  -- 20261020030000 is still in force and the insert below has to satisfy it.
  -- Under the old blanket revoke that was automatic; now it is not, and a
  -- client whose registration is NOT dynamic -- the SILO Test Client and any
  -- customer-registered confidential client are exactly this -- reconnects
  -- under the client_id it already holds. Without this, re-approving such a
  -- client while a slot is free fails on a duplicate key and the person simply
  -- cannot finish the approval. Not folded into rule 1: this one goes whatever
  -- its state, because it is being replaced, not cleaned up, and its slot is
  -- then the free slot rule 2 finds.
  update public.silo_api_grants
     set revoked_at = now()
   where client_id = trim(p_client_id)
     and user_id = v_user
     and revoked_at is null;

  -- Rule 2: the lowest free slot, or the least recently used connection's.
  select s.n into v_slot
  from generate_series(0, v_limit - 1) as s(n)
  where not exists (
    select 1 from public.silo_api_grants g
    where g.app_key = v_app
      and g.user_id = v_user
      and g.revoked_at is null
      and g.slot = s.n)
  order by s.n
  limit 1;

  if v_slot is null then
    select g.id, g.slot into v_evict, v_slot
    from public.silo_api_grants g
    where g.app_key = v_app
      and g.user_id = v_user
      and g.revoked_at is null
      and g.slot < v_limit
    order by g.last_used_at desc nulls last, g.consented_at desc, g.id
    offset greatest(v_limit - 1, 0)
    limit 1;

    if v_evict is null then
      -- Every slot inside the limit is taken by a row the eviction query
      -- could not see, which can only mean the limit was lowered under live
      -- grants. Refuse rather than silently exceed it.
      raise exception 'no_connection_slot: disconnect one of your existing connections to this application first'
        using errcode = 'check_violation';
    end if;

    update public.silo_api_grants
       set revoked_at = now()
     where id = v_evict
       and revoked_at is null;
  end if;

  insert into public.silo_api_grants
    (client_id, app_key, slot, user_id, company_entity_id, auth_session_id,
     generation, scopes, consented_aal, consented_at, expires_at)
  values
    (trim(p_client_id), v_app, v_slot, v_user, v_company, null,
     v_gen + 1, v_scopes, v_aal, now(), now() + interval '90 days')
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.silo_api_consent(text, text[]) is
  'Creates a live authorization for a third-party application, deriving the person, company, assurance and dates from request state rather than from arguments. Offers reports:read and data:read. Refuses a session that is not aal2, because a grant consented below aal2 can never be used. A person may hold silo_api_app_connection_limit() live connections to one application at once -- keyed on silo_api_app_key(), never on the company -- so the same application works on more than one device; approving again revokes any authorization that never received a token, then takes a free slot, then the least recently used one. 20261020030000; data:read 20261030110000; per-application 20261102180000; slots 20261104020000.';

revoke all on function public.silo_api_consent(text, text[]) from public, anon;
grant execute on function public.silo_api_consent(text, text[]) to authenticated;
