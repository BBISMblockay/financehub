// Customer account onboarding, executed against the real migration as real
// roles.
//
// The properties proven here are the ones that make this safe to put on the
// open internet, since the form is filled in by somebody with no SILO login
// and the function behind it holds the service-role key:
//
//   1. THE TOKEN IS THE WHOLE AUTHORIZATION, AND IT IS SPENT. An onboarding
//      link works once; the card step runs on a separate, short-lived
//      continuation. A replay after approval reopens nothing.
//   2. TAX DATA IS NARROWER THAN THE DIRECTORY. A colleague who can look up a
//      ship-to address cannot read the EIN or pull the seller's permit. This
//      is the reason the tax profile is a separate table at all, so it is
//      asserted rather than assumed -- including through the storage policy.
//   3. AN APPLICANT CANNOT GRANT THEMSELVES TERMS. approved_payment_terms,
//      credit_limit and price_tier are not writable from a submission at all;
//      approve_customer_account() is their only writer.
//   4. "SAME AS" IS A POINTER. The constraints make a cycle unrepresentable
//      and a half-filled pointer row impossible, so the resolving view can be
//      two joins and can never loop.
//   5. A RETRY DOES NOT SAVE A SECOND CARD OR FOUND A SECOND CUSTOMER. The
//      lost response is the retry that actually happens.
//   6. A MISMATCHED WEBHOOK WRITES NOTHING. A delivery naming another
//      company's account, or a Stripe customer this account is not bound to,
//      is refused rather than attributed.
//
// Mutations (each must make a specific assertion fail):
//   CUSTOMER_DB_MUTATION=tax-open           (the tax profile uses the directory's gate)
//   CUSTOMER_DB_MUTATION=invites-readable   (a select policy on the token table)
//   CUSTOMER_DB_MUTATION=submit-takes-terms (the submission writes approved terms)
//   CUSTOMER_DB_MUTATION=submit-after-approval (an approved account can be resubmitted)
//   CUSTOMER_DB_MUTATION=token-not-consumed (the onboarding token survives submission)
//   CUSTOMER_DB_MUTATION=claim-unguarded    (the card claim always succeeds)
//   CUSTOMER_DB_MUTATION=claim-steals-session (a claim holding a session is stolen on a timer)
//   CUSTOMER_DB_MUTATION=release-no-bump    (a release does not rotate the attempt)
//   CUSTOMER_DB_MUTATION=webhook-any-company (a delivery for another company is written)
//   CUSTOMER_DB_MUTATION=webhook-any-customer (a mismatched Stripe customer is written)
//   CUSTOMER_DB_MUTATION=rebind-allowed     (an account may be re-pointed at a second customer)
//   CUSTOMER_DB_MUTATION=storage-bucket-only (the object policy gates on bucket_id alone)
//   CUSTOMER_DB_MUTATION=public-rpc-granted (the public-path RPCs keep their default grants)
// Added after the cycle-1 independent review:
//   CUSTOMER_DB_MUTATION=table-writable   (blanket client UPDATE on customer_accounts restored)
//   CUSTOMER_DB_MUTATION=owner-any-company (the session-owner lookup ignores the company)
// Added after the cycle-2 independent review:
//   CUSTOMER_DB_MUTATION=activity-every-call (the capture is logged on every delivery)
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e && e.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { splitSqlStatements } from '../lib/sql-statements.mjs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const mutation = process.env.CUSTOMER_DB_MUTATION || '';
assert.ok([
  '', 'tax-open', 'invites-readable', 'submit-takes-terms', 'submit-after-approval',
  'token-not-consumed', 'claim-unguarded', 'claim-steals-session', 'release-no-bump',
  'webhook-any-company',
  'webhook-any-customer', 'rebind-allowed', 'storage-bucket-only', 'public-rpc-granted',
  'table-writable', 'owner-any-company', 'activity-every-call',
  // The open door.
  'open-default-on', 'open-ignores-switch', 'open-allows-duplicate',
  'open-trusts-type', 'helper-client-callable',
].includes(mutation), `Unknown mutation: ${mutation}`);

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

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ── Cast ────────────────────────────────────────────────────────────────────
const blake = randomUUID();    // owner_admin, department exec -- may invoice
const finance = randomUUID();  // membership admin, department finance -- may invoice
const ops = randomUUID();      // membership admin, department ops -- may NOT invoice
const rival = randomUUID();    // owner_admin of company B
const companyA = randomUUID();
const companyB = randomUUID();

await db.exec(await readFile(new URL('scripts/tests/stripe-db-bootstrap.sql', root), 'utf8'));
await db.exec(await readFile(
  new URL('supabase/migrations/20260919120000_stripe_billing_and_connect.sql', root), 'utf8'));
await db.exec(await readFile(
  new URL('scripts/tests/customer-onboarding-bootstrap.sql', root), 'utf8'));

await q(`insert into auth.users(id,email) values
  ($1,'blake@baseballism.com'),($2,'finance@baseballism.com'),
  ($3,'ops@baseballism.com'),($4,'owner@rival.test')`, [blake, finance, ops, rival]);
await q(`insert into public.entities(id,module,entity_type,entity_key,source,title) values
  ($1,'finance_hub','company','baseballism','seed','Baseballism'),
  ($2,'finance_hub','company','rival','seed','Rival Co')`, [companyA, companyB]);
await q(`insert into public.profiles(id,email,role,department,active_company_id) values
  ($1,'blake@baseballism.com','owner','exec',$5),
  ($2,'finance@baseballism.com','admin','finance',$5),
  ($3,'ops@baseballism.com','admin','ops',$5),
  ($4,'owner@rival.test','owner','exec',$6)`,
  [blake, finance, ops, rival, companyA, companyB]);
await q(`insert into public.entity_memberships(entity_id,user_id,role) values
  ($1,$3,'owner_admin'),($1,$4,'admin'),($1,$5,'admin'),($2,$6,'owner_admin')`,
  [companyA, companyB, blake, finance, ops, rival]);

// ── Apply the migrations under test ─────────────────────────────────────────
// Both are read BEFORE any mutation is applied, because 20260921120000
// REDEFINES submit_customer_account and moves its body into a shared helper.
// A mutation patched into the older file's copy would simply be overwritten by
// the newer definition, and String.replace with no match is silent -- so the
// guard would quietly stop being tested while the suite still passed. That is
// exactly what happened to submit-takes-terms, submit-after-approval and
// token-not-consumed when the refactor landed; CI caught it only because the
// mutation loop asserts each one still fails the suite.
//
// patch() therefore applies to whichever file contains the text, and RAISES
// when neither does.
let sql = await readFile(
  new URL('supabase/migrations/20260919140000_customer_account_onboarding.sql', root), 'utf8');
let openSql = await readFile(
  new URL('supabase/migrations/20260921120000_open_customer_applications.sql', root), 'utf8');

