-- Add assignee columns to launch_tasks
-- assigned_to_user_id: FK to auth.users (nullable)
-- assigned_to_name: denormalized display name (avoids join on every render)

alter table public.launch_tasks
  add column if not exists assigned_to_user_id uuid references auth.users(id) on delete set null,
  add column if not exists assigned_to_name text;
