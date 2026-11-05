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
// Codes are what the customer typed, so they are evidence, not a channel: capped,
// trimmed and de-duplicated the way visits are, and never interpreted here.
export function sanitizeDiscountCodes(value) {
  if (!Array.isArray(value)) return [];
  const codes = [], seen = new Set();
  for (const raw of value) {
    const code = String(raw ?? '').trim().slice(0,128), key = code.toLowerCase();
    // Shopify matches a code regardless of case, so the same code in two spellings is
    // one code. The first spelling is kept: the evidence says what Shopify returned.
    if (code && !seen.has(key)) { seen.add(key); codes.push(code); }
    if (codes.length === 20) break;
  }
  return codes;
}
const visitFields = `__typename ... on CustomerVisit { id occurredAt source sourceType landingPage referrerUrl utmParameters { source medium campaign content term } }`;
// Exported so the batched query below and any probe build the SAME selection. Two
// spellings of this selection is how the serial and batched paths would quietly drift
// apart, and a drift here is wrong attribution rather than a crash.
export const journeyVisitFields = visitFields;
export const unavailableOrder = id => ({id:'gid://shopify/Order/'+id,name:String(id),createdAt:null,sourceName:null,customerJourneySummary:null,evidence_status:'unavailable'});

/** Turn ONE order payload into the stored evidence shape.
 *
 *  The single order fetch and the batched fetch both go through here, so they cannot
 *  disagree about what an order's journey means. `visits` is the accumulator across
 *  pages of the same order; it is a Map keyed by visit id, and insertion order is
 *  [firstVisit, ...moments, lastVisit] because `Map.set` keeps the LAST copy of a
 *  repeated id and the page model relies on that.
 *
 *  Returns { journey, needsMorePages, endCursor }. `needsMorePages` is the caller's cue
 *  that this order has more moments than the page asked for -- the batched path hands
 *  such an order to fetchJourney() alone rather than guessing. */
export function buildJourney(order, visits = new Map()) {
  if (!order) return {journey:null, needsMorePages:false, endCursor:null};
  const j = order.customerJourneySummary;
  if (!j || !j.ready) return {journey:{id:order.id,name:order.name,createdAt:order.createdAt,sourceName:order.sourceName,
    discountCodes:sanitizeDiscountCodes(order.discountCodes),customerJourneySummary:j ? {ready:false} : null},
    needsMorePages:false, endCursor:null};
  const first = sanitizeVisit(j.firstVisit), last = sanitizeVisit(j.lastVisit);
  for (const v of [first,...(j.moments?.nodes || []).map(sanitizeVisit),last]) if (v) visits.set(v.id,v);
  const info = j.moments?.pageInfo;
  if (!info) throw Error('Missing journey pagination');
  return {
    journey:{id:order.id,name:order.name,createdAt:order.createdAt,sourceName:order.sourceName,
      discountCodes:sanitizeDiscountCodes(order.discountCodes),
      customerJourneySummary:{ready:true,firstVisit:first,lastVisit:last,moments:{nodes:[...visits.values()],pageInfo:{hasNextPage:false}}}},
    needsMorePages:info.hasNextPage === true,
    endCursor:info.endCursor ?? null,
  };
}

export async function fetchJourney(connection, id, { gql, maxPages = 100 } = {}) {
  let cursor = null;
  const visits = new Map(), cursors = new Set();
  for (let page = 0; page < maxPages; page++) {
    const data = await gql(connection, `query AttributionJourney($id: ID!, $after: String) {
      order(id:$id) { id name createdAt sourceName discountCodes customerJourneySummary {
        ready firstVisit { ${visitFields} } lastVisit { ${visitFields} }
        moments(first:50,after:$after) { nodes { ${visitFields} } pageInfo { hasNextPage endCursor } }
      } }
    }`, { id:'gid://shopify/Order/'+id, after:cursor });
    if (!data.order) return unavailableOrder(id);
    const {journey,needsMorePages,endCursor} = buildJourney(data.order, visits);
    if (!needsMorePages) return journey;
    if (!endCursor || cursors.has(endCursor)) throw Error('Journey cursor did not advance');
    cursors.add(endCursor); cursor = endCursor;
  }
  throw Error('Journey pagination limit exceeded');
}

