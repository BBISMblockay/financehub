-- ============================================================
-- 20260806190000_review_rating_scale_question_kind.sql
--
-- Template authors were building a "1-4 rating scale with a written
-- definition per point" (Does not meet / Fully meets / Exceeds / Far
-- exceeds standards) as a single_choice question with the full
-- definition paragraphs as the four options -- so the manager had to
-- read and click a whole paragraph as their "answer" instead of just
-- picking a number, and there was nowhere to add a comment explaining
-- the rating.
--
-- New 'rating_scale' kind: options holds the point definitions in
-- order (options[0] = definition for point 1, etc, same column single/
-- multi_choice already use for their choice text -- no new column
-- needed). The definitions render as a reference legend, not as
-- clickable answer choices. The actual answer is a single numeric
-- score (1..options.length) plus an optional comment, stored the same
-- way scale_1_10 already stores {score}, extended with {comment}.
-- ============================================================

alter table public.review_template_questions drop constraint if exists review_template_questions_kind_check;
alter table public.review_template_questions add constraint review_template_questions_kind_check
  check (kind in ('free_text', 'scale_1_10', 'single_choice', 'multi_choice', 'goals', 'rating_scale'));
