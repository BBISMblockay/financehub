// The two Affiliate Studio edge functions, executed in Node with a fake
// Supabase and a fake Resend:
//   supabase/functions/affiliate-portal/handler.mjs  (public, token-authorized)
//   supabase/functions/affiliate-invite/handler.mjs  (staff, JWT)
//
// Properties:
//   * the raw link token never reaches the database -- only its SHA-256;
//   * an unknown or expired link is a 404 before any write;
//   * the portal response exposes no internal ids;
//   * acceptance survives a missing mail key, and the mail goes to the address
//     ON FILE, never one in the request;
//   * renewal answers identically whether or not the link was renewable;
//   * the staff function asks the database, AS THE CALLER, before any
//     service-role call, and takes the company from the caller, never the body;
//   * a signup link for a prospect is RETURNED, never emailed;
//   * a draft payout is never announced;
//   * the mail module ships byte-identical in both functions.
//
// Mutations (CI runs each and requires a failure):
//   AFFILIATE_EDGE_MUTATION=rawtoken      the portal hands the raw token to the database
//   AFFILIATE_EDGE_MUTATION=bodyaddress   renewal mails an address taken from the request
//   AFFILIATE_EDGE_MUTATION=gateorder     the staff function reads with the service role before the gate
//   AFFILIATE_EDGE_MUTATION=bodycompany   the staff function takes the company from the body
//   AFFILIATE_EDGE_MUTATION=prospectmail  a signup link is emailed to the prospect
//   AFFILIATE_EDGE_MUTATION=draftnews     a draft payout is announced
//   AFFILIATE_EDGE_MUTATION=byprospectonly a follow-up to a known email tries a second record
//   AFFILIATE_EDGE_MUTATION=anylogo       the portal hands the page any stored logo address
//   AFFILIATE_EDGE_MUTATION=nocodelink    an affiliate link does not carry the affiliate's code
//   AFFILIATE_EDGE_MUTATION=offsitelink   an affiliate link may open a page on another site
//   AFFILIATE_EDGE_MUTATION=oldplatform   an acceptance of an older platform terms version is recorded
//   AFFILIATE_EDGE_MUTATION=anyhostlink   a link to another site is sent through the store with the code
//   AFFILIATE_EDGE_MUTATION=pendingcode   a code still waiting for Shopify is shown to the affiliate
//   AFFILIATE_EDGE_MUTATION=plainmaillink the codes email sends plain links that do not apply the code
//   AFFILIATE_EDGE_MUTATION=linkquery     a store page's own query (variant, search) is dropped from the link
//   AFFILIATE_EDGE_MUTATION=utcday        the codes email picks today's code by the UTC date
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MUT = process.env.AFFILIATE_EDGE_MUTATION || '';
const ROOT = new URL('../../', import.meta.url);

