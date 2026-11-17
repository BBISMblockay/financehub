/* SILO makes affiliate discount codes in Shopify itself (2026-11-17).
 * supabase/functions/affiliate-invite/shopify-codes.mjs + the
 * create_shopify_codes action of affiliate-invite. No network, no database.
 *   node scripts/tests/affiliate-shopify-codes.test.mjs
 * MUT=<name> applies one deliberate break (see muts) and must make it fail.
 */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const DIR = new URL('supabase/functions/affiliate-invite/', ROOT);
const MUT = process.env.MUT || '';
const muts = {
  // A code that already exists in Shopify is made again instead of adopted.
  scnoadopt: ['shopify-codes.mjs', '  if (existing) return { id: existing, adopted: true };\n', ''],
  // The scope is taken on trust: every store is treated as able to make codes.
  scnoscope: ['shopify-codes.mjs', '  return handles.includes(CODE_SCOPE);', '  return true;'],
  // Activation no longer requires the code to still be pending.
  scnotpending: ['handler.mjs', ".eq('id', c.id).eq('company_entity_id', co).eq('status', 'pending').select('id');", ".eq('id', c.id).eq('company_entity_id', co).select('id');"],
  // Several stores and no pick: SILO guesses the first.
  scguess: ['shopify-codes.mjs', '  return live.length === 1 ? live[0] : null;', '  return live[0] || null;'],
  // The sweep (every company) opens to anyone.
  scsweepopen: ['handler.mjs', '      if (codeId || sweep) {', '      if (true) {'],
  // The staff path ignores the caller's company.
  scanyco: ['handler.mjs', 'return reply({ results: await createShopifyCodes({ company, codeIds', 'return reply({ results: await createShopifyCodes({ company: null, codeIds'],
  // A store's own app is never asked again with a fresh token.
  scnoremint: ['handler.mjs', "if (!ok && conn.auth_method === 'client_credentials') {", 'if (false) {'],
  // The sweep re-reads the first page instead of walking on.
  scfirstpage: ['handler.mjs', '      after = data[data.length - 1];', '      after = null;'],
  // The sweep never says where it stopped.
  scnonext: ['handler.mjs', '    results.next = next;\n', ''],
  // A code is made in a store the program's links do not open.
  scwrongstore: ['handler.mjs', '        if (!storeMatches(progs.get(c.program_id), conn)) {', '        if (false) {'],
  // End dates are inclusive of the whole last day.
  scendday: ['shopify-codes.mjs', 'dayStartIso(nextDay(code.ends_on), tz)) - 1000', 'dayStartIso(code.ends_on, tz)) - 1000'],
  // Any discount with the same text is adopted, a store promo included.
  scadoptany: ['shopify-codes.mjs', "if (d.__typename === 'DiscountCodeBasic' && String(d.title || '').startsWith(SILO_TITLE)) return node.id;", 'return node.id;'],
  // A code SILO picked itself is left waiting instead of taking the next free text.
  scnorename: ['handler.mjs', "if (e?.kind !== 'taken' || c.created_by) throw e;", 'throw e;'],
};
if (MUT && !muts[MUT]) throw new Error(`unknown mutation ${MUT}`);

async function load(file) {
  const m = muts[MUT];
  if (!m) return import(new URL(file, DIR));
  const tmp = await mkdtemp(join(tmpdir(), 'scodes-'));
  await cp(fileURLToPath(DIR), tmp, { recursive: true });
  const target = join(tmp, m[0]);
  const src = await readFile(target, 'utf8');
  assert.ok(src.includes(m[1]), `mutation ${MUT}: pattern not found`);
  await writeFile(target, src.split(m[1]).join(m[2]));
  return import(pathToFileURL(join(tmp, file)).href);
}
const L = await load('shopify-codes.mjs');
const { createInviteHandler } = await load('handler.mjs');

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
};

