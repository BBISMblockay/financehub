import { fetchAllRows, resolveSql } from '../../supabase/functions/report-email-deliver/lib/report-email-deliver-core.mjs';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select current_setting('request.jwt.claim.sub')::uuid $$;
    create table profiles (id uuid primary key, active_company_id uuid);
    insert into profiles values ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-a000-000000000004');
    create function active_company_id() returns uuid language sql stable security definer set search_path = public as
      $$ select active_company_id from profiles where id = auth.uid() $$;
    create materialized view public.sales_by_product_title_daily_mv as
    select ('00000000-0000-4000-a000-00000000000' || (i % 6))::uuid company_entity_id,
           date '2026-01-01' + ((i / 6) % 350) + (((now() at time zone 'America/Los_Angeles')::date - date '2026-01-01') - 326) day_date,
           case when i % 101 = 0 then 'x-redo' when i % 103 = 0 then null
                else 'title-' || (i % 1201) end product_title,
           ((i % 1201) * 100 + (i % 90 - 1700))::numeric / 100 net_sales,
           repeat(md5(i::text), 6) filler
    from generate_series(1, 845114) as i;
    create index sales_by_product_title_daily_mv_day_idx
      on public.sales_by_product_title_daily_mv (company_entity_id, day_date);
    create view public.sales_by_product_title_daily_v with (security_invoker = false) as
    select company_entity_id, day_date, product_title, net_sales from public.sales_by_product_title_daily_mv
    where company_entity_id = active_company_id();
    revoke all on sales_by_product_title_daily_mv from public, anon, authenticated;
    grant select on sales_by_product_title_daily_v to authenticated;
    select set_config('request.jwt.claim.sub', '00000000-0000-4000-b000-000000000001', false);
  `);
  await db.exec('vacuum analyze public.sales_by_product_title_daily_mv');
  await db.exec(readFileSync(new URL('../../supabase/migrations/20260916120000_chat_readonly_query_read_only_txn.sql', import.meta.url), 'utf8'));
  // Captured from the failed first-page RPC's server-side SQL context.
  const saved = `select product_title as product_name, sum(net_sales) as net_sales
from sales_by_product_title_daily_v
where day_date >= (now() at time zone 'America/Los_Angeles')::date - 30
and day_date < (now() at time zone 'America/Los_Angeles')::date
and product_title <> 'x-redo'
group by product_title order by net_sales desc limit 15`;
  const sql = resolveSql({ queries_run: [saved], parameters: [] }, 0, {});
  assert.equal(sql, saved);
  const capture = async () => {
    await db.exec("set role authenticated; set statement_timeout = '8s'");
    try {
      const offsets = [];
      const t0 = performance.now();
      const rows = await fetchAllRows({ async rpc(name, args) {
        assert.equal(name, 'chat_run_readonly_query');
        assert.equal(args.query, saved);
        offsets.push(args.p_offset);
        const { rows } = await db.query('select public.chat_run_readonly_query($1, $2) as rows', [args.query, args.p_offset]);
        return { data: rows[0].rows };
      } }, sql);
      assert.deepEqual(offsets, [0]);
      return { rows, ms: performance.now() - t0 };
    } finally {
      await db.exec('reset role; reset statement_timeout');
    }
  };
  const explain = async () => {
    const queryPlan = (await db.query('explain (analyze, buffers, format json) ' + sql)).rows[0]['QUERY PLAN'][0];
    const nodes = (p) => [p, ...(p.Plans || []).flatMap(nodes)];
    const scan = nodes(queryPlan.Plan).find((p) => p['Relation Name'] === 'sales_by_product_title_daily_mv');
    return { scan: scan['Node Type'], index: scan['Index Name'], heapFetches: scan['Heap Fetches'],
      bufferHits: scan['Shared Hit Blocks'], elapsedMs: queryPlan['Execution Time'] };
  };

  const before = await capture();
  await db.exec(`update profiles set active_company_id = '00000000-0000-4000-a000-000000000005'`);
  assert.notDeepEqual((await capture()).rows, before.rows);
  await db.exec(`update profiles set active_company_id = '00000000-0000-4000-a000-000000000004'`);
  const beforePlan = await explain();
  const migration = readFileSync(new URL('../../supabase/migrations/20261124023000_product_title_revenue_covering_index.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  const after = await capture();
  assert.equal(before.rows.length, 15);
  assert.deepEqual(after.rows, before.rows);
  assert.ok(after.ms < 8000, 'report reached the authenticated request deadline');
  const afterPlan = await explain();
  assert.equal(afterPlan.index, 'sales_by_product_title_daily_mv_rank_idx');
  assert.equal(afterPlan.scan, 'Index Only Scan');
  assert.equal(afterPlan.heapFetches, 0);
  assert.ok(afterPlan.bufferHits < beforePlan.bufferHits);
  console.log(JSON.stringify({ before: beforePlan, after: afterPlan, beforeWrapperMs: before.ms, afterWrapperMs: after.ms, identicalRows: after.rows.length }));
} finally {
  await db.close();
}
