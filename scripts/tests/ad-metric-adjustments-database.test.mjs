// scripts/tests/ad-metric-adjustments-database.test.mjs
//
// ad_metric_adjustments (20261120020000) on real PostgreSQL (PGlite), applied
// twice as apply_all_post_merge.sql does. Asserted here: an adjustment
// corrects the stored marketing_kpis_daily row, the platform's raw value is
// kept and restored when the adjustment goes away, the next sync cannot put
// the bad number back, an integer column is rounded, one company's adjustment
// never touches another's rows, no browser role can rewrite stored metrics,
// and a broken adjustment stores the raw row instead of breaking the sync.
//
// Mutations this suite must catch (CI runs each and requires a failure):
//   AD_ADJ_MUTATION=rls        RLS left off ad_metric_adjustments
//   AD_ADJ_MUTATION=company    the select policy drops the company filter
//   AD_ADJ_MUTATION=admin      the insert policy drops the admin gate
//   AD_ADJ_MUTATION=funcgrant  apply_ad_metric_adjustments left callable by the browser
//   AD_ADJ_MUTATION=rawkeep    the raw value is written to a path jsonb_set cannot create
//   AD_ADJ_MUTATION=resync     no trigger on marketing_kpis_daily, so a sync undoes the fix
//   AD_ADJ_MUTATION=failsoft   a broken adjustment breaks the ad sync instead of warning
//   AD_ADJ_MUTATION=scope      the campaign filter is ignored, so clean days are zeroed
//   AD_ADJ_MUTATION=overlap    two active corrections for the same metric are allowed
//   AD_ADJ_MUTATION=nullkeep   restoring a saved JSON null leaves the correction in place
//   AD_ADJ_MUTATION=nullexclude  excluding an unmeasured metric invents a measured zero
//   AD_ADJ_MUTATION=providerraw  a provider write does not refresh the saved raw value
//   AD_ADJ_MUTATION=dropmark     a mark is left behind when the metric becomes unmeasured
//   AD_ADJ_MUTATION=stamporder   the overlap guard runs before the company is stamped
//   AD_ADJ_MUTATION=lock         the overlap check is not serialized

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.AD_ADJ_MUTATION || '';
const db = new PGlite();

// Fixtures only: auth/company helpers and the ad table as production has it.
await db.exec(`
create role anon; create role authenticated; create role silo_integration; create role service_role bypassrls;
create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
create table entities(id uuid primary key);
create function active_company_id() returns uuid language sql as
  $$ select nullif(current_setting('test.company', true), '')::uuid $$;
create function is_admin_user() returns boolean language sql as
  $$ select coalesce(nullif(current_setting('test.admin', true), '')::boolean, false) $$;
create function set_updated_at() returns trigger language plpgsql as
  $$ begin new.updated_at := now(); return new; end $$;
create function stamp_company_entity_id() returns trigger language plpgsql as
  $$ begin if new.company_entity_id is null then new.company_entity_id := public.active_company_id(); end if;
     return new; end $$;
-- The real function attaches the stamp to EVERY public table with a
-- company_entity_id, ad_metric_adjustments included, which is what makes
-- trigger name order matter there.
create function attach_stamp_company_entity_id_triggers() returns void language plpgsql as $$
declare t text; v_oid oid;
begin
  foreach t in array array['marketing_kpis_daily', 'ad_metric_adjustments'] loop
    v_oid := to_regclass('public.' || t);
    if v_oid is not null
       and not exists (select 1 from pg_trigger
                        where tgrelid = v_oid and tgname = 'stamp_company_entity_id') then
      execute format('create trigger stamp_company_entity_id before insert on public.%I
                        for each row execute function public.stamp_company_entity_id()', t);
    end if;
  end loop;
end $$;
create function refresh_chat_schema_catalog() returns void language sql as $$ select $$;
create table marketing_kpis_daily(
  id uuid primary key default gen_random_uuid(), company_entity_id uuid not null,
  platform text not null, account_id text, day_date date not null,
  campaign_id text, campaign_name text, impressions bigint, clicks bigint,
  spend numeric, conversions numeric, conversion_value numeric, sessions bigint,
  extra jsonb, row_hash text not null unique,
  source text, synced_at timestamptz default now(), sync_batch_id text);
select public.attach_stamp_company_entity_id_triggers();
grant all on marketing_kpis_daily to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated, silo_integration;
`);

