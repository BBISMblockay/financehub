/* Meta Ads OAuth (Facebook Login for Business): the shared decisions
 * (scripts/lib/meta-oauth-lib.mjs) and both edge function handlers EXECUTED
 * with fake Meta + fake Supabase, plus the state-table migration against
 * Postgres when scripts/tests/finance-db is installed.
 *
 * Proven:
 *   1. Both lib copies are byte-identical, and mayConnect / mayReconnect give
 *      exactly google-oauth-lib's answers on every case.
 *   2. The dialog URL carries config_id and no scope; expiry is null for a
 *      token without expires_in.
 *   3. meta-oauth-start: unconfigured -> 503; no session -> 401; a member who
 *      is not an admin -> 403 and no state; a reconnect naming another
 *      company's row -> 404; an admin gets the dialog URL and a meta_ads state.
 *   4. meta-oauth-callback: a denied login, a missing or expired state, write
 *      nothing; a system user token is stored with no expiry and the year of
 *      history flagged; a short-lived user token is swapped for a long-lived
 *      one and its expiry recorded; a reconnect updates the named row only;
 *      the state is single use.
 *   5. The deploy workflow keeps the callback public and start JWT-verified.
 *   6. (PGlite) the migration admits meta_ads, keeps every earlier platform,
 *      applies twice, and its verify row reads ok.
 *
 * Mutations (each must make this file FAIL):
 *   META_OAUTH_MUTATION=any-admin    (start skips mayConnect)
 *   META_OAUTH_MUTATION=no-recheck   (the callback skips mayReconnect)
 *   META_OAUTH_MUTATION=keep-short   (no long-lived swap for a user token)
 *
 * Run: node scripts/tests/meta-oauth.test.mjs */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const mutation = process.env.META_OAUTH_MUTATION || '';
assert.ok(['', 'any-admin', 'no-recheck', 'keep-short'].includes(mutation), `Unknown mutation ${mutation}`);

const tmp = mkdtempSync(join(tmpdir(), 'meta-oauth-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
function stage(fn, edits = []) {
  const dir = join(tmp, fn);
  execFileSync('mkdir', ['-p', dir]);
  writeFileSync(join(dir, 'meta-oauth-lib.mjs'), read(`supabase/functions/${fn}/meta-oauth-lib.mjs`));
  let src = read(`supabase/functions/${fn}/handler.mjs`);
  for (const [from, to] of edits) {
    assert.ok(src.includes(from), `mutation anchor missing in ${fn}: ${from.slice(0, 60)}`);
    src = src.replace(from, to);
  }
  writeFileSync(join(dir, 'handler.mjs'), src);
  return pathToFileURL(join(dir, 'handler.mjs')).href;
}
const startEdits = mutation === 'any-admin'
  ? [['if (!mayConnect({ profile, profileError, membership, membershipError, companyId })) {', 'if (false) {']] : [];
const cbEdits = [];
if (mutation === 'no-recheck') cbEdits.push(['if (!mayReconnect(stateRow, conn)) return fail', 'if (!conn) return fail']);
if (mutation === 'keep-short') cbEdits.push(['if (expiresAt) {\n', 'if (false) {\n']);
const { createStartHandler } = await import(stage('meta-oauth-start', startEdits));
const { createCallbackHandler } = await import(stage('meta-oauth-callback', cbEdits));
const M = await import(pathToFileURL(join(tmp, 'meta-oauth-start', 'meta-oauth-lib.mjs')).href);
const G = await import(pathToFileURL(join(ROOT, 'supabase/functions/google-oauth-start/google-oauth-lib.mjs')).href);

let n = 0;
const test = async (name, fn) => { await fn(); n += 1; console.log(`ok ${n} - ${name}`); };

function fakeDb(tables = {}) {
  const log = [];
  const db = {
    log, tables, users: {},
    auth: { getUser: async (jwt) => ({ data: { user: db.users[jwt] ?? null } }) },
    from(table) {
      const rows = (tables[table] ||= []);
      const filters = [];
      let op = 'select', payload = null;
      const match = (r) => filters.every(([k, v]) => r[k] === v);
      const run = () => {
        if (op === 'insert') {
          const row = { id: `id-${rows.length + 1}`, ...payload };
          rows.push(row); log.push(['insert', table, row]); return { data: [row], error: null };
        }
        if (op === 'update') {
          const hit = rows.filter(match);
          hit.forEach((r) => Object.assign(r, payload));
          log.push(['update', table, payload, filters.slice()]); return { data: hit.map((r) => ({ id: r.id })), error: null };
        }
        if (op === 'delete') {
          for (let i = rows.length - 1; i >= 0; i -= 1) if (match(rows[i])) rows.splice(i, 1);
          log.push(['delete', table]); return { data: null, error: null };
        }
        return { data: rows.filter(match), error: null };
      };
      const b = {
        select() { return b; },
        insert(p) { op = 'insert'; payload = p; return b; },
        update(p) { op = 'update'; payload = p; return b; },
        delete() { op = 'delete'; return b; },
        eq(k, v) { filters.push([k, v]); return b; },
        maybeSingle() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: null }); },
        single() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: null }); },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return b;
    },
  };
  return db;
}

