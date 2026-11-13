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
//   * renewal and email sign-in answer identically whether or not anything was sent;
//   * the staff function asks the database, AS THE CALLER, before any
//     service-role call, and takes the company from the caller, never the body;
//   * a signup link for a prospect is RETURNED, never emailed;
//   * a draft payout is never announced;
//   * the mail module ships byte-identical in both functions.
//
// Mutations (CI runs each and requires a failure):
//   AFFILIATE_EDGE_MUTATION=rawtoken      the portal hands the raw token to the database
//   AFFILIATE_EDGE_MUTATION=bodyaddress   renewal mails an address taken from the request
//   AFFILIATE_EDGE_MUTATION=signinleak    email sign-in answers differently when the address is an affiliate's
//   AFFILIATE_EDGE_MUTATION=switchany     a brand switch mints for the requested id instead of asking the database
//   AFFILIATE_EDGE_MUTATION=mailedmint    a portal link handed to its requester is bound as though it had been mailed
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
//   AFFILIATE_EDGE_MUTATION=noticesweep   anyone (no service key) may sweep every company's live-code notices
//   AFFILIATE_EDGE_MUTATION=noticepaused  a paused rep is mailed that their code is live
//   AFFILIATE_EDGE_MUTATION=probeopen     any key that reaches the probe may sweep, whatever Auth answers
//   AFFILIATE_EDGE_MUTATION=probethrow    a probe that fails lets the sweep through
//   AFFILIATE_EDGE_MUTATION=kickreplay    a replayed code mark kicks the notice again
//   AFFILIATE_EDGE_MUTATION=kickgrant     the kick forwards the connection's own token
//   AFFILIATE_EDGE_MUTATION=handbackmailed a mailed portal link is also returned to the manager
//   AFFILIATE_EDGE_MUTATION=unboundmail   the emailed portal link is minted unbound
//   AFFILIATE_EDGE_MUTATION=photobodyid   a photo is saved on the affiliate the request names, not the link's
//   AFFILIATE_EDGE_MUTATION=photosignup   a signup link (not yet joined) may set a photo
//   AFFILIATE_EDGE_MUTATION=photonotjpeg  any bytes are stored as the rep's photo
//   AFFILIATE_EDGE_MUTATION=photohidden   a removed photo comes back as the one found for the rep
//   AFFILIATE_EDGE_MUTATION=photoshared   every upload overwrites one object, so a racing Remove deletes the new photo
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
    bodyaddress: ['affiliate-portal', "        kind, to: subject.contact_email, subject: `${brand}: your affiliate portal link`, html, text,", "        kind, to: globalThis.__bodyEmail || subject.contact_email, subject: `${brand}: your affiliate portal link`, html, text,"],
    mailedmint: ['affiliate-portal', "  async function mintPortalLink(subject, { mailed = false } = {}) {", "  async function mintPortalLink(subject, { mailed = true } = {}) {"],
    switchany: ['affiliate-portal', "      const { error } = await service.rpc('affiliate_portal_switch_token', {", "      const { error } = await service.rpc('affiliate_issue_access_token', { p_purpose: 'portal', p_company_entity_id: t.company_entity_id, p_program_id: t.program_id, p_affiliate_id: wanted, p_prospect_id: null, p_created_by: null,"],
    seedsignup: ['affiliate-portal', "    if (action === 'seed_request') {\n      if (t.purpose !== 'portal' || !t.affiliate_id) return reply({ error: 'Finish signing up first.' }, 400);", "    if (action === 'seed_request') {"],
    seedtitle: ['affiliate-portal', "        p_token_hash: hash, p_feed_item_id: rawItem, p_title: rawItem ? null : title, p_note: note || null,", "        p_token_hash: hash, p_feed_item_id: rawItem, p_title: title || null, p_note: note || null,"],
    signinleak: ['affiliate-portal', "      for (const subject of (Array.isArray(data) ? data : []).slice(0, 10)) {", "      if (Array.isArray(data) && data.length) return reply({ status: 'sent' });\n      for (const subject of (Array.isArray(data) ? data : []).slice(0, 10)) {"],
    byprospectonly: ['affiliate-invite', "        if (!aff) {\n          const like", "        if (false) {\n          const like"],
    gateorder: ['affiliate-invite', "    const caller = userClientFor(authHeader);\n", "    await service.from('affiliates').select('id');\n    const caller = userClientFor(authHeader);\n"],
    bodycompany: ['affiliate-invite', "    const { data: company, error: gateErr } = await caller.rpc('affiliate_managed_company');", "    let { data: company, error: gateErr } = await caller.rpc('affiliate_managed_company');\n    const peek = await req.clone().json().catch(() => ({})); if (peek.company_entity_id) company = peek.company_entity_id;"],
    prospectmail: ['affiliate-invite', "        return reply({ affiliate_id: aff.id, signup_url: link.url, expires_at: link.expires_at, emailed: false });", "        await sendAffiliateMail({ service, resendKey, fetchImpl }, { companyId: company, programId: p.program_id, affiliateId: aff.id, kind: 'portal_link', to: email, subject: 'Join', html: link.url, text: link.url });\n        return reply({ affiliate_id: aff.id, signup_url: link.url, expires_at: link.expires_at, emailed: false });"],
    nocodelink: ['affiliate-portal', "return `${store}/discount/${encodeURIComponent(code)}?redirect=${encodeURIComponent(`${p}?${q}${h}`)}`;", "return `${store}${p}?${q}`;", 'affiliate-mail.mjs'],
    linkquery: ['affiliate-portal', "  return affiliateLink(store, code, u.pathname || '/', u.search, u.hash);", "  return affiliateLink(store, code, u.pathname || '/');", 'affiliate-mail.mjs'],
    utcday: ['affiliate-invite', "    const today = localDay(now(), tz);", "    const today = now().toISOString().slice(0, 10);"],
    noticesweep: ['affiliate-invite', "      if (!codeId && !isService) return reply({ error: 'Unauthorized' }, 401);\n", ''],
    probeopen: ['affiliate-invite', "(await isServiceToken(authHeader.replace(/^Bearer\\s+/, ''))) === true;", "(await isServiceToken(authHeader.replace(/^Bearer\\s+/, ''))) !== undefined;"],
    probethrow: ['affiliate-invite', "        catch { isService = false; }\n", "        catch { isService = true; }\n"],
    noticepaused: ['affiliate-invite', "        if (!a || a.status !== 'active') {", '        if (!a) {'],
    kickreplay: ['mcp', "      if (r.data && r.data.replayed === false) await kickCodeNotice(code);", '      if (r.data) await kickCodeNotice(code);'],
    kickgrant: ['mcp', "        headers: { apikey: anonKey, Authorization: 'Bearer ' + anonKey, 'Content-Type': 'application/json' },", "        headers: { apikey: anonKey, Authorization: authorization, 'Content-Type': 'application/json' },"],
    offsitelink: ['affiliate-portal', "const p = PATH_RE.test(String(path || '')) && !String(path).startsWith('//') ? path : '/';", "const p = path || '/';", 'affiliate-mail.mjs'],
    anyhostlink: ['affiliate-portal', "  if (u.protocol !== 'https:' || bare(u.hostname) !== bare(new URL(store).hostname)) return null;", "  if (u.protocol !== 'https:') return null;", 'affiliate-mail.mjs'],
    pendingcode: ['affiliate-portal', "data.codes = data.codes.filter((c) => c?.status !== 'pending');", 'data.codes = data.codes;'],
    plainmaillink: ['affiliate-invite', "        let u = current ? storeLinkFor(store, current.code, l.destination_url) : null;", '        let u = null;'],
    oldplatform: ['affiliate-portal', "if (platformVersion !== null && platformVersion !== PLATFORM_TERMS_VERSION) {", 'if (false) {'],
    anylogo: ['affiliate-portal', "return typeof u === 'string' && LOGO_RE.test(u) ? u : null;", "return typeof u === 'string' ? u : null;"],
    draftnews: ['affiliate-invite', "          const words = { approved:", "          const words = { draft: 'is drafted', approved:"],
    handbackmailed: ['affiliate-invite', "            if (mail?.status === 'sent') return reply({ portal_url: null, expires_at: sent.expires_at, email: 'sent', reason: null });", "            if (mail?.status === 'sent') return reply({ portal_url: sent.url, expires_at: sent.expires_at, email: 'sent', reason: null });"],
    photobodyid: ['affiliate-portal', "        .eq('id', t.affiliate_id).eq('company_entity_id', t.company_entity_id).select('id');", "        .eq('id', body.affiliate_id || t.affiliate_id).eq('company_entity_id', t.company_entity_id).select('id');"],
    photosignup: ['affiliate-portal', "      if (t.purpose !== 'portal' || !t.affiliate_id) return reply({ error: 'Finish signing up first.' }, 400);\n      const path", "      if (!t.affiliate_id) return reply({ error: 'Finish signing up first.' }, 400);\n      const path"],
    photonotjpeg: ['affiliate-portal', "if (!bytes || !isJpeg(bytes))", 'if (!bytes)'],
    photoshared: ['affiliate-portal', "const path = `${folder}-${now().getTime()}-${makeToken().slice(0, 8)}.jpg`;", "const path = `${folder}-a.jpg`;"],
    photohidden: ['affiliate-portal', "if (error || !a || a.photo_hidden === true) return", 'if (error || !a) return'],
    unboundmail: ['affiliate-invite', "            const sent = await mintMailed({ company, program: a.program_id, affiliateId: a.id, mailedTo: a.contact_email, days: PORTAL_LINK_DAYS });", "            const sent = await mint({ company, program: a.program_id, purpose: 'portal', affiliateId: a.id, days: PORTAL_LINK_DAYS, createdBy: actor });"],
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
if (MUT && !['seedsignup', 'seedtitle', 'byprospectonly', 'rawtoken', 'bodyaddress', 'gateorder', 'bodycompany', 'prospectmail', 'draftnews', 'anylogo', 'nocodelink', 'offsitelink', 'oldplatform', 'anyhostlink', 'pendingcode', 'plainmaillink', 'linkquery', 'utcday', 'signinleak', 'switchany', 'mailedmint', 'handbackmailed', 'unboundmail', 'noticesweep', 'noticepaused', 'probeopen', 'probethrow', 'kickreplay', 'kickgrant', 'photobodyid', 'photosignup', 'photonotjpeg', 'photohidden', 'photoshared'].includes(MUT)) throw new Error(`unknown mutation ${MUT}`);

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
const AFF2 = '3f000000-0000-4000-8000-000000000004';

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
          res(data?.__error ? { data: null, error: data.__error } : { data, error: null });
        },
      };
      return b;
    },
    auth: { getUser: async () => ({ data: { user: { id: 'staff-user' } }, error: null }) },
    uploads: [], removed: [],
    storage: { from: (bucket) => ({
      upload: async (path, bytes, opts) => { svc.uploads.push({ bucket, path, bytes, opts }); return { error: null }; },
      remove: async (paths) => { svc.removed.push(...paths.map((p) => `${bucket}/${p}`)); return { error: null }; },
      getPublicUrl: (path) => ({ data: { publicUrl: `https://ref.supabase.co/storage/v1/object/public/${bucket}/${path}` } }),
    }) },
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
      { kind: 'launch', title: 'Drop', event_on: '2026-11-20', product_path: null,
        push: [{ id: AFF2, title: 'Drop tee', product_path: '/products/drop-tee' }] }] }, error: null },
  } });
  const h = createPortalHandler({ service: svc, siteUrl: 'https://app.test', resendKey: '' });
  const out = await (await h(post({ action: 'statement', token: TOKEN }))).json();
  // A launch's product keeps its id, so the rep can ask for it at the seeding price.
  assert.equal(out.feed.items.find((i) => i.title === 'Drop').push[0].id, AFF2);
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
    affiliate_portal_issue_mailed_token: { data: 'id', error: null },
    affiliate_issue_access_token: { data: 'id', error: null } }, tables: { entities: { title: 'Brand A' } } });
  globalThis.__bodyEmail = 'attacker@evil.invalid';
  const a = await (await createPortalHandler({ service: none, siteUrl: 'https://app.test', resendKey: 're_x', fetchImpl: mail.fetchImpl })(post({ action: 'renew', token: TOKEN, email: 'attacker@evil.invalid' }))).json();
  const b = await (await createPortalHandler({ service: known, siteUrl: 'https://app.test', resendKey: 're_x', fetchImpl: mail.fetchImpl })(post({ action: 'renew', token: TOKEN, email: 'attacker@evil.invalid' }))).json();
  assert.deepEqual(a, b);
  assert.equal(mail.sent.length, 1);
  assert.deepEqual(mail.sent[0].body.to, ['pat@onfile.invalid']);
  delete globalThis.__bodyEmail;
});

