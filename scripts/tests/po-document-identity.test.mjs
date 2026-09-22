// The PO Builder's vendor PDF names the company from company_settings, never
// from a literal in the page. Until 2026-09-22 it printed "Baseballism Inc.",
// a Beaverton address and a named buyer for EVERY tenant.
//
// Run: node --test scripts/tests/po-document-identity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
// A classic <script> module, loaded the way the page loads it: into a window.
// (The repo is "type": "module", so require() would read it as ESM.)
const ctx = { window: {}, console };
vm.runInNewContext(await read('v2/po-document-identity.js'), ctx);
const { SETTINGS_COLUMNS } = ctx.window.SiloPoDocumentIdentity;
// Arrays made inside the sandbox have the sandbox's Array prototype, which
// deepStrictEqual rejects; the page only ever reads plain values from these.
const resolve = (input) => JSON.parse(JSON.stringify(ctx.window.SiloPoDocumentIdentity.resolve(input)));

const baseballism = {
  legal_name: 'Baseballism Inc.', address_line1: '11035 SW 11th Street', address_line2: 'Building B, Suite 290',
  city: 'Beaverton', region: 'OR', postal_code: '97005', country: null, phone: null,
  purchasing_contact_name: 'Chris Clements', purchasing_contact_phone: '(831) 383-8283', purchasing_contact_email: null,
};

test('configured settings print exactly what the page used to hardcode', () => {
  const id = resolve({ settings: baseballism, entity: { title: 'Baseballism' }, user: { name: 'Someone Else', email: 'x@example.com' } });
  assert.equal(id.name, 'Baseballism Inc.');
  assert.deepEqual(id.shipTo, ['Baseballism Inc.', '11035 SW 11th Street', 'Building B, Suite 290', 'Beaverton, OR 97005']);
  assert.deepEqual(id.contact, ['Chris Clements', '(831) 383-8283']);
  assert.equal(id.contactSource, 'settings');
  assert.equal(id.footer, 'Baseballism Inc. Purchase Order');
  assert.deepEqual(id.missing, []);
});

test('another tenant never inherits Baseballism: title fallback, generating user as contact, address named missing', () => {
  const id = resolve({ settings: { legal_name: null }, entity: { title: 'Test Company' }, user: { name: 'Pat Buyer', email: 'pat@test.example' } });
  assert.equal(id.name, 'Test Company');
  assert.deepEqual(id.shipTo, ['Test Company']);
  assert.deepEqual(id.contact, ['Pat Buyer', 'pat@test.example']);
  assert.equal(id.contactSource, 'user');
  assert.equal(id.footer, 'Test Company Purchase Order');
  assert.deepEqual(id.missing, ['ship-to address']);
  assert.doesNotMatch(JSON.stringify(id), /Baseballism|Beaverton|383-8283|Clements/);
});

test('nothing known at all is reported, not invented', () => {
  const id = resolve({});
  assert.equal(id.name, '');
  assert.deepEqual(id.shipTo, []);
  assert.deepEqual(id.contact, []);
  assert.equal(id.contactSource, 'none');
  assert.equal(id.footer, 'Purchase Order');
  assert.deepEqual(id.missing, ['company name', 'ship-to address', 'buyer contact']);
});

test('whitespace and partial city lines are tidied, country is its own line', () => {
  const id = resolve({ settings: { legal_name: '  Acme  Co ', address_line1: '1 Main St', city: 'Austin', region: '', postal_code: '78701', country: 'US' } });
  assert.deepEqual(id.shipTo, ['Acme Co', '1 Main St', 'Austin, 78701', 'US']);
});

test('the PO builder reads the identity module and carries no Baseballism literal in its PDF', async () => {
  const html = await read('v2/po-builder.html');
  assert.match(html, /<script src="po-document-identity\.js"><\/script>/);
  assert.match(html, /SiloPoDocumentIdentity\.resolve\(/);
  assert.match(html, /from\('company_settings'\)\.select\(window\.SiloPoDocumentIdentity\.SETTINGS_COLUMNS\)/);
  const pdf = html.slice(html.indexOf('function buildVendorPdfHtml'), html.indexOf('function generateVendorPdf'));
  assert.doesNotMatch(pdf, /Baseballism|Beaverton|11035 SW|383-8283|Clements/);
});

test('the Company settings page edits every column the PDF reads', async () => {
  const html = await read('v2/settings-company.html');
  for (const col of SETTINGS_COLUMNS.split(', ')) assert.match(html, new RegExp(`data-col="${col}"`), col);
  assert.match(html, /from\('company_settings'\)\.select\(/);
});

test('the migration is additive and seeds Baseballism only where null', async () => {
  const sql = await read('supabase/migrations/20260922130000_company_document_identity.sql');
  for (const col of SETTINGS_COLUMNS.split(', ')) assert.match(sql, new RegExp(`add column if not exists ${col}\\b`), col);
  assert.match(sql, /e\.entity_key = 'baseballism'/);
  assert.match(sql, /coalesce\(cs\.legal_name, 'Baseballism Inc\.'\)/);
  assert.doesNotMatch(sql, /set legal_name\s*=\s*'Baseballism/);
  assert.match(sql, /refresh_chat_schema_catalog\(\)/);
});
