// Execute the actual migration against local PostgreSQL (PGlite), never Supabase.
// Run: node scripts/tests/shopify-online-default-database.test.mjs
// Needs: npm ci --prefix scripts/tests/finance-db (pinned PGlite 0.5.8).
//
// Fixture facts verified against production on 2026-10-02: locations.id is a
// bigint with NO default/sequence, its PK is locations_pkey, and authenticated
// writes require BOTH the active company and admin status. Connection.location_id
// is a SILO bigint pointer, not a Shopify GID. Unrelated columns are only sentinels.
//
// PGlite has one connection: replay and failure injection are executable tests;
// the row/table locks are checked in the installed function definition, NOT a
// claim that concurrent transactions have been exercised. PK-collision injection
// below tests the retry branch, not the scheduler or a concurrent UI allocator.
//
// Every mutation changes only SQL in memory. Each must fail a specific assertion:
// SHOPIFY_ONLINE_DB_MUTATION=grant-clients|definer|shop-name-first|unstable-code|
//   ignore-explicit|ignore-pointer|cross-company-pointer|skip-default-save|
//   rename-overwrite|fake-shopify-id|no-row-lock|no-table-lock|no-pk-retry|
//   swallow-other-unique|space-only-code-check|space-only-name-check|
//   space-only-domain-check|empty-explicit-label|empty-pointer-label|
//   empty-recovered-label|unbounded-pk-retry
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });

const mutation = process.env.SHOPIFY_ONLINE_DB_MUTATION || '';
assert.ok(['', 'grant-clients', 'definer', 'shop-name-first', 'unstable-code',
  'ignore-explicit', 'ignore-pointer', 'cross-company-pointer', 'skip-default-save',
  'rename-overwrite', 'fake-shopify-id', 'no-row-lock', 'no-table-lock',
  'no-pk-retry', 'swallow-other-unique', 'space-only-code-check',
  'space-only-name-check', 'space-only-domain-check', 'empty-explicit-label',
  'empty-pointer-label', 'empty-recovered-label', 'unbounded-pk-retry'].includes(mutation), `Unknown mutation: ${mutation}`);

const db = new PGlite();
const root = new URL('../../', import.meta.url);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const codeFor = (id) => `shopify_online_${id.replaceAll('-', '')}`;
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`not ok - ${name}`); throw e; }
};
async function as(role, fn, { company = '', admin = false } = {}) {
  assert.ok(['authenticated', 'anon', 'service_role'].includes(role));
  await db.exec(`set role ${role}`);
  await q("select set_config('test.company', $1, false), set_config('test.admin', $2, false)", [company, String(admin)]);
  try { return await fn(); }
  finally {
    await db.exec('reset role');
    await db.exec("select set_config('test.company', '', false), set_config('test.admin', 'false', false)");
  }
}
const rpc = async (id) => (await one('select public.ensure_shopify_sales_default($1::uuid) as result', [id])).result;
const ensure = (id) => as('service_role', () => rpc(id));
const connection = (id) => one('select * from public.shopify_connections where id = $1', [id]);
const location = (code, company) => one('select * from public.locations where location_code = $1 and company_entity_id = $2', [code, company]);
const snapshot = async () => ({
  entities: await q('select * from public.entities order by id'),
  connections: await q('select * from public.shopify_connections order by id'),
  locations: await q('select * from public.locations order by id'),
});
async function company(title, entityType = 'company') {
  const id = randomUUID();
  await q('insert into public.entities(id, entity_type, title) values ($1, $2, $3)', [id, entityType, title]);
  return id;
}
async function addConnection(companyId, options = {}) {
  const id = options.id || randomUUID();
  await q(`insert into public.shopify_connections
    (id, company_entity_id, shop_domain, shop_name, default_location_code, location_id, access_token)
    values ($1, $2, $3, $4, $5, $6, 'PRIVATE-TEST-TOKEN')`,
  [id, companyId, options.domain ?? `${id}.myshopify.com`, options.name ?? 'My Store',
    options.code ?? null, options.locationId ?? null]);
  return id;
}
async function addLocation(companyId, code, name, options = {}) {
  return one(`insert into public.locations
    (id, company_entity_id, location_code, location_name, shopify_location_id, store_type, is_active)
    values (coalesce($1::bigint, (select coalesce(max(id), 0) + 1 from public.locations)), $2, $3, $4, $5, $6, $7)
    returning *`, [options.id ?? null, companyId, code, name, options.shopifyId ?? null,
    options.storeType ?? 'retail', options.active ?? true]);
}

