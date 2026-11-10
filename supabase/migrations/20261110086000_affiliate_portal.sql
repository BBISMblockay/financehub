-- =============================================================================
-- Affiliate Studio -- the affiliate-facing side of the database.
--
-- An affiliate is NOT a SILO user. They get no account, no membership and no
-- workspace: they hold a link. Every function in this file is therefore
-- executable by the SERVICE ROLE ONLY (the affiliate-portal edge function) and
-- by nothing a browser can reach, because each one takes a token HASH, and a
-- function that accepts a credential and is callable by `authenticated` is a
-- credential oracle.
--
-- The token model is the public review portal's, which is already in
-- production: the raw token lives only in the link, only its SHA-256 is
-- stored, it maps to exactly one affiliate or prospect, and it carries a
-- NOT NULL expiry. The edge function hashes; the database never sees the raw
-- token and so cannot leak it.
--
-- Needs 20261110084000 and 20261110085000.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Delivery results for transactional mail
-- ---------------------------------------------------------------------------
--
-- Every email SILO sends an affiliate -- signup confirmation, portal link,
-- code and link details, payout status -- is recorded here with what the
-- provider answered. "Did they get it" is then a stored fact rather than an
-- assumption, and a send that did not happen (no API key, suppressed address,
-- provider refusal) is distinguishable from one that did.
--
-- This table never holds PROSPECT outreach: SILO does not send that at all.
-- The CHECK on kind is what makes that a schema fact rather than a habit.
create table if not exists public.affiliate_notifications (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  program_id        uuid references public.affiliate_programs(id) on delete set null,
  affiliate_id      uuid references public.affiliates(id) on delete set null,
  kind              text not null check (kind in
                      ('signup_confirmation','portal_link','codes_and_links','payout_status','link_renewal')),
  to_email          text not null,
  subject           text,
  status            text not null check (status in ('sent','failed','skipped')),
  provider          text not null default 'resend',
  provider_message_id text,
  reason            text,
  triggered_by      uuid references public.profiles(id),
  created_at        timestamptz not null default now()
);

create index if not exists affiliate_notifications_affiliate_idx
  on public.affiliate_notifications (company_entity_id, affiliate_id, created_at desc);

alter table public.affiliate_notifications enable row level security;

drop policy if exists affiliate_notifications_select on public.affiliate_notifications;
create policy affiliate_notifications_select on public.affiliate_notifications
  for select to authenticated
  using (company_entity_id = public.active_company_id());

revoke insert, update, delete on public.affiliate_notifications from authenticated, anon;
grant all on public.affiliate_notifications to service_role;

comment on table public.affiliate_notifications is
  'Delivery record of every TRANSACTIONAL email sent to an affiliate (signup confirmation, portal link, code/link details, payout status, link renewal) and what the provider answered. status skipped/failed carry a reason. The kind CHECK has no outreach value on purpose: SILO never sends prospect outreach. Written by the affiliate-portal and affiliate-invite edge functions only.';

-- ---------------------------------------------------------------------------
-- 1. Issuing a link
-- ---------------------------------------------------------------------------

