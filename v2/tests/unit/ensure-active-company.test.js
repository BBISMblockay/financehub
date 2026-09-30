/* pages/config.js -- ensureActiveCompany() reconciliation.
 *
 * The bug (PR #830 review, 2026-09-30): ensureActiveCompany() only ever
 * self-healed an EMPTY cache. A tab that already had a company cached from
 * before ANOTHER tab switched companies (company-picker's set_active_company
 * RPC changes profiles.active_company_id for the whole account, not just the
 * tab that clicked it) kept serving its stale label forever -- RLS-scoped
 * reads still landed on the new server-side company (correct), but the
 * sidebar/label and any client branch reading getActiveCompany() kept
 * naming the OLD one, recreating exactly the cross-company-looking UI the
 * company-picker ordering fix was meant to eliminate.
 *
 * What must hold:
 *   - an empty cache still self-heals from the server (pre-existing behavior)
 *   - a cache that already matches the server is left alone, with no extra
 *     entities fetch
 *   - a cache naming a DIFFERENT company than the server is corrected
 *   - a server with no active company at all clears a stale cache
 *   - a network hiccup during reconciliation falls back to the existing
 *     cache rather than blanking a previously-good one
 *   - calling with no supabaseClient behaves exactly as before (existing
 *     cache or null, no error)
 *
 * Second round (same review, cycle 3 -- source review, not yet posted to
 * the PR): a FAILED read (error set, not thrown -- how the Supabase JS
 * client actually reports most query failures) is a different fact from a
 * confirmed answer, and the first pass conflated them twice:
 *   - a failed profiles read must not be read as "confirmed no active
 *     company" and must not clear a good cache
 *   - a known mismatch (server names a different id than the cache) whose
 *     entity lookup then fails must not be silently handed back as though
 *     resolved -- one retry gives a transient blip a real chance, and a
 *     caller that repaints UI from the return value must be able to tell
 *     "still stale, unresolved" apart from "confirmed current"
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');

const r = createReporter('ensure-active-company');
const CONFIG_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'pages', 'config.js'), 'utf8');

/** Fresh sandbox with a real-enough sessionStorage, config.js already run. */
function freshConfig(seedCompany) {
  const store = new Map();
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  if (seedCompany) store.set('__SILO_COMPANY__', JSON.stringify(seedCompany));
  const g = { window: {}, sessionStorage, JSON, console };
  g.window = g;
  vm.createContext(g);
  vm.runInContext(CONFIG_SRC, g, { filename: 'config.js' });
  return g.window.__SILO_CONFIG__;
}

function fakeClient({
  uid = 'u1', activeCompanyId, entity, profErr, entityErr, entityFailTimes = 0,
  throwOnAuth, throwOnProfiles,
} = {}) {
  const calls = { entities: 0 };
  return {
    auth: {
      getUser: async () => {
        if (throwOnAuth) throw new Error('network down');
        return { data: { user: uid ? { id: uid } : null } };
      },
    },
    from: (table) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => {
                if (throwOnProfiles) throw new Error('network down');
                if (profErr) return { data: null, error: profErr };
                return { data: { active_company_id: activeCompanyId }, error: null };
              },
            }),
          }),
        };
      }
      if (table === 'entities') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => {
                calls.entities += 1;
                if (entityErr) return { data: null, error: entityErr };
                // entityFailTimes lets a test prove the retry actually helps:
                // fail the first N attempts (a transient blip), then succeed.
                if (calls.entities <= entityFailTimes) return { data: null, error: { message: 'transient' } };
                return { data: entity, error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    _calls: calls,
  };
}