// ── Shopify fake ───────────────────────────────────────────────────────────
function fakeShopify({ primary = 'www.brand.com', scopes = ['read_orders', 'write_discounts'], existing = {}, refuse = null, status = 200, taken = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const q = body.query;
    calls.push({ url, op: /SiloScopes/.test(q) ? 'scopes' : /SiloFindCode/.test(q) ? 'find' : /SiloCreateCode/.test(q) ? 'create' : 'other', vars: body.variables, token: init.headers['X-Shopify-Access-Token'] });
    if (status !== 200) return new Response('{"errors":"nope"}', { status });
    const last = calls[calls.length - 1];
    if (last.op === 'scopes') return Response.json({ data: { currentAppInstallation: { accessScopes: scopes.map((h) => ({ handle: h })) }, shop: { myshopifyDomain: 'brand.myshopify.com', primaryDomain: { host: primary } } } });
    if (last.op === 'find') {
      // A string is a discount SILO made ("Affiliate: ..."); { id, title } is anyone else's.
      const e = existing[body.variables.code];
      const node = !e ? null : typeof e === 'string'
        ? { id: e, codeDiscount: { __typename: 'DiscountCodeBasic', title: 'Affiliate: Pat' } }
        : { id: e.id, codeDiscount: { __typename: e.type || 'DiscountCodeBasic', title: e.title } };
      return Response.json({ data: { codeDiscountNodeByCode: node } });
    }
    if (last.op === 'create') {
      if (refuse) return Response.json({ data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ field: ['code'], code: 'INVALID', message: refuse }] } } });
      if (taken) { existing[body.variables.basicCodeDiscount.code] = 'gid://shopify/DiscountCodeNode/77'; return Response.json({ data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ field: ['code'], code: 'TAKEN', message: 'Code must be unique.' }] } } }); }
      return Response.json({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/55' }, userErrors: [] } } });
    }
    return Response.json({ data: {} });
  };
  return { calls, fetchImpl };
}
const CONN = { id: 'conn1', shop_domain: 'brand.myshopify.com', is_active: true, access_token: 'shpat_x', api_version: '2025-01' };

await test('the store: the program\'s pick, then a myshopify store address, then the only store; never a guess', () => {
  const a = { ...CONN, id: 'a', shop_domain: 'a.myshopify.com' };
  const b = { ...CONN, id: 'b', shop_domain: 'b.myshopify.com' };
  assert.equal(L.pickConnection({ shop_domains: ['B.myshopify.com'] }, [a, b])?.id, 'b');
  assert.equal(L.pickConnection({ shop_domains: ['a.myshopify.com', 'b.myshopify.com'] }, [a, b]), null, 'two picked: ask');
  assert.equal(L.pickConnection({ store_url: 'https://a.myshopify.com' }, [a, b])?.id, 'a');
  assert.equal(L.pickConnection({ store_url: 'https://brand.com' }, [a, b]), null, 'several stores and no pick: never a guess');
  assert.equal(L.pickConnection({ store_url: 'https://brand.com' }, [a])?.id, 'a', 'the only store');
  assert.equal(L.pickConnection({}, [{ ...a, is_active: false }, b])?.id, 'b', 'an inactive store does not count');
  assert.equal(L.pickConnection({ shop_domains: ['c.myshopify.com'] }, [a, b]), null, 'a picked store that is not connected');
});

await test('dates: the company\'s own day, the whole last day included', () => {
  assert.equal(L.dayStartIso('2026-11-17', 'America/Los_Angeles'), '2026-11-17T08:00:00.000Z');
  assert.equal(L.dayStartIso('2026-07-01', 'America/Los_Angeles'), '2026-07-01T07:00:00.000Z');
  assert.equal(L.dayStartIso('2026-03-08', 'America/Los_Angeles'), '2026-03-08T08:00:00.000Z', 'the day the clocks change');
  assert.equal(L.dayStartIso('2026-11-17', 'Europe/Berlin'), '2026-11-16T23:00:00.000Z');
  assert.equal(L.dayStartIso('2026-11-17', null), '2026-11-17T00:00:00.000Z');
  const i = L.discountInput({ code: ' PAT10 ', discount_percent: 15, starts_on: '2026-11-17', ends_on: '2026-11-30', affiliate: 'Pat' }, 'America/Los_Angeles');
  assert.equal(i.code, 'PAT10');
  assert.equal(i.customerGets.value.percentage, 0.15);
  assert.deepEqual(i.customerGets.items, { all: true });
  assert.deepEqual(i.customerSelection, { all: true });
  assert.equal(i.startsAt, '2026-11-17T08:00:00.000Z');
  assert.equal(i.endsAt, '2026-12-01T07:59:59.000Z', 'ends at the last second of Nov 30, Pacific, so Shopify shows Nov 30');
  assert.equal(i.usageLimit, undefined, 'no usage limit');
  assert.equal(L.discountInput({ code: 'X', discount_percent: 10, starts_on: '2026-11-17', ends_on: null }, 'UTC').endsAt, null, 'open-ended');
  assert.throws(() => L.discountInput({ code: 'X', discount_percent: 0, starts_on: '2026-11-17' }, 'UTC'), /percent/);
});

