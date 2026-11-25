-- po_status:write -- the step a purchase order is at, moved by the person's
-- own AI, without drafting a delivery.
--
-- receiving:write (20261117220000) let a connected AI read a PO's lines and
-- DRAFT a delivery for someone to confirm. Everything else about a PO's
-- progress -- "sent to factory", "in production", "shipped" -- was a person
-- typing in PO Report, even when they had just told their AI that it had
-- happened and the AI had the document in front of it. A receipt was the only
-- way in, so the common case (nothing has arrived yet; the factory simply has
-- the order) had to be forced through a shipment or left undone.
--
-- Blake, 2026-11-25: "if they approve in their llm to mark as something, it
-- shouldn't require them to then go into silo to approve second time." So this
-- is NOT a draft. The person decides in their own AI client; SILO applies the
-- status there and then, and spends one of the connection's daily writes on
-- it. What stands in for the second confirmation is the fence:
--
--   * Its own consent box. po_status:write is never implied by another scope,
--     and pausing writes on the connection pauses it.
--   * The STEPS ARE COMPANY DATA, not code. po_status_options holds each
--     company's own list, and only a row flagged ai_settable may be set by a
--     connection. SILO ships a default list for the workflow it already had,
--     seeded per company, and an admin can rename, add or withdraw a step
--     without a deploy. Nothing here names a company.
--   * Quantities still go through a receipt. A step flagged needs_receipt
--     ('Received', 'Partially Received' by default) is refused with a pointer
--     to record_shipment_receipt, so arrival keeps meaning "a person confirmed
--     a delivery against these lines" and does not become a word an AI typed.
--     Approval and cancellation are not ai_settable at all.
--   * Authority is the APPROVING PERSON's, judged against the grant's company:
--     admin there, or the PO's own creator -- the same two ways po_headers'
--     UPDATE policy lets anyone change a PO. A connection cannot give its
--     person authority they do not have.
--   * Every change is on the record twice: po_status_changes (the reason, the
--     document, the app, the person, the idempotency key) and the PO's own
--     po_status_history row, which this stamps with the approving person and
--     "Via <app>" rather than leaving the trigger's defaults.
--
-- 20261125234500.

-- -- 1. The po_status:write scope ---------------------------------------------
-- Re-stated from 20261117220000 (production matches it) with ONE line
-- changed: c_offered.
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
  -- codes:create since 20261110160000: reading the affiliate codes a person
  -- asked to have created in Shopify, and recording each one the person's own
  -- AI created there. Its own box; never implied by another scope.
  -- receiving:write since 20261117220000: reading a purchase order's lines so
  -- the person's own AI can record a shipment receipt against them, as a DRAFT
  -- a person confirms in SILO. Its own box; never implied by another scope.
  -- po_status:write since 20261125234500: moving a purchase order to one of
  -- the steps this company allows an AI to set, applied when the person says
  -- so in their own AI client. Its own box; never implied by receiving:write,
  -- and it can never set a step that needs a delivery confirmed.
  c_offered constant text[] := array['reports:read', 'data:read', 'work:write', 'outreach:send', 'codes:create', 'receiving:write', 'po_status:write'];
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
  'Writes the SILO grant row for an approved application: aal2 required, scopes from the allowlist (reports:read, data:read, work:write, outreach:send, codes:create, receiving:write, po_status:write) and a scope outside it is REFUSED rather than dropped, up to silo_api_app_connection_limit() live connections per person per application in numbered slots. 20261020030000; app_key 20261102180000; slots 20261104020000; work:write 20261104230000; strict scopes 20261104234500; outreach:send 20261110093000; codes:create 20261110160000; receiving:write 20261117220000; po_status:write 20261125234500.';

revoke all on function public.silo_api_consent(text, text[]) from public, anon;
grant execute on function public.silo_api_consent(text, text[]) to authenticated;

