// Nav profile resolution — which company's sidebar a session is served.
//
// This is visibility only: RLS decides what data anyone can read, and it does
// so from profiles.active_company_id on the server, not from anything here. So
// the failure this guards is not a data leak. It is that a SECOND TENANT'S
// USER WAS SERVED BASEBALLISM'S SIDEBAR -- "BBISM Receivables" and the rest --
// whenever their tab had no cached company.
//
// That state is ordinary, not exotic: getActiveCompany() reads sessionStorage,
// which is per-TAB, while the Supabase auth session lives in localStorage and
// survives new tabs and restarts. Anyone arriving on a v2 page from a bookmark
// or a deep link is fully authenticated with no cached company, and
// resolveNavProfile(null) used to answer 'grandfathered'.
//
// It now answers 'standard' -- the smaller menu -- and silo-chrome.js repaints
// once ensureActiveCompany() resolves the real company. Same stance the
// grant-based nav unlocks already take: first paint shows less, never more.
//
// Run: node --test scripts/tests/nav-profile.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);

// nav-config.js is an IIFE over `window`; hand it a bare object and read back
// what it exports rather than re-implementing the function here.
const source = await readFile(new URL('v2/nav-config.js', root), 'utf8');
const globalStub = {};
new Function('window', source)(globalStub);
const { resolveNavProfile, navSectionsForProfile } = globalStub.SiloNav;

test('an unresolved company fails closed to the standard menu', () => {
  // The regression. Anything other than 'standard' here means a tenant whose
  // company has not resolved yet is being shown Baseballism's sidebar.
  assert.equal(resolveNavProfile(null), 'standard');
  assert.equal(resolveNavProfile(undefined), 'standard');
});

test('Baseballism still resolves to its grandfathered menu', () => {
  // The fail-closed default must not cost the existing tenant its menu once the
  // company IS known -- that is what the silo-chrome.js repaint restores.
  assert.equal(resolveNavProfile({ id: 'x', entity_key: 'baseballism' }), 'grandfathered');
});

test('any other company gets the standard menu', () => {
  assert.equal(resolveNavProfile({ id: 'y', entity_key: 'acme-commerce' }), 'standard');
  assert.equal(resolveNavProfile({ id: 'z', entity_key: 'test-co' }), 'standard');
});

test('entities.meta.nav_profile remains the explicit override', () => {
  // This is the configuration seam that keeps a new tenant from needing code:
  // a company that genuinely wants the fuller menu is a data change, not a
  // branch in nav-config.js.
  assert.equal(resolveNavProfile({ id: 'y', entity_key: 'acme-commerce', meta: { nav_profile: 'grandfathered' } }), 'grandfathered');
  assert.equal(resolveNavProfile({ id: 'x', entity_key: 'baseballism', meta: { nav_profile: 'standard' } }), 'standard');
  // An unrecognised override value must not be honoured -- fall through to the
  // entity_key rules rather than trusting arbitrary metadata.
  assert.equal(resolveNavProfile({ id: 'y', entity_key: 'acme-commerce', meta: { nav_profile: 'everything' } }), 'standard');
});

test('standard workspaces use Finance and surface Customers', () => {
  const sections = navSectionsForProfile('standard', 'finance', 'owner_admin', new Set());
  const finance = sections.find((section) => section.section === 'Finance');
  assert.ok(finance, 'standard finance navigation exists');
  assert.ok(!sections.some((section) => section.section === 'Operations'));
  assert.ok(finance.items.some((item) => item.id === 'finance/customers'));
  assert.ok(finance.items.some((item) => item.id === 'finance/accounting'));
});

test('workspace owner membership receives admin navigation without raw role leakage', () => {
  const ids = navSectionsForProfile('standard', 'finance', 'owner_admin', new Set())
    .flatMap((section) => section.items.map((item) => item.id));
  assert.ok(ids.includes('start/setup'));
  assert.ok(ids.includes('settings/workspace'));
});
