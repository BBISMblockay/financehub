-- Search Console: the newest completed run wins, by construction.
--
-- Found in the second independent review of PR #692. The nightly
-- (ad-platforms-sync.yml) and the manual backfill (search-console-backfill.yml)
-- share no concurrency gate, and both write the same three tables through
-- one code path: fetch three cuts, upsert page rows, upsert query rows, upsert
-- the site row LAST, then retire detail rows the fetch did not return. The
-- retirement is ordered by synced_at (20260914120000's companion change in
-- scripts/lib/search-console-sync-core.mjs), so an older run's sweep cannot
-- delete a newer run's rows. Its UPSERTS were not ordered: run A starts,
-- run B starts later and completes, then A resumes and its plain upsert
-- rewrites every identity both runs share -- and the site totals -- with A's
-- OLDER payload. A's sweep then deletes nothing newer than A, so the table is
-- left with A's numbers over B's rows: a snapshot no single fetch produced.
--
-- A GitHub concurrency group is not the fix. CLAUDE.md records why the
-- shopify sync removed one within the hour: with cancel-in-progress false a
-- newly queued run is cancelled the moment another enters the group, so the
-- group can silently kill a scheduled nightly, the exact failure the catch-up
-- crons exist to prevent. The database can refuse the stale write itself,
-- which holds for every caller (nightly, backfill, a hand-run script) rather
-- than only for the two workflows that happen to exist today.
--
-- The rule, one BEFORE trigger on all three tables:
--
--   UPDATE  (an upsert hitting an existing identity): if the incoming
--           synced_at is OLDER than the stored one, keep the stored row
--           (return null). Equal is allowed: a retry inside one run carries
--           the same timestamp and must be able to complete.
--   INSERT  of a page or query row: if the SITE row for that company /
--           property / day already carries a NEWER synced_at, a run newer
--           than this one has already completed that day (the site row is
--           written last, so its timestamp means "this day is done"), and
--           the incoming row is stale on arrival -- it would be a row the
--           newer run's own retirement could never have seen. Refuse it.
--
-- Net effect for the interleaving above: A's shared identities keep B's
-- numbers, A's rows for pages B did not return are refused, A's site row is
-- refused, and A's sweep (rows older than A) leaves B's rows alone. What is
-- left is exactly B's snapshot. In the ordinary sequential case every run is
-- newer than the last and nothing here fires. A run never writes an older
-- synced_at than it started with, so nothing legitimate is refused.
--
-- The core reports how many of its days a newer run had already completed
-- (`superseded_days`) so the log distinguishes "wrote" from "lost", but the
-- guarantee lives here, not in the caller.

create or replace function public.search_console_reject_stale_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if new.synced_at < old.synced_at then
      return null;  -- an older run's write loses to the stored, newer row
    end if;
    return new;
  end if;

  -- INSERT. Only the detail tables consult the site row; the site row is the
  -- marker of a completed day and has nothing above it to consult.
  if tg_table_name in ('search_console_page_daily', 'search_console_query_daily') then
    if exists (
      select 1 from public.search_console_site_daily s
      where s.company_entity_id = new.company_entity_id
        and s.site_url = new.site_url
        and s.day_date = new.day_date
        and s.synced_at > new.synced_at
    ) then
      return null;  -- a newer run has already completed this day
    end if;
  end if;
  return new;
end;
$$;

comment on function public.search_console_reject_stale_write() is
  'BEFORE INSERT OR UPDATE on the three search_console_*_daily tables: an '
  'update whose synced_at is older than the stored row is dropped, and a '
  'page/query insert for a day whose site row already carries a newer '
  'synced_at is dropped. Makes "the newest completed run wins" hold for '
  'overlapping nightly/backfill runs without a workflow concurrency group. '
  'Equal timestamps pass (a retry within one run).';

drop trigger if exists trg_search_console_newest_run_wins on public.search_console_site_daily;
create trigger trg_search_console_newest_run_wins
  before insert or update on public.search_console_site_daily
  for each row execute function public.search_console_reject_stale_write();

drop trigger if exists trg_search_console_newest_run_wins on public.search_console_page_daily;
create trigger trg_search_console_newest_run_wins
  before insert or update on public.search_console_page_daily
  for each row execute function public.search_console_reject_stale_write();

drop trigger if exists trg_search_console_newest_run_wins on public.search_console_query_daily;
create trigger trg_search_console_newest_run_wins
  before insert or update on public.search_console_query_daily
  for each row execute function public.search_console_reject_stale_write();
