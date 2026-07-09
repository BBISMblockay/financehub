// Shared Shopify Admin API scope requirements for SILO sync jobs.
// Keep in sync with supabase/functions/test-shopify-connection/shopify-scopes.ts

window.SiloShopifyScopes = {
  API_VERSION: '2024-07',

  /** Scopes required per future sync job type */
  JOB_SCOPES: {
    test_connection: [],
    history_import: ['read_orders'],
    incremental_sales: ['read_orders'],
    inventory_snapshot: ['read_inventory', 'read_locations'],
    catalog_sync: ['read_products'],
    payouts_sync: ['read_shopify_payments_payouts'],
  },

  /** Union of scopes needed before any Phase 2 sync */
  REQUIRED_FOR_SYNC: [
    'read_orders',
    'read_products',
    'read_inventory',
    'read_locations',
  ],

  LABELS: {
    read_orders: 'Read orders',
    read_products: 'Read products',
    read_inventory: 'Read inventory',
    read_locations: 'Read locations',
  },

  normalizeGranted(scopesPayload) {
    if (!scopesPayload) return [];
    if (Array.isArray(scopesPayload)) {
      return scopesPayload.map((s) => (typeof s === 'string' ? s : s?.handle)).filter(Boolean);
    }
    const list = scopesPayload.access_scopes || scopesPayload.scopes || [];
    return list.map((s) => (typeof s === 'string' ? s : s?.handle)).filter(Boolean);
  },

  missingForSync(granted) {
    const set = new Set(granted || []);
    return this.REQUIRED_FOR_SYNC.filter((s) => !set.has(s));
  },

  missingForJob(granted, jobType) {
    const need = this.JOB_SCOPES[jobType] || [];
    const set = new Set(granted || []);
    return need.filter((s) => !set.has(s));
  },

  formatScopeList(handles) {
    return (handles || []).map((h) => this.LABELS[h] || h).join(', ');
  },
};
