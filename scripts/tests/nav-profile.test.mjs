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

test('entities.meta.nav_profile is the ONLY thing that grants the fuller menu', () => {
  // 20261113040000 moved the profile into company data. entity_key used to
  // decide it, which meant one tenant was named in code every tenant loads and
  // no second workspace could ever be grandfathered without a code change.
  assert.equal(resolveNavProfile({ id: 'y', entity_key: 'acme-commerce', meta: { nav_profile: 'grandfathered' } }), 'grandfathered');
  assert.equal(resolveNavProfile({ id: 'x', entity_key: 'baseballism', meta: { nav_profile: 'grandfathered' } }), 'grandfathered');
  assert.equal(resolveNavProfile({ id: 'x', entity_key: 'baseballism', meta: { nav_profile: 'standard' } }), 'standard');
});

test('no entity_key gets the fuller menu on its own, including the one that used to', () => {
  // The flag is unset here. This is also what Baseballism looks like until the
  // migration is applied: the SMALLER menu, which is the safe direction.
  assert.equal(resolveNavProfile({ id: 'x', entity_key: 'baseballism' }), 'standard');
  assert.equal(resolveNavProfile({ id: 'y', entity_key: 'acme-commerce' }), 'standard');
  assert.equal(resolveNavProfile({ id: 'z', entity_key: 'test-co' }), 'standard');
  assert.equal(resolveNavProfile({ id: 'x', title: 'Baseballism' }), 'standard');
  // An unrecognised flag value is not honoured either, and there is no longer
  // an entity_key rule to fall through to.
  assert.equal(resolveNavProfile({ id: 'x', entity_key: 'baseballism', meta: { nav_profile: 'everything' } }), 'standard');
  assert.equal(resolveNavProfile({ id: 'y', meta: { nav_profile: 'grandfathered ' } }), 'standard');
  assert.equal(resolveNavProfile({ id: 'y', meta: {} }), 'standard');
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
  // Marketing Report stays grandfathered-only (2026-10-07). Silo Attribution
  // is open to every workspace since 2026-11-13 -- it was a pilot gated on one
  // company's entity id, and the page was always company-scoped.
  assert.deepEqual(marketing.items.map((item) => item.id), [
    'reports/silo-attribution',
    'reports/marketing-overview',
    'reports/marketing-explorer',
    // Ad Studio's exec soft-launch gate came off 2026-10-13 (Blake:
    // marketing is its audience), so it now shows on any role.
    'reports/ad-studio',
    'reports/seo',
  ]);
  // Affiliate Studio is reachable by URL only for now (2026-11-10).
  assert.ok(!ids.includes('marketing/affiliates'));
  assert.ok(!sections.some((section) => section.section === 'Reports'));
  assert.ok(!sections.some((section) => section.section === 'Sales'));
  assert.ok(!ids.includes('reports/library'));
  assert.ok(!ids.includes('reports/builder'));
  assert.ok(!ids.includes('reports/wow-report'));
  assert.ok(ids.includes('reports/silo-attribution'), 'Attribution is open to standard workspaces');
  // The Schedule tab is Baseballism-only for now (Blake, 2026-10-13): the
  // page is being shaped around how Baseballism runs tests, so a standard
  // workspace is not offered it yet.
  assert.ok(!ids.includes('reports/marketing-ops'));
});

