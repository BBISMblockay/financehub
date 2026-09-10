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
import { readdirSync, statSync } from 'node:fs';

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF || 'mkquclffrvlzyecnabyf';
const FN_DIR = 'supabase/functions';

// Deployed with no source in this repo, as of 2026-09-10. Documented in
// CLAUDE.md ("Not in this repo"). Adding a slug here is a decision to keep
// living with it; the honest fix is checking the source in.
const KNOWN_UNSOURCED = new Set(['bright-action', 'replace-product-tags', 'notify-slack', 'oneoff-meta-sync']);

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

const repoSlugs = new Set(
  readdirSync(FN_DIR).filter((d) => statSync(`${FN_DIR}/${d}`).isDirectory()),
);

const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', FN_DIR], { encoding: 'utf8' })
  .split('\n').filter(Boolean);

const modified = [];       // deployed source differs from repo
const extraFiles = [];     // deployed bundle carries a file the repo does not
const unsourced = new Set(); // deployed, no directory in repo
for (const line of status) {
  const code = line.slice(0, 2);
  const path = line.slice(3);
  const slug = path.split('/')[2];
  if (code === '??') {
    if (repoSlugs.has(slug)) extraFiles.push(path); else unsourced.add(slug);
  } else {
    modified.push(path);
  }
}
const notDeployed = [...repoSlugs].filter((s) => !deployedSlugs.has(s));

console.log('Deployed functions:');
for (const f of deployed.sort((a, b) => a.slug.localeCompare(b.slug))) {
  console.log(`  ${f.slug.padEnd(34)} v${String(f.version).padEnd(4)} verify_jwt=${f.verify_jwt}`);
}

let failed = false;
if (modified.length) {
  failed = true;
  console.log('\nDEPLOYED SOURCE DIFFERS FROM THIS CHECKOUT:');
  for (const p of modified) { console.log(`  ${p}`); console.log(`::error file=${p}::deployed source differs from main`); }
  console.log('\n' + execFileSync('git', ['diff', '--stat', '--', FN_DIR], { encoding: 'utf8' }));
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
console.log('\nEvery deployed function matches main byte-for-byte, and every function on main is deployed.');
