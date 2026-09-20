-- Per-tenant notification sender identity and Reply-To contacts.
--
-- Today all ten mail functions hold ONE global constant --
-- `SILO_MAIL_FROM`, defaulting to `SILO <noreply@silo-baseballism.com>` --
-- and NINE of the ten set no Reply-To at all (only
-- payment-request-forward-melio does). A global env string cannot carry a
-- per-tenant display name, so the sender identity has to be resolved at send
-- time from the company, not from configuration.
--
-- The target, agreed 2026-09-20:
--   From:     Baseballism - SILO <notifications@get-silo.com>
--   Reply-To: the tenant's own contact for that KIND of notification
--
-- SILO must never become the accidental recipient of replies about invoices,
-- purchase requests or tenant operations. `support@get-silo.com` is the only
-- monitored platform mailbox.

create table if not exists public.company_notification_contacts (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  -- SILO-owned vocabulary, so a CHECK is right here (unlike Stripe's own
  -- statuses, which must not be frozen by one).
  purpose text not null check (purpose in
    ('finance_ap', 'purchasing', 'hr_comp', 'general_ops', 'technical')),
  -- Deliberately ONE address per purpose, not a list: a tenant-controlled
  -- group address (finance@tenant.com) keeps staff changes out of SILO and
  -- makes replies predictable. A list here would reimplement a mailing list
  -- badly and would need maintaining as people join and leave.
  reply_to_email text not null check (position('@' in reply_to_email) > 1),
  label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  changed_by uuid references public.profiles(id),
  constraint company_notification_contacts_one_per_purpose
    unique (company_entity_id, purpose)
);

alter table public.company_notification_contacts enable row level security;

-- Read: any active member -- knowing where replies go is not privileged, and
-- the Notifications tab shows it to everyone who can open Workspace Settings.
drop policy if exists company_notification_contacts_select on public.company_notification_contacts;
create policy company_notification_contacts_select on public.company_notification_contacts
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Write: is_admin_user(), matching Integrations rather than the owner-only
-- rename. Redirecting where invoice replies land is an operational setting,
-- not a change to what the company IS.
drop policy if exists company_notification_contacts_write on public.company_notification_contacts;
create policy company_notification_contacts_write on public.company_notification_contacts
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.is_admin_user())
  with check (company_entity_id = public.active_company_id() and public.is_admin_user());

comment on table public.company_notification_contacts is
  'Per-company Reply-To address per notification purpose. One address per purpose, ideally a tenant-controlled group address. Read: any active member. Write: is_admin_user().';

-- The ONE definition of who a notification comes from and where a reply goes.
--
-- A database function rather than a shared TypeScript module: `_shared/` sits
-- outside each function's directory, and deployment-drift-check downloads each
-- deployed function and diffs it against the repo, so a cross-directory import
-- risks showing all ten as permanently drifted. This also puts the resolution
-- where the data already is, and makes it testable without deploying anything.
--
-- SECURITY DEFINER because every caller is an edge function holding the
-- service-role key (which bypasses RLS anyway), and because the fallback chain
-- reads `profiles` and `entity_memberships` for a user who is NOT the caller.
create or replace function public.resolve_notification_sender(
  p_company_entity_id uuid,
  p_purpose text,
  p_actor_email text default null
)
returns table (from_header text, reply_to text, reply_to_source text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_title text;
  v_address text := coalesce(
    nullif(current_setting('silo.notifications_address', true), ''),
    'notifications@get-silo.com');
  v_reply text;
  v_source text;
begin
  -- A DEFINER function that takes a company id and is granted to `authenticated`
  -- is an RLS bypass unless it re-checks the caller itself. Without this, a
  -- member of company A could pass company B's uuid and read B's configured
  -- reply address -- and, where none is set, B's owner-admin email out of the
  -- fallback. Found by the independent review on PR #745, reproduced against
  -- two synthetic tenants; the same shape as the unscoped is_owner_admin() gate
  -- closed the same day in 20260920160000.
  --
  -- auth.uid() is NULL for the service role, which is how every mail function
  -- calls this: the edge functions keep working, and only a browser session is
  -- held to its own memberships. The settings page only ever asks about its own
  -- active company, so nothing legitimate is narrowed.
  if v_actor is not null and not exists (
    select 1 from public.entity_memberships m
    where m.entity_id = p_company_entity_id
      and m.user_id = v_actor
  ) then
    raise exception 'Not a member of this company'
      using errcode = '42501';
  end if;

  select e.title into v_title from public.entities e where e.id = p_company_entity_id;

  -- The display name is the tenant's, the address is always SILO's: the From
  -- domain has to stay one SILO-authenticated domain for SPF/DKIM alignment.
  -- Reply-To carries no such constraint, which is exactly why this split works.
  from_header := case
    when v_title is null or btrim(v_title) = '' then 'SILO <' || v_address || '>'
    -- A display name containing a quote or a control character would let the
    -- header be split; strip rather than escape, since a company title has no
    -- business containing either.
    else regexp_replace(btrim(v_title), '["\r\n,<>]', '', 'g') || ' - SILO <' || v_address || '>'
  end;

  -- 1. The contact configured for this exact purpose.
  select c.reply_to_email into v_reply
    from public.company_notification_contacts c
   where c.company_entity_id = p_company_entity_id and c.purpose = p_purpose;
  if v_reply is not null then
    v_source := 'purpose';
  else
    -- 2. The tenant's general operational contact.
    select c.reply_to_email into v_reply
      from public.company_notification_contacts c
     where c.company_entity_id = p_company_entity_id and c.purpose = 'general_ops';
    if v_reply is not null then
      v_source := 'general_ops';
    -- 3. Whoever triggered the notification. They are at the tenant and they
    --    know what the message is about.
    elsif p_actor_email is not null and position('@' in p_actor_email) > 1 then
      v_reply := p_actor_email;
      v_source := 'actor';
    else
      -- 4. An owner-admin of that company. Never a SILO address: an
      --    unconfigured tenant must not turn SILO into the reply desk, which
      --    is the whole point of this table.
      select p.email into v_reply
        from public.entity_memberships m
        join public.profiles p on p.id = m.user_id
       where m.entity_id = p_company_entity_id
         and m.role = 'owner_admin'
         and p.is_active
         and p.email is not null
       order by p.email
       limit 1;
      v_source := case when v_reply is null then 'none' else 'owner_admin' end;
    end if;
  end if;

  reply_to := v_reply;
  reply_to_source := v_source;
  return next;
end;
$$;

revoke all on function public.resolve_notification_sender(uuid, text, text) from public, anon;
grant execute on function public.resolve_notification_sender(uuid, text, text) to authenticated, service_role;

comment on function public.resolve_notification_sender(uuid, text, text) is
  'The one definition of a notification''s From header and Reply-To. An authenticated caller must belong to the company it names; the service role, which is how the mail functions call it, is exempt. Falls back purpose -> general_ops -> the acting user -> an owner_admin, and NEVER to a SILO address: an unconfigured tenant must not make SILO the reply desk. reply_to_source says which rung answered.';

select public.attach_stamp_company_entity_id_triggers();
