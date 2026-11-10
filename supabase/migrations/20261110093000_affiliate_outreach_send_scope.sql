-- outreach:send -- a SILO AI connection hands approved affiliate outreach to
-- the person's own AI, which sends it from the person's own mailbox (Gmail,
-- Outlook, whatever their AI is connected to), and then records that it was
-- sent. SILO still sends nothing.
--
-- WHY. Affiliate Studio (20261110084000) ends outreach at "approved": a person
-- exports a spreadsheet with personal signup links, sends each message
-- themselves, and marks each one sent with evidence. Blake, 2026-11-10: "a
-- perfect SILO MCP > users MCP Gmail flow". The person's AI already has their
-- mailbox; what it lacks is the approved message, a working signup link, and
-- a way to close the loop. Cold outreach must not go through SILO's Resend:
-- every tenant shares SILO's sending domain, and recruitment mail to someone
-- who never asked is not transactional.
--
-- WHAT THIS ADDS. One opt-in scope and two tools, both on the same fence as
-- work:write (20261104230000): SECURITY DEFINER, company and person from the
-- GRANT row and never from the session, a paused connection writes nothing,
-- and the application's name is stored on the row as "Via <app>".
--   * silo_api_claim_outreach -- takes up to 25 APPROVED email drafts of one
--     active program, mints each a fresh 14-day signup link (the same token
--     the export mints, hash stored, raw link returned once), and moves them
--     to "exported" in a batch tagged with the connection. Each draft claimed
--     is one write against silo_api_write_cap(). An idempotency key makes a
--     retry return the same drafts with re-minted links instead of claiming
--     more (the first links are revoked by affiliate_issue_access_token).
--   * silo_api_mark_outreach_sent -- records ONE draft this connection
--     claimed as sent, with the sent message's id as evidence. The existing
--     CHECK still demands a named person and evidence; the person is the one
--     who approved the connection, and the row says which app.
--
-- WHAT IT CANNOT DO. Approve a draft (a person does, in Affiliate Studio),
-- write or change a message, reach a draft that is not approved, a program
-- that is not active, a suppressed recipient, or another company's rows, or
-- mark sent a draft a person exported by hand or another connection claimed.
-- Who may use it at all is the Affiliate Studio manager gate
-- (can_manage_affiliate_programs's rule, judged for the grant's company).
begin;

-- ── 1. The scope ──────────────────────────────────────────────────────────
-- Re-stated from 20261104234500 (the live version; read back from that file,
-- which production matches per the drift check) with ONE line changed:
-- c_offered.
create or replace function public.silo_api_consent(
  p_client_id text,
  p_scopes text[] default array['reports:read'])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- data:read since 20261030110000 (the query tool).
  -- work:write since 20261104230000: creating a task. Asked for separately on
  -- the consent screen and never implied by a read scope.
  -- outreach:send since 20261110093000: taking approved affiliate outreach to
  -- send from the person's own mailbox, and recording that it was sent. Its
  -- own box on the consent screen, never implied by work:write.
  c_offered constant text[] := array['reports:read', 'data:read', 'work:write', 'outreach:send'];
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
  -- reports it. An OAuth token reads aal1 forever, so the only evidence
  -- two-factor approval happened is what was true HERE, at this moment.
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

  -- An unrecognised scope is REFUSED, not dropped. Measured on production
  -- 2026-11-04: an approval that ticked "also let it open tasks" stored the two
  -- read scopes and nothing else, because the page was running an older cached
  -- copy of v2/api-connections.js in which the constant for the write scope did
  -- not exist yet -- so it sent a null, this filter dropped it, and the person
  -- was told the connection was approved with a permission it did not have.
  -- Storing FEWER permissions than the person ticked, silently, is the worst
  -- outcome available here: failing in front of them costs one reload.
  if exists (
    select 1
    from unnest(coalesce(p_scopes, '{}'::text[])) sc
    where sc is null or sc <> all(c_offered)) then
    raise exception 'unknown_scope: SILO does not recognise one of the permissions this page asked for. Reload the approval page and approve again.'
      using errcode = 'check_violation';
  end if;

  if array_length(v_scopes, 1) is null then
    raise exception 'invalid_scope: no recognised scope was requested'
      using errcode = 'check_violation';
  end if;

  -- Up to silo_api_app_connection_limit() live connections per person per
  -- APPLICATION (20261102180000, slots 20261104020000).
  v_app   := public.silo_api_app_key(p_client_id);
  v_limit := public.silo_api_app_connection_limit();

  perform pg_advisory_xact_lock(
    hashtextextended(v_app || ':' || v_user::text, 0));

  select coalesce(max(g.generation), 0) into v_gen
  from public.silo_api_grants g
  where g.app_key = v_app and g.user_id = v_user;

  -- Rule 1: an authorization that never received a token is nobody's
  -- connection.
  update public.silo_api_grants
     set revoked_at = now()
   where app_key = v_app
     and user_id = v_user
     and revoked_at is null
     and auth_session_id is null
     and last_used_at is null;

  -- Rule 1b: this person's live grant for THIS SAME client registration.
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
  'Writes the SILO grant row for an approved application: aal2 required, scopes from the allowlist (reports:read, data:read, work:write, outreach:send) and a scope outside it is REFUSED rather than dropped, up to silo_api_app_connection_limit() live connections per person per application in numbered slots. 20261020030000; app_key 20261102180000; slots 20261104020000; work:write 20261104230000; strict scopes 20261104234500; outreach:send 20261110093000.';

