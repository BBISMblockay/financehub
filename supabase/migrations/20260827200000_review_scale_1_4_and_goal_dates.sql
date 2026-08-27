-- Reviews: 1-4 grading scale + a written justification on every rating,
-- and goal due dates surfaced end to end.
--
-- WHY 1-4 AND NOT A NEW COLUMN
-- ----------------------------
-- The rating a manager gives and the sentence backing it up are ONE answer to
-- ONE question, so the justification rides in the existing review_answers.value
-- jsonb as { "score": 3, "comment": "..." } rather than in a new column. That
-- keeps review-portal/index.ts (which returns `value` whole) and the answer
-- upsert in v2/review-editor.html unchanged, and it means an older answer with
-- no comment key reads back as "rated, not explained" instead of breaking.
--
-- 'scale_1_10' STAYS IN THE CONSTRAINT ON PURPOSE
-- -----------------------------------------------
-- Not because anything should create one -- the template builder now only
-- offers 1-4 -- but because a stored answer of 7 is only meaningful next to the
-- question kind that produced it. Dropping the kind would force a rewrite of
-- historical questions and silently reprint every past 7/10 as 7/4. The
-- renderers pick their denominator off the kind, so both read correctly.
--
-- PROD DRIFT NOTE (found 2026-08-27 via pg_constraint, not by reading this repo)
-- ----------------------------------------------------------------------------
-- Production's kind CHECK already carried a sixth value, 'rating_scale', that
-- appears in NO migration, NO edge function, and NO page in this repo, and that
-- zero rows use. Someone widened the constraint straight against prod for a
-- question type that was never built. It is preserved verbatim below so this
-- migration stays additive -- removing it is a separate decision, not a
-- side effect of adding the 1-4 scale.

-- ---------------------------------------------------------------------------
-- 1. Allow the 1-4 rating question kind.
-- ---------------------------------------------------------------------------
alter table public.review_template_questions
  drop constraint if exists review_template_questions_kind_check;

alter table public.review_template_questions
  add constraint review_template_questions_kind_check
  check (kind in ('free_text', 'scale_1_4', 'scale_1_10', 'single_choice',
                  'multi_choice', 'goals', 'rating_scale'));

-- ---------------------------------------------------------------------------
-- 2. Convert existing 1-10 questions to 1-4 -- but ONLY where doing so cannot
--    reinterpret an answer somebody already gave. A question holding a stored
--    score above 4 is left as scale_1_10 and keeps rendering out of 10.
-- ---------------------------------------------------------------------------
update public.review_template_questions q
   set kind = 'scale_1_4', updated_at = now()
 where q.kind = 'scale_1_10'
   and not exists (
     select 1 from public.review_answers a
      where a.question_id = q.id
        and coalesce((a.value ->> 'score')::numeric, 0) > 4
   );

-- ---------------------------------------------------------------------------
-- 3. Goal due dates. employee_goals.target_date has existed since the phase-1
--    migration but was only ever writable on goals created inside the review
--    being edited -- a goal carried forward from a prior cycle could never be
--    given or moved a date. Nothing to add to the schema; the fix is in
--    v2/review-editor.html. The index is here because the two authenticated
--    goal reads (v2/review-editor.html, v2/my-review.html) now order by
--    (employee_id, target_date). The public portal sorts client-side instead --
--    review-portal returns goals unordered and is not worth a redeploy for it.
-- ---------------------------------------------------------------------------
create index if not exists employee_goals_target_date_idx
  on public.employee_goals (employee_id, target_date);

comment on column public.employee_goals.target_date is
  'Due date for the goal. Editable on carried-forward goals too, not just goals created in the current review.';