// Mirror broad Supabase defaults. Without these, forgetting a REVOKE can make
// an apparently secure test pass even though production grants EXECUTE back.
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  create function public.active_company_id() returns uuid language sql stable as $$
    select nullif(current_setting('test.company', true), '')::uuid;
  $$;
  create function public.is_admin_user() returns boolean language sql stable as $$
    select coalesce(current_setting('test.admin', true) = 'true', false);
  $$;
  create table public.entities (id uuid primary key, entity_type text not null, title text);
  create table public.locations (
    id bigint primary key,
    company_entity_id uuid not null references public.entities(id),
    location_code text, location_name text not null, shopify_location_id text, domain text,
    store_type text check (store_type in ('online', 'retail', 'outlet', 'pop_up', 'warehouse', 'wholesale')),
    is_active boolean default true,
    operational_note text default 'preserve-location-metadata'
  );
  create table public.shopify_connections (
    id uuid primary key, company_entity_id uuid not null references public.entities(id),
    shop_domain text not null, shop_name text, default_location_code text,
    location_id bigint references public.locations(id), access_token text,
    is_active boolean not null default true, sync_enabled boolean not null default true,
    meta jsonb not null default '{"checkpoint":"do-not-change"}'::jsonb,
    unique(company_entity_id, shop_domain)
  );
  alter table public.entities enable row level security;
  alter table public.locations enable row level security;
  alter table public.shopify_connections enable row level security;
  create policy entities_select on public.entities for select to authenticated
    using (id = public.active_company_id());
  create policy locations_select on public.locations for select to authenticated
    using (company_entity_id = public.active_company_id());
  create policy locations_write on public.locations for all to authenticated
    using (company_entity_id = public.active_company_id() and public.is_admin_user())
    with check (company_entity_id = public.active_company_id() and public.is_admin_user());
  create policy shopify_connections_select on public.shopify_connections for select to authenticated
    using (company_entity_id = public.active_company_id());
  create policy shopify_connections_write on public.shopify_connections for all to authenticated
    using (company_entity_id = public.active_company_id() and public.is_admin_user())
    with check (company_entity_id = public.active_company_id() and public.is_admin_user());
  -- Live credentials hardening keeps connection metadata readable, token private.
  revoke select on public.shopify_connections from anon, authenticated;
  grant select (id, company_entity_id, shop_domain, shop_name, default_location_code,
    location_id, is_active, sync_enabled, meta) on public.shopify_connections to authenticated;
