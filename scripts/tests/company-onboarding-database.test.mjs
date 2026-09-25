// Founding a NEW tenant, executed against the real migration as real roles.
//
// The scoped ask was "create company + owner membership atomically, with safe
// retries" and "verify isolation". Atomicity is nearly free in a SECURITY
// DEFINER function, so most of what is proven here is the part that is not:
//
//   1. Company creation is INVITE-GATED where the gate actually is. Removing
//      the org-name box from login.html proves nothing -- signUp is a public
//      endpoint and the anon key is published -- so the test signs a user up
//      WITH org_name in the metadata and asserts no company appears.
//   2. A repeated redeem returns the SAME company. This is the failure that
//      atomicity does not cover: the row commits, the response is lost, the
//      user clicks again.
//   3. A non-Pacific timezone is REFUSED, and the refusal names why. A stored
//      setting that 17 sites ignore reads as configured.
//   4. The new owner sees their own company and nothing of Baseballism's, and
//      the existing tenant's view is unchanged by any of it.
//   5. Only a platform admin can mint an invite; an owner_admin of an existing
//      company cannot.
//   6. silo_business_today() is company-aware and still answers Pacific for
//      every existing caller, including one with no active company at all.
//   7. create_entity_with_owner is gone, and was broken before it went.
//
// What this file CANNOT cover: PGlite is one connection, so nothing here can
// force two sessions to interleave. The three concurrency claims -- the invite
// row lock, the profiles FOR UPDATE, and the per-company currency lock -- are
// driven against a real PostgreSQL by scripts/tests/onboarding-concurrency.test.mjs.
// Do not add a "concurrency" assertion here; it would test the sequential case
// and read as coverage.
//
// Mutations (each must make a specific assertion fail):
//   ONBOARDING_MUTATION=signup-founds-org   (handle_new_user keeps org_name)
//   ONBOARDING_MUTATION=retry-creates-new   (redeem ignores an accepted invite)
//   ONBOARDING_MUTATION=tz-anything-goes    (the timezone allowlist is skipped)
//   ONBOARDING_MUTATION=invite-any-admin    (is_admin() mints platform invites)
// Added after the cycle-1 review:
//   ONBOARDING_MUTATION=founding-rewrites-global-role (the has-other-org guard removed)
//   ONBOARDING_MUTATION=currency-one-sided  (the company_settings side of the guard removed)
//   ONBOARDING_MUTATION=helpers-definer     (the date helpers made SECURITY DEFINER again)
// Added after the cycle-2 review:
//   ONBOARDING_MUTATION=founding-reactivates (the disabled-account refusal removed)
//   ONBOARDING_MUTATION=currency-unlocked    (the per-company currency lock removed)
//   ONBOARDING_MUTATION=refusal-only-removed (layer 1 gone, so layer 2 is tested alone)
//   ONBOARDING_MUTATION=declared-insert-unguarded (the guard back to UPDATE-only)
//   ONBOARDING_MUTATION=retry-shape-drift   (the retry path drops entity_key again)
// Added after the cycle-3 review:
//   ONBOARDING_MUTATION=sweep-gate-open     (silo_company_timezone answers for any company)
//   ONBOARDING_MUTATION=sweep-helper-literal (silo_business_timezone back to its own Pacific literal)
//   ONBOARDING_MUTATION=sweep-no-new-zones  (20260924130400's allowlist rows not inserted)
//   ONBOARDING_MUTATION=retry-validates-first (validation moved above the retry branch,
//                                              which is what the page's recovery relies on)
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e && e.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const mutation = process.env.ONBOARDING_MUTATION || '';
assert.ok(['', 'signup-founds-org', 'retry-creates-new', 'tz-anything-goes', 'invite-any-admin',
  'founding-rewrites-global-role', 'currency-one-sided', 'helpers-definer',
  'founding-reactivates', 'currency-unlocked', 'refusal-only-removed',
  'declared-insert-unguarded', 'retry-shape-drift', 'retry-validates-first',
  'sweep-gate-open', 'sweep-helper-literal', 'sweep-no-new-zones'].includes(mutation),
  `Unknown onboarding mutation: ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
const refused = async (fn, pattern, what) => {
  await assert.rejects(fn, pattern, what);
  passed += 1; console.log(`ok ${passed} - refused: ${what}`);
};

async function as(user, fn, role = 'authenticated') {
  await db.exec('set role ' + role);
  await q("select set_config('request.jwt.claim.sub',$1,false)", [user || '']);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const rpc = async (name, args) =>
  Object.values(await one(`select ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args))[0];

// ── Cast ─────────────────────────────────────────────────────────────────────
const blake = randomUUID();          // platform admin, owner of the incumbent
const bbismAdmin = randomUUID();     // ordinary admin of the incumbent
const founder = randomUUID();        // the prospect being onboarded
const stranger = randomUUID();       // signs up with no invite at all
const dualUser = randomUUID();       // a MEMBER of the incumbent who later founds their own company
const bbism = randomUUID();          // the incumbent company

await db.exec(await readFile(new URL('./onboarding-db-bootstrap.sql', import.meta.url), 'utf8'));

// The incumbent tenant, as it stands before any of this runs.
await q(`insert into auth.users(id,email) values ($1,'blake@baseballism.com'),($2,'admin@baseballism.com'),($3,'dual@baseballism.com')`,
  [blake, bbismAdmin, dualUser]);
await q(`insert into public.entities(id,module,entity_type,entity_key,source,title)
         values ($1,'finance_hub','company','baseballism','seed','Baseballism')`, [bbism]);
await q(`update public.profiles set role='owner', department='exec', active_company_id=$2 where id=$1`, [blake, bbism]);
await q(`update public.profiles set role='admin', department='finance', active_company_id=$2 where id=$1`, [bbismAdmin, bbism]);
await q(`insert into public.entity_memberships(entity_id,user_id,role)
         values ($1,$2,'owner_admin'),($1,$3,'admin'),($1,$4,'member')`,
  [bbism, blake, bbismAdmin, dualUser]);
// A plain member of the incumbent, department NULL and role 'user' -- the exact
// profile shape the review's finding 1 turns on.
await q(`update public.profiles set role='user', department=null, active_company_id=$2 where id=$1`,
  [dualUser, bbism]);
await q(`insert into public.silo_chat_audit_log(company_entity_id,created_by,question,status,tool_rounds)
         values ($1,$2,'How did we do yesterday?','ok',3),
                ($1,$2,'And the week?','error',1)`, [bbism, blake]);

// ── The dead function, before it is dropped ─────────────────────────────────
await test('create_entity_with_owner fails on the membership role CHECK (production, 23514)', async () => {
  await as(bbismAdmin, async () => {
    await assert.rejects(
      () => rpc('create_entity_with_owner', ['finance_hub', 'company', 'probe', 'probe', 'Probe', '{}']),
      /entity_memberships_role_check/,
      'the dead function should fail exactly as production does');
  });
  assert.equal((await q(`select 1 from public.entities where entity_key='probe'`)).length, 0,
    'its entity insert must roll back with the failed membership insert');
});

