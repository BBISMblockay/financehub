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
// Connected apps merged into Connect AI on 2026-10-30; the old URL is a stub.
const APPS = readFileSync('v2/settings-connect-ai.html', 'utf8');
const STUB = readFileSync('v2/settings-connected-apps.html', 'utf8');
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

test('the repeat path asks before it writes anything', () => {
  // The dangerous version of this page wrote the grant and redirected from
  // inside this branch, with nothing on screen. silo_api_consent() binds the
  // connection to whatever company is active right now and revokes the
  // previous grant, so that silently moved an application from company A to
  // company B for anyone who had switched companies since.
  const i = CONSENT.indexOf("REPEAT = PLAN.kind === 'already_consented'");
  assert.ok(i > 0, 'the page recognises the auto-approved repeat');
  const j = CONSENT.indexOf('renderAsk()', i);
  assert.ok(j > i, 'it falls through to the same pane a fresh request gets');
  const between = CONSENT.slice(i, j);
  assert.ok(!/writeGrant\(/.test(between),
    'nothing is granted between recognising the repeat and showing the pane');
  assert.ok(!/window\.location\.href/.test(between),
    'and the person is not sent back to the application before deciding');
});

test('the repeat path resolves the client it was never told', () => {
  // Supabase's auto-approve response does not name the client, so the grant
  // had nothing to write against -- measured in production 2026-10-29, where
  // the restore failed with "did not name an application". The lookup is
  // scoped in the database to the caller's own authorizations.
  assert.match(CONSENT, /rpc\('silo_api_client_for_authorization',\s*\{\s*\n?\s*p_authorization_id: AUTH_ID/);
  assert.match(CONSENT, /CLIENT_ID = await resolveClientId\(\)/,
    'both paths resolve through one function before the pane is drawn');
  assert.match(CONSENT, /if \(PLAN\.clientId\) return PLAN\.clientId;/,
    'a client already named costs no round trip');
  assert.match(CONSENT, /if \(!CLIENT_ID\) \{ fail\(/,
    'an unresolvable application is an honest refusal, not a blank pane');
});

test('the only grant write is behind the Approve button', () => {
  const calls = CONSENT.match(/writeGrant\(/g) || [];
  assert.equal(calls.length, 2, 'the definition and exactly one call site');
  const approve = CONSENT.indexOf('async function onApprove');
  const call = CONSENT.indexOf('await writeGrant(CLIENT_ID)');
  const deny = CONSENT.indexOf('async function onDeny');
  assert.ok(approve > 0 && call > approve && call < deny,
    'the write happens inside onApprove and nowhere else');
});

test('the company is chosen before the grant is written, on every path', () => {
  const approve = CONSENT.indexOf('async function onApprove');
  const body = CONSENT.slice(approve, CONSENT.indexOf('async function onDeny'));
  const chosen = body.indexOf("el('coSelect').value");
  const set = body.indexOf('await setCompany(chosen)');
  const write = body.indexOf('await writeGrant(CLIENT_ID)');
  assert.ok(chosen > 0 && set > chosen && write > set,
    'silo_api_consent() reads the ACTIVE company, so it is set first');
});

test('a reconnect starts on the company the application already had', () => {
  // Not the active company: someone who switched companies since would
  // otherwise be one unchanged click away from repointing the application.
  assert.match(CONSENT, /\.eq\('client_id', CLIENT_ID\)/,
    'the prior grant is looked up by the resolved client');
  assert.match(CONSENT, /PRIOR_COMPANY && COMPANIES\.some/,
    'and only if the person is still a member of that company');
  const prefer = CONSENT.indexOf('const prefer =');
  assert.ok(prefer > 0 && CONSENT.indexOf('PRIOR_COMPANY', prefer) < CONSENT.indexOf('active?.id', prefer),
    'the prior company wins over the active one');
});

test('approving a repeat follows the redirect Supabase already issued', () => {
  // There is no authorization left to approve; calling the consent endpoint
  // again would fail AFTER the grant had been written.
  const body = CONSENT.slice(CONSENT.indexOf('async function onApprove'),
    CONSENT.indexOf('async function onDeny'));
  assert.match(body, /let url = PLAN\.redirectUrl;/);
  assert.match(body, /if \(!REPEAT\) \{[\s\S]{0,200}?decide\(PLAN\.authorizationId, 'approve'\)/);
});

test('denying a repeat gives the application nothing', () => {
  const body = CONSENT.slice(CONSENT.indexOf('async function onDeny'));
  const guard = body.indexOf('if (REPEAT)');
  const ret = body.indexOf('return;', guard);
  const redirect = body.indexOf('window.location.href');
  assert.ok(guard > 0 && ret > guard, 'the repeat branch returns');
  assert.ok(ret < redirect,
    'it returns BEFORE any redirect: no code reaches the application, and with no grant row a token reads nothing');
});

test('writeGrant calls silo_api_consent with SILO scopes, not the OAuth scope string', () => {
  assert.match(CONSENT, /rpc\('silo_api_consent',\s*\{[\s\S]{0,120}?K\.SILO_SCOPES/);
  assert.deepEqual(here(K.SILO_SCOPES), ['reports:read', 'data:read']);
});

test('the fresh path writes the grant before asking Supabase to approve', () => {
  const write = CONSENT.indexOf('await writeGrant(CLIENT_ID)');
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

test('the app name lookup uses the method the SDK actually ships', () => {
  // Supabase's guide documents getUserGrants(); the SDK ships listGrants().
  // Coding only the documented name shipped a lookup that silently did
  // nothing, so every row read "Application 0307bcaf" (2026-10-29, first live
  // connection). Both names plus the HTTP endpoint they wrap.
  assert.match(APPS, /o\.listGrants \|\| o\.getUserGrants/);
  // Anchored to the fetch, not just the path: the disconnect comment below
  // names the same endpoint, so a bare path match passes on prose alone.
  assert.match(APPS, /fetch\(SUPABASE_URL[^\n]*'\/auth\/v1\/user\/oauth\/grants'/,
    'falls back to the endpoint when neither method exists');
});

test('a name lookup failure never breaks the list', () => {
  const i = APPS.indexOf('async function loadNames');
  const fn = APPS.slice(i, APPS.indexOf('async function grantsOverHttp'));
  assert.match(fn, /catch \(_\)/, 'the lookup swallows its own failure');
  assert.doesNotMatch(fn, /setStatus\(/, 'a missing name is cosmetic, not an error banner');
});

test('the company column reads a title the query actually selects', () => {
  // An earlier version rendered g.company_title, which no query selected, so
  // the column was always "—" (2026-10-29).
  assert.doesNotMatch(APPS, /g\.company_title/,
    'nothing renders a field no query selects');
  assert.match(APPS, /_cos\[g\.company_entity_id\]/);
  assert.match(APPS, /from\('entities'\)\s*\.select\('id, title'\)\.in\('id', ids\)/,
    'the titles are fetched for the company ids actually present');
});

test('the owner section is gated on owner_admin of the active company', () => {
  assert.match(APPS, /_isOwner = mem\?\.role === 'owner_admin'/,
    "matches silo_api_revoke()'s own test, not is_admin_user()");
});

// ── 4b. Removing an app, as the person reads it ───────────────────────────

test('removing takes a confirm, and only the confirm revokes', () => {
  // A one-click Remove sits beside other cards; the wrong application being
  // disconnected is a silent, annoying failure to recover from.
  const ask = APPS.indexOf('function askToRemove');
  const rpc = APPS.indexOf("rpc('silo_api_revoke'");
  assert.ok(ask > 0, 'there is a confirm step');
  assert.match(APPS.slice(ask, APPS.indexOf('function wireCard')), /data-confirm/);
  const wire = APPS.slice(APPS.indexOf('function wireCard'), APPS.indexOf('/* A removed application'));
  assert.match(wire, /data-ask/, 'the resting state is Remove, not Confirm');
  assert.match(wire, /addEventListener\('click', \(\) => askToRemove\(card, g\)\)/,
    'the first click asks');
  assert.doesNotMatch(wire, /revoke\(card/, 'the first click never revokes');
  assert.ok(rpc > ask, 'the revoke lives past the confirm');
});

test('a removed application leaves the page, and never comes back on a reload', () => {
  assert.match(APPS, /function dropCard/, 'the card is taken off the page');
  assert.match(APPS, /const live = \(rows\) => \(rows \|\| \[\]\)\.filter\(\(g\) => !g\.revoked_at\)/,
    'the lists carry live connections only');
  assert.match(APPS, /paint\('gridMine', 'mineSub', live\(mine\)/);
});

test('the grant row itself is still never written from the browser', () => {
  // dropCard() is a DOM removal. The database record stays; silo_api_revoke()
  // is what stops the access.
  const fn = APPS.slice(APPS.indexOf('function dropCard'), APPS.indexOf('async function load'));
  assert.doesNotMatch(fn, /\.delete\(|\.update\(/);
});

test('both pages draw an application mark, and fall back to its initial', () => {
  const CONNECT = readFileSync('v2/settings-connect-ai.html', 'utf8');
  const MARKS = readFileSync('v2/app-marks.js', 'utf8');
  assert.match(APPS, /src="app-marks\.js"/, 'the page loads the marks');
  assert.match(APPS, /SiloAppMarks\.forName\(/, 'a connected app gets its own mark');
  assert.match(APPS, /SiloAppMarks\.svg\(/, 'so does each app you can add');
  // A logo beside the WRONG application is worse than no logo.
  assert.match(MARKS, /function letterBadge/);
  assert.match(MARKS, /for \(const \[re, key\] of NAME_RULES\) if \(re\.test\(s\)\) return key;\n\s*return null;/,
    'an unrecognised name resolves to no mark, not to a default logo');
  // Drawn here, so the settings page needs no third-party request.
  assert.doesNotMatch(MARKS, /https?:\/\//);
});

test('"Claude Code" is not matched by the bare Claude rule', () => {
  const ctx2 = vm.createContext({ window: {} });
  vm.runInContext(readFileSync('v2/app-marks.js', 'utf8'), ctx2);
  const M = ctx2.window.SiloAppMarks;
  assert.equal(M.keyForName('Claude Code'), 'claude-code');
  assert.equal(M.keyForName('Claude'), 'claude');
  assert.equal(M.keyForName('VS Code'), 'vscode');
  assert.equal(M.keyForName('Grok'), 'grok');
  assert.equal(M.keyForName('Power BI'), null, 'an app with no mark gets none');
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
  for (const [name, src] of [['api-consent', CONSENT], ['settings-connect-ai', APPS]]) {
    assert.match(src, /src="api-connections\.js"/, `${name} loads the shared module`);
    assert.match(src, /cfg\.SUPABASE_ANON_KEY/, `${name} reads config`);
    assert.doesNotMatch(src, /eyJ[A-Za-z0-9_-]{20,}/, `${name} has no baked-in key`);
    assert.doesNotMatch(src, /\balert\(/, `${name} uses bcn-status, not alert()`);
  }
});

test('Connect AI is the one Workspace Settings tab, with an icon', () => {
  const nav = readFileSync('v2/nav-config.js', 'utf8');
  const strip = readFileSync('v2/workspace-settings.js', 'utf8');
  assert.match(nav, /\['settings\/connect-ai','Connect AI','settings-connect-ai\.html'\]/);
  assert.doesNotMatch(nav, /settings\/connected-apps/,
    'the two tabs merged; a second one would be the same subject twice');
  assert.match(strip, /'settings\/connect-ai':\s*'</,
    'a tab with no icon falls back to a plain page mark and reads as unfinished');
});

test('the old Connected apps URL still lands somewhere, carrying no logic', () => {
  assert.match(STUB, /location\.replace\('\/v2\/settings-connect-ai\.html'/);
  assert.doesNotMatch(STUB, /createClient|silo_api_/, 'a stub redirect, not a second copy');
});
