// Windsor yields to a company's own native connector.
//
// Windsor can deliver TikTok and Klaviyo for the same company that has
// connected those sources directly. Both write the same days, so one of them
// must stand down, and the native connector owns its own grain. The entries
// are DATA (NATIVE_CONNECTION_TABLES) with the columns that identify the row,
// so adding a source is a map entry, never a branch in the sync.
//
// Mutations (each must fail at least one assertion):
//   WINDSOR_NATIVE_MUTATION=match     the entry's identifying columns are not applied
//   WINDSOR_NATIVE_MUTATION=guess     a failed read answers "not native" instead of throwing
//   WINDSOR_NATIVE_MUTATION=notiktok  TikTok is dropped from the map, so Windsor writes its days too
//
// Run: node --test scripts/tests/windsor-native-precedence.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MUT = process.env.WINDSOR_NATIVE_MUTATION || '';
const libUrl = new URL('../lib/windsor-sync-core.mjs', import.meta.url);

async function loadCore() {
  let src = fs.readFileSync(libUrl, 'utf8');
  const sub = (from, to) => {
    assert.ok(src.includes(from), `mutation ${MUT}: pattern missing`);
    src = src.split(from).join(to);
  };
  if (MUT === 'match') sub('  for (const [column, value] of Object.entries(native.match || {})) query = query.eq(column, value);\n', '');
  if (MUT === 'guess') sub('if (error) throw new Error(`could not check for a native ${dsId} connection: ${error.message}`);', 'if (error) return false;');
  if (MUT === 'notiktok') sub("  tiktok: { table: 'ad_platform_connections', match: { platform: 'tiktok_ads' } },\n", '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windsor-native-'));
  const libFile = path.join(dir, 'windsor-lib.mjs');
  fs.writeFileSync(libFile, fs.readFileSync(new URL('../../supabase/functions/windsor-broker/windsor-lib.mjs', import.meta.url)));
  src = src.replace("'../../supabase/functions/windsor-broker/windsor-lib.mjs'", "'./windsor-lib.mjs'")
    .replace("'./shopify-sync-core.mjs'", `'${new URL('./shopify-sync-core.mjs', libUrl).href}'`);
  const file = path.join(dir, 'windsor-sync-core.mjs');
  fs.writeFileSync(file, src);
  return import(file);
}
const { supersededByNative, NATIVE_CONNECTION_TABLES } = await loadCore();

const CO = '11111111-1111-1111-1111-111111111111';

/** Minimal PostgREST stand-in: records every filter, answers with `rows`. */
function fakeSupabase({ rows = [], error = null } = {}) {
  const seen = [];
  const builder = (table) => {
    const filters = {};
    const self = {
      select: () => self,
      eq: (col, val) => { filters[col] = val; return self; },
      limit: () => { seen.push({ table, filters }); return Promise.resolve({ data: rows, error }); },
    };
    return self;
  };
  return { supabase: { from: builder }, seen };
}

await test('a native TikTok connection supersedes Windsor, matched on platform', async () => {
  const { supabase, seen } = fakeSupabase({ rows: [{ id: 'c1' }] });
  assert.equal(await supersededByNative({ supabase, dsId: 'tiktok', companyId: CO }), true);
  assert.deepEqual(seen, [{
    table: 'ad_platform_connections',
    // ad_platform_connections holds every platform, so without the platform
    // filter a company's Google Ads row would silence Windsor's TikTok.
    filters: { company_entity_id: CO, is_active: true, sync_enabled: true, platform: 'tiktok_ads' },
  }]);
});

await test('Klaviyo keeps its unfiltered check', async () => {
  const { supabase, seen } = fakeSupabase({ rows: [{ id: 'k1' }] });
  assert.equal(await supersededByNative({ supabase, dsId: 'klaviyo', companyId: CO }), true);
  assert.deepEqual(seen[0].filters, { company_entity_id: CO, is_active: true, sync_enabled: true });
});

await test('no native row means Windsor still syncs', async () => {
  const { supabase } = fakeSupabase({ rows: [] });
  assert.equal(await supersededByNative({ supabase, dsId: 'tiktok', companyId: CO }), false);
});

await test('a source with no native connector is never checked', async () => {
  const { supabase, seen } = fakeSupabase({ rows: [{ id: 'x' }] });
  assert.equal(await supersededByNative({ supabase, dsId: 'pinterest', companyId: CO }), false);
  assert.equal(seen.length, 0);
});

await test('a failed read throws rather than guessing "not native"', async () => {
  // Guessing wrong writes a second copy of the same numbers, which is exactly
  // what this check exists to prevent.
  const { supabase } = fakeSupabase({ error: { message: 'timeout' } });
  await assert.rejects(() => supersededByNative({ supabase, dsId: 'tiktok', companyId: CO }), /timeout/);
});

await test('the map stays data: every entry names a table, and any filter is plain columns', () => {
  for (const [dsId, entry] of Object.entries(NATIVE_CONNECTION_TABLES)) {
    assert.equal(typeof entry.table, 'string', `${dsId} names no table`);
    for (const [col, val] of Object.entries(entry.match || {})) {
      assert.match(col, /^[a-z][a-z0-9_]*$/, `${dsId}.${col} is not a column name`);
      assert.equal(typeof val, 'string');
    }
  }
});
