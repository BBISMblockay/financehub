import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "./finance-db/node_modules/@electric-sql/pglite/dist/index.js";
import { pgcrypto } from "./finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js";
import { btree_gist } from "./finance-db/node_modules/@electric-sql/pglite/dist/contrib/btree_gist.js";
const db = new PGlite({ extensions: { pgcrypto, btree_gist } }),
  root = new URL("../../", import.meta.url);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const co = randomUUID(),
  other = randomUUID(),
  finance = randomUUID(),
  outsider = randomUUID(),
  otherUser = randomUUID(),
  conn = randomUUID(),
  otherConn = randomUUID(),
  bank = randomUUID(),
  card = randomUUID(),
  foreign = randomUUID();
async function as(user, fn) {
  await db.exec("set role authenticated");
  await q("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}
const dependencies = [
  "20260826070000_quickbooks_integration.sql",
  "20260826090000_quickbooks_locations.sql",
  "20260827210000_quickbooks_reports.sql",
  "20260831180000_card_coding.sql",
  "20260831190000_card_name_and_holder.sql",
  "20260831200000_qbo_entities_and_line_entity.sql",
  "20260831210000_apply_card_coding_rpc.sql",
  "20260831220000_void_card_posting.sql",
  "20260831230000_rule_hits_and_conflicts.sql",
  "20260901000000_journal_adjustments.sql",
  "20260901010000_void_journal_adjustment.sql",
  "20260901020000_posted_status_not_client_writable.sql",
  "20260904310000_cash_flow_forecast.sql",
  "20260912000000_finance_v1_posting_controls.sql",
  "20260912052930_plaid_bank_feed.sql",
  "20260912203725_bank_feed_workspace_history.sql",
  "20260912231606_accounting_foundation.sql",
];
const insert = (params = {}) =>
  q(
    `insert into cash_forecast_overrides(company_entity_id,currency,scope_group,category_key,category_label,flow_key,direction,start_date,end_date,payment_date,amount,account_id,counter_account_id) values($1,$2,'coa',$3,'Divvy','Card paydowns','out',$4,$5,$6,$7,$8,$9) returning *`,
    [
      params.company || co,
      params.currency || "USD",
      params.key || "divvy",
      params.start || "2026-10-01",
      params.end || "2026-10-31",
      params.payment || "2026-10-20",
      params.amount ?? 120000,
      Object.hasOwn(params, "account") ? params.account : bank,
      Object.hasOwn(params, "counter") ? params.counter : card,
    ],
  );
try {
  await db.exec(
    await readFile(
      new URL("./finance-db/bootstrap.sql", import.meta.url),
      "utf8",
    ),
  );
  for (const name of dependencies)
    await db.exec(
      await readFile(new URL("supabase/migrations/" + name, root), "utf8"),
    );
  const migration = await readFile(
    new URL(
      "supabase/migrations/20260913062551_cashflow_overrides_liquidity.sql",
      root,
    ),
    "utf8",
  );
  await db.exec(migration);
  await db.exec(migration);
  await q("insert into entities(id,title) values($1,'A'),($2,'B')", [
    co,
    other,
  ]);
  await q("insert into auth.users(id) values($1),($2),($3)", [
    finance,
    outsider,
    otherUser,
  ]);
  await q(
    "insert into profiles(id,name,department,active_company_id) values($1,'F','finance',$4),($2,'O','marketing',$4),($3,'B','finance',$5)",
    [finance, outsider, otherUser, co, other],
  );
  await q(
    "insert into entity_memberships(entity_id,user_id,role) values($1,$2,'member'),($1,$3,'member'),($4,$5,'member')",
    [co, finance, outsider, other, otherUser],
  );
  await q(
    "insert into plaid_connections(id,company_entity_id,item_id,institution_name,environment,status) values($1,$2,'a','Bank','sandbox','active'),($3,$4,'b','Other','sandbox','active')",
    [conn, co, otherConn, other],
  );
  await q(
    "insert into plaid_accounts(id,company_entity_id,connection_id,provider_account_id,name,type,iso_currency_code) values($1,$4,$6,'bank','Checking','depository','USD'),($2,$4,$6,'card','Divvy','credit','USD'),($3,$5,$7,'foreign','Other','depository','USD')",
    [bank, card, foreign, co, other, conn, otherConn],
  );
  const [saved] = await as(finance, () => insert());
  assert.equal(saved.created_by, finance);
  assert.equal(saved.updated_by, finance);
  assert.equal(
    (await as(otherUser, () => q("select * from cash_forecast_overrides")))
      .length,
    0,
  );
  assert.equal(
    (await as(outsider, () => q("select * from cash_forecast_overrides")))
      .length,
    0,
  );
  await assert.rejects(
    as(outsider, () =>
      insert({ key: "forbidden", account: null, counter: null }),
    ),
    /row-level security/,
  );
  await assert.rejects(
    as(finance, () =>
      insert({ company: other, account: foreign, counter: null }),
    ),
    /row-level security|connected/,
  );
  await assert.rejects(
    as(finance, () => insert({ key: "foreign-account", account: foreign })),
    /connected cash/,
  );
  await assert.rejects(
    as(finance, () => insert({ key: "foreign-counter", counter: foreign })),
    /connected counterpart/,
  );
  await assert.rejects(
    as(finance, () => insert({ key: "same-account", counter: bank })),
    /different accounts/,
  );
  await assert.rejects(
    as(finance, () => insert({ key: "wrong-currency", currency: "EUR" })),
    /base currency/,
  );
  await assert.rejects(
    as(finance, () => insert({ start: "2026-10-15", end: "2026-11-15" })),
    /exclusion constraint/,
  );
  await assert.rejects(
    as(finance, () => insert({ key: "invalid-date", payment: "2026-11-01" })),
    /check constraint/,
  );
  const [adjacent] = await as(finance, () =>
    insert({
      start: "2026-11-01",
      end: "2026-11-30",
      payment: "2026-11-20",
      amount: 0,
    }),
  );
  assert.equal(Number(adjacent.amount), 0);
  const [updated] = await as(finance, () =>
    q(
      "update cash_forecast_overrides set amount=125000,updated_by=$1 where id=$2 and updated_at=$3 returning *",
      [outsider, saved.id, saved.updated_at],
    ),
  );
  assert.equal(updated.updated_by, finance);
  assert.equal(
    (
      await as(finance, () =>
        q(
          "update cash_forecast_overrides set amount=130000 where id=$1 and updated_at=$2 returning id",
          [saved.id, saved.updated_at],
        ),
      )
    ).length,
    0,
  );
  await as(finance, () =>
    q("update cash_forecast_overrides set is_active=false where id=$1", [
      saved.id,
    ]),
  );
  await as(finance, () => insert());
  await assert.rejects(
    as(finance, () =>
      q("delete from cash_forecast_overrides where id=$1", [saved.id]),
    ),
    /permission denied/,
  );
  const [item] = await as(finance, () =>
    q(
      "insert into cash_forecast_items(company_entity_id,label,category,amount,kind,start_date,account_id,counter_account_id) values($1,'Transfer','flow|Transfers',-100,'one_time','2026-10-20',$2,$3) returning *",
      [co, bank, card],
    ),
  );
  assert.equal(item.created_by, finance);
  const audit = await as(finance, () =>
    q(
      "select * from finance_audit_events where object_type in ('cash_forecast_overrides','cash_forecast_items')",
    ),
  );
  assert.ok(audit.length >= 6);
  assert.ok(audit.some((a) => a.object_id === item.id));
  assert.ok(
    audit.some(
      (a) => a.old_values?.amount === 120000 && a.new_values?.amount === 125000,
    ),
  );
  const controls = await q(
    "select relrowsecurity from pg_class where oid='cash_forecast_overrides'::regclass",
  );
  assert.equal(controls[0].relrowsecurity, true);
  assert.equal(
    (
      await q(
        "select has_table_privilege('anon','cash_forecast_overrides','SELECT') allowed",
      )
    )[0].allowed,
    false,
  );
  console.log(
    "Cashflow database: migration replay, RLS, account/currency boundaries, overlaps, zero overrides, concurrent edits, reset and audit passed",
  );
} finally {
  await db.close();
}
