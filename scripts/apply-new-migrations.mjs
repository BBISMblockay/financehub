/* Apply the migration files named on the command line to a Supabase project.
 *
 * Driven by .github/workflows/auto-apply-migrations.yml, which passes ONLY the
 * files the merged push ADDED -- this script never decides what to apply, so
 * it cannot backfill and cannot touch a file the push did not add.
 *
 * Decisions, the atomicity probe and why the Management API rather than psql:
 * scripts/lib/apply-migrations-core.mjs. Tests:
 * scripts/tests/apply-migrations.test.mjs.
 *
 * Env:
 *   SUPABASE_ACCESS_TOKEN   required (the same secret the deploy and drift
 *                           workflows use; no database password anywhere)
 *   SUPABASE_PROJECT_REF    default mkquclffrvlzyecnabyf (Silo production)
 *   GITHUB_STEP_SUMMARY     optional; the per-file outcome is written there
 *
 * Exit: 0 applied/skipped everything asked, 1 stopped on a file, 2 misconfigured.
 */
import { readFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { applyMigrations } from './lib/apply-migrations-core.mjs';
import { queryWithRetry, makePacer, DEFAULT_MIN_GAP_MS } from './lib/management-api.mjs';

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF || 'mkquclffrvlzyecnabyf';
const files = process.argv.slice(2).filter(Boolean);

const summaryLines = [];
const summary = (line) => summaryLines.push(line);
function flushSummary() {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path || summaryLines.length === 0) return;
  try { appendFileSync(path, `${summaryLines.join('\n')}\n`); } catch { /* a summary is not worth failing a run */ }
}

if (files.length === 0) {
  console.log('No migration files were passed; nothing to apply.');
  summary('### Migrations\n');
  summary('No new migration files in this push.');
  flushSummary();
  process.exit(0);
}

if (!TOKEN) {
  console.error('::error::SUPABASE_ACCESS_TOKEN is not set. It is the same secret the Deploy Edge Function workflow uses. These migrations must be applied by hand:');
  for (const f of files) console.error(`::error::  ${f}`);
  summary('### Migrations\n');
  summary('**Stopped: `SUPABASE_ACCESS_TOKEN` is not set.** Nothing was applied.');
  flushSummary();
  process.exit(2);
}

console.log(`${files.length} migration file(s) to consider, project ${REF}\n`);

// Paced and 429-retried for the same reason the drift check is: this endpoint
// rate-limits, and a refused call is not a finding about the database.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pace = makePacer(DEFAULT_MIN_GAP_MS, sleep);
async function runSql(query) {
  await pace();
  return queryWithRetry({ fetch, sleep, token: TOKEN, ref: REF, query, log: (m) => console.log(m) });
}

const { results, failed, abort } = await applyMigrations({
  files,
  readFile: (p) => readFile(p, 'utf8'),
  runSql,
  log: (m) => console.log(m),
});

summary('### Migrations\n');
if (abort) {
  console.error(`::error::${abort}`);
  summary(`**Stopped before applying anything.** ${abort}`);
}
for (const r of results) {
  const base = r.file.split('/').pop();
  if (r.status === 'applied') summary(`- \`${base}\` — applied`);
  else if (r.status === 'skipped') summary(`- \`${base}\` — skipped, already applied`);
  else if (r.status === 'refused') {
    console.error(`::error::${base} ${r.detail}. Apply it by hand, then re-run this run to continue with the rest.`);
    summary(`- \`${base}\` — **needs a hand apply**: ${r.detail}`);
  } else if (r.status === 'failed') {
    console.error(`::error::${base} failed: ${r.detail}`);
    summary(`- \`${base}\` — **FAILED and rolled back**: ${r.detail}`);
  } else summary(`- \`${base}\` — not attempted`);
}
if (failed || abort) {
  summary('\nNothing after the stopping point ran, and no edge function was deployed.');
}
flushSummary();
process.exit(failed || abort ? 1 : 0);
