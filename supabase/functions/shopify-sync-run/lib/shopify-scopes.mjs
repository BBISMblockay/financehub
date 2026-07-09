// Keep in sync with v2/shopify-scopes.js and supabase/functions/test-shopify-connection/shopify-scopes.ts

export const JOB_SCOPES = {
  test_connection: [],
  history_import: ['read_orders'],
  incremental_sales: ['read_orders'],
  inventory_snapshot: ['read_inventory', 'read_locations'],
  catalog_sync: ['read_products'],
  payouts_sync: ['read_shopify_payments_payouts'],
};

export const REQUIRED_FOR_SYNC = [
  'read_orders',
  'read_products',
  'read_inventory',
  'read_locations',
];

export function scopesMissingForJob(granted, jobType) {
  const need = JOB_SCOPES[jobType] || [];
  const set = new Set(granted || []);
  return need.filter((s) => !set.has(s));
}

export function connectionReadyForSync(connection) {
  const missing = connection.scopes_missing;
  if (Array.isArray(missing)) return missing.length === 0;
  return false;
}
