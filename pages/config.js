// /public/config.js
window.__SILO_CONFIG__ = {
  SUPABASE_URL: "https://mkquclffrvlzyecnabyf.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rcXVjbGZmcnZsenllY25hYnlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzODk4MDEsImV4cCI6MjA4Njk2NTgwMX0.vkOceXSXLnUMPp5FwvivcFvFcDxuVyQnlmmRc9hp1V4",
  REDIRECT_TO: "/finance.html",
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
  }
};