create or replace function public.affiliate_issue_access_token(
  p_company_entity_id uuid,
  p_program_id uuid,
  p_purpose text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_affiliate_id uuid default null,
  p_prospect_id uuid default null,
  p_created_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if p_purpose not in ('signup','portal') then
    raise exception 'affiliate_issue_access_token: unknown purpose %', p_purpose;
  end if;
  if btrim(coalesce(p_token_hash,'')) = '' then
    raise exception 'affiliate_issue_access_token: a token hash is required';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'affiliate_issue_access_token: expires_at must be in the future';
  end if;
  if p_affiliate_id is null and p_prospect_id is null then
    raise exception 'affiliate_issue_access_token: a token must name an affiliate or a prospect';
  end if;

  -- The subject must belong to the company AND the program the caller named.
  -- Without this, a caller could mint a link that resolves to one tenant's
  -- affiliate under another tenant's program.
  if p_affiliate_id is not null and not exists (
    select 1 from public.affiliates a
     where a.id = p_affiliate_id
       and a.company_entity_id = p_company_entity_id
       and a.program_id = p_program_id
  ) then
    raise exception 'affiliate_issue_access_token: affiliate does not belong to that company and program';
  end if;
  if p_prospect_id is not null and not exists (
    select 1 from public.affiliate_prospects x
     where x.id = p_prospect_id
       and x.company_entity_id = p_company_entity_id
       and x.program_id = p_program_id
  ) then
    raise exception 'affiliate_issue_access_token: prospect does not belong to that company and program';
  end if;

  -- One live link per subject per purpose: a second signup link in a second
  -- email means two paths into one record, and the older mail keeps working
  -- after the person has already signed up.
  update public.affiliate_access_tokens
     set revoked_at = now()
   where company_entity_id = p_company_entity_id
     and purpose = p_purpose
     and revoked_at is null
     and first_used_at is null
     and ((p_affiliate_id is not null and affiliate_id = p_affiliate_id)
       or (p_prospect_id  is not null and prospect_id  = p_prospect_id));

  insert into public.affiliate_access_tokens (
    company_entity_id, program_id, affiliate_id, prospect_id,
    purpose, token_hash, expires_at, created_by
  ) values (
    p_company_entity_id, p_program_id, p_affiliate_id, p_prospect_id,
    p_purpose, p_token_hash, p_expires_at, p_created_by
  ) returning id into v_id;

  return v_id;
end;
$$;

comment on function public.affiliate_issue_access_token(uuid, uuid, text, text, timestamptz, uuid, uuid, uuid) is
  'Records the SHA-256 of a signup or portal link. Service role only -- a function that accepts a token hash and is callable by a browser is a credential oracle. Verifies the subject really belongs to the named company and program, revokes any earlier unused link of the same purpose for that subject, and refuses a past or missing expiry.';

revoke all on function public.affiliate_issue_access_token(uuid, uuid, text, text, timestamptz, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.affiliate_issue_access_token(uuid, uuid, text, text, timestamptz, uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Resolving a link
-- ---------------------------------------------------------------------------
--
-- SETOF, not a composite. `select * from f()` on a composite-returning
-- function yields ONE ALL-NULL ROW when nothing matched, so `not exists` says
-- false and an unknown token reads as a valid one with empty fields. That has
-- been a real fail-open defect in this schema; it is not repeated here.
create or replace function public.affiliate_portal_resolve(p_token_hash text)
returns table (
  token_id uuid,
  purpose text,
  company_entity_id uuid,
  company_title text,
  program_id uuid,
  program_name text,
  program_status text,
  terms_markdown text,
  terms_version integer,
  commission_kind text,
  commission_percent numeric,
  commission_fixed_cents integer,
  currency text,
  affiliate_id uuid,
  prospect_id uuid,
  affiliate_status text,
  affiliate_display_name text,
  affiliate_contact_email text,
  terms_version_accepted integer,
  terms_accepted_at timestamptz,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id, t.purpose, t.company_entity_id, e.title,
    p.id, p.name, p.status, p.terms_markdown, p.terms_version,
    coalesce(a.commission_kind, p.commission_kind),
    case when a.commission_kind is null then p.commission_percent else a.commission_percent end,
    case when a.commission_kind is null then p.commission_fixed_cents else a.commission_fixed_cents end,
    p.currency,
    t.affiliate_id, t.prospect_id,
    a.status, a.display_name, a.contact_email,
    a.terms_version_accepted, a.terms_accepted_at,
    t.expires_at
  from public.affiliate_access_tokens t
  -- Company-qualified joins: a token can only ever show its OWN company's
  -- program and affiliate (the composite foreign keys below make any other
  -- pairing unstorable; this makes it unreadable too).
  join public.affiliate_programs p
    on p.id = t.program_id and p.company_entity_id = t.company_entity_id
  join public.entities e on e.id = t.company_entity_id
  left join public.affiliates a
    on a.id = t.affiliate_id and a.company_entity_id = t.company_entity_id and a.program_id = t.program_id
  where t.token_hash = p_token_hash
    and t.revoked_at is null
    -- An expiry compared with `or expires_at is null` would be no expiry at
    -- all. The column is NOT NULL and the comparison is unconditional.
    and t.expires_at > now();
$$;

comment on function public.affiliate_portal_resolve(text) is
  'Resolves a link hash to exactly the facts the affiliate-facing page may show: the brand, the program terms and the rate that applies to them. Returns SETOF so an unknown, revoked or expired token returns NO ROW -- a composite return would hand back one all-NULL row that reads as valid. Service role only.';

revoke all on function public.affiliate_portal_resolve(text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_resolve(text) to service_role;

create or replace function public.affiliate_portal_touch_token(p_token_hash text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.affiliate_access_tokens
     set first_used_at = coalesce(first_used_at, now()),
         last_used_at = now(),
         used_count = used_count + 1
   where token_hash = p_token_hash
     and revoked_at is null
     and expires_at > now();
$$;

revoke all on function public.affiliate_portal_touch_token(text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_touch_token(text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Accepting the terms
-- ---------------------------------------------------------------------------

create or replace function public.affiliate_portal_accept_terms(
  p_token_hash text,
  p_signed_name text,
  p_terms_version integer,
  p_acceptance jsonb default '{}'::jsonb,
  p_contact_name text default null,
  p_payout_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok    record;
  v_prog   record;
  v_aff    public.affiliates;
begin
  if btrim(coalesce(p_signed_name,'')) = '' then
    raise exception 'affiliate_portal_accept_terms: a signed name is required';
  end if;

  select t.* into v_tok
    from public.affiliate_access_tokens t
   where t.token_hash = p_token_hash
     and t.revoked_at is null
     and t.expires_at > now();
  if not found then
    raise exception 'affiliate_portal_accept_terms: link is not valid' using errcode = '42501';
  end if;
  if v_tok.affiliate_id is null then
    raise exception 'affiliate_portal_accept_terms: this link has no affiliate record yet';
  end if;

  select * into v_prog from public.affiliate_programs where id = v_tok.program_id;
  if v_prog.status <> 'active' then
    raise exception 'affiliate_portal_accept_terms: the program is % and is not accepting signups', v_prog.status
      using errcode = '42501';
  end if;

  -- The version the page SHOWED must be the version still current. A program
  -- whose terms were revised while the page was open would otherwise record an
  -- acceptance of text the person never read.
  if p_terms_version is distinct from v_prog.terms_version then
    raise exception 'affiliate_portal_accept_terms: these terms have been updated (version % is now %). Reload and read them again.',
      p_terms_version, v_prog.terms_version
      using errcode = '40001';
  end if;

  select * into v_aff from public.affiliates where id = v_tok.affiliate_id;
  if v_aff.status in ('paused','terminated') then
    raise exception 'affiliate_portal_accept_terms: this affiliation is %', v_aff.status
      using errcode = '42501';
  end if;

  -- Already accepted THIS version: idempotent, so a double-submit or a
  -- reloaded confirmation does not re-stamp the acceptance time.
  if v_aff.terms_version_accepted = v_prog.terms_version and v_aff.terms_accepted_at is not null then
    return jsonb_build_object('status', v_aff.status, 'already_accepted', true,
                              'terms_version', v_aff.terms_version_accepted);
  end if;

  update public.affiliates
     set status = 'active',
         terms_version_accepted = v_prog.terms_version,
         terms_accepted_at = now(),
         -- What was accepted, and the circumstances the edge function
         -- observed (IP, user agent, the terms hash it rendered). Never
         -- trusted as authorization -- it is a record, not a credential.
         terms_acceptance = jsonb_strip_nulls(
           coalesce(p_acceptance, '{}'::jsonb)
           || jsonb_build_object('signed_name', btrim(p_signed_name),
                                 'accepted_at', now(),
                                 'terms_version', v_prog.terms_version)),
         contact_name = coalesce(nullif(btrim(coalesce(p_contact_name,'')), ''), contact_name),
         note = coalesce(nullif(btrim(coalesce(p_payout_note,'')), ''), note),
         updated_at = now()
   where id = v_aff.id;

  -- The signup link has done its job. Leaving it live is a second path into a
  -- record that is now active.
  update public.affiliate_access_tokens
     set revoked_at = now()
   where id = v_tok.id and purpose = 'signup';

  if v_aff.from_prospect_id is not null then
    update public.affiliate_prospects
       set status = 'signed_up', updated_at = now()
     where id = v_aff.from_prospect_id
       and company_entity_id = v_tok.company_entity_id;

    update public.affiliate_outreach_drafts
       set state = 'signed_up', updated_at = now()
     where company_entity_id = v_tok.company_entity_id
       and prospect_id = v_aff.from_prospect_id
       and state in ('exported','sent','replied');
  end if;

  return jsonb_build_object('status', 'active', 'already_accepted', false,
                            'terms_version', v_prog.terms_version);
end;
$$;

comment on function public.affiliate_portal_accept_terms(text, text, integer, jsonb, text, text) is
  'Records an affiliate accepting a specific VERSION of a program''s terms and activates them. Refuses a version other than the one now current (the page may have been open while the terms were revised), is idempotent for a version already accepted, revokes the signup link it was used with, and advances the prospect and outreach rows. Service role only.';

revoke all on function public.affiliate_portal_accept_terms(text, text, integer, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_accept_terms(text, text, integer, jsonb, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. What an affiliate may see about themselves
-- ---------------------------------------------------------------------------

create or replace function public.affiliate_portal_statement(p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok record;
  v_out jsonb;
begin
  select t.* into v_tok
    from public.affiliate_access_tokens t
   where t.token_hash = p_token_hash
     and t.revoked_at is null
     and t.expires_at > now();
  if not found then
    raise exception 'affiliate_portal_statement: link is not valid' using errcode = '42501';
  end if;
  if v_tok.affiliate_id is null then
    return jsonb_build_object('entries', '[]'::jsonb, 'codes', '[]'::jsonb,
                              'links', '[]'::jsonb, 'totals', '{}'::jsonb);
  end if;

  -- Deliberately NOT the order list. An affiliate may see what they earned
  -- and on how many orders; the merchant's per-order customer data is not
  -- theirs to read, and this is the one place that line is drawn.
  select jsonb_build_object(
    'affiliate', jsonb_build_object(
      'display_name', a.display_name, 'status', a.status,
      'terms_version_accepted', a.terms_version_accepted,
      'terms_accepted_at', a.terms_accepted_at),
    'currency', p.currency,
    'totals', (
      select jsonb_build_object(
        'earned_cents', coalesce(sum(l.amount_cents), 0),
        'entries', count(*),
        'orders', count(distinct l.order_id),
        'unclaimed_cents', coalesce(sum(l.amount_cents) filter (
          where not exists (select 1 from public.affiliate_payout_items i
                             join public.affiliate_payouts po on po.id = i.payout_id and po.status <> 'void'
                            where i.ledger_entry_id = l.id)), 0),
        'paid_cents', coalesce(sum(l.amount_cents) filter (
          where exists (select 1 from public.affiliate_payout_items i
                         join public.affiliate_payouts po on po.id = i.payout_id and po.status = 'marked_paid'
                        where i.ledger_entry_id = l.id)), 0))
        from public.affiliate_commission_ledger l
       where l.company_entity_id = v_tok.company_entity_id
         and l.affiliate_id = v_tok.affiliate_id),
    'monthly', (
      select coalesce(jsonb_agg(m order by m->>'month'), '[]'::jsonb) from (
        select jsonb_build_object(
                 'month', to_char(date_trunc('month', l.order_day), 'YYYY-MM'),
                 'orders', count(distinct l.order_id),
                 'amount_cents', sum(l.amount_cents)) as m
          from public.affiliate_commission_ledger l
         where l.company_entity_id = v_tok.company_entity_id
           and l.affiliate_id = v_tok.affiliate_id
           and l.order_day is not null
         group by date_trunc('month', l.order_day)) q),
    'codes', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'code', c.code, 'starts_on', c.starts_on, 'ends_on', c.ends_on,
               'status', c.status) order by c.starts_on desc), '[]'::jsonb)
        from public.affiliate_codes c
       where c.company_entity_id = v_tok.company_entity_id
         and c.affiliate_id = v_tok.affiliate_id),
    'links', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'destination_url', k.destination_url, 'utm_source', k.utm_source,
               'utm_medium', k.utm_medium, 'utm_campaign', k.utm_campaign,
               'starts_on', k.starts_on, 'ends_on', k.ends_on, 'status', k.status)
               order by k.starts_on desc), '[]'::jsonb)
        from public.affiliate_links k
       where k.company_entity_id = v_tok.company_entity_id
         and k.affiliate_id = v_tok.affiliate_id),
    'payouts', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'amount_cents', po.amount_cents, 'status', po.status,
               'marked_paid_at', po.marked_paid_at,
               'reference', case when po.status = 'marked_paid' then po.external_reference end)
               order by po.created_at desc), '[]'::jsonb)
        from public.affiliate_payouts po
       where po.company_entity_id = v_tok.company_entity_id
         and po.affiliate_id = v_tok.affiliate_id
         and po.status <> 'void')
  ) into v_out
  from public.affiliates a
  join public.affiliate_programs p on p.id = a.program_id
  where a.id = v_tok.affiliate_id;

  return v_out;
