// Local synthetic PostgreSQL execution, never a hosted database.
//
// The two migrations of 2026-11-13 that turn company-specific CODE into
// company DATA. Both are small; what is worth pinning is narrow and exact.
//
//  1. payment_request_vendor_suggestions replaced 195 vendor and ambassador
//     names written into v2/purchase_request.html. The old gate
//     (`entity_key === 'baseballism'`) decided what was DISPLAYED and never
//     what was DELIVERED -- the array reached every tenant's browser. So the
//     only thing that makes this change worth anything is that RLS holds:
//     another company cannot read these names, anon cannot read them at all,
//     an ordinary member cannot write them, and the company stamp cannot be
//     bypassed on insert. Each of those has a mutation below.
//
//  2. nav_profile_in_entity_meta sets entities.meta.nav_profile for the
//     grandfathered workspace. It must set exactly one company, must not
//     destroy the other keys already in that company's meta (integrations,
//     seeded, invite_id ...), must leave every other company alone, and must
//     be re-runnable.
//
// Run: node --test scripts/tests/vendor-suggestions-nav-profile-database.test.mjs
// Mutations: VENDOR_MUTATION=cross-tenant-read|member-write|anon-read|no-unique|meta-clobber|all-companies
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUTATIONS = ['', 'cross-tenant-read', 'member-write', 'anon-read', 'no-unique', 'case-dupes', 'meta-clobber', 'all-companies'];
const mutation = process.env.VENDOR_MUTATION || '';
assert.ok(MUTATIONS.includes(mutation), `Unknown mutation ${mutation}`);

const db = new PGlite();
let checks = 0;
const check = () => { checks += 1; };

await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
create table entities(id uuid primary key, entity_key text unique, entity_type text, title text, meta jsonb default '{}'::jsonb);
create table profiles(id uuid primary key, active_company_id uuid);
create table entity_memberships(entity_id uuid, user_id uuid, role text);
create function active_company_id() returns uuid language sql stable security definer as $$select active_company_id from profiles where id=auth.uid()$$;
-- is_admin_user() as production behaves: membership admin in the ACTIVE
-- company. (It passes for nearly every profile there -- which is why it is the
-- right gate for curating a suggestion list and the wrong one for money.)
create function is_admin_user() returns boolean language sql stable security definer as $$
  select exists(select 1 from entity_memberships m
                 where m.user_id=auth.uid() and m.entity_id=active_company_id()
                   and m.role in ('owner_admin','admin'))$$;
-- The real helper attaches a BEFORE INSERT stamp; this stand-in does the same
-- thing for the one table under test, so the backstop is actually exercised
-- rather than stubbed away.
create function stamp_company_entity_id() returns trigger language plpgsql as $$
begin
  if new.company_entity_id is null then new.company_entity_id := public.active_company_id(); end if;
  return new;
end$$;
create function attach_stamp_company_entity_id_triggers() returns void language plpgsql as $$
begin
  if to_regclass('public.payment_request_vendor_suggestions') is not null then
    drop trigger if exists stamp_company_entity_id on public.payment_request_vendor_suggestions;
    create trigger stamp_company_entity_id before insert on public.payment_request_vendor_suggestions
      for each row execute function public.stamp_company_entity_id();
  end if;
