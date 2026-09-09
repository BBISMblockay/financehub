/* Shopify integration stays READ-ONLY.
 *
 * This currently holds twice over: the OAuth app requests 71 scopes and
 * every one is read_*, and no sync issues a GraphQL mutation. Shopify would
 * reject a write even if the code attempted one, which is the strongest
 * form of this guarantee -- it does not depend on anyone reviewing a diff.
 *
 * The reason to assert it anyway is that both halves are one line from
 * being lost. Adding 'write_products' to the SCOPES array is a plausible
 * thing to do while chasing a feature (publishing a collection, fixing a
 * title), and it silently converts every sync in this repo from a reader
 * into something that could write to the live storefront. Nothing else in
 * the repo would notice.
 *
 * If a future feature genuinely needs a write scope, this test failing is
 * the intended conversation, not an obstacle: the scope belongs on a
 * separate, narrowly-scoped credential rather than widening the one every
 * nightly sync already holds.
 *
 * No network, no database. Run:
 *   node scripts/tests/shopify-readonly.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
let count = 0;
function test(name, fn) {
  count++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}

// GraphQL mutation DECLARATION syntax -- `mutation Name(`, `mutation Name {`
// or `mutation {`. Deliberately not a bare /mutation/, which would match
// prose in a comment (including the comments in this very file).
const MUTATION = /\bmutation\s*[A-Za-z_][A-Za-z0-9_]*\s*[({]|\bmutation\s*\{/;

const SYNC_FILES = [
  'scripts/lib/shopify-sync-core.mjs',
  'scripts/shopify-sync.mjs',
  'scripts/shopify-orders-backfill.mjs',
];

console.log('\n-- no sync issues a Shopify mutation --');

for (const file of SYNC_FILES) {
  test(`${file} contains no GraphQL mutation`, () => {
    let src;
    try { src = read(file); } catch { return; } // file may not exist in older trees
    const hit = MUTATION.exec(src);
    if (hit) {
      const line = src.slice(0, hit.index).split('\n').length;
      throw new Error(`GraphQL mutation at ${file}:${line} — Shopify syncs are read-only`);
    }
  });
}

console.log('\n-- the OAuth app requests only read scopes --');

test('every requested Shopify scope is read_*', () => {
  const src = read('supabase/functions/shopify-oauth-start/index.ts');
  const block = /const SCOPES = \[([\s\S]*?)\]/.exec(src);
  if (!block) throw new Error('could not find the SCOPES array in shopify-oauth-start');
  const scopes = [...block[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
  if (scopes.length === 0) throw new Error('parsed zero scopes — the assertion would pass vacuously');
  const writes = scopes.filter((s) => !s.startsWith('read_'));
  if (writes.length) {
    throw new Error(
      `${writes.length} non-read scope(s) requested: ${writes.join(', ')}. ` +
      'A write scope here widens the credential every nightly sync holds; ' +
      'put it on a separate narrowly-scoped credential instead.',
    );
  }
  console.log(`       (${scopes.length} scopes, all read_*)`);
});

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
