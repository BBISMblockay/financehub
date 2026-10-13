// The freshness check's SELF-HEAL path, held to the two properties that made
// it useless between 2026-10-05 and 2026-10-13.
//
// What went wrong, measured on run 38341584392 (2026-10-13 03:29 UTC): the
// "Re-sync marketing (stale)" step ran scripts/ad-platforms-sync.mjs with no
// `env:` block at all. That script redeems a per-connection Google refresh
// token with the SHARED OAuth client, so with GOOGLE_CLIENT_ID /
// GOOGLE_CLIENT_SECRET / GOOGLE_ADS_DEVELOPER_TOKEN unset every google_ads,
// ga4 and search_console connection came back {"skipped":
// "google_env_missing"} and the script exited 1. The heal could not repair a
// Google feed -- the only kind of marketing feed there is -- and its exit 1
// turned the job red on every run, so the alarm that was correctly reporting
// a seven-day-stale company reported it into a check nobody could read.
//
// Neither property is visible in a diff: a step with a missing secret looks
// exactly like a step that needs none. Hence this test.
//
// Deliberately text-based. The repo has no YAML parser in its dependencies,
// and PyYAML is not installed either, so the assertions walk the step blocks
// themselves. Each one is scoped to ONE step, so moving a secret to a
// different step fails just as a deletion does.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isManualRun, runOutcomeReport } from '../lib/sync-plan.mjs';

const WORKFLOW = '.github/workflows/sales-freshness-check.yml';
const source = readFileSync(WORKFLOW, 'utf8');

/** The YAML block belonging to one step, by its `name:`, up to the next step.
 *
 * Returning the block rather than the whole file is the point: an assertion
 * against the file would pass if the secret were added to any step at all,
 * and "the sales heal has the Google secrets" is not the property under test.
 */
function stepBlock(name) {
  const start = source.indexOf(`      - name: ${name}\n`);
  assert.notStrictEqual(start, -1, `${WORKFLOW} has no step named "${name}"`);
  const next = source.indexOf('\n      - name: ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test('the marketing heal carries the shared Google OAuth client', () => {
  const block = stepBlock('Re-sync marketing (stale)');
  // The whole set scripts/ad-platforms-sync.mjs reads beyond the Supabase
  // pair. Meta and TikTok credentials live on the connection rows, so if this
  // list ever needs a fourth entry it is because the script changed.
  for (const secret of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_ADS_DEVELOPER_TOKEN']) {
    assert.match(
      block,
      new RegExp(`^\\s+${secret}: \\$\\{\\{ secrets\\.${secret} \\}\\}$`, 'm'),
      `the marketing heal step must pass ${secret}, or every Google connection is skipped as google_env_missing and the heal cannot repair the feed it exists for`,
    );
  }
});

// The sales heal's own failure policy. Measured on run 38370936709
// (2026-10-13 09:21 UTC, the first green run after the marketing fix): the
// verdict read HEAL_SALES=failure while the sales feed came back fresh,
// because the step passed no SHOPIFY_RUN_KIND and isManualRun() therefore
// defaulted to the strict hand-dispatch policy. Bat Nutz lacks
// read_shopify_payments_payouts and read_draft_orders, so two stages
// scope-skip on every run and exit 1 followed every time -- a permanent
// "the heal path is broken" in a verdict where it was not.
test('the sales heal is judged by the policy of the trigger that started it', () => {
  assert.match(
    stepBlock('Re-sync sales (stale)'),
    /^\s+SHOPIFY_RUN_KIND: \$\{\{ github\.event_name \}\}$/m,
    'without this the scheduled heal is judged as a hand-dispatched backfill, so a stage only the store owner can unblock reports the heal as failed on every run',
  );
});

test('a scheduled run does not fail for a stage only the store owner can unblock', () => {
  const scoped = [{ requested: true, state: 'scope_skipped', jobType: 'draft_orders_sync', shopDomain: 'batnutz.myshopify.com' }];
  assert.equal(runOutcomeReport({ manual: isManualRun({ SHOPIFY_RUN_KIND: 'schedule' }), outcomes: scoped }).exitCode, 0);
  // The same missing scope on a hand-dispatched backfill still goes red: the
  // operator asked for that stage and did not get it.
  assert.equal(runOutcomeReport({ manual: isManualRun({ SHOPIFY_RUN_KIND: 'workflow_dispatch' }), outcomes: scoped }).exitCode, 1);
  // And the default with no RUN_KIND is still strict, which is why the step
  // has to pass one.
  assert.equal(isManualRun({}), true);
});

test('a heal that fails is not the job verdict, and the verdict step is', () => {
  for (const name of ['Re-sync sales (stale)', 'Re-sync marketing (stale)']) {
    const block = stepBlock(name);
    assert.match(block, /^\s+continue-on-error: true$/m,
      `${name} must not decide the job: the question is whether the DATA is fresh, which the verify pass answers`);
    assert.match(block, /^\s+id: heal_/m, `${name} needs an id so the verdict step can report its outcome`);
  }

  const verify = stepBlock('Verify freshness after heal');
  assert.match(verify, /^\s+id: verify$/m);
  assert.match(verify, /^\s+continue-on-error: true$/m);
  assert.match(verify, /node scripts\/check-sales-freshness\.mjs/);

  const verdict = stepBlock('Freshness verdict');
  assert.match(verdict, /if: \$\{\{ always\(\) \}\}/,
    'the verdict must run even when a heal or the verify pass failed');
  // It owns the exit code, so every one of these has to be reachable from it:
  // the check itself breaking, the data still being stale, and a heal that
  // failed while the data came back fresh.
  assert.match(verdict, /VERIFY: \$\{\{ steps\.verify\.outcome \}\}/);
  assert.match(verdict, /HEAL_SALES: \$\{\{ steps\.heal_sales\.outcome \}\}/);
  assert.match(verdict, /HEAL_MARKETING: \$\{\{ steps\.heal_marketing\.outcome \}\}/);
  assert.match(verdict, /if \[ "\$VERIFY" = "failure" \]; then\n(.|\n)*?exit 1/,
    'still-stale data after the heal must fail the job');
  assert.match(verdict, /if \[ "\$CHECK" != "success" \]; then\n(.|\n)*?exit 1/,
    'a check that did not complete must fail the job rather than read as fresh');
  assert.match(verdict, /HEAL_SALES" = "failure" \] \|\| \[ "\$HEAL_MARKETING" = "failure"/,
    'a heal that failed must be named even when the feed recovered, or a broken heal path hides behind it');
});

test('the heal still only runs for the feed that is stale, and only when asked', () => {
  assert.match(stepBlock('Re-sync sales (stale)'),
    /if: \$\{\{ steps\.check\.outputs\.sales_stale == 'true' && github\.event\.inputs\.heal != 'false' \}\}/);
  assert.match(stepBlock('Re-sync marketing (stale)'),
    /if: \$\{\{ steps\.check\.outputs\.marketing_stale == 'true' && github\.event\.inputs\.heal != 'false' \}\}/);
});