end$$;
grant usage on schema public,auth to authenticated,anon;
-- Supabase's default privileges hand every NEW table in public to anon and
-- authenticated, which is why the migration has to revoke from anon
-- explicitly. Without this line the revoke is untestable: anon would never
-- have held a grant in the first place, and removing the revoke would look
-- harmless when in production it exposes every company's vendor names.
alter default privileges in schema public grant all on tables to anon, authenticated;
`);

const root = new URL('../../supabase/migrations/', import.meta.url);
let table = await readFile(new URL('20261113030000_payment_request_vendor_suggestions.sql', root), 'utf8');
let flag = await readFile(new URL('20261113040000_nav_profile_in_entity_meta.sql', root), 'utf8');
// The comment on entities.meta names columns this fixture does not model.
flag = flag.replace(/comment on column public\.entities\.meta is[\s\S]*?;\n/, '');

if (mutation === 'cross-tenant-read') table = table.replace('for select to authenticated\n  using (company_entity_id = public.active_company_id())', 'for select to authenticated\n  using (true)');
if (mutation === 'member-write') table = table.replaceAll('and public.is_admin_user()', '');
if (mutation === 'anon-read') table = table.replace('revoke all on public.payment_request_vendor_suggestions from anon;', '');
if (mutation === 'no-unique') table = table.replace(/create unique index if not exists payment_request_vendor_suggestions_once[\s\S]*?;/, '');
if (mutation === 'case-dupes') table = table.replace('(company_entity_id, lower(btrim(vendor_name)))', '(company_entity_id, vendor_name)');
if (mutation === 'meta-clobber') flag = flag.replace("set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('nav_profile', 'grandfathered')", "set meta = jsonb_build_object('nav_profile', 'grandfathered')");
if (mutation === 'all-companies') flag = flag.replace("where entity_key = 'baseballism'\n   and entity_type = 'company'\n   and", 'where');

await db.exec(table);
await db.exec(table);   // idempotent
check();

const GF = '00000000-0000-0000-0000-0000000000a1';
const OTHER = '00000000-0000-0000-0000-0000000000b2';
await db.query(`insert into entities(id, entity_key, entity_type, title, meta) values
  ($1,'baseballism','company','Baseballism','{"seeded":true,"integrations":{"shopify":{"enabled":false}}}'::jsonb),
  ($2,'acme','company','Acme','{"invite_id":"x"}'::jsonb)`, [GF, OTHER]);

const people = [
  ['admin-gf',   '10000000-0000-0000-0000-000000000001', GF,    'admin'],
  ['member-gf',  '10000000-0000-0000-0000-000000000002', GF,    'member'],
  ['admin-other','10000000-0000-0000-0000-000000000003', OTHER, 'admin'],
];
for (const [, uid, co, role] of people) {
  await db.query('insert into profiles values ($1,$2)', [uid, co]);
  await db.query('insert into entity_memberships values ($1,$2,$3)', [co, uid, role]);
}
const as = async (uid) => { await db.query("select set_config('test.uid',$1,false)", [uid]); await db.exec('set role authenticated'); };
const done = () => db.exec('reset role');

// ── 1. An admin curates their OWN company's list ──────────────────────────
await as(people[0][1]);
// company_entity_id left out entirely: the stamp trigger is the backstop.
const inserted = await db.query("insert into payment_request_vendor_suggestions(vendor_name) values ('Some Vendor LLC') returning company_entity_id, vendor_name");
assert.equal(inserted.rows[0].company_entity_id, GF); check();
await db.query("insert into payment_request_vendor_suggestions(company_entity_id, vendor_name) values ($1,'A Person- Ambassador')", [GF]); check();
// The same name twice is refused rather than shown twice in the datalist.
await assert.rejects(() => db.query("insert into payment_request_vendor_suggestions(company_entity_id, vendor_name) values ($1,'Some Vendor LLC')", [GF]), /duplicate key|unique/); check();
// The same name in another case, or with surrounding space, is the same entry
// -- one supplier must not appear twice in a datalist.
await assert.rejects(() => db.query("insert into payment_request_vendor_suggestions(company_entity_id, vendor_name) values ($1,'some vendor llc')", [GF]), /duplicate key|unique/); check();
// A blank name is not a suggestion.
await assert.rejects(() => db.query("insert into payment_request_vendor_suggestions(company_entity_id, vendor_name) values ($1,'   ')", [GF]), /check constraint/); check();
// Nor is one stored with space around it, which would sort oddly and read as a
// different supplier from the same name without it.
await assert.rejects(() => db.query("insert into payment_request_vendor_suggestions(company_entity_id, vendor_name) values ($1,' Padded Vendor ')", [GF]), /check constraint/); check();
// Writing into ANOTHER company is refused even for an admin here.
await assert.rejects(() => db.query("insert into payment_request_vendor_suggestions(company_entity_id, vendor_name) values ($1,'Smuggled Vendor')", [OTHER]), /row-level security/); check();
assert.equal((await db.query('select * from payment_request_vendor_suggestions')).rows.length, 2); check();
await done();

// ── 2. An ordinary member READS but cannot curate ─────────────────────────
await as(people[1][1]);
assert.equal((await db.query('select * from payment_request_vendor_suggestions')).rows.length, 2); check();
await assert.rejects(() => db.query("insert into payment_request_vendor_suggestions(company_entity_id, vendor_name) values ($1,'Member Vendor')", [GF]), /row-level security/); check();
assert.equal((await db.query("update payment_request_vendor_suggestions set vendor_name='Renamed' returning *")).rows.length, 0); check();
assert.equal((await db.query('delete from payment_request_vendor_suggestions returning *')).rows.length, 0); check();
await done();

// ── 3. THE POINT OF THE CHANGE: another company reads nothing ─────────────
// This is what the static array could never do. The names were in everyone's
// browser; now a different tenant's signed-in admin sees an empty list.
await as(people[2][1]);
assert.deepEqual((await db.query('select * from payment_request_vendor_suggestions')).rows, []); check();
assert.equal((await db.query('select count(*)::int n from payment_request_vendor_suggestions')).rows[0].n, 0); check();
await done();

// ── 4. anon reads nothing at all ──────────────────────────────────────────
await db.exec('set role anon');
await assert.rejects(() => db.exec('select * from payment_request_vendor_suggestions'), /permission denied/); check();
await done();

// ── 5. The nav profile flag ───────────────────────────────────────────────
await db.exec(flag);
await db.exec(flag);   // idempotent
const meta = async (id) => (await db.query('select meta from entities where id=$1', [id])).rows[0].meta;
assert.equal((await meta(GF)).nav_profile, 'grandfathered'); check();
// The keys that were already there survive: this runs against a live row, and
// replacing meta instead of merging into it would silently turn off that
// company's integrations.
assert.equal((await meta(GF)).seeded, true); check();
assert.equal((await meta(GF)).integrations.shopify.enabled, false); check();
// Every other company is untouched, and so resolves to the standard menu.
assert.equal((await meta(OTHER)).nav_profile, undefined); check();
assert.equal((await meta(OTHER)).invite_id, 'x'); check();
assert.equal((await db.query("select count(*)::int n from entities where meta->>'nav_profile' = 'grandfathered'")).rows[0].n, 1); check();

console.log(`${checks} database assertions passed (real policies and real migrations, synthetic helper/auth fixtures).`);
await db.close();