// ── Apply the migration under test ──────────────────────────────────────────
let sql = await readFile(new URL('supabase/migrations/20260918120000_company_onboarding.sql', root), 'utf8');

if (mutation === 'signup-founds-org') {
  // Put the org_name founding branch back into the replacement trigger.
  sql = sql.replace(
    /create or replace function public\.handle_new_user\(\)[\s\S]*?\n\$\$;\n/,
    () => `create or replace function public.handle_new_user() returns trigger
     language plpgsql security definer set search_path to 'public' as $$
     declare v_org_name text; v_key text; v_entity_id uuid;
     begin
       v_org_name := nullif(trim(coalesce(new.raw_user_meta_data->>'org_name','')),'');
       if v_org_name is null then
         insert into public.profiles (id,email,name) values (new.id,new.email,null)
         on conflict (id) do update set email = excluded.email;
         return new;
       end if;
       v_key := trim(both '-' from regexp_replace(lower(v_org_name),'[^a-z0-9]+','-','g'));
       insert into public.entities (module,entity_type,entity_key,source,title,created_by)
       values ('finance_hub','company',v_key,'self_signup',v_org_name,new.id)
       returning id into v_entity_id;
       insert into public.profiles (id,email,role,department,is_active,active_company_id)
       values (new.id,new.email,'owner'::app_role,'exec',true,v_entity_id)
       on conflict (id) do update set role=excluded.role, active_company_id=excluded.active_company_id;
       insert into public.entity_memberships (entity_id,user_id,role)
       values (v_entity_id,new.id,'owner_admin') on conflict do nothing;
       return new;
     end; $$;\n`);
}
if (mutation === 'tz-anything-goes') {
  sql = sql.replace('if v_supported is null or not v_supported then', 'if false then');
  // and let the FK accept it, so the mutation reaches the assertion
  sql = sql.replace('business_timezone text not null references public.supported_business_timezones(tz_name),',
                    'business_timezone text not null,');
}
if (mutation === 'founding-rewrites-global-role') {
  // Restore the unconditional global overwrite the review found.
  sql = sql.replace(/set role = case when v_has_other_org then profiles\.role\s*\n\s*else excluded\.role end,/,
                    () => 'set role = excluded.role,');
  sql = sql.replace(/department = case when v_has_other_org then profiles\.department\s*\n\s*else coalesce\(profiles\.department, excluded\.department\) end,/,
                    () => 'department = coalesce(profiles.department, excluded.department),');
}
if (mutation === 'refusal-only-removed') {
  // Remove ONLY the disabled-account refusal, keeping the is_active
  // preservation. Without this the preservation arm is unreachable -- the
  // refusal stops every case that would exercise it -- so the test asserting
  // it could not fail, which the independent review caught.
  sql = sql.replace(/  select is_active into v_is_active\n    from public\.profiles where id = auth\.uid\(\)\n    for update;\n  if v_is_active is not null and not v_is_active then\n[^\n]*\n  end if;\n/, () => '');
}
if (mutation === 'retry-validates-first') {
  // Validation above the retry branch: the shape the recovery page would break on.
  const marker = "  if v_invite.status = 'accepted' then";
  const before = sql;
  sql = sql.replace(marker, () =>
    "  if nullif(trim(coalesce(p_company, '')), '') is null then\n"
    + "    raise exception 'company name is required';\n"
    + "  end if;\n" + marker);
  assert.notEqual(sql, before, 'retry-validates-first must find the retry branch');
}
if (mutation === 'retry-shape-drift') {
  sql = sql.replace(/\n\s*'entity_key', \(select entity_key from public\.entities where id = v_invite\.created_company_id\),/,
                    () => '');
}
if (mutation === 'declared-insert-unguarded') {
  sql = sql.replace('before insert or update of default_currency on public.company_settings',
                    () => 'before update of default_currency on public.company_settings');
}
if (mutation === 'founding-reactivates') {
  // Drop the refusal AND the preservation, i.e. restore the state cycle 2 found.
  sql = sql.replace(/  select is_active into v_is_active[\s\S]*?  end if;\n/, () => '');
  sql = sql.replace('is_active = case when v_has_other_org then profiles.is_active else true end,',
                    () => 'is_active = true,');
}
if (mutation === 'currency-unlocked') {
  sql = sql.replace(/\n\s*perform pg_advisory_xact_lock\([^;]*\);\n/g, () => '\n');
}
if (mutation === 'currency-one-sided') {
  // Neutralise the company_settings side of the guard, leaving the
  // accounting_settings side intact -- i.e. restore the one-sided invariant.
  // WHEN belongs after FOR EACH ROW; putting it after the ON clause only breaks
  // the SQL, which would "fail" the suite while proving nothing.
  sql = sql.replace(
    'for each row execute function public.check_declared_currency_matches_books();',
    'for each row when (false) execute function public.check_declared_currency_matches_books();');
}
if (mutation === 'helpers-definer') {
  // Mark the date helpers SECURITY DEFINER again and drop the anon revokes --
  // the exact state the review found. Replacer FUNCTIONS, not strings: `$$` in
  // a replacement string is an escape for a literal `$`, which silently
  // corrupts dollar-quoted bodies.
  sql = sql.replace(/returns date language sql stable set search_path/g,
                    () => 'returns date language sql stable security definer set search_path');
  sql = sql.replace('revoke execute on function public.silo_business_today() from public, anon;\nrevoke execute on function public.silo_business_yesterday() from public, anon;',
                    () => '');
}
if (mutation === 'retry-creates-new') {
  sql = sql.replace("if v_invite.status = 'accepted' then", 'if false then');
}
if (mutation === 'invite-any-admin') {
  sql = sql.replace('if not public.is_platform_admin() then\n    raise exception \'not authorized\';\n  end if;\n\n  v_email  := lower',
                    'if not public.is_admin() then\n    raise exception \'not authorized\';\n  end if;\n\n  v_email  := lower');
  sql = sql.replace(/if not public\.is_platform_admin\(\) then/, 'if not public.is_admin() then');
}

await db.exec(sql);
// Idempotency: the repo requires migrations to be safely re-runnable.
if (!mutation) await db.exec(sql);

await test('migration applies, and applies twice', async () => {
  assert.ok(await one(`select 1 from pg_class where relname='platform_invites'`));
  assert.ok(await one(`select 1 from pg_class where relname='company_settings'`));
});

await test('create_entity_with_owner is gone', async () => {
  assert.equal((await q(`select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                          where n.nspname='public' and p.proname='create_entity_with_owner'`)).length, 0);
});