await test('Shopify: a code that exists is adopted; a new one is made; a race is adopted; a refusal says why', async () => {
  let s = fakeShopify({ existing: { PAT10: 'gid://shopify/DiscountCodeNode/9' } });
  assert.deepEqual(await L.makeCode(CONN, { code: 'PAT10', discount_percent: 10, starts_on: '2026-11-17' }, 'UTC', s.fetchImpl), { id: 'gid://shopify/DiscountCodeNode/9', adopted: true });
  assert.ok(!s.calls.some((c) => c.op === 'create'), 'never made twice');
  s = fakeShopify();
  assert.deepEqual(await L.makeCode(CONN, { code: 'PAT10', discount_percent: 10, starts_on: '2026-11-17' }, 'UTC', s.fetchImpl), { id: 'gid://shopify/DiscountCodeNode/55', adopted: false });
  assert.match(s.calls[0].url, /^https:\/\/brand\.myshopify\.com\/admin\/api\/2025-01\/graphql\.json$/);
  assert.equal(s.calls[0].token, 'shpat_x');
  s = fakeShopify({ taken: true });
  assert.deepEqual(await L.makeCode(CONN, { code: 'PAT10', discount_percent: 10, starts_on: '2026-11-17' }, 'UTC', s.fetchImpl), { id: 'gid://shopify/DiscountCodeNode/77', adopted: true });
  s = fakeShopify({ refuse: 'Code is too long' });
  await assert.rejects(L.makeCode(CONN, { code: 'PAT10', discount_percent: 10, starts_on: '2026-11-17' }, 'UTC', s.fetchImpl), /too long/);
});

await test('Shopify: another discount with the same text (a promo) is never adopted', async () => {
  const s = fakeShopify({ existing: { PAT10: { id: 'gid://shopify/DiscountCodeNode/1', title: 'Black Friday' } } });
  await assert.rejects(L.makeCode(CONN, { code: 'PAT10', discount_percent: 10, starts_on: '2026-11-17' }, 'UTC', s.fetchImpl), (e) => e.kind === 'taken');
  assert.ok(!s.calls.some((c) => c.op === 'create'), 'nothing made over it');
});

await test('scope: asked of Shopify; missing write_discounts or a 403 means reconnect', async () => {
  assert.equal(await L.canMakeCodes(CONN, fakeShopify().fetchImpl), true);
  assert.equal(await L.canMakeCodes(CONN, fakeShopify({ scopes: ['read_orders', 'read_discounts'] }).fetchImpl), false);
  await assert.rejects(L.canMakeCodes(CONN, fakeShopify({ status: 403 }).fetchImpl), (e) => e.kind === 'needs_scope');
});

