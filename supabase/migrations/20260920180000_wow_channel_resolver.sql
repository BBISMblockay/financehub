-- Point every channel-scoped Marketing RPC at location_channel_map.
--
-- Companion to 20260920170000. Seven sites across five deployed functions
-- carried a hardcoded `location_tag = 'online'`:
--
--   wow_report               3   (sales CTE, rollup CTE, inventory CTE)
--   wow_data_through         1
--   wow_kpi_compare          1
--   wow_online_shop_domains  1
--   wow_paid_media_reality   1
--
-- Every one has the same shape -- some location_tag expression, then
-- `= 'online'` -- so the rewrite is uniform: only the RIGHT-hand side changes.
-- The left side is left exactly as deployed (`lower(btrim(s.location_tag))`
-- in four places, bare `location_tag` in three) so query plans keep their
-- current shape and this migration cannot accidentally change which index a
-- predicate can use.
--
-- REWRITES THE DEPLOYED DEFINITIONS rather than retyping them -- the same
-- method as 20260901120000 / 20260901140000, and for the reason recorded in
-- docs/ops/bugs.md: several of these functions have been edited in place and
-- the repo text is NOT what runs. wow_creatives was deployed ahead of this
-- repo with four extra computed columns, and rebuilding it from its migration
-- file would have silently deleted two headline metrics. Each rewrite asserts
-- its expected shape first and raises rather than guessing.
--
-- Behaviour for Baseballism is unchanged BY CONSTRUCTION: the companion
-- migration asserts the seeded online set is exactly {'online'}, which is the
-- set this literal matched.
do $mig$
declare
  want    record;
  fn      record;
  def     text;
  newdef  text;
  n_all   int;
  n_loc   int;
  rewrote int := 0;
  skipped int := 0;
begin
  for want in
    -- (function, how many sites it must carry). A count that has moved means
    -- the body changed since 2026-09-20 -- stop and let a person look.
    select * from (values
      ('wow_report', 3),
      ('wow_data_through', 1),
      ('wow_kpi_compare', 1),
      ('wow_online_shop_domains', 1),
      ('wow_paid_media_reality', 1)
    ) as t(proname, expected)
  loop
    for fn in
      select p.oid, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace nsp on nsp.oid = p.pronamespace
      where nsp.nspname = 'public'
        and p.prokind = 'f'
        and p.proname = want.proname
    loop
      def := pg_get_functiondef(fn.oid);

      -- Idempotent: a re-run of this migration finds the resolver already in
      -- place and leaves the function alone.
      if position('silo_channel_location_tags' in def) > 0 then
        skipped := skipped + 1;
        continue;
      end if;

      n_all := (select count(*) from regexp_matches(def, '= ''online''', 'g'));
      n_loc := (select count(*) from regexp_matches(def, 'location_tag\)* = ''online''', 'g'));

      if n_all <> want.expected then
        raise exception
          'wow channel: %(%) carries % online literals, expected % -- body has changed, refusing to guess',
          want.proname, fn.args, n_all, want.expected;
      end if;

      -- Every literal must be a location_tag predicate. If some other column
      -- is ever compared to 'online', a blanket replace would silently rewrite
      -- it into a channel lookup that means something entirely different.
      if n_loc <> n_all then
        raise exception
          'wow channel: %(%) has % online literals but only % are location_tag predicates -- refusing to rewrite',
          want.proname, fn.args, n_all, n_loc;
      end if;

      newdef := replace(def, '= ''online''', '= any(public.silo_channel_location_tags(''online''))');
      if newdef = def then
        raise exception 'wow channel: %(%) replacement was a no-op -- refusing to guess', want.proname, fn.args;
      end if;

      execute newdef;
      rewrote := rewrote + 1;
      raise notice 'wow channel: %(%) now resolves through location_channel_map (% sites)',
        want.proname, fn.args, n_all;
    end loop;
  end loop;

  if rewrote = 0 and skipped = 0 then
    raise exception 'wow channel: none of the five functions were found -- nothing was rewritten';
  end if;

  raise notice 'wow channel: % function(s) rewritten, % already current', rewrote, skipped;
end;
$mig$;