-- -- 2. The paths the developer platform exposes ------------------------------
-- Re-stated from 20261117220000 (production matches it) with three paths added.
create or replace function public.silo_api_path_allowed()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('request.path', true), '') in (
    '/rpc/silo_api_run_report', '/rpc/silo_api_list_reports',
    '/rpc/silo_api_describe_tables', '/rpc/silo_api_query',
    '/rpc/silo_api_windsor_connections',
    '/rpc/silo_api_create_task',
    '/rpc/silo_api_scopes',
    '/rpc/silo_api_claim_outreach',
    '/rpc/silo_api_mark_outreach_sent',
    '/rpc/silo_api_codes_to_create',
    '/rpc/silo_api_mark_code_created',
    '/rpc/silo_api_connect',
    '/rpc/silo_api_record_failure',
    '/rpc/silo_api_pos_awaiting_receipt',
    '/rpc/silo_api_po_lines_for_receiving',
    '/rpc/silo_api_record_shipment_receipt',
    '/rpc/silo_api_po_status_options',
    '/rpc/silo_api_pos_for_status',
    '/rpc/silo_api_set_po_status')
$$;

comment on function public.silo_api_path_allowed() is
  'True when a third-party OAuth request is on one of the paths the developer platform exposes: running and listing reports (reports:read), describing tables, running a read-only query and reading published connections (data:read), opening a task (work:write), reading this connection''s own scopes and recording a handshake or a failure (no scope needed), claiming approved affiliate outreach and marking it sent (outreach:send), reading affiliate codes waiting for Shopify and recording one as created (codes:create), listing the purchase orders awaiting a delivery, reading one''s lines and recording a DRAFT shipment receipt against it (receiving:write), and reading the steps a purchase order can be moved to, listing the purchase orders that can be moved and setting one''s step (po_status:write). Every other path is refused by silo_check_request(). 20261030050000; query 20261030110000; connections 20261103210000; create_task 20261104230000; scopes 20261104234500; outreach 20261110093000; codes 20261110160000; connect and failures 20261112030000; receiving 20261117220000; po status 20261125234500.';

-- One more kind of write against the connection's daily cap.
alter table public.silo_api_writes drop constraint if exists silo_api_writes_kind_check;
alter table public.silo_api_writes
  add constraint silo_api_writes_kind_check
  check (kind in ('task', 'outreach_claim', 'code_created', 'shipment_receipt', 'po_status'));

-- -- 3. The steps, as company data --------------------------------------------
-- The eleven-step list SILO already had lived in v2/po-builder.html as a
-- JavaScript constant, so a company could not name its own steps and nothing
-- outside that page could say which steps an AI may set. Both now live here.
create table if not exists public.po_status_options (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  name text not null,
  sort_order integer not null default 100,

  -- An order that is placed and has not finished arriving: what "on order"
  -- and "incoming" mean on every purchasing surface.
  is_open boolean not null default true,

  -- The only steps a connected AI may set. Off by default, so a step added
  -- later is a person's until someone decides otherwise.
  ai_settable boolean not null default false,

  -- A step that means units arrived. Refused to a connection whatever
  -- ai_settable says, with a pointer to record_shipment_receipt: arrival has
  -- to stay a delivery a person confirmed against the lines, not a word.
  needs_receipt boolean not null default false,

  -- The end of the line: a PO at this step is not listed to a connection at
  -- all, because there is no next step for an AI to set. Not the same as
  -- is_open false -- a draft is not an open order either, and "the factory has
  -- it now" is exactly the step a draft moves to.
  is_final boolean not null default false,

  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  constraint po_status_options_name_unique unique (company_entity_id, name),
  constraint po_status_options_name_len check (length(btrim(name)) between 1 and 60)
);

create index if not exists po_status_options_company_idx
  on public.po_status_options (company_entity_id, sort_order);

comment on table public.po_status_options is
  'The steps a purchase order can be at, per company: the list PO Builder offers, which of them count as an open order (is_open), which a connected AI may set itself (ai_settable), which mean units arrived and so must go through a confirmed delivery instead (needs_receipt) and which are the end of the line (is_final). Company DATA: renaming or withdrawing a step is an update here, not a deploy. Seeded from SILO''s default list for every company that has purchase orders. 20261125234500.';

alter table public.po_status_options enable row level security;

drop policy if exists po_status_options_active_select on public.po_status_options;
create policy po_status_options_active_select on public.po_status_options
  for select to authenticated
  using (company_entity_id = (select public.active_company_id()));

drop policy if exists po_status_options_admin_write on public.po_status_options;
create policy po_status_options_admin_write on public.po_status_options
  for all to authenticated
  using (company_entity_id = (select public.active_company_id()) and (select public.is_admin_user()))
  with check (company_entity_id = (select public.active_company_id()) and (select public.is_admin_user()));

grant select on public.po_status_options to authenticated;
grant insert, update, delete on public.po_status_options to authenticated;

