-- Attribution vs Sales: hoist the channel resolver, and re-pin its tie-outs.
--
-- WHY. The report's two `online` CTEs filter
--   s.location_tag = any (public.silo_channel_location_tags('online'))
-- with the resolver called BARE. It is STABLE, so the planner neither folds it
-- to a constant nor caches it: it re-runs (a query on `locations`) once per
-- scanned sales_by_day row. supabase/CLAUDE.md already requires the hoisted
-- form and 20261012180000 fixed the same shape in the wow_* RPCs; this report
-- was never given that treatment.
--
-- Measured on production 2026-11-11 as a Baseballism admin (`authenticated`,
-- the role the browser and the nightly tie-out run use):
--   each of the report's three tie-out checks, bare      > 55 s (cancelled)
--   the same three checks, hoisted                        161 / 44 / 24 ms
--   values, hoisted                                       identical to the
--     report's own figures (1,044,946.64 online net sales; 797,736.49 claims;
--     341,207.76 spend)
-- The browser has 8 s, so this report and the dashboard tiles built on it
-- (Marketing, SILO home) could not load for that company at all, and the
-- nightly "Report tie-outs" run -- every check for one company runs in ONE
-- statement -- spent its whole time budget here and died on whichever check
-- it had reached, which on 2026-11-10 was an SEO Performance one.
--
-- WHAT. A purely syntactic rewrite of the DEPLOYED text (the 20261012180000
-- method): `= any (<array>)` and `= any ((select <array>)::text[])` are the
-- same membership test, including for an empty array ("channel not
-- configured") and a NULL location_tag, so no row can change. The cast is
-- required: without it `any(...)` parses the parenthesised select as a
-- subquery and fails on `text = text[]`.
--
-- The tie-outs embed the report's SQL and pin md5(queries_run || parameters).
-- Rewriting the report moves that fingerprint, which would turn every check
-- STALE, so the same transaction applies the same rewrite to the checks and
-- swaps the old fingerprint for the new one. A check's independent route (the
-- right-hand side) reads sales_by_day with the same bare call; it is hoisted
-- too, which is again the same membership test.
--
-- REFUSES rather than guesses: if the report carries a number of bare sites
-- other than the two it had on 2026-11-11 (or zero, once applied), the body
-- has drifted and a person should look. Re-running is a no-op.
do $mig$
declare
  rid      constant uuid := 'c3000000-0000-4000-a000-000000000005';
  bare     constant text := 'any (public.silo_channel_location_tags(''online''))';
  hoisted  constant text := 'any ((select public.silo_channel_location_tags(''online''))::text[])';
  r        record;
  old_hash text;
  new_hash text;
  n_bare   int;
  n_left   int;
  n_pinned_before int;
  n_pinned_after  int;
begin
  select * into r from public.silo_chat_saved_reports where id = rid;
  if not found then
    raise notice 'Attribution vs Sales (%) is not installed; nothing to hoist', rid;
    return;
  end if;

  select coalesce(sum((length(q) - length(replace(q, bare, ''))) / length(bare)), 0)
    into n_bare from unnest(r.queries_run) q;
  if n_bare not in (0, 2) then
    raise exception 'Attribution vs Sales carries % bare channel-resolver calls, expected 2 (or 0 once hoisted); its SQL has drifted -- look before rewriting', n_bare;
  end if;

  old_hash := md5(r.queries_run::text || r.parameters::text);

  if n_bare > 0 then
    update public.silo_chat_saved_reports
       set queries_run = array(select replace(q, bare, hoisted)
                                 from unnest(queries_run) with ordinality u(q, i) order by i)
     where id = rid;
  end if;

  select md5(queries_run::text || parameters::text) into new_hash
    from public.silo_chat_saved_reports where id = rid;

  -- The checks: hoist the same token and move the pin from the old
  -- fingerprint to the new one. A check that pins this report by its id is
  -- the only kind that carries old_hash.
  select count(*) into n_pinned_before from public.silo_report_tieouts
   where check_sql like '%' || old_hash || '%' or check_sql like '%' || new_hash || '%';

  update public.silo_report_tieouts
     set check_sql = replace(replace(check_sql, bare, hoisted), old_hash, new_hash)
   where report_id = rid
      or check_sql like '%' || old_hash || '%';

  select count(*) into n_pinned_after from public.silo_report_tieouts
   where check_sql like '%' || new_hash || '%';
  if n_pinned_after <> n_pinned_before then
    raise exception 'Attribution vs Sales tie-outs: % pinned the report before, % pin it after', n_pinned_before, n_pinned_after;
  end if;

  select coalesce(sum((length(t) - length(replace(t, bare, ''))) / length(bare)), 0)
    into n_left
    from (select check_sql t from public.silo_report_tieouts where report_id = rid
          union all
          select q from public.silo_chat_saved_reports s, unnest(s.queries_run) q where s.id = rid) z;
  if n_left <> 0 then
    raise exception 'Attribution vs Sales still carries % bare channel-resolver calls after the rewrite', n_left;
  end if;

  raise notice 'Attribution vs Sales: hoisted % report site(s); % tie-out(s) now pin %', n_bare, n_pinned_after, new_hash;
end $mig$;
