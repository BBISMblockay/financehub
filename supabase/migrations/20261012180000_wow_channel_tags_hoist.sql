-- Hoist the channel resolver out of seven row filters.
--
-- 20260920180000 replaced a hardcoded `location_tag = 'online'` with
-- `= any(public.silo_channel_location_tags('online'))` in five deployed
-- functions. That removed the tenant bug and introduced a performance one:
-- silo_channel_location_tags() is STABLE, which stops the planner folding it
-- to a constant but does NOT make it cached, so it re-runs once per scanned
-- row. supabase/CLAUDE.md and docs/agents/database.md both already state the
-- required form and the measurement behind it -- the call must be HOISTED,
-- `= any((select public.silo_channel_location_tags('online'))::text[])`, with
-- the cast, or `any(...)` parses the parenthesised select as a subquery and
-- fails on `text = text[]`. The deployed bodies never got that treatment.
--
-- Measured on production 2026-10-12, as `authenticated`, warm, week grain:
--
--   wow_report              19.3 s   (inventory CTE alone 14.96 s / 276,762 buffers
--                                     for 10,065 rows: 67,563 calls of the resolver)
--   wow_discount_codes      26.9 s   (via wow_online_shop_domains, twice)
--   wow_paid_media_reality  14.3 s
--   wow_landing_pages       13.1 s   (via wow_online_shop_domains)
--   wow_funnel              12.7 s   (via wow_online_shop_domains)
--   wow_online_shop_domains 16.4 s   -> 0.09 s hoisted
--
-- The same inventory predicate hoisted plans as an InitPlan evaluated once and
-- runs in 110 ms -- 135x -- for byte-identical rows. `authenticated` carries an
-- 8 s statement timeout, so these were not merely slow: the Postgres log for
-- 2026-10-12 shows bursts of five cancellations matching /v2/wow-report.html's
-- second batch of calls, and the page was rendering those sections empty.
--
-- REWRITES THE DEPLOYED DEFINITIONS rather than retyping them, the same method
-- and for the same reason as 20260920180000: several of these functions have
-- been edited in place and the repo text is NOT what runs. The replacement is
-- purely syntactic on the exact bare-call token, so it cannot change which rows
-- a predicate matches: `= any(<array>)` and `= any((select <array>)::text[])`
-- are the same membership test, including for an empty array (no rows, which is
-- "channel not configured") and for a NULL left-hand side.
--
-- wow_channel_status is deliberately NOT in the list below: it already reads the
-- resolver once, through a CTE, and measures 0.52 s.
do $mig$
declare
  want    record;
  fn      record;
  def     text;
  newdef  text;
  n_bare  int;
  rewrote int := 0;
  skipped int := 0;
  found   int := 0;
begin
  for want in
    -- (function, how many bare sites it must carry). A count that has moved
    -- means the body changed since 2026-10-12 -- stop and let a person look.
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
      found := found + 1;
      def := pg_get_functiondef(fn.oid);

      n_bare := (select count(*) from regexp_matches(
        def, '= any\(public\.silo_channel_location_tags\(''[a-z_]+''\)\)', 'g'));

      -- Idempotent: a re-run finds every site already hoisted and leaves the
      -- function alone.
      if n_bare = 0 then
        if position('(select public.silo_channel_location_tags' in def) = 0 then
          raise exception
            'wow hoist: %(%) resolves no channel at all -- refusing to touch it',
            want.proname, fn.args;
        end if;
        skipped := skipped + 1;
        continue;
      end if;

      if n_bare <> want.expected then
        raise exception
          'wow hoist: %(%) carries % bare resolver calls, expected % -- body has changed, refusing to guess',
          want.proname, fn.args, n_bare, want.expected;
      end if;

      newdef := regexp_replace(
        def,
        '= any\(public\.silo_channel_location_tags\((''[a-z_]+'')\)\)',
        '= any((select public.silo_channel_location_tags(\1))::text[])',
        'g');

      if newdef = def then
        raise exception 'wow hoist: %(%) replacement was a no-op -- refusing to guess',
          want.proname, fn.args;
      end if;
      if position('= any(public.silo_channel_location_tags(' in newdef) > 0 then
        raise exception 'wow hoist: %(%) still carries a bare resolver call after rewrite',
          want.proname, fn.args;
      end if;

      execute newdef;
      rewrote := rewrote + 1;
      raise notice 'wow hoist: %(%) hoisted (% site(s))', want.proname, fn.args, n_bare;
    end loop;
  end loop;

  if found = 0 then
    raise exception 'wow hoist: none of the five functions were found -- nothing was rewritten';
  end if;

  raise notice 'wow hoist: % function(s) rewritten, % already hoisted', rewrote, skipped;
end;
$mig$;
