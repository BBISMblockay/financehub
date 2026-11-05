#!/usr/bin/env node
// Fail if two migration files share a version timestamp.
//
// supabase_migrations.schema_migrations is keyed by the leading version alone,
// so if two files carry the same timestamp, applying one records the version
// and leaves the other looking applied while its statements never ran. Two
// threads working the same day collide easily -- 20261105060000 was claimed
// twice on 2026-11-05 -- and nothing in the diff shows it, because each PR
// adds only one file.
//
// Read-only. No database, no network.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// Ten versions were claimed twice before this check existed. Every one of them
// is already recorded in production, so the files cannot be renamed now: a
// rename would make the second file look unapplied and replay it. They are
// listed here so the check can fail on a NEW collision, which is the one that
// is still cheap to fix. Nothing may be added to this list -- a new duplicate
// gets renamed instead.
const ALREADY_APPLIED = new Set([
  '20260603140000', '20260721000000', '20260812000000', '20260821170000',
  '20260825170000', '20260826070000', '20260827180000', '20260923160000',
  '20260923170000', '20261013180000',
]);

const DIR = join(import.meta.dirname, '..', 'supabase', 'migrations');
const byVersion = new Map();

for (const name of readdirSync(DIR).sort()) {
  if (!name.endsWith('.sql')) continue;
  const m = /^(\d{14})_/.exec(name);
  if (!m) {
    console.error(`NOT A MIGRATION NAME: ${name} (expected 14 digits, an underscore, then a description)`);
    process.exitCode = 1;
    continue;
  }
  const list = byVersion.get(m[1]) || [];
  list.push(name);
  byVersion.set(m[1], list);
}

let clashes = 0;
for (const [version, files] of byVersion) {
  if (files.length < 2) continue;
  if (ALREADY_APPLIED.has(version)) continue;
  clashes += 1;
  console.error(`DUPLICATE VERSION ${version}:`);
  for (const f of files) console.error(`  supabase/migrations/${f}`);
}

if (clashes) {
  console.error('');
  console.error(`${clashes} version${clashes === 1 ? '' : 's'} claimed by more than one file.`);
  console.error('Rename the newer file to an unused timestamp and follow it in');
  console.error('supabase/apply_all_post_merge.sql. Do this BEFORE either file is');
  console.error('applied: once a version is recorded, the other file is skipped.');
  process.exitCode = 1;
} else if (!process.exitCode) {
  console.log(
    `${byVersion.size} versions across the migrations directory, no new duplicates ` +
    `(${ALREADY_APPLIED.size} historical ones grandfathered).`,
  );
}