// ── Handler ───────────────────────────────────────────────────────────────
const CO = '3f000000-0000-4000-8000-000000000001';
const OTHER = '3f000000-0000-4000-8000-0000000000ff';
const PROG = '3f000000-0000-4000-8000-000000000002';
const CODE = '3f000000-0000-4000-8000-000000000009';
function fakeService({ codes, conns = [CONN], program = { id: PROG, store_url: null, shop_domains: ['brand.myshopify.com'] }, stillPending = true } = {}) {
  const log = [];
  return {
    log,
    rpc: async (name, args) => { log.push({ kind: 'rpc', name, args }); return { data: name === 'silo_company_timezone' ? 'America/Los_Angeles' : name === 'affiliate_claim_code_notices' ? [] : null, error: null }; },
    from: (table) => {
      const f = {}; let op = 'select'; let payload = null;
      const b = {
        select() { return b; }, order(k) { (f.__order ||= []).push(k); return b; }, limit(n) { f.__limit = n; return b; }, maybeSingle() { b.one = true; return b; },
        or(x) { f.__or = x; return b; },
        eq(k, v) { f[k] = v; return b; }, in(k, v) { f[k] = { in: v }; return b; },
        update(p) { op = 'update'; payload = p; return b; },
        then(res) {
          log.push({ table, op, f: { ...f }, payload });
          let data = null;
          if (table === 'affiliate_codes' && op === 'select') {
            // Like PostgREST: ordered, keyset filter, limited.
            const m = /created_at\.gt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.gt\.([^)]+)\)/.exec(f.__or || '');
            data = (codes || []).filter((c) => (!f.company_entity_id || c.company_entity_id === f.company_entity_id) && (!f.id?.in || f.id.in.includes(c.id))
              && (!m || c.created_at > m[1] || (c.created_at === m[2] && c.id > m[3])))
              .sort((x, y) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : x.id < y.id ? -1 : 1))
              .slice(0, f.__limit ?? Infinity);
          }
          if (table === 'affiliate_codes' && op === 'update') data = stillPending && f.status === 'pending' ? [{ id: f.id }] : [];
          if (table === 'shopify_connections') data = op === 'update' ? null : conns;
          if (table === 'shopify_client_credentials') data = { client_id: 'id', client_secret: 'sec' };
          if (table === 'affiliate_programs') data = program;
          if (table === 'affiliates') data = { display_name: 'Pat' };
          res({ data, error: null });
        },
      };
      return b;
    },
    auth: { getUser: async () => ({ data: { user: { id: 'staff-user' } }, error: null }) },
  };
}
const pending = (over = {}) => ({ id: CODE, created_at: '2026-11-17T00:00:00Z', company_entity_id: CO, program_id: PROG, affiliate_id: 'aff', code: 'PAT10', starts_on: '2026-11-17', ends_on: null, discount_percent: 10, ...over });
const staff = (gate = { data: CO, error: null }) => () => ({ rpc: async () => gate });
const post = (body, auth = 'Bearer staff.jwt') => new Request('https://fn.test', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: auth }, body: JSON.stringify(body) });
const mk = (svc, shop, extra = {}) => createInviteHandler({ service: svc, userClientFor: staff(), siteUrl: 'https://app.test', resendKey: '', serviceKey: 'svc-key', fetchImpl: shop.fetchImpl, isServiceToken: async () => false, ...extra });

await test('staff: makes the waiting code in Shopify, then marks it live -- only if still waiting, in its own company', async () => {
  const svc = fakeService({ codes: [pending()] }); const shop = fakeShopify();
  const res = await mk(svc, shop)(post({ action: 'create_shopify_codes', code_ids: [CODE] }));
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out.results.map((r) => [r.status, r.shopify_discount_id]), [['created', 'gid://shopify/DiscountCodeNode/55']]);
  const upd = svc.log.find((x) => x.table === 'affiliate_codes' && x.op === 'update');
  assert.equal(upd.payload.status, 'active');
  assert.equal(upd.payload.shopify_created_via_app, 'SILO');
  assert.equal(upd.payload.changed_by, 'staff-user');
  assert.equal(upd.f.status, 'pending', 'only a code still waiting');
  assert.equal(upd.f.company_entity_id, CO);
  const sel = svc.log.find((x) => x.table === 'affiliate_codes' && x.op === 'select');
  assert.equal(sel.f.company_entity_id, CO, 'the caller\'s company, from the database');
  assert.ok(svc.log.some((x) => x.name === 'affiliate_claim_code_notices'), 'the "your code is live" email follows');
  const made = shop.calls.find((c) => c.op === 'create');
  assert.equal(made.vars.basicCodeDiscount.startsAt, '2026-11-17T08:00:00.000Z', 'the company\'s own day');
});

