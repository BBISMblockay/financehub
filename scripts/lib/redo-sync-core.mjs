// Redo returns API (historical backfill + reconciliation) sync logic.
// Complements supabase/functions/redo-webhook (real-time, forward-looking
// only) with a pull-based path that can walk Redo's full return history --
// the webhook alone was found to cover only a small slice of Shopify's
// actual refund volume, since it only fires for returns created/updated
// after a store's webhook was wired up.
//
// API surface verified 2026-08 against the real OpenAPI spec at
// github.com/redoapp/redo-dev (release/2.2 branch,
// redo/api-schema/openapi.yaml) -- NOT from Redo's marketing docs pages,
// which this dev sandbox's egress policy blocks outright (developers.redo.com
// / developer.getredo.com / api.getredo.com are all denied here). This code
// has therefore NOT been live-tested end to end against Redo -- run it
// somewhere with real network access (a local machine, or the paired
// "Redo Returns Backfill" GitHub Action) and check the first page's log
// line closely before trusting a full run.
//
//   GET https://api.getredo.com/v2.2/stores/{storeId}/returns
//   Auth:  Authorization: Bearer <redo_connections.api_secret>  (scope returns_read)
//   Query: updated_at_min / updated_at_max (ISO 8601, inclusive/exclusive),
//          status, shopify_order_name, provider_order_name
//   Pagination: request headers X-Page-Continue (cursor, echo back the prior
//     response's X-Page-Next header) and X-Page-Size (1-500, default 20).
//     No more pages once X-Page-Next comes back empty.
//   Response: { orders: [...], returns: [...] } -- returns[].order is a
//     lightweight reference; the full order (with line items and
//     product/variant names) lives in the sibling top-level orders[] array,
//     joined by id. Same split Redo's webhook payload uses (event.order vs
//     event.return.order), just at list-response scale.
//
// Row mapping mirrors supabase/functions/redo-webhook/index.ts field for
// field, so a return looks identical in redo_returns/redo_return_items
// whether it arrived via webhook or backfill -- keep both in sync if Redo's
// schema changes.

import { fetchWithRetry, sleep } from './shopify-sync-core.mjs';

export const REDO_API_BASE = 'https://api.getredo.com/v2.2';

function moneyAmount(node) {
  const raw = node?.amount?.amount;
  return raw ? Number(raw) || 0 : 0;
}

function personName(name) {
  const full = [name?.given, name?.surname].filter(Boolean).join(' ').trim();
  return full || null;
}

export function mapReturnRow(companyEntityId, ret, lastEventType) {
  const currency =
    ret.totals?.refund?.amount?.currency ||
    ret.totals?.exchange?.amount?.currency ||
    'USD';

  return {
    company_entity_id: companyEntityId,
    redo_return_id: ret.id,
    redo_order_id: ret.order?.id ?? null,
    shopify_order_name: ret.order?.name ?? null,
    shopify_order_id: ret.externalOrderIds?.[0] ?? ret.shopifyOrderIds?.[0] ?? null,
    return_type: ret.type ?? null,
    status: ret.status ?? null,
    compensation_methods: ret.compensationMethods ?? [],
    refund_amount: moneyAmount(ret.totals?.refund),
    exchange_amount: moneyAmount(ret.totals?.exchange),
    store_credit_amount: moneyAmount(ret.totals?.storeCredit),
    charge_amount: moneyAmount(ret.totals?.charge),
    shipping_fee_amount: moneyAmount(ret.totals?.shippingFee),
    currency,
    customer_email: ret.source?.emailAddress ?? null,
    customer_name: personName(ret.source?.name),
    last_event_type: lastEventType ?? null,
    redo_created_at: ret.createdAt ?? null,
    redo_updated_at: ret.updatedAt ?? null,
    raw: ret,
    updated_at: new Date().toISOString(),
  };
}

export function mapReturnItemRows(companyEntityId, returnRowId, ret, order) {
  const orderItemsById = new Map((order?.items || []).map((oi) => [oi.id, oi]));
  return (ret.items || []).map((it) => {
    const orderItem = orderItemsById.get(it.orderItem?.id);
    return {
      company_entity_id: companyEntityId,
      return_id: returnRowId,
      redo_item_id: it.id,
      sku: it.sku ?? orderItem?.variant?.sku ?? null,
      upc: it.upc ?? null,
      product_id: it.productId ?? orderItem?.product?.externalId ?? null,
      variant_id: it.variantId ?? orderItem?.variant?.externalId ?? null,
      product_name: orderItem?.product?.name ?? null,
      variant_name: orderItem?.variant?.name ?? null,
      quantity: it.quantity ?? null,
      status: it.status ?? null,
      reason: it.reason ?? null,
      reason_code: it.reasonCode ?? null,
      reasons: it.reasons ?? [],
      reason_codes: it.reasonCodes ?? [],
      customer_comment: it.customerComment ?? null,
      grade: it.grade ?? null,
      outcome: it.outcome ?? null,
      green_return: !!it.greenReturn,
      refund_amount: moneyAmount(it.refund),
      refund_type: it.refund?.type ?? null,
      product_value: moneyAmount(it.productValueNoTaxNoAdjustment),
      is_exchange: !!it.exchangeItem,
      exchange_product_name: it.exchangeItem?.product?.name ?? null,
      exchange_variant_name: it.exchangeItem?.variant?.name ?? null,
      exchange_quantity: it.exchangeItem?.quantity ?? null,
      raw: it,
    };
  });
}

