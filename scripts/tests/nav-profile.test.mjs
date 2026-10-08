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

test('standard workspaces surface Insights and the proven Marketing pages only', () => {
  const sections = navSectionsForProfile('standard', 'marketing', 'owner_admin', new Set());
  const insights = sections.find((section) => section.section === 'Insights');
  const marketing = sections.find((section) => section.section === 'Marketing');
  const ids = sections.flatMap((section) => section.items.map((item) => item.id));

  // Ask SILO left Insights for its own row under Home (2026-10-08).
  assert.deepEqual(insights.items.map((item) => item.id), [
    'reports/dashboards',
  ]);
  // SEO (2026-09-27) is ONE row: Studio, Search performance and Keywords are
  // tabs of it (seo-suite.test.mjs). It stays on the standard profile because
  // Keywords is where a client switches weekly rank tracking on for THEIR
  // company; the row carries the exec soft-launch gate OR a seo_approvers
  // grant, and every write is approver-gated by RLS.
  // Marketing Report and Silo Attribution are Baseballism-only (2026-10-07).
  assert.deepEqual(marketing.items.map((item) => item.id), [
    'reports/marketing-overview',
    'reports/marketing-explorer',
    // Ad Studio (2026-09-27): same exec soft-launch gate.
    'reports/ad-studio',
    'reports/seo',
  ]);
  assert.ok(!sections.some((section) => section.section === 'Reports'));
  assert.ok(!sections.some((section) => section.section === 'Sales'));
  assert.ok(!ids.includes('reports/library'));
  assert.ok(!ids.includes('reports/builder'));
  assert.ok(!ids.includes('reports/wow-report'));
  assert.ok(!ids.includes('reports/silo-attribution'));
});

test('Marketing Report and Silo Attribution: Baseballism keeps them, no standard role sees them', () => {
  const bb = { id: '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', entity_key: 'baseballism' };
  const bbIds = globalStub.SiloNav.navSectionsForCompany(bb, 'marketing', 'owner_admin', new Set())
    .flatMap((s) => s.items.map((i) => i.id));
  assert.ok(bbIds.includes('reports/wow-report'), 'Baseballism keeps Marketing Report');
  assert.ok(bbIds.includes('reports/silo-attribution'), 'Baseballism keeps Silo Attribution');
  for (const role of ['owner', 'owner_admin', 'executive', 'admin', 'member', 'viewer', 'user']) {
    for (const dept of ['marketing', 'exec', 'finance']) {
      const ids = navSectionsForProfile('standard', dept, role, new Set(['seo_approvers', 'silo_chat_managers', 'platform_admins']))
        .flatMap((s) => s.items.map((i) => i.id));
      assert.ok(!ids.includes('reports/wow-report'), `${role}/${dept} standard sees Marketing Report`);
      assert.ok(!ids.includes('reports/silo-attribution'), `${role}/${dept} standard sees Silo Attribution`);
    }
  }
});

test('Ask SILO is its own row right under Home, on both profiles, for the same people as before', () => {
  for (const profile of ['grandfathered', 'standard']) {
    const sections = navSectionsForProfile(profile, 'marketing', 'owner_admin', new Set());
    const start = sections.find((s) => s.section === 'Start');
    assert.equal(sections[0].section, 'Start', `${profile}: Start leads the menu`);
    assert.deepEqual(start.items.slice(0, 2).map((i) => i.id), ['finance/menu', 'reports/silo-chat'], profile);
    const elsewhere = sections.filter((s) => s.section !== 'Start')
      .some((s) => s.items.some((i) => i.id === 'reports/silo-chat'));
    assert.ok(!elsewhere, `${profile}: Ask SILO appears once`);
    // Visibility unchanged: exec/owner, or a silo_chat_managers grant.
    for (const role of ['owner', 'owner_admin', 'executive']) {
      const ids = navSectionsForProfile(profile, 'marketing', role, new Set()).flatMap((s) => s.items.map((i) => i.id));
      assert.ok(ids.includes('reports/silo-chat'), `${profile}/${role} sees Ask SILO`);
    }
    for (const role of ['admin', 'member', 'viewer', 'user']) {
      const ids = navSectionsForProfile(profile, 'marketing', role, new Set()).flatMap((s) => s.items.map((i) => i.id));
      assert.ok(!ids.includes('reports/silo-chat'), `${profile}/${role} without a grant does not see Ask SILO`);
      const granted = navSectionsForProfile(profile, 'marketing', role, new Set(['reports/silo-chat'])).flatMap((s) => s.items.map((i) => i.id));
      assert.ok(granted.includes('reports/silo-chat'), `${profile}/${role} with the grant sees Ask SILO`);
    }
  }
});

test('Reports replaces the sales menu for all existing viewers without widening standard discovery', () => {
  for (const role of ['owner', 'owner_admin', 'executive', 'admin', 'member', 'viewer', 'user']) {
    const sections = navSectionsForProfile('grandfathered', 'retail', role, new Set());
    const ids = sections.flatMap((s) => s.items.map((i) => i.id));
    assert.ok(ids.includes('reports/dashboards'), `${role} can still find the sales reports`);
    assert.ok(!sections.some((s) => s.section === 'Sales'));
    assert.ok(!globalStub.SiloNav.SALES_REPORT_PAGES.some((p) => ids.includes(p.id)));
    const standard = navSectionsForProfile('standard', 'retail', role, new Set())
      .flatMap((s) => s.items.map((i) => i.id));
    assert.equal(standard.includes('reports/dashboards'), ['owner', 'owner_admin', 'executive'].includes(role));
  }
});