/** Many orders' journeys in one request.
 *
 *  Why this exists: collecting a day used to be one GraphQL call per order, and a
 *  4,103-order day measured 32 minutes at a dead-flat 2.13 orders/sec -- pure serial
 *  round-trip latency, not rate limiting. Asking for many orders at once is the fix.
 *
 *  Two deliberate choices:
 *   - `moments` is paged SHALLOW here (most journeys are a handful of visits), and any
 *     order that turns out to have more is re-fetched on its own through fetchJourney().
 *     Deep journeys are rare, so the rare case pays the old cost and the common case
 *     does not.
 *   - an id Shopify does not return as an Order is reported `unavailable`, exactly as
 *     the single fetch does, rather than being skipped. A dropped id would be evidence
 *     silently lost.
 *
 *  Results come back keyed by the numeric id that was asked for, in no particular
 *  order; the caller keeps ledger order. */
export async function fetchJourneys(connection, ids, { gql, moments = 10, maxPages = 100, onSplit = null } = {}) {
  const out = new Map(), deep = [];
  if (!ids.length) return out;
  await collectBatch(connection, ids, { gql, moments, onSplit }, out, deep);
  // Resolved AFTER all the batching, and never inside a splittable region: a deep journey
  // that genuinely cannot be read must fail once, not be re-attempted by every split.
  // Rare, and worth a round trip each rather than a deeper page for everybody.
  for (const id of deep) out.set(id, await fetchJourney(connection, id, { gql, maxPages }));
  return out;
}

/** One batched request, halving itself on any failure.
 *
 *  Admin GraphQL prices a query by calculated cost, and a batch costs roughly its size
 *  times its moments page. shopifyGraphql() throws on a GraphQL-level THROTTLED or
 *  cost-limit answer rather than backing off, so a batch sized for a quiet moment would
 *  otherwise fail a whole day the first time the bucket runs dry.
 *
 *  Halving on failure covers throttling, a cost refusal and an oversized response with
 *  one rule, and the worst case is the serial path: at size one there is nothing left to
 *  split, so the error surfaces exactly as it does today. Splitting is reported, because
 *  a batch quietly degrading to serial would otherwise look like the speedup not
 *  working. */