revoke all on function public.silo_api_consent(text, text[]) from public, anon;
grant execute on function public.silo_api_consent(text, text[]) to authenticated;

-- ── 2. The paths ──────────────────────────────────────────────────────────
-- Re-stated from 20261104234500 with two paths added.
create or replace function public.silo_api_path_allowed()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('request.path', true), '') in (
    '/rpc/silo_api_run_report', '/rpc/silo_api_list_reports',
    '/rpc/silo_api_describe_tables', '/rpc/silo_api_query',
    '/rpc/silo_api_windsor_connections',
    '/rpc/silo_api_create_task',
    '/rpc/silo_api_scopes',
    '/rpc/silo_api_claim_outreach',
    '/rpc/silo_api_mark_outreach_sent')
$$;

comment on function public.silo_api_path_allowed() is
  'True when a third-party OAuth request is on one of the paths the developer platform exposes: running and listing reports (reports:read), describing tables, running a read-only query and reading published connections (data:read), opening a task (work:write), reading this connection''s own scopes (no scope needed -- it is what the server lists tools from), and claiming approved affiliate outreach and marking it sent (outreach:send). Every other path is refused by silo_check_request(). 20261030050000; query 20261030110000; connections 20261103210000; create_task 20261104230000; scopes 20261104234500; outreach 20261110093000.';

-- ── 3. The ledger learns a second kind ────────────────────────────────────
-- A claimed draft is a write: it mints a credential and moves a row. Marking
-- one sent is not counted -- it can only follow a claim, so the claim already
-- paid for it, and counting both would halve what a person can send.
alter table public.silo_api_writes drop constraint if exists silo_api_writes_kind_check;
alter table public.silo_api_writes
  add constraint silo_api_writes_kind_check check (kind in ('task', 'outreach_claim'));

-- ── 4. The rows say which connection ──────────────────────────────────────
alter table public.affiliate_outreach_batches
  add column if not exists created_by_grant_id uuid references public.silo_api_grants(id) on delete set null,
  add column if not exists created_by_app text,
  add column if not exists idempotency_key text;

comment on column public.affiliate_outreach_batches.created_by_grant_id is
  'The AI connection that claimed this batch to send from the person''s own mailbox (outreach:send). Null for a spreadsheet export a person made. 20261110093000.';
comment on column public.affiliate_outreach_batches.created_by_app is
  'The application''s own name, stored on the row so every manager sees the same "Via <app>". 20261110093000.';
