-- Harden review_answers_select scoping (not an active leak — verified below).
--
-- 20260713200000_performance_reviews_phase1.sql created review_answers_select as:
--   using (exists (select 1 from reviews r where r.id = review_answers.review_id))
-- Read in isolation this looks unscoped — no company_entity_id check, no
-- manager/exec/employee check. It was investigated as a possible leak, but
-- empirical testing (real profile ids, temporary policy swap, cleaned up
-- after) showed it was NOT exploitable: the EXISTS subquery against
-- `reviews` is itself subject to reviews' own RLS for the querying role, so
-- an unrelated user's session could not see the referenced review row and
-- the EXISTS returned false. An unrelated test user was blocked; the
-- review's manager and the review's own employee (once non-draft) were both
-- correctly allowed — under the OLD policy too.
--
-- This migration replaces the implicit "inherits via a subquery on another
-- RLS-protected table" pattern with an explicit equivalent that mirrors
-- reviews_active_select's own scoping (company + manager-of-record +
-- exec/owner + employee-self-once-sent) directly on review_answers. Same
-- access, verified against the same three real users before and after —
-- just auditable without having to reason about cross-table RLS inheritance.

drop policy if exists review_answers_select on public.review_answers;
create policy review_answers_select on public.review_answers for select to authenticated
  using (
    company_entity_id = active_company_id()
    and exists (
      select 1 from public.reviews r
      left join public.employees e on e.id = r.employee_id
      where r.id = review_answers.review_id
        and (
          r.manager_user_id = auth.uid()
          or public.is_exec_or_owner()
          or (r.status <> 'draft' and e.profile_id = auth.uid())
        )
    )
  );
