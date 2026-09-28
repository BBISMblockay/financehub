/* query-shape-lib.mjs assertions. Pure: no model, no database, no network.
 *
 * The rewrites are only safe because they are value-identical, so most of this
 * file is about what must NOT change: literals, comments, moments (now()),
 * sub-day units, correlated calls, and already-hoisted calls.
 *
 * Run: node supabase/functions/silo-chat/query-shape.test.mjs
 */
import { rewriteSlowShapes, timeoutHint } from './query-shape-lib.mjs';

let failed = 0;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { failed++; console.error(`FAIL ${name}\n  ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(actual, expected, what = 'value') {
  if (actual !== expected) throw new Error(`${what}:\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const same = (sql) => {
  const r = rewriteSlowShapes(sql);
  eq(r.sql, sql, 'sql should be unchanged');
  eq(r.rewrites.length, 0, 'rewrite count');
};

// ---- the traced statements (Loomis, 2026-09-28) -----------------------------

test('traced product query: interval days -> integer days', () => {
  const sql = "SELECT product_name, sum(total_net_sales) FROM sales_by_day WHERE day_date >= current_date - interval '90 days' AND day_date < current_date GROUP BY 1";
  const r = rewriteSlowShapes(sql);
  eq(r.sql, "SELECT product_name, sum(total_net_sales) FROM sales_by_day WHERE day_date >= (current_date - 90) AND day_date < current_date GROUP BY 1");
  eq(r.rewrites.join(), 'date_interval');
});

test('traced channel query: every tags call hoisted, intervals converted', () => {
  const sql = `SELECT CASE WHEN location_tag = any(silo_channel_location_tags('online')) THEN 'online'
    WHEN location_tag = any(silo_channel_location_tags('retail')) THEN 'retail' ELSE 'x' END,
  CASE WHEN day_date >= current_date - interval '90 days' THEN 'last_90' ELSE 'prior_90' END
FROM sales_by_day WHERE day_date >= current_date - interval '180 days' AND day_date < current_date`;
  const r = rewriteSlowShapes(sql);
  eq(r.sql, `SELECT CASE WHEN location_tag = any((select silo_channel_location_tags('online'))::text[]) THEN 'online'
    WHEN location_tag = any((select silo_channel_location_tags('retail'))::text[]) THEN 'retail' ELSE 'x' END,
  CASE WHEN day_date >= (current_date - 90) THEN 'last_90' ELSE 'prior_90' END
FROM sales_by_day WHERE day_date >= (current_date - 180) AND day_date < current_date`);
  eq(r.rewrites.sort().join(), 'channel_tags_hoist,date_interval');
});

// ---- interval forms ---------------------------------------------------------

test('weeks convert to days, plus and uppercase handled', () => {
  eq(rewriteSlowShapes("select 1 from t where d >= CURRENT_DATE - INTERVAL '2 weeks' and d < current_date + interval '1 day'").sql,
    "select 1 from t where d >= (CURRENT_DATE - 14) and d < (current_date + 1)");
});

test("'N days'::interval form", () => {
  eq(rewriteSlowShapes("select 1 from t where d >= current_date - '30 days'::interval").sql,
    "select 1 from t where d >= (current_date - 30)");
});

test('months and years keep the interval and cast back to date', () => {
  eq(rewriteSlowShapes("select 1 from t where d >= current_date - interval '13 months'").sql,
    "select 1 from t where d >= (current_date - interval '13 months')::date");
  eq(rewriteSlowShapes("select 1 from t where d >= current_date - '1 year'::interval").sql,
    "select 1 from t where d >= (current_date - '1 year'::interval)::date");
});

test('sub-day units are a moment, not a day: untouched', () => {
  same("select 1 from t where d >= current_date - interval '36 hours'");
  same("select 1 from t where d >= current_date - interval '90 minutes'");
});

test('now() is a moment: untouched', () => {
  same("select 1 from t where created_at >= now() - interval '7 days'");
});

test('compound or unparseable intervals are left alone', () => {
  same("select 1 from t where d >= current_date - interval '1 month 3 days'");
  same("select 1 from t where d >= current_date - interval '-1 day'");
  same("select 1 from t where d >= current_date - interval '1.5 days'");
});

test('date_trunc and other bases are not touched (outside the proven shape)', () => {
  same("select 1 from t where d >= date_trunc('month', current_date) - interval '13 months'");
});

test('silo_business_today()/_yesterday() are date bases too (live re-run 2026-09-28 15:32)', () => {
  // The exact statement that timed out twice on the first live re-run.
  const sql = "SELECT date_trunc('month', day_date)::date AS month, SUM(total_net_sales) AS net_sales\nFROM sales_by_day\nWHERE day_date >= (silo_business_today() - INTERVAL '13 months')\nGROUP BY 1";
  const r = rewriteSlowShapes(sql);
  eq(r.sql, "SELECT date_trunc('month', day_date)::date AS month, SUM(total_net_sales) AS net_sales\nFROM sales_by_day\nWHERE day_date >= ((silo_business_today() - INTERVAL '13 months')::date)\nGROUP BY 1");
  eq(rewriteSlowShapes("select 1 from t where d >= silo_business_today() - interval '90 days'").sql,
    "select 1 from t where d >= (silo_business_today() - 90)");
  eq(rewriteSlowShapes("select 1 from t where d > public.silo_business_yesterday() - '1 week'::interval").sql,
    "select 1 from t where d > (public.silo_business_yesterday() - 7)");
});

test('a function that is not known to return date is not a base', () => {
  same("select 1 from t where d >= silo_business_timezone() - interval '1 day'");
  same("select 1 from t where d >= my_today() - interval '1 day'");
});

// ---- channel tags -----------------------------------------------------------

test('already-hoisted call is left alone', () => {
  same("select 1 from sales_by_day where location_tag = any((select silo_channel_location_tags('online'))::text[])");
  same("with t as (select silo_channel_location_tags('online') o) select 1");
});

test('schema-qualified and <> all forms hoist', () => {
  eq(rewriteSlowShapes("select 1 from s where location_tag <> all(public.silo_channel_location_tags('Retail'))").sql,
    "select 1 from s where location_tag <> all((select public.silo_channel_location_tags('Retail'))::text[])");
});

test('non-literal argument (correlated) is not hoisted', () => {
  same("select 1 from s join c on true where s.location_tag = any(silo_channel_location_tags(c.channel))");
});

// ---- never inside literals or comments ---------------------------------------

test('text inside a string literal is never rewritten', () => {
  same("select 'current_date - interval ''90 days''' as note, 'silo_channel_location_tags(''online'')' as n");
});

test('text inside comments is never rewritten', () => {
  same("select 1 -- current_date - interval '90 days'\nfrom t /* silo_channel_location_tags('online') */");
});

test('quoted identifiers are not rewritten', () => {
  same('select "current_date - interval" from t');
});

test('literals elsewhere in a rewritten statement survive byte-for-byte', () => {
  const r = rewriteSlowShapes("select 'it''s', 'a -- b' from t where d >= current_date - interval '7 days' and x = 'y'");
  eq(r.sql, "select 'it''s', 'a -- b' from t where d >= (current_date - 7) and x = 'y'");
});

test('unchanged input returns the identical string and no rewrites', () => {
  same("select sum(total_net_sales) from sales_by_day where day_date between '2026-09-01' and '2026-09-27'");
  same('');
});

// ---- timeout hints ----------------------------------------------------------

test('timeoutHint names the alternative only for a timeout on a known slow relation', () => {
  const t = 'canceling statement due to statement timeout';
  assert(/sales_monthly_product_type_rollup_v/.test(timeoutHint(t, ['sales_monthly_location_rollup_v'])), 'location rollup');
  assert(/CURRENT month or any period ending today/.test(timeoutHint(t, ['sales_monthly_location_rollup_v'])), 'freshness caveat');
  assert(/as of the last completed sync/.test(timeoutHint(t, ['sales_sku_location_rollup_v'])), 'sku freshness caveat');
  assert(/sales_velocity_by_sku_location_v/.test(timeoutHint(t, ['sales_sku_location_rollup_v'])), 'sku rollup');
  eq(timeoutHint(t, ['sales_by_day']), null, 'ordinary relation');
  eq(timeoutHint('column "x" does not exist', ['sales_monthly_location_rollup_v']), null, 'not a timeout');
  eq(timeoutHint(t, []), null, 'no relations');
});

console.log(`query-shape: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
