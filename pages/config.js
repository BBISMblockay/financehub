// /public/config.js
window.__SILO_CONFIG__ = {
  SUPABASE_URL: "https://mkquclffrvlzyecnabyf.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rcXVjbGZmcnZsenllY25hYnlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzODk4MDEsImV4cCI6MjA4Njk2NTgwMX0.vkOceXSXLnUMPp5FwvivcFvFcDxuVyQnlmmRc9hp1V4",
  REDIRECT_TO: "/v2/finance.html",
  EXPECT_EMAIL_CONFIRMATION: true,

  // Returns the active company object stored after login, or null.
  // Shape: { id, title, entity_key, meta, role }
  getActiveCompany() {
    try {
      return JSON.parse(sessionStorage.getItem('__SILO_COMPANY__') || 'null');
    } catch { return null; }
  },

  // Call this to store the active company (used by login + company-picker).
  setActiveCompany(company) {
    if (company) sessionStorage.setItem('__SILO_COMPANY__', JSON.stringify(company));
    else sessionStorage.removeItem('__SILO_COMPANY__');
  },

  // getActiveCompany() reads sessionStorage, which login.html populates --
  // but sessionStorage is per-TAB, while the Supabase auth session lives in
  // localStorage and survives new tabs/reloads/restarts. A returning user
  // who lands on a v2 page directly (bookmark, deep link, reopened tab)
  // skips login.html entirely, so this tab never got a __SILO_COMPANY__
  // value even though they're fully authenticated. Any page logic gated on
  // getActiveCompany() then silently no-ops (RLS-only queries still work
  // fine since active_company_id() reads the server-side profiles column,
  // which is what makes this so hard to spot -- most of the page looks
  // normal). Call this instead of a bare getActiveCompany() wherever the
  // result feeds a client-side query or write; it self-heals from the
  // server's already-resolved profiles.active_company_id instead of
  // re-running the full login picker flow.
  async ensureActiveCompany(supabaseClient) {
    const existing = this.getActiveCompany();
    if (existing?.id) return existing;
    if (!supabaseClient) return null;
    try {
      const { data: auth } = await supabaseClient.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) return null;
      const { data: prof } = await supabaseClient.from('profiles')
        .select('active_company_id').eq('id', uid).single();
      if (!prof?.active_company_id) return null;
      const { data: entity } = await supabaseClient.from('entities')
        .select('id, title, entity_key, meta').eq('id', prof.active_company_id).single();
      if (!entity) return null;
      this.setActiveCompany(entity);
      return entity;
    } catch {
      return null;
    }
  },

  // Stamp company_entity_id on insert payloads when a page omitted it.
  // DB trigger is the safety net; prefer these helpers in new UI writes.
  withCompany(row) {
    if (!row || row.company_entity_id != null) return row;
    const co = this.getActiveCompany();
    if (!co?.id) return row;
    return { ...row, company_entity_id: co.id };
  },

  withCompanyRows(rows) {
    if (!Array.isArray(rows)) return rows;
    const co = this.getActiveCompany();
    if (!co?.id) return rows;
    return rows.map((row) =>
      row && row.company_entity_id == null
        ? { ...row, company_entity_id: co.id }
        : row
    );
  }
};