drop trigger if exists trg_po_status_options_updated_at on public.po_status_options;
create trigger trg_po_status_options_updated_at
  before update on public.po_status_options
  for each row execute function public.set_updated_at();

-- SILO's default workflow -- the product's own list, not any company's. A new
-- company starts here and edits from there.
create or replace function public.po_status_default_options()
returns table (name text, sort_order integer, is_open boolean, ai_settable boolean, needs_receipt boolean, is_final boolean)
language sql
immutable
set search_path = ''
as $$
  select *
    from (values
      ('Draft',              10, false, false, false, false),
      ('Approved',           20, true,  false, false, false),
      ('Sent to Factory',    30, true,  true,  false, false),
      ('Confirmed',          40, true,  true,  false, false),
      ('In Production',      50, true,  true,  false, false),
      ('Shipped',            60, true,  true,  false, false),
      ('In Transit',         70, true,  true,  false, false),
      ('Partially Received', 80, true,  false, true,  false),
      ('Received',           90, false, false, true,  true),
      ('Closed',            100, false, false, false, true),
      ('Cancelled',         110, false, false, false, true)
    ) as t(name, sort_order, is_open, ai_settable, needs_receipt, is_final)
$$;

comment on function public.po_status_default_options() is
  'SILO''s default purchase-order steps, with which count as open, which a connected AI may set, which need a confirmed delivery and which are the end of the line. The product''s own list: seeded into po_status_options per company, never read in place of it. 20261125234500.';

-- Seed every company that has purchase orders: the default list, plus any
-- status its POs already carry that the default list does not name (as an
-- inactive-for-AI step, so an unexpected word keeps working everywhere it
-- already appears without becoming settable by a connection).
insert into public.po_status_options (company_entity_id, name, sort_order, is_open, ai_settable, needs_receipt, is_final)
select h.company_entity_id, d.name, d.sort_order, d.is_open, d.ai_settable, d.needs_receipt, d.is_final
  from (select distinct company_entity_id from public.po_headers where company_entity_id is not null) h
 cross join public.po_status_default_options() d
on conflict (company_entity_id, name) do nothing;

insert into public.po_status_options (company_entity_id, name, sort_order, is_open, ai_settable, needs_receipt, is_final)
select distinct h.company_entity_id, btrim(h.status), 200, true, false, false, false
  from public.po_headers h
 where h.company_entity_id is not null
   and coalesce(btrim(h.status), '') <> ''
   and not exists (
     select 1 from public.po_status_default_options() d where d.name = btrim(h.status))
on conflict (company_entity_id, name) do nothing;

