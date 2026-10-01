// Supabase preloads pg_safeupdate for API sessions (authenticator's
// session_preload_libraries), which refuses any DELETE without a WHERE clause
// -- even against a temporary table, and even inside a SECURITY DEFINER
// function. PGlite does not load it, so the database tests cannot see this:
// `delete from tmp_split;` passed them and failed every split save in
// production ("DELETE requires a WHERE clause", 2026-10-01).
//
// This reads the LATEST definition of every public function across the
// migrations and refuses a bare `delete from <table>;` in any of them.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const dir = new URL('../../supabase/migrations/', import.meta.url);

async function latestFunctionBodies() {
  const latest = new Map();
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(name, dir), 'utf8');
    const re = /create\s+or\s+replace\s+function\s+(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\$(\w*)\$([\s\S]*?)\$\3\$/gi;
    for (const m of sql.matchAll(re)) latest.set(m[1].toLowerCase(), { file: name, body: m[4] });
  }
  return latest;
}

test('no function deletes without a WHERE clause (pg_safeupdate refuses it)', async () => {
  const offenders = [];
  for (const [fn, { file, body }] of await latestFunctionBodies()) {
    const stripped = body.replace(/--[^\n]*/g, '');
    for (const m of stripped.matchAll(/\bdelete\s+from\s+[\w."]+(?:\s+(?:as\s+)?\w+)?\s*;/gi)) {
      offenders.push(`${fn} (${file}): ${m[0].replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('set_card_transaction_splits resets its scratch table with an explicit WHERE', async () => {
  const fn = (await latestFunctionBodies()).get('set_card_transaction_splits');
  assert.ok(fn, 'set_card_transaction_splits is defined');
  assert.match(fn.body, /delete from tmp_split where true;/);
});