// ── 1. The gate is in the trigger, not the form ─────────────────────────────
await test('signing up with org_name in the metadata founds NO company', async () => {
  await q(`insert into auth.users(id,email,raw_user_meta_data)
           values ($1,'stranger@example.com', jsonb_build_object('org_name','Free Company','name','Stranger'))`,
    [stranger]);
  const ents = await q(`select 1 from public.entities where title='Free Company'`);
  assert.equal(ents.length, 0, 'org_name must not create an entity');
  const p = await one(`select role::text as role, active_company_id from public.profiles where id=$1`, [stranger]);
  assert.equal(p.role, 'user', 'a bare signup must not become an owner');
  assert.equal(p.active_company_id, null, 'a bare signup must have no company');
  assert.equal((await q(`select 1 from public.entity_memberships where user_id=$1`, [stranger])).length, 0);
});

await test('that stranger can read nothing at all', async () => {
  await as(stranger, async () => {
    assert.equal((await q(`select * from public.silo_chat_audit_log`)).length, 0);
    assert.equal((await q(`select * from public.company_settings`)).length, 0);
  });
});

// ── 5. Who may authorize a new company ──────────────────────────────────────
await test('blake is the seeded platform admin; the incumbent admin is not', async () => {
  assert.equal(await as(blake, () => rpc('is_platform_admin', [])), true);
  assert.equal(await as(bbismAdmin, () => rpc('is_platform_admin', [])), false);
});

await refused(
  () => as(bbismAdmin, () => rpc('create_platform_invite', ['prospect@example.com', 'Prospect Co'])),
  /not authorized/,
  'an owner_admin/admin of an existing company cannot mint a company-creation invite');

await refused(
  () => as(stranger, () => rpc('create_platform_invite', ['prospect@example.com', null])),
  /not authorized/,
  'an unaffiliated signed-in user cannot mint one either');

let token;
await test('the platform admin mints an invite', async () => {
  const res = await as(blake, () => rpc('create_platform_invite', ['founder@prospect.com', 'Prospect Co']));
  assert.equal(res.ok, true);
  token = res.token;
  assert.match(token, /^[0-9a-f]{48}$/, 'raw token is returned once, hashed at rest');
  const stored = await one(`select token_hash, status from public.platform_invites where email='founder@prospect.com'`);
  assert.notEqual(stored.token_hash, token, 'the raw token must not be stored');
  assert.equal(stored.status, 'pending');
});

await test('platform_invites is unreadable from the client, by policy AND by grant', async () => {
  await as(founder, async () => {
    await assert.rejects(() => q(`select * from public.platform_invites`), /permission denied/);
  });
});

// The prospect signs up (no invite metadata -- the invite is redeemed after).
await q(`insert into auth.users(id,email,raw_user_meta_data)
         values ($1,'founder@prospect.com', jsonb_build_object('name','Dana Founder'))`, [founder]);

await refused(
  () => as(stranger, () => rpc('redeem_platform_invite', [token, 'Stolen Co', 'America/Los_Angeles', 'USD'])),
  /different email address/,
  'an invite is bound to its email -- a third party holding the token cannot use it');

// ── 3. The timezone refusal ─────────────────────────────────────────────────
{
  await refused(
    () => as(founder, () => rpc('redeem_platform_invite', [token, 'Prospect Co', 'America/New_York', 'USD'])),
    /Ten database functions and seven sync scripts/,
    'a non-Pacific timezone is refused, and the refusal names what does not honour it');

  await test('the refusal left nothing behind', async () => {
    assert.equal((await q(`select 1 from public.entities where title='Prospect Co'`)).length, 0);
    assert.equal((await q(`select 1 from public.platform_invites where status='accepted'`)).length, 0);
  });
}

await refused(
  () => as(founder, () => rpc('redeem_platform_invite', [token, 'Prospect Co', 'America/Los_Angeles', 'dollars'])),
  /three-letter code/,
  'currency must be a three-letter code');

await refused(
  () => as(founder, () => rpc('redeem_platform_invite', [token, '   ', 'America/Los_Angeles', 'USD'])),
  /company name is required/,
  'a blank company name is refused');

// ── 2. The founding, and the retry ──────────────────────────────────────────
let founded;
await test('redeeming founds the company, the owner profile and the membership in one go', async () => {
  founded = await as(founder, () => rpc('redeem_platform_invite', [token, 'Prospect Co', 'America/Los_Angeles', 'usd']));
  assert.equal(founded.ok, true);
  assert.equal(founded.repeated, false);
  assert.equal(founded.default_currency, 'USD', 'currency is normalised to upper case');

  const ent = await one(`select entity_key, source, title from public.entities where id=$1`, [founded.entity_id]);
  assert.equal(ent.entity_key, 'prospect-co');
  assert.equal(ent.source, 'platform_invite');

  const prof = await one(`select role::text as role, is_active, active_company_id from public.profiles where id=$1`, [founder]);
  assert.equal(prof.role, 'owner');
  assert.equal(prof.is_active, true);
  assert.equal(prof.active_company_id, founded.entity_id, 'the workspace is active immediately -- no picker hop');

  const mem = await one(`select role from public.entity_memberships where user_id=$1 and entity_id=$2`,
    [founder, founded.entity_id]);
  assert.equal(mem.role, 'owner_admin');

  const cs = await one(`select business_timezone, default_currency from public.company_settings where company_entity_id=$1`,
    [founded.entity_id]);
  assert.equal(cs.business_timezone, 'America/Los_Angeles');
  assert.equal(cs.default_currency, 'USD');
});

await test('the new owner passes the gates the app actually checks', async () => {
  assert.equal(await as(founder, () => rpc('is_admin', [])), true, 'so they can invite teammates');
  assert.equal(await as(founder, () => rpc('is_exec_or_owner', [])), true);
  assert.equal(await as(founder, () => rpc('is_owner_admin_of_active_company', [])), true);
  assert.equal(await as(bbismAdmin, () => rpc('is_owner_admin_of_active_company', [])), false,
    'a plain admin of another company does not');
});

await test('the new owner can actually read their own company row', async () => {
  // Not a formality: config.js's ensureActiveCompany() resolves the active
  // company by SELECTing `entities`, and SiloChrome will not render a sidebar
  // without it -- so an owner who cannot read this row lands in a blank app.
  // It works because is_entity_member has no role filter. is_entity_admin and
  // is_owner_admin beside it still test role in ('owner','admin'), which the
  // CHECK constraint has never allowed, so an owner_admin matches NEITHER --
  // pinned here so the day someone "fixes" is_entity_member the same way, this
  // fails loudly instead of the app going blank for every new tenant.
  await as(founder, async () => {
    const rows = await q(`select id, title from public.entities`);
    assert.equal(rows.length, 1, 'exactly their own company, and no other');
    assert.equal(rows[0].id, founded.entity_id);
    assert.equal(rows[0].title, 'Prospect Co');
  });
  await as(bbismAdmin, async () => {
    const rows = await q(`select id from public.entities`);
    assert.deepEqual(rows.map(r => r.id), [bbism], 'and the incumbent still sees only theirs');
  });
});