`);

// Use the real slug helper, not a test-only reimplementation that could mask drift.
const resolver = await readFile(new URL('supabase/migrations/20260920170000_location_channel_resolver.sql', root), 'utf8');
const slugDefinition = resolver.match(/create or replace function public\.silo_location_slug\(p_text text\)[\s\S]*?\$fn\$;/)?.[0];
assert.ok(slugDefinition, 'actual location slug helper found');
await db.exec(slugDefinition);
await db.exec('revoke execute on function public.silo_location_slug(text) from public, anon;');

const coA = await company('  Bat   Nutz\tAthletics\n ');
const coB = await company('Other Company');
const seedLocation = await addLocation(coB, 'OTHER-RETAIL', 'Other company retail', {
  id: '7000000000', shopifyId: 'gid://shopify/Location/123',
});
const connA = await addConnection(coA, { domain: 'bat-nutz.myshopify.com', name: 'My Store' });
const connA2 = await addConnection(coA, { domain: 'bat-nutz-second.myshopify.com', name: 'My Store' });
const connB = await addConnection(coB, { domain: 'bat-nutz.myshopify.com', name: 'My Store' });

let sql = await readFile(new URL('supabase/migrations/20261002031446_shopify_online_sales_default.sql', root), 'utf8');
function replace(from, to) {
  assert.ok(sql.includes(from), `mutation anchor missing: ${from}`);
  sql = sql.replace(from, to);
}
if (mutation === 'grant-clients') replace('revoke all on function public.ensure_shopify_sales_default(uuid) from public, anon, authenticated;', '');
if (mutation === 'definer') replace('security invoker', 'security definer');
if (mutation === 'shop-name-first') replace("coalesce(v_name, nullif(btrim(regexp_replace(c.shop_name, '\\s+', ' ', 'g')), '')", "coalesce(nullif(btrim(regexp_replace(c.shop_name, '\\s+', ' ', 'g')), ''), v_name");
if (mutation === 'unstable-code') replace("v_code := 'shopify_online_' || replace(c.id::text, '-', '');", 'v_code := public.silo_location_slug(v_name);');
if (mutation === 'ignore-explicit') replace("if nullif(btrim(regexp_replace(c.default_location_code, '\\s+', ' ', 'g')), '') is not null then", 'if false then');
if (mutation === 'ignore-pointer') replace('if c.location_id is not null then', 'if false then');
if (mutation === 'cross-company-pointer') replace('where id = c.location_id and company_entity_id = c.company_entity_id;', 'where id = c.location_id;');
if (mutation === 'skip-default-save') replace('update public.shopify_connections set default_location_code = v_code where id = c.id;', 'null;');
if (mutation === 'rename-overwrite') replace("if found then\n      v_name := coalesce(nullif(btrim(regexp_replace(l.location_name, '\\s+', ' ', 'g')), ''), v_code);", "if found then\n      update public.locations set location_name = v_name where company_entity_id = c.company_entity_id and location_code = v_code;");
if (mutation === 'fake-shopify-id') {
  replace('domain, store_type, is_active)', 'domain, store_type, is_active, shopify_location_id)');
  replace("c.shop_domain, 'online', true);", "c.shop_domain, 'online', true, 'gid://shopify/Location/fake');");
}
if (mutation === 'no-row-lock') replace('for update;', ';');
if (mutation === 'no-table-lock') replace('lock table public.locations in share row exclusive mode;', 'null;');
if (mutation === 'no-pk-retry') replace('exception when unique_violation then', 'exception when unique_violation then\n          raise;');
if (mutation === 'swallow-other-unique') replace("if v_constraint <> 'locations_pkey' or v_attempts >= 3 then raise; end if;", 'if v_attempts >= 3 then raise; end if;');
if (mutation === 'unbounded-pk-retry') replace("if v_constraint <> 'locations_pkey' or v_attempts >= 3 then raise; end if;", "if v_constraint <> 'locations_pkey' then raise; end if;");
if (mutation === 'space-only-code-check') replace("regexp_replace(c.default_location_code, '\\s+', ' ', 'g')", 'c.default_location_code');
if (mutation === 'space-only-name-check') replace("regexp_replace(c.shop_name, '\\s+', ' ', 'g')", 'c.shop_name');
if (mutation === 'space-only-domain-check') replace("regexp_replace(c.shop_domain, '\\s+', ' ', 'g')", 'c.shop_domain');
if (mutation === 'empty-explicit-label') replace("coalesce(nullif(btrim(regexp_replace(l.location_name, '\\s+', ' ', 'g')), ''), c.default_location_code)", 'coalesce(l.location_name, c.default_location_code)');
if (mutation === 'empty-pointer-label') replace("v_code := l.location_code;\n    v_name := coalesce(nullif(btrim(regexp_replace(l.location_name, '\\s+', ' ', 'g')), ''), v_code);", 'v_code := l.location_code;\n    v_name := l.location_name;');
if (mutation === 'empty-recovered-label') replace("if found then\n      v_name := coalesce(nullif(btrim(regexp_replace(l.location_name, '\\s+', ' ', 'g')), ''), v_code);", 'if found then\n      v_name := l.location_name;');

await test('migration applies twice without changing any company, connection, or location data', async () => {
  const before = await snapshot();
  await db.exec(sql);
  await db.exec(sql);
  assert.deepEqual(await snapshot(), before);
  const idColumn = await one(`select column_default, data_type from information_schema.columns
    where table_schema = 'public' and table_name = 'locations' and column_name = 'id'`);
  assert.deepEqual(idColumn, { column_default: null, data_type: 'bigint' });
});

await test('installed RPC is service-only SECURITY INVOKER with a fixed search_path', async () => {
  const p = await one(`select prosecdef, proconfig,
    has_function_privilege('service_role', oid, 'EXECUTE') as service_exec,
    has_function_privilege('authenticated', oid, 'EXECUTE') as authenticated_exec,
    has_function_privilege('anon', oid, 'EXECUTE') as anon_exec,
    exists(select 1 from aclexplode(proacl) where grantee = 0 and privilege_type = 'EXECUTE') as public_exec
    from pg_proc where oid = 'public.ensure_shopify_sales_default(uuid)'::regprocedure`);
  assert.equal(p.prosecdef, false, 'RPC must not gain definer rights');
  assert.ok(p.proconfig.includes('search_path=public'));
  assert.deepEqual([p.service_exec, p.authenticated_exec, p.anon_exec, p.public_exec], [true, false, false, false]);
});

await test('authenticated members, admins, and anon are denied at the RPC boundary with no writes', async () => {
  const before = await snapshot();
  for (const [role, admin] of [['authenticated', false], ['authenticated', true], ['anon', false]]) {
    await as(role, () => assert.rejects(() => rpc(connA), /permission denied for function ensure_shopify_sales_default/), { company: coA, admin });
  }
  assert.deepEqual(await snapshot(), before);
});

await test('installed function retains row locking and legacy-id table serialization', async () => {
  const { definition } = await one(`select pg_get_functiondef('public.ensure_shopify_sales_default(uuid)'::regprocedure) as definition`);
  const executable = definition.replace(/--[^\n]*/g, '');
  assert.match(executable, /from public\.shopify_connections\s+where id = p_connection_id\s+for update/i);
  assert.match(executable, /lock table public\.locations in share row exclusive mode/i);
});

await test('service role creates a real online location named from the company, without a Shopify id or credential leak', async () => {
  const before = await connection(connA);
  const result = await ensure(connA);
  const code = codeFor(connA);
  assert.deepEqual(result, { location_tag: code, location_name: 'Bat Nutz Athletics Online', default_location_code: code, automatic: true });
  const row = await location(code, coA);
  assert.ok(row, 'a real locations row must back the sales tag');
  assert.equal(String(row.id), '7000000001', 'allocator uses the global bigint maximum, not company maximum or an assumed sequence');
  assert.deepEqual([row.company_entity_id, row.location_code, row.location_name, row.domain, row.store_type, row.is_active, row.shopify_location_id],
    [coA, code, 'Bat Nutz Athletics Online', 'bat-nutz.myshopify.com', 'online', true, null]);
  assert.deepEqual(await connection(connA), { ...before, default_location_code: code });
  assert.deepEqual(await one('select * from public.locations where id = $1', [seedLocation.id]), seedLocation);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-TEST-TOKEN'));
});

await test('same-company stores and same-domain stores in two companies receive separate stable identities', async () => {
  const a = await ensure(connA);
  const a2 = await ensure(connA2);
  const b = await ensure(connB);
  assert.equal(new Set([a.location_tag, a2.location_tag, b.location_tag]).size, 3);
  assert.equal(a2.location_name, 'Bat Nutz Athletics Online');
  assert.equal(b.location_name, 'Other Company Online');
  assert.equal((await location(a2.default_location_code, coA)).company_entity_id, coA);
  assert.equal((await location(b.default_location_code, coB)).company_entity_id, coB);
  assert.equal(await location(b.default_location_code, coA), undefined);
});

await test('twenty replays return the same row and make no further data changes', async () => {
  const result = await ensure(connA);
  const before = await snapshot();
  for (let n = 0; n < 20; n += 1) assert.deepEqual(await ensure(connA), result);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await one('select count(*)::int as n from public.locations where company_entity_id = $1 and location_code = $2', [coA, codeFor(connA)])).n, 1);
});

await test('ordinary members read only their company; an admin can rename the auto location under existing RLS', async () => {
  const code = codeFor(connA);
  await as('authenticated', async () => {
    assert.equal((await one('select count(*)::int as n from public.locations where company_entity_id = $1', [coB])).n, 0);
    assert.equal((await q('select id from public.locations where location_code = $1', [code])).length, 1);
    await assert.rejects(() => q('select access_token from public.shopify_connections'), /permission denied/);
    assert.equal((await q("update public.locations set location_name = 'Forbidden' where location_code = $1 returning id", [code])).length, 0);
  }, { company: coA });
  await as('authenticated', async () => {
    assert.equal((await q("update public.locations set location_name = 'Bat Nutz Web' where location_code = $1 returning id", [code])).length, 1);
    assert.equal((await q("update public.locations set location_name = 'Wrong Company' where id = $1 returning id", [seedLocation.id])).length, 0);
    await assert.rejects(() => q('update public.locations set company_entity_id = $1 where location_code = $2', [coB, code]), /row-level security/);
  }, { company: coA, admin: true });
  assert.equal((await location(code, coA)).location_name, 'Bat Nutz Web');
});

await test('replay preserves a user rename after company/store edits, including recovery with the default cleared', async () => {
  const code = codeFor(connA);
  await q("update public.entities set title = 'Renamed Company' where id = $1", [coA]);
  await q("update public.shopify_connections set shop_name = 'Renamed Store' where id = $1", [connA]);
  const oldLocation = await location(code, coA);
  assert.equal((await ensure(connA)).location_name, 'Bat Nutz Web');
  await q("update public.shopify_connections set default_location_code = '   ' where id = $1", [connA]);
  const result = await ensure(connA);
  assert.deepEqual(result, { location_tag: code, location_name: 'Bat Nutz Web', default_location_code: code, automatic: true });
  assert.deepEqual(await location(code, coA), oldLocation, 'recover existing identity without changing its name, type, mapping, or metadata');
  assert.equal((await one('select count(*)::int as n from public.locations where company_entity_id = $1 and location_code = $2', [coA, code])).n, 1);
});

await test('Unicode company names stay readable; blank names fall back to shop, domain, then Shopify', async () => {
  for (const [title, name, domain, expected] of [
    ['  東京 ⚾\n  Équipe  ', 'My Store', 'unicode.myshopify.com', '東京 ⚾ Équipe Online'],
    [' \n\t ', '  Shop Name  ', 'blank-company.myshopify.com', 'Shop Name Online'],
    [null, '   ', '  domain.myshopify.com  ', 'domain.myshopify.com Online'],
    ['', '', '', 'Shopify Online'],
    [' \t\n', ' Shop\t Name\n ', 'shop-name.myshopify.com', 'Shop Name Online'],
    [null, '\r\n\t ', ' \tdomain.myshopify.com\n ', 'domain.myshopify.com Online'],
    ['', '\r\n\t ', ' \t\r\n ', 'Shopify Online'],
  ]) {
    const companyId = await company(title);
    const id = await addConnection(companyId, { name, domain, code: '   ' });
    const result = await ensure(id);
    assert.equal(result.location_name, expected);
    assert.equal(result.location_tag, codeFor(id), 'Unicode display names never become fragile ASCII identity keys');
    assert.equal((await location(result.default_location_code, companyId)).location_name, expected);
  }
});

await test('tab/newline-only stored default codes provision rather than being mistaken for explicit configuration', async () => {
  for (const code of ['\t', '\r\n', ' \t\n\r ']) {
    const id = await addConnection(coA, { code });
    const result = await ensure(id);
    assert.deepEqual(result, {
      location_tag: codeFor(id), location_name: 'Renamed Company Online',
      default_location_code: codeFor(id), automatic: true,
    });
    assert.equal((await connection(id)).default_location_code, codeFor(id));
    assert.equal((await location(codeFor(id), coA)).location_name, 'Renamed Company Online');
  }
});

await test('explicit default codes win over a selected pointer, preserving spelling, mapping, and all data', async () => {
  const configured = await addLocation(coA, ' \tCustom /\n WEB  ', 'Custom web channel', { storeType: 'wholesale', active: false });
  // The other company's same code must never supply the display name.
  await addLocation(coB, configured.location_code, 'Wrong company name');
  const id = await addConnection(coA, { code: configured.location_code, locationId: seedLocation.id });
  const before = await snapshot();
  assert.deepEqual(await ensure(id), { location_tag: 'custom_web', location_name: 'Custom web channel', default_location_code: configured.location_code, automatic: false });
  assert.deepEqual(await snapshot(), before);
  const noRow = await addConnection(coA, { code: 'Legacy Import Code' });
  const noRowBefore = await snapshot();
  assert.deepEqual(await ensure(noRow), { location_tag: 'legacy_import_code', location_name: 'Legacy Import Code', default_location_code: 'Legacy Import Code', automatic: false });
  assert.deepEqual(await snapshot(), noRowBefore, 'an explicit legacy code does not silently create or remap a location');
});

await test('selected SILO bigint location is honored without allocating or changing that location', async () => {
  const chosen = await addLocation(coA, 'Existing / Selected', 'Selected fulfillment location', { shopifyId: 'gid://shopify/Location/789', storeType: 'retail', active: false });
  const id = await addConnection(coA, { code: ' ', locationId: chosen.id });
  const before = await snapshot();
  const result = await ensure(id);
  assert.deepEqual(result, { location_tag: 'existing_selected', location_name: chosen.location_name, default_location_code: chosen.location_code, automatic: false });
  const after = await snapshot();
  const expected = structuredClone(before);
  expected.connections.find((c) => c.id === id).default_location_code = chosen.location_code;
  assert.deepEqual(after, expected);
  assert.equal((await connection(id)).location_id, chosen.id, 'SILO pointer remains a bigint, never replaced by a Shopify id');
});

await test('an unusable explicit code stays untouched and returns no usable tag for the caller to reject', async () => {
  const id = await addConnection(coA, { code: '東京 ⚾' });
  const before = await snapshot();
  assert.deepEqual(await ensure(id), {
    location_tag: null, location_name: '東京 ⚾', default_location_code: '東京 ⚾', automatic: false,
  });
  assert.deepEqual(await snapshot(), before, 'preserve explicit configuration rather than silently replace it');
});

await test('blank/whitespace names on explicit, selected, and recovered locations use their code without changing stored labels', async () => {
  for (const [i, name] of ['', ' \t\r\n '].entries()) {
    const explicitCode = `unnamed_explicit_${i}`;
    await addLocation(coA, explicitCode, name);
    const explicit = await addConnection(coA, { code: explicitCode });
    let before = await snapshot();
    assert.deepEqual(await ensure(explicit), {
      location_tag: explicitCode, location_name: explicitCode,
      default_location_code: explicitCode, automatic: false,
    });
    assert.deepEqual(await snapshot(), before, 'explicit default and blank stored label remain untouched');

    const selectedCode = `unnamed_selected_${i}`;
    const selectedRow = await addLocation(coA, selectedCode, name);
    const selected = await addConnection(coA, { locationId: selectedRow.id });
    before = await snapshot();
    const selectedResult = await ensure(selected);
    assert.deepEqual(selectedResult, {
      location_tag: selectedCode, location_name: selectedCode,
      default_location_code: selectedCode, automatic: false,
    });
    before.connections.find((c) => c.id === selected).default_location_code = selectedCode;
    assert.deepEqual(await snapshot(), before, 'selected pointer only sets the connection code');
    assert.deepEqual(await ensure(selected), selectedResult, 'first call and explicit-code replay agree');

    const recovered = await addConnection(coA);
    const recoveredCode = codeFor(recovered);
    await addLocation(coA, recoveredCode, name, { storeType: 'online' });
    before = await snapshot();
    const recoveredResult = await ensure(recovered);
    assert.deepEqual(recoveredResult, {
      location_tag: recoveredCode, location_name: recoveredCode,
      default_location_code: recoveredCode, automatic: true,
    });
    before.connections.find((c) => c.id === recovered).default_location_code = recoveredCode;
    assert.deepEqual(await snapshot(), before, 'recovered location is reused without silently renaming it');
    assert.deepEqual(await ensure(recovered), recoveredResult, 'recovery and subsequent replay agree');
  }
});

await test('cross-company and unusable selected pointers fail atomically instead of creating a replacement', async () => {
  const crossed = await addConnection(coA, { code: ' ', locationId: seedLocation.id });
  let before = await snapshot();
  await assert.rejects(() => ensure(crossed), /Configured Shopify default location is unavailable/);
  assert.deepEqual(await snapshot(), before);
  for (const unusableCode of [null, ' ', '東京']) {
    const chosen = await addLocation(coA, unusableCode, 'No usable code');
    const id = await addConnection(coA, { locationId: chosen.id });
    before = await snapshot();
    await assert.rejects(() => ensure(id), /Configured Shopify default location has no usable code/);
    assert.deepEqual(await snapshot(), before);
  }
});

await test('missing connection and non-company entity refuse with no writes', async () => {
  const wrongEntity = await company('A department is not a company', 'department');
  const invalid = await addConnection(wrongEntity);
  const before = await snapshot();
  await assert.rejects(() => ensure(randomUUID()), /Shopify connection has no company/);
  await assert.rejects(() => ensure(null), /Shopify connection has no company/);
  await assert.rejects(() => ensure(invalid), /Shopify company is unavailable/);
  assert.deepEqual(await snapshot(), before);
});

await test('auto-row recovery cannot reuse a different company row with a matching stable code', async () => {
  const id = await addConnection(coA);
  const other = await addLocation(coB, codeFor(id), 'Wrong tenant automatic name', { shopifyId: 'gid://shopify/Location/555' });
  const result = await ensure(id);
  assert.equal(result.location_name, 'Renamed Company Online');
  assert.equal((await location(codeFor(id), coA)).company_entity_id, coA);
  assert.deepEqual(await location(codeFor(id), coB), other);
});

// Deliberately fail AFTER inserting a new location but BEFORE saving the
// connection's default. PostgreSQL must roll the entire statement back.
await db.exec(`
  create function public.test_reject_default_update() returns trigger language plpgsql as $$
  begin
    if new.shop_domain = 'reject-default.myshopify.com' and new.default_location_code is not null then
      raise exception 'test: connection default update rejected';
    end if;
    return new;
  end $$;
  create trigger test_reject_default_update before update on public.shopify_connections
    for each row execute function public.test_reject_default_update();
