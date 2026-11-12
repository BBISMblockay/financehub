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
 *      and asks for the list with list_accounts; after OAuth it never falls
 *      back to another row when the callback named one not in this workspace.
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
  // Named advertisers win over the bare ids: both arrive together when the
  // tester could reach /oauth2/advertiser/get/, and nineteen digits name
  // nothing to the person choosing.
  const named = P.options('tiktok_ads', {
    advertiser_ids: ['70123', '70124'],
    advertisers: [{ advertiser_id: '70123', advertiser_name: 'Acme Supply' }, { advertiser_id: '70124' }],
  });
  assert.equal(named.length, 2);
  assert.equal(named[0].label, 'Acme Supply');
  assert.equal(named[0].sub, '70123');
  assert.equal(named[1].label, '70124', 'an advertiser with no name still falls back to its id');
  assert.equal(P.patchFor('tiktok_ads', named[0]).tiktok_advertiser_id, '70123');
  assert.equal(P.patchFor('tiktok_ads', named[0]).sync_enabled, true);
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
await test('Integrations: loads the picker, offers Reconnect where there is an authorization to renew, lists with list_accounts', () => {
  const page = read('v2/integrations.html');
  assert.ok(page.indexOf('<script src="ad-account-picker.js"></script>') > 0);
  assert.match(page, /<dialog class="int-picker" id="acct-picker"/);
  assert.match(page, /GOOGLE_PLATFORMS\.includes\(row\.platform\) \? `<button class="int-btn int-btn--warn" onclick="reconnectAdConnection/);
  // Meta earns Reconnect from the oauth stamp the callback writes, never from
  // the platform: a pasted System User token row has no authorization to
  // renew and must keep Replace token as its only way back.
  assert.match(page, /row\.platform === 'meta_ads' && row\.meta\?\.oauth\?\.connected_via \? `<button class="int-btn int-btn--warn" onclick="reconnectAdConnection/);
  assert.match(page, /body: JSON\.stringify\(\{ connection_id: id, list_accounts: true \}\)/);
  assert.match(page, /afterAdOauth\(oauthPlatform, urlParams\.get\('connection_id'\)/);
});

await test('Integrations: Reconnect goes to the platform\'s own start function, and Meta sends no platform', () => {
  const page = read('v2/integrations.html');
  const map = page.match(/const OAUTH_START_FN = \{[\s\S]*?\n    \};/)[0];
  const fn = page.match(/function reconnectAdConnection\(id, platform, btn\) \{[\s\S]*?\n    \}/)[0];
  const src = `${map}\n${fn}`;
  const calls = [];
  const ctx = {
    _co: { id: 'co-1' },
    setStatus: (m) => calls.push(['status', m]),
    startAdOauth: (fn, body) => calls.push([fn, J(body)]),
  };
  vm.runInNewContext(`${src}; reconnectAdConnection(id, platform, null);`, { ...ctx, id: 'r1', platform: 'meta_ads' });
  assert.deepEqual(calls.pop(), ['meta-oauth-start', { company_entity_id: 'co-1', connection_id: 'r1' }]);
  vm.runInNewContext(`${src}; reconnectAdConnection(id, platform, null);`, { ...ctx, id: 'r2', platform: 'ga4' });
  assert.deepEqual(calls.pop(), ['google-oauth-start', { company_entity_id: 'co-1', platform: 'ga4', connection_id: 'r2' }]);
  vm.runInNewContext(`${src}; reconnectAdConnection(id, platform, null);`, { ...ctx, id: 'r3', platform: 'tiktok_ads' });
  assert.deepEqual(calls.pop(), ['tiktok-oauth-start', { company_entity_id: 'co-1', platform: 'tiktok_ads', connection_id: 'r3' }]);
  // An unknown platform says so rather than sending the row to Google's flow,
  // which would refuse it with a message about a Google account.
  vm.runInNewContext(`${src}; reconnectAdConnection(id, platform, null);`, { ...ctx, id: 'r4', platform: 'shopify' });
  assert.equal(calls.pop()[0], 'status');
});

await test('Meta Pages: the Page and its Instagram account are one choice', () => {
  const o = P.options('meta_pages', { pages: [
    { page_id: '105', page_name: 'Acme', instagram_business_account_id: '178', instagram_username: 'acme' },
    { page_id: '106', page_name: 'Acme Outlet', instagram_business_account_id: null, instagram_username: null },
  ] });
  assert.equal(o.length, 2);
  assert.equal(o[0].value, '105');
  assert.equal(o[0].label, 'Acme');
  assert.match(o[0].sub, /@acme/);
  assert.equal(o[1].disabled, false, 'a Page with no Instagram account is still worth syncing');
  assert.match(o[1].sub, /no linked Instagram account/);
  assert.deepEqual(P.options('meta_pages', {}), []);
  // Both ids move together, and choosing a Page with no Instagram account
  // BLANKS the previous one -- otherwise the nightly sync reads one
  // business's Instagram against another's Page.
  assert.deepEqual(P.patchFor('meta_pages', o[0]),
    { facebook_page_id: '105', instagram_business_account_id: '178' });
  assert.deepEqual(P.patchFor('meta_pages', o[1]),
    { facebook_page_id: '106', instagram_business_account_id: null });
  // A Page choice is not a decision to sync ads.
  assert.ok(!('sync_enabled' in P.patchFor('meta_pages', o[0])));
});

await test('Integrations: the Page picker saves both ids and never kicks the ad backfill', () => {
  const page = read('v2/integrations.html');
  assert.match(page, /SiloAdPicker\.options\('meta_pages', data\)/);
  const src = page.match(/async function choosePage\(row, option\) \{[\s\S]*?\n    \}/)[0];
  assert.ok(!/firstConnectBootstrap|syncAdConnection/.test(src), 'choosing a Page starts no sync');
  // Asked once, straight after the ad account is chosen through OAuth.
  const chose = page.match(/async function chooseAccount\(row, option, afterConnect = false\) \{[\s\S]*?\n    \}/)[0];
  assert.match(chose, /afterConnect && row\.platform === 'meta_ads' && !row\.facebook_page_id/);
});

await test('Integrations: after OAuth, a returned connection id is never guessed past', async () => {
  // The tab switched workspace mid-OAuth: the id the callback returned is not
  // in this workspace's rows. Falling back to "newest row of the platform"
  // tested or opened the picker on a DIFFERENT connection (review, 2026-10-07).
  const page = read('v2/integrations.html');
  const src = page.match(/async function afterAdOauth\(platform, connectionId, reconnected\) \{[\s\S]*?\n    \}/)[0];
  const run = async (rows, platform, id, reconnected = false) => {
    const calls = [];
    const ctx = {
      AD_PLATFORM_LABELS: { ga4: 'GA4', tiktok_ads: 'TikTok Ads' },
      AD_ACCOUNT_FIELD: { ga4: 'ga4_property_id', tiktok_ads: 'advertiser_id' },
      _adRows: rows,
      loadAdConnections: async () => {},
      setStatus: (msg, type) => calls.push(['status', type, msg]),
      testAdConnection: (rid) => calls.push(['test', rid]),
      openAccountPicker: (rid) => calls.push(['picker', rid]),
    };
    vm.runInNewContext(`${src}; result = afterAdOauth(${JSON.stringify(platform)}, ${JSON.stringify(id)}, ${reconnected});`, ctx);
    await ctx.result;
    return calls;
  };
  const here = [{ id: 'other-ga4', platform: 'ga4', ga4_property_id: '123' }];
  // id from another workspace: no test, no picker, a clear message
  let calls = await run(here, 'ga4', 'elsewhere');
  assert.deepEqual(calls.map((c) => c[0]), ['status']);
  assert.equal(calls[0][1], 'neg');
  assert.match(calls[0][2], /different workspace/);
  calls = await run(here, 'ga4', 'elsewhere', true);
  assert.deepEqual(calls.map((c) => c[0]), ['status'], 'a reconnect is not guessed past either');
  // id found here: as before
  calls = await run([{ id: 'new', platform: 'ga4' }, ...here], 'ga4', 'new');
  assert.deepEqual(calls, [['picker', 'new']]);
  // no id (a callback deployed before it returned one): nothing is guessed,
  // even when this workspace has rows of that platform
  calls = await run([{ id: 't1', platform: 'tiktok_ads' }, { id: 't2', platform: 'tiktok_ads', advertiser_id: '9' }], 'tiktok_ads', null);
  assert.deepEqual(calls.map((c) => c[0]), ['status']);
  assert.equal(calls[0][1], 'pos');
});
await test('TikTok callback returns the row it inserted, so Integrations need not guess', () => {
  const cb = read('supabase/functions/tiktok-oauth-callback/index.ts');
  assert.match(cb, /\}\)\.select\('id'\)\.single\(\);/);
  assert.match(cb, /oauth_connected=1&platform=tiktok_ads&connection_id=\$\{encodeURIComponent\(inserted\.id\)\}/);
  for (const f of ['google-oauth-callback', 'meta-oauth-callback']) {
    const p = `supabase/functions/${f}/index.ts`;
    if (existsSync(join(ROOT, p))) assert.ok(/connection_id/.test(read(p)) || /connection_id/.test(read(`supabase/functions/${f}/handler.mjs`)), `${f} returns the id`);
  }
});

await test('Integrations: edge calls send the CURRENT session token, never the page-load snapshot', async () => {
  // A tab open past the token's hour sent the expired load-time token, so
  // Test read "Unauthorized" before Meta was asked (Bat Nutz, 2026-10-05).
  const page = read('v2/integrations.html');
  assert.doesNotMatch(page, /Bearer \$\{_session\.access_token\}/);
  const calls = page.match(/Bearer \$\{await currentAccessToken\(\)\}/g) || [];
  assert.ok(calls.length >= 4, `expected Test, Sync now, picker and OAuth start to use currentAccessToken, found ${calls.length}`);
  const src = page.match(/async function currentAccessToken\(\) \{[\s\S]*?\n    \}/)[0];
  const ctx = { _session: { access_token: 'expired-at-load' }, db: { auth: {
    getSession: async () => ({ data: { session: { access_token: 'refreshed' } } }) } } };
  vm.runInNewContext(`${src}; result = currentAccessToken();`, ctx);
  assert.equal(await ctx.result, 'refreshed');
  assert.equal(ctx._session.access_token, 'refreshed');
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
