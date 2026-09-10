#!/usr/bin/env node
/**
 * Compare what is DEPLOYED as edge functions with what is on this checkout.
 *
 * Run AFTER `supabase functions download --use-api --project-ref <ref>` has
 * written the deployed source of every function into supabase/functions/.
 * From there the comparison is git's: a modified tracked file is a function
 * whose deployed source differs from the repo; an untracked directory is a
 * function deployed with no source in the repo at all.
 *
 * Both have happened here. `silo-chat` ran a version behind `main` twice in
 * two weeks (2026-08-26 and 2026-09-07) because merging a PR does not deploy,
 * and the only way anyone found out was a model being told a row cap that
 * was no longer true. Four functions (bright-action, replace-product-tags,
 * notify-slack, oneoff-meta-sync) are deployed with no source checked in;
 * one of them is called by a DB trigger. Those four are KNOWN and listed
 * below so they warn rather than fail -- a new one fails, because a function
 * that exists only in production is exactly the drift this exists to catch.
 *
 * The third direction is checked too: a function directory in the repo that
 * is not deployed at all. "Repo ahead of prod" is the same class of drift as
 * an unapplied migration.
 *
 * Env: SUPABASE_ACCESS_TOKEN (Management API), SUPABASE_PROJECT_REF.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF || 'mkquclffrvlzyecnabyf';
const FN_DIR = 'supabase/functions';

// Deployed with no source in this repo, as of 2026-09-10. Documented in
// CLAUDE.md ("Not in this repo"). Adding a slug here is a decision to keep
// living with it; the honest fix is checking the source in.
const KNOWN_UNSOURCED = new Set(['bright-action', 'replace-product-tags', 'notify-slack', 'oneoff-meta-sync']);

// A content difference somebody has decided not to reconcile YET.
//
// Without this the check is red every day for as long as the decision
// stands, and a check that is always red is one nobody reads -- which costs
// more than the finding it is reporting.
//
// But a bare list of slugs would be worse than the red: it would also
// swallow the NEXT, different drift in the same function -- a truncated hand
// deploy, a rollback, a repo edit nobody shipped -- which is exactly what
// this check exists to catch. So each entry is PINNED to the `ezbr_sha256`
// of the deployed bundle at the moment the decision was taken. It forgives
// that one state of production and nothing else: redeploy the function and
// the hash moves, the pin breaks, and the run fails again.
//
// Delete the entry when the difference is reconciled.
const DEFERRED_DRIFT = new Map([
  ['card-categorize', {
    since: '2026-09-10',
    deployedSha256: '2f4a4bc09f8c688b837841748f34481a752fc5a4023339047f0c23697ff58ba0', // v9
    why: 'the difference is a prompt RULE, not a merge -- production says a card-name '
      + 'match should set the location, main says only name a location when the merchant '
      + 'or card clearly belongs to one store. Deferred until there is enough real card '
      + 'coding to say which rule suggests better; shipping either one first ends the '
      + 'comparison.',
  }],
]);

if (!TOKEN) {
  console.error('::error::SUPABASE_ACCESS_TOKEN is not set.');
  process.exit(2);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/functions`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
if (!res.ok) {
  console.error(`::error::could not list deployed functions: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  process.exit(2);
}
const deployed = await res.json();
const deployedSlugs = new Set(deployed.map((f) => f.slug));
const shaBySlug = new Map(deployed.map((f) => [f.slug, f.ezbr_sha256]));

// TRACKED directories only. This runs after `supabase functions download`
// has written every deployed function over the checkout, so reading the
// filesystem here would count the just-downloaded unsourced functions as
// "in the repo" -- which is exactly what the first live run did (2026-09-10):
// all four known-unsourced functions were reported as extra files inside
// repo functions instead of as functions with no source. git's index is the
// only honest answer to "what does the repo contain".
const repoSlugs = new Set(
  execFileSync('git', ['ls-files', '--', FN_DIR], { encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .map((p) => p.split('/')[2])
    .filter(Boolean),
);

const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', FN_DIR], { encoding: 'utf8' })
  .split('\n').filter(Boolean);

const modified = [];       // deployed source differs from repo in CONTENT
const newlineOnly = [];    // differs only by a trailing newline at EOF
const extraFiles = [];     // deployed bundle carries a file the repo does not
const unsourced = new Set(); // deployed, no directory in repo
for (const line of status) {
  const code = line.slice(0, 2);
  const path = line.slice(3);
  const slug = path.split('/')[2];
  if (code === '??') {
    if (repoSlugs.has(slug)) extraFiles.push(path); else unsourced.add(slug);
    continue;
  }
  // Every function deployed before the sources were checked in (2026-09-02)
  // is stored WITHOUT a trailing newline, and every file in the repo ends
  // with one -- so six functions showed a 2-line diff on the first run that
  // was no difference at all. Compared with trailing whitespace stripped;
  // anything else is real.
  const deployed = readFileSync(path, 'utf8');
  const tracked = execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8' });
  if (deployed.trimEnd() === tracked.trimEnd()) newlineOnly.push(path); else modified.push(path);
}
// Pull out drift that was deferred BY DECISION -- but only while the pin
// still holds. A pin that cannot be checked (no ezbr_sha256 came back for
// the slug) fails closed: the path stays in `modified` and the run fails.
const deferredDrift = [];
const brokenPins = [];
for (let i = modified.length - 1; i >= 0; i -= 1) {
  const slug = modified[i].split('/')[2];
  const d = DEFERRED_DRIFT.get(slug);
  if (!d) continue;
  const live = shaBySlug.get(slug);
  if (live && live === d.deployedSha256) deferredDrift.push(...modified.splice(i, 1));
  else brokenPins.push({ path: modified[i], slug, live });
}

const notDeployed = [...repoSlugs].filter((s) => !deployedSlugs.has(s));

console.log('Deployed functions:');
for (const f of deployed.sort((a, b) => a.slug.localeCompare(b.slug))) {
  console.log(`  ${f.slug.padEnd(34)} v${String(f.version).padEnd(4)} verify_jwt=${f.verify_jwt}`);
}

let failed = false;
if (deferredDrift.length) {
  console.log('\nDeferred by decision (deployed bundle still matches the pin, so this is the SAME difference that was deferred):');
  for (const path of deferredDrift) {
    const d = DEFERRED_DRIFT.get(path.split('/')[2]);
    console.log(`  ${path}\n    deferred ${d.since}: ${d.why}`);
    console.log(`::warning file=${path}::deployed source differs from main; deferred by decision on ${d.since}`);
  }
}
if (brokenPins.length) {
  // Still counted in `modified`, so the run fails on it -- this only makes
  // the reason legible instead of looking like brand-new drift.
  console.log('\nA DEFERRED DIFFERENCE IS NO LONGER THE ONE THAT WAS DEFERRED:');
  for (const b of brokenPins) {
    const d = DEFERRED_DRIFT.get(b.slug);
    console.log(`::error file=${b.path}::${b.slug} was deferred on ${d.since} against deployed bundle `
      + `${d.deployedSha256.slice(0, 12)}, but production now reports ${String(b.live || 'no ezbr_sha256').slice(0, 12)}. `
      + 'Re-read the difference, then either reconcile it or re-pin the deferral in scripts/check-function-drift.mjs.');
  }
}
if (newlineOnly.length) {
  console.log('\nDiffers only by a trailing newline at end of file (not drift):');
  for (const p of newlineOnly) console.log(`  ${p}`);
}
if (modified.length) {
  failed = true;
  console.log('\nDEPLOYED SOURCE DIFFERS FROM THIS CHECKOUT:');
  for (const p of modified) { console.log(`  ${p}`); console.log(`::error file=${p}::deployed source differs from main`); }
  console.log('\n' + execFileSync('git', ['diff', '--stat', '--', ...modified], { encoding: 'utf8' }));
  // The diff itself, capped: a 2-line change in six functions is a CLI
  // re-emission quirk, an 80-line change in one is a deploy that never
  // happened, and only the hunks tell them apart.
  const diff = execFileSync('git', ['diff', '--', ...modified], { encoding: 'utf8' });
  const lines = diff.split('\n');
  console.log(lines.slice(0, 400).join('\n'));
  if (lines.length > 400) console.log(`... (${lines.length - 400} more diff lines; run the download locally for the rest)`);
}
if (extraFiles.length) {
  failed = true;
  console.log('\nDEPLOYED BUNDLE CARRIES FILES THE REPO DOES NOT:');
  for (const p of extraFiles) { console.log(`  ${p}`); console.log(`::error file=${p}::file exists in the deployed bundle but not in the repo`); }
}
const newUnsourced = [...unsourced].filter((s) => !KNOWN_UNSOURCED.has(s));
const knownUnsourced = [...unsourced].filter((s) => KNOWN_UNSOURCED.has(s));
if (knownUnsourced.length) {
  console.log(`\nDeployed with no source in repo (known, see CLAUDE.md): ${knownUnsourced.join(', ')}`);
  console.log(`::warning::${knownUnsourced.length} deployed function(s) have no source in this repo: ${knownUnsourced.join(', ')}`);
}
if (newUnsourced.length) {
  failed = true;
  console.log(`\nNEW FUNCTION DEPLOYED WITH NO SOURCE IN REPO: ${newUnsourced.join(', ')}`);
  for (const s of newUnsourced) console.log(`::error::${s} is deployed but has no directory under ${FN_DIR}`);
}
if (notDeployed.length) {
  failed = true;
  console.log(`\nIN REPO BUT NOT DEPLOYED: ${notDeployed.join(', ')}`);
  for (const s of notDeployed) console.log(`::error::${FN_DIR}/${s} exists on main but is not deployed (run the Deploy Edge Function workflow)`);
}

if (failed) {
  console.log('\nFix: run the "Deploy Edge Function" workflow for the named function(s) from main. Never copy source through an API client by hand -- that is what truncated two silo-chat deploys on 2026-08-25.');
  process.exit(1);
}
console.log(deferredDrift.length
  ? `\nNo undeferred drift: every other deployed function matches main byte-for-byte, every function on main is deployed, and ${deferredDrift.length} deferred difference(s) are unchanged since the decision.`
  : '\nEvery deployed function matches main byte-for-byte, and every function on main is deployed.');
