create or replace function public.refresh_inventory_current_mv()
returns void
language plpgsql
security definer
as $$
begin
  refresh materialized view concurrently public.inventory_on_hand_current_mv;
end;
$$;