await test('a code SILO picked that a store promo already uses gets the next free text; a code a person chose waits', async () => {
  let svc = fakeService({ codes: [pending({ created_by: null })] });
  let shop = fakeShopify({ existing: { PAT10: { id: 'gid://shopify/DiscountCodeNode/1', title: 'Store promo' } } });
  let out = await (await mk(svc, shop)(post({ action: 'create_shopify_codes', code_ids: [CODE] }))).json();
  assert.deepEqual(out.results.map((r) => [r.status, r.code]), [['created', 'PAT10-2']]);
  assert.equal(shop.calls.find((c) => c.op === 'create').vars.basicCodeDiscount.code, 'PAT10-2');
  assert.ok(svc.log.some((x) => x.table === 'affiliate_codes' && x.op === 'update' && x.payload.code === 'PAT10-2' && x.f.status === 'pending'), 'renamed only while still waiting');
  svc = fakeService({ codes: [pending({ created_by: 'staff-user' })] });
  shop = fakeShopify({ existing: { PAT10: { id: 'gid://shopify/DiscountCodeNode/1', title: 'Store promo' } } });
  out = await (await mk(svc, shop)(post({ action: 'create_shopify_codes', code_ids: [CODE] }))).json();
  assert.equal(out.results[0].status, 'taken');
  assert.match(out.results[0].reason, /different code/);
  assert.ok(!svc.log.some((x) => x.op === 'update'), 'a chosen code is not renamed or marked live');
});

await test('staff: a code cancelled meanwhile is left alone', async () => {
  const svc = fakeService({ codes: [pending()], stillPending: false });
  const out = await (await mk(svc, fakeShopify())(post({ action: 'create_shopify_codes', code_ids: [CODE] }))).json();
  assert.equal(out.results[0].status, 'skipped');
  assert.ok(!svc.log.some((x) => x.name === 'affiliate_claim_code_notices'), 'no live email for a code that is not live');
});

await test('fail soft: no write_discounts, no store, or a refusal leaves the code waiting and says which', async () => {
  let svc = fakeService({ codes: [pending()] });
  let out = await (await mk(svc, fakeShopify({ scopes: ['read_orders'] }))(post({ action: 'create_shopify_codes', code_ids: [CODE] }))).json();
  assert.equal(out.results[0].status, 'needs_scope');
  assert.ok(!svc.log.some((x) => x.op === 'update'), 'nothing marked live');
  svc = fakeService({ codes: [pending()], conns: [CONN, { ...CONN, id: 'c2', shop_domain: 'other.myshopify.com' }], program: { id: PROG, store_url: 'https://brand.com', shop_domains: null } });
  const shop = fakeShopify();
  out = await (await mk(svc, shop)(post({ action: 'create_shopify_codes', code_ids: [CODE] }))).json();
  assert.equal(out.results[0].status, 'no_store');
  assert.equal(shop.calls.length, 0, 'Shopify never asked');
  svc = fakeService({ codes: [pending()] });
  out = await (await mk(svc, fakeShopify({ refuse: 'Code is too long' }))(post({ action: 'create_shopify_codes', code_ids: [CODE] }))).json();
  assert.equal(out.results[0].status, 'failed');
  assert.match(out.results[0].reason, /too long/);
  assert.ok(!svc.log.some((x) => x.op === 'update'));
});

await test('access: no gate, no codes; one code by id needs no session; the all-company sweep needs the service key', async () => {
  let svc = fakeService({ codes: [pending()] });
  let res = await mk(svc, fakeShopify(), { userClientFor: staff({ data: null, error: { message: 'refused' } }) })(post({ action: 'create_shopify_codes', code_ids: [CODE] }));
  assert.equal(res.status, 401);
  assert.ok(!svc.log.some((x) => x.table === 'affiliate_codes'), 'nothing read');
  // The portal's kick: one code, anon key.
  svc = fakeService({ codes: [pending(), pending({ id: 'x2', company_entity_id: OTHER })] });
  res = await mk(svc, fakeShopify(), { userClientFor: staff({ data: null, error: { message: 'anon' } }) })(post({ action: 'create_shopify_codes', code_id: CODE }, 'Bearer anon.key'));
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out.results.map((r) => r.code_id), [CODE], 'only that one code');
  // A sweep from a stranger falls to the staff gate and is refused.
  svc = fakeService({ codes: [pending()] });
  res = await mk(svc, fakeShopify(), { userClientFor: staff({ data: null, error: { message: 'anon' } }) })(post({ action: 'create_shopify_codes' }, 'Bearer anon.key'));
  assert.equal(res.status, 401);
  assert.ok(!svc.log.some((x) => x.table === 'affiliate_codes'));
  // The nightly sweep.
  svc = fakeService({ codes: [pending(), pending({ id: 'x2', company_entity_id: OTHER })] });
  res = await mk(svc, fakeShopify())(post({ action: 'create_shopify_codes' }, 'Bearer svc-key'));
  assert.equal((await res.json()).results.length, 2, 'every company');
});

