-- Deleting an initiative deletes its tasks.
--
-- 20260910120000 shipped the initiative link as ON DELETE SET NULL, reasoning
-- that removing an initiative should not destroy somebody's work. The owner's
-- call is the opposite, and it is the consistent one: deleting a LAUNCH has
-- always deleted its tasks (launch_tasks_launch_id_fkey has been CASCADE since
-- the table existed), so an initiative behaving differently would mean two
-- rules for the same gesture.
--
--   delete a launch      -> its tasks go
--   delete an initiative -> its tasks go
--   a task tied to neither survives everything
--
-- The third line needs no code: both columns are nullable and an unattached
-- task references nothing, so nothing can cascade to it.
--
-- Safe to apply now and not later: zero tasks currently carry a
-- channel_item_id (the link shipped hours ago), so this rewrites a rule
-- rather than deleting anything.
--
-- Note what this makes UNREACHABLE: a task can no longer outlive its
-- initiative, so `channel_item_id` pointing at a row that is gone is now
-- impossible through the delete path. The "Initiative (removed)" label in
-- v2/launch-calendar.html stays as a defensive fallback -- it costs nothing
-- and a row removed by some other means would otherwise render a blank tag --
-- but it is no longer a state the UI is expected to reach.

alter table public.launch_tasks
  drop constraint if exists launch_tasks_channel_item_id_fkey;

alter table public.launch_tasks
  add constraint launch_tasks_channel_item_id_fkey
  foreign key (channel_item_id)
  references public.launch_channel_items(id)
  on delete cascade;