await test('a repeated redeem returns the SAME company, not a second one', async () => {
  const again = await as(founder, () => rpc('redeem_platform_invite', [token, 'Prospect Co', 'America/Los_Angeles', 'USD']));
  assert.equal(again.repeated, true, 'the retry is reported as a retry, not silently re-run');
  assert.equal(again.entity_id, founded.entity_id);

  // Both success paths must return the SAME KEYS. The caller caches the company
  // from this response and `entity_key` decides which nav profile the first
  // page paints with -- so a retry that omits it caches a half-built company,
  // on the very path this branch exists to serve. `repeated` is the one key
  // that differs in VALUE; the key set does not differ at all.
  const freshKeys = Object.keys(founded).sort();
  const retryKeys = Object.keys(again).sort();
  assert.deepEqual(retryKeys, freshKeys,
    `retry returned a different shape: fresh=${freshKeys} retry=${retryKeys}`);
  assert.equal(again.entity_key, founded.entity_key);
  assert.equal(again.business_timezone, founded.business_timezone);
  assert.equal(again.default_currency, founded.default_currency);
  const n = (await q(`select 1 from public.entities where entity_type='company' and title='Prospect Co'`)).length;
  assert.equal(n, 1, 'exactly one company for one invite, however many times it is redeemed');
});

// The recovery path in v2/company-onboarding.html sends NULL for all three
// creation inputs, because it is not creating anything -- it is asking for a
// company that already exists and already has its own settings. That is only
// safe because the retry branch returns BEFORE any of the validations, and
// nothing said so out loud. It does now: if the ordering is ever changed, this
// fails here rather than as a founder stuck on a page that cannot recover.
await test('a retry succeeds on inputs a fresh creation would reject outright', async () => {
  const again = await as(founder, () => rpc('redeem_platform_invite', [token, null, null, null]));
  assert.equal(again.repeated, true);
  assert.equal(again.entity_id, founded.entity_id);
  assert.equal(again.business_timezone, founded.business_timezone,
    'the company keeps the timezone it was founded with, not the null it was asked about');
  assert.equal(again.default_currency, founded.default_currency);

  // ...and the same inputs on a FRESH invite are still refused, so this is the
  // retry branch short-circuiting rather than validation having gone soft.
  const fresh = await as(blake, () => rpc('create_platform_invite', ['nullprobe@prospect.com', null]));
  const u = randomUUID();
  await q(`insert into auth.users(id,email) values ($1,'nullprobe@prospect.com')`, [u]);
  await assert.rejects(
    () => as(u, () => rpc('redeem_platform_invite', [fresh.token, null, null, null])),
    /company name is required/,
    'a first-time redeem must still validate what it is being asked to create');
});

await test('a retry naming a DIFFERENT company still returns the original', async () => {
  const again = await as(founder, () => rpc('redeem_platform_invite', [token, 'Something Else', 'America/Los_Angeles', 'EUR']));
  assert.equal(again.entity_id, founded.entity_id);
  assert.equal((await q(`select 1 from public.entities where title='Something Else'`)).length, 0,
    'a consumed invite cannot be re-aimed at a new company');
});

// ── Finding 1 (cycle-1 review): founding must not change authority elsewhere ─
await test('founding a company grants NOTHING in the companies you already belong to', async () => {
  // Before: a plain member of the incumbent, no department, no journal rights.
  const before = await as(dualUser, async () => ({
    je: await rpc('can_manage_journal_entries', []),
    exec: await rpc('is_exec_or_owner', []),
    admin: await rpc('is_admin', []),
  }));
  assert.deepEqual(before, { je: false, exec: false, admin: false },
    'a member of the incumbent starts with none of these');

  // They are legitimately invited to found their OWN company, and do.
  const inv = await as(blake, () => rpc('create_platform_invite', ['dual@baseballism.com', 'Dual Co']));
  const own = await as(dualUser, () => rpc('redeem_platform_invite',
    [inv.token, 'Dual Co', 'America/Los_Angeles', 'USD']));
  assert.equal(own.ok, true);

  // In their OWN company they are the owner, by membership.
  await as(dualUser, async () => {
    assert.equal(await rpc('is_owner_admin_of_active_company', []), true);
  });

  // The global fields must be untouched: they belong to another org, so this
  // founding may not rewrite authority that org granted -- or failed to grant.
  const prof = await one(`select role::text as role, department from public.profiles where id=$1`, [dualUser]);
  assert.equal(prof.role, 'user', 'the global role must not be promoted to owner');
  assert.equal(prof.department, null, "the global department must not become 'exec'");

  // And switching back to the incumbent must find exactly what they had.
  await as(dualUser, () => rpc('set_active_company', [bbism]));
  const after = await as(dualUser, async () => ({
    je: await rpc('can_manage_journal_entries', []),
    exec: await rpc('is_exec_or_owner', []),
    admin: await rpc('is_admin', []),
  }));
  assert.deepEqual(after, before,
    'founding elsewhere must not hand anyone journal-entry authority here');

  // Leave them pointed back at their own company.
  await as(dualUser, () => rpc('set_active_company', [own.entity_id]));
});

await test('is_active preservation holds even with the refusal removed', async () => {
  // Two layers guard this, and the outer one hid the inner: with the refusal in
  // place, no disabled account ever reaches the upsert, so an assertion about
  // what the upsert preserves could not fail. That is coverage in name only --
  // exactly what the independent review flagged.
  //
  // So the inner layer is tested under ONBOARDING_MUTATION=refusal-only-removed,
  // which strips the refusal and leaves the preservation. Under the clean build
  // the refusal fires first and the redeem is rejected; under the mutation the
  // redeem proceeds and is_active must STILL be false afterwards. Either way
  // the account must not come out reactivated -- that is the invariant, and it
  // now has a path that can break.
  const u = randomUUID();
  await q(`insert into auth.users(id,email) values ($1,'twolayer@baseballism.com')`, [u]);
  await q(`insert into public.entity_memberships(entity_id,user_id,role) values ($1,$2,'member')`,
    [bbism, u]);
  await q(`update public.profiles set is_active=false, active_company_id=$2 where id=$1`, [u, bbism]);

  const inv = await as(blake, () => rpc('create_platform_invite', ['twolayer@baseballism.com', null]));
  try {
    await as(u, () => rpc('redeem_platform_invite',
      [inv.token, 'Two Layer Co', 'America/Los_Angeles', 'USD']));
    // Reached only when the refusal is gone (the mutation). The preservation
    // arm must then be what keeps the account disabled.
  } catch (e) {
    assert.match(e.message || String(e), /account is disabled/,
      'the only acceptable rejection here is the refusal itself');
  }

  const prof = await one(`select is_active from public.profiles where id=$1`, [u]);
  assert.equal(prof.is_active, false,
    'a disabled multi-org account must never come out of redemption reactivated');
});