(async () => {
  // 1. Empty cache, server has an active company -> resolves and caches it.
  {
    const cfg = freshConfig(null);
    const client = fakeClient({
      activeCompanyId: 'co-1',
      entity: { id: 'co-1', title: 'Baseballism', entity_key: 'baseballism' },
    });
    const co = await cfg.ensureActiveCompany(client);
    r.ok('empty cache self-heals to the server company', co?.id === 'co-1', JSON.stringify(co));
    r.ok('the resolved company is cached for next time', cfg.getActiveCompany()?.id === 'co-1');
  }

  // 2. Cache already matches server -> returned as-is, no entities fetch.
  {
    const cfg = freshConfig({ id: 'co-1', title: 'Baseballism', entity_key: 'baseballism' });
    const client = fakeClient({ activeCompanyId: 'co-1' });
    const co = await cfg.ensureActiveCompany(client);
    r.ok('a matching cache is returned unchanged', co?.id === 'co-1');
    r.ok('no entities round trip when the cache already matches', client._calls.entities === 0,
      `entities calls: ${client._calls.entities}`);
  }

  // 3. THE BUG: cache names a different company than the server.
  {
    const cfg = freshConfig({ id: 'co-old', title: 'Test Company', entity_key: 'test-co' });
    const client = fakeClient({
      activeCompanyId: 'co-new',
      entity: { id: 'co-new', title: 'Baseballism', entity_key: 'baseballism' },
    });
    const co = await cfg.ensureActiveCompany(client);
    r.ok('a stale cache is corrected to the server company', co?.id === 'co-new', JSON.stringify(co));
    r.ok('the corrected company overwrites the stale cache', cfg.getActiveCompany()?.id === 'co-new');
  }

  // 4. Server has no active company at all -> stale cache is cleared.
  {
    const cfg = freshConfig({ id: 'co-old', title: 'Test Company', entity_key: 'test-co' });
    const client = fakeClient({ activeCompanyId: null });
    const co = await cfg.ensureActiveCompany(client);
    r.ok('no server-side company resolves to null', co === null);
    r.ok('a stale cache is cleared rather than left dangling', cfg.getActiveCompany() === null);
  }

  // 5. Network hiccup during reconciliation -- do not blank a good cache.
  {
    const cfg = freshConfig({ id: 'co-1', title: 'Baseballism', entity_key: 'baseballism' });
    const client = fakeClient({ throwOnProfiles: true });
    const co = await cfg.ensureActiveCompany(client);
    r.ok('a network error falls back to the existing cache, not null', co?.id === 'co-1', JSON.stringify(co));
    r.ok('the cache itself is untouched by the failed reconciliation', cfg.getActiveCompany()?.id === 'co-1');
  }

  {
    const cfg = freshConfig({ id: 'co-1', title: 'Baseballism', entity_key: 'baseballism' });
    const client = fakeClient({ throwOnAuth: true });
    const co = await cfg.ensureActiveCompany(client);
    r.ok('an auth lookup failure also falls back to the existing cache', co?.id === 'co-1', JSON.stringify(co));
  }

  // 6. No supabaseClient -- behaves exactly as before: cache or null.
  {
    const cfg = freshConfig({ id: 'co-1', title: 'Baseballism', entity_key: 'baseballism' });
    const co = await cfg.ensureActiveCompany(null);
    r.ok('with no client, an existing cache is still returned', co?.id === 'co-1');
  }
  {
    const cfg = freshConfig(null);
    const co = await cfg.ensureActiveCompany(null);
    r.ok('with no client and no cache, resolves to null', co === null);
  }

  // 7. The entity lookup for a KNOWN mismatch fails on both attempts --
  //    fall back to the stale cache (callers need SOME id) but mark it as
  //    unresolved, never as confirmed, and never persist it as if it were.
  {
    const cfg = freshConfig({ id: 'co-old', title: 'Test Company', entity_key: 'test-co' });
    const client = fakeClient({ activeCompanyId: 'co-new', entity: null, entityFailTimes: 99 });
    const co = await cfg.ensureActiveCompany(client);
    r.ok('an unresolvable server entity falls back to the existing cache',
      co?.id === 'co-old', JSON.stringify(co));
    r.ok('the fallback is marked unresolved, not confirmed', co?._staleReconcile === true, JSON.stringify(co));
    r.ok('a real retry was attempted before giving up', client._calls.entities === 2,
      `entities calls: ${client._calls.entities}`);
    r.ok('the stale value is never persisted as if it were current',
      cfg.getActiveCompany()?.id === 'co-old' && !cfg.getActiveCompany()?._staleReconcile,
      JSON.stringify(cfg.getActiveCompany()));
  }

  // 8. The retry actually helps: the entity lookup fails ONCE (a transient
  //    blip) then succeeds -- the mismatch is corrected, not given up on.
  {
    const cfg = freshConfig({ id: 'co-old', title: 'Test Company', entity_key: 'test-co' });
    const client = fakeClient({
      activeCompanyId: 'co-new',
      entity: { id: 'co-new', title: 'Baseballism', entity_key: 'baseballism' },
      entityFailTimes: 1,
    });
    const co = await cfg.ensureActiveCompany(client);
    r.ok('a transient failure on the first attempt is retried and resolved',
      co?.id === 'co-new' && !co?._staleReconcile, JSON.stringify(co));
    r.ok('the corrected company is cached', cfg.getActiveCompany()?.id === 'co-new');
  }

  // 9. A FAILED profiles read (error set, not thrown) must not be read as
  //    a confirmed "no active company" -- it is a different fact, and
  //    conflating them used to clear a perfectly good cache on a blip.
  {
    const cfg = freshConfig({ id: 'co-1', title: 'Baseballism', entity_key: 'baseballism' });
    const client = fakeClient({ profErr: { message: 'permission denied' } });
    const co = await cfg.ensureActiveCompany(client);
    r.ok('a failed (not thrown) profiles read falls back to the existing cache',
      co?.id === 'co-1', JSON.stringify(co));
    r.ok('the cache is NOT cleared by a failed read',
      cfg.getActiveCompany()?.id === 'co-1', JSON.stringify(cfg.getActiveCompany()));
  }

  process.exit(r.summary().fail ? 1 : 0);
})();
