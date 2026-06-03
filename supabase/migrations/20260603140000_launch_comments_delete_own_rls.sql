-- Launch comments: authenticated users may read/insert; only the author may delete (and update).
-- Replaces launch_comments_auth_all (for all) with scoped policies.
-- Safe to re-run.

do $rls$
declare
  owner_match text := 'user_id = auth.uid()';
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'launch_comments'
  ) then
    raise notice 'Skip: launch_comments table missing';
    return;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'launch_comments' and column_name = 'created_by'
  ) then
    owner_match := 'coalesce(user_id, created_by) = auth.uid()';
  end if;

  alter table public.launch_comments enable row level security;

  drop policy if exists launch_comments_auth_all on public.launch_comments;
  drop policy if exists launch_comments_select_auth on public.launch_comments;
  drop policy if exists launch_comments_insert_auth on public.launch_comments;
  drop policy if exists launch_comments_update_auth on public.launch_comments;
  drop policy if exists launch_comments_delete_own on public.launch_comments;

  create policy launch_comments_select_auth
    on public.launch_comments for select to authenticated
    using (true);

  create policy launch_comments_insert_auth
    on public.launch_comments for insert to authenticated
    with check (coalesce(user_id, auth.uid()) = auth.uid());

  execute format(
    'create policy launch_comments_update_auth on public.launch_comments for update to authenticated using (%s) with check (%s)',
    owner_match, owner_match
  );

  execute format(
    'create policy launch_comments_delete_own on public.launch_comments for delete to authenticated using (%s)',
    owner_match
  );

  raise notice 'launch_comments RLS: update/delete limited to author (%).', owner_match;
end
$rls$;