await test('portal: joining kicks SILO to make the new code', async () => {
  const { createPortalHandler } = await import(new URL('supabase/functions/affiliate-portal/handler.mjs', ROOT));
  const src = await readFile(new URL('supabase/functions/affiliate-portal/handler.mjs', ROOT), 'utf8');
  assert.ok(src.includes("for (const w of waiting || []) await makeShopifyCode(w.id);"));
  assert.equal(typeof createPortalHandler, 'function');
  const idx = await readFile(new URL('supabase/functions/affiliate-portal/index.ts', ROOT), 'utf8');
  assert.match(idx, /action: 'create_shopify_codes', code_id: codeId/);
});

await test('the nightly sweep walks past codes that stay waiting, to a newer company\'s code', async () => {
  const OTHER_PROG = '3f000000-0000-4000-8000-0000000000aa';
  const stuck = Array.from({ length: 25 }, (_, i) => pending({ id: `3f000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, program_id: OTHER_PROG, created_at: '2026-11-01T00:00:00Z' }));
  const fresh = pending({ id: '3f000000-0000-4000-8000-000000000200', company_entity_id: OTHER, created_at: '2026-11-17T00:00:00Z' });
  const svc = fakeService({ codes: [fresh, ...stuck] });
  const prog = svc.from;
  // The stuck company's program names no store it has: no_store, no Shopify call.
  svc.from = (t) => (t === 'affiliate_programs' ? { select() { return this; }, eq(k, v) { this.v = this.v || {}; this.v[k] = v; return this; }, maybeSingle() { return this; },
    then(res) { res({ data: this.v.id === OTHER_PROG ? { id: OTHER_PROG, shop_domains: ['gone.myshopify.com'] } : { id: PROG, shop_domains: ['brand.myshopify.com'] }, error: null }); } } : prog(t));
  const out = await (await mk(svc, fakeShopify())(post({ action: 'create_shopify_codes' }, 'Bearer svc-key'))).json();
  assert.equal(out.results.length, 26, 'every waiting code was looked at');
  assert.equal(out.results.find((r) => r.code_id === fresh.id)?.status, 'created', 'the newer company\'s code was made');
  assert.equal(out.results.filter((r) => r.status === 'no_store').length, 25);
});

await test('past the per-request budget, the sweep says where it stopped and the next request carries on', async () => {
  const { SWEEP_PAGES } = await load('handler.mjs');
  const OTHER_PROG = '3f000000-0000-4000-8000-0000000000aa';
  const n = 25 * SWEEP_PAGES;
  const stuck = Array.from({ length: n }, (_, i) => pending({ id: `3f000000-0000-4000-8000-${String(100000000 + i).padStart(12, '0')}`, program_id: OTHER_PROG, created_at: '2026-11-01T00:00:00Z' }));
  const fresh = pending({ id: '3f000000-0000-4000-8000-900000000000', company_entity_id: OTHER, created_at: '2026-11-17T00:00:00Z' });
  const svc = fakeService({ codes: [fresh, ...stuck] });
  const prog = svc.from;
  svc.from = (t) => (t === 'affiliate_programs' ? { select() { return this; }, eq(k, v) { this.v = this.v || {}; this.v[k] = v; return this; }, maybeSingle() { return this; },
    then(res) { res({ data: this.v.id === OTHER_PROG ? { id: OTHER_PROG, shop_domains: ['gone.myshopify.com'] } : { id: PROG, shop_domains: ['brand.myshopify.com'] }, error: null }); } } : prog(t));
  const h = mk(svc, fakeShopify());
  const first = await (await h(post({ action: 'create_shopify_codes' }, 'Bearer svc-key'))).json();
  assert.equal(first.results.length, n, 'one request stays within its budget');
  assert.ok(first.next?.id, 'and says where it stopped');
  const second = await (await h(post({ action: 'create_shopify_codes', after: first.next }, 'Bearer svc-key'))).json();
  assert.equal(second.results.find((r) => r.code_id === fresh.id)?.status, 'created', 'the next request reaches the newer code');
  assert.equal(second.next, null, 'and reports the end');
  const caller = await readFile(new URL('scripts/affiliate-commissions.mjs', ROOT), 'utf8');
  assert.match(caller, /if \(!body\.next\) break;\s*after = body\.next;/, 'the nightly run follows it');
  assert.match(caller, /\.\.\.\(after \? \{ after \} : \{\}\)/);
});

await test('a code is made only in the store the program\'s links open', async () => {
  assert.equal(L.storeMatches({ store_url: 'https://brand.com' }, { shop_hosts: ['brand.myshopify.com', 'brand.com'] }), true, 'www and bare are one store');
  assert.equal(L.storeMatches({ store_url: 'https://brand.myshopify.com' }, { shop_hosts: ['brand.myshopify.com', 'brand.com'] }), true);
  assert.equal(L.storeMatches({ store_url: 'https://other.com' }, { shop_hosts: ['brand.myshopify.com', 'brand.com'] }), false);
  assert.equal(L.storeMatches({ store_url: null }, { shop_hosts: ['brand.myshopify.com'] }), true, 'no address yet: no objection');
  const svc = fakeService({ codes: [pending()], program: { id: PROG, store_url: 'https://other-brand.com', shop_domains: ['brand.myshopify.com'] } });
  const shop = fakeShopify();
  const out = await (await mk(svc, shop)(post({ action: 'create_shopify_codes', code_ids: [CODE] }))).json();
  assert.equal(out.results[0].status, 'no_store');
  assert.match(out.results[0].reason, /store address is not brand\.myshopify\.com/);
  assert.ok(!shop.calls.some((c) => c.op === 'create'), 'nothing made in the wrong store');
  const ok = await (await mk(fakeService({ codes: [pending()], program: { id: PROG, store_url: 'https://brand.com', shop_domains: ['brand.myshopify.com'] } }), fakeShopify())(post({ action: 'create_shopify_codes', code_ids: [CODE] }))).json();
  assert.equal(ok.results[0].status, 'created', 'the store\'s own domain is fine');
});

await test('a store\'s own app: re-minted once before saying it lacks the permission, and told where to allow it', async () => {
  const svc = fakeService({ codes: [pending()], conns: [{ ...CONN, auth_method: 'client_credentials', token_expires_at: '2099-01-01T00:00:00Z' }] });
  const shop = fakeShopify({ scopes: ['read_orders'] });
  const mintFetch = async (url, init) => (/oauth\/access_token/.test(url)
    ? Response.json({ access_token: 'fresh', expires_in: 86399, scope: 'read_orders' }) : shop.fetchImpl(url, init));
  const out = await (await mk(svc, { fetchImpl: mintFetch })(post({ action: 'create_shopify_codes', code_ids: [CODE] }))).json();
  assert.equal(out.results[0].status, 'needs_scope');
  assert.match(out.results[0].reason, /Dev Dashboard/);
  assert.equal(shop.calls.filter((c) => c.op === 'scopes').length, 2, 'asked again with a fresh token');
  assert.equal(shop.calls[1].token, 'fresh');
});

await test('reconnecting a store keeps its nightly sync on', async () => {
  const src = await readFile(new URL('supabase/functions/shopify-oauth-callback/index.ts', ROOT), 'utf8');
  assert.match(src, /\.\.\.\(existing \? \{\} : \{ sync_enabled: false, created_by: stateRow\.user_id \}\)/);
  assert.ok(!/^\s*sync_enabled: false,\s*$/m.test(src), 'no unconditional sync_enabled: false');
  const start = await readFile(new URL('supabase/functions/shopify-oauth-start/index.ts', ROOT), 'utf8');
  assert.match(start, /'write_discounts',\n\]\.join/, 'the legacy app asks for write_discounts');
});

console.log(`\naffiliate-shopify-codes: ${passed} passed`);
