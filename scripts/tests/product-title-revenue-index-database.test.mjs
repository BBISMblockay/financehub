import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
try {
  await db.exec(`
    create function active_company_id() returns uuid language sql stable as
      $$ select '00000000-0000-4000-a000-000000000004'::uuid $$;
    create materialized view public.sales_by_product_title_daily_mv as
    select ('00000000-0000-4000-a000-00000000000' || (i % 6))::uuid company_entity_id,
           date '2026-01-01' + ((i / 6) % 350) day_date,
           case when i % 101 = 0 then 'x-redo' when i % 103 = 0 then null
                else 'title-' || (i % 1201) end product_title,
           (i % 90 - 17)::numeric / 10 net_sales,
           repeat(md5(i::text), 6) filler
    from generate_series(1, 845114) as i;
    create index sales_by_product_title_daily_mv_day_idx
      on public.sales_by_product_title_daily_mv (company_entity_id, day_date);
    create view public.sales_by_product_title_daily_v as
    select * from public.sales_by_product_title_daily_mv
    where company_entity_id = active_company_id();
  `);
  await db.exec('vacuum analyze public.sales_by_product_title_daily_mv');
  // Freeze the failed delivery's Pacific date window. Sort equal totals by
  // title only to compare the two plans deterministically in this fixture.
  const sql = `select product_title as product_name, sum(net_sales) as net_sales
    from public.sales_by_product_title_daily_v
    where day_date >= date '2026-10-24' and day_date < date '2026-11-23'
      and product_title <> 'x-redo'
    group by product_title order by net_sales desc, product_title limit 15`;
  const explain = async () => {
    const queryPlan = (await db.query('explain (analyze, buffers, format json) ' + sql)).rows[0]['QUERY PLAN'][0];
    const nodes = (p) => [p, ...(p.Plans || []).flatMap(nodes)];
    const scan = nodes(queryPlan.Plan).find((p) => p['Relation Name'] === 'sales_by_product_title_daily_mv');
    return { scan: scan['Node Type'], index: scan['Index Name'], heapFetches: scan['Heap Fetches'],
      bufferHits: scan['Shared Hit Blocks'], elapsedMs: queryPlan['Execution Time'] };
  };

  const before = await db.query(sql);
  const beforePlan = await explain();
  const migration = readFileSync(new URL('../../supabase/migrations/20261124023000_product_title_revenue_covering_index.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  const after = await db.query(sql);
  assert.equal(before.rows.length, 15);
  assert.deepEqual(after.rows, before.rows);
  const afterPlan = await explain();
  assert.equal(afterPlan.index, 'sales_by_product_title_daily_mv_rank_idx');
  assert.equal(afterPlan.scan, 'Index Only Scan');
  assert.equal(afterPlan.heapFetches, 0);
  assert.ok(afterPlan.bufferHits < beforePlan.bufferHits);
  console.log(JSON.stringify({ before: beforePlan, after: afterPlan, identicalRows: after.rows.length }));
} finally {
  await db.close();
}
