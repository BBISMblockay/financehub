// windsor-broker (supabase/functions/windsor-broker): the edge half of the
// Windsor tenant broker. One Windsor owner key serves every SILO company, so
// what this suite pins is attribution: an account is filed under a company
// only when Windsor reports it under THAT company's own link token, a preview
// returns only that company's account's rows, and the owner key never comes
// back to a browser.
//
// Mutations (CI runs each and requires a failure):
//   WINDSOR_MUTATION=trustfilter  reconcile accepts rows without checking their token
//   WINDSOR_MUTATION=notoken      mint_link hands out a link it found no token in
//   WINDSOR_MUTATION=rowfilter    preview returns Windsor's rows unfiltered
//   WINDSOR_MUTATION=bodycompany  the company comes from the request body
//   WINDSOR_MUTATION=conflict     reconcile files another company's account
//   WINDSOR_MUTATION=redact       errors echo Windsor's text unredacted
//   WINDSOR_MUTATION=connector    preview lets the caller choose the endpoint
//   WINDSOR_MUTATION=linkwindow   reconcile only ever checks one batch of links
//   WINDSOR_MUTATION=grouptoken   a grouped account takes the request's token, not its group's
//   WINDSOR_MUTATION=mapcompany   field_catalog reads every company's mapping
//
// Run: node scripts/tests/windsor-broker.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeSupabase } from './lib/fake-supabase.mjs';

const MUT = process.env.WINDSOR_MUTATION || '';
const fnDir = new URL('../../supabase/functions/windsor-broker/', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, fnDir), 'utf8');

// Load the function, mutated if asked, from a temp copy so the repo is never edited.
async function loadHandler() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windsor-'));
  let handler = read('handler.mjs');
  let lib = read('windsor-lib.mjs');
  const sub = (src, from, to) => { assert.ok(src.includes(from), `mutation ${MUT}: pattern missing`); return src.replace(from, to); };
  if (MUT === 'trustfilter') lib = sub(lib, "if (!rowToken) { rejected.token_missing += 1; continue; }\n    if (rowToken !== token) { rejected.token_mismatch += 1; continue; }", '');
  if (MUT === 'notoken') lib = sub(lib, "if (!token || token.length < 8 || token.length > 512) return { ok: false };", "if (!token) token = 'none-found';");
  if (MUT === 'rowfilter') handler = sub(handler, 'if (foreign || unattributed) return json(', 'if (false) return json(');
  if (MUT === 'bodycompany') handler = sub(handler, 'const companyId = profile?.active_company_id ?? null;', 'const companyId = body?.company_entity_id ?? profile?.active_company_id ?? null;');
  if (MUT === 'conflict') lib = sub(lib, 'else conflicts.push({ ds_id: a.ds_id, account_id: a.account_id });', 'else inserts.push(a);');
  if (MUT === 'connector') handler = sub(handler, 'const conn = connectorForSource(own.row.ds_id);', "const conn = connectorForSource(body?.connector || own.row.ds_id);")
    .replace("&& connectorForSource(String(body.connector).trim().toLowerCase()).value !== connectorForSource(own.row.ds_id).value", '&& false');
  if (MUT === 'linkwindow') handler = sub(handler, 'const offset = Number.isInteger(body?.offset) && body.offset >= 0 ? body.offset : 0;', 'const offset = 0;');
  if (MUT === 'grouptoken') lib = sub(lib, 'for (const r of flattenLinkedAccounts(rows)) {', 'for (const r of flattenLinkedAccounts(rows).map((x) => ({ ...x, access_token: token }))) {');
  if (MUT === 'mapcompany') handler = sub(handler, ".select('measure, field_id').eq('company_entity_id', companyId).eq('ds_id', own.row.ds_id);", ".select('measure, field_id').eq('ds_id', own.row.ds_id);");
  if (MUT === 'redact') lib = sub(lib, "if (key) s = s.split(key).join('***');\n  s = s.replace(/(api_key=)[^&\\s\"']+/gi, '$1***');", '');
  fs.writeFileSync(path.join(dir, 'handler.mjs'), handler);
  fs.writeFileSync(path.join(dir, 'windsor-lib.mjs'), lib);
  fs.copyFileSync(new URL('google-oauth-lib.mjs', fnDir), path.join(dir, 'google-oauth-lib.mjs'));
  return (await import(path.join(dir, 'handler.mjs'))).createWindsorHandler;
}
const createWindsorHandler = await loadHandler();

