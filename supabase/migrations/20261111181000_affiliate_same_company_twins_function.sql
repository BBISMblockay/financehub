-- 20261111181000 -- the affiliate same-company twin becomes a function a new
-- table can call, and the one table missing it gets its twin.
--
-- 20261110086000 added, for every single-column affiliate reference, a
-- composite twin (col, company_entity_id) -> (id, company_entity_id), because
-- RLS checks only a row's own company: without the twin, a company A row can
-- point at company B's program when somebody knows the id, and #1177's review
-- found exactly that reaching B's terms through the portal. It was written as
-- a DO block that reads the catalog "so a table added later is covered by
-- re-running this block" -- but re-running it is a thing somebody has to
-- remember, and four days later nobody had: 20261110150000 added
-- affiliate_feed_items.program_id, and `verify_v2_schema.sql` has reported
-- CRITICAL "an affiliate reference has no same-company twin" on production
-- since that migration was applied.
--
-- So the block moves into a function, which the next affiliate migration ends
-- with the way a company-scoped table ends with
-- attach_stamp_company_entity_id_triggers(). Same catalog query, same names,
-- same idempotence; it adds only what is missing and alters nothing else.
--
-- Safe by construction: it only ADDS constraints, and only where parent and
-- child both carry company_entity_id. Verified on production 2026-11-11
-- before writing this -- affiliate_feed_items holds 14 rows and none points
-- at another company's program -- so the one ALTER it has to do cannot fail
-- on existing data.

begin;

create or replace function public.attach_affiliate_same_company_twins()
returns void
language plpgsql
as $fn$
declare
  r record;
  v_uq text;
  v_fk text;
begin
  for r in
    select c.conrelid, c.confrelid, cl.relname as child, pl.relname as parent, ca.attname as col
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_namespace n on n.oid = cl.relnamespace
      join pg_class pl on pl.oid = c.confrelid
      join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = c.conkey[1]
      join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
     where c.contype = 'f'
       and n.nspname = 'public'
       and array_length(c.conkey, 1) = 1
       and pa.attname = 'id'
       and (cl.relname = 'affiliates' or cl.relname like 'affiliate\_%')
       and (pl.relname = 'affiliates' or pl.relname like 'affiliate\_%')
       and exists (select 1 from pg_attribute a where a.attrelid = c.conrelid
                    and a.attname = 'company_entity_id' and not a.attisdropped)
       and exists (select 1 from pg_attribute a where a.attrelid = c.confrelid
                    and a.attname = 'company_entity_id' and not a.attisdropped)
     order by 3, 5
  loop
    v_uq := left(r.parent, 48) || '_id_company_key';
    if not exists (select 1 from pg_constraint where conrelid = r.confrelid and conname = v_uq) then
      execute format('alter table public.%I add constraint %I unique (id, company_entity_id)', r.parent, v_uq);
    end if;
    v_fk := left(r.child, 30) || '_' || left(r.col, 20) || '_same_co';
    if not exists (select 1 from pg_constraint where conrelid = r.conrelid and conname = v_fk) then
      execute format('alter table public.%I add constraint %I foreign key (%I, company_entity_id) references public.%I (id, company_entity_id)',
                     r.child, v_fk, r.col, r.parent);
    end if;
  end loop;
end $fn$;

-- It does DDL, so no client role may call it. Supabase's default privileges
-- re-grant EXECUTE on every new public function to anon and authenticated,
-- and `create or replace` keeps existing grants, so both are revoked by name.
revoke all on function public.attach_affiliate_same_company_twins() from public, anon, authenticated;

select public.attach_affiliate_same_company_twins();

-- The thing this is for: the reference that had no twin.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.affiliate_feed_items'::regclass
                    and contype = 'f' and array_length(conkey, 1) = 2) then
    raise exception 'affiliate_feed_items still has no same-company twin';
  end if;
end $$;

commit;