async function collectBatch(connection, ids, opts, out, deep) {
  const { gql, moments, onSplit } = opts;
  try {
    const data = await gql(connection, `query AttributionJourneyBatch($ids: [ID!]!, $after: String) {
    nodes(ids: $ids) { __typename ... on Order { id name createdAt sourceName discountCodes
      customerJourneySummary { ready firstVisit { ${visitFields} } lastVisit { ${visitFields} }
        moments(first:${moments},after:$after) { nodes { ${visitFields} } pageInfo { hasNextPage endCursor } } } } }
  }`, { ids: ids.map(id => 'gid://shopify/Order/'+id), after: null });
    const nodes = data?.nodes;
    // A batch that does not come back one node per id cannot be matched up safely: the
    // positional contract is all that ties a node to the id asked for.
    if (!Array.isArray(nodes) || nodes.length !== ids.length) throw Error('Journey batch did not answer every order');
    const staged = new Map(), stagedDeep = [];
    for (const [index, node] of nodes.entries()) {
      const id = ids[index];
      // null is the answer the single fetch also gets for an order Shopify will not
      // return, so it means the same thing here: unavailable, recorded, not dropped. A
      // node that comes back as something OTHER than an Order is not an unavailable
      // order, it is a wrong id, and recording that as unmeasured would hide the mistake.
      if (!node) { staged.set(id, unavailableOrder(id)); continue; }
      if (node.__typename !== 'Order') throw Error('Journey batch returned a non-order node');
      const {journey,needsMorePages} = buildJourney(node);
      if (needsMorePages) stagedDeep.push(id); else staged.set(id, journey);
    }
    // Merged only once the whole batch has parsed: a batch that throws halfway must leave
    // nothing behind for the retry to double up on.
    for (const [id, journey] of staged) out.set(id, journey);
    deep.push(...stagedDeep);
  } catch (error) {
    if (ids.length === 1) throw error;
    if (onSplit) onSplit({ size: ids.length, reason: error?.message ? String(error.message).slice(0, 200) : 'unknown' });
    const half = Math.ceil(ids.length / 2);
    await collectBatch(connection, ids.slice(0, half), opts, out, deep);
    await collectBatch(connection, ids.slice(half), opts, out, deep);
  }
}
// The collector's own ceiling on how many order rows it will read for one day. It is NOT
// a Shopify limit: 2025-11-28 (9,916 orders) failed on THIS bound, not on a refusal from
// ShopifyQL. Raising it is safe by construction rather than by hope, because validateDay()
// reconciles the per-order rows against the day's own control total to the penny and
// rejects duplicate order ids -- so a silently capped or shifted OFFSET window cannot
// publish, it can only fail. Raise it only once deep paging has been measured on a real
// shop (scripts/shopify-attribution-plan-probe.mjs reports exactly that).
export const DEFAULT_MAX_DAY_ROWS = 10000;
export function validateDay(day, sales, control, { maxRows = DEFAULT_MAX_DAY_ROWS } = {}) {
  if (sales.raw?.table_data_was_null || control.raw?.table_data_was_null || sales.length >= maxRows) throw Error('Incomplete ShopifyQL sales for the day; collector row ceiling is '+maxRows);
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
export async function fetchSalesDay(connection,day,ql,{maxRows=DEFAULT_MAX_DAY_ROWS}={}) {
  const rows=[];
  // Stable 500-row pages stay below the shared client's 1,000-row ceiling.
  for(let offset=0;offset<maxRows;offset+=500){
    const page=await ql(connection,`FROM sales SHOW net_sales, total_sales GROUP BY order_id, day SINCE ${day} UNTIL ${day} ORDER BY order_id ASC LIMIT 500 OFFSET ${offset}`);
    if(page.raw?.table_data_was_null||page.length>500)throw Error('Incomplete ShopifyQL sales page');
    rows.push(...page);
    if(page.length<500)return rows;
  }
  throw Error('Attribution daily row ceiling of '+maxRows+' reached; no snapshot published');
}
/** Landing sites for many orders in one REST call.
 *
 *  `restBatch` asks Shopify for a list of ids at once; anything it does not return is
 *  re-asked one at a time through `rest`, which is the call that has always been made
 *  and which still throws on a bad response. So a batched run can be faster than the
 *  serial one but never more forgiving: an order whose landing site cannot be read
 *  fails the day exactly as it does today, instead of publishing with empty evidence.
 *
 *  Returns a Map of numeric id -> the order object (or whatever `rest` returns). */
export async function fetchLandingSites(connection, ids, { rest, restBatch = null, batch = 1 } = {}) {
  const out = new Map();
  if (!ids.length) return out;
  if (!restBatch || batch <= 1) {
    for (const id of ids) out.set(id, await rest(connection, id));
    return out;
  }
  for (let i = 0; i < ids.length; i += batch) {
    const slice = ids.slice(i, i + batch);
    for (const order of await restBatch(connection, slice)) {
      const id = String(order?.id ?? '');
      if (id) out.set(id, order);
    }
    for (const id of slice) if (!out.has(id)) out.set(id, await rest(connection, id));
  }
  return out;
}

export async function collectDay(connection, day, { ql, gql, rest, restBatch=null, publish, stage=null, finalize=null, decorate=null, commit=false, now=()=>new Date().toISOString(), chunk=500, threshold=5000, journeyBatch=1, landingBatch=1, journeyMoments=10, maxRows=DEFAULT_MAX_DAY_ROWS, onSplit=null }) {
  // Stamp before reads: a slower old extraction cannot overwrite a newer one.
  const extracted = now();
  const shop = (await gql(connection, 'query AttributionShop { shop { currencyCode ianaTimezone primaryDomain { host } } }')).shop;
  if (!shop?.currencyCode || !shop.ianaTimezone) throw Error('Missing Shopify currency/timezone');
  const sales = await fetchSalesDay(connection,day,ql,{maxRows});
  const control = await ql(connection, `FROM sales SHOW net_sales, total_sales SINCE ${day} UNTIL ${day}`);
  const {ledger,net,total} = validateDay(day,sales,control,{maxRows});
  const own_hosts=[connection.shop_domain,shop.primaryDomain?.host,shop.primaryDomain?.host?.replace(/^www\./,''),'www.'+shop.primaryDomain?.host?.replace(/^www\./,'')].filter(h=>h&&!h.includes('undefined'));
  // One order at a time is two sequential HTTP calls per order, which measured a dead-flat
  // 2.13 orders/sec on a 4,103-order day -- 32 minutes of pure round-trip latency. Asking
  // for many orders per call is the whole speedup. Both batch sizes default to 1, which is
  // byte for byte the serial path that has published every snapshot so far, so turning
  // this on is a configuration change and turning it off is too.
  const orders=[]; let pending=0;
  const outer=Math.max(landingBatch,journeyBatch,1);
  for (let i=0;i<ledger.length;i+=outer) {
    const slice=ledger.slice(i,i+outer), ids=slice.map(r=>r.order_id);
    const journeys=new Map();
    if (journeyBatch>1) {
      for (let j=0;j<ids.length;j+=journeyBatch) {
        for (const [id,order] of await fetchJourneys(connection,ids.slice(j,j+journeyBatch),{gql,moments:journeyMoments,onSplit})) journeys.set(id,order);
      }
    } else {
      for (const id of ids) journeys.set(id,await fetchJourney(connection,id,{gql}));
    }
    // An order Shopify would not return has no landing site to ask for, and asking would
    // invent evidence for an order we are explicitly recording as unmeasured.
    const landings=await fetchLandingSites(connection,ids.filter(id=>journeys.get(id)?.evidence_status!=='unavailable'),{rest,restBatch,batch:landingBatch});
    for (const row of slice) {
      const order=journeys.get(row.order_id);
      if (!order) throw Error('Journey missing for a ledger order');
      pending += order.customerJourneySummary?.ready === false ? 1 : 0;
      const raw=order.evidence_status === 'unavailable' ? null : landings.get(row.order_id);
      const evidence={order,raw:landingEvidence(raw?.landing_site),own_hosts};
      if(decorate)evidence.allocations=decorate(evidence);
      orders.push({order_id:row.order_id,evidence});
    }
  }
  // A day's evidence goes up in one request, which stops being deliverable somewhere
  // above four thousand orders -- 2025-11-27 (8,231) died twice on that call, once as a
  // failed fetch and once as a Cloudflare 520. Past the threshold the evidence goes up in
  // slices to a staging table no reader can see, and finalize promotes it into the
  // evidence table and writes the day row in ONE transaction -- so the request is split
  // but the commit is not, and re-publishing an already-published day still changes
  // nothing until it changes everything. Below the threshold this is byte for byte the
  // single call that has published every snapshot.
  const staged = commit && stage && finalize && orders.length > threshold;
  if (staged) {
    for (let i=0;i<orders.length;i+=chunk) await stage({p_connection:connection.id,p_day:day,p_orders:orders.slice(i,i+chunk),p_extracted:extracted});
    await finalize({p_connection:connection.id,p_day:day,p_currency:shop.currencyCode,p_timezone:shop.ianaTimezone,
      p_ledger:ledger,p_net:net,p_total:total,p_extracted:extracted});
  } else if (commit) await publish({p_connection:connection.id,p_day:day,p_currency:shop.currencyCode,p_timezone:shop.ianaTimezone,
    p_ledger:ledger,p_orders:orders,p_net:net,p_total:total,p_extracted:extracted});
  return {day,orders:orders.length,pending,net_cents:net,total_cents:total,committed:commit,staged};
}
export function dayRange(start,end) {
  const valid = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && new Date(v+'T00:00:00Z').toISOString().slice(0,10) === v;
  if (!valid(start) || !valid(end) || end < start) throw Error('Explicit valid inclusive dates required');
  const days=[];
  for(let t=Date.parse(start);t<=Date.parse(end);t+=86400000) days.push(new Date(t).toISOString().slice(0,10));
  if(days.length>31)throw Error('At most 31 days per run');
  return days;
}
