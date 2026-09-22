process.on('uncaughtException', (error) => { console.error('\nFAILED:', error.message); process.exit(1); });
process.on('unhandledRejection', (error) => { console.error('\nFAILED:', error?.message || error); process.exit(1); });

// 20260922130000_company_document_identity.sql against a real PostgreSQL:
// additive, applies twice, seeds Baseballism with what its PDF printed
// before, and NEVER overwrites a value the settings page has since written.
// Run: node scripts/tests/company-document-identity-database.test.mjs
// (needs `npm ci --prefix scripts/tests/finance-db --ignore-scripts`)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const root = new URL('../../', import.meta.url);
const migration = await readFile(new URL('supabase/migrations/20260922130000_company_document_identity.sql', root), 'utf8');
const db = new PGlite();
let checks = 0;
const test = async (name, fn) => { await fn(); checks += 1; console.log(`ok ${checks} - ${name}`); };
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

await db.exec(`
  create table public.entities(id uuid primary key, entity_key text, title text);
  create table public.company_settings(
    company_entity_id uuid primary key references public.entities(id),
    business_timezone text not null, default_currency text not null);
  create function public.refresh_chat_schema_catalog() returns void language sql as $$ select $$;
  insert into public.entities values
    ('3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', 'baseballism', 'Baseballism'),
    ('11111111-1111-4111-8111-111111111111', 'test-company', 'Test Company');
  insert into public.company_settings values
    ('3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', 'America/Los_Angeles', 'USD'),
    ('11111111-1111-4111-8111-111111111111', 'America/Los_Angeles', 'USD');
`);
await db.exec(migration);

await test('all eleven document columns exist', async () => {
  const { rows } = await db.query(`select column_name from information_schema.columns
    where table_schema='public' and table_name='company_settings' and column_name in
    ('legal_name','address_line1','address_line2','city','region','postal_code','country','phone',
     'purchasing_contact_name','purchasing_contact_phone','purchasing_contact_email')`);
  assert.equal(rows.length, 11);
});

await test('Baseballism is seeded with exactly what its PDF printed before', async () => {
  const r = await one(`select * from public.company_settings where company_entity_id='3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'`);
  assert.equal(r.legal_name, 'Baseballism Inc.');
  assert.equal(r.address_line1, '11035 SW 11th Street');
  assert.equal(r.address_line2, 'Building B, Suite 290');
  assert.equal(r.city, 'Beaverton'); assert.equal(r.region, 'OR'); assert.equal(r.postal_code, '97005');
  assert.equal(r.country, null);
  assert.equal(r.purchasing_contact_name, 'Chris Clements');
  assert.equal(r.purchasing_contact_phone, '(831) 383-8283');
});

await test('another tenant gets nothing seeded', async () => {
  const r = await one(`select * from public.company_settings where company_entity_id='11111111-1111-4111-8111-111111111111'`);
  for (const c of ['legal_name','address_line1','city','purchasing_contact_name']) assert.equal(r[c], null, c);
});

await test('re-running never overwrites a value the settings page wrote', async () => {
  await db.exec(`update public.company_settings set legal_name='Baseballism Holdings LLC', purchasing_contact_name=null
    where company_entity_id='3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'`);
  await db.exec(migration);
  const r = await one(`select legal_name, purchasing_contact_name from public.company_settings where company_entity_id='3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'`);
  assert.equal(r.legal_name, 'Baseballism Holdings LLC');
  // A column emptied on purpose IS re-seeded, because null is the only signal
  // the migration has. Recorded here so it is a known property, not a surprise.
  assert.equal(r.purchasing_contact_name, 'Chris Clements');
});

await db.close();
console.log(`${checks} company document identity checks passed.`);