const CO = 'co-a', OTHER = 'co-b';
const ENV = {
  META_APP_ID: 'app-1', META_APP_SECRET: 'sec-1', META_LOGIN_CONFIG_ID: 'cfg-1',
  META_OAUTH_REDIRECT_URI: 'https://x.supabase.co/functions/v1/meta-oauth-callback', SILO_APP_URL: 'https://get-silo.com',
};
const NOW = 1_800_000_000_000;

// ── 1-2. lib ────────────────────────────────────────────────────────────────
await test('lib copies identical; mayConnect / mayReconnect match google-oauth-lib exactly', () => {
  for (const fn of ['meta-oauth-start', 'meta-oauth-callback']) {
    assert.equal(read(`supabase/functions/${fn}/meta-oauth-lib.mjs`), read('scripts/lib/meta-oauth-lib.mjs'), `${fn} drifted`);
  }
  const profiles = [null, { is_active: false, role: 'owner', active_company_id: CO },
    { is_active: true, role: 'owner', active_company_id: CO }, { is_active: true, role: 'user', active_company_id: CO },
    { is_active: true, role: 'admin', active_company_id: OTHER }];
  const memberships = [null, { role: 'owner_admin' }, { role: 'admin' }, { role: 'member' }];
  for (const profile of profiles) for (const membership of memberships) for (const err of [null, { m: 'x' }]) {
    const args = { profile, profileError: err, membership, membershipError: null, companyId: CO };
    assert.equal(M.mayConnect(args), G.mayConnect(args), JSON.stringify(args));
  }
  const state = { connection_id: 'c1', company_entity_id: CO, platform: 'meta_ads' };
  for (const conn of [null, { id: 'c1', company_entity_id: CO, platform: 'meta_ads' },
    { id: 'c1', company_entity_id: OTHER, platform: 'meta_ads' }, { id: 'c1', company_entity_id: CO, platform: 'google_ads' }]) {
    assert.equal(M.mayReconnect(state, conn), G.mayReconnect(state, conn));
  }
});

await test('the dialog URL carries config_id and no scope; expiry only when Meta gives one', () => {
  const u = new URL(M.authorizeUrl({ appId: 'a', configId: 'c', redirectUri: 'https://r', state: 's' }));
  assert.equal(u.origin + u.pathname, `https://www.facebook.com/${M.META_GRAPH_VERSION}/dialog/oauth`);
  assert.equal(u.searchParams.get('config_id'), 'c');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.has('scope'), false, 'the configuration carries the permissions');
  assert.equal(M.tokenExpiry({ access_token: 't' }, NOW), null);
  assert.equal(M.tokenExpiry({ access_token: 't', expires_in: 3600 }, NOW), new Date(NOW + 3_600_000).toISOString());
  assert.equal(M.META_GRAPH_VERSION, /META_API_VERSION = '([^']+)'/.exec(read('scripts/lib/ad-platforms-sync-core.mjs'))[1],
    'the OAuth Graph version matches the sync');
  assert.equal(M.callbackError('<x>'), 'token_exchange_failed');
});

// ── 3. start ────────────────────────────────────────────────────────────────
function startDb() {
  const db = fakeDb({
    profiles: [{ id: 'u-admin', role: 'user', active_company_id: CO, is_active: true },
      { id: 'u-member', role: 'user', active_company_id: CO, is_active: true }],
    entity_memberships: [{ entity_id: CO, user_id: 'u-admin', role: 'admin' }, { entity_id: CO, user_id: 'u-member', role: 'member' }],
    ad_platform_connections: [{ id: 'c-other', company_entity_id: OTHER, platform: 'meta_ads' }],
  });
  db.users = { 'jwt-admin': { id: 'u-admin' }, 'jwt-member': { id: 'u-member' } };
  return db;
}
const post = (body, jwt) => new Request('https://x/functions/v1/meta-oauth-start', {
  method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: JSON.stringify(body),
});

await test('start: unconfigured, unsigned and non-admin callers record nothing', async () => {
  const db = startDb();
  assert.equal((await createStartHandler({ env: {}, admin: db })(post({ company_entity_id: CO }, 'jwt-admin'))).status, 503);
  const h = createStartHandler({ env: ENV, admin: db });
  assert.equal((await h(post({ company_entity_id: CO }, 'nope'))).status, 401);
  assert.equal((await h(post({ company_entity_id: CO }, 'jwt-member'))).status, 403);
  assert.equal((await h(post({ company_entity_id: CO, connection_id: 'c-other' }, 'jwt-admin'))).status, 404,
    'a reconnect cannot name another company\'s row');
  assert.equal((db.tables.ad_platform_oauth_states || []).length, 0);
});

