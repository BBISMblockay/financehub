// scripts/forecast-candidate-run.mjs — the operational runner for the
// Demand Planner's prospective forecast candidates.
//
// Source specification: saved report f98754f7-47a6-4eeb-8a8b-eece9a069432,
// frozen candidate Candidate_YoY_Shift_v1 (Youth, 30-day horizon).
//
// WHAT IT DOES: at each eligible cutoff it writes ONE static ledger row and
// never touches it again. Re-running is the normal case and is a no-op on any
// cutoff already frozen -- the database short-circuits on the existing row
// without recomputing, so a re-run cannot quietly replace a number a planner
// acted on with one today's data would produce.
//
// WHAT IT DOES NOT DO: it does not write a forecast anybody purchases
// against, does not touch po_headers/po_lines, and does not alter the
// production 90/180-day logic. The ledger is a parallel record kept so the
// candidate can be scored later against matured actuals.
//
// Run:  node scripts/forecast-candidate-run.mjs
// Env:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional:
//   FC_COMPANY_ID      one company (default: every company with a membership row)
//   FC_START_CUTOFF    first cutoff to attempt (default 2026-09-01, the first
//                      frozen run in the source report). Earlier cutoffs are
//                      BACKTEST territory and must not be written here as
//                      though they had been forecast at the time -- use
//                      scripts/forecast-candidate-backtest.mjs, which scores
//                      them without writing anything.
//   FC_CANDIDATE_ID, FC_SKU_CATEGORY, FC_HORIZON_DAYS
//   FC_DRY_RUN=1       plan the cutoffs and issue no writes

import { createClient } from '@supabase/supabase-js';
import {
  resolveCategories,
  runForecastCandidate,
  formatSummary,
  FIRST_FROZEN_CUTOFF,
  DEFAULT_CANDIDATE_ID,
  DEFAULT_HORIZON_DAYS,
} from './lib/forecast-candidate-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const ONLY_COMPANY = process.env.FC_COMPANY_ID || '';
const START_CUTOFF = process.env.FC_START_CUTOFF || FIRST_FROZEN_CUTOFF;
const CANDIDATE_ID = process.env.FC_CANDIDATE_ID || DEFAULT_CANDIDATE_ID;
// Empty means ALL forecastable categories for the company, resolved per tenant
// from forecastable_product_types(). No hardcoded fallback: a missing category
// is a question to ask the database, not a guess to make.
const SKU_CATEGORY = process.env.FC_SKU_CATEGORY || '';
const HORIZON_DAYS = Number(process.env.FC_HORIZON_DAYS || DEFAULT_HORIZON_DAYS);
const DRY_RUN = process.env.FC_DRY_RUN === '1';

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function companiesToRun() {
  if (ONLY_COMPANY) return [ONLY_COMPANY];
  // Every company with at least one membership. Deliberately not "every row in
  // entities": an entity with no members is not a tenant anyone is planning for.
  const { data, error } = await db.from('entity_memberships').select('entity_id');
  if (error) throw new Error(`could not list companies: ${error.message}`);
  return [...new Set((data || []).map((r) => r.entity_id))].filter(Boolean);
}


// The categories this company actually plans for. Resolved from the database,
// never guessed: forecastable_product_types() applies the human override where
// somebody set one and the evidence (inventory-tracked or purchased) otherwise.
//
// This exists because removing the 'Youth' default left the driver passing an
// empty category to a core that requires one -- every company would have thrown
// before recording a single forecast, and the scheduled workflow would exit 1.
// An explicit FC_SKU_CATEGORY still wins, so a manual single-category run is
// unchanged.
async function categoriesToRun(companyEntityId) {
  const { categories, needsReview } = await resolveCategories(db, companyEntityId, SKU_CATEGORY);
  if (!SKU_CATEGORY) {
    console.log(`  categories: ${categories.length} forecastable`);
    // Loud, and repeated every run until somebody records an override in
    // product_type_profile. These are NOT confirmed fee lines -- they are types
    // the evidence cannot classify, and the forecast they do not get is one
    // that can never be backfilled once the cutoff closes.
    if (needsReview.length > 0) {
      console.log(`  REVIEW REQUIRED - ${needsReview.length} type(s) have no inventory row, no`
        + ' purchase history and no override, so they are NOT being forecast:');
      for (const t of needsReview) console.log(`    - ${t}`);
      console.log('    Confirm each in product_type_profile (is_forecastable true or false).');
    }
  }
  return categories;
}

const companies = await companiesToRun();
if (companies.length === 0) {
  console.log('No companies to run.');
  process.exit(0);
}

let failures = 0;
for (const companyEntityId of companies) {
  console.log(`\n=== company ${companyEntityId} ===`);
  try {
    const categories = await categoriesToRun(companyEntityId);
    if (categories.length === 0) {
      console.log('  no forecastable categories; nothing to record');
      continue;
    }
    for (const skuCategory of categories) {
      // Per CATEGORY, not per company: one category failing must not cost the
      // rest of the company's ledger, for the same reason one company failing
      // must not cost the others.
      try {
        const { summary } = await runForecastCandidate({
          client: db,
          companyEntityId,
          startCutoff: START_CUTOFF,
          candidateId: CANDIDATE_ID,
          skuCategory,
          horizonDays: HORIZON_DAYS,
          dryRun: DRY_RUN,
        });
        console.log(`  ${skuCategory}: ${formatSummary(summary)}`);
        failures += summary.failed;
      } catch (error) {
        failures += 1;
        console.error(`  ${skuCategory} FAILED: ${error.message}`);
      }
    }
  } catch (error) {
    // One company failing must not stop the others: each tenant's ledger is
    // an independent record, and aborting would hide every company after the
    // first bad one.
    failures += 1;
    console.error(`  company ${companyEntityId} FAILED: ${error.message}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s). A failed Actions run emails the repo owner.`);
  process.exit(1);
}
console.log('\nDone. Every forecast written is PROSPECTIVE — NOT SCORED until its 30-day cycle matures.');