await test('portal: the brand menu lists only this address\'s records, and a switch mints a token for one of them', async () => {
  const sibling = (id, co, title, current) => ({ affiliate_id: id, company_entity_id: co, program_id: PROG,
    company_title: title, program_name: 'Creators', display_name: 'Pat', is_current: current });
  const rows = [sibling(AFF, CO, 'Brand A', true), sibling(AFF2, 'co-2', 'Brand B', false)];
  const svc = (over = {}) => fakeService({ rpc: {
    affiliate_portal_resolve: { data: [resolvedRow({ purpose: 'portal' })], error: null },
    affiliate_portal_touch_token: { data: null, error: null },
    affiliate_portal_brands: { data: rows, error: null },
    affiliate_portal_switch_token: { data: 'new-id', error: null },
    ...over } });
  const mk = (service) => createPortalHandler({ service, siteUrl: 'https://app.test', resendKey: 're_x' });

  const menu = await (await mk(svc())(post({ action: 'brands', token: TOKEN }))).json();
  assert.deepEqual(menu.brands.map((b) => [b.brand, b.is_current]), [['Brand A', true], ['Brand B', false]]);
  // Names for a menu: no company id, program id or address reaches the page.
  assert.deepEqual(Object.keys(menu.brands[0]).sort(), ['affiliate_id', 'brand', 'brand_logo', 'is_current', 'program']);
  assert.equal(JSON.stringify(menu).includes('@'), false);

  // A SIGNUP link cannot switch: there is no session to switch out of, and it
  // is refused here before the database is asked at all.
  const signup = fakeService({ rpc: { affiliate_portal_resolve: { data: [resolvedRow()], error: null },
    affiliate_portal_touch_token: { data: null, error: null } } });
  assert.deepEqual(await (await mk(signup)(post({ action: 'brands', token: TOKEN }))).json(), { brands: [] });

  const mail = fakeResend();
  const ok = svc();
  const got = await (await mk(ok)(post({ action: 'switch', token: TOKEN, affiliate_id: AFF2 }))).json();
  assert.match(got.token, /^[A-Za-z0-9_-]{32,128}$/);
  assert.notEqual(got.token, TOKEN);
  // A switch is a session, not a letter: nothing is mailed.
  assert.equal(mail.sent.length, 0);
  // The database decides which record may be moved to, and sees only hashes.
  const sw = ok.log.find((l) => l.name === 'affiliate_portal_switch_token').args;
  assert.equal(sw.p_affiliate_id, AFF2);
  assert.equal(sw.p_token_hash.length, 64);
  assert.equal(sw.p_new_token_hash.length, 64);
  assert.equal(sw.p_new_token_hash, await sha256hex(got.token), 'the database is given the hash, never the token');
  assert.equal(ok.log.some((l) => l.name === 'affiliate_issue_access_token'), false, 'the switch mints through the bound path only');

  assert.equal((await mk(svc())(post({ action: 'switch', token: TOKEN, affiliate_id: 'not-a-uuid' }))).status, 400);

  // Every refusal the database can raise -- not a sibling, the rep's own
  // record, a token that was never mailed, one whose affiliate's address has
  // since been changed -- comes back identically, so the menu stays the only
  // way to learn what exists on an address.
  const refused = svc({ affiliate_portal_switch_token: { data: null, error: { code: '42501', message: 'affiliate_portal_switch_token: that brand is not on this account' } } });
  const no = await mk(refused)(post({ action: 'switch', token: TOKEN, affiliate_id: AFF2 }));
  assert.equal(no.status, 403);
  assert.equal((await no.json()).error, 'that brand is not on this account');

  // A portal token the database does not treat as mailbox proof -- a staff
  // link (affiliate-invite portal_link) or the one signup acceptance returns,
  // both held by their requester -- gets no siblings back either.
  const staff = svc({ affiliate_portal_brands: { data: [], error: null } });
  assert.deepEqual(await (await mk(staff)(post({ action: 'brands', token: TOKEN }))).json(), { brands: [] });
});

