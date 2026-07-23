// One-off diagnostic: introspect Shopify's GraphQL Return/Exchange schema and
// fetch real return data for specific orders, so the eventual sync addition
// (booking exchange gross sales on their processing date, matching Shopify's
// own "Total sales over time" report) is built against verified field names
// instead of guessed ones. GraphQL hard-errors on unknown fields, unlike the
// REST API, so this runs schema introspection first.
//
// Not part of the nightly pipeline — run manually via
// .github/workflows/diagnose-shopify-returns.yml.

import { createClient } from '@supabase/supabase-js';
import { DEFAULT_API_VERSION } from './lib/shopify-sync-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHOP_DOMAIN = process.env.DIAGNOSE_SHOP_DOMAIN;
const ORDER_NAMES = (process.env.DIAGNOSE_ORDER_NAMES || '').split(',').map((s) => s.trim()).filter(Boolean);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
if (!SHOP_DOMAIN) throw new Error('Missing DIAGNOSE_SHOP_DOMAIN');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function graphql(base, headers, query, variables) {
  const res = await fetch(`${base}/graphql.json`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2));
  return json;
}

async function introspectType(base, headers, typeName) {
  const query = `
    query IntrospectType($name: String!) {
      __type(name: $name) {
        name
        fields {
          name
          type { name kind ofType { name kind ofType { name kind } } }
        }
      }
    }
  `;
  const result = await graphql(base, headers, query, { name: typeName });
  return result.data?.__type;
}

async function main() {
  const { data: connection, error } = await supabase
    .from('shopify_connections')
    .select('*')
    .eq('shop_domain', SHOP_DOMAIN)
    .single();
  if (error) throw new Error(`connection load failed: ${error.message}`);

  const apiVersion = connection.api_version || DEFAULT_API_VERSION;
  const base = `https://${connection.shop_domain}/admin/api/${apiVersion}`;
  const headers = {
    'X-Shopify-Access-Token': connection.access_token,
    'Content-Type': 'application/json',
  };

  console.log(`=== Introspecting Return-related types on ${SHOP_DOMAIN} (API ${apiVersion}) ===`);
  for (const typeName of ['Return', 'ReturnLineItem', 'ExchangeLineItem', 'ReverseFulfillmentOrder', 'ReverseDelivery', 'Order']) {
    const type = await introspectType(base, headers, typeName);
    if (!type) {
      console.log(`\n--- ${typeName}: NOT FOUND on this API version ---`);
      continue;
    }
    console.log(`\n--- ${typeName} fields ---`);
    for (const f of type.fields || []) {
      const t = f.type;
      const typeDesc = t.name || t.ofType?.name || t.ofType?.ofType?.name || t.kind;
      console.log(`  ${f.name}: ${typeDesc}`);
    }
  }

  if (ORDER_NAMES.length) {
    console.log(`\n=== Fetching returns for orders: ${ORDER_NAMES.join(', ')} ===`);
    const query = `
      query OrderReturns($query: String!) {
        orders(first: 10, query: $query) {
          nodes {
            id
            name
            createdAt
            returns(first: 10) {
              nodes {
                id
                name
                status
                totalQuantity
              }
            }
          }
        }
      }
    `;
    const nameQuery = ORDER_NAMES.map((n) => `name:${n.replace('#', '')}`).join(' OR ');
    const result = await graphql(base, headers, query, { query: nameQuery });
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((err) => {
  console.error('[diagnose-shopify-returns] fatal', err);
  process.exit(1);
});