`);
await test('a failed connection update rolls back the newly inserted location; successful retry creates exactly one', async () => {
  const id = await addConnection(coA, { domain: 'reject-default.myshopify.com' });
  const before = await snapshot();
  await assert.rejects(() => ensure(id), /test: connection default update rejected/);
  assert.deepEqual(await snapshot(), before, 'neither half of the default survives');
  await db.exec('drop trigger test_reject_default_update on public.shopify_connections');
  const result = await ensure(id);
  assert.equal(result.default_location_code, codeFor(id));
  assert.equal((await one('select count(*)::int as n from public.locations where company_entity_id = $1 and location_code = $2', [coA, codeFor(id)])).n, 1);
});

// Sequences are intentionally non-transactional so a failed subtransaction
// cannot reset the injection forever. Distinct non-PK stop errors prevent both
// "retry all unique violations" and "unbounded PK retry" mutations from hanging
// the process. A correct function never reaches either injection safeguard.
await db.exec(`
  create sequence public.test_pk_attempts;
  create sequence public.test_other_unique_attempts;
  create sequence public.test_persistent_pk_attempts;
  create function public.test_location_insert_collision() returns trigger language plpgsql as $$
  declare attempt bigint;
  begin
    if new.domain = 'retry-pk.myshopify.com' then
      attempt := nextval('public.test_pk_attempts');
      if attempt = 1 then
        raise unique_violation using message = 'test: primary key collision', constraint = 'locations_pkey';
      end if;
    elsif new.domain = 'persistent-pk.myshopify.com' then
      attempt := nextval('public.test_persistent_pk_attempts');
      if attempt > 3 then raise exception 'test: PK retry exceeded its three-attempt bound'; end if;
      raise unique_violation using message = 'test: persistent primary key collision', constraint = 'locations_pkey';
    elsif new.domain = 'reject-unique.myshopify.com' then
      attempt := nextval('public.test_other_unique_attempts');
      if attempt > 2 then raise exception 'test: non-PK violation was incorrectly retried'; end if;
      raise unique_violation using message = 'test: unrelated unique constraint', constraint = 'test_other_unique';
    end if;
    return new;
  end $$;
  create trigger test_location_insert_collision before insert on public.locations
    for each row execute function public.test_location_insert_collision();
