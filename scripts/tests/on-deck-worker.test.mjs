import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { run } from '../on-deck-prepare.mjs';
// Execute the worker's real mapping select against the original table DDL.
// The adapter only translates PostgREST field aliases; PostgreSQL checks columns.
const pg = new PGlite(), company = '11111111-1111-4111-8111-111111111111';
try {
  const migration = await readFile(new URL('../../supabase/migrations/20260909200000_shopify_product_skus.sql', import.meta.url), 'utf8');
  const ddl = migration.match(/create table if not exists public\.shopify_product_skus \([\s\S]*?\n\);/)[0];
  await pg.exec(`create table public.entities(id uuid primary key); insert into public.entities values('${company}'); ${ddl}`);
  await pg.query('insert into public.shopify_product_skus(company_entity_id,shop_domain,shopify_product_id,shopify_variant_id,sku,product_title,shopify_status) values($1,\'shop\',\'123\',\'1\',\'TEE-S\',\'Tee\',\'active\')', [company]);
  let mappings, finished = false; const factCalls = [];
  const db = {
    rpc: async (name) => { factCalls.push(name); return { data: name === 'on_deck_source_version' ? 'v1' : [] }; },
    from(table) {
      let columns = '*', update, filters = [];
      const q = {
        select(c) { columns = c; return q; }, eq(k,v) { filters.push([k,v]); return q; },
        order() { return q; }, range() { return q; }, lt() { return q; }, gt() { return q; }, in() { return q; },
        update(values) { update = values; return q; },
        async then(resolve, reject) {
          try {
            if (table === 'shopify_product_skus') {
              assert.deepEqual(filters, [['company_entity_id', company]]);
              const fields = columns.split(',').map(field => {
                assert.match(field, /^[a-z_]+(?::[a-z_]+)?$/);
                const [alias, column] = field.split(':'); return column ? `${column} as ${alias}` : alias;
              }).join(',');
              mappings = (await pg.query(`select ${fields} from public.shopify_product_skus where company_entity_id=$1`, [company])).rows;
              resolve({ data: mappings }); return;
            }
            if (table === 'on_deck_settings' && update) finished = update.last_status === 'Screened strongest opportunities';
            resolve({ data: table === 'on_deck_settings' && !update ? [{ company_entity_id: company, enabled: true, workflows: ['restock','launch','seo','ads'] }] : [] });
          } catch (e) { reject(e); }
        },
      }; return q;
    },
  };
  await run({ db, apiKey: 'test', fetcher: () => { throw new Error('No eligible proposal should spend'); } });
  assert.equal(mappings[0].status, 'active'); assert.equal(finished, true);
  for (const kind of ['product','launch','seo','ad']) assert.ok(factCalls.includes(`on_deck_${kind}_facts`));
  console.log('ok - worker mapping select uses installed schema and continues every workflow');
} finally { await pg.close(); }