await test('start: an admin gets the dialog URL and a meta_ads state', async () => {
  const db = startDb();
  const res = await createStartHandler({ env: ENV, admin: db })(post({ company_entity_id: CO }, 'jwt-admin'));
  assert.equal(res.status, 200);
  const u = new URL((await res.json()).url);
  const st = db.tables.ad_platform_oauth_states[0];
  assert.equal(st.platform, 'meta_ads');
  assert.equal(st.company_entity_id, CO);
  assert.equal(st.user_id, 'u-admin');
  assert.equal(u.searchParams.get('state'), st.nonce);
  assert.equal(u.searchParams.get('redirect_uri'), ENV.META_OAUTH_REDIRECT_URI);
});

// ── 4. callback ─────────────────────────────────────────────────────────────
const future = new Date(NOW + 300_000).toISOString();
function cbDb(state = {}) {
  return fakeDb({
    ad_platform_oauth_states: [{ nonce: 'n1', platform: 'meta_ads', company_entity_id: CO, user_id: 'u-admin', expires_at: future, ...state }],
    ad_platform_connections: [
      { id: 'c-mine', company_entity_id: CO, platform: 'meta_ads', meta: { history_backfilled_at: 'x' }, access_token: 'old' },
      { id: 'c-theirs', company_entity_id: OTHER, platform: 'meta_ads', access_token: 'theirs' },
      { id: 'c-google', company_entity_id: CO, platform: 'google_ads', access_token: 'google' },
    ],
  });
}
function fakeMeta({ expiresIn = null, longLived = true } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/oauth/access_token') && u.searchParams.get('grant_type') === 'fb_exchange_token') {
      return new Response(JSON.stringify(longLived ? { access_token: 'long-token', expires_in: 5_184_000 } : {}), { status: longLived ? 200 : 400 });
    }
    if (u.pathname.endsWith('/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'code-token', ...(expiresIn ? { expires_in: expiresIn } : {}) }));
    }
    if (u.pathname.endsWith('/me')) return new Response(JSON.stringify({ id: 'su1', client_business_id: 'biz-9' }));
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchImpl };
}
const cb = (q) => new Request(`https://x/functions/v1/meta-oauth-callback?${new URLSearchParams(q)}`);

await test('callback: a denied login and a missing or expired state write nothing', async () => {
  const db = cbDb({ expires_at: new Date(NOW - 1).toISOString() });
  const { fetchImpl, calls } = fakeMeta();
  const h = createCallbackHandler({ env: ENV, admin: db, fetchImpl, now: () => NOW });
  assert.match((await h(cb({ error: 'access_denied', state: 'n1' }))).headers.get('Location'), /oauth_error=access_denied/);
  assert.match((await h(cb({ code: 'c' }))).headers.get('Location'), /oauth_error=missing_params/);
  assert.match((await h(cb({ code: 'c', state: 'n1' }))).headers.get('Location'), /oauth_error=invalid_or_expired_state/);
  assert.equal(calls.length, 0);
  assert.equal(db.log.filter((e) => e[0] !== 'delete').length, 0);
});

await test('callback: a system user token is stored with no expiry and the year of history flagged', async () => {
  const db = cbDb();
  const { fetchImpl, calls } = fakeMeta();
  const h = createCallbackHandler({ env: ENV, admin: db, fetchImpl, now: () => NOW });
  const loc = (await h(cb({ code: 'the-code', state: 'n1' }))).headers.get('Location');
  assert.match(loc, /^https:\/\/get-silo\.com\/v2\/integrations\.html\?oauth_connected=1&platform=meta_ads&connection_id=id-4$/);
  const ex = new URL(calls[0]);
  assert.equal(ex.searchParams.get('redirect_uri'), ENV.META_OAUTH_REDIRECT_URI, 'the exchange repeats the redirect URI');
  assert.equal(ex.searchParams.get('code'), 'the-code');
  const row = db.tables.ad_platform_connections.find((r) => r.id === 'id-4');
  assert.equal(row.access_token, 'code-token');
  assert.equal(row.token_expires_at, null);
  assert.equal(row.sync_enabled, false);
  assert.equal(row.created_by, 'u-admin');
  assert.equal(row.meta.history_backfill_pending, true);
  assert.equal(row.meta.oauth.token_type, 'system_user');
  assert.equal(row.meta.oauth.client_business_id, 'biz-9');
  assert.equal(db.tables.ad_platform_oauth_states.length, 0, 'single use');
  assert.match((await h(cb({ code: 'the-code', state: 'n1' }))).headers.get('Location'), /invalid_or_expired_state/, 'a replay finds nothing');
});

