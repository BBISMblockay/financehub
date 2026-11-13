window.__SILO_CONFIG__ = {
  SUPABASE_URL: 'http://localhost/stub',
  SUPABASE_ANON_KEY: 'stub-anon-key',
  // The grandfathered nav profile is company DATA (entities.meta.nav_profile,
  // 20261113040000), not an entity_key nav-config.js recognises.
  getActiveCompany() { return { id: 'C1', title: 'Baseballism', entity_key: 'baseballism', meta: { nav_profile: 'grandfathered' } }; },
  async ensureActiveCompany() { return this.getActiveCompany(); },
  withCompany(r) { return r; },
  withCompanyRows(r) { return r; },
};
