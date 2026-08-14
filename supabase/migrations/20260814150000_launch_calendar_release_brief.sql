-- Launch Workbench is gaining a structured "release brief" so creative
-- direction, marketing story, budget, and post-launch performance live on
-- the launch itself instead of scattered notes fields nobody can find.
-- Additive columns on launch_calendar (matches its existing wide-table
-- style — overview/references/creative concerns already live there).
alter table public.launch_calendar
  -- release overview
  add column if not exists preview_start_date date,
  add column if not exists preview_start_time time,
  add column if not exists release_pdf_url text,
  add column if not exists landing_page_url text,
  -- products & design
  add column if not exists design_intent text,
  add column if not exists product_callouts text,
  -- marketing / creative brief
  add column if not exists marketing_angle text,
  add column if not exists audience text,
  add column if not exists special_callouts text,
  add column if not exists copy_dos text,
  add column if not exists copy_donts text,
  add column if not exists creative_dos text,
  add column if not exists creative_donts text,
  -- budget / forecast
  add column if not exists preview_marketing_budget numeric,
  add column if not exists post_launch_budget numeric,
  add column if not exists projected_revenue numeric,
  -- performance tracking (actuals)
  add column if not exists actual_preview_spend numeric,
  add column if not exists actual_post_launch_spend numeric,
  add column if not exists actual_revenue numeric,
  add column if not exists performance_comparison text,
  add column if not exists overperformed_notes text,
  add column if not exists underperformed_notes text;
