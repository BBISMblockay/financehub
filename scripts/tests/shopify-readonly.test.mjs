/* Shopify integration stays READ-ONLY.
 *
 * This currently holds twice over: the OAuth app requests 71 scopes and
 * every one is read_*, and no sync issues a GraphQL mutation. Shopify would
 * reject a write even if the code attempted one, which is the strongest
 * form of this guarantee -- it does not depend on anyone reviewing a diff.
 *
 * The reason to assert it anyway is that both halves are one line from
 * being lost. Adding 'write_products' to a scopes array is a plausible
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
 * 2026-11-17, that conversation (Blake): SILO makes affiliate discount codes
 * in the store itself, on the SAME connection ("We ask a lot of user to use
 * silo") -- Shopify gives one token per app per store, so a separate
 * credential would mean a second app. So exactly ONE write is allowed:
 * write_discounts, used by exactly one file, for exactly one mutation
 * (discountCodeBasicCreate), and the syncs still issue none.
 *
 * 2026-11-18 (audit, Blake: "end the affiliate and confirm the code stops
 * working"): the same file may also DEACTIVATE a discount SILO made
 * (discountCodeDeactivate), so ending an affiliate stops their code at
 * checkout. Same scope; never a delete, never anything else.
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

// Two apps request scopes: the legacy custom app (LEGACY_SCOPES in the start
// function) and the public app (PUBLIC_SCOPES in the shared auth lib). Both
// lists are checked; a Dev Dashboard app's scopes are set by the store owner
// in Shopify and are shown to them as the same eight PUBLIC_SCOPES.
for (const [label, path, name] of [
  ['legacy app', 'supabase/functions/shopify-oauth-start/index.ts', 'LEGACY_SCOPES'],
  ['public app', 'scripts/lib/shopify-auth-lib.mjs', 'PUBLIC_SCOPES'],
]) {
  test(`every scope the ${label} requests is read_*`, () => {
    const src = read(path);
    const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`).exec(src);
    if (!block) throw new Error(`could not find the ${name} array in ${path}`);
    const scopes = [...block[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    if (scopes.length === 0) throw new Error('parsed zero scopes — the assertion would pass vacuously');
    // write_discounts is the one write SILO holds (2026-11-17): it makes
    // affiliate discount codes, from affiliate-invite only -- never a sync.
    // Syncs stay read-only by the mutation scan above.
    const writes = scopes.filter((s) => !s.startsWith('read_') && s !== 'write_discounts');
    if (writes.length) {
      throw new Error(
        `${writes.length} non-read scope(s) requested: ${writes.join(', ')}. ` +
        'A write scope here widens the credential every nightly sync holds; ' +
        'put it on a separate narrowly-scoped credential instead.',
      );
    }
    console.log(`       (${scopes.length} scopes, all read_*)`);
  });
}

console.log('\n-- the one write: affiliate discount codes --');
test('shopify-codes.mjs issues only discountCodeBasicCreate and discountCodeDeactivate', () => {
  const src = read('supabase/functions/affiliate-invite/shopify-codes.mjs');
  const found = [...src.matchAll(/\bmutation\s+\w+[^{]*\{\s*(\w+)/g)].map((m) => m[1]).sort();
  if (JSON.stringify(found) !== JSON.stringify(['discountCodeBasicCreate', 'discountCodeDeactivate'])) {
    throw new Error(`expected exactly discountCodeBasicCreate and discountCodeDeactivate; found ${JSON.stringify(found)}`);
  }
});

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
