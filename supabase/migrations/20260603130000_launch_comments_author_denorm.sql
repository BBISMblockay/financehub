-- Denormalized author fields on launch comments (display without joining profiles).
-- Safe to re-run.

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'launch_comments'
  ) then
    alter table public.launch_comments add column if not exists author_name text;
    alter table public.launch_comments add column if not exists author_email text;

    update public.launch_comments c
    set
      author_name = coalesce(c.author_name, p.name, split_part(p.email, '@', 1)),
      author_email = coalesce(c.author_email, p.email)
    from public.profiles p
    where c.user_id = p.id
      and (c.author_name is null or c.author_email is null);
  end if;
end $$;
