/* Click-to-connect for ad platforms: the account picker and Reconnect.
 *
 * Proven:
 *   1. Every platform's listing becomes choices whose stored value is what the
 *      nightly sync reads (GA4 / Ads prefixes stripped, a Search Console
 *      property kept VERBATIM), and an unverified property is not selectable.
 *   2. Only a single selectable choice is made without asking.
 *   3. A choice writes the account field AND switches sync on; a disabled or
 *      empty choice writes nothing.
 *   4. mayReconnect: tokens go only onto the row the state names, in the same
 *      company, on the same platform.
 *   5. The functions are wired to those rules: start checks the row before
 *      recording it, the callback re-checks, updates instead of inserting,
 *      and returns the connection id; the test function's list mode records
 *      no test result.
 *   6. The migration applies twice, cascades with the connection, stays
 *      service-role only, and its verify block reads ok (real PostgreSQL).
 *   7. Integrations loads the picker, offers Reconnect on Google rows only,
 *      and asks for the list with list_accounts.
 *
 * Run: node scripts/tests/ad-account-picker.test.mjs
 * Needs (step 6): npm ci --prefix scripts/tests/finance-db  (skipped without it)
 * Mutation: AD_PICKER_MUTATION=no-recheck (the callback trusts the state's
 * connection id) must fail. */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const mutation = process.env.AD_PICKER_MUTATION || '';
assert.ok(['', 'no-recheck'].includes(mutation), `Unknown mutation ${mutation}`);

// Loaded the way the browser loads it: a plain script defining window.SiloAdPicker.
const sandbox = { window: {} };
vm.runInNewContext(read('v2/ad-account-picker.js'), sandbox);
const raw = sandbox.window.SiloAdPicker;
// Results cross back from the vm realm; clone them so deepEqual compares values, not prototypes.
const J = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const P = { options: (...a) => J(raw.options(...a)), patchFor: (...a) => J(raw.patchFor(...a)), autoPick: raw.autoPick };
const lib = await import(join(ROOT, 'supabase/functions/google-oauth-callback/google-oauth-lib.mjs'));

let n = 0;
const test = async (name, fn) => { await fn(); n += 1; console.log(`ok ${n} - ${name}`); };

await test('GA4: property id without the prefix, named, with its account', () => {
  const o = P.options('ga4', { properties: [{ property: 'properties/342891716', display_name: 'Baseballism', account: 'Baseballism Inc' }] });
  assert.deepEqual(o, [{ value: '342891716', label: 'Baseballism', sub: 'Baseballism Inc · 342891716', disabled: false }]);
});
await test('Google Ads: digits, shown dashed', () => {
  const [o] = P.options('google_ads', { accessible_customers: ['customers/7373491765'] });
  assert.equal(o.value, '7373491765');
  assert.equal(o.label, '737-349-1765');
});
await test('Search Console: the URL verbatim; an unverified property cannot be chosen', () => {
  const o = P.options('search_console', { sites: [
    { site_url: 'https://www.baseballism.com/', permission_level: 'siteOwner', readable: true },
    { site_url: 'sc-domain:baseballism.com', permission_level: 'siteUnverifiedUser', readable: false },
  ] });
  assert.equal(o[0].value, 'https://www.baseballism.com/');
  assert.equal(o[0].disabled, false);
  assert.equal(o[1].value, 'sc-domain:baseballism.com');
  assert.equal(o[1].disabled, true);
  assert.equal(P.autoPick(o), o[0], 'the only selectable one');
});
await test('Meta and TikTok lists', () => {
  assert.equal(P.options('meta_ads', { ad_accounts: [{ id: 'act_1', name: 'BB', currency: 'USD' }] })[0].value, 'act_1');
  assert.equal(P.options('tiktok_ads', { advertiser_ids: ['70123'] })[0].value, '70123');
  assert.deepEqual(P.options('ga4', {}), []);
  assert.deepEqual(P.options('unknown', { properties: [{ property: 'x' }] }), []);
});
await test('autoPick: exactly one selectable, otherwise ask', () => {
  const two = P.options('ga4', { properties: [{ property: 'properties/1' }, { property: 'properties/2' }] });
  assert.equal(P.autoPick(two), null);
  assert.equal(P.autoPick([]), null);
});
await test('patchFor: account field plus sync on; nothing for a disabled or empty choice', () => {
  assert.deepEqual(P.patchFor('search_console', { value: 'https://x.com/', disabled: false }),
    { search_console_site_url: 'https://x.com/', sync_enabled: true });
  assert.deepEqual(P.patchFor('ga4', { value: '9', disabled: false }), { ga4_property_id: '9', sync_enabled: true });
  assert.equal(P.patchFor('ga4', { value: '9', disabled: true }), null);
  assert.equal(P.patchFor('ga4', { value: '', disabled: false }), null);
  assert.equal(P.patchFor('nope', { value: '9' }), null);
});

const co = 'c1', other = 'c2';
const state = { connection_id: 'r1', company_entity_id: co, platform: 'ga4' };
await test('mayReconnect: the named row, same company, same platform — nothing else', () => {
  assert.equal(lib.mayReconnect(state, { id: 'r1', company_entity_id: co, platform: 'ga4' }), true);
  assert.equal(lib.mayReconnect(state, { id: 'r2', company_entity_id: co, platform: 'ga4' }), false);
  assert.equal(lib.mayReconnect(state, { id: 'r1', company_entity_id: other, platform: 'ga4' }), false);
  assert.equal(lib.mayReconnect(state, { id: 'r1', company_entity_id: co, platform: 'google_ads' }), false);
  assert.equal(lib.mayReconnect(state, null), false);
  assert.equal(lib.mayReconnect({ ...state, connection_id: null }, { id: null, company_entity_id: co, platform: 'ga4' }), false);
});

