-- po_email:send -- a purchase order goes to its factory as an email the
-- PERSON'S OWN AI sends from the PERSON'S OWN mailbox, with the PO attached.
-- SILO still sends nothing.
--
-- WHY. Blake, 2026-11-28: "Factories need modernized upgraded and email mcp
-- prompt for their pos unsent etc", then "it would attach said pos with
-- drafted copy based on po factors etc". A purchase order in SILO today ends
-- at a browser print window: somebody saves a PDF, opens their mail client,
-- writes the same paragraph again and attaches it. The drafting is the part a
-- model is good at and the sending is the part it must not own, which is
-- exactly the shape outreach:send already has (20261110093000).
--
-- WHAT THIS ADDS.
--   * po_vendor_emails -- one row per PO email: who it goes to, the subject
--     and body a person queued (and may edit), and what happened to it. A row
--     is queued by a person in SILO, claimed by a connection, and marked sent
--     by that same connection with the sent message's id as evidence.
--   * po_vendor_email_draft() -- the drafted copy, built from the PO's own
--     factors: its name, dates, style and unit counts, its new-product and
--     tech-pack flags, the factory's terms, the company's purchasing contact,
--     and the other POs still open with that factory. SECURITY INVOKER, so
--     the page that previews it reads exactly what the person may read. The
--     text is stored on the row at queue time: what the person saw and edited
--     is what is handed over, never something regenerated later.
--   * silo_api_po_emails_to_send / silo_api_mark_po_email_sent -- the two
--     tools, on the same fence as every other write scope: SECURITY DEFINER,
--     company and person from the GRANT and never from the session, a paused
--     connection writes nothing, the app's name stored on the row.
--   * A one-time document token per claimed email, so the connection can
--     fetch that PO as a PDF to attach (the po-document edge function) and
--     nothing else. Hashed at rest, 24 hours, one PO.
--
-- WHAT IT CANNOT DO. Queue an email (a person does, in SILO), change the
-- subject, body or recipient, reach a PO in another company, reach a PO its
-- person may not change (silo_api_may_set_po_status, 20261125234500 -- the
-- same authority as moving that PO's step), or send anything. The email
-- leaves the person's own mailbox or it does not leave at all.
--
-- MOVING THE PO ON. Marking an email sent moves the PO to the company's
-- vendor-send step, when that company has one and allows an AI to set it. The
-- step is COMPANY DATA (po_status_options.is_vendor_send), and where no row
-- carries the flag it resolves to that company's first open, AI-settable
-- step. No status name appears anywhere in here.
--
-- GENERIC. No company, factory, PO or wording is named in this file. The
-- drafted copy is assembled from columns; a company that wants its own
-- greeting and sign-off sets them in company_settings, and blank uses the
-- neutral wording below.
--
-- 20261128050000.

-- -- 1. The scope -------------------------------------------------------------
-- Re-stated from the LIVE definition (read back with pg_get_functiondef on
-- 2026-11-28, md5 d609ba05cd1f4570fd1ede5832c2f992) with ONE line changed:
-- c_offered, plus the comment that explains it.
create or replace function public.silo_api_consent(
  p_client_id text,
  p_scopes text[] default array['reports:read'::text])
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
  -- po_email:send since 20261128050000: taking the purchase-order emails a
  -- person queued in SILO, with the PO to attach, to send from the person's
  -- own mailbox, and recording that each one was sent. Its own box; never
  -- implied by po_status:write, and it can neither write nor queue an email.
  c_offered constant text[] := array['reports:read', 'data:read', 'work:write', 'outreach:send', 'codes:create', 'receiving:write', 'po_status:write', 'po_email:send'];
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

revoke all on function public.silo_api_consent(text, text[]) from public, anon;
grant execute on function public.silo_api_consent(text, text[]) to authenticated;

-- -- 2. The paths -------------------------------------------------------------
-- Re-stated from the live definition with the two new RPCs added.
create or replace function public.silo_api_path_allowed()
returns boolean
language sql
stable
set search_path = ''
as $$
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
    '/rpc/silo_api_set_po_status',
    '/rpc/silo_api_po_emails_to_send',
    '/rpc/silo_api_mark_po_email_sent')
$$;

