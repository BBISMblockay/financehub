-- is_admin_user() cost 50x what it should, in 47 policies across 31 tables.
--
-- Measured, same session, same call count:
--   is_admin_user()     x176  -> 755 ms   (STABLE, SECURITY INVOKER)
--   active_company_id() x176  ->  15 ms   (STABLE, SECURITY DEFINER)
--
-- The difference is not the query -- both read one row of public.profiles by
-- primary key. It is that is_admin_user() ran as the CALLER, so every call
-- evaluated profiles' three SELECT policies, two of which call further
-- functions (is_owner_admin(), current_user_can_manage_payment_requests())
-- that query profiles again.
--
-- Found because seven Logistics dashboard tiles timed out. The tiles were
-- innocent: po_headers RLS is `company AND (is_admin_user() OR created_by =
-- auth.uid())`, so reading 176 PO headers cost 679ms of policy evaluation,
-- and seven concurrent tiles turned that into chat_run_readonly_query's 30s
-- statement timeout. Every PO, mailroom, payment-request, products and
-- inventory page in SILO has been paying this.
--
-- SECURITY DEFINER CANNOT CHANGE THE ANSWER HERE, which is the only reason
-- it is safe to do this to an authorization function. It reads exactly two
-- things, both of them the caller's OWN rows:
--     public.profiles           where p.id = auth.uid()
--     public.entity_memberships where em.user_id = p.id
-- and both tables carry a PERMISSIVE own-row SELECT policy
-- (profiles_select_own: auth.uid() = id; memberships_select_own:
-- user_id = auth.uid()), so those rows were always visible to the caller
-- anyway. DEFINER removes the cost of proving it, not the check itself.
--
-- If anything the invoker version was the riskier one: had profiles RLS ever
-- stopped returning the caller's own row, this would have silently answered
-- FALSE and locked admins out of 31 tables.
--
-- VERIFIED rather than argued: is_admin_user() was evaluated as all 34 real
-- users before and after the change -- 32 admins, 2 non-admins, ZERO
-- differences. Whole Logistics board went 6,496ms -> 986ms.
create or replace function public.is_admin_user()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and p.is_active = true
      and case when em.role is not null
            then em.role in ('owner_admin','admin')
            else p.role::text in ('owner','admin')
          end
  );
$function$;

comment on function public.is_admin_user() is
  'Is the caller an admin of their active company (membership owner_admin/admin, falling back to profile role owner/admin when they have no membership row). SECURITY DEFINER for COST, not reach: it reads only the caller''s own profiles and entity_memberships rows, both of which carry permissive own-row SELECT policies, so the answer is identical either way -- but as INVOKER each call re-evaluated profiles'' three policies (two of which call functions that query profiles again), measured at 755ms per 176 calls against 15ms for the DEFINER equivalent. It sits in 47 policies across 31 tables.';
