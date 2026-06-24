-- Global location id allocator for multi-tenant inserts.
-- locations.id is manual bigint (no serial). Client max(id) under RLS only sees
-- the active company's rows, so new companies (e.g. test-co) would collide on id=1.

create or replace function public.next_location_id()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin_user() then
    raise exception 'Admin access required';
  end if;

  return (select coalesce(max(id), 0) + 1 from public.locations);
end;
$$;

revoke all on function public.next_location_id() from public;
grant execute on function public.next_location_id() to authenticated;

comment on function public.next_location_id() is
  'Returns next global locations.id for admin inserts (bypasses per-company RLS visibility).';

notify pgrst, 'reload schema';