await test('callback: a short-lived user token is swapped for a long-lived one, expiry recorded', async () => {
  const db = cbDb();
  const { fetchImpl } = fakeMeta({ expiresIn: 3600 });
  await createCallbackHandler({ env: ENV, admin: db, fetchImpl, now: () => NOW })(cb({ code: 'c', state: 'n1' }));
  const row = db.tables.ad_platform_connections.find((r) => r.id === 'id-4');
  assert.equal(row.access_token, 'long-token');
  assert.equal(row.token_expires_at, new Date(NOW + 5_184_000_000).toISOString());
  assert.equal(row.meta.oauth.token_type, 'user', 'the row says it is not a system user token');
});

await test('callback: a reconnect updates only the named row of its own company', async () => {
  const db = cbDb({ connection_id: 'c-mine' });
  const { fetchImpl } = fakeMeta();
  const loc = (await createCallbackHandler({ env: ENV, admin: db, fetchImpl, now: () => NOW })(cb({ code: 'c', state: 'n1' }))).headers.get('Location');
  assert.match(loc, /connection_id=c-mine&reconnected=1$/);
  const mine = db.tables.ad_platform_connections.find((r) => r.id === 'c-mine');
  assert.equal(mine.access_token, 'code-token');
  assert.equal(mine.meta.history_backfilled_at, 'x', 'existing meta keys survive');
  assert.equal(db.tables.ad_platform_connections.length, 3, 'no new row');

  const db2 = cbDb({ connection_id: 'c-theirs' });
  const loc2 = (await createCallbackHandler({ env: ENV, admin: db2, fetchImpl, now: () => NOW })(cb({ code: 'c', state: 'n1' }))).headers.get('Location');
  assert.match(loc2, /oauth_error=reconnect_target_missing/);
  assert.equal(db2.tables.ad_platform_connections.find((r) => r.id === 'c-theirs').access_token, 'theirs');

  // Same company, wrong platform: only mayReconnect stands between a Meta
  // grant and a Google row (the update's company filter would let it through).
  const db3 = cbDb({ connection_id: 'c-google' });
  const loc3 = (await createCallbackHandler({ env: ENV, admin: db3, fetchImpl, now: () => NOW })(cb({ code: 'c', state: 'n1' }))).headers.get('Location');
  assert.match(loc3, /oauth_error=reconnect_target_missing/);
  assert.equal(db3.tables.ad_platform_connections.find((r) => r.id === 'c-google').access_token, 'google');
});

// ── 5. deploy ───────────────────────────────────────────────────────────────
await test('deploy: the callback is public on every path; start keeps JWT', () => {
  const list = /NO_JWT_FUNCTIONS="([^"]*)"/.exec(read('.github/workflows/deploy-edge-function.yml'))[1].split(/\s+/);
  assert.ok(list.includes('meta-oauth-callback'), 'Meta presents no Supabase JWT on its redirect');
  assert.ok(!list.includes('meta-oauth-start'));
});

// ── 6. PGlite ───────────────────────────────────────────────────────────────
const pglite = join(ROOT, 'scripts/tests/finance-db/node_modules/@electric-sql/pglite/dist/index.js');
if (existsSync(pglite)) {
  const { PGlite } = await import(pathToFileURL(pglite).href);
  const db = new PGlite();
  await db.exec(`create table public.ad_platform_oauth_states (nonce text primary key, platform text,
    constraint ad_platform_oauth_states_platform_check check (platform in ('google_ads','ga4','tiktok_ads','search_console')));`);
  const migration = read('supabase/migrations/20261007130000_meta_oauth_states.sql');
  await db.exec(migration);
  await db.exec(migration);
  await test('(db) the migration admits meta_ads, keeps every earlier platform, and verifies ok', async () => {
    for (const p of ['google_ads', 'ga4', 'tiktok_ads', 'search_console', 'meta_ads']) {
      await db.query('insert into public.ad_platform_oauth_states (nonce, platform) values ($1, $1)', [p]);
    }
    await assert.rejects(db.query("insert into public.ad_platform_oauth_states values ('x', 'myspace')"), /check/);
    const verify = read('supabase/verify_v2_schema.sql');
    const start = verify.indexOf('-- ── Meta Ads OAuth state (20261007130000)');
    const end = verify.indexOf('as meta_oauth_states;', start);
    const [row] = (await db.query(verify.slice(start, end + 'as meta_oauth_states'.length))).rows;
    assert.equal(row.meta_oauth_states, 'ok');
  });
} else console.log('# skip (db) step: npm ci --prefix scripts/tests/finance-db');

console.log(`\n${n} passed`);
