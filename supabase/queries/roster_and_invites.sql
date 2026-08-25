-- ===========================================================================
-- SILO — roster by department and role, and who still needs an invite
-- Run in the Supabase SQL Editor. Read-only; safe to re-run any time.
--
-- Baseballism entity id is hardcoded below. For another company, swap it:
--   3bd934c9-4cdd-429b-9076-f8f6b45d4eb7
--
-- Two different "roles" exist and they do NOT always agree:
--   entity_memberships.role  — access role for THIS company
--                              (owner_admin | admin | member | viewer)
--                              This is the one permission gates actually read.
--   profiles.role            — legacy global role (owner | admin | executive | user)
--                              Still used for the 'executive' tier. It is an
--                              ENUM, so always compare with role::text.
--
-- profiles.department now carries real weight: finance/exec is what opens
-- Compensation. Treat it as a permission field, not a label.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. HEADCOUNT BY DEPARTMENT × ACCESS ROLE   (start here)
--    Last row (department = '(none)') is the company total, via ROLLUP.
-- ---------------------------------------------------------------------------
select
  coalesce(p.department, '(none)')                              as department,
  count(*)                                                      as people,
  count(*) filter (where em.role = 'owner_admin')               as owner_admin,
  count(*) filter (where em.role = 'admin')                     as admin,
  count(*) filter (where em.role = 'member')                    as member,
  count(*) filter (where em.role = 'viewer')                    as viewer,
  count(*) filter (where em.role is null)                       as no_membership,
  count(*) filter (where p.role::text = 'executive')            as exec_tier,
  -- who can see compensation requests, per the current gate
  count(*) filter (where p.department in ('finance','exec')
                      or em.role = 'owner_admin'
                      or p.role::text = 'executive')            as sees_comp
from public.profiles p
left join public.entity_memberships em
       on em.user_id = p.id
      and em.entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
where coalesce(p.is_active, true)
  and (em.entity_id is not null
       or p.active_company_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7')
group by rollup (p.department)
order by (p.department is null), department;


-- ---------------------------------------------------------------------------
-- 2. FULL ROSTER — one row per person, grouped by department then role
--    Includes the Team-module columns so you can see who is actually wired
--    into Performance Reviews, not just who has a login.
-- ---------------------------------------------------------------------------
select
  coalesce(p.department, '(none)')                              as department,
  coalesce(em.role, '(no membership)')                          as access_role,
  p.role::text                                                  as profile_role,
  p.name,
  p.email,
  case when p.role::text in ('owner','executive') or em.role = 'owner_admin'
       then 'yes' else 'no' end                                 as exec_or_owner,
  case when p.department in ('finance','exec')
         or em.role = 'owner_admin'
         or p.role::text = 'executive'
       then 'yes' else 'no' end                                 as sees_comp,
  (select count(*) from public.employee_managers m
    where m.manager_user_id = p.id)                             as reports_managed,
  case when exists (select 1 from public.employees e
                     where e.profile_id = p.id and e.is_active)
       then 'yes' else 'no' end                                 as on_review_roster,
  p.default_page,
  p.created_at::date                                            as joined
from public.profiles p
left join public.entity_memberships em
       on em.user_id = p.id
      and em.entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
where coalesce(p.is_active, true)
  and (em.entity_id is not null
       or p.active_company_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7')
order by department, access_role, p.name;


-- ---------------------------------------------------------------------------
-- 3. STILL NEEDS ACTION — open invites and open access requests
--    'pending' + not expired  = invite sent, waiting on them.
--    'pending' + expired      = they missed the 14-day window; re-invite.
-- ---------------------------------------------------------------------------
select
  'invite'                                                      as kind,
  i.email,
  i.role                                                        as invited_as,
  i.department,
  i.status,
  i.created_at::date                                            as sent,
  i.expires_at::date                                            as expires,
  case when i.expires_at < now() then 'EXPIRED — re-invite'
       else 'waiting on them' end                               as action,
  p.name                                                        as sent_by
from public.org_invites i
left join public.profiles p on p.id = i.invited_by
where i.entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
  and i.status = 'pending'

union all

select
  'access request',
  a.email,
  a.requested_role,
  a.department,
  a.status,
  a.created_at::date,
  null,
  'approve or deny in /v2/backend.html',
  null
from public.access_requests a
where a.status = 'pending'
order by kind, sent desc;


-- ---------------------------------------------------------------------------
-- 4. WHO HAS NO LOGIN YET — people on a review roster with no SILO account
--    These are the ones an invite would actually turn into users. Associates
--    who never need to log in can stay here; they use the emailed review link.
-- ---------------------------------------------------------------------------
select
  e.name,
  e.email,
  e.job_title,
  string_agg(mp.name, ', ' order by mp.name)                    as managed_by,
  case when exists (select 1 from public.org_invites i
                     where lower(i.email) = lower(e.email)
                       and i.status = 'pending'
                       and i.entity_id = e.company_entity_id)
       then 'invite pending'
       else 'no invite sent' end                                as invite_state
from public.employees e
left join public.employee_managers em on em.employee_id = e.id
left join public.profiles mp on mp.id = em.manager_user_id
where e.company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
  and e.is_active
  and e.profile_id is null          -- no SILO account linked
group by e.id, e.name, e.email, e.job_title, e.company_entity_id
order by e.name;


-- ---------------------------------------------------------------------------
-- 5. CLEANUP CHECKS — mismatches worth a look before sending more invites
-- ---------------------------------------------------------------------------
-- 5a. Department on the invite disagrees with the department they ended up in.
--     Matters now that finance/exec opens Compensation.
select i.email,
       i.department                                             as invited_as_dept,
       p.department                                             as current_dept,
       em.role                                                  as access_role
from public.org_invites i
join public.profiles p on lower(p.email) = lower(i.email)
left join public.entity_memberships em
       on em.user_id = p.id and em.entity_id = i.entity_id
where i.entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
  and i.status = 'accepted'
  and coalesce(i.department,'') is distinct from coalesce(p.department,'')
order by i.email;

-- 5b. Active profiles with no membership row for this company — they can log
--     in but resolve to no company, so most pages come up empty.
select p.name, p.email, p.department, p.role::text as profile_role,
       p.active_company_id
from public.profiles p
left join public.entity_memberships em
       on em.user_id = p.id
      and em.entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
where coalesce(p.is_active, true)
  and em.entity_id is null
order by p.name;

-- 5c. Deactivated accounts still holding a membership.
select p.name, p.email, p.department, em.role as access_role
from public.profiles p
join public.entity_memberships em
  on em.user_id = p.id
 and em.entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
where p.is_active is false
order by p.name;
