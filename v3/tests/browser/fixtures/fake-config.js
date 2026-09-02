window.__SILO_CONFIG__ = {
  SUPABASE_URL: 'http://localhost/stub',
  SUPABASE_ANON_KEY: 'stub-anon-key',
  getActiveCompany() { return { id: 'C1', title: 'Baseballism', entity_key: 'baseballism' }; },
  async ensureActiveCompany() { return this.getActiveCompany(); },
  withCompany(r) { return r; },
  withCompanyRows(r) { return r; },
};
