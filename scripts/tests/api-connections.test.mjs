/* The connected-applications screens.
 *
 * Two things here are worth a test and the rest is markup:
 *
 *   1. planFromAuthorizationDetails() and what the consent page does with it.
 *      Supabase AUTO-APPROVES a repeat authorization and returns no
 *      authorization_id, and its documented example follows the redirect at
 *      once. SILO keeps its own grant row, so following that redirect without
 *      writing the row makes an idle, expired or disconnected connection
 *      impossible to restore -- the person reconnects, sees success, and
 *      nothing works. The page's own source is asserted here, not just the
 *      helper, because the helper being right does not help if the page
 *      ignores it.
 *
 *   2. grantStatus() agreeing with silo_api_grant() in the database. A screen
 *      that says "Active" about a connection the database refuses is worse
 *      than no screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Arrays built inside the vm context carry THAT realm's Array prototype, so
   deepEqual (which is deepStrictEqual under node:assert/strict) refuses them
   against a literal here. Copy into this realm before comparing. */
const here = (a) => Array.from(a);

const ctx = vm.createContext({ window: {}, console });
vm.runInContext(readFileSync('v2/api-connections.js', 'utf8'), ctx);
const K = ctx.window.SiloApiConnections;

const CONSENT = readFileSync('v2/api-consent.html', 'utf8');
const APPS = readFileSync('v2/settings-connected-apps.html', 'utf8');
const IDLE_MIG = readFileSync(
  'supabase/migrations/20261028070000_developer_api_idle_disconnect.sql', 'utf8');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-29T12:00:00Z');
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString();
const ahead = (days) => new Date(NOW.getTime() + days * DAY).toISOString();

// ── 1. The repeat-authorization branch ────────────────────────────────────

test('a fresh authorization asks the person', () => {
  const plan = K.planFromAuthorizationDetails({
    authorization_id: 'auth-1', redirect_uri: 'https://app.example/cb',
    client: { id: 'cli-1', name: 'Acme Dashboards' }, scope: 'openid email',
  });
  assert.equal(plan.kind, 'ask');
  assert.equal(plan.clientName, 'Acme Dashboards');
  assert.equal(plan.clientId, 'cli-1');
});

test('an auto-approved repeat is NOT an ask, and still names the client', () => {
  const plan = K.planFromAuthorizationDetails({
    redirect_url: 'https://app.example/cb?code=xyz',
    client: { id: 'cli-1', name: 'Acme Dashboards' },
  });
  assert.equal(plan.kind, 'already_consented');
  assert.equal(plan.redirectUrl, 'https://app.example/cb?code=xyz');
  // Without the client id there is nothing to write the grant against, which
  // is the whole point of this branch.
  assert.equal(plan.clientId, 'cli-1');
});

test('a repeat with nowhere to send the person is an error, not a silent pass', () => {
  assert.equal(K.planFromAuthorizationDetails({ client: { id: 'c' } }).kind, 'error');
  assert.equal(K.planFromAuthorizationDetails(null).kind, 'error');
});

test('the consent page writes the grant on the already-consented path', () => {
  const i = CONSENT.indexOf("PLAN.kind === 'already_consented'");
  assert.ok(i > 0, 'the page handles the already-consented plan');

  const branch = CONSENT.slice(i, i + 1200);
  const write = branch.indexOf('writeGrant(');
  const redirect = branch.indexOf('window.location.href = PLAN.redirectUrl');
  assert.ok(write > 0, 'the repeat path calls writeGrant()');
  assert.ok(redirect > 0, 'the repeat path redirects');
  assert.ok(write < redirect,
    'writeGrant() must come BEFORE the redirect, or the grant is never written');
});