const KEY = 'owner-key-SECRET-9f8e7d';
const A = 'company-A';
const B = 'company-B';
const USER_A = 'user-a';
const pass = () => ({ ok: true });

function world() {
  const fake = createFakeSupabase();
  const db = fake.from.bind(fake);
  const seed = (t, row) => { fake.tables.has(t) || fake.tables.set(t, []); fake.tables.get(t).push(row); };
  seed('profiles', { id: USER_A, role: 'admin', active_company_id: A, is_active: true });
  seed('entity_memberships', { entity_id: A, user_id: USER_A, role: 'admin' });
  seed('windsor_links', { id: 'link-a', company_entity_id: A, access_token: 'tok-A-0000001', created_at: '2026-11-01' });
  seed('windsor_links', { id: 'link-b', company_entity_id: B, access_token: 'tok-B-0000001', created_at: '2026-11-01' });
  seed('windsor_linked_accounts', { id: 'acc-b', company_entity_id: B, link_id: 'link-b', ds_id: 'klaviyo', account_id: 'kb-1' });
  const admin = { from: db, auth: { getUser: async (jwt) => ({ data: jwt === 'jwt-a' ? { user: { id: USER_A } } : null }) } };
  return { fake, admin };
}

// A fake Windsor. `routes` maps a path to a function(url) -> { status, body }.
function fakeWindsor(routes) {
  const log = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    log.push({ url: u, method: init?.method || 'GET' });
    const route = routes[`${init?.method || 'GET'} ${u.host}${u.pathname}`];
    if (!route) return { ok: false, status: 404, text: async () => 'not found' };
    const { status = 200, body } = route(u);
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  return { fetchImpl, log };
}