let callback = read('supabase/functions/google-oauth-callback/index.ts');
if (mutation === 'no-recheck') callback = callback.replace("if (!mayReconnect(stateRow, conn)) return errorRedirect('reconnect_target_missing');", '');
const start = read('supabase/functions/google-oauth-start/index.ts');
const tester = read('supabase/functions/test-ad-platform-connection/index.ts');

await test('callback: re-checks the row, updates it (never inserts), clears the old test, returns the id', () => {
  const branch = callback.slice(callback.indexOf('if (stateRow.connection_id)'), callback.indexOf('const { data: inserted'));
  assert.match(branch, /if \(!mayReconnect\(stateRow, conn\)\) return errorRedirect/, 'the row is re-checked');
  assert.match(branch, /\.update\(\{/);
  assert.doesNotMatch(branch, /\.insert\(/);
  assert.match(branch, /refresh_token: refreshToken/);
  assert.match(branch, /last_test_success: null/);
  assert.match(branch, /\.eq\('company_entity_id', stateRow\.company_entity_id\)/);
  assert.match(branch, /if \(!updated\?\.length\) return errorRedirect/, 'zero rows updated is a failure, not a success');
  assert.match(callback, /\.insert\(\{[\s\S]*?\}\)\.select\('id'\)\.single\(\)/, 'a new connection returns its id');
  assert.match(callback, /&connection_id=\$\{connectionId\}/);
});
await test('start: checks the row against the authorised company/platform before recording it', () => {
  const check = start.indexOf('mayReconnect({ connection_id, company_entity_id, platform }, conn)');
  const auth = start.indexOf('mayConnect(');
  const record = start.indexOf("...(connection_id ? { connection_id } : {})");
  assert.ok(auth > 0 && check > auth && record > check, 'admin check, then row check, then state insert');
});
await test('test function: list mode empties the account field and records no test result', () => {
  assert.match(tester, /const listMode = list_accounts === true;/);
  assert.match(tester, /if \(!listMode\) await service\.from\('ad_platform_connections'\)\.update\(\{\s*last_tested_at/);
  for (const f of ['testGoogleAds(probe', 'testGa4(probe', 'testSearchConsole(probe', 'testMetaAds(probe)', 'testTiktokAds(probe)']) {
    assert.ok(tester.includes(f), f);
  }
});
await test('Integrations: loads the picker, Reconnect on Google rows only, lists with list_accounts', () => {
  const page = read('v2/integrations.html');
  assert.ok(page.indexOf('<script src="ad-account-picker.js"></script>') > 0);
  assert.match(page, /<dialog class="int-picker" id="acct-picker"/);
  assert.match(page, /GOOGLE_PLATFORMS\.includes\(row\.platform\) \? `<button class="int-btn int-btn--warn" onclick="reconnectAdConnection/);
  assert.match(page, /body: JSON\.stringify\(\{ connection_id: id, list_accounts: true \}\)/);
  assert.match(page, /startAdOauth\('google-oauth-start', \{ company_entity_id: _co\.id, platform, connection_id: id \}/);
  assert.match(page, /afterAdOauth\(oauthPlatform, urlParams\.get\('connection_id'\)/);
});

const pglite = join(ROOT, 'scripts/tests/finance-db/node_modules/@electric-sql/pglite/dist/index.js');
if (!existsSync(pglite)) {
  console.log('# skip: database checks (npm ci --prefix scripts/tests/finance-db)');
} else {
  const { PGlite } = await import(pglite);
  const db = new PGlite();
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  await db.exec(read('scripts/tests/seo-db-bootstrap.sql'));
  await db.exec(`
    create table public.ad_platform_oauth_states (nonce text primary key,
      company_entity_id uuid not null references public.entities(id), user_id uuid, platform text not null,
      created_at timestamptz default now(), expires_at timestamptz default now() + interval '10 minutes');
    alter table public.ad_platform_oauth_states enable row level security;`);
  const migration = read('supabase/migrations/20260928160000_ad_platform_oauth_reconnect.sql');
  await db.exec(migration);
  await db.exec(migration);
  await test('migration: applies twice; a state is dropped with its connection; verify reads ok', async () => {
    const c = randomUUID();
    await q('insert into public.entities (id, title) values ($1, $2)', [c, 'Co']);
    const [{ id }] = await q("insert into public.ad_platform_connections (company_entity_id, platform) values ($1, 'ga4') returning id", [c]);
    await q("insert into public.ad_platform_oauth_states (nonce, company_entity_id, platform, connection_id) values ('n', $1, 'ga4', $2)", [c, id]);
    await q('delete from public.ad_platform_connections where id = $1', [id]);
    assert.equal((await q('select count(*)::int n from public.ad_platform_oauth_states'))[0].n, 0);
    const verify = read('supabase/verify_v2_schema.sql');
    const s = verify.indexOf('-- ── Ad-platform reconnect in place (20260928160000)');
    const e = verify.indexOf('as ad_platform_oauth_reconnect;', s);
    assert.ok(s > 0 && e > s, 'verify block present');
    const [row] = await q(verify.slice(s, e + 'as ad_platform_oauth_reconnect'.length));
    assert.equal(row.ad_platform_oauth_reconnect, 'ok');
  });
}

console.log(`\n${n} passed`);