test('a failed grant write on the repeat path stops rather than redirecting', () => {
  const i = CONSENT.indexOf("PLAN.kind === 'already_consented'");
  const branch = CONSENT.slice(i, i + 1200);
  assert.match(branch, /catch[\s\S]{0,200}?fail\(/,
    'a refused restore is reported, not followed by a redirect to an app that thinks it is connected');
});

test('writeGrant calls silo_api_consent with SILO scopes, not the OAuth scope string', () => {
  assert.match(CONSENT, /rpc\('silo_api_consent',\s*\{[\s\S]{0,120}?K\.SILO_SCOPES/);
  assert.deepEqual(here(K.SILO_SCOPES), ['reports:read']);
});

test('the fresh path writes the grant before asking Supabase to approve', () => {
  const write = CONSENT.indexOf('await writeGrant(PLAN.clientId)');
  const approve = CONSENT.indexOf("decide(PLAN.authorizationId, 'approve')");
  assert.ok(write > 0 && approve > 0);
  assert.ok(write < approve,
    'ours first: the other order hands the app a live token backed by no grant');
});

// ── 2. Status, against the database's own predicate ───────────────────────

test('the browser idle window matches the migration', () => {
  assert.match(IDLE_MIG, /interval\s+'30 days'/,
    'the migration still defines a 30-day window');
  assert.equal(K.IDLE_DAYS, 30);
});

test('status mirrors silo_api_grant(), in its order of refusal', () => {
  const live = { consented_at: ago(1), last_used_at: ago(1), expires_at: ahead(89) };
  assert.equal(K.grantStatus(live, NOW), 'active');

  assert.equal(K.grantStatus({ ...live, revoked_at: ago(2) }, NOW), 'disconnected');
  assert.equal(K.grantStatus({ ...live, expires_at: ago(1) }, NOW), 'expired');

  // Never used, consented 31 days ago: coalesce(last_used_at, consented_at).
  assert.equal(K.grantStatus(
    { consented_at: ago(31), last_used_at: null, expires_at: ahead(59) }, NOW), 'idle');
  // Used yesterday but consented long ago is ACTIVE -- the coalesce takes
  // last_used_at first, and reading consented_at alone would kill every
  // healthy long-lived connection.
  assert.equal(K.grantStatus(
    { consented_at: ago(80), last_used_at: ago(1), expires_at: ahead(10) }, NOW), 'active');
});

test('a grant that is both expired and idle reads as expired', () => {
  // Both are true of an old abandoned connection, and "Expired" is the truer
  // answer: it ended on a date, and reconnecting is the only way back.
  // Calling it "Idle" would tell the person it comes back when used, which an
  // expired grant does not.
  assert.equal(K.grantStatus(
    { consented_at: ago(100), last_used_at: ago(40), expires_at: ago(5) }, NOW), 'expired');
});

test('a grant that is both revoked and expired reads as disconnected', () => {
  // Order is not cosmetic: the first match is the one that explains it.
  assert.equal(K.grantStatus(
    { consented_at: ago(100), expires_at: ago(10), revoked_at: ago(20) }, NOW), 'disconnected');
});

test('exactly 30 days unused is already idle, matching the strict > in SQL', () => {
  // SQL: coalesce(last_used_at, consented_at) > now() - idle_window.
  // At exactly the boundary the predicate is false, so the grant is unusable.
  assert.equal(K.grantStatus(
    { consented_at: ago(30), expires_at: ahead(60) }, NOW), 'idle');
  assert.equal(K.grantStatus(
    { consented_at: ago(29.9), expires_at: ahead(60) }, NOW), 'active');
});

test('idle is explained as recoverable, because it is', () => {
  const copy = K.STATUS_COPY.idle.detail;
  assert.match(copy, /nothing was deleted/i);
  assert.match(copy, /connect again/i);
});

// ── 3. Shapes that differ between the two Supabase endpoints ──────────────

test('scope arrives singular-and-spaced from authorize, plural-and-array from grants', () => {
  assert.deepEqual(here(K.scopeList({ scope: 'openid email profile' })), ['openid', 'email', 'profile']);
  assert.deepEqual(here(K.scopeList({ scopes: ['reports:read'] })), ['reports:read']);
  assert.deepEqual(here(K.scopeList({})), []);
});

test('the client is read from either the nested or the flat shape', () => {
  assert.equal(K.clientNameOf({ client: { name: 'A' } }), 'A');
  assert.equal(K.clientNameOf({ client_name: 'B' }), 'B');
  assert.equal(K.clientIdOf({ client: { id: 'x' } }), 'x');
  assert.equal(K.clientIdOf({ client_id: 'y' }), 'y');
});

test('a nameless client shows its id rather than nothing', () => {
  assert.equal(K.displayName('', 'abcdef123456'), 'Application abcdef12');
  assert.equal(K.displayName('Acme', 'abcdef123456'), 'Acme');
  assert.equal(K.displayName('', ''), 'An application');
});

// ── 4. Disconnect tells the truth about what it did ───────────────────────

test('disconnect reports the two halves separately', () => {
  // Only the approving person's own browser can end the Supabase session --
  // there is no admin-side revokeGrant -- so an owner disconnecting someone
  // else's connection must not claim it signed the application out.
  assert.match(APPS, /revokeGrant\(/);
  assert.match(APPS, /signOutDone\s*\?/,
    'the message branches on whether the sign-out actually happened');
  assert.match(APPS, /sign-in lapses on its own/);
});

test('disconnect goes through silo_api_revoke, never a table write', () => {
  assert.match(APPS, /rpc\('silo_api_revoke',\s*\{\s*p_grant_id/);
  assert.doesNotMatch(APPS, /from\('silo_api_grants'\)[\s\S]{0,80}?\.(update|insert|delete|upsert)\(/,
    'nothing writes the grants table from a browser');
});

test('the owner section is gated on owner_admin of the active company', () => {
  assert.match(APPS, /_isOwner = mem\?\.role === 'owner_admin'/,
    "matches silo_api_revoke()'s own test, not is_admin_user()");
});

// ── 5. Page wiring ────────────────────────────────────────────────────────

test('the consent page preserves authorization_id across login', () => {
  assert.match(CONSENT, /login\.html\?next='\s*\+\s*encodeURIComponent\(location\.pathname \+ location\.search\)/);
});

test('the consent page makes the company a choice, not an inheritance', () => {
  assert.match(CONSENT, /rpc\('set_active_company'/);
  assert.match(CONSENT, /coSelect/);
});

test('both pages load the shared module and neither hardcodes credentials', () => {
  for (const [name, src] of [['api-consent', CONSENT], ['settings-connected-apps', APPS]]) {
    assert.match(src, /src="api-connections\.js"/, `${name} loads the shared module`);
    assert.match(src, /cfg\.SUPABASE_ANON_KEY/, `${name} reads config`);
    assert.doesNotMatch(src, /eyJ[A-Za-z0-9_-]{20,}/, `${name} has no baked-in key`);
    assert.doesNotMatch(src, /\balert\(/, `${name} uses bcn-status, not alert()`);
  }
});

test('Connected apps is a Workspace Settings tab with an icon', () => {
  const nav = readFileSync('v2/nav-config.js', 'utf8');
  const strip = readFileSync('v2/workspace-settings.js', 'utf8');
  assert.match(nav, /\['settings\/connected-apps','Connected apps','settings-connected-apps\.html'\]/);
  assert.match(strip, /'settings\/connected-apps':\s*'</,
    'a tab with no icon falls back to a plain page mark and reads as unfinished');
});