let migration = await readFile(
  new URL('../../supabase/migrations/20261120020000_ad_metric_adjustments.sql', import.meta.url), 'utf8');
const mutate = (from, to) => {
  assert.ok(migration.includes(from), `mutation ${MUT}: pattern not found`);
  migration = migration.replace(from, to);
};
if (MUT === 'rls') mutate('alter table public.ad_metric_adjustments enable row level security;', '');
if (MUT === 'company') mutate(`  for select to authenticated
  using (company_entity_id = public.active_company_id());`, `  for select to authenticated
  using (true);`);
if (MUT === 'admin') mutate('with check (company_entity_id = public.active_company_id() and public.is_admin_user());',
  'with check (company_entity_id = public.active_company_id());');
if (MUT === 'funcgrant') mutate(
  'revoke all on function public.apply_ad_metric_adjustments(uuid, uuid) from public, anon, authenticated, silo_integration;', '');
if (MUT === 'rawkeep') mutate(`             extra = coalesce(k.extra, '{}'::jsonb) || jsonb_build_object('silo_adjusted',
                       coalesce(k.extra -> 'silo_adjusted', '{}'::jsonb)
                       || jsonb_build_object(%3$L, jsonb_build_object(
                            'raw', to_jsonb(k.%1$I), 'adjustment_id', %4$L::text,
                            'mode', %5$L::text, 'at', now())))`,
  `             extra = jsonb_set(coalesce(k.extra, '{}'::jsonb), array['silo_adjusted', %3$L],
                       jsonb_build_object('raw', to_jsonb(k.%1$I), 'adjustment_id', %4$L::text,
                                          'mode', %5$L::text, 'at', now()), true)`);
if (MUT === 'resync') mutate(`create trigger zz_apply_ad_metric_adjustments
  after insert or update on public.marketing_kpis_daily
  for each row when (pg_trigger_depth() < 1)
  execute function public.tg_marketing_kpis_apply_adjustments();`, '');
if (MUT === 'overlap') mutate(`create trigger zz_ad_metric_adjustments_no_overlap
  before insert or update on public.ad_metric_adjustments
  for each row execute function public.tg_ad_metric_adjustments_no_overlap();`, '');
if (MUT === 'stamporder') mutate('create trigger zz_ad_metric_adjustments_no_overlap',
  'create trigger ad_metric_adjustments_no_overlap');
if (MUT === 'lock') mutate(`  perform pg_advisory_xact_lock(hashtextextended(
    coalesce(new.company_entity_id::text, '') || ':' || new.platform || ':' || new.metric, 0));`, '');
if (MUT === 'providerraw') mutate('      v_provider := new.synced_at is distinct from old.synced_at;',
  '      v_provider := false;');
if (MUT === 'dropmark') mutate(`        if v_mark is not null then
          v_drop := v_drop || a.metric;
          v_changed := true;
        end if;`, '');
if (MUT === 'nullkeep') mutate(`       set %1$I = case when k.extra -> 'silo_adjusted' -> %2$L ? 'raw'
                       then (k.extra -> 'silo_adjusted' -> %2$L ->> 'raw')::numeric
                       else k.%1$I end,`,
  `       set %1$I = coalesce((k.extra -> 'silo_adjusted' -> %2$L ->> 'raw')::numeric, k.%1$I),`);
if (MUT === 'nullexclude') mutate(`         and (%14$L::boolean or k.%1$I is not null)`, '');
if (MUT === 'failsoft') mutate(`  exception when others then
    raise warning 'ad metric adjustments skipped for marketing_kpis_daily row: %', sqlerrm;
    return new;
  end;`, `  end;`);