await test('a DISABLED account cannot found a company, and A\'s deactivation stands', async () => {
  // profiles.is_active is GLOBAL, like role and department. Company A disables
  // this person; their membership in A is untouched, because deactivation does
  // not remove it. If founding B flipped the one global flag back to true,
  // switching to A would restore everything A took away -- and every
  // authorization helper gates on exactly that flag.
  const disabled = randomUUID();
  await q(`insert into auth.users(id,email) values ($1,'disabled@baseballism.com')`, [disabled]);
  await q(`insert into public.entity_memberships(entity_id,user_id,role) values ($1,$2,'member')`,
    [bbism, disabled]);
  await q(`update public.profiles set is_active=false, active_company_id=$2 where id=$1`, [disabled, bbism]);

  await as(disabled, async () => {
    assert.equal(await rpc('is_admin', []), false, 'disabled means disabled, before we start');
  });

  const inv = await as(blake, () => rpc('create_platform_invite', ['disabled@baseballism.com', null]));
  await assert.rejects(
    () => as(disabled, () => rpc('redeem_platform_invite',
      [inv.token, 'Reactivation Co', 'America/Los_Angeles', 'USD'])),
    /account is disabled/,
    'a disabled account must not be able to found a company');

  const prof = await one(`select is_active from public.profiles where id=$1`, [disabled]);
  assert.equal(prof.is_active, false, "A's deactivation must still stand");
  assert.equal((await q(`select 1 from public.entities where title='Reactivation Co'`)).length, 0,
    'and nothing was created on the way');
});

await test('a founder with NO other company still gets the global owner profile', async () => {
  // The guard is "has another org", not "never set these" -- a genuinely new
  // user must still come out as owner/exec, or the first tenant is crippled.
  const prof = await one(`select role::text as role, department from public.profiles where id=$1`, [founder]);
  assert.equal(prof.role, 'owner');
  assert.equal(prof.department, 'exec');
});

// ── 4. Isolation, both directions ───────────────────────────────────────────
await test('the new owner sees only their own company', async () => {
  await as(founder, async () => {
    assert.equal(await rpc('active_company_id', []), founded.entity_id);
    const settings = await q(`select company_entity_id from public.company_settings`);
    assert.deepEqual(settings.map(r => r.company_entity_id), [founded.entity_id]);
    assert.equal((await q(`select * from public.silo_chat_audit_log`)).length, 0,
      "Baseballism's Ask SILO history must not be visible");
    assert.equal((await q(`select * from public.silo_chat_usage_by_company_v`)).length, 0);
  });
});

await test("the incumbent's view is unchanged by any of this", async () => {
  await as(blake, async () => {
    assert.equal(await rpc('active_company_id', []), bbism);
    const usage = await q(`select company_entity_id, questions, errors, distinct_users
                             from public.silo_chat_usage_by_company_v`);
    assert.equal(usage.length, 1, 'one company, one row');
    assert.equal(usage[0].company_entity_id, bbism);
    assert.equal(Number(usage[0].questions), 2);
    assert.equal(Number(usage[0].errors), 1, "errors is status='error', as silo_chat_health_v defines it");
    const rows = await q(`select company_entity_id from public.company_settings`);
    assert.equal(rows.length, 0, 'Baseballism has no settings row yet, and sees nobody else\'s');
  });
});

await test('the new owner cannot reach into the incumbent by switching', async () => {
  await as(founder, async () => {
    await assert.rejects(() => rpc('set_active_company', [bbism]), /Not a member/);
  });
});

// ── 6. The day boundary ─────────────────────────────────────────────────────
await test('silo_business_today() is company-aware and still answers Pacific today', async () => {
  const pacific = (await one(`select (now() at time zone 'America/Los_Angeles')::date as d`)).d;
  const forFounder = await as(founder, () => rpc('silo_business_today', []));
  assert.deepEqual(forFounder, pacific, "the founded company is Pacific, so nothing moves");

  const forNobody = await as(stranger, () => rpc('silo_business_today', []));
  assert.deepEqual(forNobody, pacific, 'no active company falls back to Pacific, not to null');

  const serviceRole = await as(null, () => rpc('silo_business_today', []), 'service_role');
  assert.deepEqual(serviceRole, pacific, 'a service-role sync keeps the behaviour it has always had');

  const yday = await as(founder, () => rpc('silo_business_yesterday', []));
  assert.equal(new Date(pacific) - new Date(yday), 86400000);
});

await test('the timezone the company stores is the one the day boundary reads', async () => {
  // Prove the wiring, not just the fallback: widen the allowlist the way the
  // sweep eventually will, and the same company's day moves with it.
  await db.exec(`insert into public.supported_business_timezones(tz_name,label)
                 values ('Pacific/Kiritimati','UTC+14, for the wiring test') on conflict do nothing`);
  await db.exec(`update public.company_settings set business_timezone='Pacific/Kiritimati'
                  where company_entity_id='${founded.entity_id}'`);
  const moved = await as(founder, () => rpc('silo_business_today', []));
  const kiritimati = (await one(`select (now() at time zone 'Pacific/Kiritimati')::date as d`)).d;
  assert.deepEqual(moved, kiritimati, 'the helper reads company_settings, not a literal');
  await db.exec(`update public.company_settings set business_timezone='America/Los_Angeles'
                  where company_entity_id='${founded.entity_id}'`);
  await db.exec(`delete from public.supported_business_timezones where tz_name='Pacific/Kiritimati'`);
});

await test('only the company\'s own owner_admin may change its settings', async () => {
  await as(founder, async () => {
    const r = await q(`update public.company_settings set default_currency='CAD'
                        where company_entity_id=$1 returning 1`, [founded.entity_id]);
    assert.equal(r.length, 1);
  });
  await as(bbismAdmin, async () => {
    const r = await q(`update public.company_settings set default_currency='GBP'
                        where company_entity_id=$1 returning 1`, [founded.entity_id]);
    assert.equal(r.length, 0, "another company's admin updates zero rows, silently -- RLS, not an error");
  });
  await as(founder, async () => {
    await q(`update public.company_settings set default_currency='USD' where company_entity_id=$1`, [founded.entity_id]);
  });
});

// ── 5b. Currency reconciliation ─────────────────────────────────────────────
await test('QuickBooks reporting a different currency raises and names both', async () => {
  const conn = randomUUID();
  await assert.rejects(
    () => q(`insert into public.accounting_settings(company_entity_id,qbo_connection_id,base_currency)
             values ($1,$2,'CAD')`, [founded.entity_id, conn]),
    /books in CAD but the company is set up to report in USD/,
    'two currencies for one company must fail loudly, not sit in two tables');
  await q(`insert into public.accounting_settings(company_entity_id,qbo_connection_id,base_currency)
           values ($1,$2,'USD')`, [founded.entity_id, conn]);
  passed += 1; console.log(`ok ${passed} - a matching currency seeds normally`);
});