async function load(fn, file) {
  const dir = new URL(`supabase/functions/${fn}/`, ROOT);
  const muts = {
    rawtoken: ['affiliate-portal', "const { data: rows, error: rErr } = await service.rpc('affiliate_portal_resolve', { p_token_hash: hash });", "const { data: rows, error: rErr } = await service.rpc('affiliate_portal_resolve', { p_token_hash: token });"],
    bodyaddress: ['affiliate-portal', "kind: 'link_renewal', to: subject.contact_email,", "kind: 'link_renewal', to: body.email || subject.contact_email,"],
    byprospectonly: ['affiliate-invite', "        if (!aff) {\n          const like", "        if (false) {\n          const like"],
    gateorder: ['affiliate-invite', "    const caller = userClientFor(authHeader);\n", "    await service.from('affiliates').select('id');\n    const caller = userClientFor(authHeader);\n"],
    bodycompany: ['affiliate-invite', "    const { data: company, error: gateErr } = await caller.rpc('affiliate_managed_company');", "    let { data: company, error: gateErr } = await caller.rpc('affiliate_managed_company');\n    const peek = await req.clone().json().catch(() => ({})); if (peek.company_entity_id) company = peek.company_entity_id;"],
    prospectmail: ['affiliate-invite', "        return reply({ affiliate_id: aff.id, signup_url: link.url, expires_at: link.expires_at, emailed: false });", "        await sendAffiliateMail({ service, resendKey, fetchImpl }, { companyId: company, programId: p.program_id, affiliateId: aff.id, kind: 'portal_link', to: email, subject: 'Join', html: link.url, text: link.url });\n        return reply({ affiliate_id: aff.id, signup_url: link.url, expires_at: link.expires_at, emailed: false });"],
    nocodelink: ['affiliate-portal', "return `${store}/discount/${encodeURIComponent(code)}?redirect=${encodeURIComponent(`${p}?${q}${h}`)}`;", "return `${store}${p}?${q}`;", 'affiliate-mail.mjs'],
    linkquery: ['affiliate-portal', "  return affiliateLink(store, code, u.pathname || '/', u.search, u.hash);", "  return affiliateLink(store, code, u.pathname || '/');", 'affiliate-mail.mjs'],
    utcday: ['affiliate-invite', "          const today = localDay(now(), tz);", "          const today = now().toISOString().slice(0, 10);"],
    offsitelink: ['affiliate-portal', "const p = PATH_RE.test(String(path || '')) && !String(path).startsWith('//') ? path : '/';", "const p = path || '/';", 'affiliate-mail.mjs'],
    anyhostlink: ['affiliate-portal', "  if (u.protocol !== 'https:' || bare(u.hostname) !== bare(new URL(store).hostname)) return null;", "  if (u.protocol !== 'https:') return null;", 'affiliate-mail.mjs'],
    pendingcode: ['affiliate-portal', "data.codes = data.codes.filter((c) => c?.status !== 'pending');", 'data.codes = data.codes;'],
    plainmaillink: ['affiliate-invite', "              let u = current ? storeLinkFor(store, current.code, l.destination_url) : null;", '              let u = null;'],
    oldplatform: ['affiliate-portal', "if (platformVersion !== null && platformVersion !== PLATFORM_TERMS_VERSION) {", 'if (false) {'],
    anylogo: ['affiliate-portal', "return typeof u === 'string' && LOGO_RE.test(u) ? u : null;", "return typeof u === 'string' ? u : null;"],
    draftnews: ['affiliate-invite', "          const words = { approved:", "          const words = { draft: 'is drafted', approved:"],
  };
  const m = muts[MUT];
  if (!MUT || !m || m[0] !== fn) return import(new URL(file, dir));
  const tmp = await mkdtemp(join(tmpdir(), `${fn}-`));
  await cp(dir, tmp, { recursive: true });
  const path = join(tmp, m[3] || file);
  let code = await readFile(path, 'utf8');
  assert.ok(code.includes(m[1]), `mutation ${MUT}: pattern not found`);
  await writeFile(path, code.split(m[1]).join(m[2]));
  return import(pathToFileURL(join(tmp, file)).href);
}
if (MUT && !['byprospectonly', 'rawtoken', 'bodyaddress', 'gateorder', 'bodycompany', 'prospectmail', 'draftnews', 'anylogo', 'nocodelink', 'offsitelink', 'oldplatform', 'anyhostlink', 'pendingcode', 'plainmaillink', 'linkquery', 'utcday'].includes(MUT)) throw new Error(`unknown mutation ${MUT}`);

const { createPortalHandler, affiliateLink, PLATFORM_TERMS_VERSION } = await load('affiliate-portal', 'handler.mjs');
const { createInviteHandler } = await load('affiliate-invite', 'handler.mjs');
const { sha256hex } = await import(new URL('supabase/functions/affiliate-portal/affiliate-mail.mjs', ROOT));

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

const CO = '3f000000-0000-4000-8000-000000000001';
const PROG = '3f000000-0000-4000-8000-000000000002';
const AFF = '3f000000-0000-4000-8000-000000000003';
const PROSPECT = '3f000000-0000-4000-8000-000000000004';
const PAYOUT = '3f000000-0000-4000-8000-000000000005';
const TOKEN = 'T'.repeat(43);