comment on function public.silo_api_path_allowed() is
  'True when a third-party OAuth request is on one of the paths the developer platform exposes. As of 20261128050000 that also covers taking the purchase-order emails a person queued in SILO and recording each one as sent (po_email:send). Every other path is refused by silo_check_request(). History: 20261030050000; query 20261030110000; connections 20261103210000; create_task 20261104230000; scopes 20261104234500; outreach 20261110093000; codes 20261110160000; connect and failures 20261112030000; receiving 20261117220000; po status 20261125234500; po email 20261128050000.';

-- One more kind of write against the connection's daily cap. Re-stated in
-- full: the constraint is replaced, not added to, so every kind already
-- allowed has to be named here as well (20261125234500 added 'po_status').
alter table public.silo_api_writes drop constraint if exists silo_api_writes_kind_check;
alter table public.silo_api_writes
  add constraint silo_api_writes_kind_check
  check (kind in ('task', 'outreach_claim', 'code_created', 'shipment_receipt', 'po_status',
                  'po_email_claim'));

-- -- 3. Which step means "the factory has it" --------------------------------
-- Company data, like every other property of a step. Nothing is seeded true:
-- a company that has not said which step that is resolves to its first open,
-- AI-settable step, which is what the default list means by it.
alter table public.po_status_options
  add column if not exists is_vendor_send boolean not null default false;

comment on column public.po_status_options.is_vendor_send is
  'True for the step that means the purchase order has gone to the factory. Marking a queued PO email sent moves the PO here, when the step also allows an AI to set it. Unset for every step, the first open ai_settable step is used. Company DATA. 20261128050000.';

create or replace function public.po_vendor_send_step(p_company uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
    from public.po_status_options o
   where o.company_entity_id = p_company
     and o.is_active = true
     and o.ai_settable = true
     and o.is_open = true
     and coalesce(o.needs_receipt, false) = false
   order by o.is_vendor_send desc, o.sort_order, o.name
   limit 1
$$;

comment on function public.po_vendor_send_step(uuid) is
  'The step a purchase order moves to when its email is marked sent: the one flagged is_vendor_send, else this company''s first open, AI-settable step that does not mean units arrived. NULL when the company has no such step, and then an email being sent moves nothing. 20261128050000.';

revoke all on function public.po_vendor_send_step(uuid) from public, anon;
grant execute on function public.po_vendor_send_step(uuid) to authenticated, silo_integration;

-- -- 4. The queue ------------------------------------------------------------
create table if not exists public.po_vendor_emails (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null,
  po_header_id uuid not null references public.po_headers(id) on delete cascade,
  factory_id uuid references public.factories(id) on delete set null,

  to_email text not null,
  subject text not null,
  body text not null,

  status text not null default 'queued',

  queued_at timestamptz not null default now(),
  queued_by uuid references auth.users(id),

  claimed_at timestamptz,
  claimed_by_grant_id uuid references public.silo_api_grants(id) on delete set null,
  claimed_by_app text,
  idempotency_key text,

  -- The attachment's one-time key: hashed at rest, one PO, 24 hours.
  doc_token_hash text,
  doc_token_expires_at timestamptz,

  sent_at timestamptz,
  sent_evidence text,
  sent_via text,

  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint po_vendor_emails_status_check
    check (status in ('queued', 'claimed', 'sent', 'cancelled')),
  constraint po_vendor_emails_to_email_check
    check (btrim(to_email) <> '' and position('@' in to_email) > 1),
  constraint po_vendor_emails_subject_len check (length(btrim(subject)) between 1 and 300),
  constraint po_vendor_emails_body_len check (length(btrim(body)) between 1 and 20000),
  constraint po_vendor_emails_evidence_len check (sent_evidence is null or length(sent_evidence) <= 500),
  constraint po_vendor_emails_sent_has_evidence
    check (status <> 'sent' or (sent_at is not null and btrim(coalesce(sent_evidence, '')) <> ''))
);

comment on table public.po_vendor_emails is
  'Purchase-order emails to a factory: queued by a person in SILO with the drafted copy they saw, claimed by an approved AI connection (po_email:send), sent from that person''s own mailbox, and marked sent here with the message id. SILO sends none of them. 20261128050000.';

-- One live email per purchase order: queueing the same PO twice while one is
-- still waiting would be two emails to the factory for one order.
create unique index if not exists po_vendor_emails_one_live_per_po
  on public.po_vendor_emails (po_header_id)
  where status in ('queued', 'claimed');

create index if not exists po_vendor_emails_company_status_idx
  on public.po_vendor_emails (company_entity_id, status, queued_at);

create index if not exists po_vendor_emails_factory_idx
  on public.po_vendor_emails (factory_id, queued_at desc);

create unique index if not exists po_vendor_emails_grant_key_unique
  on public.po_vendor_emails (claimed_by_grant_id, idempotency_key, po_header_id)
  where claimed_by_grant_id is not null and idempotency_key is not null;

alter table public.po_vendor_emails enable row level security;

-- Reading: anyone who can see the company's POs.
drop policy if exists po_vendor_emails_active_select on public.po_vendor_emails;
create policy po_vendor_emails_active_select on public.po_vendor_emails
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Queueing and cancelling: the same authority as moving that PO's step, which
-- is po_headers' own UPDATE rule -- admin of the company, or the PO's creator.
drop policy if exists po_vendor_emails_queue_insert on public.po_vendor_emails;
create policy po_vendor_emails_queue_insert on public.po_vendor_emails
  for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and status = 'queued'
    and public.silo_api_may_set_po_status(auth.uid(), company_entity_id, po_header_id));