export async function fetchReturnsPage({
  apiSecret,
  storeId,
  updatedAtMin,
  updatedAtMax,
  status,
  pageSize = 500,
  pageContinue,
}) {
  const url = new URL(`${REDO_API_BASE}/stores/${storeId}/returns`);
  if (updatedAtMin) url.searchParams.set('updated_at_min', updatedAtMin);
  if (updatedAtMax) url.searchParams.set('updated_at_max', updatedAtMax);
  if (status) url.searchParams.set('status', status);

  const headers = {
    Authorization: `Bearer ${apiSecret}`,
    'X-Page-Size': String(pageSize),
  };
  if (pageContinue) headers['X-Page-Continue'] = pageContinue;

  const res = await fetchWithRetry(url.toString(), { headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Redo API GET /stores/${storeId}/returns -> ${res.status}: ${text.slice(0, 500)}`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Redo API returned non-JSON: ${text.slice(0, 200)}`);
  }

  return {
    orders: body.orders || [],
    returns: body.returns || [],
    nextPageToken: res.headers.get('x-page-next') || null,
  };
}

async function upsertReturnsChunk(supabase, rows) {
  const { data, error } = await supabase
    .from('redo_returns')
    .upsert(rows, { onConflict: 'company_entity_id,redo_return_id' })
    .select('id, redo_return_id');
  if (error) throw new Error(`redo_returns upsert failed: ${error.message}`);
  return data || [];
}

async function replaceItemsForReturns(supabase, returnIds, itemRows) {
  if (returnIds.length) {
    const { error: delErr } = await supabase.from('redo_return_items').delete().in('return_id', returnIds);
    if (delErr) throw new Error(`redo_return_items delete failed: ${delErr.message}`);
  }
  if (itemRows.length) {
    const { error: insErr } = await supabase.from('redo_return_items').insert(itemRows);
    if (insErr) throw new Error(`redo_return_items insert failed: ${insErr.message}`);
  }
}

export async function backfillRedoReturns({
  supabase,
  companyEntityId,
  apiSecret,
  storeId,
  updatedAtMin,
  updatedAtMax,
  status,
  pageSize = 500,
  log = console.log,
  throttleMs = 250,
}) {
  let pageContinue;
  let pageCount = 0;
  let returnsSeen = 0;
  let returnsUpserted = 0;
  let itemsUpserted = 0;
  const returnIds = new Set();

  do {
    const page = await fetchReturnsPage({
      apiSecret,
      storeId,
      updatedAtMin,
      updatedAtMax,
      status,
      pageSize,
      pageContinue,
    });
    pageCount += 1;
    returnsSeen += page.returns.length;

    const ordersById = new Map((page.orders || []).map((o) => [o.id, o]));
    const rows = page.returns.map((ret) => {
      returnIds.add(ret.id);
      return mapReturnRow(companyEntityId, ret, 'backfill');
    });

    if (rows.length) {
      const saved = await upsertReturnsChunk(supabase, rows);
      const dbIdByReturnId = new Map(saved.map((r) => [r.redo_return_id, r.id]));

      const itemRows = [];
      const dbReturnIds = [];
      for (const ret of page.returns) {
        const dbId = dbIdByReturnId.get(ret.id);
        if (!dbId) continue;
        dbReturnIds.push(dbId);
        itemRows.push(...mapReturnItemRows(companyEntityId, dbId, ret, ordersById.get(ret.order?.id)));
      }
      await replaceItemsForReturns(supabase, dbReturnIds, itemRows);
      returnsUpserted += saved.length;
      itemsUpserted += itemRows.length;
    }

    log(
      `[redo-sync] page ${pageCount}: +${page.returns.length} returns ` +
      `(seen ${returnsSeen}, upserted ${returnsUpserted}, items ${itemsUpserted})`
    );

    pageContinue = page.nextPageToken;
    if (pageContinue) await sleep(throttleMs);
  } while (pageContinue);

  return { pages: pageCount, returnsSeen, returnsUpserted, itemsUpserted, returnIds };
}
