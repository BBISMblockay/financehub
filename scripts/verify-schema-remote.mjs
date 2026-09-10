#!/usr/bin/env node
/**
 * Run supabase/verify_v2_schema.sql against the PRODUCTION database, on a
 * schedule, and fail if any row is not ok.
 *
 * WHY. The verify script has existed since June and CLAUDE.md says to run it
 * after every DB change. It is run by hand in the SQL editor, so it is run
 * when someone remembers. Measured cost of that on 2026-09-10: check 6
 * (every table with company_entity_id carries the stamp trigger) had been
 * reporting MISSING since 2026-09-09 -- twelve tables, every table created
 * that day -- and nobody saw it, because nothing ran the script. The
 * `silo-chat` prompt drifted from `main` twice in two weeks the same way.
 * The tests that run on every push cannot see any of this: they check that
 * the code does what the code says, not that production is in the state the
 * repo claims.
 *
 * Same stance as scripts/check-sales-freshness.mjs: independently scheduled,
 * reports by FAILING (a red run emails the repo owner with no extra
 * credential), and does nothing beyond reading.
 *
 * HOW. Statements are sent one at a time to the Management API's query
 * endpoint -- the same endpoint the Supabase MCP uses -- with the
 * SUPABASE_ACCESS_TOKEN the deploy workflow already holds. Splitting is done
 * by scripts/lib/sql-statements.mjs (a status message containing ';' must not
 * become two statements), and every statement is checked to be a SELECT/WITH
 * before it is sent, so this can never execute anything else against prod.
 *
 * A failing cell is any string starting with MISSING / CRITICAL / STALE /
 * DRIFT / WARN / FAIL / ERROR -- the file's own vocabulary. Each is printed
 * with the section header a person would look for in the file.
 *
 * Env:
 *   SUPABASE_ACCESS_TOKEN   required (Management API token)
 *   SUPABASE_PROJECT_REF    default mkquclffrvlzyecnabyf (Silo production)
 *   VERIFY_SQL_PATH         default supabase/verify_v2_schema.sql
 */
import { readFileSync } from 'node:fs';
import { splitSqlStatements, isReadOnlyStatement, findFailures } from './lib/sql-statements.mjs';
import { queryWithRetry, makePacer, DEFAULT_MIN_GAP_MS } from './lib/management-api.mjs';

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF || 'mkquclffrvlzyecnabyf';
const SQL_PATH = process.env.VERIFY_SQL_PATH || 'supabase/verify_v2_schema.sql';

if (!TOKEN) {
  console.error('::error::SUPABASE_ACCESS_TOKEN is not set. It is the same secret the Deploy Edge Function workflow uses.');
  process.exit(2);
}

const statements = splitSqlStatements(readFileSync(SQL_PATH, 'utf8'));
const notReadOnly = statements.filter((s) => !isReadOnlyStatement(s.text));
if (notReadOnly.length) {
  for (const s of notReadOnly) {
    console.error(`::error file=${SQL_PATH},line=${s.line}::statement is not SELECT/WITH and will not be sent: ${s.text.slice(0, 80)}`);
  }
  process.exit(2);
}
console.log(`${statements.length} statements in ${SQL_PATH}, project ${REF}\n`);

// The endpoint accepts { query } and, optionally, { read_only: true }. The
// flag is NOT sent, and the reason is a first-run finding (2026-09-10): it
// is honoured by running the statement as a restricted role, and that role
// sees a different database. information_schema.check_constraints hides
// constraints on tables the role has no privilege on, and a function granted
// only to `authenticated` is "permission denied" -- so two checks that read
// ok in the SQL editor came back MISSING / ERROR here for nothing. The
// verify script is written to be run as the SQL editor role (`postgres`),
// and that is what it is run as; the read-only guarantee comes from the
// SELECT/WITH check above, which is enforced before anything is sent.
//
// Calls are paced and 429s are retried: the SECOND run lost 28 of 148
// statements to the API's rate limit once they stopped being slowed down by
// the read-only role. See scripts/lib/management-api.mjs.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pace = makePacer(DEFAULT_MIN_GAP_MS, sleep);
async function runStatement(text) {
  await pace();
  return queryWithRetry({ fetch, sleep, token: TOKEN, ref: REF, query: text, log: (m) => console.log(m) });
}

let failed = 0;
let errored = 0;
let retried = 0;
let okCells = 0;
let lastSection = null;

for (const [idx, s] of statements.entries()) {
  const label = `#${idx + 1} (line ${s.line})`;
  const result = await runStatement(s.text);
  if (result.retries) retried++;
  if (result.error) {
    errored++;
    if (s.section !== lastSection) { console.log(`\n-- ${s.section ?? '(no section header)'}`); lastSection = s.section; }
    console.log(`  ERROR ${label}: ${result.error}`);
    console.log(`::error file=${SQL_PATH},line=${s.line}::statement failed to run: ${result.error}`);
    continue;
  }
  const bad = findFailures(result.rows);
  const rows = Array.isArray(result.rows) ? result.rows : [];
  for (const row of rows) for (const v of Object.values(row)) if (v === 'ok') okCells++;
  if (bad.length) {
    failed++;
    if (s.section !== lastSection) { console.log(`\n-- ${s.section ?? '(no section header)'}`); lastSection = s.section; }
    for (const b of bad) {
      console.log(`  FAIL ${label} ${b.column}: ${b.value}`);
      console.log(`::error file=${SQL_PATH},line=${s.line}::${s.section ? `[${s.section}] ` : ''}${b.column}: ${b.value}`);
    }
  }
}

console.log(`\n${statements.length} statements, ${okCells} ok cells, ${failed} with a failing row, ${errored} that could not run, ${retried} retried after a rate limit.`);
if (failed || errored) {
  console.log('\nProduction does not match what the repo claims. Usually this means a merged migration was never applied: run supabase/apply_all_post_merge.sql (or the named migration) in the SQL editor, then re-run this workflow.');
  process.exit(1);
}
console.log('All ok.');
