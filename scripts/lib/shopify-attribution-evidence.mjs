// Dedicated attribution path; never writes existing sales aggregates.
export const cents = value => {
  const s = String(value ?? '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw Error('Invalid monetary value');
  const [whole, fraction = ''] = s.replace('-', '').split('.');
  const n = (Number(whole) * 100 + Number(fraction.padEnd(2, '0'))) * (s.startsWith('-') ? -1 : 1);
  if (!Number.isSafeInteger(n)) throw Error('Monetary value exceeds integer range');
  return n;
};
const allowedTracking = new Set(['utm_source','utm_medium','utm_campaign','utm_content','utm_term','utm_id','tw_source','tw_adid','tw_campaign','fbadid','campaign_id','ad_id','adset_id','gad_campaignid']);
export function safeUrl(value) {
  try { const u = new URL(value, 'https://invalid.local'); return u.hostname === 'invalid.local' ? u.pathname : u.origin + u.pathname; }
  catch { return ''; }
}
export function landingEvidence(value) {
  const tracking = {};
  try {
    const u = new URL(value || '/', 'https://invalid.local');
    for (const [k,v] of u.searchParams) {
      if (allowedTracking.has(k.toLowerCase())) tracking[k.toLowerCase()] = v.slice(0,512);
      if (/^(gclid|gbraid|wbraid|fbclid|msclkid)$/.test(k)) tracking[k] = 'present';
    }
    return { landing_path: u.pathname, tracking, landing_truncated: String(value || '').length >= 255 };
  } catch { return { landing_path: '', tracking: {}, landing_truncated: false }; }
}
export function sanitizeVisit(v) {
  if (!v?.id || v.__typename && v.__typename !== 'CustomerVisit') return null;
  const utm = v.utmParameters || {};
  return { id:v.id, __typename:'CustomerVisit', occurredAt:v.occurredAt,
    source: safeUrl(v.source).includes('://') ? safeUrl(v.source) : String(v.source || '').slice(0,256),
    sourceType:v.sourceType || null, landingPage:safeUrl(v.landingPage), referrerUrl:safeUrl(v.referrerUrl),
    utmParameters:Object.fromEntries(['source','medium','campaign','content','term'].map(k => [k,String(utm[k] || '').slice(0,512)])) };
}
const visitFields = `id __typename ... on CustomerVisit { occurredAt source sourceType landingPage referrerUrl utmParameters { source medium campaign content term } }`;
export async function fetchJourney(connection, id, { gql, maxPages = 100 } = {}) {
  let cursor = null, first = null, last = null, order = null;
  const visits = new Map(), cursors = new Set();
  for (let page = 0; page < maxPages; page++) {
    const data = await gql(connection, `query AttributionJourney($id: ID!, $after: String) {
      order(id:$id) { id name createdAt sourceName customerJourneySummary {
        ready firstVisit { ${visitFields} } lastVisit { ${visitFields} }
        moments(first:50,after:$after) { nodes { ${visitFields} } pageInfo { hasNextPage endCursor } }
      } }
    }`, { id:'gid://shopify/Order/'+id, after:cursor });
    order = data.order;
    if (!order) throw Error('Shopify order unavailable: '+id);
    const j = order.customerJourneySummary;
    if (!j || !j.ready) return { id:order.id,name:order.name,createdAt:order.createdAt,sourceName:order.sourceName,customerJourneySummary:j ? {ready:false} : null };
    first = sanitizeVisit(j.firstVisit); last = sanitizeVisit(j.lastVisit);
    for (const v of [first,...(j.moments?.nodes || []).map(sanitizeVisit),last]) if (v) visits.set(v.id,v);
    const info = j.moments?.pageInfo;
    if (!info) throw Error('Missing journey pagination');
    if (!info.hasNextPage) return { id:order.id,name:order.name,createdAt:order.createdAt,sourceName:order.sourceName,
      customerJourneySummary:{ready:true,firstVisit:first,lastVisit:last,moments:{nodes:[...visits.values()],pageInfo:{hasNextPage:false}}} };
    if (!info.endCursor || cursors.has(info.endCursor)) throw Error('Journey cursor did not advance');
    cursors.add(info.endCursor); cursor = info.endCursor;
  }
  throw Error('Journey pagination limit exceeded');
}
export function validateDay(day, sales, control) {
  if (sales.raw?.table_data_was_null || control.raw?.table_data_was_null || sales.length >= 10000) throw Error('Incomplete ShopifyQL sales');
  if (control.length !== 1) throw Error('Missing daily control');
  const seen = new Set();
  const ledger = sales.map(r => {
    const id = String(r.order_id || '');
    if (!/^\d+$/.test(id) || seen.has(id) || r.day !== day) throw Error('Invalid order/day identity');
    seen.add(id);
    return { order_id:id,net_cents:cents(r.net_sales),total_cents:cents(r.total_sales) };
  });
  const net = cents(control[0].net_sales), total = cents(control[0].total_sales);
  if (ledger.reduce((s,r)=>s+r.net_cents,0) !== net || ledger.reduce((s,r)=>s+r.total_cents,0) !== total) throw Error('Shopify revenue mismatch');
  return {ledger,net,total};
}
export async function collectDay(connection, day, { ql, gql, rest, publish, commit=false, now=()=>new Date().toISOString() }) {
  // Stamp before reads: a slower old extraction cannot overwrite a newer one.
  const extracted = now();
  const shop = (await gql(connection, 'query AttributionShop { shop { currencyCode ianaTimezone primaryDomain { host } } }')).shop;
  if (!shop?.currencyCode || !shop.ianaTimezone) throw Error('Missing Shopify currency/timezone');
  const sales = await ql(connection, `FROM sales SHOW net_sales, total_sales GROUP BY order_id, day SINCE ${day} UNTIL ${day} LIMIT 10000`);
  const control = await ql(connection, `FROM sales SHOW net_sales, total_sales SINCE ${day} UNTIL ${day}`);
  const {ledger,net,total} = validateDay(day,sales,control);
  const orders=[]; let pending=0;
  for (const row of ledger) {
    const order = await fetchJourney(connection,row.order_id,{gql});
    pending += order.customerJourneySummary?.ready === false ? 1 : 0;
    const raw = await rest(connection,row.order_id);
    orders.push({order_id:row.order_id,evidence:{order,raw:landingEvidence(raw?.landing_site),own_hosts:[connection.shop_domain,shop.primaryDomain?.host].filter(Boolean)}});
  }
  if (commit) await publish({p_connection:connection.id,p_day:day,p_currency:shop.currencyCode,p_timezone:shop.ianaTimezone,
    p_ledger:ledger,p_orders:orders,p_net:net,p_total:total,p_extracted:extracted});
  return {day,orders:orders.length,pending,net_cents:net,total_cents:total,committed:commit};
}
export function dayRange(start,end) {
  const valid = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && new Date(v+'T00:00:00Z').toISOString().slice(0,10) === v;
  if (!valid(start) || !valid(end) || end < start) throw Error('Explicit valid inclusive dates required');
  const days=[];
  for(let t=Date.parse(start);t<=Date.parse(end);t+=86400000) days.push(new Date(t).toISOString().slice(0,10));
  if(days.length>31)throw Error('At most 31 days per run');
  return days;
}
