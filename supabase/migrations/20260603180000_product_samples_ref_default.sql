-- Auto-generate sample_ref on insert (e.g. SMPL-2026-0001)
-- Safe to re-run.

create sequence if not exists public.product_samples_ref_seq start 1;

create or replace function public.generate_sample_ref()
returns trigger language plpgsql as $$
begin
  if new.sample_ref is null or new.sample_ref = '' then
    new.sample_ref := 'SMPL-' || to_char(now(), 'YYYY') || '-' ||
                      lpad(nextval('public.product_samples_ref_seq')::text, 4, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists product_samples_set_ref on public.product_samples;
create trigger product_samples_set_ref
  before insert on public.product_samples
  for each row execute function public.generate_sample_ref();