function handlerFor(w, fw, env = { WINDSOR_API_KEY: KEY }) {
  return createWindsorHandler({ env, admin: w.admin, fetchImpl: fw.fetchImpl, checkMfa: async () => pass(), checkIntegration: pass });
}
const call = async (h, body, jwt = 'jwt-a') => {
  const res = await h(new Request('https://fn.test/windsor-broker', {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
};

const LINKED = 'GET onboard.windsor.ai/api/team/co-user-linked-accounts/';
const MINT = 'GET onboard.windsor.ai/api/team/generate-co-user-url/';

test('unauthenticated and unwired gates are refused', async () => {
  const w = world(); const fw = fakeWindsor({});
  assert.equal((await call(handlerFor(w, fw), { action: 'status' }, 'nope')).status, 401);
  const unwired = createWindsorHandler({ env: { WINDSOR_API_KEY: KEY }, admin: w.admin, fetchImpl: fw.fetchImpl });
  const r = await call(unwired, { action: 'status' });
  assert.equal(r.status, 503, 'an unwired gate refuses, never passes');
});

test('the company is the caller\'s active company, never the request\'s', async () => {
  const w = world();
  const fw = fakeWindsor({ [LINKED]: () => ({ body: [] }) });
  const r = await call(handlerFor(w, fw), { action: 'reconcile', company_entity_id: B });
  assert.equal(r.status, 200);
  const tokens = fw.log.map((l) => l.url.searchParams.get('access_token'));
  assert.deepEqual(tokens, ['tok-A-0000001'], 'only A\'s link is reconciled, whatever the body says');
});

test('mint_link records the token for the caller\'s company before handing the link out', async () => {
  const w = world();
  const fw = fakeWindsor({ [MINT]: (u) => ({ body: { url: `https://onboard.windsor.ai/co-user?access_token=tok-new-123456&src=${u.searchParams.get('allowed_sources')}` } }) });
  const r = await call(handlerFor(w, fw), { action: 'mint_link', source: 'klaviyo' });
  assert.equal(r.status, 200);
  assert.match(r.body.url, /tok-new-123456/);
  assert.equal(fw.log[0].url.searchParams.get('allowed_sources'), 'klaviyo');
  const stored = w.fake.rows('windsor_links').find((l) => l.access_token === 'tok-new-123456');
  assert.equal(stored?.company_entity_id, A);
  assert.equal(stored?.allowed_source, 'klaviyo');
});

test('mint_link refuses a link it cannot read a token from, and records nothing', async () => {
  const w = world();
  const fw = fakeWindsor({ [MINT]: () => ({ body: { url: 'https://onboard.windsor.ai/co-user/abc', id: 7 } }) });
  const before = w.fake.rows('windsor_links').length;
  const r = await call(handlerFor(w, fw), { action: 'mint_link' });
  assert.equal(r.status, 502);
  assert.equal(r.body.url, undefined, 'no link is handed out');
  assert.match(r.body.shape, /object \{url, id\}/, 'the shape is reported so the parser can be fixed');
  assert.equal(w.fake.rows('windsor_links').length, before);
});

test('mint_link rejects a source that is not a data source id', async () => {
  const w = world(); const fw = fakeWindsor({});
  assert.equal((await call(handlerFor(w, fw), { action: 'mint_link', source: 'klaviyo&api_key=x' })).status, 400);
  assert.equal(fw.log.length, 0);
});

test('reconcile files only rows carrying this company\'s own token', async () => {
  const w = world();
  // Windsor ignores the filter and returns the whole team, plus a legacy row.
  const fw = fakeWindsor({ [LINKED]: () => ({ body: { data: [
    { datasource: 'klaviyo', account_id: 'ka-1', access_token: 'tok-A-0000001', account_name: 'A Store' },
    { datasource: 'klaviyo', account_id: 'kb-9', access_token: 'tok-B-0000001' },
    { datasource: 'tiktok', account_id: 'legacy-1', co_user_member_name: 'someone' },
    { datasource: 'Bad Source!', account_id: 'x', access_token: 'tok-A-0000001' },
  ] } }) });
  const r = await call(handlerFor(w, fw), { action: 'reconcile' });
  assert.equal(r.status, 200);
  assert.equal(r.body.added, 1);
  assert.deepEqual(r.body.rejected, { token_mismatch: 1, token_missing: 1, malformed: 1, deactivated: 0 });
  const mine = w.fake.rows('windsor_linked_accounts').filter((x) => x.company_entity_id === A);
  assert.deepEqual(mine.map((x) => [x.ds_id, x.account_id, x.link_id]), [['klaviyo', 'ka-1', 'link-a']]);
});

test('reconcile reads the grouped shape Windsor returns live, token taken from each group', async () => {
  const w = world();
  // The live shape (2026-11-02): one entry per link. Windsor here also
  // ignores the access_token filter and returns company B's group.
  const fw = fakeWindsor({ [LINKED]: () => ({ body: [
    { link: { access_token: 'tok-A-0000001', issued_at: '2026-11-02T22:18:03', revoked_at: '2026-11-02T22:19:49' }, accounts: [
      { datasource: 'klaviyo', account_id: 'ka-old', account_name: 'Old', is_deactivated: true },
      { datasource: 'tiktok', account_id: '7000000000000000001', account_name: 'A TikTok', is_deactivated: false },
    ] },
    { link: { access_token: 'tok-B-0000001' }, accounts: [
      { datasource: 'klaviyo', account_id: 'kb-2', account_name: 'B Store', is_deactivated: false },
    ] },
  ] }) });
  const r = await call(handlerFor(w, fw), { action: 'reconcile' });
  assert.equal(r.status, 200);
  assert.equal(r.body.added, 1);
  assert.deepEqual(r.body.rejected, { token_mismatch: 1, token_missing: 0, malformed: 0, deactivated: 1 });
  const mine = w.fake.rows('windsor_linked_accounts').filter((x) => x.company_entity_id === A);
  assert.deepEqual(mine.map((x) => [x.ds_id, x.account_id, x.account_name]), [['tiktok', '7000000000000000001', 'A TikTok']]);
  assert.ok(!w.fake.rows('windsor_linked_accounts').some((x) => x.account_id === 'kb-2'), 'B\'s group is not filed under A');
});

test('reconcile never takes an account another company already holds', async () => {
  const w = world();
  const fw = fakeWindsor({ [LINKED]: () => ({ body: [{ datasource: 'klaviyo', account_id: 'kb-1', access_token: 'tok-A-0000001' }] }) });
  const r = await call(handlerFor(w, fw), { action: 'reconcile' });
  assert.deepEqual(r.body.conflicts, [{ ds_id: 'klaviyo', account_id: 'kb-1' }]);
  const kb1 = w.fake.rows('windsor_linked_accounts').filter((x) => x.account_id === 'kb-1');
  assert.deepEqual(kb1.map((x) => x.company_entity_id), [B], 'B keeps it; A gets no copy');
});

test('reconcile refreshes an account already filed under the same company', async () => {
  const w = world();
  w.fake.tables.get('windsor_linked_accounts').push({ id: 'acc-a', company_entity_id: A, link_id: 'link-a', ds_id: 'klaviyo', account_id: 'ka-1', last_seen_at: 'old' });
  const fw = fakeWindsor({ [LINKED]: () => ({ body: [{ datasource: 'klaviyo', account_id: 'ka-1', access_token: 'tok-A-0000001' }] }) });
  const r = await call(handlerFor(w, fw), { action: 'reconcile' });
  assert.equal(r.body.refreshed, 1);
  assert.equal(r.body.added, 0);
  assert.notEqual(w.fake.rows('windsor_linked_accounts').find((x) => x.id === 'acc-a').last_seen_at, 'old');
});

test('preview fails closed on mixed identities', async () => {
  const w = world();
  w.fake.tables.get('windsor_linked_accounts').push({ id: 'acc-a', company_entity_id: A, link_id: 'link-a', ds_id: 'klaviyo', account_id: 'ka-1' });
  const fw = fakeWindsor({ 'GET connectors.windsor.ai/klaviyo': () => ({ body: { data: [
    { account_id: 'ka-1', date: '2026-11-01', clicks: 3 },
    { account_id: 'kb-1', date: '2026-11-01', clicks: 99 },
    { date: '2026-11-01', clicks: 7 },
  ] } }) });
  const r = await call(handlerFor(w, fw), { action: 'preview', linked_account_id: 'acc-a', fields: 'date,clicks' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'identity_unverified');
  assert.equal(r.body.rows, undefined);
  assert.ok(!JSON.stringify(r.body).includes('kb-1'));
  const u = fw.log[0].url;
  assert.equal(u.searchParams.get('select_accounts'), 'ka-1');
  assert.match(u.searchParams.get('fields'), /^account_id,/, 'account_id is always requested');
});

test('a TikTok preview includes inactive campaigns; other connectors send no options', async () => {
  const w = world();
  w.fake.tables.get('windsor_linked_accounts').push(
    { id: 'acc-t', company_entity_id: A, link_id: 'link-a', ds_id: 'tiktok', account_id: '7000000000000000001' },
    { id: 'acc-k', company_entity_id: A, link_id: 'link-a', ds_id: 'klaviyo', account_id: 'ka-1' });
  const fw = fakeWindsor({
    'GET connectors.windsor.ai/tiktok': () => ({ body: { data: [{ account_id: '7000000000000000001', date: '2026-11-01', spend: 0 }] } }),
    'GET connectors.windsor.ai/klaviyo': () => ({ body: { data: [] } }),
  });
  const h = handlerFor(w, fw);
  const r = await call(h, { action: 'preview', linked_account_id: 'acc-t', fields: 'date,spend' });
  assert.equal(r.body.rows.length, 1);
  assert.deepEqual(JSON.parse(fw.log[0].url.searchParams.get('options')), { tiktok: { include_inactive: 'true' } });
  assert.equal(fw.log[0].url.searchParams.get('select_accounts'), '7000000000000000001', 'still one account only');
  await call(h, { action: 'preview', linked_account_id: 'acc-k', fields: 'date' });
  assert.equal(fw.log[1].url.searchParams.get('options'), null);
});

test('preview cannot reach another company\'s account, or the all connector', async () => {
  const w = world(); const fw = fakeWindsor({});
  assert.equal((await call(handlerFor(w, fw), { action: 'preview', linked_account_id: 'acc-b', fields: 'date' })).status, 404);
  w.fake.tables.get('windsor_linked_accounts').push({ id: 'acc-a', company_entity_id: A, link_id: 'link-a', ds_id: 'klaviyo', account_id: 'ka-1' });
  assert.equal((await call(handlerFor(w, fw), { action: 'preview', linked_account_id: 'acc-a', connector: 'all', fields: 'date' })).status, 400);
  assert.equal(fw.log.length, 0, 'Windsor was never asked');
});

test('field_catalog lists one own account\'s numeric fields and the sync\'s pick, with this company\'s mapping only', async () => {
  const w = world();
  w.fake.tables.get('windsor_linked_accounts').push({ id: 'acc-p', company_entity_id: A, link_id: 'link-a', ds_id: 'pinterest', account_id: 'p-1' });
  w.fake.tables.set('windsor_field_mappings', [
    { company_entity_id: A, ds_id: 'pinterest', measure: 'conversions', field_id: 'saves' },
    { company_entity_id: B, ds_id: 'pinterest', measure: 'spend', field_id: 'saves' },
  ]);
  const fw = fakeWindsor({ 'GET connectors.windsor.ai/pinterest/fields': (u) => {
    assert.equal(u.searchParams.get('api_key'), null, 'the public list is read without the owner key');
    return { body: [
      { id: 'date', type: 'DATE' }, { id: 'account_id', type: 'TEXT' }, { id: 'campaign_id', type: 'TEXT' },
      { id: 'spend', type: 'NUMERIC', name: 'Spend' }, { id: 'impressions', type: 'NUMERIC' }, { id: 'clicks', type: 'NUMERIC' },
      { id: 'total_conversions', type: 'NUMERIC' }, { id: 'saves', type: 'NUMERIC', table: 'Engagement' },
    ] };
  } });
  const h = handlerFor(w, fw);
  const r = await call(h, { action: 'field_catalog', linked_account_id: 'acc-p' });
  assert.equal(r.status, 200);
  assert.equal(r.body.kind, 'ad');
  assert.match(r.body.destination, /pinterest_ads/);
  const by = Object.fromEntries(r.body.measures.map((m) => [m.measure, m]));
  assert.equal(by.conversions.auto, 'total_conversions');
  assert.equal(by.conversions.chosen, 'saves', 'this company\'s mapping');
  assert.equal(by.spend.chosen, 'spend', 'another company\'s mapping never applies');
  assert.deepEqual(r.body.numeric_fields.map((f) => f.id), ['spend', 'impressions', 'clicks', 'total_conversions', 'saves']);
  assert.equal((await call(h, { action: 'field_catalog', linked_account_id: 'acc-b' })).status, 404, 'not B\'s account');
  assert.ok(!r.text.includes(KEY));
});

test('unlink removes only an own account, and keeps SILO\'s row if Windsor refuses', async () => {
  const w = world();
  w.fake.tables.get('windsor_linked_accounts').push({ id: 'acc-a', company_entity_id: A, link_id: 'link-a', ds_id: 'klaviyo', account_id: 'ka-1' });
  const refusing = fakeWindsor({ 'DELETE onboard.windsor.ai/api/team/co-user-linked-accounts/': () => ({ status: 403, body: { error: 'Permission denied' } }) });
  assert.equal((await call(handlerFor(w, refusing), { action: 'unlink', linked_account_id: 'acc-a' })).status, 502);
  assert.ok(w.fake.rows('windsor_linked_accounts').some((x) => x.id === 'acc-a'));
  const ok = fakeWindsor({ 'DELETE onboard.windsor.ai/api/team/co-user-linked-accounts/': () => ({ body: { result: 'unlinked' } }) });
  assert.equal((await call(handlerFor(w, ok), { action: 'unlink', linked_account_id: 'acc-b' })).status, 404, 'not B\'s');
  assert.equal((await call(handlerFor(w, ok), { action: 'unlink', linked_account_id: 'acc-a' })).status, 200);
  assert.equal(ok.log[0].url.searchParams.get('account_id'), 'ka-1');
  assert.ok(!w.fake.rows('windsor_linked_accounts').some((x) => x.id === 'acc-a'));
  assert.ok(w.fake.rows('windsor_linked_accounts').some((x) => x.id === 'acc-b'), 'B untouched');
});

test('the owner key never reaches the browser', async () => {
  const w = world();
  const fw = fakeWindsor({ [MINT]: (u) => ({ status: 400, body: `bad request for ${u.toString()} key=${KEY}` }) });
  const r = await call(handlerFor(w, fw), { action: 'mint_link' });
  assert.equal(r.status, 502);
  assert.ok(!r.text.includes(KEY), 'the key is redacted from Windsor\'s echo');
});

test('without the key, everything but status refuses', async () => {
  const w = world(); const fw = fakeWindsor({});
  const h = handlerFor(w, fw, {});
  assert.deepEqual((await call(h, { action: 'status' })).body, { configured: false });
  assert.equal((await call(h, { action: 'reconcile' })).status, 503);
});

test('preview reads the account\'s own source: the same account id on another source is another company\'s', async () => {
  const w = world();
  // A owns (klaviyo, 123); B owns (tiktok, 123). Identical ids, different accounts.
  w.fake.tables.get('windsor_linked_accounts').push(
    { id: 'acc-a', company_entity_id: A, link_id: 'link-a', ds_id: 'klaviyo', account_id: '123' },
    { id: 'acc-b2', company_entity_id: B, link_id: 'link-b', ds_id: 'tiktok', account_id: '123' },
  );
  const fw = fakeWindsor({
    'GET connectors.windsor.ai/tiktok': () => ({ body: [{ account_id: '123', spend: 500 }] }),
    'GET connectors.windsor.ai/klaviyo': () => ({ body: [{ account_id: '123', clicks: 4 }] }),
  });
  const h = handlerFor(w, fw);
  const r = await call(h, { action: 'preview', linked_account_id: 'acc-a', connector: 'tiktok', fields: 'spend' });
  assert.equal(r.status, 400, 'a connector other than the account\'s own source is refused');
  assert.equal(fw.log.length, 0, 'refused before Windsor is asked');
  const ok = await call(h, { action: 'preview', linked_account_id: 'acc-a', fields: 'clicks' });
  assert.equal(ok.status, 200);
  assert.equal(fw.log[0].url.pathname, '/klaviyo', 'the endpoint is the stored source');
  assert.deepEqual(ok.body.rows, [{ account_id: '123', clicks: 4 }]);
});

test('reconcile reaches every link, oldest included, in bounded batches', async () => {
  const w = world();
  const links = w.fake.tables.get('windsor_links');
  links.length = 0;
  for (let i = 0; i < 26; i += 1) {
    links.push({ id: `link-${String(i).padStart(2, '0')}`, company_entity_id: A,
      access_token: `tok-${String(i).padStart(2, '0')}-000000`, created_at: `2026-10-${String(i + 1).padStart(2, '0')}` });
  }
  // The OLDEST link is the one a client finally connected through.
  const fw = fakeWindsor({ [LINKED]: (u) => ({ body: u.searchParams.get('access_token') === 'tok-00-000000'
    ? [{ datasource: 'klaviyo', account_id: 'old-1', access_token: 'tok-00-000000' }] : [] }) });
  const h = handlerFor(w, fw);
  const seen = new Set();
  let offset = 0; let added = 0; let guard = 0;
  for (;;) {
    const r = await call(h, { action: 'reconcile', offset });
    assert.equal(r.status, 200);
    assert.ok(r.body.links <= 25, 'each call is bounded');
    added += r.body.added;
    if (r.body.next_offset === null) break;
    offset = r.body.next_offset;
    assert.ok(++guard < 5);
  }
  for (const l of fw.log) seen.add(l.url.searchParams.get('access_token'));
  assert.equal(seen.size, 26, 'every link was checked exactly across the batches');
  assert.equal(fw.log.length, 26, 'and none twice');
  assert.equal(added, 1);
  assert.ok(w.fake.rows('windsor_linked_accounts').some((x) => x.account_id === 'old-1' && x.company_entity_id === A));
});

test('vendored copies match their originals byte for byte', () => {
  const root = new URL('../../', import.meta.url);
  const r = (p) => fs.readFileSync(new URL(p, root), 'utf8');
  assert.equal(read('mfa-gate.mjs'), r('scripts/lib/mfa-gate.mjs'));
  assert.equal(read('integration-gate.mjs'), r('scripts/lib/integration-gate.mjs'));
  assert.equal(read('google-oauth-lib.mjs'), r('supabase/functions/google-oauth-start/google-oauth-lib.mjs'));
});


test('connector catalog uses public metadata and excludes multiplexed/unsafe IDs', async () => {
  const w = world();
  const fw = fakeWindsor({ 'GET connectors.windsor.ai/list_connectors': () => ({ body:
    ['youtube', 'klaviyo', 'future_source', 'all', '../secret', 'youtube'] }) });
  const r = await call(handlerFor(w, fw), { action: 'connector_catalog' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.connectors.map((x) => x.name), ['Future Source', 'Klaviyo', 'YouTube']);
  assert.equal(fw.log[0].url.searchParams.get('api_key'), null);
});

test('field discovery returns readable dimensions and source-specific defaults for a new connector', async () => {
  const w = world();
  w.fake.tables.get('windsor_linked_accounts').push({ id: 'acc-a', company_entity_id: A, ds_id: 'new_source', account_id: 'ka-1' });
  const fw = fakeWindsor({ 'GET connectors.windsor.ai/new_source/fields': () => ({ body: [
    { id: 'account_id', type: 'TEXT' }, { id: 'date', type: 'DATE' },
    { id: 'watch_minutes', name: 'Minutes watched', type: 'NUMERIC', table: 'daily' },
    { id: 'video_id', type: 'TEXT' }, { id: 'other_report', type: 'NUMERIC', table: 'video' },
  ] }) });
  const r = await call(handlerFor(w, fw), { action: 'field_catalog', linked_account_id: 'acc-a' });
  assert.equal(r.status, 200);
  assert.equal(r.body.fields.find((f) => f.id === 'video_id').name, 'Video Id');
  assert.deepEqual(r.body.default_fields, ['account_id', 'date', 'watch_minutes']);
  assert.equal(fw.log[0].url.searchParams.get('api_key'), null);
  const denied = await call(handlerFor(w, fw), { action: 'field_catalog', linked_account_id: 'acc-b' });
  assert.equal(denied.status, 404);
});