await test('portal: only the links that go to the address on file are bound to it', async () => {
  const mail = fakeResend();
  const svc = fakeService({ rpc: { ...noSuppression,
    affiliate_portal_signin_subjects: { data: [{ company_entity_id: CO, program_id: PROG, affiliate_id: AFF, contact_email: 'pat@onfile.invalid', display_name: 'Pat' }], error: null },
    affiliate_portal_issue_mailed_token: { data: 'id', error: null },
    affiliate_portal_issue_mailed_token: { data: 'id', error: null },
    affiliate_issue_access_token: { data: 'id', error: null } },
    tables: { entities: { title: 'Brand A' } } });
  await createPortalHandler({ service: svc, siteUrl: 'https://app.test', resendKey: 're_x', fetchImpl: mail.fetchImpl })(post({ action: 'signin', email: 'pat@onfile.invalid' }));
  // Sign-in mails the link and returns nothing, so it is mailbox proof.
  const minted = svc.log.filter((l) => l.name === 'affiliate_portal_issue_mailed_token');
  assert.equal(minted.length, 1);
  assert.equal(svc.log.filter((l) => l.name === 'affiliate_issue_access_token').length, 0);
  // Bound to the address the mail actually goes to, which is the one ON FILE.
  assert.equal(minted[0].args.p_mailed_to, 'pat@onfile.invalid');

  // Signup acceptance hands the portal URL back to whoever finished the
  // signup link -- a manager can hold one -- so it is NOT.
  const acc = fakeService({ rpc: { ...noSuppression,
    affiliate_portal_resolve: { data: [resolvedRow({ purpose: 'signup', affiliate_status: 'pending_terms' })], error: null },
    affiliate_portal_touch_token: { data: null, error: null },
    affiliate_portal_accept_terms: { data: { status: 'active', terms_version: 2 }, error: null },
    affiliate_portal_issue_mailed_token: { data: 'id', error: null },
    affiliate_issue_access_token: { data: 'id', error: null } },
    tables: { entities: { title: 'Brand A' } } });
  const r = await (await createPortalHandler({ service: acc, siteUrl: 'https://app.test', resendKey: 're_x', fetchImpl: fakeResend().fetchImpl })(
    post({ action: 'accept', token: TOKEN, signed_name: 'Pat Coach', terms_version: 2, platform_terms_version: 1 }))).json();
  assert.ok(r.portal_url, 'acceptance still returns the portal link');
  assert.equal(acc.log.filter((l) => l.name === 'affiliate_portal_issue_mailed_token').length, 0);
  assert.equal(acc.log.filter((l) => l.name === 'affiliate_issue_access_token').length, 1);
});

