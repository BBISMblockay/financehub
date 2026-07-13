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