// ── Fakes ─────────────────────────────────────────────────────────────────
function fakeService({ rpc = {}, tables = {} } = {}) {
  const log = [];
  const svc = {
    log,
    rpc: async (name, args) => {
      log.push({ kind: 'rpc', name, args });
      const h = rpc[name];
      if (typeof h === 'function') return h(args);
      return h ?? { data: null, error: null };
    },
    from: (table) => {
      const filters = {};
      let op = 'select'; let payload = null;
      const b = {
        select() { return b; }, eq(k, v) { filters[k] = v; return b; }, ilike(k, v) { filters[k] = { ilike: v }; return b; }, in() { return b; },
        insert(p) { op = 'insert'; payload = p; return b; }, update(p) { op = 'update'; payload = p; return b; },
        maybeSingle() { return b; }, single() { return b; },
        then(res) {
          log.push({ kind: 'table', table, op, filters: { ...filters }, payload });
          const t = tables[table];
          const data = typeof t === 'function' ? t({ op, filters, payload }) : (op === 'select' ? t ?? null : (op === 'insert' ? { id: `${table}-new`, status: 'invited' } : null));
          res({ data, error: null });
        },
      };
      return b;
    },
    auth: { getUser: async () => ({ data: { user: { id: 'staff-user' } }, error: null }) },
  };
  return svc;
}
function fakeResend() {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }); };
  return { sent, fetchImpl };
}
const post = (body, headers = {}) => new Request('https://fn.test', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const resolvedRow = (over = {}) => ({
  token_id: 'tok', purpose: 'signup', company_entity_id: CO, company_title: 'Brand A', program_id: PROG,
  program_name: 'Creators', program_status: 'active', terms_markdown: 'Be nice.', terms_version: 2,
  commission_kind: 'percent_of_net', commission_percent: 10, commission_fixed_cents: null, currency: 'USD',
  affiliate_id: AFF, prospect_id: null, affiliate_status: 'invited', affiliate_display_name: 'Pat',
  affiliate_contact_email: 'pat@onfile.invalid', terms_version_accepted: null, terms_accepted_at: null,
  expires_at: '2026-12-01T00:00:00Z', ...over,
});
const noSuppression = { affiliate_outreach_can_contact: { data: true, error: null } };

// ── affiliate-portal ──────────────────────────────────────────────────────
await test('portal: bad method, oversize body and malformed tokens are refused before the database', async () => {
  const svc = fakeService();
  const h = createPortalHandler({ service: svc, siteUrl: 'https://app.test', resendKey: '' });
  assert.equal((await h(new Request('https://fn.test', { method: 'GET' }))).status, 405);
  assert.equal((await h(post({ action: 'resolve', token: 'x'.repeat(20000) }))).status, 413);
  assert.equal((await h(post({ action: 'resolve', token: 'short' }))).status, 400);
  assert.equal(svc.log.length, 0);
});

await test('portal: the database only ever sees the token\'s hash', async () => {
  const svc = fakeService({ rpc: { affiliate_portal_resolve: { data: [resolvedRow()], error: null } } });
  const h = createPortalHandler({ service: svc, siteUrl: 'https://app.test', resendKey: '' });
  const res = await h(post({ action: 'resolve', token: TOKEN }));
  assert.equal(res.status, 200);
  const hash = await sha256hex(TOKEN);
  assert.ok(svc.log.some((c) => c.args?.p_token_hash === hash));
  assert.ok(!JSON.stringify(svc.log).includes(TOKEN), 'the raw token reached the database');
});

await test('portal: an unknown or expired link is a 404 and nothing is written', async () => {
  const svc = fakeService({ rpc: { affiliate_portal_resolve: { data: [], error: null } } });
  const h = createPortalHandler({ service: svc, siteUrl: 'https://app.test', resendKey: '' });
  const res = await h(post({ action: 'accept', token: TOKEN, signed_name: 'Pat', terms_version: 2 }));
  assert.equal(res.status, 404);
  assert.ok(!svc.log.some((c) => c.name === 'affiliate_portal_accept_terms' || c.op === 'insert'));
});

await test('portal: resolve carries the company logo, only when it is one in the logo bucket', async () => {
  const good = `https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/company-logos/${CO}/logo-1762758000000.png`;
  const mk = (logo) => fakeService({ rpc: { affiliate_portal_resolve: { data: [resolvedRow()], error: null } },
    tables: { company_settings: logo === undefined ? null : { logo_url: logo } } });
  const resolve = async (svc) => (await (await createPortalHandler({ service: svc, siteUrl: 'https://app.test', resendKey: '' })(post({ action: 'resolve', token: TOKEN }))).json());
  const svc = mk(good);
  assert.equal((await resolve(svc)).brand_logo, good);
  assert.ok(svc.log.some((c) => c.table === 'company_settings' && c.filters.company_entity_id === CO), 'read for the link\'s own company');
  assert.equal((await resolve(mk(undefined))).brand_logo, null, 'no logo: the page shows the initial');
  assert.equal((await resolve(mk('https://evil.test/pixel.png'))).brand_logo, null, 'an address outside the logo bucket is never handed to the page');
});

await test('portal: the feed gives each shared item a link on the brand\'s store that applies the affiliate\'s code', async () => {
  const svc = fakeService({ rpc: {
    affiliate_portal_resolve: { data: [resolvedRow({ purpose: 'portal' })], error: null },
    affiliate_portal_statement: { data: { currency: 'USD', totals: {},
      codes: [{ code: 'PAT 10', status: 'active' }, { code: 'WAITING', status: 'pending' }],
      links: [{ destination_url: 'https://www.shop.brand.test/collections/caps', status: 'active' },
        { destination_url: 'https://blog.test/review', status: 'active' }] }, error: null },
    affiliate_portal_feed: { data: { store_url: 'https://shop.brand.test', codes: ['PAT 10'], items: [
      { kind: 'product', title: 'Hat', product_path: '/products/hat', image_url: 'https://cdn.test/h.png' },
      { kind: 'ad', title: 'Spring', note: 'Say spring', product_path: '//evil.test/x', image_url: 'javascript:x' },
      { kind: 'launch', title: 'Drop', event_on: '2026-11-20', product_path: null }] }, error: null },
  } });
  const h = createPortalHandler({ service: svc, siteUrl: 'https://app.test', resendKey: '' });
  const out = await (await h(post({ action: 'statement', token: TOKEN }))).json();
  const hat = out.feed.items.find((i) => i.title === 'Hat');
  const u = new URL(hat.link);
  assert.equal(u.origin, 'https://shop.brand.test');
  assert.equal(u.pathname, '/discount/PAT%2010', 'the code is applied at checkout');
  const r = new URL(u.searchParams.get('redirect'), 'https://shop.brand.test');
  assert.equal(r.pathname, '/products/hat');
  assert.equal(r.searchParams.get('utm_source'), 'affiliate');
  assert.equal(r.searchParams.get('utm_campaign'), 'PAT 10');
  const ad = out.feed.items.find((i) => i.title === 'Spring');
  assert.equal(new URL(ad.link).searchParams.get('redirect').split('?')[0], '/', 'a path that leaves the store becomes the home page');
  assert.equal(ad.image_url, null, 'only https images');
  assert.equal(out.feed.items.find((i) => i.title === 'Drop').link, null, 'nothing to link: no link');
  assert.ok(out.feed.store_link.startsWith('https://shop.brand.test/discount/PAT%2010?redirect=%2F%3F'));
  assert.deepEqual(out.statement.codes.map((c) => c.code), ['PAT 10'], 'a code waiting for Shopify is not shown');
  const [caps, blog] = out.statement.links;
  assert.equal(new URL(caps.link).pathname, '/discount/PAT%2010', 'a link to a store page applies the code');
  assert.equal(new URL(new URL(caps.link).searchParams.get('redirect'), 'https://x.test').pathname, '/collections/caps');
  assert.equal(blog.link, null, 'a page on another site is never sent through the store');
  assert.ok(!('store' in out.feed), 'the feed answer carries links, not internals');
  assert.equal(affiliateLink('https://shop.brand.test', null, '/x'), null, 'no code yet: no link');
  assert.equal(affiliateLink('http://shop.brand.test', 'A', '/x'), null, 'only an https store');
  const noFeed = fakeService({ rpc: { affiliate_portal_resolve: { data: [resolvedRow({ purpose: 'portal' })], error: null },
    affiliate_portal_statement: { data: {}, error: null }, affiliate_portal_feed: { data: null, error: { message: 'missing', code: '42883' } } } });
  const o2 = await (await createPortalHandler({ service: noFeed, siteUrl: 'https://app.test', resendKey: '' })(post({ action: 'statement', token: TOKEN }))).json();
  assert.equal(o2.feed, null, 'before the migration, the statement still works with no feed');
});

await test('portal: resolve exposes no internal ids', async () => {
  const svc = fakeService({ rpc: { affiliate_portal_resolve: { data: [resolvedRow()], error: null } } });
  const h = createPortalHandler({ service: svc, siteUrl: 'https://app.test', resendKey: '' });
  const body = await (await h(post({ action: 'resolve', token: TOKEN }))).json();
  const text = JSON.stringify(body);
  for (const id of [CO, PROG, AFF, 'tok']) assert.ok(!text.includes(id), `${id} leaked`);
  assert.equal(body.program.terms_version, 2);
  assert.equal(body.brand, 'Brand A');
});

await test('portal: acceptance mails the address on file and mints a portal link', async () => {
  const mail = fakeResend();
  const svc = fakeService({ rpc: { ...noSuppression,
    affiliate_portal_resolve: { data: [resolvedRow()], error: null },
    affiliate_portal_accept_terms: { data: { status: 'active', terms_version: 2 }, error: null },
    affiliate_issue_access_token: { data: 'new-token-id', error: null },
    resolve_notification_sender: { data: [{ from_header: 'Brand A - SILO <notifications@get-silo.com>', reply_to: 'ops@brand.invalid' }], error: null } } });
  const h = createPortalHandler({ service: svc, siteUrl: 'https://app.test', resendKey: 're_x', fetchImpl: mail.fetchImpl, makeToken: () => 'P'.repeat(43) });
  const res = await h(post({ action: 'accept', token: TOKEN, signed_name: 'Pat Q', terms_version: 2, email: 'attacker@evil.invalid' }, { 'x-forwarded-for': '203.0.113.9' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'active');
  assert.match(body.portal_url, /^https:\/\/app\.test\/v2\/affiliates\/portal\.html\?t=P+$/);
  assert.equal(body.confirmation_email, 'sent');
  assert.deepEqual(mail.sent[0].body.to, ['pat@onfile.invalid']);
  const acc = svc.log.find((c) => c.name === 'affiliate_portal_accept_terms').args;
  assert.equal(acc.p_terms_version, 2);
  assert.equal(acc.p_acceptance.ip, '203.0.113.9');
  assert.equal(acc.p_acceptance.terms_sha256, await sha256hex('Be nice.'));
  const issued = svc.log.find((c) => c.name === 'affiliate_issue_access_token').args;
  assert.equal(issued.p_purpose, 'portal');
  assert.equal(issued.p_token_hash, await sha256hex('P'.repeat(43)));
  const recorded = svc.log.find((c) => c.table === 'affiliate_notifications');
  assert.equal(recorded.payload.status, 'sent');
  assert.equal(recorded.payload.kind, 'signup_confirmation');
});

await test('portal: no mail key still activates, and the skip is recorded', async () => {
  const svc = fakeService({ rpc: { ...noSuppression,
    affiliate_portal_resolve: { data: [resolvedRow()], error: null },
    affiliate_portal_accept_terms: { data: { status: 'active', terms_version: 2 }, error: null },
    affiliate_issue_access_token: { data: 'id', error: null } } });
  const h = createPortalHandler({ service: svc, siteUrl: 'https://app.test', resendKey: '' });
  const body = await (await h(post({ action: 'accept', token: TOKEN, signed_name: 'Pat', terms_version: 2 }))).json();
  assert.equal(body.status, 'active');
  assert.equal(body.confirmation_email, 'skipped');
  assert.match(svc.log.find((c) => c.table === 'affiliate_notifications').payload.reason, /RESEND_API_KEY/);
});

await test('portal: the platform terms version is recorded, an older one is refused, and the page and function agree on it', async () => {
  const mk = () => fakeService({ rpc: { ...noSuppression,
    affiliate_portal_resolve: { data: [resolvedRow()], error: null },
    affiliate_portal_accept_terms: { data: { status: 'active', terms_version: 2 }, error: null },
    affiliate_issue_access_token: { data: 'id', error: null } } });
  const ok = mk();
  await createPortalHandler({ service: ok, siteUrl: 'https://app.test', resendKey: '' })(post({ action: 'accept', token: TOKEN, signed_name: 'Pat', terms_version: 2, platform_terms_version: PLATFORM_TERMS_VERSION }));
  assert.equal(ok.log.find((c) => c.name === 'affiliate_portal_accept_terms').args.p_acceptance.platform_terms_version, PLATFORM_TERMS_VERSION);
  const old = mk();
  const res = await createPortalHandler({ service: old, siteUrl: 'https://app.test', resendKey: '' })(post({ action: 'accept', token: TOKEN, signed_name: 'Pat', terms_version: 2, platform_terms_version: PLATFORM_TERMS_VERSION - 1 }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'terms_changed');
  assert.ok(!old.log.some((c) => c.name === 'affiliate_portal_accept_terms'), 'nothing is accepted');
  const page = await readFile(new URL('legal/affiliate-terms.html', ROOT), 'utf8');
  assert.equal(Number(/name="silo-affiliate-platform-terms-version" content="(\d+)"/.exec(page)?.[1]), PLATFORM_TERMS_VERSION, 'the terms page carries the version the function records');
  const join = await readFile(new URL('v2/affiliates/join.html', ROOT), 'utf8');
  assert.equal(Number(/const PLATFORM_TERMS_VERSION = (\d+);/.exec(join)?.[1]), PLATFORM_TERMS_VERSION, 'the join page sends the same version');
});

await test('portal: changed terms are a 409 the page can act on', async () => {
  const svc = fakeService({ rpc: {
    affiliate_portal_resolve: { data: [resolvedRow()], error: null },
    affiliate_portal_accept_terms: { data: null, error: { code: '40001', message: 'affiliate_portal_accept_terms: these terms have been updated (version 1 is now 2). Reload and read them again.' } } } });
  const h = createPortalHandler({ service: svc, siteUrl: 'https://app.test', resendKey: '' });
  const res = await h(post({ action: 'accept', token: TOKEN, signed_name: 'Pat', terms_version: 1 }));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'terms_changed');
  assert.ok(!body.error.startsWith('affiliate_portal'), 'internal function names are stripped');
});

await test('portal: a portal link cannot accept, and a signup link cannot read a statement', async () => {
  const svc = fakeService({ rpc: { affiliate_portal_resolve: { data: [resolvedRow({ purpose: 'portal' })], error: null } } });
  const h = createPortalHandler({ service: svc, siteUrl: 'https://app.test', resendKey: '' });
  assert.equal((await h(post({ action: 'accept', token: TOKEN, signed_name: 'P', terms_version: 2 }))).status, 400);
  const svc2 = fakeService({ rpc: { affiliate_portal_resolve: { data: [resolvedRow()], error: null } } });
  const h2 = createPortalHandler({ service: svc2, siteUrl: 'https://app.test', resendKey: '' });
  assert.equal((await h2(post({ action: 'statement', token: TOKEN }))).status, 400);
});

await test('portal: renewal answers the same either way, and mails only the address on file', async () => {
  const mail = fakeResend();
  const none = fakeService({ rpc: { affiliate_portal_renew_subject: { data: [], error: null } } });
  const known = fakeService({ rpc: { ...noSuppression,
    affiliate_portal_renew_subject: { data: [{ company_entity_id: CO, program_id: PROG, affiliate_id: AFF, contact_email: 'pat@onfile.invalid', display_name: 'Pat', affiliate_status: 'active' }], error: null },
    affiliate_issue_access_token: { data: 'id', error: null } }, tables: { entities: { title: 'Brand A' } } });
  const a = await (await createPortalHandler({ service: none, siteUrl: 'https://app.test', resendKey: 're_x', fetchImpl: mail.fetchImpl })(post({ action: 'renew', token: TOKEN, email: 'attacker@evil.invalid' }))).json();
  const b = await (await createPortalHandler({ service: known, siteUrl: 'https://app.test', resendKey: 're_x', fetchImpl: mail.fetchImpl })(post({ action: 'renew', token: TOKEN, email: 'attacker@evil.invalid' }))).json();
  assert.deepEqual(a, b);
  assert.equal(mail.sent.length, 1);
  assert.deepEqual(mail.sent[0].body.to, ['pat@onfile.invalid']);
});

await test('portal: the application honeypot writes nothing; a bad company id is refused', async () => {
  const svc = fakeService();
  const h = createPortalHandler({ service: svc, siteUrl: 'https://app.test', resendKey: '' });
  assert.equal((await (await h(post({ action: 'apply', website: 'http://spam', company_id: CO, program: 'creators', email: 'a@b.c', name: 'x' }))).json()).status, 'received');
  assert.equal(svc.log.length, 0);
  assert.equal((await h(post({ action: 'apply', company_id: 'not-a-uuid', program: 'x' }))).status, 400);
});

// ── affiliate-invite ──────────────────────────────────────────────────────
// The database answers "may manage" and "which company" together
// (affiliate_managed_company): a company id, NULL for a non-manager, or an
// error for a refused session.
function caller({ gate = { data: true, error: null }, company = CO } = {}) {
  const calls = [];
  return { calls, client: { rpc: async (name) => {
    calls.push(name);
    if (name !== 'affiliate_managed_company') return { data: null, error: { message: `unexpected rpc ${name}` } };
    return gate.error ? { data: null, error: gate.error } : { data: gate.data === true ? company : null, error: null };
  } } };
}
const authed = (body) => post(body, { Authorization: 'Bearer staff.jwt.value' });

await test('invite: no session is 401; a refused session aborts before any service-role call', async () => {
  const svc = fakeService();
  const c = caller({ gate: { data: null, error: { message: 'JWT expired' } } });
  const h = createInviteHandler({ service: svc, userClientFor: () => c.client, siteUrl: 'https://app.test', resendKey: '' });
  assert.equal((await h(post({ action: 'portal_link', affiliate_id: AFF }))).status, 401);
  assert.equal((await h(authed({ action: 'portal_link', affiliate_id: AFF }))).status, 401);
  assert.equal(svc.log.length, 0, 'the service role was used before the caller was verified');
});

await test('invite: a non-manager is 403 before any service-role call', async () => {
  const svc = fakeService();
  const c = caller({ gate: { data: false, error: null } });
  const h = createInviteHandler({ service: svc, userClientFor: () => c.client, siteUrl: 'https://app.test', resendKey: '' });
  assert.equal((await h(authed({ action: 'portal_link', affiliate_id: AFF }))).status, 403);
  assert.equal(svc.log.length, 0);
  assert.equal(c.calls[0], 'affiliate_managed_company', 'the gate is the first thing asked');
});

await test('invite: permission and company come from ONE caller request, so a company switch cannot split them', async () => {
  // Review cycle 1, P1: asked as two requests, a manager of A who is a plain
  // member of B could switch to B in between and write B's rows on A's word.
  const OTHER = '3f000000-0000-4000-8000-0000000000bb';
  const svc = fakeService({ tables: { affiliates: null } });
  const c = caller({ company: OTHER });
  const h = createInviteHandler({ service: svc, userClientFor: () => c.client, siteUrl: 'https://app.test', resendKey: '' });
  await h(authed({ action: 'portal_link', affiliate_id: AFF }));
  assert.deepEqual(c.calls, ['affiliate_managed_company'], 'exactly one caller-token request decides both');
  const reads = svc.log.filter((l) => l.table === 'affiliates');
  assert.ok(reads.length && reads.every((r) => r.filters.company_entity_id === OTHER),
    'every service-role read uses the company the gate returned');
});

await test('invite: the company comes from the caller, never from the body', async () => {
  const svc = fakeService({ tables: { affiliates: null } });
  const c = caller();
  const h = createInviteHandler({ service: svc, userClientFor: () => c.client, siteUrl: 'https://app.test', resendKey: '' });
  await h(authed({ action: 'portal_link', affiliate_id: AFF, company_entity_id: '3f000000-0000-4000-8000-0000000000ff' }));
  const reads = svc.log.filter((l) => l.table === 'affiliates');
  assert.ok(reads.length && reads.every((r) => r.filters.company_entity_id === CO));
});

await test('invite: a signup link is RETURNED for the person to send -- SILO emails no prospect', async () => {
  const mail = fakeResend();
  const svc = fakeService({ rpc: { ...noSuppression, affiliate_issue_access_token: { data: 'tok-1', error: null } },
    tables: {
      affiliate_prospects: ({ op }) => (op === 'select' ? { id: PROSPECT, program_id: PROG, display_name: 'Pat', platform: 'youtube', handle: '@pat', profile_url: 'https://youtube.com/@pat', contact_email: 'pat@x.invalid', status: 'approved' } : null),
      affiliates: ({ op }) => (op === 'select' ? null : { id: AFF, status: 'invited' }),
    } });
  const h = createInviteHandler({ service: svc, userClientFor: () => caller().client, siteUrl: 'https://app.test', resendKey: 're_x', fetchImpl: mail.fetchImpl, makeToken: () => 'S'.repeat(43) });
  const res = await h(authed({ action: 'signup_link', prospect_id: PROSPECT }));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(body.signup_url, /\/v2\/affiliates\/join\.html\?t=S+$/);
  assert.equal(body.emailed, false);
  assert.equal(mail.sent.length, 0, 'a prospect must never be emailed by SILO');
  assert.ok(!svc.log.some((l) => l.table === 'affiliate_notifications'));
  const issued = svc.log.find((l) => l.name === 'affiliate_issue_access_token').args;
  assert.equal(issued.p_purpose, 'signup');
  assert.equal(issued.p_company_entity_id, CO);
});

await test('invite: a follow-up to an email the program already has reuses that record, never a second one', async () => {
  // The prospect row is new; the program already holds a record for the email.
  const mk = (existing) => fakeService({ rpc: { ...noSuppression, affiliate_issue_access_token: { data: 'tok-2', error: null } },
    tables: {
      affiliate_prospects: ({ op }) => (op === 'select' ? { id: PROSPECT, program_id: PROG, display_name: 'Pat', platform: 'youtube', handle: '@pat2', profile_url: null, contact_email: 'Pat_1@x.invalid', status: 'approved' } : null),
      affiliates: ({ op, filters }) => (op === 'select' ? (filters.contact_email ? existing : null) : null),
    } });
  const run = async (svc) => {
    const res = await createInviteHandler({ service: svc, userClientFor: () => caller().client, siteUrl: 'https://app.test', resendKey: '', makeToken: () => 'F'.repeat(43) })(authed({ action: 'signup_link', prospect_id: PROSPECT }));
    return { status: res.status, body: await res.json() };
  };
  const ended = mk({ id: AFF, status: 'terminated', terms_accepted_at: null });
  const r1 = await run(ended);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.ok(!ended.log.some((l) => l.table === 'affiliates' && l.op === 'insert'), 'no second affiliate record is created');
  const reopen = ended.log.find((l) => l.table === 'affiliates' && l.op === 'update');
  assert.equal(reopen?.payload?.status, 'invited', 'an ended invite is reopened');
  assert.equal(ended.log.find((l) => l.name === 'affiliate_issue_access_token').args.p_affiliate_id, AFF, 'the link belongs to the existing record');
  const lookup = ended.log.find((l) => l.table === 'affiliates' && l.filters.contact_email);
  assert.deepEqual(lookup.filters.contact_email, { ilike: 'pat\\_1@x.invalid' }, 'matched case-insensitively, with _ taken literally');
  assert.equal(lookup.filters.program_id, PROG);
  assert.equal((await run(mk({ id: AFF, status: 'active', terms_accepted_at: '2026-11-01' }))).status, 409, 'an active affiliate gets no signup link');
  assert.equal((await run(mk({ id: AFF, status: 'terminated', terms_accepted_at: '2026-11-01' }))).status, 409, 'someone who joined and was ended is not reopened');
});

await test('invite: an unapproved prospect gets no link; a suppressed one gets none either', async () => {
  const mk = (status, allowed) => fakeService({ rpc: { affiliate_outreach_can_contact: { data: allowed, error: null } },
    tables: { affiliate_prospects: { id: PROSPECT, program_id: PROG, contact_email: 'p@x.invalid', status } } });
  const run = async (svc) => (await createInviteHandler({ service: svc, userClientFor: () => caller().client, siteUrl: 'https://app.test', resendKey: '' })(authed({ action: 'signup_link', prospect_id: PROSPECT }))).status;
  assert.equal(await run(mk('new', true)), 409);
  assert.equal(await run(mk('approved', false)), 409);
});

await test('invite: a draft payout is not news; a paid one is announced with its reference', async () => {
  const mail = fakeResend();
  const mk = (status) => fakeService({ rpc: noSuppression, tables: {
    affiliates: { id: AFF, program_id: PROG, display_name: 'Pat', contact_email: 'pat@onfile.invalid', status: 'active' },
    entities: { title: 'Brand A' },
    affiliate_payouts: { id: PAYOUT, status, amount_cents: 150000, currency: 'USD', external_reference: 'ACH-9' },
  } });
  const run = (svc) => createInviteHandler({ service: svc, userClientFor: () => caller().client, siteUrl: 'https://app.test', resendKey: 're_x', fetchImpl: mail.fetchImpl })(authed({ action: 'notify', affiliate_id: AFF, kind: 'payout_status', payout_id: PAYOUT }));
  assert.equal((await run(mk('draft'))).status, 409);
  assert.equal(mail.sent.length, 0);
  assert.equal((await run(mk('marked_paid'))).status, 200);
  assert.match(mail.sent[0].body.html, /\$1,500\.00/);
  assert.match(mail.sent[0].body.html, /ACH-9/);
});

await test('invite: the codes email gives links that apply the code, on the store the brand named', async () => {
  const mail = fakeResend();
  const svc = fakeService({ rpc: { ...noSuppression, affiliate_program_store_url: { data: 'https://shop.brand.test', error: null } }, tables: {
    affiliates: { id: AFF, program_id: PROG, display_name: 'Pat', contact_email: 'pat@onfile.invalid', status: 'active' },
    entities: { title: 'Brand A' },
    affiliate_codes: [{ code: 'PAT10', starts_on: '2026-01-01', ends_on: null, status: 'active' }],
    affiliate_links: [{ destination_url: 'https://www.shop.brand.test/products/hat', utm_source: 'affiliate', utm_medium: 'affiliate', utm_campaign: 'x', starts_on: '2026-01-01', ends_on: null }],
  } });
  const res = await createInviteHandler({ service: svc, userClientFor: () => caller().client, siteUrl: 'https://app.test', resendKey: 're_x', fetchImpl: mail.fetchImpl })(
    authed({ action: 'notify', affiliate_id: AFF, kind: 'codes_and_links' }));
  assert.equal(res.status, 200);
  const html = mail.sent[0].body.html;
  assert.ok(html.includes('https://shop.brand.test/discount/PAT10?redirect=%2F%3F'), 'the store home with the code');
  assert.ok(html.includes('https://shop.brand.test/discount/PAT10?redirect=%2Fproducts%2Fhat'), 'the store page with the code');
  assert.ok(svc.log.some((c) => c.name === 'affiliate_program_store_url' && c.args.p_company === CO && c.args.p_program === PROG));
});

await test('a store page keeps its own query and anchor inside the code link', async () => {
  const { storeLinkFor } = await load('affiliate-portal', 'affiliate-mail.mjs');
  const target = (u) => new URL(u).searchParams.get('redirect');
  const v = target(storeLinkFor('https://shop.brand.test', 'PAT10', 'https://shop.brand.test/products/hat?variant=123#reviews'));
  assert.ok(v.startsWith('/products/hat?variant=123&utm_source=affiliate'), v);
  assert.ok(v.endsWith('utm_campaign=PAT10#reviews'), v);
  const q = target(storeLinkFor('https://shop.brand.test', 'PAT10', 'https://shop.brand.test/search?q=caps&utm_campaign=old'));
  assert.equal(q, '/search?q=caps&utm_campaign=PAT10&utm_source=affiliate&utm_medium=affiliate');
});

await test('invite: the codes email picks the code in effect on the company\'s own day, not UTC\'s', async () => {
  // 18:00 in Los Angeles on Nov 10 is already Nov 11 in UTC.
  const at = new Date('2026-11-11T02:00:00Z');
  const send = async (codes) => {
    const mail = fakeResend();
    const svc = fakeService({ rpc: { ...noSuppression, affiliate_program_store_url: { data: 'https://shop.brand.test', error: null }, silo_company_timezone: { data: 'America/Los_Angeles', error: null } }, tables: {
      affiliates: { id: AFF, program_id: PROG, display_name: 'Pat', contact_email: 'pat@onfile.invalid', status: 'active' },
      entities: { title: 'Brand A' }, affiliate_codes: codes, affiliate_links: [],
    } });
    const res = await createInviteHandler({ service: svc, userClientFor: () => caller().client, siteUrl: 'https://app.test', resendKey: 're_x', fetchImpl: mail.fetchImpl, now: () => at })(
      authed({ action: 'notify', affiliate_id: AFF, kind: 'codes_and_links' }));
    assert.equal(res.status, 200);
    return mail.sent[0].body.html;
  };
  const ending = await send([{ code: 'ENDSTODAY', starts_on: '2026-11-01', ends_on: '2026-11-10', status: 'active' }]);
  assert.ok(ending.includes('/discount/ENDSTODAY?'), 'a code valid through the local today still gets its link');
  const starting = await send([{ code: 'TOMORROW', starts_on: '2026-11-11', ends_on: null, status: 'active' }]);
  assert.ok(!starting.includes('/discount/TOMORROW?'), 'a code that starts tomorrow, local time, is not linked yet');
});

await test('the mail module ships byte-identical in both functions', async () => {
  const a = await readFile(new URL('supabase/functions/affiliate-portal/affiliate-mail.mjs', ROOT), 'utf8');
  const b = await readFile(new URL('supabase/functions/affiliate-invite/affiliate-mail.mjs', ROOT), 'utf8');
  assert.equal(b, a, 'edit affiliate-portal/affiliate-mail.mjs and re-copy it into affiliate-invite');
});

await test('the mail module refuses any kind outside the transactional set', async () => {
  const { sendAffiliateMail } = await import(new URL('supabase/functions/affiliate-portal/affiliate-mail.mjs', ROOT));
  await assert.rejects(sendAffiliateMail({ service: fakeService() }, { companyId: CO, kind: 'outreach', to: 'x@y.invalid' }), /unknown/);
});

console.log(`\naffiliate-edge: ${passed} passed`);
