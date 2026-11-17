-- Receiving recorded by the person's own AI, as a DRAFT a person confirms.
--
-- WHY. Blake, 2026-11-17, with a receiving sheet turned into JSON by hand:
-- "trying to train a skill in claude silo mcp to mark off shipments...". The
-- work is real and repetitive -- a warehouse sheet arrives, somebody reads it
-- against the PO's lines and types twenty rows into PO Report -- and an AI
-- with the sheet is better at that transcription than a person is. What an AI
-- must NOT do is decide that a purchase order has been received: the units it
-- reads off a packing list are the FACTORY's count, the warehouse count can
-- differ, and a PO flipped to Received is what Purchasing, projections and
-- demand coverage all read afterwards.
--
-- So nothing here writes a shipment. The AI writes a DRAFT RECEIPT, which is
-- inert: it changes no shipment, no PO and no quantity anywhere in SILO. A
-- person opens PO Report, sees the lines side by side with what the PO
-- ordered and what earlier shipments already covered, and confirms or
-- discards it. Confirming is what inserts the shipment, and it runs as that
-- person, under their own RLS, stamped with their id by the existing audit
-- trigger (20260923160000) -- so the shipment is theirs, not the robot's, and
-- a person who may not change that PO's status cannot do it through a draft
-- either.
--
-- WHAT THE DRAFT CARRIES, and why each piece is here:
--   * qty_basis ('expected' | 'counted'). A packing list is not a warehouse
--     count. The AI says which it had; the confirm screen says so too, and an
--     'expected' receipt notes that on the shipment it creates.
--   * ordered_qty at the moment of drafting, per line, so the confirm screen
--     shows the variance the person is being asked to accept rather than
--     making them look it up.
--   * set_po_status, only 'Partially Received' or 'Received' and only as a
--     SUGGESTION. It is applied on confirmation, by the confirming person,
--     and it is reported separately when their own permissions refuse it (an
--     RLS-refused UPDATE succeeds with zero rows -- supabase/CLAUDE.md).
--   * flags: over-receipt against the PO line, lines the draft left out, and
--     'expected' quantities. The page shows them; nothing is hidden behind a
--     total.
--
-- GENERIC. No company, PO, SKU or workflow is named anywhere in here. The
-- shipment statuses are incoming_shipments' own CHECK list; the two PO
-- statuses are the two every company's PO Report already offers for a
-- delivery that landed.
--
-- 20261117220000.

begin;
-- -- 1. The receiving:write scope --------------------------------------------
-- Re-stated from 20261110160000 (production matches it) with ONE line
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
  c_offered constant text[] := array['reports:read', 'data:read', 'work:write', 'outreach:send', 'codes:create', 'receiving:write'];
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
  'Writes the SILO grant row for an approved application: aal2 required, scopes from the allowlist (reports:read, data:read, work:write, outreach:send, codes:create, receiving:write) and a scope outside it is REFUSED rather than dropped, up to silo_api_app_connection_limit() live connections per person per application in numbered slots. 20261020030000; app_key 20261102180000; slots 20261104020000; work:write 20261104230000; strict scopes 20261104234500; outreach:send 20261110093000; codes:create 20261110160000; receiving:write 20261117220000.';

revoke all on function public.silo_api_consent(text, text[]) from public, anon;
grant execute on function public.silo_api_consent(text, text[]) to authenticated;

-- -- 2. The paths the developer platform exposes ------------------------------
-- Re-stated from 20261112030000 (production matches it) with three paths added.
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
    '/rpc/silo_api_record_shipment_receipt')
$$;

comment on function public.silo_api_path_allowed() is
  'True when a third-party OAuth request is on one of the paths the developer platform exposes: running and listing reports (reports:read), describing tables, running a read-only query and reading published connections (data:read), opening a task (work:write), reading this connection''s own scopes and recording a handshake or a failure (no scope needed), claiming approved affiliate outreach and marking it sent (outreach:send), reading affiliate codes waiting for Shopify and recording one as created (codes:create), and listing the purchase orders awaiting a delivery, reading one''s lines and recording a DRAFT shipment receipt against it (receiving:write). Every other path is refused by silo_check_request(). 20261030050000; query 20261030110000; connections 20261103210000; create_task 20261104230000; scopes 20261104234500; outreach 20261110093000; codes 20261110160000; connect and failures 20261112030000; receiving 20261117220000.';

-- One more kind of write against the connection's daily cap.
alter table public.silo_api_writes drop constraint if exists silo_api_writes_kind_check;
alter table public.silo_api_writes
  add constraint silo_api_writes_kind_check
  check (kind in ('task', 'outreach_claim', 'code_created', 'shipment_receipt'));

