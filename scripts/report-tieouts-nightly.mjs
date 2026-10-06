#!/usr/bin/env node
/**
 * Nightly run of every SILO report's tie-outs, for every company, as that
 * company. Fails (red run, emails the repo owner) on any MISMATCH, STALE or
 * ERROR. Read-only: each company's run is impersonated inside a transaction
 * that is rolled back. See scripts/lib/report-tieouts-nightly.mjs for why.
 *
 * Env:
 *   SUPABASE_ACCESS_TOKEN   required (the Management API token the drift
 *                           check and Deploy Edge Function already hold)
 *   SUPABASE_PROJECT_REF    default mkquclffrvlzyecnabyf (Silo production)
 *   GITHUB_STEP_SUMMARY     optional; a results table is appended when set
 */
import { appendFileSync } from 'node:fs';
import { queryWithRetry, makePacer, DEFAULT_MIN_GAP_MS } from './lib/management-api.mjs';
import { runNightly, summaryMarkdown, FAILING } from './lib/report-tieouts-nightly.mjs';

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF || 'mkquclffrvlzyecnabyf';
if (!TOKEN) {
  console.error('::error::SUPABASE_ACCESS_TOKEN is not set. It is the same secret the Deploy Edge Function workflow uses.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pace = makePacer(DEFAULT_MIN_GAP_MS, sleep);
async function query(sql) {
  await pace();
  return queryWithRetry({ fetch, sleep, token: TOKEN, ref: REF, query: sql, log: (m) => console.log(m) });
}

const result = await runNightly({ query, log: (m) => console.log(m) });
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result));

for (const c of result.companies) {
  for (const x of c.results || []) {
    if (FAILING.has(x.final)) {
      console.log(`::error::${c.title}: ${x.final} — ${x.report_title} :: ${x.check_name}`);
    }
  }
  if (c.status === 'error') console.log(`::error::${c.title}: ${c.reason}`);
}

if (result.failures) {
  console.log(`\n${result.failures} failing result(s). STALE means the report changed after its check was written: regenerate the check against the report's current SQL. MISMATCH means the report and its independent route disagree.`);
  process.exit(1);
}
console.log('\nAll checked companies pass.');
