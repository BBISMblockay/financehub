export const SHOPIFY_API_VERSION = '2025-01';

export const JOB_SCOPES: Record<string, string[]> = {
  test_connection: [],
  history_import: ['read_orders'],
  incremental_sales: ['read_orders'],
  inventory_snapshot: ['read_inventory', 'read_locations'],
  catalog_sync: ['read_products'],
};

/** Union of scopes needed before any Phase 2 sync */
export const REQUIRED_FOR_SYNC = [
  'read_orders',
  'read_products',
  'read_inventory',
  'read_locations',
];

export function normalizeGranted(scopesPayload: unknown): string[] {
  if (!scopesPayload) return [];
  if (Array.isArray(scopesPayload)) {
    return scopesPayload
      .map((s) => (typeof s === 'string' ? s : (s as { handle?: string })?.handle))
      .filter(Boolean) as string[];
  }
  const obj = scopesPayload as { access_scopes?: { handle: string }[]; scopes?: string[] };
  const list = obj.access_scopes || obj.scopes || [];
  return list
    .map((s) => (typeof s === 'string' ? s : s?.handle))
    .filter(Boolean) as string[];
}

export function missingForSync(granted: string[]): string[] {
  const set = new Set(granted);
  return REQUIRED_FOR_SYNC.filter((s) => !set.has(s));
}

export function missingForJob(granted: string[], jobType: string): string[] {
  const need = JOB_SCOPES[jobType] || [];
  const set = new Set(granted);
  return need.filter((s) => !set.has(s));
}