-- A company that had no purchase orders when this was applied has no steps,
-- and its first PO may well be created by a person who is not an admin -- so
-- the list is also seeded on first use, rather than leaving a new workspace
-- with nothing an AI (or the builder) could offer.
create or replace function public.po_status_options_ensure(p_company uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_company is null then return; end if;
  if exists (select 1 from public.po_status_options o where o.company_entity_id = p_company) then
    return;
  end if;
  insert into public.po_status_options
    (company_entity_id, name, sort_order, is_open, ai_settable, needs_receipt, is_final)
  select p_company, d.name, d.sort_order, d.is_open, d.ai_settable, d.needs_receipt, d.is_final
    from public.po_status_default_options() d
  on conflict (company_entity_id, name) do nothing;
end;
$$;

comment on function public.po_status_options_ensure(uuid) is
  'Seeds one company''s purchase-order steps from po_status_default_options() if it has none yet -- for a workspace that had no POs when 20261125234500 was applied. Does nothing once the company has a list of its own, so an edited list is never restored. Internal. 20261125234500.';

revoke all on function public.po_status_options_ensure(uuid)
  from public, anon, authenticated, silo_integration, silo_revoked;

-- The browser's way in: PO Builder seeds the workspace it is actually looking
-- at. It takes NO company, because a definer function that seeds whichever
-- company id it is handed is a cross-tenant write with extra steps.
create or replace function public.po_status_options_ensure()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.po_status_options_ensure(public.active_company_id());
end;
$$;

comment on function public.po_status_options_ensure() is
  'Seeds the ACTIVE company''s purchase-order steps if it has none yet. What PO Builder calls before reading the list, so a workspace whose first PO has not been created yet still has a status dropdown. 20261125234500.';

revoke all on function public.po_status_options_ensure() from public, anon, silo_integration, silo_revoked;
grant execute on function public.po_status_options_ensure() to authenticated;

-- -- 4. What a connection changed ---------------------------------------------
-- The record of each status an AI set: who approved the connection, which app,
-- why, and the document it was read from. po_status_history records the
-- transition; this records the authority and the reason behind it.
create table if not exists public.po_status_changes (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  po_header_id uuid not null references public.po_headers(id) on delete cascade,
  old_status text,
  new_status text not null,
  reason text,
  source_label text,
  source_url text,
  grant_id uuid references public.silo_api_grants(id) on delete set null,
  requested_by uuid,
  via_app text,
  idempotency_key text,
  created_at timestamptz not null default now()
);

create unique index if not exists po_status_changes_grant_key_unique
  on public.po_status_changes (grant_id, idempotency_key)
  where grant_id is not null and idempotency_key is not null;

create index if not exists po_status_changes_po_idx
  on public.po_status_changes (po_header_id, created_at desc);

create index if not exists po_status_changes_company_idx
  on public.po_status_changes (company_entity_id, created_at desc);

comment on table public.po_status_changes is
  'Every purchase-order step a connected AI set through po_status:write: the PO, the step it came from and went to, the reason the AI gave, the document it read (label and link), the application, the person whose connection it was and the idempotency key. The transition itself is in po_status_history; this is why it happened and on whose authority. 20261125234500.';

alter table public.po_status_changes enable row level security;

drop policy if exists po_status_changes_active_select on public.po_status_changes;
create policy po_status_changes_active_select on public.po_status_changes
  for select to authenticated
  using (company_entity_id = (select public.active_company_id()));

grant select on public.po_status_changes to authenticated;

-- -- 5. The shared fence of the po_status:write tools -------------------------
-- The same fence receiving:write carries (20261117220000): the scope, a live
-- unpaused grant bound to a company, and the person who approved it still an
-- active member of it.
create or replace function public.silo_api_po_status_grant()
returns public.silo_api_grants
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grant public.silo_api_grants;
begin
  -- Scope first: this is also what records the call (20261103240000).
  perform public.silo_api_require_scope('po_status:write');

  if not public.silo_api_is_integration() then
    raise exception 'not_a_connection: this tool is for approved AI connections; use PO Report in SILO'
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
  if not exists (
    select 1 from public.profiles p
    where p.id = v_grant.user_id and coalesce(p.is_active, true) = true) then
    raise exception 'not_active: the person who approved this connection is no longer active'
      using errcode = 'insufficient_privilege';
  end if;
  return v_grant;
end;
$$;

comment on function public.silo_api_po_status_grant() is
  'The shared fence of the po_status:write tools: scope, a live unpaused grant bound to a company, and the approver still an active member of it. Internal. 20261125234500.';

revoke all on function public.silo_api_po_status_grant()
  from public, anon, authenticated, silo_integration, silo_revoked;

-- Whether the person who approved the connection may change THIS purchase
-- order, judged against the GRANT's company and never a session's: admin
-- there, or the PO's own creator. Those are the two ways po_headers'
-- UPDATE policy lets anyone change a PO, so a connection can never move a PO
-- its person could not move in SILO.
create or replace function public.silo_api_may_set_po_status(p_user uuid, p_company uuid, p_po_header_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.po_headers h
      join public.profiles p on p.id = p_user and coalesce(p.is_active, true) = true
      left join public.entity_memberships em
        on em.user_id = p_user and em.entity_id = p_company
     where h.id = p_po_header_id
       and h.company_entity_id = p_company
       and (h.created_by = p_user
            or case when em.role is not null
                      then em.role in ('owner_admin', 'admin')
                      else p.role::text in ('owner', 'admin')
                 end))
$$;

comment on function public.silo_api_may_set_po_status(uuid, uuid, uuid) is
  'True when that person may change that purchase order''s step in that company -- admin of the company, or the PO''s creator -- which is what po_headers'' UPDATE policy allows. Judged against the grant''s company, never a session''s. Internal. 20261125234500.';

revoke all on function public.silo_api_may_set_po_status(uuid, uuid, uuid)
  from public, anon, authenticated, silo_integration, silo_revoked;

-- -- 6. The steps this company allows ----------------------------------------
create or replace function public.silo_api_po_status_options()
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant   public.silo_api_grants;
  v_company uuid;
  v_steps   json;
begin
  v_grant   := public.silo_api_po_status_grant();
  v_company := v_grant.company_entity_id;
  perform public.po_status_options_ensure(v_company);

  select coalesce(json_agg(x order by x.sort_order, x.status), '[]'::json) into v_steps
    from (
      select o.name as status, o.sort_order, o.is_open, o.ai_settable, o.needs_receipt, o.is_final
        from public.po_status_options o
       where o.company_entity_id = v_company
         and o.is_active = true) x;

  return json_build_object(
    'steps', v_steps,
    'timezone', public.silo_company_timezone(v_company),
    'how_to_use',
      'These are this company''s own purchase-order steps, in order. You may set only a step with '
      || 'ai_settable true, and only when the person has told you to -- SILO applies it immediately and '
      || 'there is no second confirmation in SILO, so ask them first and then call set_po_status. A step '
      || 'with needs_receipt true means units arrived: record it with record_shipment_receipt against the '
      || 'PO''s lines instead, so a person confirms what was delivered. Approving and cancelling a PO are '
      || 'not an AI''s to do.',
    'note', case when json_array_length(v_steps) = 0 then
      'This company has no purchase-order steps configured, so nothing can be set.' end);
end;
$$;

comment on function public.silo_api_po_status_options() is
  'MCP / developer API tool (po_status:write): this company''s purchase-order steps in order, with which count as an open order, which a connection may set, which need a confirmed delivery instead and which are the end of the line. Reads only. 20261125234500.';

revoke all on function public.silo_api_po_status_options()
  from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_po_status_options() to silo_integration;

-- -- 7. Which POs can be moved -----------------------------------------------
-- Not pos_awaiting_receipt: that one hides Draft POs, and "the factory has the
-- order now" is the step a draft most often moves to.
create or replace function public.silo_api_pos_for_status(p_search text default null, p_limit integer default 25)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant   public.silo_api_grants;
  v_company uuid;
  v_user    uuid;
  v_search  text := nullif(btrim(coalesce(p_search, '')), '');
  v_pos     json;
  v_steps   text[];
begin
  v_grant   := public.silo_api_po_status_grant();
  v_company := v_grant.company_entity_id;
  v_user    := v_grant.user_id;
  perform public.po_status_options_ensure(v_company);

  select coalesce(array_agg(o.name order by o.sort_order, o.name), '{}') into v_steps
    from public.po_status_options o
   where o.company_entity_id = v_company and o.is_active = true and o.ai_settable = true;

  select coalesce(json_agg(x order by x.order_date desc nulls last, x.po_name), '[]'::json) into v_pos
    from (
      select h.id as po_header_id, h.po_name, h.status, h.order_date,
             h.expected_arrival_date, f.factory_name as factory,
             (select count(*) from public.po_lines l where l.po_header_id = h.id) as lines,
             public.silo_api_may_set_po_status(v_user, v_company, h.id) as you_may_set_its_step
        from public.po_headers h
        left join public.factories f on f.id = h.factory_id
       where h.company_entity_id = v_company
         and (h.status is null
              or not exists (
                select 1 from public.po_status_options o
                 where o.company_entity_id = v_company
                   and o.name = h.status
                   and o.is_final = true))
         and (v_search is null
              or h.po_name ilike '%' || v_search || '%'
              or f.factory_name ilike '%' || v_search || '%')
       order by h.order_date desc nulls last, h.po_name
       limit least(greatest(coalesce(p_limit, 25), 1), 100)) x;

  return json_build_object(
    'purchase_orders', v_pos,
    'steps_you_may_set', to_json(v_steps),
    'timezone', public.silo_company_timezone(v_company),
    'next',
      'Pass one po_header_id to set_po_status with the step the person asked for. A PO whose '
      || 'you_may_set_its_step is false cannot be moved by this connection -- say so and give the person '
      || 'the SILO link rather than trying. A PO at one of this company''s final steps -- received, '
      || 'closed or cancelled, unless it says otherwise -- is not listed, because no step follows it.',
    'note', case when json_array_length(v_pos) = 0 then
      'No purchase order matches. A PO at a final step is not listed.' end);
end;
$$;

comment on function public.silo_api_pos_for_status(text, integer) is
  'MCP / developer API tool (po_status:write): the purchase orders whose step can still move -- everything except the steps this company marks final -- with the current step, the factory, the line count and whether the connection''s own person may move that PO. Reads only. 20261125234500.';

revoke all on function public.silo_api_pos_for_status(text, integer)
  from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_pos_for_status(text, integer) to silo_integration;

-- -- 8. Set the step ----------------------------------------------------------
create or replace function public.silo_api_set_po_status(
  p_po_header_id uuid,
  p_status text,
  p_idempotency_key text,
  p_reason text default null,
  p_source_label text default null,
  p_source_url text default null)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant   public.silo_api_grants;
  v_company uuid;
  v_user    uuid;
  v_app     text;
  v_key     text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_status  text := nullif(btrim(coalesce(p_status, '')), '');
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_po      record;
  v_opt     record;
  v_prior   public.po_status_changes;
  v_change  uuid;
  v_hist    uuid;
  v_used    integer;
  v_rows    integer;
begin
  v_grant   := public.silo_api_po_status_grant();
  v_company := v_grant.company_entity_id;
  v_user    := v_grant.user_id;
  v_app     := public.silo_api_app_name(v_grant.client_id, v_grant.app_key);
  perform public.po_status_options_ensure(v_company);

  if v_key is null or length(v_key) > 100 then
    raise exception 'idempotency_key_required: pass your own id for this change, up to 100 characters, and reuse it if you retry'
      using errcode = 'check_violation';
  end if;

  -- A retry is the same change, never a second one. Answered before anything
  -- else is validated, so a retry cannot be refused by a PO that has moved on
  -- in the meantime.
  select c.* into v_prior
    from public.po_status_changes c
   where c.grant_id = v_grant.id and c.idempotency_key = v_key;
  if v_prior.id is not null then
    return json_build_object(
      'applied', true, 'replayed', true,
      'po_header_id', v_prior.po_header_id,
      'old_status', v_prior.old_status, 'new_status', v_prior.new_status,
      'set_at', v_prior.created_at, 'via', v_prior.via_app,
      'open_in_silo', '/v2/po-report.html');
  end if;

  if v_status is null then
    raise exception 'status_required: pass the step to set, exactly as po_status_options names it'
      using errcode = 'check_violation';
  end if;

  select h.id, h.po_name, h.status, h.created_by into v_po
    from public.po_headers h
   where h.id = p_po_header_id and h.company_entity_id = v_company;
  if v_po.id is null then
    raise exception 'unknown_po: no such purchase order in this company'
      using errcode = 'check_violation';
  end if;

  -- The step must be one this company has, and one it lets a connection set.
  -- Matched case-insensitively, because a model retyping "sent to factory" is
  -- not a different step -- but an EXACT match wins, so two steps a company
  -- named with different capitals can never resolve to whichever row came
  -- back first.
  select o.name, o.ai_settable, o.needs_receipt into v_opt
    from public.po_status_options o
   where o.company_entity_id = v_company
     and o.is_active = true
     and lower(o.name) = lower(v_status)
   order by (o.name = v_status) desc, o.name
   limit 1;

  if v_opt.name is null then
    raise exception 'unknown_status: "%" is not one of this company''s purchase-order steps. Call po_status_options and use a name exactly as it appears there.', v_status
      using errcode = 'check_violation';
  end if;

  if v_opt.needs_receipt then
    raise exception 'needs_receipt: "%" means units arrived, so it is recorded by confirming a delivery against the PO''s lines -- use record_shipment_receipt instead.', v_opt.name
      using errcode = 'check_violation';
  end if;

  if not v_opt.ai_settable then
    raise exception 'status_not_settable: "%" is a step a person sets in SILO, not a connection. po_status_options says which steps you may set.', v_opt.name
      using errcode = 'check_violation';
  end if;

  -- The authority is the approving person's, and it is theirs TODAY.
  if not public.silo_api_may_set_po_status(v_user, v_company, v_po.id) then
    raise exception 'not_permitted: the person who approved this connection may not change this purchase order in SILO, so neither may this connection. Send them the PO in SILO instead.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Already there: nothing to change, nothing to record, and no write spent.
  if v_po.status is not distinct from v_opt.name then
    return json_build_object(
      'applied', false, 'changed', false, 'reason', 'already_set',
      'po_header_id', v_po.id, 'po_name', v_po.po_name,
      'old_status', v_po.status, 'new_status', v_opt.name,
      'say', 'That purchase order is already at that step, so nothing changed.',
      'open_in_silo', '/v2/po-report.html');
  end if;

  -- The cap, taken one call at a time, as every other write tool does
  -- (20261110160000): two calls cannot both see the last free write.
  perform pg_advisory_xact_lock(hashtextextended('silo_api_writes:' || v_grant.id::text, 0));
  select count(*) into v_used
    from public.silo_api_writes w
   where w.grant_id = v_grant.id
     and w.created_at > now() - interval '1 day';
  if v_used >= public.silo_api_write_cap() then
    raise exception 'write_cap_reached: this connection has used its % writes for today', public.silo_api_write_cap()
      using errcode = 'check_violation';
  end if;

  update public.po_headers
     set status = v_opt.name
   where id = v_po.id
     and company_entity_id = v_company
     and status is not distinct from v_po.status;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'po_moved: that purchase order''s step changed while this was being recorded. Read it again and ask the person before setting it.'
      using errcode = 'check_violation';
  end if;

  -- The PO's own history row exists already (log_po_status_change, corrected
  -- in this migration to record whoever made the change). auth.uid() inside a
  -- connection's call IS the approving person, so this mostly confirms what
  -- the trigger wrote -- but it is written explicitly anyway, because the
  -- authority here is the GRANT's and must not depend on a session claim, and
  -- because the note is where the app and the reason go.
  select h.id into v_hist
    from public.po_status_history h
   where h.po_header_id = v_po.id
     and h.new_status = v_opt.name
   order by h.changed_at desc, h.id desc
   limit 1;

  if v_hist is not null then
    update public.po_status_history
       set changed_by = v_user,
           company_entity_id = v_company,
           note = 'Via ' || coalesce(v_app, 'an AI connection')
                  || case when v_reason is not null then ' - ' || v_reason else '' end
     where id = v_hist;
  end if;

  insert into public.po_status_changes
    (company_entity_id, po_header_id, old_status, new_status, reason,
     source_label, source_url, grant_id, requested_by, via_app, idempotency_key)
  values
    (v_company, v_po.id, v_po.status, v_opt.name, v_reason,
     nullif(btrim(coalesce(p_source_label, '')), ''),
     nullif(btrim(coalesce(p_source_url, '')), ''),
     v_grant.id, v_user, v_app, v_key)
  returning id into v_change;

  insert into public.silo_api_writes
    (company_entity_id, grant_id, user_id, via, kind, target_id, idempotency_key)
  values (v_company, v_grant.id, v_user, 'app', 'po_status', v_po.id, v_key);

  return json_build_object(
    'applied', true, 'changed', true, 'replayed', false,
    'change_id', v_change,
    'po_header_id', v_po.id, 'po_name', v_po.po_name,
    'old_status', v_po.status, 'new_status', v_opt.name,
    'via', v_app,
    'say',
      'Set ' || coalesce(v_po.po_name, 'the purchase order') || ' to ' || v_opt.name
      || ' in SILO. It is live now -- nobody has to confirm it -- and PO Report shows who set it and why.',
    'open_in_silo', '/v2/po-report.html');