drop policy if exists po_vendor_emails_queue_update on public.po_vendor_emails;
create policy po_vendor_emails_queue_update on public.po_vendor_emails
  for update to authenticated
  using (
    company_entity_id = public.active_company_id()
    and status in ('queued', 'cancelled')
    and public.silo_api_may_set_po_status(auth.uid(), company_entity_id, po_header_id))
  with check (
    company_entity_id = public.active_company_id()
    and status in ('queued', 'cancelled')
    and public.silo_api_may_set_po_status(auth.uid(), company_entity_id, po_header_id));

drop policy if exists po_vendor_emails_queue_delete on public.po_vendor_emails;
create policy po_vendor_emails_queue_delete on public.po_vendor_emails
  for delete to authenticated
  using (
    company_entity_id = public.active_company_id()
    and status = 'queued'
    and public.silo_api_may_set_po_status(auth.uid(), company_entity_id, po_header_id));

-- Supabase re-grants every new public table to anon and authenticated; the
-- connection reaches this table only through its two SECURITY DEFINER tools,
-- and the document token never leaves the database.
revoke all on public.po_vendor_emails from public, anon, authenticated;
grant select (id, company_entity_id, po_header_id, factory_id, to_email, subject, body, status,
              queued_at, queued_by, claimed_at, claimed_by_app, sent_at, sent_evidence, sent_via,
              cancelled_at, cancelled_by, created_at, updated_at)
  on public.po_vendor_emails to authenticated;
grant insert (company_entity_id, po_header_id, factory_id, to_email, subject, body, status, queued_by)
  on public.po_vendor_emails to authenticated;
grant update (to_email, subject, body, status, cancelled_at, cancelled_by, updated_at)
  on public.po_vendor_emails to authenticated;
grant delete on public.po_vendor_emails to authenticated;