await test('portal: email sign-in answers the same either way, mails each record on file, needs no token', async () => {
  const mail = fakeResend();
  const subj = (id, co) => ({ company_entity_id: co, program_id: PROG, affiliate_id: id, contact_email: 'Pat@OnFile.invalid', display_name: 'Pat' });
  const none = fakeService({ rpc: { affiliate_portal_signin_subjects: { data: [], error: null } } });
  const known = fakeService({ rpc: { ...noSuppression,
    affiliate_portal_signin_subjects: (args) => ({ data: args.p_email === 'pat@onfile.invalid' ? [subj(AFF, CO), subj('aff-2', 'co-2')] : [], error: null }),
    affiliate_issue_access_token: { data: 'id', error: null } }, tables: { entities: { title: 'Brand A' } } });
  const a = await (await createPortalHandler({ service: none, siteUrl: 'https://app.test', resendKey: 're_x', fetchImpl: mail.fetchImpl })(post({ action: 'signin', email: 'pat@onfile.invalid' }))).json();
  const b = await (await createPortalHandler({ service: known, siteUrl: 'https://app.test', resendKey: 're_x', fetchImpl: mail.fetchImpl })(post({ action: 'signin', email: '  PAT@onfile.invalid ' }))).json();
  assert.deepEqual(a, b, 'a known address gets the same answer as an unknown one');
  assert.equal(mail.sent.length, 2, 'one link per affiliate record on file');
  assert.ok(mail.sent.every((m) => m.body.to[0] === 'Pat@OnFile.invalid'));
  assert.ok(mail.sent.every((m) => /portal\.html\?t=/.test(m.body.html)), 'the mail carries a portal link');
  // Sign-in mints through the mailed path, so each link is mailbox proof and
  // may later switch brands (20261110190000).
  const issued = known.log.filter((e) => e.name === 'affiliate_portal_issue_mailed_token');
  assert.equal(issued.length, 2);
  assert.ok(issued.every((e) => e.args.p_token_hash.length === 64 && e.args.p_affiliate_id));
  assert.ok(issued.every((e) => e.args.p_mailed_to === 'Pat@OnFile.invalid'), 'bound to the address the mail went to');
  assert.equal(known.log.filter((e) => e.name === 'affiliate_issue_access_token').length, 0);
  // A lookup error is the same answer too, and a missing address is refused before any lookup.
  const broken = fakeService({ rpc: { affiliate_portal_signin_subjects: { data: null, error: { message: 'boom' } } } });
  assert.deepEqual(await (await createPortalHandler({ service: broken, siteUrl: 'https://app.test', resendKey: '' })(post({ action: 'signin', email: 'x@y.invalid' }))).json(), a);
  const empty = fakeService();
  assert.equal((await createPortalHandler({ service: empty, siteUrl: 'https://app.test', resendKey: '' })(post({ action: 'signin', email: 'nope' }))).status, 400);
  assert.equal(empty.log.length, 0);
});