await test('once books are seeded, the DECLARED currency cannot drift away from them', async () => {
  // The other half of the same invariant. The accounting_settings trigger only
  // fires when accounting_settings is written, so before this the owner could
  // edit company_settings to CAD after seeding in USD and nothing would run --
  // leaving the settings page and the ledger each confidently saying a
  // different thing. A one-sided invariant is not an invariant.
  await as(founder, async () => {
    await assert.rejects(
      () => q(`update public.company_settings set default_currency='CAD' where company_entity_id=$1`,
              [founded.entity_id]),
      /books are already seeded in USD/,
      'changing the declared currency away from the booked one must be refused');
  });
  const still = await one(`select default_currency from public.company_settings where company_entity_id=$1`,
    [founded.entity_id]);
  assert.equal(still.default_currency, 'USD', 'and the stored value is unchanged');
});

await test('a declaration INSERTED against existing books is refused', async () => {
  // The UPDATE-only guard missed this, and it is the state every pre-migration
  // company is in: books already carry a currency, company_settings has no row,
  // and this migration backfills none -- so the FIRST write of a declaration for
  // such a company is an INSERT. Service-role only (clients have no insert
  // grant), which is precisely who would run a backfill.
  const legacy = randomUUID();
  await q(`insert into public.entities(id,module,entity_type,entity_key,source,title)
           values ($1,'finance_hub','company','legacy-co','seed','Legacy Co')`, [legacy]);
  await q(`insert into public.accounting_settings(company_entity_id,qbo_connection_id,base_currency)
           values ($1,$2,'USD')`, [legacy, randomUUID()]);

  await assert.rejects(
    () => q(`insert into public.company_settings(company_entity_id,business_timezone,default_currency)
             values ($1,'America/Los_Angeles','CAD')`, [legacy]),
    /books in USD but the company is set up to report in CAD|books are already seeded in USD/,
    'an INSERT contradicting existing books must be refused, not just an UPDATE');

  const ok = await q(`insert into public.company_settings(company_entity_id,business_timezone,default_currency)
                      values ($1,'America/Los_Angeles','USD') returning 1`, [legacy]);
  assert.equal(ok.length, 1, 'a matching declaration inserts normally');
});

await test('a company with no books may still change its declared currency', async () => {
  // The guard keys on books EXISTING, not on the column being immutable: a
  // tenant that has not connected QuickBooks yet must still be able to correct
  // a currency they picked wrongly at onboarding.
  const other = await as(blake, () => rpc('create_platform_invite', ['nobooks@prospect.com', null]));
  const uid = randomUUID();
  await q(`insert into auth.users(id,email) values ($1,'nobooks@prospect.com')`, [uid]);
  const co2 = await as(uid, () => rpc('redeem_platform_invite',
    [other.token, 'No Books Co', 'America/Los_Angeles', 'USD']));
  await as(uid, async () => {
    const r = await q(`update public.company_settings set default_currency='CAD'
                        where company_entity_id=$1 returning 1`, [co2.entity_id]);
    assert.equal(r.length, 1, 'no books, so nothing to contradict');
  });
});

// ── Settings writes ─────────────────────────────────────────────────────────
await test('a client cannot insert or delete a company_settings row', async () => {
  await as(founder, async () => {
    await assert.rejects(
      () => q(`insert into public.company_settings(company_entity_id,business_timezone,default_currency)
               values ($1,'America/Los_Angeles','USD')`, [bbism]),
      /permission denied/);
    await assert.rejects(
      () => q(`delete from public.company_settings where company_entity_id=$1`, [founded.entity_id]),
      /permission denied/);
  });
});

await test('a revoked invite cannot be redeemed', async () => {
  const res = await as(blake, () => rpc('create_platform_invite', ['second@prospect.com', null]));
  await q(`insert into auth.users(id,email) values ($1,'second@prospect.com')`, [randomUUID()]);
  const inv = await one(`select id from public.platform_invites where email='second@prospect.com'`);
  await as(blake, () => rpc('revoke_platform_invite', [inv.id]));
  const uid = (await one(`select id from auth.users where email='second@prospect.com'`)).id;
  await assert.rejects(
    () => as(uid, () => rpc('redeem_platform_invite', [res.token, 'Second Co', 'America/Los_Angeles', 'USD'])),
    /revoked/);
  passed += 1; console.log(`ok ${passed} - a revoked invite cannot be redeemed`);
});

await test('minting a second invite for one address supersedes the first', async () => {
  const a = await as(blake, () => rpc('create_platform_invite', ['dup@prospect.com', null]));
  await as(blake, () => rpc('create_platform_invite', ['dup@prospect.com', null]));
  const uid = randomUUID();
  await q(`insert into auth.users(id,email) values ($1,'dup@prospect.com')`, [uid]);
  await assert.rejects(
    () => as(uid, () => rpc('redeem_platform_invite', [a.token, 'Dup Co', 'America/Los_Angeles', 'USD'])),
    /revoked/,
    'two live tokens for one address would found two companies');
});