-- -- 5. The drafted copy -----------------------------------------------------
-- SECURITY INVOKER: it reads the PO, its lines, the factory and the company's
-- settings as the person asking, so it can never compose an email out of rows
-- that person may not read.
create or replace function public.po_vendor_email_draft(p_po_header_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_po        record;
  v_fac       record;
  v_set       record;
  v_ent       record;
  v_styles    integer := 0;
  v_units     numeric := 0;
  v_lines     text := '';
  v_open      text := '';
  v_subject   text;
  v_body      text;
  v_contact   text;
  v_signoff   text;
  v_greeting  text;
  v_company   text;
begin
  select h.id, h.po_name, h.factory_id, h.order_date, h.req_ship_date, h.expected_arrival_date,
         h.status, h.notes, h.is_new_product_po, h.company_entity_id
    into v_po
    from public.po_headers h
   where h.id = p_po_header_id;
  if v_po.id is null then
    raise exception 'unknown_po: no such purchase order' using errcode = 'check_violation';
  end if;

  select f.id, f.factory_name, f.contact_name, f.contact_email, f.payment_terms, f.shipping_terms
    into v_fac
    from public.factories f
   where f.id = v_po.factory_id;

  select count(*)::integer, coalesce(sum(l.qty), 0)
    into v_styles, v_units
    from public.po_lines l
   where l.po_header_id = v_po.id;

  -- Up to eight lines of the order itself, so the factory can check the email
  -- against the attachment without opening it.
  select coalesce(string_agg(t.line, E'\n'), '')
    into v_lines
    from (
      select '  ' || rpad(coalesce(nullif(btrim(l.title_snapshot), ''), coalesce(l.sku_snapshot, 'Item')), 42)
             || ' ' || to_char(coalesce(l.qty, 0), 'FM999G999G999') as line
        from public.po_lines l
       where l.po_header_id = v_po.id
       order by l.qty desc nulls last
       limit 8
    ) t;

  -- Other purchase orders still with this factory: what a buyer would mention.
  select coalesce(string_agg(t.line, E'\n'), '')
    into v_open
    from (
      select '  ' || h2.po_name || ' (' || h2.status || ')'
             || case when h2.expected_arrival_date is not null
                       then ', expected ' || to_char(h2.expected_arrival_date, 'DD Mon YYYY')
                     else '' end as line
        from public.po_headers h2
        join public.po_status_options o
          on o.company_entity_id = h2.company_entity_id
         and lower(o.name) = lower(h2.status)
       where h2.factory_id = v_po.factory_id
         and h2.company_entity_id = v_po.company_entity_id
         and h2.id <> v_po.id
         and o.is_open = true
       order by h2.order_date desc nulls last
       limit 4
    ) t;

  select s.legal_name, s.purchasing_contact_name, s.purchasing_contact_email, s.purchasing_contact_phone,
         s.po_email_greeting, s.po_email_signoff
    into v_set
    from public.company_settings s
   where s.company_entity_id = v_po.company_entity_id;

  select e.title into v_ent from public.entities e where e.id = v_po.company_entity_id;

  v_company := coalesce(nullif(btrim(coalesce(v_set.legal_name, '')), ''), nullif(btrim(coalesce(v_ent.title, '')), ''));
  v_contact := nullif(btrim(concat_ws(E'\n',
                 nullif(btrim(coalesce(v_set.purchasing_contact_name, '')), ''),
                 v_company,
                 nullif(btrim(coalesce(v_set.purchasing_contact_email, '')), ''),
                 nullif(btrim(coalesce(v_set.purchasing_contact_phone, '')), ''))), '');

  v_greeting := coalesce(nullif(btrim(coalesce(v_set.po_email_greeting, '')), ''),
                         'Hi' || coalesce(' ' || nullif(btrim(coalesce(v_fac.contact_name, '')), ''), '') || ',');
  v_signoff  := coalesce(nullif(btrim(coalesce(v_set.po_email_signoff, '')), ''), 'Thanks,');

  v_subject := concat_ws(' · ',
    nullif(btrim(concat_ws(' ', v_company, coalesce(v_po.po_name, 'Purchase order'))), ''),
    to_char(v_units, 'FM999G999G999') || ' units',
    case when v_po.req_ship_date is not null
           then 'ship by ' || to_char(v_po.req_ship_date, 'DD Mon YYYY') end);

  v_body := v_greeting || E'\n\n'
    || 'Please find attached purchase order ' || coalesce(v_po.po_name, '(unnamed)')
    || case when v_po.order_date is not null then ', dated ' || to_char(v_po.order_date, 'DD Mon YYYY') else '' end
    || '.'
    || case when v_po.is_new_product_po
              then ' This order contains new product, so it needs a pre-production sample before bulk.' else '' end
    || E'\n\n'
    || '  Styles           ' || v_styles::text || E'\n'
    || '  Total units      ' || to_char(v_units, 'FM999G999G999') || E'\n'
    || case when v_po.req_ship_date is not null
              then '  Requested ship   ' || to_char(v_po.req_ship_date, 'DD Mon YYYY') || E'\n' else '' end
    || case when v_po.expected_arrival_date is not null
              then '  Expected arrival ' || to_char(v_po.expected_arrival_date, 'DD Mon YYYY') || E'\n' else '' end
    || case when nullif(btrim(coalesce(v_fac.payment_terms, '')), '') is not null
              then '  Payment terms    ' || v_fac.payment_terms || E'\n' else '' end
    || case when nullif(btrim(coalesce(v_fac.shipping_terms, '')), '') is not null
              then '  Shipping terms   ' || v_fac.shipping_terms || E'\n' else '' end
    || case when v_lines <> '' then E'\n' || v_lines || E'\n' else '' end
    || case when v_open <> '' then E'\nStill open with you:\n' || v_open || E'\n' else '' end
    || case when nullif(btrim(coalesce(v_po.notes, '')), '') is not null
              then E'\n' || v_po.notes || E'\n' else '' end
    || E'\nPlease confirm receipt of this order, the unit prices and the ship date.\n\n'
    || v_signoff
    || case when v_contact is not null then E'\n' || v_contact else '' end;

  return jsonb_build_object(
    'po_header_id', v_po.id,
    'po_name', v_po.po_name,
    'factory_id', v_fac.id,
    'factory_name', v_fac.factory_name,
    'to_email', nullif(btrim(lower(coalesce(v_fac.contact_email, ''))), ''),
    'subject', v_subject,
    'body', v_body,
    'styles', v_styles,
    'units', v_units,
    'attachment_filename', coalesce(nullif(btrim(coalesce(v_po.po_name, '')), ''), 'purchase-order') || '.pdf',
    'missing', (
      case when nullif(btrim(lower(coalesce(v_fac.contact_email, ''))), '') is null
             then jsonb_build_array('factory contact email') else '[]'::jsonb end
      || case when v_company is null then jsonb_build_array('company name') else '[]'::jsonb end
      || case when v_contact is null then jsonb_build_array('purchasing contact') else '[]'::jsonb end));
end;
$$;

comment on function public.po_vendor_email_draft(uuid) is
  'The drafted factory email for one purchase order, built from the PO''s own factors (dates, styles, units, new-product flag, notes), the factory''s terms, the other POs still open with that factory, and the company''s purchasing contact. SECURITY INVOKER, so it composes only from rows the caller may read. `missing` names what a person still has to fill in. The page stores this text on the queued row: what the person saw and edited is what is handed over. 20261128050000.';

revoke all on function public.po_vendor_email_draft(uuid) from public, anon;
grant execute on function public.po_vendor_email_draft(uuid) to authenticated;

-- A company's own wording, where it wants one. Blank is the neutral default
-- above; nothing here is ever company-specific in code.
alter table public.company_settings
  add column if not exists po_email_greeting text,
  add column if not exists po_email_signoff text;

comment on column public.company_settings.po_email_greeting is
  'First line of a purchase-order email to a factory. Blank uses SILO''s neutral greeting with the factory contact''s name. 20261128050000.';
comment on column public.company_settings.po_email_signoff is
  'Sign-off line of a purchase-order email to a factory, above the purchasing contact block. Blank uses "Thanks,". 20261128050000.';

-- -- 6. The fence -------------------------------------------------------------
create or replace function public.silo_api_po_email_grant()
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
  perform public.silo_api_require_scope('po_email:send');

  if not public.silo_api_is_integration() then
    raise exception 'not_a_connection: this tool is for approved AI connections; queue PO emails in SILO'
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

comment on function public.silo_api_po_email_grant() is
  'The shared fence of the po_email:send tools: scope, a live unpaused grant bound to a company, and the approver still an active member of it. Internal. 20261128050000.';

revoke all on function public.silo_api_po_email_grant()
  from public, anon, authenticated, silo_integration, silo_revoked;

-- -- 7. Take the queued emails ------------------------------------------------
create or replace function public.silo_api_po_emails_to_send(
  p_limit integer default 10,
  p_idempotency_key text default null)
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
  v_replay  boolean := false;
  v_used    integer;
  v_room    integer;
  v_limit   integer;
  v_e       record;
  v_raw     text;
  v_claimed jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_n       integer := 0;
  v_step    text;
begin
  v_grant   := public.silo_api_po_email_grant();
  v_company := v_grant.company_entity_id;
  v_user    := v_grant.user_id;
  v_app     := public.silo_api_app_name(v_grant.client_id, v_grant.app_key);
  v_step    := public.po_vendor_send_step(v_company);

  if length(coalesce(v_key, '')) > 100 then
    raise exception 'invalid_idempotency_key: keep it under 100 characters'
      using errcode = 'check_violation';
  end if;

  -- A retry with the same key is the same claim: the same emails come back,
  -- each with a fresh document link, and nothing more is taken.
  if v_key is not null then
    v_replay := exists (
      select 1 from public.po_vendor_emails e
       where e.claimed_by_grant_id = v_grant.id
         and e.idempotency_key = v_key
         and e.status = 'claimed');
  end if;

  if not v_replay then
    -- The cap, taken one call at a time (20261110160000).
    perform pg_advisory_xact_lock(hashtextextended('silo_api_writes:' || v_grant.id::text, 0));
    select count(*) into v_used
      from public.silo_api_writes w
     where w.grant_id = v_grant.id
       and w.created_at > now() - interval '1 day';
    v_room := public.silo_api_write_cap() - v_used;
    if v_room <= 0 then
      raise exception 'write_cap_reached: this connection has used its % writes for today', public.silo_api_write_cap()
        using errcode = 'check_violation';
    end if;
    v_limit := least(greatest(coalesce(p_limit, 10), 1), 10, v_room);
  else
    v_limit := 10;
  end if;

  for v_e in
    select e.id, e.po_header_id, e.to_email, e.subject, e.body, e.factory_id
      from public.po_vendor_emails e
     where e.company_entity_id = v_company
       and case when v_replay
                  then e.claimed_by_grant_id = v_grant.id and e.idempotency_key = v_key and e.status = 'claimed'
                  else e.status = 'queued'
            end
     order by e.queued_at, e.id
     for update of e skip locked
  loop
    exit when v_n >= v_limit;
    begin
      -- The authority is the approving person's, and it is theirs TODAY: the
      -- same rule that decides whether they could move this PO in SILO.
      if not public.silo_api_may_set_po_status(v_user, v_company, v_e.po_header_id) then
        raise exception 'not_permitted: the person who approved this connection may not act on this purchase order in SILO';
      end if;

      v_raw := encode(extensions.gen_random_bytes(32), 'hex');

      update public.po_vendor_emails
         set status = 'claimed',
             claimed_at = now(),
             claimed_by_grant_id = v_grant.id,
             claimed_by_app = v_app,
             idempotency_key = coalesce(v_key, idempotency_key),
             doc_token_hash = encode(extensions.digest(v_raw, 'sha256'), 'hex'),
             doc_token_expires_at = now() + interval '24 hours',
             updated_at = now()
       where id = v_e.id;

      if not v_replay then
        insert into public.silo_api_writes
          (company_entity_id, grant_id, user_id, via, kind, target_id)
        values
          (v_company, v_grant.id, v_user, 'app', 'po_email_claim', v_e.id);
      end if;

      v_n := v_n + 1;
      v_claimed := v_claimed || jsonb_build_object(
        'draft_id', v_e.id,
        'po_header_id', v_e.po_header_id,
        'to', v_e.to_email,
        'subject', v_e.subject,
        'body', v_e.body,
        'attachment', jsonb_build_object(
          'filename', (select coalesce(nullif(btrim(coalesce(h.po_name, '')), ''), 'purchase-order') || '.pdf'
                         from public.po_headers h where h.id = v_e.po_header_id),
          'media_type', 'application/pdf',
          -- A path, not a URL: the project's own address belongs to whatever
          -- is serving the call (the MCP function makes it absolute), never
          -- to a literal in the database.
          'url_path', '/functions/v1/po-document?t=' || v_raw,
          'expires_at', now() + interval '24 hours',
          'note', 'Download this and attach it to the email. The link is single-use per claim, is only this purchase order, and stops working in 24 hours.'));
    exception when others then
      if jsonb_array_length(v_skipped) < 10 then
        v_skipped := v_skipped || jsonb_build_object(
          'draft_id', v_e.id, 'reason', split_part(sqlerrm, ':', 1), 'detail', sqlerrm);
      end if;
    end;
  end loop;

  return json_build_object(
    'claimed', v_claimed,
    'skipped', v_skipped,
    'replayed', v_replay,
    'via', v_app,
    'note', case when v_n = 0 then
      'No purchase-order emails are waiting. A person queues them in SILO first, on the Factories page or in PO Report.' end,
    'next_step', case when v_n > 0 then
      'Download each attachment, then send that email from the person''s own mailbox, exactly as written, to the "to" address only '
      || '-- no extra recipients, no BCC, no follow-ups, no rewording. Then call mark_po_email_sent with its draft_id and the sent '
      || 'message''s id. An email you do not send stays claimed in SILO and a person can put it back.'
      end,
    'moves_po_to', v_step,
    'open_in_silo', '/v2/factories.html');
end;
$$;

comment on function public.silo_api_po_emails_to_send(integer, text) is
  'MCP / developer API tool (po_email:send): hands over up to 10 purchase-order emails a person queued in SILO -- recipient, subject, body and a single-use link to that PO as a PDF to attach -- for the person''s own AI to send from their own mailbox. Each one claimed is one write against silo_api_write_cap(); the same idempotency key returns the same emails with fresh links and spends nothing. It cannot queue, write or change an email, and SILO sends nothing. 20261128050000.';

revoke all on function public.silo_api_po_emails_to_send(integer, text)
  from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_po_emails_to_send(integer, text) to silo_integration;

-- -- 8. Record a send ---------------------------------------------------------
create or replace function public.silo_api_mark_po_email_sent(
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
  v_e        record;
  v_step     text;
  v_moved    boolean := false;
  v_why      text;
  v_rows     integer;
begin
  v_grant   := public.silo_api_po_email_grant();
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

  select e.* into v_e
    from public.po_vendor_emails e
   where e.id = p_draft_id
     and e.company_entity_id = v_company;
  if v_e.id is null then
    raise exception 'unknown_draft: no such queued purchase-order email in this company'
      using errcode = 'check_violation';
  end if;

  -- Calling it again for the same email is the same record, not a second one.
  if v_e.status = 'sent' then
    return json_build_object(
      'recorded', true, 'replayed', true,
      'draft_id', v_e.id, 'po_header_id', v_e.po_header_id,
      'sent_at', v_e.sent_at, 'evidence', v_e.sent_evidence, 'via', v_e.sent_via);
  end if;

  if v_e.status <> 'claimed' or v_e.claimed_by_grant_id is distinct from v_grant.id then
    raise exception 'not_claimed: this connection did not take that email, so it cannot record it as sent'
      using errcode = 'insufficient_privilege';
  end if;

  update public.po_vendor_emails
     set status = 'sent',
         sent_at = now(),
         sent_evidence = v_evidence,
         sent_via = v_app,
         doc_token_hash = null,
         doc_token_expires_at = null,
         updated_at = now()
   where id = v_e.id
     and status = 'claimed';
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'draft_moved: that email changed while this was being recorded. Read it again before recording it.'
      using errcode = 'check_violation';
  end if;

  -- The PO moves on, when the company has a step for it, that step allows a
  -- connection to set it, and the approving person may move this PO. Each of
  -- those failing is reported, never silent: the email IS recorded either way.
  v_step := public.po_vendor_send_step(v_company);
  if v_step is null then
    v_why := 'This company has no step that means the factory has the order, so the PO was left where it is.';
  elsif not public.silo_api_may_set_po_status(v_user, v_company, v_e.po_header_id) then
    v_why := 'The person who approved this connection may not change this purchase order in SILO, so its step was left alone.';
  else
    update public.po_headers
       set status = v_step
     where id = v_e.po_header_id
       and company_entity_id = v_company
       and status is distinct from v_step;
    get diagnostics v_rows = row_count;
    v_moved := v_rows > 0;
    if not v_moved then
      v_why := 'The purchase order was already at that step.';
    end if;
  end if;

  return json_build_object(
    'recorded', true, 'replayed', false,
    'draft_id', v_e.id,
    'po_header_id', v_e.po_header_id,
    'sent_at', now(),
    'evidence', v_evidence,
    'via', v_app,
    'po_moved_to', case when v_moved then v_step end,
    'note', v_why,
    'open_in_silo', '/v2/factories.html');
end;
$$;

comment on function public.silo_api_mark_po_email_sent(uuid, text) is
  'MCP / developer API tool (po_email:send): records one claimed purchase-order email as sent by the person who approved the connection, with the sent message''s id as evidence, retires its document link, and moves the PO to the company''s vendor-send step when that step allows it. Calling it again for the same email returns the first record. 20261128050000.';

revoke all on function public.silo_api_mark_po_email_sent(uuid, text)
  from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_mark_po_email_sent(uuid, text) to silo_integration;

-- -- 9. Stamping and housekeeping --------------------------------------------
create or replace function public.po_vendor_emails_touch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' and new.queued_by is null then
    new.queued_by := auth.uid();
  end if;
  return new;
end;
$$;

revoke all on function public.po_vendor_emails_touch() from public, anon, authenticated, silo_integration, silo_revoked;

drop trigger if exists po_vendor_emails_touch_trg on public.po_vendor_emails;
create trigger po_vendor_emails_touch_trg
  before insert or update on public.po_vendor_emails
  for each row execute function public.po_vendor_emails_touch();

select public.attach_stamp_company_entity_id_triggers();