function patch(target, replacement) {
  // Some mutations target a whole policy or DO block by regex rather than by
  // literal text, so membership is tested by attempting the replacement and
  // comparing -- String.prototype.includes throws on a RegExp, and testing
  // with it was itself a false "caught" on three mutations.
  let hit = false;
  const applied = (before) => {
    const after = before.replace(target, replacement);
    if (after !== before) hit = true;
    return after;
  };
  sql = applied(sql);
  openSql = applied(openSql);
  assert.ok(hit,
    `mutation ${mutation}: its target text is in neither migration, so it would `
    + 'have changed nothing and the guard it removes would be untested');
}

if (mutation === 'tax-open') {
  // The tempting simplification: gate the tax profile like the directory.
  patch(
    `create policy customer_account_tax_profiles_select on public.customer_account_tax_profiles
  for select to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_client_invoices());`,
    `create policy customer_account_tax_profiles_select on public.customer_account_tax_profiles
  for select to authenticated
  using (company_entity_id = public.active_company_id());`);
}
if (mutation === 'invites-readable') {
  sql += `
create policy customer_account_invites_select on public.customer_account_invites
  for select to authenticated using (company_entity_id = public.active_company_id());`;
}
if (mutation === 'submit-takes-terms') {
  patch(
    `         applicant_notes = nullif(btrim(coalesce(p_payload->>'applicant_notes', '')), ''),`,
    `         applicant_notes = nullif(btrim(coalesce(p_payload->>'applicant_notes', '')), ''),
         approved_payment_terms = coalesce(nullif(btrim(coalesce(p_payload->>'approved_payment_terms','')),''), approved_payment_terms),
         credit_limit = coalesce((p_payload->>'credit_limit')::numeric, credit_limit),`);
}
if (mutation === 'submit-after-approval') {
  patch(
    `  if v_account.status not in ('invited','submitted') then`,
    `  if false then`);
}
if (mutation === 'token-not-consumed') {
  patch(
    `  update public.customer_account_invites
     set status = 'consumed', consumed_at = now()
   where id = v_tok.invite_id;`, '');
}
if (mutation === 'claim-unguarded') {
  // Check-then-act, from the caller's point of view: every request is told to
  // create a session.
  patch(
    `     and (
       card_setup_status in ('not_started','abandoned')
       -- A stale claim that never got as far as recording a session: the
       -- caller was killed mid-flight. Ten minutes is far longer than any
       -- Stripe call this makes. A claim WITH a session id is deliberately
       -- excluded -- that one is resolved by asking Stripe, never by a timer.
       or (card_setup_session_id is null
           and card_setup_claimed_at < now() - interval '10 minutes')
     )`, '');
}
if (mutation === 'claim-steals-session') {
  // The rule the Billing surface needed a correction to get right: a claim
  // that recorded a session is resolved by asking Stripe, never by a timer.
  patch(
    `       or (card_setup_session_id is null
           and card_setup_claimed_at < now() - interval '10 minutes')`,
    `       or (card_setup_claimed_at < now() - interval '10 minutes')`);
}
if (mutation === 'release-no-bump') {
  patch('         card_setup_attempt = card_setup_attempt + 1\n', '');
}
if (mutation === 'webhook-any-company') {
  patch(
    `  if v_account.company_entity_id <> p_company then
    return json_build_object('ok', false, 'reason', 'company_mismatch');
  end if;`, '');
}
if (mutation === 'webhook-any-customer') {
  patch(
    `  if v_account.stripe_customer_id is distinct from p_customer_id then
    return json_build_object('ok', false, 'reason', 'customer_mismatch');
  end if;`, '');
}
if (mutation === 'rebind-allowed') {
  patch(
    `  if v_existing is not null and v_existing <> p_customer_id then
    raise exception 'customer account % is already bound to Stripe customer %',
      p_account_id, v_existing;
  end if;`, '');
}
if (mutation === 'storage-bucket-only') {
  // How schedule-item-files actually shipped: named "by company", gating on
  // nothing but the bucket.
  patch(
    /create policy "customer account files readable with the tax profile"\n  on storage\.objects for select to authenticated\n  using \([\s\S]*?\n  \);/,
    `create policy "customer account files readable with the tax profile"
  on storage.objects for select to authenticated
  using (bucket_id = 'customer-account-files');`);
}
if (mutation === 'public-rpc-granted') {
  patch(
    /do \$\$\ndeclare r text;\nbegin\n  for r in select unnest\(array\[\n    'customer_onboarding_resolve_token\(text,text\)',[\s\S]*?\nend;\n\$\$;/,
    '-- mutated: the public-path revokes are gone, so Supabase defaults stand');
}

if (mutation === 'table-writable') {
  // The shape this started as: one `for all` policy, and Supabase's default
  // table grants left in place behind it.
  patch(
    /revoke insert, update, delete on public\.customer_accounts from authenticated;[\s\S]*?on public\.customer_accounts to authenticated;/,
    'grant insert, update, delete on public.customer_accounts to authenticated;');
}
if (mutation === 'activity-every-call') {
  patch(
    "  if v_account.card_setup_status is distinct from 'succeeded' then",
    '  if true then');
}
if (mutation === 'owner-any-company') {
  patch("     and ca.company_entity_id = p_company;", "     ;");
}

await db.exec(sql);

if (mutation === 'open-default-on') {
  // The tempting simplification: default the switch to true so the feature
  // "just works". That silently gives every tenant a public write endpoint.
  patch(
    'add column if not exists open_customer_applications boolean not null default false;',
    'add column if not exists open_customer_applications boolean not null default true;');
}
if (mutation === 'open-ignores-switch') {
  // Resolve the company without consulting company_settings at all.
  patch('     and cs.open_customer_applications\n', '');
}
if (mutation === 'open-allows-duplicate') {
  patch("    raise exception 'open_duplicate' using errcode = '28000';",
    '    null;');
}
if (mutation === 'open-trusts-type') {
  patch(
    "  if v_type not in ('wholesale','retail','distributor','licensee','other') then\n    raise exception 'open_bad_type' using errcode = '28000';\n  end if;",
    '');
}
if (mutation === 'helper-client-callable') {
  // The revoke is the boundary: Supabase grants EXECUTE on new public
  // functions to authenticated by default.
  patch(
    'revoke all on function public.apply_customer_account_payload(uuid, jsonb) from authenticated;',
    '');
}

await db.exec(openSql);

// ── Fixtures ────────────────────────────────────────────────────────────────
await q(`insert into public.stripe_connect_accounts
  (company_entity_id, stripe_account_id, charges_enabled, payouts_enabled, details_submitted)
  values ($1,'acct_tenant',true,true,true)`, [companyA]);

async function invite(email, who = finance) {
  return await as(who, async () =>
    (await one(`select public.create_customer_account_invite($1,$2,'wholesale') as r`,
      [email, 'Dugout Sports LLC'])).r);
}

const FORM = {
  legal_name: 'Dugout Sports LLC',
  dba_name: 'Dugout',
  federal_ein: '12-3456789',
  resale_tax_id: 'CA-998877',
  addresses: [
    { address_type: 'business', street1: '1 Main St', city: 'Portland',
      region: 'OR', postal_code: '97201', country: 'US' },
    { address_type: 'shipping', same_as_address_type: 'business', attention_name: 'Receiving' },
    { address_type: 'billing', same_as_address_type: 'shipping' },
  ],
  contacts: [
    { contact_type: 'primary', first_name: 'Sam', last_name: 'Reed',
      title: 'Owner', email: 'sam@dugout.test', phone: '503-555-0101' },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 1. The token
// ════════════════════════════════════════════════════════════════════════════

await test('an invite mints a token that is stored only as a hash', async () => {
  const inv = await invite('buyer@dugout.test');
  assert.ok(inv.token && inv.token.length >= 32);
  const row = await one(
    `select token_hash, status, purpose from public.customer_account_invites
      where customer_account_id = $1`, [inv.customer_account_id]);
  assert.equal(row.token_hash, sha256(inv.token));
  assert.notEqual(row.token_hash, inv.token);
  assert.equal(row.purpose, 'onboarding');
});

await test('the token table is unreadable by every client, owner included', async () => {
  for (const who of [blake, finance, ops]) {
    const rows = await as(who, () => q('select * from public.customer_account_invites'));
    assert.equal(rows.length, 0,
      'a token table a client can select is not a token table, even hashed');
  }
});

await test('a user who cannot invoice cannot mint an onboarding link', async () => {
  await refused(
    () => as(ops, () => q(`select public.create_customer_account_invite('x@y.test',null,'wholesale')`)),
    /not authorized/, 'an ops user minting a customer onboarding link');
});

await test('an expired token resolves as expired and is marked so', async () => {
  const inv = await invite('late@dugout.test');
  await q(`update public.customer_account_invites set expires_at = now() - interval '1 day'
            where customer_account_id = $1`, [inv.customer_account_id]);
  const r = await one(`select * from public.customer_onboarding_resolve_token($1,'onboarding')`,
    [inv.token]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
  const after = await one(`select status from public.customer_account_invites
                            where customer_account_id = $1`, [inv.customer_account_id]);
  assert.equal(after.status, 'expired');
});

await test('a token for the wrong purpose does not resolve', async () => {
  const inv = await invite('purpose@dugout.test');
  const r = await one(`select * from public.customer_onboarding_resolve_token($1,'card_setup')`,
    [inv.token]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_found',
    'an onboarding link must not double as a card-setup link');
});

await test('a garbage token resolves to nothing rather than erroring', async () => {
  for (const t of ['', 'not-a-token', 'x'.repeat(200)]) {
    const r = await one(`select * from public.customer_onboarding_resolve_token($1,'onboarding')`, [t]);
    assert.equal(r.ok, false);
    assert.equal(r.customer_account_id, null);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Submission
// ════════════════════════════════════════════════════════════════════════════

const main = await invite('main@dugout.test');
let continuation = null;

await test('submitting consumes the onboarding token and issues a continuation', async () => {
  const r = await one(`select public.submit_customer_account($1,$2::jsonb) as r`,
    [main.token, JSON.stringify(FORM)]);
  continuation = r.r.continuation_token;
  assert.ok(continuation);
  assert.notEqual(continuation, main.token);

  const rows = await q(`select purpose, status, expires_at from public.customer_account_invites
                         where customer_account_id = $1 order by purpose`,
    [main.customer_account_id]);
  const onboarding = rows.find((x) => x.purpose === 'onboarding');
  const card = rows.find((x) => x.purpose === 'card_setup');
  assert.equal(onboarding.status, 'consumed');
  assert.equal(card.status, 'pending');
  // The continuation is short-lived: the link in an inbox must not be the one
  // that can open a payment-method capture.
  assert.ok(new Date(card.expires_at) - new Date(onboarding.expires_at) < 0,
    'the card-setup token must expire well before the onboarding one would have');
});

await test('the consumed onboarding token cannot be replayed', async () => {
  await refused(
    () => q(`select public.submit_customer_account($1,$2::jsonb)`,
      [main.token, JSON.stringify(FORM)]),
    /invite_consumed/, 'replaying a spent onboarding link');
});

await test('a submission cannot set approved terms, a credit limit or a price tier', async () => {
  const inv = await invite('sneaky@dugout.test');
  await q(`select public.submit_customer_account($1,$2::jsonb)`, [inv.token, JSON.stringify({
    ...FORM,
    approved_payment_terms: 'Net 90',
    credit_limit: 9999999,
    price_tier: 'platinum',
    stripe_customer_id: 'cus_attacker',
    status: 'approved',
  })]);
  const row = await one(`select status, approved_payment_terms, credit_limit, price_tier,
                                stripe_customer_id
                           from public.customer_accounts where id = $1`, [inv.customer_account_id]);
  assert.equal(row.status, 'submitted', 'a submission cannot approve itself');
  assert.equal(row.approved_payment_terms, null);
  assert.equal(row.credit_limit, null);
  assert.equal(row.price_tier, null);
  assert.equal(row.stripe_customer_id, null);
});

await test('the applicant\'s REQUESTED terms are kept -- a different fact', async () => {
  const inv = await invite('asks@dugout.test');
  await q(`select public.submit_customer_account($1,$2::jsonb)`,
    [inv.token, JSON.stringify({ ...FORM, requested_payment_terms: 'Net 60' })]);
  const row = await one(`select requested_payment_terms, approved_payment_terms
                           from public.customer_accounts where id = $1`, [inv.customer_account_id]);
  assert.equal(row.requested_payment_terms, 'Net 60');
  assert.equal(row.approved_payment_terms, null,
    'asking for terms is not being granted them');
});

await test('resubmitting before approval replaces addresses rather than merging them', async () => {
  const inv = await invite('revise@dugout.test');
  await q(`select public.submit_customer_account($1,$2::jsonb)`, [inv.token, JSON.stringify(FORM)]);
  // The applicant realises billing is NOT the same as shipping after all and
  // drops the separate row. A merge would leave the old pointer standing.
  await q(`update public.customer_account_invites set status='pending', consumed_at=null
            where customer_account_id=$1 and purpose='onboarding'`, [inv.customer_account_id]);
  await q(`select public.submit_customer_account($1,$2::jsonb)`, [inv.token, JSON.stringify({
    ...FORM,
    addresses: FORM.addresses.filter((a) => a.address_type !== 'billing'),
  })]);
  const types = (await q(`select address_type from public.customer_account_addresses
                           where customer_account_id = $1 order by address_type`,
    [inv.customer_account_id])).map((r) => r.address_type);
  assert.deepEqual(types, ['business', 'shipping']);
});

await test('an approved application cannot be resubmitted', async () => {
  const inv = await invite('done@dugout.test');
  await q(`select public.submit_customer_account($1,$2::jsonb)`, [inv.token, JSON.stringify(FORM)]);
  await as(finance, () => q(`select public.approve_customer_account($1,'Net 30',5000,'tier-1')`,
    [inv.customer_account_id]));
  await q(`update public.customer_account_invites set status='pending'
            where customer_account_id=$1 and purpose='onboarding'`, [inv.customer_account_id]);
  await refused(
    () => q(`select public.submit_customer_account($1,$2::jsonb)`, [inv.token, JSON.stringify(FORM)]),
    /account_approved/, 'a late replay reopening a decided application');
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Approval is the only writer of internal terms
// ════════════════════════════════════════════════════════════════════════════

await test('approval records the terms, the approver and the time', async () => {
  const inv = await invite('approve@dugout.test');
  await q(`select public.submit_customer_account($1,$2::jsonb)`, [inv.token, JSON.stringify(FORM)]);
  await as(finance, () => q(`select public.approve_customer_account($1,'Net 30',7500,'tier-2')`,
    [inv.customer_account_id]));
  const row = await one(`select status, approved_payment_terms, credit_limit, price_tier,
                                approved_by, approved_at
                           from public.customer_accounts where id=$1`, [inv.customer_account_id]);
  assert.equal(row.status, 'approved');
  assert.equal(row.approved_payment_terms, 'Net 30');
  assert.equal(Number(row.credit_limit), 7500);
  assert.equal(row.price_tier, 'tier-2');
  assert.equal(row.approved_by, finance);
  assert.ok(row.approved_at);
});

await test('a user who cannot invoice cannot approve', async () => {
  const inv = await invite('nope@dugout.test');
  await q(`select public.submit_customer_account($1,$2::jsonb)`, [inv.token, JSON.stringify(FORM)]);
  await refused(
    () => as(ops, () => q(`select public.approve_customer_account($1,'Net 30',1,'x')`,
      [inv.customer_account_id])),
    /not authorized/, 'an ops user approving a wholesale account');
});

await test('an application that was never submitted cannot be approved', async () => {
  const inv = await invite('unsubmitted@dugout.test');
  await refused(
    () => as(finance, () => q(`select public.approve_customer_account($1,null,null,null)`,
      [inv.customer_account_id])),
    /only a submitted application/, 'approving an application nobody filled in');
});

await test('rejecting kills every live link for that application', async () => {
  const inv = await invite('reject@dugout.test');
  await q(`select public.submit_customer_account($1,$2::jsonb)`, [inv.token, JSON.stringify(FORM)]);
  await as(finance, () => q(`select public.reject_customer_account($1,'no resale certificate')`,
    [inv.customer_account_id]));
  const live = await q(`select 1 from public.customer_account_invites
                         where customer_account_id=$1 and status='pending'`,
    [inv.customer_account_id]);
  assert.equal(live.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Tax data is narrower than the directory
// ════════════════════════════════════════════════════════════════════════════

await test('an ops user sees the customer directory', async () => {
  const rows = await as(ops, () => q(
    `select id from public.customer_accounts where contact_email = 'main@dugout.test'`));
  assert.equal(rows.length, 1, 'a ship-to lookup is ordinary directory access');
});

await test('an ops user does NOT see the EIN or the resale id', async () => {
  const rows = await as(ops, () => q('select * from public.customer_account_tax_profiles'));
  assert.equal(rows.length, 0,
    'looking up an address must not hand over a federal tax id');
  const finRows = await as(finance, () => q(
    `select federal_ein from public.customer_account_tax_profiles
      where customer_account_id = $1`, [main.customer_account_id]));
  assert.equal(finRows[0].federal_ein, '12-3456789');
});

await test('the directory view carries no tax columns at all', async () => {
  const cols = (await q(
    `select column_name from information_schema.columns
      where table_schema='public' and table_name='customer_accounts_v'`)).map((r) => r.column_name);
  for (const leak of ['federal_ein', 'resale_tax_id', 'resale_certificate_path']) {
    assert.ok(!cols.includes(leak), `${leak} must not be joined into the directory view`);
  }
  assert.ok(cols.includes('has_tax_profile'),
    '"is there one" is directory-safe; what is in it is not');
});

await test('a rival company sees none of it', async () => {
  for (const table of [
    'customer_accounts', 'customer_account_addresses',
    'customer_account_contacts', 'customer_account_tax_profiles',
  ]) {
    const rows = await as(rival, () => q(`select * from public.${table}`));
    assert.equal(rows.length, 0, `${table} leaked across companies`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 5. "Same as" is a pointer
// ════════════════════════════════════════════════════════════════════════════

await test('the resolving view follows billing -> shipping -> business', async () => {
  const rows = await as(finance, () => q(
    `select address_type, resolved_from, street1, city, attention_name
       from public.customer_account_addresses_resolved_v
      where customer_account_id = $1 order by address_type`, [main.customer_account_id]));
  const byType = Object.fromEntries(rows.map((r) => [r.address_type, r]));
  assert.equal(byType.business.street1, '1 Main St');
  assert.equal(byType.shipping.street1, '1 Main St');
  // Two hops: billing points at shipping, which points at business.
  assert.equal(byType.billing.street1, '1 Main St');
  assert.equal(byType.billing.resolved_from, 'shipping');
  // The shipping row's OWN attention name survives resolution -- it is part of
  // the label, not of the place it inherited.
  assert.equal(byType.shipping.attention_name, 'Receiving');
});

await test('correcting the business address corrects everything that names it', async () => {
  await as(finance, () => q(
    `update public.customer_account_addresses set street1 = '99 New Rd'
      where customer_account_id = $1 and address_type = 'business'`, [main.customer_account_id]));
  const rows = await as(finance, () => q(
    `select address_type, street1 from public.customer_account_addresses_resolved_v
      where customer_account_id = $1`, [main.customer_account_id]));
  for (const r of rows) {
    assert.equal(r.street1, '99 New Rd',
      'a copy would have fixed one row and left the others wrong');
  }
});

await test('a pointer row carrying a street is refused', async () => {
  await refused(() => as(finance, () => q(
    `insert into public.customer_account_addresses
       (company_entity_id, customer_account_id, address_type, same_as_address_type, street1)
     values ($1,$2,'billing','business','1 Sneaky Way')`,
    [companyA, main.customer_account_id])),
    /pointer_is_empty|unique/, 'a "same as" row that also stores its own street');
});

await test('a cycle is unrepresentable', async () => {
  const inv = await invite('cycle@dugout.test');
  await refused(() => as(finance, () => q(
    `insert into public.customer_account_addresses
       (company_entity_id, customer_account_id, address_type, same_as_address_type)
     values ($1,$2,'business','shipping')`, [companyA, inv.customer_account_id])),
    /business_is_root/, 'the business address deferring to another');
  // Refused by the COLUMN check -- 'billing' is not an allowed pointer target
  // at all, so shipping_defers_to_business never gets to fire on this input.
  // It stays as the second guard for the day somebody widens that column, but
  // the assertion names what actually refuses rather than what was expected to.
  await refused(() => as(finance, () => q(
    `insert into public.customer_account_addresses
       (company_entity_id, customer_account_id, address_type, same_as_address_type)
     values ($1,$2,'shipping','billing')`, [companyA, inv.customer_account_id])),
    /same_as_address_type_check|shipping_defers_to_business/, 'shipping deferring to billing');

  // And the chain is bounded by construction: the only pointer targets the
  // column permits are business and shipping, business can never be a pointer,
  // and nothing may point at itself -- so billing -> shipping -> business is
  // the longest path that exists and the resolving view cannot loop.
  const targets = await one(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'customer_account_addresses_same_as_address_type_check'`);
  assert.match(targets.def, /'business'::text, 'shipping'::text|'business', 'shipping'/);
});

await test('a child row cannot name a different company than its account', async () => {
  // A FRESH account, with no addresses yet: reusing one that already has a
  // business address would trip the (account, type) unique index first and the
  // test would pass without the composite foreign key existing at all.
  const fresh = await invite('fk@dugout.test');
  await refused(() => q(
    `insert into public.customer_account_addresses
       (company_entity_id, customer_account_id, address_type, street1, city, country)
     values ($1,$2,'business','1 Rival Rd','Nowhere','US')`,
    [companyB, fresh.customer_account_id]),
    /account_fk/, 'an address filed under the wrong company');
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Card setup: claim, replay, release
// ════════════════════════════════════════════════════════════════════════════

const card = await invite('card@dugout.test');
await q(`select public.submit_customer_account($1,$2::jsonb)`, [card.token, JSON.stringify(FORM)]);
const cardAccount = card.customer_account_id;

await test('a session cannot be claimed before consent is recorded', async () => {
  const r = await one(`select * from public.claim_customer_card_setup($1)`, [cardAccount]);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'consent_required');
});

await test('consent is recorded with the text, not just a version', async () => {
  await q(`select public.record_customer_account_consent($1,$2,$3)`,
    [cardAccount, '2026-09-19.v1', 'I authorise ... when I am not present ...']);
  const row = await one(`select off_session_consent_at, off_session_consent_version,
                                off_session_consent_text
                           from public.customer_accounts where id=$1`, [cardAccount]);
  assert.ok(row.off_session_consent_at);
  assert.equal(row.off_session_consent_version, '2026-09-19.v1');
  assert.match(row.off_session_consent_text, /not present/,
    'the defensible record is what this person read, not a pointer to it');
});

await test('an open session is reported back rather than a second one allowed', async () => {
  const first = await one(`select * from public.claim_customer_card_setup($1)`, [cardAccount]);
  assert.equal(first.allowed, true);
  assert.equal(first.attempt, 0);

  const noted = await one(`select public.note_customer_card_setup_session($1,'cs_first') as ok`,
    [cardAccount]);
  assert.equal(noted.ok, true);

  const second = await one(`select * from public.claim_customer_card_setup($1)`, [cardAccount]);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'session_open');
  assert.equal(second.existing_session_id, 'cs_first',
    'the caller must be handed the session that exists, not permission to make another');
});

await test('a claim that already holds a session is never stolen on a timer', async () => {
  // Age the claim well past the stale window. It HAS a session id, so the only
  // thing that may resolve it is Stripe's own answer about that session.
  await q(`update public.customer_accounts
              set card_setup_claimed_at = now() - interval '2 hours'
            where id = $1`, [cardAccount]);
  const r = await one(`select * from public.claim_customer_card_setup($1)`, [cardAccount]);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'session_open');
  assert.equal(r.existing_session_id, 'cs_first',
    'that session may still be open in the applicant\'s tab -- a timer must not open a second');
});

await test('a stale claim that never recorded a session is taken over, KEEPING its attempt',
  async () => {
    const stale = await invite('stale@dugout.test');
    await q(`select public.submit_customer_account($1,$2::jsonb)`,
      [stale.token, JSON.stringify(FORM)]);
    await q(`select public.record_customer_account_consent($1,'2026-09-19.v1','...')`,
      [stale.customer_account_id]);
    const first = await one(`select * from public.claim_customer_card_setup($1)`,
      [stale.customer_account_id]);
    assert.equal(first.allowed, true);
    // The caller died before recording a session.
    await q(`update public.customer_accounts
                set card_setup_claimed_at = now() - interval '2 hours'
              where id = $1`, [stale.customer_account_id]);
    const retry = await one(`select * from public.claim_customer_card_setup($1)`,
      [stale.customer_account_id]);
    assert.equal(retry.allowed, true);
    assert.equal(retry.attempt, first.attempt,
      'the dead attempt may have created a session whose answer was lost -- only replaying its key gets that session back, so a takeover must NOT rotate');
  });

await test('releasing a session rotates the attempt so a restart is genuinely new', async () => {
  const attempt = await one(`select public.release_customer_card_setup($1,'cs_first') as a`,
    [companyA]);
  assert.equal(attempt.a, 1,
    'without a rotation the next create replays the dead session\'s idempotency key');
  const row = await one(`select card_setup_status, card_setup_session_id
                           from public.customer_accounts where id=$1`, [cardAccount]);
  assert.equal(row.card_setup_status, 'abandoned');
  assert.equal(row.card_setup_session_id, null);

  const again = await one(`select * from public.claim_customer_card_setup($1)`, [cardAccount]);
  assert.equal(again.allowed, true);
  assert.equal(again.attempt, 1);
});

await test('recording a session only works for a live, unrecorded claim', async () => {
  const noted = await one(`select public.note_customer_card_setup_session($1,'cs_second') as ok`,
    [cardAccount]);
  assert.equal(noted.ok, true);
  // A second write for the same claim lands nowhere: the session id is already
  // recorded, and a late write from a superseded attempt must not replace the
  // one a live attempt just took.
  const again = await one(`select public.note_customer_card_setup_session($1,'cs_late') as ok`,
    [cardAccount]);
  assert.equal(again.ok, false);
  const row = await one(`select card_setup_session_id from public.customer_accounts where id=$1`,
    [cardAccount]);
  assert.equal(row.card_setup_session_id, 'cs_second');
});

await test('an unclaimed account cannot have a session recorded against it', async () => {
  const other = await invite('clash@dugout.test');
  await q(`select public.submit_customer_account($1,$2::jsonb)`,
    [other.token, JSON.stringify(FORM)]);
  const noted = await one(`select public.note_customer_card_setup_session($1,'cs_other') as ok`,
    [other.customer_account_id]);
  assert.equal(noted.ok, false,
    'the claim is what authorises a session, so recording one without it must fail closed');
});

await test('a session id is never shared between two accounts', async () => {
  const other = await invite('clash2@dugout.test');
  await q(`select public.submit_customer_account($1,$2::jsonb)`,
    [other.token, JSON.stringify(FORM)]);
  await q(`select public.record_customer_account_consent($1,'2026-09-19.v1','...')`,
    [other.customer_account_id]);
  await q(`select * from public.claim_customer_card_setup($1)`, [other.customer_account_id]);
  await refused(
    () => q(`select public.note_customer_card_setup_session($1,'cs_second')`,
      [other.customer_account_id]),
    /setup_session_uidx|unique/, 'two accounts claiming one Checkout session');
});

// ════════════════════════════════════════════════════════════════════════════
// 7. The webhook's writer
// ════════════════════════════════════════════════════════════════════════════

await test('a completion for a session nobody claimed writes nothing', async () => {
  const r = await one(`select public.record_customer_card_setup(
    $1,'cs_unknown','seti_x','cus_x','pm_x','visa','4242',4,2030,true) as r`, [companyA]);
  assert.equal(r.r.ok, false);
  assert.equal(r.r.reason, 'no_account_for_session');
});

await test('a completion naming another company writes nothing', async () => {
  const r = await one(`select public.record_customer_card_setup(
    $1,'cs_second','seti_x','cus_x','pm_x','visa','4242',4,2030,true) as r`, [companyB]);
  assert.equal(r.r.ok, false);
  assert.equal(r.r.reason, 'company_mismatch');
  const row = await one(`select card_payment_method_id from public.customer_accounts where id=$1`,
    [cardAccount]);
  assert.equal(row.card_payment_method_id, null);
});

await test('a completion naming a Stripe customer this account is not bound to writes nothing',
  async () => {
    const r = await one(`select public.record_customer_card_setup(
      $1,'cs_second','seti_x','cus_someone_else','pm_x','visa','4242',4,2030,true) as r`,
      [companyA]);
    assert.equal(r.r.ok, false);
    assert.equal(r.r.reason, 'customer_mismatch',
      'attaching a card to the wrong account is the failure this check exists for');
  });

await test('the Stripe customer binding is write-once', async () => {
  await q(`select public.bind_customer_account_stripe_customer($1,'cus_real')`, [cardAccount]);
  // The same id again is fine -- that is a retry.
  await q(`select public.bind_customer_account_stripe_customer($1,'cus_real')`, [cardAccount]);
  await refused(
    () => q(`select public.bind_customer_account_stripe_customer($1,'cus_second')`, [cardAccount]),
    /already bound/, 'a second Stripe customer for one applicant');
});

await test('a matching completion records the card and marks it the invoice default', async () => {
  const r = await one(`select public.record_customer_card_setup(
    $1,'cs_second','seti_1','cus_real','pm_1','visa','4242',4,2030,true) as r`, [companyA]);
  assert.equal(r.r.ok, true);
  const row = await one(`select card_setup_status, card_payment_method_id, card_brand, card_last4,
                                card_exp_month, card_exp_year, card_captured_at,
                                default_payment_method_set_at
                           from public.customer_accounts where id=$1`, [cardAccount]);
  assert.equal(row.card_setup_status, 'succeeded');
  assert.equal(row.card_payment_method_id, 'pm_1');
  assert.equal(row.card_last4, '4242');
  assert.ok(row.card_captured_at);
  assert.ok(row.default_payment_method_set_at);
});

await test('a repeated completion of the same session changes nothing', async () => {
  const before = await one(`select * from public.customer_accounts where id=$1`, [cardAccount]);
  await q(`select public.record_customer_card_setup(
    $1,'cs_second','seti_1','cus_real','pm_1','visa','4242',4,2030,true)`, [companyA]);
  const after = await one(`select * from public.customer_accounts where id=$1`, [cardAccount]);
  assert.equal(String(after.card_captured_at), String(before.card_captured_at),
    'the capture time must not move on a redelivery');
  assert.equal(String(after.default_payment_method_set_at),
    String(before.default_payment_method_set_at));
});

await test('one card is ONE card_captured entry, however many deliveries arrive', async () => {
  // The handler rethrows a transient failure to set the invoice default so
  // Stripe redelivers -- and the redelivery re-runs this function. Logging on
  // every call would put several capture entries in the audit trail for a
  // single card, which misrepresents the one thing that trail exists to state.
  //
  // Two shapes, because they arrive by different routes: a plain duplicate
  // completion, and the redelivery that the deliberate 500 provokes.
  for (let i = 0; i < 3; i += 1) {
    await q(`select public.record_customer_card_setup(
      $1,'cs_second','seti_1','cus_real','pm_1','visa','4242',4,2030,$2)`,
      [companyA, i % 2 === 0]);
  }
  const rows = await q(
    `select count(*)::int n from public.customer_account_activity
      where customer_account_id = $1 and event = 'card_captured'`, [cardAccount]);
  assert.equal(rows[0].n, 1,
    'the capture is logged on the TRANSITION, not once per webhook delivery');
});

await test('a genuinely new capture after an abandoned session IS logged', async () => {
  // The guard must be "did it transition", not "has it ever been captured" --
  // a card captured again after a release is a real, separate event.
  const again = await invite('recapture@dugout.test');
  await q(`select public.submit_customer_account($1,$2::jsonb)`,
    [again.token, JSON.stringify(FORM)]);
  await q(`select public.record_customer_account_consent($1,'2026-09-19.v1','...')`,
    [again.customer_account_id]);
  await q(`select * from public.claim_customer_card_setup($1)`, [again.customer_account_id]);
  await q(`select public.note_customer_card_setup_session($1,'cs_recap')`,
    [again.customer_account_id]);
  await q(`select public.bind_customer_account_stripe_customer($1,'cus_recap')`,
    [again.customer_account_id]);
  await q(`select public.record_customer_card_setup(
    $1,'cs_recap','seti_r','cus_recap','pm_r','visa','1111',1,2031,true)`, [companyA]);
  const n = await one(`select count(*)::int n from public.customer_account_activity
                        where customer_account_id=$1 and event='card_captured'`,
    [again.customer_account_id]);
  assert.equal(n.n, 1);
});

await test('a late expiry cannot undo a card that was already saved', async () => {
  const released = await one(`select public.release_customer_card_setup($1,'cs_second') as a`,
    [companyA]);
  assert.equal(released.a, null, 'nothing should have been released');
  const row = await one(`select card_setup_status from public.customer_accounts where id=$1`,
    [cardAccount]);
  assert.equal(row.card_setup_status, 'succeeded',
    'Stripe does not order its deliveries -- a stale expiry must not erase a real card');
});

await test('no card number could be stored even if somebody tried', async () => {
  const cols = (await q(
    `select column_name from information_schema.columns
      where table_schema='public' and table_name='customer_accounts'
        and column_name like 'card%'`)).map((r) => r.column_name);
  for (const c of cols) {
    assert.ok(!/number|pan|cvc|cvv|security/.test(c), `${c} looks like card data`);
  }
  // last4 is constrained to four digits -- a full PAN cannot be written into it.
  await refused(() => q(
    `update public.customer_accounts set card_last4 = '4242424242424242' where id=$1`,
    [cardAccount]), /card_last4/, 'a full card number squeezed into the last-four column');
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Storage
// ════════════════════════════════════════════════════════════════════════════

await test('the resale certificate inherits the tax profile\'s narrow gate', async () => {
  await q(`insert into storage.objects (bucket_id, name)
           values ('customer-account-files', $1)`,
    [`${main.customer_account_id}/resale-certificate.pdf`]);

  const finSees = await as(finance, () => q(
    `select name from storage.objects where bucket_id='customer-account-files'`));
  assert.equal(finSees.length, 1, 'finance must be able to read the certificate it asked for');

  const opsSees = await as(ops, () => q(
    `select name from storage.objects where bucket_id='customer-account-files'`));
  assert.equal(opsSees.length, 0,
    'a seller\'s permit is not something a ship-to lookup should return');

  const rivalSees = await as(rival, () => q(
    `select name from storage.objects where bucket_id='customer-account-files'`));
  assert.equal(rivalSees.length, 0, 'and certainly not across companies');
});

await test('the bucket is private', async () => {
  const b = await one(`select public from storage.buckets where id='customer-account-files'`);
  assert.equal(b.public, false);
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Grants
// ════════════════════════════════════════════════════════════════════════════

await test('the public-path RPCs are unreachable with the published anon key', async () => {
  // Supabase's default privileges grant EXECUTE on every new public function to
  // anon AND authenticated, so the revoke IS the boundary -- not an extra.
  // Every public-path function, checked by name: a new one added to the
  // migration without a matching revoke is exactly the hole this catches, and
  // it would not show up anywhere else.
  const fns = [
    'customer_onboarding_resolve_token(text,text)',
    'submit_customer_account(text,jsonb)',
    'record_customer_account_consent(uuid,text,text)',
    'claim_customer_card_setup(uuid)',
    'note_customer_card_setup_session(uuid,text)',
    'record_customer_card_setup(uuid,text,text,text,text,text,text,integer,integer,boolean)',
    'release_customer_card_setup(uuid,text)',
    'bind_customer_account_stripe_customer(uuid,text)',
  ];
  for (const f of fns) {
    assert.ok(await one(`select to_regprocedure($1) is not null as ok`, [`public.${f}`])
      .then((r) => r.ok), `${f} does not exist -- the signature in this list is stale`);
  }
  for (const f of fns) {
    for (const role of ['anon', 'authenticated']) {
      const r = await one(
        `select has_function_privilege($1, $2, 'execute') as ok`, [role, `public.${f}`]);
      assert.equal(r.ok, false,
        `${role} can execute ${f} -- a service-role-only function on the open internet`);
    }
  }
});

await test('the internal RPCs stay callable by authenticated users, and gate themselves', async () => {
  for (const f of [
    'create_customer_account_invite(text,text,text)',
    'approve_customer_account(uuid,text,numeric,text)',
  ]) {
    const auth = await one(
      `select has_function_privilege('authenticated', $1, 'execute') as ok`, [`public.${f}`]);
    assert.equal(auth.ok, true, `${f} must remain callable -- it gates itself`);
    const anon = await one(
      `select has_function_privilege('anon', $1, 'execute') as ok`, [`public.${f}`]);
    assert.equal(anon.ok, false, `${f} must not be reachable anonymously`);
  }
});

await test('nothing client-side can write the activity log', async () => {
  const policies = await q(
    `select cmd from pg_policies where tablename = 'customer_account_activity'`);
  assert.deepEqual(policies.map((p) => p.cmd).sort(), ['SELECT'],
    'the log is written by the functions and by nothing else');
});

// ════════════════════════════════════════════════════════════════════════════
// 9b. State columns are not client-writable
// ════════════════════════════════════════════════════════════════════════════
// Supabase's default privileges grant `authenticated` full DML on every new
// public table, so RLS is the only thing between a browser session and an
// UPDATE -- and RLS cannot scope a policy to COLUMNS. The privilege does.

await test('a finance user may correct the descriptive fields', async () => {
  await as(finance, () => q(
    `update public.customer_accounts set legal_name = 'Dugout Sports, LLC', internal_notes = 'called'
      where id = $1`, [main.customer_account_id]));
  const row = await one(`select legal_name, internal_notes from public.customer_accounts where id=$1`,
    [main.customer_account_id]);
  assert.equal(row.legal_name, 'Dugout Sports, LLC');
  assert.equal(row.internal_notes, 'called');
});

await test('but cannot approve itself, set terms, or write a credit limit directly', async () => {
  const pending = await invite('direct@dugout.test');
  await q(`select public.submit_customer_account($1,$2::jsonb)`,
    [pending.token, JSON.stringify(FORM)]);
  for (const [col, val] of [
    ['status', `'approved'`], ['approved_payment_terms', `'Net 90'`],
    ['credit_limit', '9999999'], ['price_tier', `'platinum'`],
  ]) {
    await refused(() => as(finance, () => q(
      `update public.customer_accounts set ${col} = ${val} where id = $1`,
      [pending.customer_account_id])),
      /permission denied|column/i, `a direct PATCH of ${col}`);
  }
  const row = await one(`select status, approved_payment_terms, credit_limit, price_tier
                           from public.customer_accounts where id=$1`,
    [pending.customer_account_id]);
  assert.equal(row.status, 'submitted');
  assert.equal(row.approved_payment_terms, null);
  assert.equal(row.credit_limit, null);
});

await test('nor write the card mirror or the Stripe binding', async () => {
  // These columns are a MIRROR of Stripe, exactly like stripe_invoices. A
  // client-writable card is a card SILO claims to hold and Stripe has never
  // heard of; a client-writable stripe_customer_id walks around the
  // write-once binding function.
  for (const [col, val] of [
    ['card_setup_status', `'succeeded'`], ['card_last4', `'4242'`],
    ['card_brand', `'visa'`], ['card_payment_method_id', `'pm_forged'`],
    ['default_payment_method_set_at', 'now()'], ['stripe_customer_id', `'cus_forged'`],
    ['card_setup_attempt', '99'],
  ]) {
    await refused(() => as(finance, () => q(
      `update public.customer_accounts set ${col} = ${val} where id = $1`,
      [main.customer_account_id])),
      /permission denied|column/i, `a direct PATCH of ${col}`);
  }
});

await test('and cannot insert or delete an account at all', async () => {
  await refused(() => as(finance, () => q(
    `insert into public.customer_accounts (company_entity_id, contact_email, status)
     values ($1,'forged@dugout.test','approved')`, [companyA])),
    /permission denied/i, 'a client-inserted account');
  await refused(() => as(finance, () => q(
    `delete from public.customer_accounts where id = $1`, [main.customer_account_id])),
    /permission denied/i, 'a client-deleted account');
});

await test('the approval RPC still works, and records the actor', async () => {
  // The same user, through the function that validates the transition.
  const inv = await invite('viarpc@dugout.test');
  await q(`select public.submit_customer_account($1,$2::jsonb)`, [inv.token, JSON.stringify(FORM)]);
  await as(finance, () => q(`select public.approve_customer_account($1,'Net 30',5000,'tier-1')`,
    [inv.customer_account_id]));
  const row = await one(`select status, approved_payment_terms, credit_limit, approved_by
                           from public.customer_accounts where id=$1`, [inv.customer_account_id]);
  assert.equal(row.status, 'approved');
  assert.equal(row.approved_payment_terms, 'Net 30');
  assert.equal(row.approved_by, finance);
  const act = await one(`select event, actor from public.customer_account_activity
                          where customer_account_id=$1 and event='approved'`,
    [inv.customer_account_id]);
  assert.equal(act.actor, finance, 'the append-only record names who approved it');
});

// ════════════════════════════════════════════════════════════════════════════
// 9c. The webhook's ownership lookup
// ════════════════════════════════════════════════════════════════════════════

await test('the session-owner lookup answers only for the owning company', async () => {
  const mine = await one(
    `select * from public.customer_card_setup_session_owner($1,'cs_second')`, [companyA]);
  assert.equal(mine.customer_account_id, cardAccount);
  assert.equal(mine.stripe_customer_id, 'cus_real');

  const theirs = await q(
    `select * from public.customer_card_setup_session_owner($1,'cs_second')`, [companyB]);
  assert.equal(theirs.length, 0,
    'another company must not learn that this session is ours, let alone act on it');

  const foreign = await q(
    `select * from public.customer_card_setup_session_owner($1,'cs_never_ours')`, [companyA]);
  assert.equal(foreign.length, 0,
    'a setup session the tenant created in their own Stripe dashboard is not ours');
});

await test('the default stamp is scoped and only applies to a recorded card', async () => {
  const before = await one(`select default_payment_method_set_at d from public.customer_accounts
                             where id=$1`, [cardAccount]);
  assert.ok(before.d, 'already set by the earlier recording');

  const other = await one(`select public.mark_customer_card_default($1,'cs_second') as ok`,
    [companyB]);
  assert.equal(other.ok, false, 'another company cannot stamp it');
});

// ════════════════════════════════════════════════════════════════════════════
// 10. The verify checks themselves
// ════════════════════════════════════════════════════════════════════════════
// A check in verify_v2_schema.sql that cannot return 'ok' against a correct
// schema is worse than no check: deployment-drift-check.yml runs that file
// against production daily, and a check that is red forever is one nobody
// reads. The storage one in this batch was written with an uncoalesced
// pg_get_expr on an INSERT policy -- NULL, which read as "not scoped" -- and
// this is what caught it.
await test('the verify_v2_schema checks for this feature return ok on a correct schema', async () => {
  const text = (st) => (typeof st === 'string' ? st : (st.text ?? st.sql ?? String(st)));
  const all = splitSqlStatements(
    await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8')).map(text);
  const mine = all.filter((st) => st.includes("'Customer "));
  assert.equal(mine.length, 4, 'expected four customer-account checks in verify_v2_schema.sql');
  for (const stmt of mine) {
    const row = await one(stmt);
    assert.equal(row.status, 'ok', `${row.check_name}: ${row.status}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 11. The open door
// ════════════════════════════════════════════════════════════════════════════
// A shareable link that anyone can open. The risk is not the form -- it is
// that a PUBLIC endpoint now creates rows, so what it refuses matters more
// than what it accepts.

await test('the open form is OFF until a company switches it on', async () => {
  // No company_settings row at all: the link resolves to nothing.
  let seen = await q(`select * from public.peek_open_customer_application('baseballism')`);
  assert.equal(seen.length, 0, 'a company with no settings row must not be open');

  await q(`insert into public.company_settings(company_entity_id) values ($1)`, [companyA]);
  seen = await q(`select * from public.peek_open_customer_application('baseballism')`);
  assert.equal(seen.length, 0, 'the switch defaults to off, so a settings row alone is not enough');

  await q(`update public.company_settings set open_customer_applications = true
            where company_entity_id = $1`, [companyA]);
  seen = await q(`select * from public.peek_open_customer_application('baseballism')`);
  assert.equal(seen.length, 1, 'the company did not open after being switched on');
  assert.equal(seen[0].company_title, 'Baseballism');
});

await test('a closed or unknown company answers identically', async () => {
  // Rival Co exists and has NOT switched the form on. If that returned a
  // different answer from a company that does not exist, the endpoint would
  // enumerate which tenants are here.
  const closed = await q(`select * from public.peek_open_customer_application('rival')`);
  const missing = await q(`select * from public.peek_open_customer_application('no-such-co')`);
  assert.deepEqual(closed, missing, 'a closed company is distinguishable from a missing one');
  assert.equal(closed.length, 0);
});

await test('an open submission creates the account and returns a card token', async () => {
  const form = { ...FORM, contacts: [{ ...FORM.contacts[0], email: 'walkin@shop.test' }] };
  const r = (await one(
    `select public.open_customer_application('baseballism','distributor','walkin@shop.test',$1) as r`,
    [JSON.stringify(form)])).r;
  assert.equal(r.ok, true);
  assert.ok(r.continuation_token, 'no card-setup continuation was issued');

  const row = await one(`select * from public.customer_accounts where id = $1`,
    [r.customer_account_id]);
  assert.equal(row.company_entity_id, companyA);
  assert.equal(row.status, 'submitted');
  assert.equal(row.account_type, 'distributor', 'the chosen type was not stored');
  assert.equal(row.source, 'open_link', 'an open application must be distinguishable later');
  assert.equal(row.created_by, null, 'nobody at the company created this row');

  // The payload landed through the SHARED writer, so the addresses and the
  // tax profile are stored exactly as an invited application stores them.
  const addrs = await q(`select address_type, same_as_address_type, street1
                           from public.customer_account_addresses
                          where customer_account_id = $1 order by address_type`,
    [r.customer_account_id]);
  assert.equal(addrs.length, 3);
  assert.equal(addrs.find((a) => a.address_type === 'shipping').same_as_address_type, 'business');
  assert.equal(addrs.find((a) => a.address_type === 'shipping').street1, null,
    'a pointer row must carry no street');
  const tax = await one(`select federal_ein from public.customer_account_tax_profiles
                          where customer_account_id = $1`, [r.customer_account_id]);
  assert.equal(tax.federal_ein, '12-3456789');
});

await test('a second application for the same address is refused, not duplicated', async () => {
  const form = { ...FORM, contacts: [{ ...FORM.contacts[0], email: 'walkin@shop.test' }] };
  await assert.rejects(
    q(`select public.open_customer_application('baseballism','wholesale','walkin@shop.test',$1)`,
      [JSON.stringify(form)]),
    /open_duplicate/,
    'the open door let one address open a second live account');
});

await test('the account type is checked, not trusted', async () => {
  await assert.rejects(
    q(`select public.open_customer_application('baseballism','platinum','new@shop.test',$1)`,
      [JSON.stringify(FORM)]),
    /open_bad_type/,
    'an invented account type was accepted');
});

await test('a closed company cannot be applied to', async () => {
  await assert.rejects(
    q(`select public.open_customer_application('rival','wholesale','new@shop.test',$1)`,
      [JSON.stringify(FORM)]),
    /open_unavailable/,
    'an application reached a company that never opened the form');
});

await test('the shared payload writer is not reachable from a browser', async () => {
  // Supabase grants EXECUTE on every new public function to authenticated, so
  // the revoke is the boundary. Without it any signed-in user could rewrite
  // any account's addresses and contacts by id.
  for (const fn of ['apply_customer_account_payload', 'issue_customer_card_setup_token',
    'open_customer_application', 'peek_open_customer_application']) {
    const row = await one(
      `select bool_or(has_function_privilege(r.rolname, p.oid, 'EXECUTE')) as granted
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join (select unnest(array['anon','authenticated']) as rolname) r
        where n.nspname = 'public' and p.proname = $1`, [fn]);
    assert.equal(row.granted, false, `${fn} is callable by anon or authenticated`);
  }
});

console.log(`\n${passed} customer onboarding database assertions passed`);