`);
await test('a locations_pkey collision retries successfully and saves exactly one location/default pair', async () => {
  const id = await addConnection(coA, { domain: 'retry-pk.myshopify.com' });
  const result = await ensure(id);
  assert.equal(result.default_location_code, codeFor(id));
  assert.equal(String((await one('select last_value from public.test_pk_attempts')).last_value), '2');
  assert.equal((await one('select count(*)::int as n from public.locations where company_entity_id = $1 and location_code = $2', [coA, codeFor(id)])).n, 1);
  assert.equal((await connection(id)).default_location_code, codeFor(id));
});

await test('a different unique violation is not retried or swallowed and leaves no half-written default', async () => {
  const id = await addConnection(coA, { domain: 'reject-unique.myshopify.com' });
  const before = await snapshot();
  await assert.rejects(() => ensure(id), (error) => error.code === '23505' && error.constraint === 'test_other_unique');
  assert.equal(String((await one('select last_value from public.test_other_unique_attempts')).last_value), '1');
  assert.deepEqual(await snapshot(), before);
});

await test('a persistent PK collision stops on the third attempt and rolls back without a location/default pair', async () => {
  const id = await addConnection(coA, { domain: 'persistent-pk.myshopify.com' });
  const before = await snapshot();
  await assert.rejects(() => ensure(id), (error) => error.code === '23505'
    && error.constraint === 'locations_pkey' && /persistent primary key collision/.test(error.message));
  assert.equal(String((await one('select last_value from public.test_persistent_pk_attempts')).last_value), '3', 'three total attempts, not three retries after the initial insert');
  assert.deepEqual(await snapshot(), before, 'a failed allocator cannot strand a location or partially save a connection default');
});

await test('reapplying after provisioning preserves all defaults, ids, user renames, and source metadata', async () => {
  const before = await snapshot();
  await db.exec(sql);
  assert.deepEqual(await snapshot(), before);
});

await test('the shipped schema-verifier row detects a missing RPC, unsafe grants, definer drift, and a missing service grant', async () => {
  const verify = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
  const start = verify.indexOf("select 'shopify_online_sales_default' as check_name,");
  const end = verify.indexOf('end as status;', start);
  assert.ok(start >= 0 && end > start, 'online-default verification query is present');
  const query = verify.slice(start, end + 'end as status;'.length);
  const status = async () => (await one(query)).status;
  const before = await snapshot();
  assert.equal(await status(), 'ok');
  await db.exec('grant execute on function public.ensure_shopify_sales_default(uuid) to authenticated');
  assert.match(await status(), /CRITICAL:.*service-only/);
  await db.exec(sql);
  await db.exec('alter function public.ensure_shopify_sales_default(uuid) security definer');
  assert.match(await status(), /CRITICAL:.*security invoker/);
  await db.exec(sql);
  await db.exec('revoke execute on function public.ensure_shopify_sales_default(uuid) from service_role');
  assert.match(await status(), /MISSING:.*service_role/);
  await db.exec('drop function public.ensure_shopify_sales_default(uuid)');
  assert.match(await status(), /MISSING: apply/);
  await db.exec(sql);
  assert.equal(await status(), 'ok');
  assert.deepEqual(await snapshot(), before);
});

await db.close();
console.log(`\nshopify-online-default-database: ${passed} passed`);
