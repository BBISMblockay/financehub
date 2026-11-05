/* The catalog told bots to group a column that splits one product.
 *
 * 20261105080000 made products_master.product_title canonical, so a bot
 * joining sales_by_day to products_master, or reading
 * sales_by_product_title_daily_v, gets one row per product. One route still
 * splits it: grouping shopify_order_lines.title, which is each STORE's wording
 * at the time of sale. The catalog invited exactly that, by calling the column
 * "reliable even where SKUs are shared across products" -- true for telling two
 * products apart, and the opposite of true for counting one product's sales.
 *
 * 20261105090000 is catalog TEXT and changes no row of data, so what can go
 * wrong is narrow and worth pinning: the sentence that invited the bad query
 * surviving, the warning not saying what to use instead, an append that fires
 * twice so the description grows on every apply, an append that replaces a
 * curated description instead of adding to it, and a relation named wrongly so
 * the guidance lands nowhere. Each has a mutation below.
 *
 * Runs on PGlite against a stand-in catalog holding the production text.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { splitSqlStatements } from '../lib/sql-statements.mjs';

const root = new URL('../../', import.meta.url);
const MIGRATION = '20261105090000_order_line_title_not_canonical.sql';
const MUTATIONS = ['', 'keep-reliable-sentence', 'no-replacement-advice', 'no-append-guard',
  'clobber-description', 'wrong-relation'];
const mutation = process.env.ORDER_LINE_TITLE_MUTATION || '';
assert.ok(MUTATIONS.includes(mutation), `Unknown mutation ${mutation}`);

let checks = 0;
const check = (name) => { checks += 1; if (process.env.VERBOSE) console.log('  ok', name); };

// The two descriptions as production holds them, abridged to the parts that
// matter here but with the sentences verbatim, because the migration matches
// one of them exactly.
const OL_TITLE_SENTENCE =
  'title is the as-sold line-item title, reliable even where SKUs are shared across products.';
const EXISTING_OL =
  "Per-SKU line items within each Shopify order (quantity, price, discount_allocated, tax_allocated, "
  + "vendor, product_type) -- for basket-level questions (attach rate, what's bought together). "
  + OL_TITLE_SENTENCE
  + ' SPEED: this is the raw 567 MB line-item table. NO ORDER DATE HERE: join shopify_orders.';
const EXISTING_PM =
  'Product catalog. The vendor column is vendor_original (not vendor); cost is unit_cost (not cost). '
  + "Storefront status lives in shopify_status (active|draft|archived) and online_published_at.";

const fresh = async () => {
  const db = new PGlite();
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  await db.exec(`
    create table public.silo_chat_schema_catalog (
      relname text primary key,
      relkind text not null,
      columns jsonb not null default '[]'::jsonb,
      description text,
      keywords text[],
      is_hidden boolean not null default false,
      reportable boolean not null default false,
      report_priority smallint not null default 0,
      auto_refreshed_at timestamptz,
      updated_at timestamptz not null default now()
    );
  `);
  for (const [relname, description] of [
    ['shopify_order_lines', EXISTING_OL],
    ['products_master', EXISTING_PM],
    // A relation the migration has no business touching.
    ['sales_by_day', 'Daily sales rollup by location/SKU.'],
  ]) {
    await q(`insert into public.silo_chat_schema_catalog (relname, relkind, description, reportable)
             values ($1, 'table', $2, true)`, [relname, description]);
  }
  return { db, q };
};

const mutate = (sql) => {
  if (mutation === 'keep-reliable-sentence') {
    // Leave the sentence that invited the bad query in place, and only append
    // the warning -- so the catalog now says both.
    return sql.replace(
      "         'title is the as-sold line-item title, reliable even where SKUs are shared across products.',",
      "         'SPEED: this is the raw 567 MB line-item table.',");
  }
  if (mutation === 'no-replacement-advice') {
    // Say what is wrong without saying what to use instead.
    return sql.replace(/ \|\| 'sales_by_product_title_daily_v \(one canonical title per product\), or group by sku here and '\n         \|\| 'join products_master for the title\.'/,
      " || 'something else.'");
  }
  if (mutation === 'no-append-guard') {
    // Drop the "only if the note is absent" clause, so a second apply appends
    // the same paragraph again.
    return sql.replace("   and description not like '%ONE canonical title per (company, sku)%';", ';');
  }
  if (mutation === 'clobber-description') {
    // Replace rather than append, losing the curated products_master text.
    return sql.replace('   set description = description\n', '   set description =\n');
  }
  if (mutation === 'wrong-relation') {
    return sql.replace(" where relname = 'shopify_order_lines';", " where relname = 'shopify_order_line';");
  }
  return sql;
};

const original = await readFile(new URL(`supabase/migrations/${MIGRATION}`, root), 'utf8');
const sql = mutate(original);
assert.ok(!mutation || sql !== original,
  `mutation ${mutation} changed nothing -- the migration no longer looks the way it did`);

const applyTo = async (db) => {
  for (const statement of splitSqlStatements(sql)) {
    if (/^(begin|commit)$/i.test(statement.text.trim())) continue;
    await db.exec(statement.text);
  }
};

const { db, q } = await fresh();
const cat = async (relname) =>
  (await q('select * from public.silo_chat_schema_catalog where relname = $1', [relname]))[0];

await applyTo(db);

check('the sentence that invited grouping by order-line title is gone');
assert.ok(!(await cat('shopify_order_lines')).description.includes(OL_TITLE_SENTENCE),
  'the catalog still tells bots that order-line title is reliable for this');

check('order-line title now says it is the selling store\'s wording, and what it does to a count');
const ol = (await cat('shopify_order_lines')).description;
assert.match(ol, /selling store/i);
assert.match(ol, /splits one product into several/);

check('and it says what to use instead');
assert.match(ol, /sales_by_product_title_daily_v/);
assert.match(ol, /group by sku/);

check('the rest of the order-lines description survives');
assert.match(ol, /attach rate/);
assert.match(ol, /NO ORDER DATE HERE/);
assert.match(ol, /567 MB/);

check('products_master says its title is canonical and safe to group by');
const pm = (await cat('products_master')).description;
assert.match(pm, /ONE canonical title per \(company, sku\)/);
assert.match(pm, /safe to group by/);
assert.match(pm, /selling store's wording at the time of sale/);

check('the rest of the products_master description survives');
assert.match(pm, /vendor_original/);
assert.match(pm, /shopify_status/);

check('a relation the migration was not asked about is untouched');
assert.equal((await cat('sales_by_day')).description, 'Daily sales rollup by location/SKU.');

check('a second apply changes nothing');
await applyTo(db);
assert.equal((await cat('shopify_order_lines')).description, ol, 'order-lines text grew on re-apply');
assert.equal((await cat('products_master')).description, pm, 'products_master text grew on re-apply');

check('and a third, because an append guard that is off by one shows up here');
await applyTo(db);
assert.equal((await cat('products_master')).description, pm);

console.log(`\n${checks} checks passed${mutation ? ` (mutation ${mutation})` : ''}`);