-- -- 3. The draft a person confirms -------------------------------------------
-- Inert by construction: no trigger, view or report reads these tables, so a
-- row here changes nothing until silo_receiving_confirm_draft() copies it into
-- incoming_shipments.
create table if not exists public.incoming_shipment_drafts (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  po_header_id uuid not null references public.po_headers(id) on delete cascade,

  -- The shipment this would create. Same vocabulary as incoming_shipments, so
  -- confirming is a copy and never a translation.
  shipment_status text not null default 'Received'
    constraint incoming_shipment_drafts_status_chk
    check (shipment_status in ('Not Shipped','Booked','Shipped','In Transit','Delayed','Delivered','Received')),
  ship_date date,
  eta date,
  received_date date,
  tracking_number text,
  carrier text,
  container_ref text,
  warehouse_location text,
  received_by text,
  notes text,

  -- Whose count this is. A packing list is not a warehouse count, and the
  -- difference is the whole reason a person confirms rather than a robot.
  qty_basis text not null default 'expected'
    constraint incoming_shipment_drafts_basis_chk check (qty_basis in ('expected', 'counted')),

  -- A SUGGESTION, applied by the confirming person under their own RLS.
  set_po_status text
    constraint incoming_shipment_drafts_po_status_chk
    check (set_po_status is null or set_po_status in ('Partially Received', 'Received')),
  po_status_note text,

  state text not null default 'pending'
    constraint incoming_shipment_drafts_state_chk
    check (state in ('pending', 'applied', 'rejected')),

  -- Where the document came from, so the person confirming can go and read
  -- it: a message in a chat tool, an email, a scan. The AI passes it; SILO
  -- shows it beside the lines and never follows it.
  source_label text,
  source_url text
    constraint incoming_shipment_drafts_source_url_chk
    check (source_url is null
           or (length(source_url) between 12 and 500
               and source_url ~* '^https://[^[:space:]<>"]+$')),

  -- Who asked for it, and through which application.
  grant_id uuid references public.silo_api_grants(id) on delete set null,
  requested_by uuid,
  via_app text,
  idempotency_key text,

  -- How many lines the draft had when it was written. A PO line deleted in the
  -- meantime takes its draft line with it (ON DELETE CASCADE), which would
  -- otherwise make the confirmed shipment quietly smaller than what the person
  -- was shown.
  line_count integer,

  applied_at timestamptz,
  applied_by uuid,
  applied_shipment_id uuid references public.incoming_shipments(id) on delete set null,
  po_status_applied boolean,
  rejected_at timestamptz,
  rejected_by uuid,
  reject_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.incoming_shipment_drafts is
  'A shipment receipt the person''s own AI recorded through the MCP / developer API (receiving:write), waiting for a person to confirm it in PO Report. Inert: nothing in SILO reads these rows except the confirm screen, so a draft changes no shipment, PO or quantity. Confirming copies it into incoming_shipments as the confirming person. 20261117220000.';
comment on column public.incoming_shipment_drafts.qty_basis is
  '''expected'' = the quantities came off a packing list or factory document; ''counted'' = a warehouse count. An expected receipt says so on the shipment it creates.';
comment on column public.incoming_shipment_drafts.set_po_status is
  'The PO status the draft suggests (Partially Received or Received), applied on confirmation by the confirming person under their own RLS, or reported as not applied when their permissions refuse it. NULL leaves the PO''s status alone.';
comment on column public.incoming_shipment_drafts.source_url is
  'An https link to the document the receipt was read from (a chat message, an email, a scan), shown to the person confirming it. SILO never fetches it, and it is a link, never evidence: the person decides whether the lines match it.';
comment on column public.incoming_shipment_drafts.po_status_applied is
  'Whether the suggested PO status was actually applied when the draft was confirmed. False means the confirming person may not change that PO; the shipment still landed.';

create index if not exists incoming_shipment_drafts_company_idx
  on public.incoming_shipment_drafts (company_entity_id, state, created_at desc);
create index if not exists incoming_shipment_drafts_po_idx
  on public.incoming_shipment_drafts (po_header_id);
-- One key, one draft, per connection: a retried tool call returns the first
-- draft instead of queueing a second delivery.
create unique index if not exists incoming_shipment_drafts_idem_uidx
  on public.incoming_shipment_drafts (grant_id, idempotency_key)
  where grant_id is not null and idempotency_key is not null;

create table if not exists public.incoming_shipment_draft_lines (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  draft_id uuid not null references public.incoming_shipment_drafts(id) on delete cascade,
  po_line_id uuid not null references public.po_lines(id) on delete cascade,
  qty numeric(12, 2),
  -- The PO line's quantity when the draft was written, so the confirm screen
  -- shows the variance without looking it up, and so a PO edited afterwards
  -- cannot change what the person was shown.
  ordered_qty numeric(12, 2),
  -- The line AS THE DOCUMENT WROTE IT. The matching from that text to a PO
  -- line is the AI's, and SILO does not repeat it or trust it -- it stores
  -- what the AI read, shows it next to the PO line it chose, and says when
  -- the two do not obviously correspond.
  source_text text,
  notes text,
  created_at timestamptz not null default now(),
  constraint incoming_shipment_draft_lines_unique unique (draft_id, po_line_id)
);

comment on table public.incoming_shipment_draft_lines is
  'The lines of a drafted shipment receipt: which PO line, how many units, what that line had ordered when the draft was written, and the text the AI matched it from. 20261117220000.';
comment on column public.incoming_shipment_draft_lines.source_text is
  'The item as the receiving document named it, passed by the AI that matched it to this PO line. Stored so a person can see what was matched to what; SILO does no matching of its own.';

create index if not exists incoming_shipment_draft_lines_draft_idx
  on public.incoming_shipment_draft_lines (draft_id);
create index if not exists incoming_shipment_draft_lines_company_idx
  on public.incoming_shipment_draft_lines (company_entity_id);

alter table public.incoming_shipment_drafts enable row level security;
alter table public.incoming_shipment_draft_lines enable row level security;

-- Stated, not inherited. A policy without a table grant is a policy nobody can
-- exercise, and Supabase's default privileges are not something to rely on for
-- a table whose whole point is who may touch it. The browser needs select and
-- update (confirming and discarding run as the caller), an admin needs delete
-- for the policy above, and nothing is granted to anon or to the integration
-- roles -- a connection reaches a draft only through its own definer tool.
grant select, update, delete on public.incoming_shipment_drafts to authenticated;
grant select on public.incoming_shipment_draft_lines to authenticated;
revoke all on public.incoming_shipment_drafts from anon, silo_integration, silo_revoked;
revoke all on public.incoming_shipment_draft_lines from anon, silo_integration, silo_revoked;

drop trigger if exists trg_incoming_shipment_drafts_updated_at on public.incoming_shipment_drafts;
create trigger trg_incoming_shipment_drafts_updated_at
  before update on public.incoming_shipment_drafts
  for each row execute function public.set_updated_at();

-- A member of the company sees the drafts and answers them. No INSERT policy:
-- the only writer is the definer function the connection calls, which sets the
-- company from the GRANT and never from a session.
drop policy if exists incoming_shipment_drafts_select on public.incoming_shipment_drafts;
create policy incoming_shipment_drafts_select on public.incoming_shipment_drafts
  for select to authenticated using (company_entity_id = (select public.active_company_id()));

drop policy if exists incoming_shipment_drafts_update on public.incoming_shipment_drafts;
create policy incoming_shipment_drafts_update on public.incoming_shipment_drafts
  for update to authenticated
  using (company_entity_id = (select public.active_company_id()))
  with check (company_entity_id = (select public.active_company_id()));

drop policy if exists incoming_shipment_drafts_delete on public.incoming_shipment_drafts;
create policy incoming_shipment_drafts_delete on public.incoming_shipment_drafts
  for delete to authenticated
  using (company_entity_id = (select public.active_company_id()) and (select public.is_admin_user()));

drop policy if exists incoming_shipment_draft_lines_select on public.incoming_shipment_draft_lines;
create policy incoming_shipment_draft_lines_select on public.incoming_shipment_draft_lines
  for select to authenticated using (company_entity_id = (select public.active_company_id()));

-- -- 4. The fence of the receiving:write tools --------------------------------
-- silo_api_codes_grant()'s checks, for this scope: a live, unpaused grant
-- bound to a company whose approver is still a member of it. Receiving does
-- not have a manager role of its own -- incoming_shipments is writable by any
-- active member of the company (its own RLS, live 2026-11-17) -- so membership
-- IS the rule, and the narrower authority (changing the PO) is enforced where
-- it is exercised: on confirmation, as the confirming person.
create or replace function public.silo_api_receiving_grant()
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
  perform public.silo_api_require_scope('receiving:write');

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

comment on function public.silo_api_receiving_grant() is
  'The shared fence of the receiving:write tools: scope, a live unpaused grant bound to a company, and the approver still an active member of it. Internal. 20261117220000.';

revoke all on function public.silo_api_receiving_grant()
  from public, anon, authenticated, silo_integration, silo_revoked;

-- -- 5. Which POs are waiting for a delivery ----------------------------------
create or replace function public.silo_api_pos_awaiting_receipt(p_search text default null, p_limit integer default 25)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant   public.silo_api_grants;
  v_company uuid;
  v_search  text := nullif(btrim(coalesce(p_search, '')), '');
  v_pos     json;
begin
  v_grant   := public.silo_api_receiving_grant();
  v_company := v_grant.company_entity_id;

  select coalesce(json_agg(x order by x.order_date desc nulls last, x.po_name), '[]'::json) into v_pos
    from (
      select h.id as po_header_id, h.po_name, h.status, h.order_date,
             h.expected_arrival_date, f.factory_name as factory,
             (select count(*) from public.po_lines l where l.po_header_id = h.id) as lines,
             (select count(*) from public.incoming_shipments s where s.po_header_id = h.id) as shipments_logged,
             (select count(*) from public.incoming_shipment_drafts d
               where d.po_header_id = h.id and d.state = 'pending') as drafts_waiting
        from public.po_headers h
        left join public.factories f on f.id = h.factory_id
       where h.company_entity_id = v_company
         and h.status is not null
         and h.status not in ('Draft', 'Cancelled', 'Closed')
         and (v_search is null
              or h.po_name ilike '%' || v_search || '%'
              or f.factory_name ilike '%' || v_search || '%')
       order by h.order_date desc nulls last, h.po_name
       limit least(greatest(coalesce(p_limit, 25), 1), 100)) x;

  return json_build_object(
    'purchase_orders', v_pos,
    'timezone', public.silo_company_timezone(v_company),
    'next', 'Pass one po_header_id to po_lines_for_receiving to get its lines and their ids.',
    'note', case when json_array_length(v_pos) = 0 then
      'No open purchase orders match. A closed, cancelled or draft PO is not listed.' end);
end;
$$;

comment on function public.silo_api_pos_awaiting_receipt(text, integer) is
  'MCP / developer API tool (receiving:write): the company''s open purchase orders -- anything not Draft, Cancelled or Closed -- with how many lines and shipments each has and whether a drafted receipt is already waiting. Reads only. 20261117220000.';

revoke all on function public.silo_api_pos_awaiting_receipt(text, integer)
  from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_pos_awaiting_receipt(text, integer) to silo_integration;

-- -- 6. One PO's lines, with what is already covered --------------------------
create or replace function public.silo_api_po_lines_for_receiving(p_po_header_id uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant   public.silo_api_grants;
  v_company uuid;
  v_po      record;
  v_lines   json;
  v_ships   json;
  v_drafts  json;
begin
  v_grant   := public.silo_api_receiving_grant();
  v_company := v_grant.company_entity_id;

  select h.id, h.po_name, h.status, h.order_date, h.expected_arrival_date, f.factory_name
    into v_po
    from public.po_headers h
    left join public.factories f on f.id = h.factory_id
   where h.id = p_po_header_id and h.company_entity_id = v_company;

  if v_po.id is null then
    raise exception 'unknown_po: no such purchase order in this company'
      using errcode = 'check_violation';
  end if;

  -- received_so_far is what earlier shipments already assigned to the line. A
  -- shipment line with no quantity means "the whole line" (the column's own
  -- meaning since 20260818210000), so it counts as the line's quantity.
  select coalesce(json_agg(x order by x.sku, x.title, x.variant), '[]'::json) into v_lines
    from (
      select l.id as po_line_id,
             l.sku_snapshot as sku, l.title_snapshot as title,
             l.variant_title_snapshot as variant,
             l.qty as ordered,
             coalesce((select sum(coalesce(sl.qty, l.qty))
                         from public.incoming_shipment_lines sl
                         join public.incoming_shipments s on s.id = sl.shipment_id
                        where sl.po_line_id = l.id
                          and sl.company_entity_id = v_company), 0) as received_so_far
        from public.po_lines l
       where l.po_header_id = v_po.id
         and l.company_entity_id = v_company) x;

  select coalesce(json_agg(y order by y.received_date desc nulls last, y.ship_date desc nulls last), '[]'::json)
    into v_ships
    from (
      select s.id as shipment_id, s.shipment_status, s.ship_date, s.eta, s.received_date,
             s.tracking_number, s.container_ref, s.warehouse_location,
             (select count(*) from public.incoming_shipment_lines sl where sl.shipment_id = s.id) as lines
        from public.incoming_shipments s
       where s.po_header_id = v_po.id and s.company_entity_id = v_company) y;

  select coalesce(json_agg(z order by z.created_at), '[]'::json) into v_drafts
    from (
      select d.id as draft_id, d.created_at, d.via_app, d.shipment_status, d.received_date,
             (select count(*) from public.incoming_shipment_draft_lines dl where dl.draft_id = d.id) as lines
        from public.incoming_shipment_drafts d
       where d.po_header_id = v_po.id and d.company_entity_id = v_company and d.state = 'pending') z;

  return json_build_object(
    'purchase_order', json_build_object(
      'po_header_id', v_po.id, 'po_name', v_po.po_name, 'status', v_po.status,
      'factory', v_po.factory_name, 'order_date', v_po.order_date,
      'expected_arrival_date', v_po.expected_arrival_date),
    'lines', v_lines,
    'shipments_already_logged', v_ships,
    'drafts_waiting_for_a_person', v_drafts,
    'timezone', public.silo_company_timezone(v_company),
    'how_to_record',
      'Match each row of the receiving document to a po_line_id above -- by SKU, not by position -- and call '
      || 'record_shipment_receipt once for the whole delivery, with one line per po_line_id and the units '
      || 'received, and source_text set to the item exactly as the document named it -- SILO stores that text '
      || 'next to the line you chose, so a person can see what was matched to what, and flags any line whose '
      || 'text does not resemble the PO line. Set qty_basis to "counted" only if the numbers are a warehouse '
      || 'count; a packing list or factory document is "expected". Leave out any line the delivery did not '
      || 'carry. Pass source_label and, where the document has a link (a chat message, an email), source_url, '
      || 'so the person can go and read it. SILO records a DRAFT: nothing changes in SILO, and no shipment '
      || 'exists, until a person opens PO Report and confirms it -- so tell the person it is waiting for '
      || 'them and give them the link the tool returns.');
end;
$$;

comment on function public.silo_api_po_lines_for_receiving(uuid) is
  'MCP / developer API tool (receiving:write): one purchase order''s lines with their ids, SKUs, ordered quantities and how many units earlier shipments already cover, plus the shipments already logged, any drafted receipt still waiting for a person, and how to record a receipt. Reads only. 20261117220000.';

revoke all on function public.silo_api_po_lines_for_receiving(uuid)
  from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_po_lines_for_receiving(uuid) to silo_integration;

-- -- 7. Record a drafted receipt ----------------------------------------------
create or replace function public.silo_api_record_shipment_receipt(
  p_po_header_id uuid,
  p_lines jsonb,
  p_idempotency_key text,
  p_shipment_status text default 'Received',
  p_qty_basis text default 'expected',
  p_ship_date date default null,
  p_eta date default null,
  p_received_date date default null,
  p_tracking_number text default null,
  p_carrier text default null,
  p_container_ref text default null,
  p_warehouse_location text default null,
  p_received_by text default null,
  p_notes text default null,
  p_set_po_status text default null,
  p_po_status_note text default null,
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
  v_status  text := nullif(btrim(coalesce(p_shipment_status, '')), '');
  v_basis   text := lower(nullif(btrim(coalesce(p_qty_basis, '')), ''));
  v_postat  text := nullif(btrim(coalesce(p_set_po_status, '')), '');
  v_po      record;
  v_existing uuid;
  v_draft   uuid;
  v_used    integer;
  v_count   integer;
begin
  v_grant   := public.silo_api_receiving_grant();
  v_company := v_grant.company_entity_id;
  v_user    := v_grant.user_id;
  v_app     := public.silo_api_app_name(v_grant.client_id, v_grant.app_key);

  if v_key is null or length(v_key) > 100 then
    raise exception 'idempotency_key_required: pass your own id for this delivery, up to 100 characters, and reuse it if you retry'
      using errcode = 'check_violation';
  end if;

  -- A retry is the same draft, never a second delivery. Answered before
  -- anything else is validated, so a retry cannot be refused by a PO that has
  -- changed in the meantime.
  select d.id into v_existing
    from public.incoming_shipment_drafts d
   where d.grant_id = v_grant.id and d.idempotency_key = v_key;
  if v_existing is not null then
    return public.silo_receiving_draft_json(v_existing, true);
  end if;

  select h.id, h.po_name, h.status into v_po
    from public.po_headers h
   where h.id = p_po_header_id and h.company_entity_id = v_company;
  if v_po.id is null then
    raise exception 'unknown_po: no such purchase order in this company'
      using errcode = 'check_violation';
  end if;

  v_status := coalesce(v_status, 'Received');
  if v_status not in ('Not Shipped','Booked','Shipped','In Transit','Delayed','Delivered','Received') then
    raise exception 'invalid_shipment_status: shipment_status must be one of Not Shipped, Booked, Shipped, In Transit, Delayed, Delivered, Received'
      using errcode = 'check_violation';
  end if;

  v_basis := coalesce(v_basis, 'expected');
  if v_basis not in ('expected', 'counted') then
    raise exception 'invalid_qty_basis: qty_basis must be "expected" (a packing list or factory document) or "counted" (a warehouse count)'
      using errcode = 'check_violation';
  end if;

  if v_postat is not null and v_postat not in ('Partially Received', 'Received') then
    raise exception 'invalid_po_status: a receipt may only suggest "Partially Received" or "Received"; any other status change is a person''s to make in SILO'
      using errcode = 'check_violation';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'lines_required: pass one entry per PO line received, each with po_line_id and qty'
      using errcode = 'check_violation';
  end if;
  -- A line that appears twice on the document is one line of the receipt: the
  -- units are added up by whoever read it, not by SILO, which has no way to
  -- tell a repeated row from a second pallet of the same item.
  if (select count(distinct e ->> 'po_line_id') from jsonb_array_elements(p_lines) e)
     <> jsonb_array_length(p_lines) then
    raise exception 'repeated_po_line: each po_line_id may appear only once; add the units together for an item listed more than once on the document'
      using errcode = 'check_violation';
  end if;
  if jsonb_array_length(p_lines) > 500 then
    raise exception 'too_many_lines: a receipt carries at most 500 lines; split the delivery'
      using errcode = 'check_violation';
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

  insert into public.incoming_shipment_drafts
    (company_entity_id, po_header_id, shipment_status, ship_date, eta, received_date,
     tracking_number, carrier, container_ref, warehouse_location, received_by, notes,
     qty_basis, set_po_status, po_status_note, source_label, source_url,
     state, grant_id, requested_by, via_app, idempotency_key)
  values
    (v_company, v_po.id, v_status, p_ship_date, p_eta, p_received_date,
     nullif(btrim(coalesce(p_tracking_number, '')), ''), nullif(btrim(coalesce(p_carrier, '')), ''),
     nullif(btrim(coalesce(p_container_ref, '')), ''), nullif(btrim(coalesce(p_warehouse_location, '')), ''),
     nullif(btrim(coalesce(p_received_by, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''),
     v_basis, v_postat, nullif(btrim(coalesce(p_po_status_note, '')), ''),
     nullif(btrim(coalesce(p_source_label, '')), ''), nullif(btrim(coalesce(p_source_url, '')), ''),
     'pending', v_grant.id, v_user, v_app, v_key)
  returning id into v_draft;

  -- Every line is checked against THIS PO. A po_line_id from another PO or
  -- another company is refused outright rather than silently dropped: a
  -- receipt that quietly covers fewer lines than the document is worse than
  -- one that fails.
  with given as (
    select (e ->> 'po_line_id')::text as raw_id,
           nullif(e ->> 'qty', '') as raw_qty,
           nullif(btrim(coalesce(e ->> 'notes', '')), '') as notes,
           nullif(btrim(coalesce(e ->> 'source_text', '')), '') as source_text,
           ord
      from jsonb_array_elements(p_lines) with ordinality as t(e, ord))
  insert into public.incoming_shipment_draft_lines
    (company_entity_id, draft_id, po_line_id, qty, ordered_qty, source_text, notes)
  select v_company, v_draft, l.id,
         case when g.raw_qty is null then null else round(g.raw_qty::numeric, 2) end,
         l.qty, g.source_text, g.notes
    from given g
    join public.po_lines l
      on l.id = (case when g.raw_id ~ '^[0-9a-fA-F-]{36}$' then g.raw_id::uuid else null end)
     and l.po_header_id = v_po.id
     and l.company_entity_id = v_company;

  select count(*) into v_count from public.incoming_shipment_draft_lines where draft_id = v_draft;
  update public.incoming_shipment_drafts set line_count = v_count where id = v_draft;
  if v_count <> jsonb_array_length(p_lines) then
    raise exception 'unknown_po_line: % of % lines are not lines of this purchase order (or are repeated). Get the ids from po_lines_for_receiving and match by SKU.',
      jsonb_array_length(p_lines) - v_count, jsonb_array_length(p_lines)
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.incoming_shipment_draft_lines
              where draft_id = v_draft and qty is not null and qty <= 0) then
    raise exception 'invalid_qty: a line''s qty must be above zero. Leave qty out to mean the line''s full ordered quantity, and leave the line out entirely if the delivery did not carry it.'
      using errcode = 'check_violation';
  end if;

  insert into public.silo_api_writes
    (company_entity_id, grant_id, user_id, via, kind, target_id, idempotency_key)
  values (v_company, v_grant.id, v_user, 'app', 'shipment_receipt', v_draft, v_key);

  return public.silo_receiving_draft_json(v_draft, false);
end;
$$;

comment on function public.silo_api_record_shipment_receipt(uuid, jsonb, text, text, text, date, date, date, text, text, text, text, text, text, text, text, text, text) is
  'MCP / developer API tool (receiving:write): records a DRAFT shipment receipt against one purchase order -- the shipment''s dates and references, and one line per PO line received. Writes NOTHING operational: no shipment, no PO change and no quantity moves until a person confirms the draft in PO Report. Refuses a line that is not a line of that PO. Each line may carry the text the document used, which is stored and shown beside the PO line the AI matched it to, and flagged when the two do not resemble each other -- SILO matches nothing itself. The receipt may carry a label and an https link to the document it was read from. Tagged with the app ("Via <app>"); one write against silo_api_write_cap(); the same idempotency_key returns the first draft. 20261117220000.';

revoke all on function public.silo_api_record_shipment_receipt(uuid, jsonb, text, text, text, date, date, date, text, text, text, text, text, text, text, text, text, text)
  from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_record_shipment_receipt(uuid, jsonb, text, text, text, date, date, date, text, text, text, text, text, text, text, text, text, text) to silo_integration;

-- Comparing a document's words with a PO line's own, for the one purpose of
-- telling a person "these two do not obviously correspond". Letters and digits
-- only, folded: "FM-YS-Hoodie" and "fm ys hoodie" are the same text, and
-- nothing here decides anything -- the AI already chose the line.
create or replace function public.silo_receiving_squash(p_text text)
returns text language sql immutable set search_path = '' as $$
  select nullif(lower(regexp_replace(coalesce(p_text, ''), '[^a-zA-Z0-9]+', '', 'g')), '')
$$;

comment on function public.silo_receiving_squash(text) is
  'Letters and digits of a string, folded to lower case, for comparing a receiving document''s item text with a PO line''s SKU or title. 20261117220000.';

revoke all on function public.silo_receiving_squash(text) from public, anon;
grant execute on function public.silo_receiving_squash(text) to authenticated, service_role;

-- -- 8. What a draft looks like, to a bot and to the page --------------------
-- One shape, so the model is told exactly what the person will be shown.
create or replace function public.silo_receiving_draft_json(p_draft_id uuid, p_replayed boolean default false)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_d       public.incoming_shipment_drafts;
  v_lines   json;
  v_over    json;
  v_missing json;
  v_units   numeric;
  v_ordered numeric;
begin
  select * into v_d from public.incoming_shipment_drafts where id = p_draft_id;
  if v_d.id is null then
    raise exception 'unknown_draft: no such drafted receipt' using errcode = 'check_violation';
  end if;

  select coalesce(json_agg(x order by x.sku, x.variant), '[]'::json),
         coalesce(sum(x.qty), 0), coalesce(sum(x.ordered), 0)
    into v_lines, v_units, v_ordered
    from (
      select dl.po_line_id, l.sku_snapshot as sku, l.title_snapshot as title,
             l.variant_title_snapshot as variant,
             coalesce(dl.qty, dl.ordered_qty) as qty, dl.ordered_qty as ordered,
             dl.source_text, dl.notes,
             -- How the document's own words sit against the line the AI chose.
             -- 'check' is not a refusal: it is the line a person should read
             -- twice, and the page says so.
             case
               when dl.source_text is null then 'no_text'
               when public.silo_receiving_squash(dl.source_text)
                    = public.silo_receiving_squash(l.sku_snapshot) then 'sku_exact'
               when public.silo_receiving_squash(l.sku_snapshot) is not null
                    and public.silo_receiving_squash(dl.source_text) is not null
                    and (position(public.silo_receiving_squash(l.sku_snapshot)
                                  in public.silo_receiving_squash(dl.source_text)) > 0
                      or position(public.silo_receiving_squash(dl.source_text)
                                  in public.silo_receiving_squash(l.sku_snapshot)) > 0) then 'sku_part'
               when public.silo_receiving_squash(l.title_snapshot) is not null
                    and public.silo_receiving_squash(dl.source_text) is not null
                    and position(public.silo_receiving_squash(l.title_snapshot)
                                 in public.silo_receiving_squash(dl.source_text)) > 0 then 'title_part'
               else 'check'
             end as match
        from public.incoming_shipment_draft_lines dl
        join public.po_lines l on l.id = dl.po_line_id
       where dl.draft_id = v_d.id) x;

  -- More units than the line ordered, counting what earlier shipments already
  -- cover. Reported, never refused: an over-receipt is a real thing that
  -- happens, and a person decides what to do about it.
  select coalesce(json_agg(y order by y.sku), '[]'::json) into v_over
    from (
      select l.sku_snapshot as sku, dl.ordered_qty as ordered,
             coalesce(dl.qty, dl.ordered_qty) as receiving,
             coalesce((select sum(coalesce(sl.qty, l.qty))
                         from public.incoming_shipment_lines sl
                        where sl.po_line_id = l.id), 0) as already_received
        from public.incoming_shipment_draft_lines dl
        join public.po_lines l on l.id = dl.po_line_id
       where dl.draft_id = v_d.id
         and coalesce(dl.qty, dl.ordered_qty)
             + coalesce((select sum(coalesce(sl.qty, l.qty))
                           from public.incoming_shipment_lines sl
                          where sl.po_line_id = l.id), 0)
             > coalesce(dl.ordered_qty, 0)) y;

  select coalesce(json_agg(z.sku order by z.sku), '[]'::json) into v_missing
    from (
      select l.sku_snapshot as sku
        from public.po_lines l
       where l.po_header_id = v_d.po_header_id
         and not exists (select 1 from public.incoming_shipment_draft_lines dl
                          where dl.draft_id = v_d.id and dl.po_line_id = l.id)) z;

  return json_build_object(
    'draft_id', v_d.id,
    'state', v_d.state,
    'replayed', coalesce(p_replayed, false),
    'po_header_id', v_d.po_header_id,
    'po_name', (select h.po_name from public.po_headers h where h.id = v_d.po_header_id),
    'shipment_status', v_d.shipment_status,
    'ship_date', v_d.ship_date, 'eta', v_d.eta, 'received_date', v_d.received_date,
    'tracking_number', v_d.tracking_number, 'carrier', v_d.carrier,
    'container_ref', v_d.container_ref, 'warehouse_location', v_d.warehouse_location,
    'received_by', v_d.received_by, 'notes', v_d.notes,
    'qty_basis', v_d.qty_basis,
    'source_label', v_d.source_label,
    'source_url', v_d.source_url,
    'suggested_po_status', v_d.set_po_status,
    'via', v_d.via_app,
    'lines', v_lines,
    'totals', json_build_object('lines', json_array_length(v_lines), 'lines_when_drafted', v_d.line_count,
      'units_receiving', v_units, 'units_ordered_on_those_lines', v_ordered,
      'variance_units', v_units - v_ordered),
    'over_receipt_lines', v_over,
    'lines_to_check',
      (select coalesce(json_agg(json_build_object('sku', e -> 'sku', 'source_text', e -> 'source_text')), '[]'::json)
         from json_array_elements(v_lines) e
        where (e ->> 'match') = 'check'),
    'po_lines_not_in_this_receipt', v_missing,
    'confirm_in_silo', '/v2/po-report.html?receipt=' || v_d.id::text,
    'what_happens_next', case when v_d.state = 'pending' then
        'Nothing has changed in SILO. A person opens PO Report, checks these lines against the purchase '
        || 'order and confirms the receipt, which is what creates the shipment'
        || case when v_d.set_po_status is not null then ' and sets the PO to ' || v_d.set_po_status else '' end
        || '. Tell them it is waiting and send them the link.'
      when v_d.state = 'applied' then 'A person confirmed this receipt; the shipment exists in SILO.'
      else 'A person discarded this draft. Nothing was recorded.' end,
    'tell_the_person', case
      when exists (select 1 from json_array_elements(v_lines) e where (e ->> 'match') = 'check')
        then 'Say which lines you were not sure about: the text on the document does not resemble the SKU or title of the PO line you matched it to.'
      when json_array_length(v_over) > 0 then 'Say that some lines receive more than the purchase order ordered; the person decides whether that is right.'
      when v_d.qty_basis = 'expected' then 'Say these are the quantities on the document, not a warehouse count.'
      end);
end;
$$;

comment on function public.silo_receiving_draft_json(uuid, boolean) is
  'One drafted shipment receipt as both the MCP tools and PO Report describe it: its lines with ordered and receiving quantities, the over-receipt lines, the PO lines it leaves out, totals, and what happens next. Definer, and callers are the receiving tools and the page''s own RPCs, which have already established the company. 20261117220000.';

revoke all on function public.silo_receiving_draft_json(uuid, boolean)
  from public, anon, authenticated, silo_integration, silo_revoked;

-- -- 9. A person confirms, or discards ---------------------------------------
-- SECURITY INVOKER on purpose. The shipment must be the confirming person's
-- write, through the same policies and the same audit trigger as the page's
-- own inserts, and the PO status change must be refused the same way their own
-- edit would be. A definer function here would quietly give every member the
-- authority the PO's own policy withholds.
create or replace function public.silo_receiving_confirm_draft(p_draft_id uuid)
returns json
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_d        public.incoming_shipment_drafts;
  v_ship     uuid;
  v_note     text;
  v_postat   boolean := null;
  v_rows     integer;
  v_lines    integer;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated: sign in to confirm a receipt' using errcode = 'insufficient_privilege';
  end if;

  -- RLS decides what is visible here; the lock makes two confirmations one.
  select * into v_d from public.incoming_shipment_drafts
   where id = p_draft_id for update;
  if v_d.id is null then
    raise exception 'unknown_draft: no such drafted receipt in this company'
      using errcode = 'check_violation';
  end if;
  if v_d.state <> 'pending' then
    return json_build_object('draft_id', v_d.id, 'state', v_d.state, 'changed', false,
      'shipment_id', v_d.applied_shipment_id,
      'message', case when v_d.state = 'applied'
        then 'This receipt was already confirmed.' else 'This draft was discarded.' end);
  end if;

  -- A PO line deleted since the draft was written took its draft line with it.
  -- Refusing is the only honest answer: the person is looking at a card built
  -- before the deletion, and confirming would record a smaller delivery than
  -- the one they read.
  select count(*) into v_lines from public.incoming_shipment_draft_lines where draft_id = v_d.id;
  if v_lines = 0 or (v_d.line_count is not null and v_lines <> v_d.line_count) then
    raise exception 'po_changed: a line of this purchase order was removed since the delivery was drafted (% of % lines left). Discard this draft and have it drafted again.',
      v_lines, coalesce(v_d.line_count, v_lines)
      using errcode = 'check_violation';
  end if;

  -- An "expected" count says so on the shipment itself, where anyone reading
  -- the shipment later will see it.
  v_note := v_d.notes;
  if v_d.qty_basis = 'expected' then
    v_note := nullif(btrim(coalesce(v_note, '') || case when coalesce(v_note, '') = '' then '' else ' ' end
      || 'Quantities are the document''s expected counts, not a warehouse count.'), '');
  end if;

  insert into public.incoming_shipments
    (po_header_id, shipment_status, ship_date, eta, received_date, tracking_number,
     carrier, container_ref, warehouse_location, received_by, notes)
  values
    (v_d.po_header_id, v_d.shipment_status, v_d.ship_date, v_d.eta, v_d.received_date,
     v_d.tracking_number, v_d.carrier, v_d.container_ref, v_d.warehouse_location,
     v_d.received_by, v_note)
  returning id into v_ship;

  insert into public.incoming_shipment_lines (shipment_id, po_line_id, qty, notes)
  select v_ship, dl.po_line_id, dl.qty, dl.notes
    from public.incoming_shipment_draft_lines dl
   where dl.draft_id = v_d.id;

  -- The PO's own policy decides this, not the draft. A refusal is zero rows,
  -- not an error (supabase/CLAUDE.md), so it is read and reported.
  if v_d.set_po_status is not null then
    update public.po_headers set status = v_d.set_po_status
     where id = v_d.po_header_id;
    get diagnostics v_rows = row_count;
    v_postat := v_rows > 0;
  end if;

  update public.incoming_shipment_drafts
     set state = 'applied', applied_at = now(), applied_by = auth.uid(),
         applied_shipment_id = v_ship, po_status_applied = v_postat
   where id = v_d.id;

  return json_build_object('draft_id', v_d.id, 'state', 'applied', 'changed', true,
    'shipment_id', v_ship,
    'po_status_requested', v_d.set_po_status,
    'po_status_applied', v_postat,
    'message', case
      when v_d.set_po_status is not null and v_postat is not true
        then 'Shipment recorded. The PO''s status was not changed: your account may not change this purchase order.'
      else 'Shipment recorded.' end);
end;
$$;

comment on function public.silo_receiving_confirm_draft(uuid) is
  'Confirms a drafted shipment receipt: inserts the shipment and its lines AS THE CALLER (security invoker, so their own RLS and the shipment audit trigger apply) and applies the PO status the draft suggested, reporting separately when the caller''s permissions refuse that. Repeating it changes nothing. 20261117220000.';

revoke all on function public.silo_receiving_confirm_draft(uuid) from public, anon, silo_integration, silo_revoked;
grant execute on function public.silo_receiving_confirm_draft(uuid) to authenticated;

create or replace function public.silo_receiving_reject_draft(p_draft_id uuid, p_reason text default null)
returns json
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_d public.incoming_shipment_drafts;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated: sign in to discard a receipt' using errcode = 'insufficient_privilege';
  end if;
  select * into v_d from public.incoming_shipment_drafts where id = p_draft_id for update;
  if v_d.id is null then
    raise exception 'unknown_draft: no such drafted receipt in this company'
      using errcode = 'check_violation';
  end if;
  if v_d.state <> 'pending' then
    return json_build_object('draft_id', v_d.id, 'state', v_d.state, 'changed', false);
  end if;
  update public.incoming_shipment_drafts
     set state = 'rejected', rejected_at = now(), rejected_by = auth.uid(),
         reject_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = v_d.id;
  return json_build_object('draft_id', v_d.id, 'state', 'rejected', 'changed', true);
end;
$$;

comment on function public.silo_receiving_reject_draft(uuid, text) is
  'Discards a drafted shipment receipt. Nothing is recorded, and the draft stays as the record that it was offered and declined. 20261117220000.';

revoke all on function public.silo_receiving_reject_draft(uuid, text) from public, anon, silo_integration, silo_revoked;
grant execute on function public.silo_receiving_reject_draft(uuid, text) to authenticated;

-- What PO Report shows for each waiting draft: the same shape the bot was
-- given, so the page and the model cannot describe the same draft differently.
-- A definer wrapper, because the shape above is definer and must not be
-- callable with an arbitrary draft id by anyone signed in. The tenant boundary
-- is therefore this function's own filter, stated here and nowhere else
-- (supabase/CLAUDE.md's rule for a deliberate definer wrapper), and it reads
-- the session's active company exactly as the drafts' RLS policy does.
create or replace function public.silo_receiving_pending_drafts()
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := public.active_company_id();
  v_out     json;
begin
  if auth.uid() is null or v_company is null then
    return '[]'::json;
  end if;
  select coalesce(json_agg(public.silo_receiving_draft_json(d.id, false) order by d.created_at), '[]'::json)
    into v_out
    from public.incoming_shipment_drafts d
   where d.state = 'pending'
     and d.company_entity_id = v_company;
  return v_out;
end;
$$;

comment on function public.silo_receiving_pending_drafts() is
  'The drafted shipment receipts waiting for a person in the caller''s active company, each in the same shape the AI was given. A definer wrapper over silo_receiving_draft_json (which no client role may call with an id of its own), so its own company filter IS the tenant boundary. 20261117220000.';

revoke all on function public.silo_receiving_pending_drafts() from public, anon, silo_integration, silo_revoked;
grant execute on function public.silo_receiving_pending_drafts() to authenticated;

select public.attach_stamp_company_entity_id_triggers();
select public.refresh_chat_schema_catalog();

-- What the two new tables mean, for the catalog Ask SILO and describe_tables
-- read. Written AFTER the refresh, which is what creates their rows, and only
-- where no description exists -- the same rule 20261103190000 uses.
update public.silo_chat_schema_catalog k
   set keywords = s.keywords,
       description = case
         when k.description is not null and btrim(k.description) <> '' then k.description
         else s.description
       end,
       updated_at = now()
  from (values
    ('incoming_shipment_drafts',
     'A delivery an AI connection drafted against a purchase order, waiting for a person to confirm it in PO Report. NOT A SHIPMENT: a row here has changed nothing, and state tells you which -- pending is waiting, applied means a person confirmed it and applied_shipment_id is the shipment that resulted, rejected means a person discarded it. Never count these as received units; incoming_shipments is what arrived.',
     array['drafted delivery','receipt to confirm','ai receiving','pending receipt']),
    ('incoming_shipment_draft_lines',
     'The lines of a drafted delivery: draft_id plus po_line_id plus qty, with ordered_qty as the PO line stood when it was drafted and source_text as the receiving document named the item. Pending rows are nothing received; see incoming_shipment_drafts.',
     array['drafted delivery lines','receipt lines','ai receiving'])
  ) as s(relname, description, keywords)
 where k.relname = s.relname;

notify pgrst, 'reload schema';

commit;