comment on column public.affiliate_outreach_batches.idempotency_key is
  'The connection''s own key for this claim: the same key again returns this batch, with fresh links, instead of claiming more drafts. 20261110093000.';

create unique index if not exists affiliate_outreach_batches_claim_once
  on public.affiliate_outreach_batches (created_by_grant_id, idempotency_key)
  where created_by_grant_id is not null and idempotency_key is not null;

alter table public.affiliate_outreach_drafts
  add column if not exists sent_by_grant_id uuid references public.silo_api_grants(id) on delete set null,
  add column if not exists sent_via_app text;

comment on column public.affiliate_outreach_drafts.sent_by_grant_id is
  'The AI connection that recorded this message as sent. sent_marked_by stays the person it acted for. Null when a person marked it. 20261110093000.';
comment on column public.affiliate_outreach_drafts.sent_via_app is
  'The application''s own name when an AI connection recorded the send, shown as "Via <app>". 20261110093000.';

-- ── 5. Helpers, not callable by any client ────────────────────────────────
-- The Affiliate Studio manager rule for a NAMED person and company. The tools
-- below act for the grant's person in the grant's company, which need not be
-- the session's active company, so can_manage_affiliate_programs() -- which
-- reads auth.uid() and active_company_id() -- cannot answer for them. Same
-- rule: exec/owner of that company (is_exec_or_owner_of_company's test), or an
-- affiliate_program_managers grant for it, on an active profile.
create or replace function public.affiliate_can_manage_for(p_user uuid, p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and p_company is not null and (
    exists (
      select 1
      from public.profiles p
      left join public.entity_memberships em
        on em.user_id = p.id and em.entity_id = p_company
      where p.id = p_user
        and coalesce(p.is_active, true) = true
        and case when em.role is not null
              then em.role = 'owner_admin' or lower(p.role::text) = 'executive'
              else lower(p.role::text) in ('owner', 'executive')
            end)
    or exists (
      select 1
      from public.affiliate_program_managers g
      join public.profiles p on p.id = g.user_id
      where g.user_id = p_user
        and g.company_entity_id = p_company
        and p.is_active = true))
$$;

comment on function public.affiliate_can_manage_for(uuid, uuid) is
  'can_manage_affiliate_programs()''s rule for a named person and company, for the outreach:send tools, which act for a grant rather than a session. Trusts its arguments, so no client role may call it. 20261110093000.';

revoke all on function public.affiliate_can_manage_for(uuid, uuid)
  from public, anon, authenticated, silo_integration, silo_revoked;

-- The application's display name for a grant, as silo_api_create_task
-- resolves it: the registration's own name, else the app key, else "an app".
create or replace function public.silo_api_app_name(p_client_id text, p_app_key text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select nullif(btrim(c.client_name), '')
       from auth.oauth_clients c
      where c.id::text = p_client_id
        and c.deleted_at is null
      limit 1),
    nullif(split_part(coalesce(p_app_key, ''), '|', 1), ''),
    'an app')
$$;

comment on function public.silo_api_app_name(text, text) is
  'The name an AI connection is shown as ("Via <name>"), resolved as silo_api_create_task does. Internal to the write tools. 20261110093000.';

revoke all on function public.silo_api_app_name(text, text)
  from public, anon, authenticated, silo_integration, silo_revoked;

-- The fence every outreach tool starts with. Returns the live grant, or
-- raises with the reason a bot can show the person.
create or replace function public.silo_api_outreach_grant()
returns public.silo_api_grants
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant public.silo_api_grants;
begin
  -- Scope first: this is also what records the call (20261103240000).
  perform public.silo_api_require_scope('outreach:send');

  if not public.silo_api_is_integration() then
    raise exception 'not_a_connection: this tool is for approved AI connections; use Affiliate Studio in SILO'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_grant from public.silo_api_grant() limit 1;
  if v_grant.id is null then
    raise exception 'integration_revoked: this connection is no longer approved'
      using errcode = 'insufficient_privilege';
  end if;
  if v_grant.writes_paused_at is not null then
    raise exception 'writes_paused: writing is switched off for this connection in Connected apps'
      using errcode = 'insufficient_privilege';
  end if;
  if v_grant.company_entity_id is null or v_grant.user_id is null then
    raise exception 'integration_revoked: this connection is not bound to a company'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from public.entity_memberships em
    where em.user_id = v_grant.user_id and em.entity_id = v_grant.company_entity_id) then
    raise exception 'not_a_member: the person who approved this connection is no longer in that company'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.affiliate_can_manage_for(v_grant.user_id, v_grant.company_entity_id) then
    raise exception 'not_an_affiliate_manager: the person who approved this connection does not manage affiliate programs in this company'
      using errcode = 'insufficient_privilege';
  end if;
  return v_grant;