await test('no SECURITY DEFINER function added here is executable by anon', async () => {
  const bad = await q(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                        where n.nspname='public' and p.prosecdef
                          and has_function_privilege('anon', p.oid, 'EXECUTE')
                          and p.proname in ('create_platform_invite','redeem_platform_invite',
                                            'peek_platform_invite','list_platform_invites',
                                            'revoke_platform_invite','is_platform_admin',
                                            'is_owner_admin_of_active_company','silo_business_timezone',
                                            'silo_business_today','silo_business_yesterday')`);
  assert.deepEqual(bad.map(r => r.proname), [],
    'Supabase re-grants EXECUTE to public on every new function; each of these must revoke it');
});

await test('both currency guards take the per-company lock before reading', async () => {
  // Without it the pair is two independent checks, not an invariant: one
  // transaction moves the declaration while another seeds the books, each reads
  // a state the other is about to change, and both pass. The interleaving
  // itself CANNOT be forced here -- PGlite is single-connection -- so this
  // asserts the lock is present and the migration header states plainly that
  // the race is argued rather than demonstrated. That stops the lock being
  // dropped silently, which is the failure this can actually catch.
  const rows = await q(`select p.proname, p.prosrc from pg_proc p
                          join pg_namespace n on n.oid=p.pronamespace
                         where n.nspname='public'
                           and p.proname in ('check_accounting_currency_matches_declared',
                                             'check_declared_currency_matches_books')`);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.match(r.prosrc, /hashtextextended\('silo-company-currency\|/,
      `${r.proname} must serialise on the shared per-company key`);
    assert.doesNotMatch(r.prosrc, /pg_advisory_xact_lock\(\s*hashtext\(/,
      `${r.proname} must use hashtextextended (bigint), not hashtext (int4), ` +
      'so its keys do not crowd the Plaid locks in the one shared advisory space');
  }
  // One key for both sides, or they do not serialise against each other.
  const keys = new Set(rows.map(r => (r.prosrc.match(/'silo-company-currency\|[^']*'/) || [])[0]));
  assert.equal(keys.size, 1, 'both guards must use the SAME lock key');
});

await test('the currency guards are definer, anon-revoked, and still fire', async () => {
  // Revoking EXECUTE on a trigger function is safe only because PostgreSQL
  // checks it at CREATE TRIGGER time, not at fire time. If that were wrong,
  // every currency test above would pass while protecting nothing -- so assert
  // the posture AND that the trigger still raises.
  const rows = await q(`select p.proname, p.prosecdef,
                               has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
                          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                         where n.nspname='public'
                           and p.proname in ('check_accounting_currency_matches_declared',
                                             'check_declared_currency_matches_books')
                         order by p.proname`);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.prosecdef, true, `${r.proname} must be SECURITY DEFINER`);
    assert.equal(r.anon_exec, false, `${r.proname} must not be anon-executable`);
  }

  // Still firing, from both sides, after the revoke.
  await as(founder, async () => {
    await assert.rejects(
      () => q(`update public.company_settings set default_currency='GBP' where company_entity_id=$1`,
              [founded.entity_id]),
      /books are already seeded in USD/,
      'the company_settings guard still fires with EXECUTE revoked');
  });
  await assert.rejects(
    () => q(`update public.accounting_settings set base_currency='GBP' where company_entity_id=$1`,
            [founded.entity_id]),
    /books in GBP but the company is set up to report in USD/,
    'the accounting_settings guard still fires with EXECUTE revoked');
});

await test('the date helpers stay SECURITY INVOKER, and lose their anon grant', async () => {
  // `create or replace` RETAINS existing grants, and production grants anon
  // EXECUTE on both of these (measured: prosecdef=false, anon can_exec=true).
  // Marking them definer would therefore have produced two SECURITY DEFINER
  // functions reachable by anon -- which this migration's OWN new verify check
  // reports CRITICAL. The fixture mirrors Supabase's default grants, so this
  // reproduces that exactly.
  const rows = await q(`select p.proname, p.prosecdef,
                               has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
                               has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
                          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                         where n.nspname='public'
                           and p.proname in ('silo_business_today','silo_business_yesterday')
                         order by p.proname`);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.prosecdef, false, `${r.proname} must stay SECURITY INVOKER`);
    assert.equal(r.anon_exec, false, `${r.proname} must not be callable by anon`);
    assert.equal(r.auth_exec, true, `${r.proname} must stay callable by authenticated`);
  }

  // And the migration's own verify check agrees -- this is the check that would
  // have gone CRITICAL on apply.
  const verify = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
  const start = verify.indexOf("select 'Definer functions reachable by anon' as check_name");
  assert.ok(start > 0, 'the anon/definer check must still exist in verify_v2_schema.sql');
  const stmt = verify.slice(start).split(/;\s*\n/)[0] + ';';
  const row = await one(stmt);
  assert.equal(row.status, 'ok', `anon/definer check: ${row.status}`);
});

await test('a same-named second company gets a distinct key, not a 23505', async () => {
  // entities_unique_key is UNIQUE (module, entity_type, entity_key). The
  // pre-check inside the redeem is advisory; this proves the insert survives a
  // collision rather than handing someone a raw constraint violation halfway
  // through signing up.
  const res = await as(blake, () => rpc('create_platform_invite', ['twin@prospect.com', null]));
  const uid = randomUUID();
  await q(`insert into auth.users(id,email) values ($1,'twin@prospect.com')`, [uid]);
  const twin = await as(uid, () => rpc('redeem_platform_invite', [res.token, 'Prospect Co', 'America/Los_Angeles', 'USD']));
  assert.equal(twin.ok, true);
  assert.notEqual(twin.entity_key, 'prospect-co', 'the second one is suffixed');
  assert.match(twin.entity_key, /^prospect-co-[0-9a-f]{6}$/);
  const titles = await q(`select entity_key from public.entities where title='Prospect Co' order by entity_key`);
  assert.equal(titles.length, 2, 'two distinct companies may share a display name');
});

// ── The verify checks, actually executed ────────────────────────────────────
// verify_v2_schema.sql is only worth anything if its checks run. These four
// are extracted by their own markers and executed against this database, so a
// typo in a check -- or a check that reads 'ok' no matter what -- fails here
// rather than sitting green in the daily drift run.
await test('the four verify_v2_schema checks pass against the migrated schema', async () => {
  const verify = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
  const start = verify.indexOf('-- ── Company onboarding (20260918120000)');
  const end = verify.indexOf('-- Plaid ingestion:');
  assert.ok(start > 0 && end > start, 'the onboarding checks must sit above the Plaid marker');
  const statements = verify.slice(start, end).split(/;\s*\n/).filter(x => /^\s*(--[^\n]*\n)*\s*select/i.test(x));
  assert.equal(statements.length, 4, 'four checks');
  for (const stmt of statements) {
    const row = await one(stmt + ';');
    assert.equal(row.status, 'ok', `${row.check_name}: ${row.status}`);
  }
});

await test('the verify checks FAIL when the thing they guard is broken', async () => {
  // A check that cannot go red is not a check. Break each guard and confirm.
  const verify = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
  const slice = verify.slice(verify.indexOf('-- ── Company onboarding (20260918120000)'),
                             verify.indexOf('-- Plaid ingestion:'));
  const statements = slice.split(/;\s*\n/).filter(x => /^\s*(--[^\n]*\n)*\s*select/i.test(x));

  const check = async (i) => (await one(statements[i] + ';')).status;

  await db.exec(`insert into public.supported_business_timezones(tz_name,label,is_supported)
                 values ('America/Denver','Mountain',false) on conflict (tz_name) do nothing`);
  await db.exec(`update public.company_settings set business_timezone='America/Denver'
                  where company_entity_id='${founded.entity_id}'`);
  assert.match(await check(2), /^CRITICAL/, 'an unhonoured timezone must go CRITICAL');
  await db.exec(`update public.company_settings set business_timezone='America/Los_Angeles'
                  where company_entity_id='${founded.entity_id}'`);
  await db.exec(`delete from public.supported_business_timezones where tz_name='America/Denver'`);

  await db.exec(`delete from public.platform_admins`);
  assert.match(await check(1), /^STALE/, 'an empty platform_admins must go STALE');
  await db.exec(`insert into public.platform_admins(user_id) values ('${blake}')`);

  await db.exec(`grant select on public.platform_invites to authenticated`);
  assert.match(await check(0), /^CRITICAL/, 'a client-reachable platform_invites must go CRITICAL');
  await db.exec(`revoke all on public.platform_invites from authenticated`);

  // The currency guard: get two currencies past the trigger by disabling it,
  // which is exactly the state the check exists to notice after the fact.
  await db.exec(`alter table public.accounting_settings disable trigger trg_accounting_currency_matches_declared`);
  await db.exec(`update public.accounting_settings set base_currency='CAD' where company_entity_id='${founded.entity_id}'`);
  assert.match(await check(3), /^CRITICAL/, 'divergent currencies must go CRITICAL');
  await db.exec(`update public.accounting_settings set base_currency='USD' where company_entity_id='${founded.entity_id}'`);
  await db.exec(`alter table public.accounting_settings enable trigger trg_accounting_currency_matches_declared`);

  for (let i = 0; i < 4; i++) assert.equal(await check(i), 'ok', 'all four restored to ok');
});

// ── The business-timezone sweep (20260924130000 + 130400) ───────────────────
// Applied AFTER everything above, which is written against 20260918120000's
// Pacific-only world (its refusal test and its "unhonoured timezone" verify
// probe both use zones this sweep then supports).
{
  let core = await readFile(new URL('supabase/migrations/20260924130000_business_timezone_core.sql', root), 'utf8');
  let unlock = await readFile(new URL('supabase/migrations/20260924130400_business_timezone_onboarding.sql', root), 'utf8');
  if (mutation === 'sweep-gate-open') {
    const before = core;
    core = core.replace("raise exception 'silo_company_timezone: not a member of company %', p_company_entity_id\n        using errcode = 'insufficient_privilege';", () => 'null;');
    assert.notEqual(core, before, 'sweep-gate-open must find the gate');
  }
  if (mutation === 'sweep-helper-literal') {
    const before = core;
    core = core.replace('select public.silo_company_timezone(public.active_company_id());',
      () => "select 'America/Los_Angeles'::text;");
    assert.notEqual(core, before, 'sweep-helper-literal must find the delegation');
  }
  if (mutation === 'sweep-no-new-zones') {
    const before = unlock;
    unlock = unlock.replace(/insert into public\.supported_business_timezones[\s\S]*?do nothing;\n/, () => '');
    assert.notEqual(unlock, before, 'sweep-no-new-zones must find the insert');
  }
  await db.exec(core);
  await db.exec(unlock);
  if (!mutation) { await db.exec(core); await db.exec(unlock); }
}

await test('sweep: the unlock REFUSES to run while a fixed site still names Pacific', async () => {
  // A stand-in for a site 130000-130300 should have rewritten but did not
  // (drift, a partial apply). Widening the allowlist on top of it is exactly
  // what the unlock must refuse -- and it must leave the allowlist unwidened.
  const unlockSql = await readFile(new URL('supabase/migrations/20260924130400_business_timezone_onboarding.sql', root), 'utf8');
  await db.exec(`create function public.seo_follow_up_window(p uuid, d integer) returns date language sql
                   as $f$ select (now() at time zone 'America/Los_Angeles')::date $f$`);
  await db.exec(`delete from public.supported_business_timezones where tz_name = 'America/Chicago'`);
  try {
    await assert.rejects(() => db.exec(unlockSql), /not unlocking new business timezones: seo_follow_up_window/);
    assert.equal((await q(`select 1 from public.supported_business_timezones where tz_name='America/Chicago'`)).length, 0,
      'a refused unlock adds nothing');
  } finally {
    await db.exec('drop function public.seo_follow_up_window(uuid, integer)');
    await db.exec(unlockSql);   // the real sites are clean here, so it now applies
  }
});

await test('sweep: the four US mainland timezones are offered, Alaska and Hawaii are not', async () => {
  const rows = (await q(`select tz_name from public.supported_business_timezones where is_supported order by tz_name`))
    .map(r => r.tz_name);
  assert.deepEqual(rows, ['America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/New_York', 'America/Phoenix']);
});

let eastern;
const easternFounder = randomUUID();
await test('sweep: an Eastern company can be founded and stores Eastern', async () => {
  const res = await as(blake, () => rpc('create_platform_invite', ['east@prospect.com', 'Eastern Co']));
  await q(`insert into auth.users(id,email) values ($1,'east@prospect.com')`, [easternFounder]);
  eastern = await as(easternFounder, () => rpc('redeem_platform_invite', [res.token, 'Eastern Co', 'America/New_York', 'USD']));
  assert.equal(eastern.ok, true);
  const cs = await one(`select business_timezone from public.company_settings where company_entity_id=$1`, [eastern.entity_id]);
  assert.equal(cs.business_timezone, 'America/New_York');
});

await refused(
  async () => {
    const res = await as(blake, () => rpc('create_platform_invite', ['aloha@prospect.com', null]));
    const uid = randomUUID();
    await q(`insert into auth.users(id,email) values ($1,'aloha@prospect.com')`, [uid]);
    await as(uid, () => rpc('redeem_platform_invite', [res.token, 'Aloha Co', 'Pacific/Honolulu', 'USD']));
  },
  /does not support Pacific\/Honolulu as a business timezone yet/,
  'sweep: a zone west of Pacific is still refused, with a message that no longer claims the sweep is unfinished');

await test("sweep: an Eastern company's day boundary is Eastern, the incumbent's stays Pacific", async () => {
  const ny = (await one(`select (now() at time zone 'America/New_York')::date as d`)).d;
  const la = (await one(`select (now() at time zone 'America/Los_Angeles')::date as d`)).d;
  assert.deepEqual(await as(easternFounder, () => rpc('silo_business_timezone', [])), 'America/New_York');
  assert.deepEqual(await as(easternFounder, () => rpc('silo_business_today', [])), ny);
  assert.deepEqual(await as(blake, () => rpc('silo_business_today', [])), la, 'Baseballism has no settings row: Pacific');
  assert.equal(await as(null, () => rpc('silo_company_timezone', [eastern.entity_id]), 'service_role'), 'America/New_York',
    'a service-role sync can resolve any company');
  assert.equal(await as(null, () => rpc('silo_company_timezone', [null]), 'service_role'), 'America/Los_Angeles',
    'a null company falls back to Pacific, never null');
});

await refused(
  () => as(blake, () => rpc('silo_company_timezone', [eastern.entity_id])),
  /not a member of company/,
  "sweep: a signed-in caller cannot ask about a company they do not belong to");

await test('sweep: the Pacific literal lives in exactly one public function', async () => {
  const rows = await q(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                         where n.nspname='public' and p.prokind='f' and p.prosrc like '%America/Los_Angeles%'
                         order by 1`);
  const names = rows.map(r => r.proname);
  assert.ok(names.includes('silo_company_timezone'));
  for (const n of ['silo_business_timezone', 'redeem_platform_invite']) {
    assert.ok(!names.includes(n), `${n} must not carry its own Pacific literal`);
  }
});

console.log(`\n1..${passed}`);
await db.close();