if (MUT === 'scope') {
  mutate('         and (adj.campaign_id is null or adj.campaign_id = new.campaign_id)', '');
  mutate('         and (adj.campaign_name is null or adj.campaign_name = new.campaign_name)', '');
  mutate('         and (%11$L::text is null or k.campaign_id = %11$L)', '');
  mutate('         and (%12$L::text is null or k.campaign_name = %12$L)', '');
}

await db.exec(migration);
await db.exec(migration);   // applied twice, as apply_all_post_merge.sql does

// ── The verify block, executed verbatim ───────────────────────────────────
const verifySql = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
const start = verifySql.indexOf("select 'ad metric adjustments' as check_name,");
assert.ok(start >= 0, 'the ad metric adjustments verify block is missing');
let block = verifySql.slice(start);
const next = /\nselect '[^']+' as check_name,/.exec(block.slice(1));
if (next) block = block.slice(0, next.index + 1);
block = block.trim();
assert.ok(block.endsWith(';'), 'could not extract the verify block');

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
await db.query('insert into entities values($1),($2)', [A, B]);

const CAMP = '23904026362';
const rows = [
  // the shape that started this: a conversion-value bug on a handful of days
  [A, 'google_ads', '2026-07-22', CAMP, 'Pmax_Country_Testing', 45.10, 2, 13486.00, 10, 'a1'],
  [A, 'google_ads', '2026-07-24', CAMP, 'Pmax_Country_Testing', 35.34, 2, 164320.25, 10, 'a2'],
  // a clean day in the same campaign, and another campaign on a dirty day
  [A, 'google_ads', '2026-07-23', CAMP, 'Pmax_Country_Testing', 43.92, 2.52, 157.70, 10, 'a3'],
  [A, 'google_ads', '2026-07-24', '11111', 'Brand_Search', 10, 1, 500.00, 10, 'a4'],
  // another company, same campaign id and day
  [B, 'google_ads', '2026-07-24', CAMP, 'Pmax_Country_Testing', 10, 1, 777.00, 10, 'b1'],
];
await db.exec('set role service_role');
for (const r of rows) {
  await db.query(`insert into marketing_kpis_daily(company_entity_id, platform, day_date, campaign_id,
    campaign_name, spend, conversions, conversion_value, clicks, row_hash)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, r);
}
await db.exec('reset role');

// A refused statement aborts its transaction, so each expectation gets one.
async function asUser(company, admin, fn) {
  await db.exec('begin');
  try {
    await db.query("select set_config('test.company', $1, true)", [company]);
    await db.query("select set_config('test.admin', $1, true)", [String(admin)]);
    await db.exec('set local role authenticated');
    const out = await fn();
    await db.exec('commit');
    return out;
  } catch (err) {
    await db.exec('rollback');
    throw err;
  }
}
async function refused(company, admin, sql, params, why) {
  await assert.rejects(asUser(company, admin, () => db.query(sql, params)), why);
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const valueOf = async (hash, column = 'conversion_value') =>
  Number((await one(`select ${column} v from marketing_kpis_daily where row_hash = $1`, [hash])).v);
const rawOf = async (hash, metric = 'conversion_value') => {
  const r = await one(
    `select extra -> 'silo_adjusted' -> $2 ->> 'raw' raw from marketing_kpis_daily where row_hash = $1`,
    [hash, metric]);
  return r.raw === null ? null : Number(r.raw);
};

// An admin files the correction; a member cannot, and nobody can file one for
// another company.
await refused(A, false,
  `insert into ad_metric_adjustments(company_entity_id, platform, campaign_id, day_from, day_to, metric, mode, reason)
   values($1,'google_ads',$2,'2026-07-22','2026-07-22','conversion_value','exclude','member try')`,
  [A, CAMP], 'a member must not file an adjustment');
await refused(A, true,
  `insert into ad_metric_adjustments(company_entity_id, platform, campaign_id, day_from, day_to, metric, mode, reason)
   values($1,'google_ads',$2,'2026-07-22','2026-07-22','conversion_value','exclude','other company')`,
  [B, CAMP], 'an admin must not file an adjustment for another company');
await asUser(A, true, async () => {
  for (const day of ['2026-07-22', '2026-07-24']) {
    await db.query(
      `insert into ad_metric_adjustments(company_entity_id, platform, campaign_id, campaign_name,
         day_from, day_to, metric, mode, reason)
       values($1,'google_ads',$2,'Pmax_Country_Testing',$3,$3,'conversion_value','exclude','platform conversion-value bug')`,
      [A, CAMP, day]);
  }
});

// The stored rows are corrected, spend is untouched, and the clean day, the
// other campaign and the other company are all left alone.
assert.equal(await valueOf('a1'), 0, 'the adjusted day still carries the platform value');
assert.equal(await valueOf('a2'), 0, 'the adjusted day still carries the platform value');
assert.equal(await valueOf('a1', 'spend'), 45.10, 'spend must not be touched');
assert.equal(await valueOf('a3'), 157.70, 'a clean day in the same campaign was changed');
assert.equal(await valueOf('a4'), 500.00, 'another campaign on the same day was changed');
assert.equal(await valueOf('b1'), 777.00, "another company's row was changed");

// The platform's own value is kept, and comes back when the adjustment goes.
assert.equal(await rawOf('a2'), 164320.25, 'the raw value was not kept');
await asUser(A, true, async () => {
  await db.query("delete from ad_metric_adjustments where day_from = '2026-07-24'");
});
assert.equal(await valueOf('a2'), 164320.25, 'deleting the adjustment did not restore the platform value');
assert.equal(await rawOf('a2'), null, 'the mark was left behind after restoring');
assert.equal(await valueOf('a1'), 0, 'deleting one adjustment undid another');

// The next sync re-upserts the bad number; it must land corrected, and so must
// a row that arrives for the first time on an adjusted day.
await db.exec('set role service_role');
await db.query(`insert into marketing_kpis_daily(company_entity_id, platform, day_date, campaign_id,
  campaign_name, spend, conversions, conversion_value, clicks, row_hash)
  values($1,'google_ads','2026-07-22',$2,'Pmax_Country_Testing',45.10,2,13486.00,10,'a1')
  on conflict (row_hash) do update set conversion_value = excluded.conversion_value,
    spend = excluded.spend, synced_at = excluded.synced_at`, [A, CAMP]);
await db.query(`insert into marketing_kpis_daily(company_entity_id, platform, day_date, campaign_id,
  campaign_name, spend, conversions, conversion_value, clicks, row_hash)
  values($1,'google_ads','2026-07-22',$2,'Pmax_Country_Testing',5,1,9999.00,3,'a5')`, [A, CAMP]);
await db.exec('reset role');
assert.equal(await valueOf('a1'), 0, 'a re-synced row put the bad number back');
assert.equal(await rawOf('a1'), 13486.00, 'a re-synced row lost the raw value');
assert.equal(await valueOf('a5'), 0, 'a new row on an adjusted day was not corrected');

// An override on an integer column is rounded to what the column stores.
await asUser(A, true, async () => {
  await db.query(
    `insert into ad_metric_adjustments(company_entity_id, platform, campaign_id, day_from, day_to,
       metric, mode, override_value, reason)
     values($1,'google_ads',$2,'2026-07-23','2026-07-23','clicks','override',7.6,'bot clicks removed')`,
    [A, CAMP]);
});
assert.equal(await valueOf('a3', 'clicks'), 8, 'an integer override was not rounded');
assert.equal(await rawOf('a3', 'clicks'), 10, 'the raw click count was not kept');
// And again on the sync path, where an unrounded value cannot be stored at all.
await db.exec('set role service_role');
await db.query(`insert into marketing_kpis_daily(company_entity_id, platform, day_date, campaign_id,
  campaign_name, spend, conversions, conversion_value, clicks, row_hash)
  values($1,'google_ads','2026-07-23',$2,'Pmax_Country_Testing',43.92,2.52,157.70,10,'a3')
  on conflict (row_hash) do update set clicks = excluded.clicks, synced_at = excluded.synced_at`,
  [A, CAMP]);
await db.exec('reset role');
assert.equal(await valueOf('a3', 'clicks'), 8, 'a re-synced row lost the integer override');

// One company cannot see another's adjustments, and no browser role can
// rewrite stored metrics directly.
const seenByB = await asUser(B, true, () => db.query('select count(*)::int n from ad_metric_adjustments'));
assert.equal(seenByB.rows[0].n, 0, "another company's adjustments are visible");
await refused(B, true, 'select public.apply_ad_metric_adjustments(null, null)', [],
  'a browser role can rewrite stored ad metrics');
await refused(B, true, "select public.restore_ad_metric_adjustment(gen_random_uuid(), 'spend')", [],
  'a browser role can rewrite stored ad metrics');

// A restatement after the correction: the platform now says 200 for an adjusted
// day, and the sync's upsert never sends `extra`. The raw value kept must be the
// new one, so removing the correction restores what the platform says today.
await db.exec('set role service_role');
await db.query(`insert into marketing_kpis_daily(company_entity_id, platform, day_date, campaign_id,
  campaign_name, spend, conversions, conversion_value, clicks, row_hash)
  values($1,'google_ads','2026-07-22',$2,'Pmax_Country_Testing',45.10,2,27000.00,10,'a1')
  on conflict (row_hash) do update set conversion_value = excluded.conversion_value,
    spend = excluded.spend, synced_at = excluded.synced_at`,
  [A, CAMP]);
await db.exec('reset role');
assert.equal(await valueOf('a1'), 0, 'a restated row put the bad number back');
assert.equal(await rawOf('a1'), 27000.00, 'the kept raw value is stale, not what the platform says now');
await asUser(A, true, async () => {
  await db.query("delete from ad_metric_adjustments where day_from = '2026-07-22' and metric = 'conversion_value'");
});
assert.equal(await valueOf('a1'), 27000.00, 'removing the correction restored a stale value');

// Two active corrections for the same row and metric are refused: which one won
// could otherwise change on the next sync, and neither raw value would be the
// platform's own.
await asUser(A, true, async () => {
  await db.query(`insert into ad_metric_adjustments(company_entity_id, platform, campaign_id,
      day_from, day_to, metric, mode, override_value, reason)
    values($1,'google_ads',$2,'2026-07-20','2026-07-26','conversion_value','override',10,'first')`, [A, CAMP]);
});
await refused(A, true,
  `insert into ad_metric_adjustments(company_entity_id, platform, campaign_name,
     day_from, day_to, metric, mode, override_value, reason)
   values($1,'google_ads','Pmax_Country_Testing','2026-07-24','2026-07-30','conversion_value','override',20,'second')`,
  [A], 'an overlapping active correction for the same metric was accepted');
// A different metric, the same days, is fine; so is the same metric once the
// first correction is switched off.
await asUser(A, true, async () => {
  await db.query(`insert into ad_metric_adjustments(company_entity_id, platform, campaign_id,
      day_from, day_to, metric, mode, override_value, reason)
    values($1,'google_ads',$2,'2026-07-20','2026-07-26','spend','override',1,'other metric')`, [A, CAMP]);
  await db.query("update ad_metric_adjustments set is_active = false where reason = 'first'");
  await db.query(`insert into ad_metric_adjustments(company_entity_id, platform, campaign_id,
      day_from, day_to, metric, mode, override_value, reason)
    values($1,'google_ads',$2,'2026-07-24','2026-07-30','conversion_value','override',20,'after deactivate')`,
    [A, CAMP]);
  await db.query("delete from ad_metric_adjustments where reason in ('first', 'other metric', 'after deactivate')");
});

// NULL means the platform did not measure the metric, never zero. Excluding it
// must not invent a measured zero, and an override on it must restore to NULL.
await db.exec('set role service_role');
await db.query(`insert into marketing_kpis_daily(company_entity_id, platform, day_date, campaign_id,
  campaign_name, spend, conversions, conversion_value, sessions, row_hash)
  values($1,'google_ads','2026-07-27',$2,'Pmax_Country_Testing',20,1,60,null,'a7')`, [A, CAMP]);
await db.exec('reset role');
await asUser(A, true, async () => {
  await db.query(`insert into ad_metric_adjustments(company_entity_id, platform, campaign_id,
      day_from, day_to, metric, mode, reason)
    values($1,'google_ads',$2,'2026-07-27','2026-07-27','sessions','exclude','nothing to exclude')`, [A, CAMP]);
});
assert.equal((await one("select sessions from marketing_kpis_daily where row_hash = 'a7'")).sessions, null,
  'excluding an unmeasured metric turned "not measured" into a measured zero');
await asUser(A, true, async () => {
  await db.query("delete from ad_metric_adjustments where metric = 'sessions'");
  await db.query(`insert into ad_metric_adjustments(company_entity_id, platform, campaign_id,
      day_from, day_to, metric, mode, override_value, reason)
    values($1,'google_ads',$2,'2026-07-27','2026-07-27','sessions','override',12,'counted by hand')`, [A, CAMP]);
});
assert.equal(await valueOf('a7', 'sessions'), 12, 'an override on an unmeasured metric did not apply');
await asUser(A, true, async () => {
  await db.query("delete from ad_metric_adjustments where metric = 'sessions'");
});
assert.equal((await one("select sessions from marketing_kpis_daily where row_hash = 'a7'")).sessions, null,
  'removing the override left a measured zero where the platform measured nothing');

// A restatement that happens to equal the correction's own target: the platform
// now says 0 for an excluded day. The saved raw must follow, or removing the
// correction would resurrect a number the platform has retracted.
await asUser(A, true, async () => {
  await db.query(`insert into ad_metric_adjustments(company_entity_id, platform, campaign_id,
      day_from, day_to, metric, mode, reason)
    values($1,'google_ads',$2,'2026-07-22','2026-07-22','conversion_value','exclude','retracted')`, [A, CAMP]);
});
assert.equal(await rawOf('a1'), 27000.00, 'the correction did not capture the platform value');
await db.exec('set role service_role');
await db.query(`insert into marketing_kpis_daily(company_entity_id, platform, day_date, campaign_id,
  campaign_name, spend, conversions, conversion_value, clicks, row_hash)
  values($1,'google_ads','2026-07-22',$2,'Pmax_Country_Testing',45.10,2,0,10,'a1')
  on conflict (row_hash) do update set conversion_value = excluded.conversion_value,
    synced_at = excluded.synced_at`, [A, CAMP]);
await db.exec('reset role');
assert.equal(await rawOf('a1'), 0, 'a restatement to the target left a stale raw value behind');
await asUser(A, true, async () => {
  await db.query("delete from ad_metric_adjustments where reason = 'retracted'");
});
assert.equal(await valueOf('a1'), 0, 'removing the correction resurrected a retracted number');

// And a metric that was measured and then is not: the mark goes, so removing the
// correction cannot put the old measurement back.
await db.exec('set role service_role');
await db.query(`insert into marketing_kpis_daily(company_entity_id, platform, day_date, campaign_id,
  campaign_name, spend, conversions, conversion_value, sessions, row_hash)
  values($1,'google_ads','2026-07-28',$2,'Pmax_Country_Testing',20,1,60,500,'a8')`, [A, CAMP]);
await db.exec('reset role');
await asUser(A, true, async () => {
  await db.query(`insert into ad_metric_adjustments(company_entity_id, platform, campaign_id,
      day_from, day_to, metric, mode, reason)
    values($1,'google_ads',$2,'2026-07-28','2026-07-28','sessions','exclude','bad sessions')`, [A, CAMP]);
});
assert.equal(await valueOf('a8', 'sessions'), 0, 'a measured metric was not excluded');
assert.equal(await rawOf('a8', 'sessions'), 500, 'the measured sessions value was not kept');
await db.exec('set role service_role');
await db.query(`insert into marketing_kpis_daily(company_entity_id, platform, day_date, campaign_id,
  campaign_name, spend, conversions, conversion_value, sessions, row_hash)
  values($1,'google_ads','2026-07-28',$2,'Pmax_Country_Testing',20,1,60,null,'a8')
  on conflict (row_hash) do update set sessions = excluded.sessions, synced_at = excluded.synced_at`,
  [A, CAMP]);
await db.exec('reset role');
assert.equal((await one("select sessions from marketing_kpis_daily where row_hash = 'a8'")).sessions, null,
  'an unmeasured metric was held at the excluded zero');
assert.equal(await rawOf('a8', 'sessions'), null, 'the stale mark was left on an unmeasured metric');
await asUser(A, true, async () => {
  await db.query("delete from ad_metric_adjustments where reason = 'bad sessions'");
});
assert.equal((await one("select sessions from marketing_kpis_daily where row_hash = 'a8'")).sessions, null,
  'removing the correction put back a measurement the platform no longer reports');

// The overlap guard must see the company the stamp fills in, so an insert that
// leaves company_entity_id out is still refused.
await asUser(A, true, async () => {
  await db.query(`insert into ad_metric_adjustments(platform, campaign_id, day_from, day_to,
      metric, mode, override_value, reason)
    values('google_ads',$1,'2026-09-01','2026-09-30','conversion_value','override',5,'stamped')`, [CAMP]);
});
await refused(A, true,
  `insert into ad_metric_adjustments(platform, campaign_id, day_from, day_to,
     metric, mode, override_value, reason)
   values('google_ads',$1,'2026-09-15','2026-10-15','conversion_value','override',6,'stamped overlap')`,
  [CAMP], 'an overlapping correction slipped past the guard when the company was left to the stamp');
await asUser(A, true, async () => {
  await db.query("delete from ad_metric_adjustments where reason = 'stamped'");
});

// Two transactions could otherwise each see no competitor and both commit.
// PGlite is single-connection, so this is asserted on the definition.
const guardDef = (await one(
  "select pg_get_functiondef('public.tg_ad_metric_adjustments_no_overlap()'::regprocedure) d")).d;
assert.match(guardDef, /pg_advisory_xact_lock/,
  'the overlap check is not serialized, so two concurrent inserts can both pass');

// Constraints: only a metric the table has, an override needs a value, and a
// range cannot run backwards.
for (const [sql, why] of [
    [`insert into ad_metric_adjustments(company_entity_id, platform, day_from, metric, mode)
      values($1,'google_ads','2026-07-01','net_sales','exclude')`, 'a metric that is not an ad metric'],
    [`insert into ad_metric_adjustments(company_entity_id, platform, day_from, metric, mode)
      values($1,'google_ads','2026-07-01','spend','override')`, 'an override with no value'],
    [`insert into ad_metric_adjustments(company_entity_id, platform, day_from, day_to, metric, mode)
      values($1,'google_ads','2026-08-01','2026-07-01','spend','exclude')`, 'a backwards date range'],
]) await refused(A, true, sql, [A], `accepted ${why}`);

// Fail-soft: an adjustment that cannot be read must not break an ad sync.
await db.exec(`create or replace function public.ad_metric_adjustment_target(p_metric text, p_mode text, p_value numeric)
  returns numeric language plpgsql stable as $$ begin raise exception 'boom'; end $$`);
await db.exec('set role service_role');
await db.query(`insert into marketing_kpis_daily(company_entity_id, platform, day_date, campaign_id,
  campaign_name, spend, conversions, conversion_value, clicks, row_hash)
  values($1,'google_ads','2026-07-22',$2,'Pmax_Country_Testing',1,1,42,1,'a6')`, [A, CAMP]);
await db.exec('reset role');
assert.equal(await valueOf('a6'), 42, 'a broken adjustment lost the raw row');

// The verify check must read ok on a correct apply. A mutation is caught by
// the behaviour above, whether or not verify can see it too.
const status = (await db.query(block)).rows[0].status;
if (!MUT) assert.equal(status, 'ok', `a correctly applied migration must verify ok (got ${status})`);

console.log(`ad_metric_adjustments database tests passed${MUT ? ` (mutation ${MUT} should have failed)` : ''}`);