test('Marketing Report stays grandfathered-only; Attribution is open to everyone', () => {
  const grandfathered = { id: '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', meta: { nav_profile: 'grandfathered' } };
  const bbIds = globalStub.SiloNav.navSectionsForCompany(grandfathered, 'marketing', 'owner_admin', new Set())
    .flatMap((s) => s.items.map((i) => i.id));
  assert.ok(bbIds.includes('reports/wow-report'), 'the grandfathered menu keeps Marketing Report');
  assert.ok(bbIds.includes('reports/silo-attribution'), 'and keeps Silo Attribution');
  for (const role of ['owner', 'owner_admin', 'executive', 'admin', 'member', 'viewer', 'user']) {
    for (const dept of ['marketing', 'exec', 'finance']) {
      const ids = navSectionsForProfile('standard', dept, role, new Set(['seo_approvers', 'silo_chat_managers', 'platform_admins']))
        .flatMap((s) => s.items.map((i) => i.id));
      assert.ok(!ids.includes('reports/wow-report'), `${role}/${dept} standard sees Marketing Report`);
      // Attribution has no role or department gate of its own, so every one of
      // these combinations gets it -- that is the unlock.
      assert.ok(ids.includes('reports/silo-attribution'), `${role}/${dept} standard lost Silo Attribution`);
    }
  }
});

test('Ask SILO is its own section right after Start, on both profiles, for the same people as before', () => {
  for (const profile of ['grandfathered', 'standard']) {
    const sections = navSectionsForProfile(profile, 'marketing', 'owner_admin', new Set());
    assert.deepEqual(sections.slice(0, 2).map((s) => s.section), ['Start', 'Ask SILO'], profile);
    assert.deepEqual(sections[1].items.map((i) => [i.id, i.label]), [['reports/silo-chat', 'Ask SILO']], profile);
    const elsewhere = sections.slice(2).concat(sections[0])
      .some((s) => s.items.some((i) => i.id === 'reports/silo-chat'));
    assert.ok(!elsewhere, `${profile}: Ask SILO appears once`);
    // Visibility unchanged: exec/owner, or a silo_chat_managers grant. A
    // person who cannot see the row gets no empty Ask SILO section either.
    for (const role of ['owner', 'owner_admin', 'executive']) {
      const ids = navSectionsForProfile(profile, 'marketing', role, new Set()).flatMap((s) => s.items.map((i) => i.id));
      assert.ok(ids.includes('reports/silo-chat'), `${profile}/${role} sees Ask SILO`);
    }
    for (const role of ['admin', 'member', 'viewer', 'user']) {
      const without = navSectionsForProfile(profile, 'marketing', role, new Set());
      assert.ok(!without.some((s) => s.section === 'Ask SILO'), `${profile}/${role} without a grant has no Ask SILO section`);
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
    assert.equal(standard.includes('reports/dashboards'), ['owner', 'owner_admin', 'executive', 'admin'].includes(role));
  }
});

// Ad Studio launched behind the exec soft-launch gate (2026-09-27). Marketing
// is the page's actual audience and most of that team carries profiles.role
// 'admin' or 'user', so the gate came off 2026-10-13 (Blake). `roles` and
// `departments` are AND-ed in the filter, so "exec OR marketing" is not
// expressible on one row -- hence no gate at all, like Performance and
// Explorer. ad-studio.html has no page-level role check, and ad_ideas RLS
// (company-scoped, any member) is the boundary either way.
test('Ad Studio reaches the whole marketing team, and nobody who had it loses it', () => {
  for (const profile of ['grandfathered', 'standard']) {
    for (const role of ['owner', 'owner_admin', 'executive', 'admin', 'member', 'viewer', 'user']) {
      for (const dept of ['marketing', 'exec', 'finance', 'logistics', 'retail']) {
        const ids = navSectionsForProfile(profile, dept, role, new Set())
          .flatMap((s) => s.items.map((i) => i.id));
        assert.ok(ids.includes('reports/ad-studio'), `${profile}/${dept}/${role} sees Ad Studio`);
      }
    }
  }
});

// The rollout case for 20261113040000 (found in review of PR #1267).
//
// resolveNavProfile now reads entities.meta.nav_profile and nothing else, and
// the company it is handed comes from ensureActiveCompany(). That function
// short-circuits on `existing.id === serverId` -- right company, serve the
// cache -- which was correct while the only field the sidebar read
// (entity_key) had always been in the cache. It is not correct across this
// migration: a tab that cached its company BEFORE the flag was set holds a
// record with no meta.nav_profile, and would draw the smaller menu for the
// life of the tab even though the server says grandfathered.
//
// pages/config.js now stamps a cache version and re-reads once when it is
// behind. These tests drive the REAL config.js against a fake sessionStorage
// and a fake PostgREST, not a re-implementation.
const configSource = await readFile(new URL('pages/config.js', root), 'utf8');

function loadConfig({ cached, serverCompanyId, entity }) {
  const store = new Map();
  if (cached) store.set('__SILO_COMPANY__', JSON.stringify(cached));
  const win = {
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
  };
  new Function('window', 'sessionStorage', configSource)(win, win.sessionStorage);
  let entityReads = 0;
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from(table) {
      return {
        select: () => ({
          eq: () => ({
            single: async () => {
              if (table === 'profiles') return { data: { active_company_id: serverCompanyId }, error: null };
              entityReads += 1;
              return { data: entity, error: null };
            },
          }),
        }),
      };
    },
  };
  return { cfg: win.__SILO_CONFIG__, db, reads: () => entityReads, store };
}

