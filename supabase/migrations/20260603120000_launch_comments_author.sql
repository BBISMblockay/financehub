-- Launch comments: tie each row to a SILO user (profiles.id).
-- Safe to re-run: only adds column / backfills when missing.

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'launch_comments'
  ) then
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'launch_comments' and column_name = 'user_id'
    ) then
      alter table public.launch_comments add column user_id uuid references public.profiles(id);
    end if;

    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'launch_comments' and column_name = 'created_by'
    ) then
      update public.launch_comments
      set user_id = coalesce(user_id, created_by)
      where user_id is null and created_by is not null;
    end if;

    create index if not exists launch_comments_user_id_idx on public.launch_comments(user_id);
  end if;
end $$;