await test('portal: product seeding goes through the token only; a signup link and a bad item are refused before the database', async () => {
  const mk = (purpose) => fakeService({ rpc: {
    affiliate_portal_resolve: { data: [resolvedRow({ purpose, affiliate_status: 'active' })], error: null },
    affiliate_portal_seeds: { data: { offer: { enabled: true, percent: 50, multiple: 3 }, claims: [] }, error: null },
    affiliate_portal_seed_request: { data: { id: 'c1', state: 'requested', replayed: false }, error: null },
  } });
  const run = (svc, body) => createPortalHandler({ service: svc, siteUrl: 'https://app.test', resendKey: '' })(post({ token: TOKEN, ...body }));
  const signup = mk('signup');
  assert.equal((await run(signup, { action: 'seed_request', title: 'Cap' })).status, 400);
  assert.equal((await run(signup, { action: 'seeds' })).status, 400);
  assert.equal(signup.log.filter((e) => /seed/.test(e.name || '')).length, 0, 'a signup link reaches no seeding function');
  const svc = mk('portal');
  assert.equal((await run(svc, { action: 'seed_request', item_id: 'nope' })).status, 400);
  assert.equal((await run(svc, { action: 'seed_request' })).status, 400, 'a request must name something');
  assert.equal(svc.log.filter((e) => e.name === 'affiliate_portal_seed_request').length, 0);
  const shared = await (await run(svc, { action: 'seed_request', item_id: AFF2, title: 'ignored' })).json();
  assert.deepEqual(shared, { requested: true, replayed: false, id: 'c1' });
  const privateAsk = await run(svc, { action: 'seed_request', title: '  Gray hoodie  ', note: 'size L' });
  assert.equal(privateAsk.status, 200);
  const calls = svc.log.filter((e) => e.name === 'affiliate_portal_seed_request');
  assert.deepEqual(calls.map((c) => [c.args.p_feed_item_id, c.args.p_title, c.args.p_note]), [[AFF2, null, null], [null, 'Gray hoodie', 'size L']],
    'a shared item is asked for by its id alone; another product by its name');
  assert.ok(calls.every((c) => c.args.p_token_hash.length === 64), 'the database sees only the hash');
  const seeds = await (await run(svc, { action: 'seeds' })).json();
  assert.equal(seeds.offer.percent, 50);
  const refused = fakeService({ rpc: {
    affiliate_portal_resolve: { data: [resolvedRow({ purpose: 'portal', affiliate_status: 'active' })], error: null },
    affiliate_portal_seed_request: { data: null, error: { code: '22023', message: 'affiliate_portal_seed_request: seeding is off for this program' } },
  } });
  const r = await run(refused, { action: 'seed_request', title: 'Cap' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'seeding is off for this program');
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

await test('invite: a portal link that is emailed is bound to the rep and never handed back', async () => {
  // The brand menu treats a bound link as proof the rep's own mailbox got it,
  // so the Studio button must mint bound when it mails -- and must not also
  // return the raw value, or the manager who clicked holds mailbox proof.
  const mk = (resendKey, mail) => fakeService({
    rpc: { ...noSuppression, affiliate_issue_access_token: { data: 'tok-u', error: null },
      affiliate_portal_issue_mailed_token: { data: 'tok-b', error: null } },
    tables: { affiliates: { id: AFF, program_id: PROG, display_name: 'Pat', contact_email: 'pat@x.invalid', status: 'active' }, entities: { title: 'Brand' } },
  });

  const mail = fakeResend();
  const svc = mk();
  const res = await createInviteHandler({ service: svc, userClientFor: () => caller().client, siteUrl: 'https://app.test', resendKey: 're_x', fetchImpl: mail.fetchImpl, makeToken: () => 'B'.repeat(43) })(authed({ action: 'portal_link', affiliate_id: AFF, email: true }));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.email, 'sent');
  assert.equal(body.portal_url, null, 'the raw link is not handed to the caller');
  assert.ok(!JSON.stringify(body).includes('B'.repeat(43)), 'the token appears nowhere in the answer');
  const bound = svc.log.find((l) => l.name === 'affiliate_portal_issue_mailed_token');
  assert.ok(bound, 'the mailed link is minted through the bound path');
  assert.equal(bound.args.p_mailed_to, 'pat@x.invalid', 'bound to the address on file, not one from the body');
  assert.equal(bound.args.p_affiliate_id, AFF);
  assert.ok(!svc.log.some((l) => l.name === 'affiliate_issue_access_token'), 'no second, unbound link is minted when the mail went');
  assert.equal(mail.sent.length, 1);
  assert.ok(mail.sent[0].body.html.includes('B'.repeat(43)), 'the token travels only in the email');

  // No mail provider: the mail is recorded as skipped, so the manager needs
  // something to send by hand -- an ordinary link, which opens one brand.
  const svc2 = mk();
  const res2 = await createInviteHandler({ service: svc2, userClientFor: () => caller().client, siteUrl: 'https://app.test', resendKey: '', makeToken: () => 'C'.repeat(43) })(authed({ action: 'portal_link', affiliate_id: AFF, email: true }));
  const body2 = await res2.json();
  assert.equal(body2.email, 'skipped');
  assert.match(body2.portal_url, /portal\.html\?t=C+$/, 'a fallback link is returned when nothing was sent');
  assert.ok(svc2.log.some((l) => l.name === 'affiliate_issue_access_token'), 'the fallback is an ordinary, unbound link');

  // Asked for without email: the caller gets a link, and nothing is bound.
  const svc3 = mk();
  const res3 = await createInviteHandler({ service: svc3, userClientFor: () => caller().client, siteUrl: 'https://app.test', resendKey: 're_x', fetchImpl: fakeResend().fetchImpl, makeToken: () => 'D'.repeat(43) })(authed({ action: 'portal_link', affiliate_id: AFF }));
  const body3 = await res3.json();
  assert.match(body3.portal_url, /portal\.html\?t=D+$/);
  assert.equal(body3.email, 'not_requested');
  assert.ok(!svc3.log.some((l) => l.name === 'affiliate_portal_issue_mailed_token'), 'a link for the manager is never bound to the rep');
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

await test('invite: code notices -- a sweep needs the service key; a code_id needs no session; neither touches the staff gate', async () => {
  const CODE = '3f000000-0000-4000-8000-000000000009';
  const notice = { code_id: CODE, company_entity_id: CO, program_id: PROG, affiliate_id: AFF, code: 'PAT10' };
  const mk = () => {
    const mail = fakeResend();
    const svc = fakeService({ rpc: { ...noSuppression, affiliate_claim_code_notices: (a) => ({ data: a.p_code === CODE || a.p_code === null ? [notice] : [], error: null }),
      affiliate_program_store_url: { data: 'https://shop.brand.test', error: null } }, tables: {
      affiliates: { id: AFF, program_id: PROG, display_name: 'Pat', contact_email: 'pat@onfile.invalid', status: 'active' },
      entities: { title: 'Brand A' },
      affiliate_codes: [{ code: 'PAT10', starts_on: '2026-01-01', ends_on: null, status: 'active' }],
      affiliate_links: [],
    } });
    const c = caller({ gate: { data: null, error: { message: 'should not be asked' } } });
    const h = createInviteHandler({ service: svc, userClientFor: () => c.client, siteUrl: 'https://app.test', resendKey: 're_x', serviceKey: 'svc-key', fetchImpl: mail.fetchImpl });
    return { mail, svc, c, h };
  };
  // A sweep (no code_id) from anyone but the service key: refused, nothing claimed.
  let k = mk();
  let res = await k.h(post({ action: 'deliver_code_notices' }, { Authorization: 'Bearer anon.key' }));
  assert.equal(res.status, 401);
  assert.ok(!k.svc.log.some((x) => x.name === 'affiliate_claim_code_notices'), 'a stranger cannot sweep every company');
  res = await k.h(post({ action: 'deliver_code_notices' }, { Authorization: 'Bearer svc-keyX' }));
  assert.equal(res.status, 401, 'a near-miss key is refused');
  // The sweep with the service key claims and mails.
  k = mk();
  res = await k.h(post({ action: 'deliver_code_notices' }, { Authorization: 'Bearer svc-key' }));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).delivered, [{ code_id: CODE, email: 'sent' }]);
  assert.equal(k.mail.sent.length, 1);
  assert.equal(k.mail.sent[0].body.to?.[0] ?? k.mail.sent[0].body.to, 'pat@onfile.invalid', 'mailed to the address on file');
  assert.match(k.mail.sent[0].body.subject, /PAT10 is live/);
  assert.ok(k.mail.sent[0].body.html.includes('https://shop.brand.test/discount/PAT10'), 'the live email carries the code link');
  assert.equal(k.c.calls.length, 0, 'the staff gate is never consulted');
  // One code, no session (the mcp kick): claims only that code.
  k = mk();
  res = await k.h(post({ action: 'deliver_code_notices', code_id: CODE }, { Authorization: 'Bearer anon.key' }));
  assert.equal(res.status, 200);
  const claim = k.svc.log.find((x) => x.name === 'affiliate_claim_code_notices');
  assert.equal(claim.args.p_code, CODE, 'scoped to the one code');
  // A paused rep is not mailed.
  k = mk();
  k.svc.from = ((orig) => (t) => (t === 'affiliates' ? fakeService({ tables: { affiliates: { id: AFF, program_id: PROG, display_name: 'Pat', contact_email: 'pat@onfile.invalid', status: 'paused' } } }).from(t) : orig(t)))(k.svc.from);
  res = await k.h(post({ action: 'deliver_code_notices', code_id: CODE }, { Authorization: 'Bearer anon.key' }));
  assert.deepEqual((await res.json()).delivered, [{ code_id: CODE, email: 'skipped' }]);
  assert.equal(k.mail.sent.length, 0);
});

await test('invite: code notices -- a different but genuine service key may sweep; Auth decides, and any doubt refuses', async () => {
  // The nightly workflow's key and the runtime's injected key are both service
  // keys but not the same string; comparing bytes refused every sweep from the
  // first run. Auth answers instead, and only for a sweep that missed the fast path.
  const notice = { code_id: '3f000000-0000-4000-8000-000000000009', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, code: 'PAT10' };
  const mk = (probe) => {
    const mail = fakeResend();
    const asked = [];
    const svc = fakeService({ rpc: { ...noSuppression, affiliate_claim_code_notices: { data: [notice], error: null },
      affiliate_program_store_url: { data: 'https://shop.brand.test', error: null } }, tables: {
      affiliates: { id: AFF, program_id: PROG, display_name: 'Pat', contact_email: 'pat@onfile.invalid', status: 'active' },
      entities: { title: 'Brand A' },
      affiliate_codes: [{ code: 'PAT10', starts_on: '2026-01-01', ends_on: null, status: 'active' }],
      affiliate_links: [],
    } });
    const c = caller({ gate: { data: null, error: { message: 'should not be asked' } } });
    const h = createInviteHandler({ service: svc, userClientFor: () => c.client, siteUrl: 'https://app.test', resendKey: 're_x', serviceKey: 'svc-key',
      fetchImpl: mail.fetchImpl, isServiceToken: async (t) => { asked.push(t); return probe(t); } });
    return { mail, svc, h, asked };
  };
  const claimed = (k) => k.svc.log.some((x) => x.name === 'affiliate_claim_code_notices');

  let k = mk((t) => t === 'other-genuine-key');
  let res = await k.h(post({ action: 'deliver_code_notices' }, { Authorization: 'Bearer other-genuine-key' }));
  assert.equal(res.status, 200, 'a genuine service key that is not byte-identical sweeps');
  assert.deepEqual(k.asked, ['other-genuine-key'], 'Auth is asked about exactly the presented key');
  assert.equal(k.mail.sent.length, 1);

  k = mk(() => false);
  res = await k.h(post({ action: 'deliver_code_notices' }, { Authorization: 'Bearer anon.key' }));
  assert.equal(res.status, 401, 'a key Auth does not admit is refused');
  assert.ok(!claimed(k), 'and nothing is claimed');

  k = mk(() => { throw new Error('auth down'); });
  res = await k.h(post({ action: 'deliver_code_notices' }, { Authorization: 'Bearer anon.key' }));
  assert.equal(res.status, 401, 'a probe that fails refuses');
  assert.ok(!claimed(k));

  k = mk(() => 'yes');
  res = await k.h(post({ action: 'deliver_code_notices' }, { Authorization: 'Bearer anon.key' }));
  assert.equal(res.status, 401, 'only a literal true admits');

  // The fast path and the one-code kick never reach Auth.
  k = mk(() => true);
  res = await k.h(post({ action: 'deliver_code_notices' }, { Authorization: 'Bearer svc-key' }));
  assert.equal(res.status, 200);
  assert.equal(k.asked.length, 0, 'the runtime key matches without asking');
  k = mk(() => true);
  res = await k.h(post({ action: 'deliver_code_notices', code_id: notice.code_id }, { Authorization: 'Bearer anon.key' }));
  assert.equal(res.status, 200);
  assert.equal(k.asked.length, 0, 'a one-code kick is not a sweep and is never probed');
});

await test('mcp: marking a code created kicks the live notice once; a replay or refusal does not', async () => {
  const { createMcpHandler } = await load('mcp', 'handler.mjs');
  const CODE = '3f000000-0000-4000-8000-000000000009';
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const GRANT = `Bearer ${b64({ alg: 'ES256' })}.${b64({ sub: '11111111-1111-4111-8111-111111111111', role: 'silo_integration', client_id: 'app' })}.sig`;
  const run = async (markReply) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, auth: init?.headers?.Authorization });
      if (String(url).includes('/rpc/silo_api_mark_code_created')) return new Response(JSON.stringify(markReply.body), { status: markReply.status });
      if (String(url).includes('/functions/v1/affiliate-invite')) return new Response('{}', { status: 200 });
      if (String(url).includes('/rpc/silo_api_scopes')) return new Response(JSON.stringify(['codes:create']), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    };
    const h = createMcpHandler({ env: { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon-k' }, fetchImpl });
    await h(new Request('https://db.test/functions/v1/mcp', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: GRANT, accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mark_affiliate_code_created', arguments: { code_id: CODE, shopify_discount_id: 'gid://shopify/DiscountCodeNode/123' } } }) }));
    return calls.filter((c) => c.url.includes('/functions/v1/affiliate-invite'));
  };
  const first = await run({ status: 200, body: { code_id: CODE, code: 'PAT10', status: 'active', replayed: false } });
  assert.equal(first.length, 1, 'a fresh mark kicks the notice');
  assert.deepEqual(first[0].body, { action: 'deliver_code_notices', code_id: CODE });
  assert.equal(first[0].auth, 'Bearer anon-k', 'the public key, never the grant token or a service key');
  assert.equal((await run({ status: 200, body: { code_id: CODE, status: 'active', replayed: true } })).length, 0, 'a replay sends nothing new');
  assert.equal((await run({ status: 400, body: { message: 'not pending' } })).length, 0, 'a refused mark sends nothing');
});

// ── the rep's own photo (20261111020000) ─────────────────────────────────
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
function photoSvc({ purpose = 'portal', affiliate = {}, prospect = null, failRead = false, failWrite = false } = {}) {
  const row = { photo_url: null, photo_hidden: false, from_prospect_id: PROSPECT, ...affiliate };
  return fakeService({
    rpc: { affiliate_portal_resolve: { data: [resolvedRow({ purpose })], error: null },
      affiliate_portal_statement: { data: { currency: 'USD', totals: {} }, error: null } },
    tables: {
      affiliates: ({ op, filters, payload }) => {
        if (op === 'update') {
          if (failWrite) return { __error: { code: '42703', message: 'column "photo_hidden" does not exist' } };
          if (filters.id !== AFF || filters.company_entity_id !== CO) return [];
          Object.assign(row, payload); return [{ id: AFF }];
        }
        return failRead ? { __error: { code: '42703', message: 'column "photo_url" does not exist' } } : { ...row };
      },
      affiliate_prospects: ({ filters }) => (filters.id === PROSPECT && filters.company_entity_id === CO ? prospect : null),
    },
  });
}
let tick = 0;
const portalCall = async (svc, body) => { const r = await createPortalHandler({ service: svc, siteUrl: 'https://app.test', resendKey: '', now: () => new Date(Date.UTC(2026, 10, 11) + (tick += 1000)) })(post({ token: TOKEN, ...body })); return { status: r.status, body: await r.json() }; };
const OWN = (name) => `https://ref.supabase.co/storage/v1/object/public/affiliate-feed-images/${CO}/affiliate-photos/${AFF}-${name}.jpg`;

await test('portal photo: a joined rep saves a JPEG on their OWN record, whatever the request names', async () => {
  const svc = photoSvc();
  const out = await portalCall(svc, { action: 'photo', image: JPEG, affiliate_id: AFF2, company_id: 'other' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(svc.uploads.length, 1);
  assert.equal(svc.uploads[0].bucket, 'affiliate-feed-images');
  assert.match(svc.uploads[0].path, new RegExp(`^${CO}/affiliate-photos/${AFF}-\\d+-[A-Za-z0-9_-]{8}\\.jpg$`), 'a new object for each upload, in the link\'s own folder');
  assert.equal(svc.uploads[0].opts.upsert, false, 'never overwrites the photo being shown');
  const upd = svc.log.find((c) => c.table === 'affiliates' && c.op === 'update');
  assert.deepEqual([upd.filters.id, upd.filters.company_entity_id], [AFF, CO], 'the link decides whose photo it is');
  assert.equal(upd.payload.photo_hidden, false);
  assert.equal(upd.payload.photo_url, `https://ref.supabase.co/storage/v1/object/public/affiliate-feed-images/${svc.uploads[0].path}`);
  assert.deepEqual(svc.removed, [], 'nothing of the rep\'s to retire yet');
  assert.equal(out.body.photo_url, upd.payload.photo_url);
});

await test('portal photo: a signup link, a non-JPEG and an oversize photo are refused with nothing stored', async () => {
  const signup = photoSvc({ purpose: 'signup' });
  assert.equal((await portalCall(signup, { action: 'photo', image: JPEG })).status, 400);
  const png = photoSvc();
  assert.equal((await portalCall(png, { action: 'photo', image: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]).toString('base64') })).status, 400);
  assert.equal((await portalCall(png, { action: 'photo', image: 'not base64!' })).status, 400);
  const big = photoSvc();
  const bytes = Buffer.alloc(300_001, 7); bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff;
  assert.equal((await portalCall(big, { action: 'photo', image: bytes.toString('base64') })).status, 413);
  for (const s of [signup, png, big]) {
    assert.equal(s.uploads.length, 0, 'nothing uploaded');
    assert.ok(!s.log.some((c) => c.table === 'affiliates' && c.op === 'update'), 'nothing written');
  }
  const other = fakeService();
  const r = await createPortalHandler({ service: other, siteUrl: 'https://app.test', resendKey: '' })(post({ action: 'resolve', token: TOKEN, pad: 'x'.repeat(20000) }));
  assert.equal(r.status, 413, 'only the photo action may send a large body');
  assert.equal(other.log.length, 0);
});

await test('portal photo: removing hides it (no found photo comes back) and deletes only the copy it replaced', async () => {
  const svc = photoSvc({ affiliate: { photo_url: OWN('old') } });
  const out = await portalCall(svc, { action: 'photo', remove: true });
  assert.equal(out.status, 200);
  const upd = svc.log.find((c) => c.table === 'affiliates' && c.op === 'update');
  assert.deepEqual([upd.payload.photo_url, upd.payload.photo_hidden], [null, true]);
  assert.deepEqual(svc.removed, [`affiliate-feed-images/${CO}/affiliate-photos/${AFF}-old.jpg`]);
  const found = photoSvc({ affiliate: { photo_url: 'https://ref.supabase.co/storage/v1/object/public/affiliate-feed-images/c/creator-photos/p.jpg' } });
  await portalCall(found, { action: 'photo', remove: true });
  assert.deepEqual(found.removed, [], 'a photo outside the rep\'s own folder is never deleted');
  const before = photoSvc({ failWrite: true });
  assert.equal((await portalCall(before, { action: 'photo', remove: true })).status, 503, 'before the migration: said, not hidden');
});

await test('portal photo: an older Remove racing a newer upload never deletes the photo now saved', async () => {
  // Remove reads the saved photo and is held after its update; an upload
  // then lands; the Remove finishes. The upload's photo must survive.
  const svc = photoSvc({ affiliate: { photo_url: OWN('a') } });
  const realRemove = svc.storage.from;
  let release; const held = new Promise((r) => { release = r; }); let first = true;
  svc.storage.from = (b) => { const o = realRemove(b); const rm = o.remove; o.remove = async (p) => { if (first) { first = false; await held; } return rm(p); }; return o; };
  const removing = portalCall(svc, { action: 'photo', remove: true });
  await new Promise((r) => setTimeout(r, 20));
  const up = await portalCall(svc, { action: 'photo', image: JPEG });
  release(); await removing;
  const newPath = svc.uploads[0].path;
  assert.equal(up.body.photo_url, `https://ref.supabase.co/storage/v1/object/public/affiliate-feed-images/${newPath}`);
  assert.ok(!svc.removed.includes(`affiliate-feed-images/${newPath}`), 'the photo the upload saved is still there');
  assert.ok(svc.removed.every((p) => p === `affiliate-feed-images/${CO}/affiliate-photos/${AFF}-a.jpg`), 'only the photo each request replaced is deleted');
});

await test('portal statement: the photo is the rep\'s own, else the one SILO found, never one they removed', async () => {
  const found = { evidence: { profile_image_url: 'https://ref.supabase.co/storage/v1/object/public/affiliate-feed-images/c/creator-photos/p.jpg?v=1', profile_image_stored: true } };
  const own = 'https://ref.supabase.co/storage/v1/object/public/affiliate-feed-images/c/affiliate-photos/a.jpg?v=2';
  const st = async (o) => (await portalCall(photoSvc(o), { action: 'statement' })).body;
  assert.deepEqual([(await st({ affiliate: { photo_url: own }, prospect: found })).photo_url, (await st({ affiliate: { photo_url: own } })).photo_own], [own, true]);
  assert.equal((await st({ prospect: found })).photo_url, found.evidence.profile_image_url, 'never touched: the found photo');
  assert.equal((await st({ prospect: found })).photo_own, false);
  assert.equal((await st({ affiliate: { photo_hidden: true }, prospect: found })).photo_url, null, 'removed stays removed');
  assert.equal((await st({ prospect: { evidence: { profile_image_url: 'https://cdn.instagram.test/x.jpg' } } })).photo_url, null, 'only a copy SILO keeps, not an expiring platform link');
  assert.equal((await st({ affiliate: { photo_url: 'http://plain.test/a.jpg' } })).photo_url, null, 'only https');
  assert.equal((await st({ failRead: true, prospect: found })).photo_url, null, 'before the migration: no photo, no error');
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