end;
$$;

comment on function public.silo_api_outreach_grant() is
  'The shared fence of the outreach:send tools: scope, a live unpaused grant bound to a company, the approver still a member, and the Affiliate Studio manager rule for that company. Internal. 20261110093000.';

revoke all on function public.silo_api_outreach_grant()
  from public, anon, authenticated, silo_integration, silo_revoked;

-- One signup link for one claimed draft. Mints the token the way the
-- affiliate-invite edge function does (affiliate_issue_access_token, which
-- revokes the subject's previous unused signup link), creating the invited
-- affiliate record first if there is none. Returns the raw URL -- the only
-- time it exists -- or raises with a reason the claim reports per draft.
create or replace function public.affiliate_outreach_mint_signup(
  p_company uuid,
  p_program uuid,
  p_prospect uuid,
  p_email text,
  p_actor uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_p       public.affiliate_prospects;
  v_aff     uuid;
  v_status  text;
  v_raw     text;
  v_token   uuid;
  v_expires timestamptz := now() + interval '14 days';
begin
  select * into v_p from public.affiliate_prospects x
   where x.id = p_prospect and x.company_entity_id = p_company and x.program_id = p_program;
  if v_p.id is null then
    raise exception 'unknown_prospect';
  end if;
  if v_p.status not in ('approved', 'invited') then
    raise exception 'prospect_not_approved: the prospect is %', v_p.status;
  end if;

  select a.id, a.status into v_aff, v_status
    from public.affiliates a
   where a.company_entity_id = p_company and a.from_prospect_id = v_p.id
   limit 1;
  if v_aff is null then
    insert into public.affiliates
      (company_entity_id, program_id, display_name, contact_email, platform, handle,
       profile_url, status, from_prospect_id, created_by)
    values
      (p_company, p_program, coalesce(nullif(btrim(v_p.display_name), ''), nullif(btrim(v_p.handle), ''), p_email),
       p_email, v_p.platform, v_p.handle, v_p.profile_url, 'invited', v_p.id, p_actor)
    returning id, status into v_aff, v_status;
  end if;
  if v_status = 'active' then
    raise exception 'already_affiliate: this person is already an active affiliate';
  end if;

  -- 64 hex characters from two CSPRNG uuids (pg_catalog.gen_random_uuid uses
  -- pg_strong_random): 244 random bits, inside the portal's token pattern.
  -- Only the SHA-256 is stored, exactly as the edge function stores it.
  v_raw := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_token := public.affiliate_issue_access_token(
    p_company, p_program, 'signup',
    encode(sha256(convert_to(v_raw, 'UTF8')), 'hex'),
    v_expires, v_aff, null, p_actor);

  update public.affiliate_prospects
     set status = 'invited', affiliate_id = v_aff, updated_at = now()
   where id = v_p.id and company_entity_id = p_company;

  return json_build_object(
    'token_id', v_token,
    'affiliate_id', v_aff,
    'url', 'https://get-silo.com/v2/affiliates/join.html?t=' || v_raw,
    'expires_at', v_expires);
end;
$$;

comment on function public.affiliate_outreach_mint_signup(uuid, uuid, uuid, text, uuid) is
  'Mints one 14-day signup link for an approved prospect, creating the invited affiliate record if needed, as affiliate-invite''s signup_link does. Returns the raw URL once; only its SHA-256 is stored. Internal to silo_api_claim_outreach. 20261110093000.';

revoke all on function public.affiliate_outreach_mint_signup(uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated, silo_integration, silo_revoked;

-- ── 6. Claim approved outreach ────────────────────────────────────────────
create or replace function public.silo_api_claim_outreach(
  p_program_id      uuid default null,
  p_limit           integer default 10,
  p_idempotency_key text default null)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant    public.silo_api_grants;
  v_company  uuid;
  v_user     uuid;
  v_app      text;
  v_key      text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_program  uuid;
  v_batch    uuid;
  v_replay   boolean := false;
  v_used     integer;
  v_room     integer;
  v_limit    integer;
  v_d        record;
  v_link     json;
  v_claimed  jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_n        integer := 0;
begin
  v_grant   := public.silo_api_outreach_grant();
  v_company := v_grant.company_entity_id;
  v_user    := v_grant.user_id;
  v_app     := public.silo_api_app_name(v_grant.client_id, v_grant.app_key);

  if length(coalesce(v_key, '')) > 100 then
    raise exception 'invalid_idempotency_key: keep it under 100 characters'
      using errcode = 'check_violation';
  end if;

  -- A retry with the same key is the same claim: hand back what it claimed,
  -- with fresh links, and spend nothing.
  if v_key is not null then
    select b.id into v_batch
      from public.affiliate_outreach_batches b
     where b.created_by_grant_id = v_grant.id and b.idempotency_key = v_key;
    v_replay := v_batch is not null;
  end if;

  if not v_replay then
    if p_program_id is not null then
      select pr.id into v_program
        from public.affiliate_programs pr
       where pr.id = p_program_id and pr.company_entity_id = v_company;
      if v_program is null then
        raise exception 'unknown_program: that affiliate program is not in this company'
          using errcode = 'check_violation';
      end if;
      if not exists (select 1 from public.affiliate_programs pr
                      where pr.id = v_program and pr.status = 'active') then
        raise exception 'program_not_active: outreach goes out only for an active program'
          using errcode = 'check_violation';
      end if;
    else
      -- One program per claim, so one batch per claim: the program of the
      -- longest-waiting approved draft.
      select d.program_id into v_program
        from public.affiliate_outreach_drafts d
        join public.affiliate_programs pr on pr.id = d.program_id and pr.company_entity_id = v_company
       where d.company_entity_id = v_company
         and d.state = 'approved' and d.channel = 'email'
         and btrim(coalesce(d.recipient_email, '')) <> ''
         and pr.status = 'active'
       order by d.approved_at nulls last, d.id
       limit 1;
    end if;

    if v_program is null then
      return json_build_object(
        'claimed', '[]'::json, 'skipped', '[]'::json, 'replayed', false,
        'note', 'No approved email outreach is waiting. A person approves drafts in Affiliate Studio first.');
    end if;

    select count(*) into v_used
      from public.silo_api_writes w
     where w.grant_id = v_grant.id
       and w.created_at > now() - interval '1 day';
    v_room := public.silo_api_write_cap() - v_used;
    if v_room <= 0 then
      raise exception 'write_cap_reached: this connection has used its % writes for today', public.silo_api_write_cap()
        using errcode = 'check_violation';
    end if;
    v_limit := least(greatest(coalesce(p_limit, 10), 1), 25, v_room);

    insert into public.affiliate_outreach_batches
      (company_entity_id, program_id, channel, note, row_count, exported_at, exported_by,
       created_by, created_by_grant_id, created_by_app, idempotency_key)
    values
      (v_company, v_program, 'email', 'Via ' || v_app || ', to send from the approver''s own mailbox', 0, now(), v_user,
       v_user, v_grant.id, v_app, v_key)
    on conflict (created_by_grant_id, idempotency_key)
      where created_by_grant_id is not null and idempotency_key is not null
      do nothing
    returning id into v_batch;

    if v_batch is null then
      -- A parallel call with the same key won the insert.
      select b.id into v_batch
        from public.affiliate_outreach_batches b
       where b.created_by_grant_id = v_grant.id and b.idempotency_key = v_key;
      v_replay := true;
    end if;
  end if;

  if v_replay then
    select b.program_id into v_program from public.affiliate_outreach_batches b where b.id = v_batch;
  end if;

  for v_d in
    select d.id, d.prospect_id, d.recipient_email, d.recipient_handle, d.subject, d.body,
           p.handle, p.profile_url
      from public.affiliate_outreach_drafts d
      join public.affiliate_prospects p on p.id = d.prospect_id and p.company_entity_id = v_company
     where d.company_entity_id = v_company
       and d.program_id = v_program
       and d.channel = 'email'
       and btrim(coalesce(d.recipient_email, '')) <> ''
       and case when v_replay
             then d.batch_id = v_batch and d.state = 'exported'
             else d.state = 'approved'
           end
     order by d.approved_at nulls last, d.id
     for update of d skip locked
  loop
    -- Stop at the limit by what was CLAIMED, not by rows looked at: a
    -- suppressed recipient at the head of the queue must not use up a claim.
    exit when not v_replay and v_n >= v_limit;
    exit when v_replay and v_n >= 25;
    begin
      if not public.affiliate_outreach_can_contact(
           v_company, v_program, v_d.recipient_email, v_d.handle, v_d.profile_url) then
        raise exception 'suppressed: this recipient asked not to be contacted';
      end if;

      v_link := public.affiliate_outreach_mint_signup(
        v_company, v_program, v_d.prospect_id, lower(btrim(v_d.recipient_email)), v_user);

      update public.affiliate_outreach_drafts
         set state = 'exported', batch_id = v_batch, exported_at = coalesce(exported_at, now()),
             token_id = (v_link ->> 'token_id')::uuid, changed_by = v_user
       where id = v_d.id;

      if not v_replay then
        insert into public.silo_api_writes
          (company_entity_id, grant_id, user_id, via, kind, target_id)
        values
          (v_company, v_grant.id, v_user, 'app', 'outreach_claim', v_d.id);
      end if;

      v_n := v_n + 1;
      v_claimed := v_claimed || jsonb_build_object(
        'draft_id', v_d.id,
        'to', lower(btrim(v_d.recipient_email)),
        'subject', v_d.subject,
        'body', case when position('{signup_link}' in coalesce(v_d.body, '')) > 0
                  then replace(v_d.body, '{signup_link}', v_link ->> 'url')
                  else coalesce(v_d.body, '') || E'\n\n' || (v_link ->> 'url') end,
        'signup_url', v_link ->> 'url',
        'signup_url_expires_at', v_link ->> 'expires_at');
    exception when others then
      -- One bad draft does not sink the rest; it stays approved (or, on a
      -- replay, exported) and the reason goes back to the bot.
      if jsonb_array_length(v_skipped) < 25 then
        v_skipped := v_skipped || jsonb_build_object(
          'draft_id', v_d.id, 'reason', split_part(sqlerrm, ':', 1), 'detail', sqlerrm);
      end if;
    end;
  end loop;

  if not v_replay then
    update public.affiliate_outreach_batches set row_count = v_n where id = v_batch;
  end if;

  return json_build_object(
    'batch_id', v_batch,
    'program_id', v_program,
    'replayed', v_replay,
    'claimed', v_claimed,
    'skipped', v_skipped,
    'via', v_app,
    'next_step', case when v_n > 0 then
      'Send each message exactly as written, one email per recipient, from the person''s own mailbox, to the "to" address only. '
      || 'Then call mark_outreach_sent with its draft_id and the sent message''s id. Do not send to anyone not listed here, '
      || 'and do not add recipients, BCCs or follow-ups. A message you do not send stays in Affiliate Studio as exported.'
      end);
end;
$$;

comment on function public.silo_api_claim_outreach(uuid, integer, text) is
  'MCP / developer API tool (outreach:send): claims up to 25 APPROVED email outreach drafts of one active affiliate program in the grant''s company, mints each a fresh 14-day signup link, and moves them to exported in a batch tagged with the connection ("Via <app>"), for the person''s own AI to send from their own mailbox. Suppressed recipients and active affiliates are skipped with a reason. Each claimed draft is one write against silo_api_write_cap(); the same idempotency key returns the same drafts with re-minted links and spends nothing. SILO sends nothing. 20261110093000.';

revoke all on function public.silo_api_claim_outreach(uuid, integer, text)
  from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_claim_outreach(uuid, integer, text) to silo_integration;

-- ── 7. Record a send ──────────────────────────────────────────────────────
create or replace function public.silo_api_mark_outreach_sent(
  p_draft_id uuid,
  p_evidence text)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant    public.silo_api_grants;
  v_company  uuid;
  v_user     uuid;
  v_app      text;
  v_evidence text := btrim(coalesce(p_evidence, ''));
  v_d        record;
begin
  v_grant   := public.silo_api_outreach_grant();
  v_company := v_grant.company_entity_id;
  v_user    := v_grant.user_id;
  v_app     := public.silo_api_app_name(v_grant.client_id, v_grant.app_key);

  if v_evidence = '' then
    raise exception 'evidence_required: pass the sent message''s id (or another reference a person can look up)'
      using errcode = 'check_violation';
  end if;
  if length(v_evidence) > 500 then
    raise exception 'invalid_evidence: keep the evidence under 500 characters'
      using errcode = 'check_violation';
  end if;

  select d.id, d.state, d.sent_by_grant_id, d.sent_evidence, b.created_by_grant_id
    into v_d
    from public.affiliate_outreach_drafts d
    left join public.affiliate_outreach_batches b on b.id = d.batch_id
   where d.id = p_draft_id and d.company_entity_id = v_company
   for update of d;

  if v_d.id is null then
    raise exception 'unknown_draft: no such outreach draft in this company'
      using errcode = 'check_violation';
  end if;

  -- Already recorded by this connection: the same answer, no second change.
  if v_d.state = 'sent' and v_d.sent_by_grant_id = v_grant.id then
    return json_build_object('draft_id', v_d.id, 'state', 'sent', 'replayed', true,
      'evidence', v_d.sent_evidence, 'via', v_app);
  end if;

  if v_d.state <> 'exported' or v_d.created_by_grant_id is distinct from v_grant.id then
    raise exception 'not_claimed_here: only a draft this connection claimed with claim_outreach_to_send and has not been recorded yet can be marked sent'
      using errcode = 'check_violation';
  end if;

  -- The drafts guard re-checks the suppression list on this state change, so
  -- an opt-out that arrived after the claim refuses here with its own words.
  update public.affiliate_outreach_drafts
     set state = 'sent', sent_marked_by = v_user, sent_marked_at = now(),
         sent_evidence = v_evidence, sent_by_grant_id = v_grant.id, sent_via_app = v_app,
         changed_by = v_user
   where id = v_d.id;

  return json_build_object('draft_id', v_d.id, 'state', 'sent', 'replayed', false,
    'evidence', v_evidence, 'via', v_app);
end;
$$;

comment on function public.silo_api_mark_outreach_sent(uuid, text) is
  'MCP / developer API tool (outreach:send): records ONE outreach draft this connection claimed as sent, with the sent message''s id as evidence, as the person who approved the connection and tagged with the app ("Via <app>"). Refuses a draft a person exported by hand, another connection''s claim, and a recipient suppressed since the claim. Repeating it returns the first record. Not counted against the write cap: it can only follow a claim, which was. 20261110093000.';

revoke all on function public.silo_api_mark_outreach_sent(uuid, text)
  from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_mark_outreach_sent(uuid, text) to silo_integration;

select public.attach_stamp_company_entity_id_triggers();
select public.refresh_chat_schema_catalog();

notify pgrst, 'reload schema';

commit;
