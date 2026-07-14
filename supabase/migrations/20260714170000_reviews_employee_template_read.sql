-- Phase 5 (my-review page): a SILO-authenticated employee can already see
-- their own non-draft reviews and answers via RLS, but the template TITLE
-- and QUESTION LABELS were manager-read-only (reviews_can_manage()), so the
-- in-app view couldn't render. Grant employees read access to templates and
-- questions — but only for templates used by one of their own non-draft
-- reviews, so template contents never leak ahead of a sent review.

drop policy if exists review_templates_employee_select on public.review_templates;
create policy review_templates_employee_select on public.review_templates for select to authenticated
  using (
    exists (
      select 1
      from public.reviews r
      join public.employees e on e.id = r.employee_id
      where r.template_id = review_templates.id
        and e.profile_id = auth.uid()
        and r.status <> 'draft'
    )
  );

drop policy if exists review_template_questions_employee_select on public.review_template_questions;
create policy review_template_questions_employee_select on public.review_template_questions for select to authenticated
  using (
    exists (
      select 1
      from public.reviews r
      join public.employees e on e.id = r.employee_id
      where r.template_id = review_template_questions.template_id
        and e.profile_id = auth.uid()
        and r.status <> 'draft'
    )
  );