end;
$$;

comment on function public.silo_api_set_po_status(uuid, text, text, text, text, text) is
  'MCP / developer API tool (po_status:write): moves one purchase order to one of the steps this company marks ai_settable, applied immediately -- there is no second confirmation in SILO, so the person must have asked for it. Refuses a step that needs a confirmed delivery (use record_shipment_receipt), a step a person keeps, and a PO the approving person may not change in SILO. Records the reason, the document and the app in po_status_changes and stamps the PO''s po_status_history row with the approving person and "Via <app>". One write against silo_api_write_cap(); the same idempotency_key returns the first change. 20261125234500.';

revoke all on function public.silo_api_set_po_status(uuid, text, text, text, text, text)
  from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_set_po_status(uuid, text, text, text, text, text) to silo_integration;

-- -- 8b. Who changed a PO's step, for everyone -------------------------------
-- log_po_status_change() exists in no migration (it was applied by hand) and
-- has recorded the WRONG person since it was written: `new.created_by` is the
-- PO's CREATOR, so every status change in po_status_history -- a person's own
-- edit in PO Builder included -- was attributed to whoever opened the PO.
-- Measured on production 2026-11-25: 566 history rows, all of them stamped
-- that way. Since this feature's whole claim is that a step says who moved it,
-- the trigger is corrected here rather than only in the function above.
--
-- Restated whole (production's body otherwise matches this), with two changes:
--   * changed_by is whoever is making the change, falling back to the PO's
--     creator when there is no session at all (a sync script or the service
--     role) -- which is exactly today's behaviour for those writers, so no
--     caller starts writing NULL.
--   * company_entity_id comes from the PO, not from the session's active
--     company. The stamp trigger on po_status_history reads
--     active_company_id(), which is null for a script and can be another
--     company for a connection acting for someone looking elsewhere.
create or replace function public.log_po_status_change()
returns trigger
language plpgsql
set search_path = 'public'
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.po_status_history (
      po_header_id, old_status, new_status, changed_by, note, company_entity_id
    ) values (
      new.id, null, new.status, coalesce(auth.uid(), new.created_by), 'Initial status',
      new.company_entity_id
    );
    return new;
  end if;

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    insert into public.po_status_history (
      po_header_id, old_status, new_status, changed_by, note, company_entity_id
    ) values (
      new.id, old.status, new.status, coalesce(auth.uid(), new.created_by), null,
      new.company_entity_id
    );
  end if;

  return new;
end;
$$;

comment on function public.log_po_status_change() is
  'Records every purchase-order status change in po_status_history: who MADE the change (auth.uid(), falling back to the PO''s creator where there is no session, as a sync script has none) and the PO''s own company, not the session''s active one. Until 20261125234500 it stamped the PO''s creator for every change, so history named the wrong person.';

-- -- 9. What PO Report shows ---------------------------------------------------
-- The steps connected apps set lately, for the card in PO Report. The
-- person's own read, under their own RLS.
create or replace function public.silo_po_status_changes_recent(p_days integer default 14, p_limit integer default 25)
returns json
language sql
volatile
security invoker
set search_path = ''
as $$
  select coalesce(json_agg(x order by x.created_at desc), '[]'::json)
    from (
      select c.id, c.po_header_id, h.po_name, c.old_status, c.new_status,
             c.reason, c.source_label, c.source_url, c.via_app, c.created_at,
             p.email as requested_by_email
        from public.po_status_changes c
        join public.po_headers h on h.id = c.po_header_id
        left join public.profiles p on p.id = c.requested_by
       where c.created_at > now() - make_interval(days => least(greatest(coalesce(p_days, 14), 1), 90))
       order by c.created_at desc
       limit least(greatest(coalesce(p_limit, 25), 1), 100)) x
$$;

comment on function public.silo_po_status_changes_recent(integer, integer) is
  'PO Report: the purchase-order steps connected AI applications have set lately, with the reason, the document and who approved the connection. SECURITY INVOKER, so a person sees only their own company''s. 20261125234500.';

revoke all on function public.silo_po_status_changes_recent(integer, integer)
  from public, anon, silo_integration, silo_revoked;
grant execute on function public.silo_po_status_changes_recent(integer, integer) to authenticated;

-- -- 10. What Ask SILO and describe_tables say about the new tables -----------
-- The catalog rows for a brand-new table do not exist until the catalog is
-- refreshed, so refresh first and then write the meaning into them.
select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog
   set description = $d$The purchase-order steps one company uses, in order: name, sort_order, is_open (the order is placed and not finished arriving -- what "on order" and "incoming" mean), ai_settable (a connected AI may set this step itself), needs_receipt (the step means units arrived, so it is recorded by confirming a delivery, never set directly) and is_final (no step follows it, so a PO at it is not offered to a connection at all). This is the list PO Builder offers, so a company's own wording lives here and not in code. Seeded from po_status_default_options() for every company that has purchase orders.$d$,
       keywords = array['po status','purchase order status','statuses','steps','workflow','po_status_options'],
       updated_at = now()
 where relname = 'po_status_options';

update public.silo_chat_schema_catalog
   set description = $d$Every purchase-order step a connected AI application set through the po_status:write permission: po_header_id, old_status, new_status, the reason the AI gave, the document it read (source_label, source_url), via_app, requested_by (the person whose connection it is) and created_at. The transition itself is also in po_status_history; this table is why it happened and on whose authority. Empty before 2026-11-25.$d$,
       keywords = array['po status','set by ai','connected app','audit','po_status_changes'],
       updated_at = now()
 where relname = 'po_status_changes';

select public.attach_stamp_company_entity_id_triggers();