end;
$$;

comment on function public.affiliate_portal_statement(text) is
  'The affiliate''s own statement: totals, a per-month summary, their codes and links, and their payouts. Deliberately NOT an order list -- an affiliate may see what they earned and on how many orders, never the merchant''s per-order customer data. Service role only.';

revoke all on function public.affiliate_portal_statement(text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_statement(text) to service_role;

-- An EXPIRED portal link may ask for a fresh one -- which is mailed to the
-- address SILO already holds for that affiliate, never to an address the
-- request supplies. Holding an old link therefore proves nothing beyond "I
-- once had this person's mail", and the new link goes back to the same inbox.
-- A revoked link (a manager deliberately cut it) does NOT renew.
create or replace function public.affiliate_portal_renew_subject(p_token_hash text)
returns table (
  company_entity_id uuid, program_id uuid, affiliate_id uuid,
  contact_email text, display_name text, affiliate_status text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.company_entity_id, t.program_id, a.id, a.contact_email, a.display_name, a.status
  from public.affiliate_access_tokens t
  join public.affiliates a on a.id = t.affiliate_id
  where t.token_hash = p_token_hash
    and t.purpose = 'portal'
    and t.revoked_at is null
    and t.expires_at <= now()
    -- A link older than a year is not renewable: by then the address on file
    -- may well belong to somebody else.
    and t.expires_at > now() - interval '365 days'
    and a.status in ('active','paused');
$$;

comment on function public.affiliate_portal_renew_subject(text) is
  'For an EXPIRED (not revoked, not older than a year) portal link, the affiliate a fresh link should be mailed to -- always the address on file, never one the request supplies. SETOF so an unknown hash returns no row. Service role only.';

revoke all on function public.affiliate_portal_renew_subject(text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_renew_subject(text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Open applications
-- ---------------------------------------------------------------------------
--
-- Only for a program whose intake_mode is 'open'. An application creates a
-- PROSPECT, never an affiliate: a stranger filling in a form must not create
-- a record that can earn money. A manager approves it, which is what mints the
-- signup link.
create or replace function public.affiliate_portal_apply(
  p_company_entity_id uuid,
  p_program_slug text,
  p_email text,
  p_display_name text,
  p_platform text default 'web',
  p_handle text default null,
  p_profile_url text default null,
  p_pitch text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog record;
  v_prospect uuid;
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if position('@' in v_email) < 2 then
    raise exception 'affiliate_portal_apply: a valid email is required';
  end if;
  if btrim(coalesce(p_display_name,'')) = '' then
    raise exception 'affiliate_portal_apply: a name is required';
  end if;

  select * into v_prog
    from public.affiliate_programs
   where company_entity_id = p_company_entity_id
     and slug = lower(btrim(p_program_slug));
  -- No such program, a private one, and a paused one all get the SAME answer
  -- and code: whether a program exists is not something an anonymous form
  -- should be able to probe by guessing slugs.
  if not found or v_prog.status <> 'active' or v_prog.intake_mode <> 'open' then
    -- Same message either way: whether a private program exists is not
    -- something an anonymous form should be able to probe.
    raise exception 'affiliate_portal_apply: this program is not accepting applications'
      using errcode = '42501';
  end if;

  -- A public form that inserts rows needs a ceiling. Per program per day, in
  -- the company's own business day; past it the form refuses rather than
  -- letting a script fill the prospect list. Generous enough that no real
  -- program meets it.
  if (select count(*) from public.affiliate_prospects x
       where x.company_entity_id = p_company_entity_id
         and x.program_id = v_prog.id
         and x.source = 'applied'
         and x.created_at >= ((now() at time zone public.silo_company_timezone(p_company_entity_id))::date
                              at time zone public.silo_company_timezone(p_company_entity_id))) >= 200 then
    raise exception 'affiliate_portal_apply: this program has received too many applications today; try again tomorrow'
      using errcode = '54000';
  end if;

  if nullif(btrim(coalesce(p_profile_url,'')), '') is not null
     and btrim(p_profile_url) !~* '^\s*https?://\S+\s*$' then
    raise exception 'affiliate_portal_apply: the profile link must start with https://'
      using errcode = '22023';
  end if;

  -- The suppression list outranks an application: someone who asked not to be
  -- contacted does not get re-added to the pipeline by a form.
  if not public.affiliate_outreach_can_contact(
       p_company_entity_id, v_prog.id, v_email, p_handle, p_profile_url) then
    raise exception 'affiliate_portal_apply: this contact cannot be added'
      using errcode = '42501';
  end if;

  insert into public.affiliate_prospects (
    company_entity_id, program_id, display_name, platform, handle, profile_url,
    contact_email, contact_source_url, source, source_url, collected_at,
    evidence, status
  ) values (
    p_company_entity_id, v_prog.id, btrim(p_display_name),
    case when p_platform in ('instagram','tiktok','youtube','twitch','x','pinterest','blog','web','other')
         then p_platform else 'other' end,
    nullif(btrim(coalesce(p_handle,'')), ''), nullif(btrim(coalesce(p_profile_url,'')), ''),
    v_email, null, 'applied', null, now(),
    jsonb_strip_nulls(jsonb_build_object('pitch', nullif(btrim(coalesce(p_pitch,'')), ''),
                                         'applied_at', now())),
    'new'
  )
  on conflict (company_entity_id, program_id,
               lower(coalesce(nullif(btrim(profile_url), ''), platform || ':' || btrim(handle))))
  -- A profile URL or handle is public, so anyone can submit someone else's.
  -- The application is RECORDED on the existing prospect (evidence), but it
  -- never replaces a name or email a person already reviewed: otherwise a
  -- stranger could put their own address on an approved creator and receive
  -- that creator's signup link (review cycle 1, P2). An unreviewed prospect
  -- with no email yet may take the applicant's, since a person still has to
  -- approve it.
  do update set
       contact_email = case
         when affiliate_prospects.status in ('new','qualified')
           then coalesce(affiliate_prospects.contact_email, excluded.contact_email)
         else affiliate_prospects.contact_email end,
       display_name = case
         when affiliate_prospects.status in ('new','qualified') and affiliate_prospects.display_name is null
           then excluded.display_name
         else affiliate_prospects.display_name end,
       evidence = affiliate_prospects.evidence || jsonb_build_object('last_application',
         excluded.evidence || jsonb_strip_nulls(jsonb_build_object(
           'applicant_name', excluded.display_name, 'applicant_email', excluded.contact_email))),
       updated_at = now()
  returning id into v_prospect;

  return jsonb_build_object('prospect_id', v_prospect, 'status', 'received');
end;
$$;

comment on function public.affiliate_portal_apply(uuid, text, text, text, text, text, text, text) is
  'An open-intake application. Creates a PROSPECT, never an affiliate -- a stranger filling in a form must not create a record that can earn money. Refuses a non-open or inactive program with the same message either way, so the form cannot probe which private programs exist, and refuses anyone on the suppression list. Service role only.';

revoke all on function public.affiliate_portal_apply(uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_apply(uuid, text, text, text, text, text, text, text) to service_role;

-- Every reference between two affiliate tables stays inside one company.
-- A single-column foreign key lets a row of company A point at company B's
-- program, affiliate or prospect when someone knows the id; RLS checks only
-- the row's own company (review cycle 1, P1: an A affiliate row pointing at
-- B's program got B's terms through the portal). So every such reference
-- gets a composite twin, (col, company_entity_id) -> (id, company_entity_id),
-- found from the catalog rather than listed, so a table added later is
-- covered by re-running this block. The single-column keys stay: they carry
-- the cascade and set-null behaviour; the twin only refuses a mismatch.
do $$
declare
  r record;
  v_uq text;
  v_fk text;
begin
  for r in
    select c.conrelid, c.confrelid, cl.relname as child, pl.relname as parent, ca.attname as col
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_namespace n on n.oid = cl.relnamespace
      join pg_class pl on pl.oid = c.confrelid
      join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = c.conkey[1]
      join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
     where c.contype = 'f'
       and n.nspname = 'public'
       and array_length(c.conkey, 1) = 1
       and pa.attname = 'id'
       and (cl.relname = 'affiliates' or cl.relname like 'affiliate\_%')
       and (pl.relname = 'affiliates' or pl.relname like 'affiliate\_%')
       and exists (select 1 from pg_attribute a where a.attrelid = c.conrelid
                    and a.attname = 'company_entity_id' and not a.attisdropped)
       and exists (select 1 from pg_attribute a where a.attrelid = c.confrelid
                    and a.attname = 'company_entity_id' and not a.attisdropped)
     order by 3, 5
  loop
    v_uq := left(r.parent, 48) || '_id_company_key';
    if not exists (select 1 from pg_constraint where conrelid = r.confrelid and conname = v_uq) then
      execute format('alter table public.%I add constraint %I unique (id, company_entity_id)', r.parent, v_uq);
    end if;
    v_fk := left(r.child, 30) || '_' || left(r.col, 20) || '_same_co';
    if not exists (select 1 from pg_constraint where conrelid = r.conrelid and conname = v_fk) then
      execute format('alter table public.%I add constraint %I foreign key (%I, company_entity_id) references public.%I (id, company_entity_id)',
                     r.child, v_fk, r.col, r.parent);
    end if;
  end loop;
end $$;

-- Nothing in this module is for the anon role: affiliates reach it only
-- through the affiliate-portal function (service role), never PostgREST.
-- Supabase's default privileges grant anon every table in public, and the
-- row policies (all "to authenticated") are then the only thing keeping anon
-- out. Take the grant away too, so a future policy written without "to
-- authenticated" cannot open a table to the internet.
do $$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r','v') and (c.relname = 'affiliates' or c.relname like 'affiliate\_%')
  loop
    execute format('revoke all on public.%I from anon', r.relname);
  end loop;
end $$;

select public.attach_stamp_company_entity_id_triggers();

do $$ begin
  if to_regprocedure('public.refresh_chat_schema_catalog()') is not null then
    perform public.refresh_chat_schema_catalog();
  end if;
end $$;
