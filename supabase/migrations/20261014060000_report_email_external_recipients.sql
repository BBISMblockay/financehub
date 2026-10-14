-- Scheduled report CSV email: send to an address outside the workspace.
--
-- The recipient list only knew people who are IN the company:
-- 'workspace_admins', 'department' and 'profile' all resolve through
-- entity_memberships, so there was no way to mail a report to an accountant,
-- a wholesale buyer or anyone else without an account. This adds a fourth
-- kind, {"kind":"email","value":"someone@example.com"}, which resolves to
-- that address with a null profile_id.
--
-- resolve_report_email_recipients() is the ONLY recipient path -- the edge
-- function calls it and mails exactly what it returns -- so this function is
-- the whole change. No table, view or column changes, so no new RLS policy
-- and no refresh_chat_schema_catalog().
--
-- Deliberately NOT adding a CHECK constraint on report_email_schedules
-- .recipients: a workspace admin may type any address, since that is the
-- point of the feature, so a constraint would not be a security boundary --
-- it would only be one more way for a future recipient shape to make a save
-- fail in production. The address is validated where a typo can still be
-- corrected (the browser refuses to save one) and again here, where an
-- unparseable entry is skipped rather than handed to the mail provider.
--
-- Idempotent: create or replace only.

create or replace function public.resolve_report_email_recipients(p_schedule_id uuid)
returns table(email text, profile_id uuid)
language plpgsql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_sched record;
  v_rec jsonb;
  v_kind text;
  v_dept text;
  v_pid uuid;
  v_email text;
begin
  select * into v_sched
  from public.report_email_schedules s
  where s.id = p_schedule_id;

  if v_sched.id is null then
    return;
  end if;

  if auth.uid() is not null
     and not public.is_entity_admin(v_sched.company_entity_id)
     and auth.role()::text <> 'service_role' then
    raise exception 'not authorized';
  end if;

  for v_rec in select jsonb_array_elements(v_sched.recipients)
  loop
    v_kind := v_rec->>'kind';
    if v_kind = 'workspace_admins' then
      return query
      select distinct pr.email, pr.id
      from public.entity_memberships em
      join public.profiles pr on pr.id = em.user_id
      where em.entity_id = v_sched.company_entity_id
        and em.role in ('owner_admin', 'admin')
        and coalesce(pr.is_active, true)
        and pr.email is not null;
    elsif v_kind = 'department' then
      v_dept := nullif(trim(v_rec->>'value'), '');
      if v_dept is not null then
        return query
        select distinct pr.email, pr.id
        from public.entity_memberships em
        join public.profiles pr on pr.id = em.user_id
        where em.entity_id = v_sched.company_entity_id
          and coalesce(pr.is_active, true)
          and pr.department::text = v_dept
          and pr.email is not null;
      end if;
    elsif v_kind = 'profile' then
      v_pid := nullif(v_rec->>'id', '')::uuid;
      if v_pid is not null then
        return query
        select pr.email, pr.id
        from public.profiles pr
        join public.entity_memberships em
          on em.user_id = pr.id and em.entity_id = v_sched.company_entity_id
        where pr.id = v_pid
          and coalesce(pr.is_active, true)
          and pr.email is not null;
      end if;
    elsif v_kind = 'email' then
      -- An address outside the workspace. No membership, no profile row, so
      -- no company scoping applies to it and none is implied: the schedule's
      -- own export is still read under the creator's RLS, which is what
      -- decides what the CSV contains.
      v_email := lower(nullif(trim(v_rec->>'value'), ''));
      if v_email is not null and v_email ~ '^[^@[:space:],;]+@[^@[:space:],;]+\.[a-z]{2,}$' then
        return query select v_email, null::uuid;
      end if;
    end if;
  end loop;

  if v_sched.allow_member_subscribe then
    return query
    select pr.email, pr.id
    from public.report_email_subscriptions sub
    join public.profiles pr on pr.id = sub.profile_id
    where sub.schedule_id = p_schedule_id
      and coalesce(pr.is_active, true)
      and pr.email is not null;
  end if;
end;
$$;

-- create or replace keeps the existing grants, but Supabase's default
-- privileges re-grant EXECUTE on public functions to anon/authenticated, so
-- state the intent again rather than rely on what was there.
revoke all on function public.resolve_report_email_recipients(uuid) from public, anon;
grant execute on function public.resolve_report_email_recipients(uuid) to authenticated, service_role;
