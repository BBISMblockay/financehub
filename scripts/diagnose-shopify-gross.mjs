// One-off diagnostic: fetch real orders for a shop/date window and break
// gross sales down under a few candidate exclusion rules (test orders, gift
// cards) side by side, to find which one explains a gap between sales_by_day
// and an external report (e.g. Better Reports/Power BI) that isn't caused by
// anything already fixed (location resolution, refund netting).
//
// Not part of the nightly pipeline — run manually via
// .github/workflows/diagnose-shopify-gross.yml.

import { createClient } from '@supabase/supabase-js';
import { DEFAULT_API_VERSION, fetchOrdersInWindow } from './lib/shopify-sync-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHOP_DOMAIN = process.env.DIAGNOSE_SHOP_DOMAIN;
const RANGE_START = process.env.DIAGNOSE_RANGE_START;
const RANGE_END = process.env.DIAGNOSE_RANGE_END;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
if (!SHOP_DOMAIN || !RANGE_START || !RANGE_END) throw new Error('Missing DIAGNOSE_SHOP_DOMAIN / DIAGNOSE_RANGE_START / DIAGNOSE_RANGE_END');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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

  const shopRes = await fetch(`${base}/shop.json`, { headers });
  if (!shopRes.ok) throw new Error(await shopRes.text());
  const { shop } = await shopRes.json();
  console.log(`shop base currency: ${shop.currency}`);

  console.log(`Fetching ${SHOP_DOMAIN} orders ${RANGE_START}..${RANGE_END} (status=any)...`);
  const orders = await fetchOrdersInWindow(headers, base, RANGE_START, RANGE_END);
  console.log(`orders fetched: ${orders.length}`);

  let testOrders = 0;
  let cancelledOrders = 0;
  let giftCardLines = 0;
  let giftCardGross = 0;
  let testOrderGross = 0;
  let excludedLineTypes = new Map(); // line items with no sku/title/price>0/item_type — what current sync drops
  let currencyCounts = new Map(); // order.currency (shop-currency at time of order)
  let presentmentCurrencyCounts = new Map(); // order.presentment_currency (customer-facing)
  let nonShopCurrencyOrders = 0;
  let priceVsShopMoneyDiffs = []; // lines where li.price != li.price_set.shop_money.amount

  let currentLogicGross = 0; // excl test, excl gift card (matches ordersToSalesRows) — uses li.price
  let inclTestGross = 0;     // incl test, excl gift card
  let inclGiftCardGross = 0; // excl test, incl gift card
  let rawGross = 0;          // no exclusions, no line filtering at all
  let shopMoneyGross = 0;    // excl test, excl gift card — uses li.price_set.shop_money.amount instead of li.price

  for (const order of orders) {
    const isTest = !!order.test;
    if (isTest) testOrders += 1;
    if (order.cancelled_at) cancelledOrders += 1;

    currencyCounts.set(order.currency, (currencyCounts.get(order.currency) || 0) + 1);
    presentmentCurrencyCounts.set(order.presentment_currency, (presentmentCurrencyCounts.get(order.presentment_currency) || 0) + 1);
    if (order.currency && order.currency !== shop.currency) nonShopCurrencyOrders += 1;

    for (const li of order.line_items || []) {
      const lineGross = Number(li.price || 0) * Number(li.quantity || 0);
      const shopMoneyUnit = Number(li.price_set?.shop_money?.amount ?? li.price ?? 0);
      const shopMoneyLineGross = shopMoneyUnit * Number(li.quantity || 0);
      rawGross += lineGross;
      if (isTest) testOrderGross += lineGross;
      if (li.gift_card) {
        giftCardLines += 1;
        giftCardGross += lineGross;
      }

      const keepsLine = !li.gift_card && (li.sku || li.title || Number(li.price) > 0);
      if (!keepsLine) {
        const key = `sku=${li.sku || ''}|title=${li.title || ''}|price=${li.price}`;
        excludedLineTypes.set(key, (excludedLineTypes.get(key) || 0) + 1);
      }

      if (!isTest && !li.gift_card) {
        currentLogicGross += lineGross;
        shopMoneyGross += shopMoneyLineGross;
      }
      if (!li.gift_card) inclTestGross += lineGross;
      if (!isTest) inclGiftCardGross += lineGross;

      if (Math.abs(shopMoneyUnit - Number(li.price || 0)) > 0.001 && priceVsShopMoneyDiffs.length < 10) {
        priceVsShopMoneyDiffs.push({
          order: order.name, sku: li.sku, li_price: li.price, shop_money: li.price_set?.shop_money?.amount,
          order_currency: order.currency, presentment_currency: order.presentment_currency,
        });
      }
    }
  }

  console.log(JSON.stringify({
    shop: SHOP_DOMAIN,
    shop_currency: shop.currency,
    range: [RANGE_START, RANGE_END],
    orders_fetched: orders.length,
    order_currency_counts: Object.fromEntries(currencyCounts),
    presentment_currency_counts: Object.fromEntries(presentmentCurrencyCounts),
    non_shop_currency_orders: nonShopCurrencyOrders,
    sample_price_vs_shop_money_diffs: priceVsShopMoneyDiffs,
    test_orders: testOrders,
    test_order_gross: testOrderGross.toFixed(2),
    cancelled_orders: cancelledOrders,
    gift_card_lines: giftCardLines,
    gift_card_gross: giftCardGross.toFixed(2),
    excluded_non_giftcard_lines: Object.fromEntries(excludedLineTypes),
    gross_current_logic_excl_test_excl_giftcard: currentLogicGross.toFixed(2),
    gross_shop_money_excl_test_excl_giftcard: shopMoneyGross.toFixed(2),
    gross_incl_test_excl_giftcard: inclTestGross.toFixed(2),
    gross_excl_test_incl_giftcard: inclGiftCardGross.toFixed(2),
    gross_raw_no_exclusions: rawGross.toFixed(2),
  }, null, 2));
}

main().catch((err) => {
  console.error('[diagnose-shopify-gross] fatal', err);
  process.exit(1);
});