const BB = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7';
const GRANDFATHERED = { id: BB, title: 'Baseballism', entity_key: 'baseballism', meta: { nav_profile: 'grandfathered' } };

test('a company cached before the migration is re-read, so the fuller menu survives the rollout', async () => {
  // Exactly the rollout: cached under the old shape (no meta), server active
  // company unchanged, server row now carrying the flag.
  const stale = { id: BB, title: 'Baseballism', entity_key: 'baseballism', role: 'owner_admin' };
  const { cfg, db, reads, store } = loadConfig({ cached: stale, serverCompanyId: BB, entity: GRANDFATHERED });
  const company = await cfg.ensureActiveCompany(db);
  assert.equal(resolveNavProfile(company), 'grandfathered');
  assert.equal(reads(), 1, 'the entity row is read once, not on every call');
  // and the repaired record is written back, so the next page load in this
  // tab costs nothing extra...
  assert.equal(JSON.parse(store.get('__SILO_COMPANY__')).meta.nav_profile, 'grandfathered');
  // ...which this proves on a second, independent load of the same cache.
  const second = loadConfig({ cached: JSON.parse(store.get('__SILO_COMPANY__')), serverCompanyId: BB, entity: GRANDFATHERED });
  assert.equal(resolveNavProfile(await second.cfg.ensureActiveCompany(second.db)), 'grandfathered');
  assert.equal(second.reads(), 0, 'an up-to-date cache is served without a read');
});

test('the re-read preserves fields the entities row does not carry, and never blanks the cache', async () => {
  const stale = { id: BB, title: 'Baseballism', entity_key: 'baseballism', role: 'owner_admin' };
  const ok = loadConfig({ cached: stale, serverCompanyId: BB, entity: GRANDFATHERED });
  const merged = await ok.cfg.ensureActiveCompany(ok.db);
  assert.equal(merged.role, 'owner_admin', 'role is not on the entities row and must survive');

  // A failed re-read leaves a correct cache exactly as it was: the company id
  // is confirmed, so returning null or a stale flag here would break ~60 call
  // sites that only need an id to scope their own query by.
  const failed = loadConfig({ cached: stale, serverCompanyId: BB, entity: null });
  const kept = await failed.cfg.ensureActiveCompany(failed.db);
  assert.equal(kept.id, BB);
  assert.equal(kept.role, 'owner_admin');
  assert.equal(resolveNavProfile(kept), 'standard', 'fails closed to the smaller menu, as everywhere else');
});

test('a standard workspace is not promoted by the re-read', async () => {
  const other = '00000000-0000-4000-8000-00000000beef';
  const stale = { id: other, title: 'State Forty Eight', entity_key: 'statefortyeight' };
  const { cfg, db } = loadConfig({
    cached: stale,
    serverCompanyId: other,
    entity: { id: other, title: 'State Forty Eight', entity_key: 'statefortyeight', meta: {} },
  });
  assert.equal(resolveNavProfile(await cfg.ensureActiveCompany(db)), 'standard');
});
