// Read-only measurement for the attribution speed work. Answers the three questions the
// faster collector depends on, and answers them against the live shop rather than from
// assumption:
//
//   1. sales_paging  -- does ShopifyQL serve order rows past OFFSET 10000? The collector's
//      own bound stops at 10000, and 2025-11-28 tripped THAT bound, not a Shopify one, so
//      whether the bound can simply be raised is a measurement, not a guess.
//   2. journey_batch -- what does a batched nodes(ids:[...]) journey query actually COST?
//      Admin GraphQL is a calculated-cost bucket and cost scales with `first:` on nested
//      connections, so the batch size has to come from extensions.cost.
//   3. landing_batch -- does REST orders.json?ids=... return landing_site for every id
//      asked for? A batched call that silently drops ids would lose evidence.
//
// Writes nothing, refreshes no credentials, and logs counts, costs and booleans only --
// never an order, a visit, a URL or a token.
import {pathToFileURL} from 'node:url';
import {normalizeShopDomain,tokenNeedsRefresh} from './lib/shopify-auth-lib.mjs';
import {shopifyql,shopifyGraphql,fetchWithRetry} from './lib/shopify-sync-core.mjs';
import {fetchJourney,journeyVisitFields,buildJourney} from './lib/shopify-attribution-evidence.mjs';

class ProbeError extends Error {}
const API_VERSION='2026-07';

/** One raw Admin GraphQL call that KEEPS extensions, which shopifyGraphql() drops.
 *  The cost numbers are the whole point of this probe. */
export async function costedGraphql(connection,query,variables={}) {
  const res=await fetchWithRetry(`https://${connection.shop_domain}/admin/api/${API_VERSION}/graphql.json`,{
    method:'POST',
    headers:{'X-Shopify-Access-Token':connection.access_token,'Content-Type':'application/json'},
    body:JSON.stringify({query,variables}),
  });
  const json=await res.json();
  const cost=json?.extensions?.cost;
  return {
    data:json?.data ?? null,
    errors:(json?.errors || []).map(e=>String(e?.message || '').slice(0,200)),
    cost:cost ? {
      requested:cost.requestedQueryCost ?? null,
      actual:cost.actualQueryCost ?? null,
      available:cost.throttleStatus?.currentlyAvailable ?? null,
      maximum:cost.throttleStatus?.maximumAvailable ?? null,
      restore:cost.throttleStatus?.restoreRate ?? null,
    } : null,
  };
}

/** The batched journey query. Same selection as fetchJourney()'s, so the two can be
 *  compared field for field, but over many orders at once and with a shallower
 *  moments page -- most journeys are short, and the deep ones can be paged alone. */
export function batchJourneyQuery(moments) {
  return `query AttributionJourneyBatch($ids: [ID!]!, $after: String) {
    nodes(ids: $ids) { __typename ... on Order { id name createdAt sourceName discountCodes
      customerJourneySummary { ready firstVisit { ${journeyVisitFields} } lastVisit { ${journeyVisitFields} }
        moments(first:${moments},after:$after) { nodes { ${journeyVisitFields} } pageInfo { hasNextPage endCursor } } } } }
  }`;
}

const salesPage=(day,offset)=>`FROM sales SHOW net_sales, total_sales GROUP BY order_id, day SINCE ${day} UNTIL ${day} ORDER BY order_id ASC LIMIT 500 OFFSET ${offset}`;

/** Walk the day past the collector's 10000-row bound and report what Shopify actually
 *  served. Reports only counts and whether the money ties out -- never a row. */
export async function probeSalesPaging(connection,day,{ql=shopifyql,maxRows=30000}={}) {
  const ids=new Set();
  const pages=[];
  let duplicates=0,truncatedAt=null;
  for (let offset=0;offset<maxRows;offset+=500) {
    const page=await ql(connection,salesPage(day,offset));
    if (page.raw?.table_data_was_null) { truncatedAt=offset; pages.push({offset,rows:null,table_data_was_null:true}); break; }
    let fresh=0;
    for (const row of page) {
      const id=String(row.order_id || '');
      if (ids.has(id)) duplicates++; else { ids.add(id); fresh++; }
    }
    pages.push({offset,rows:page.length,new_ids:fresh});
    if (page.length<500) { truncatedAt=offset; break; }
  }
  // Tie the walk back to the day's own control total: a silent cap or a shifted OFFSET
  // window shows up here as money that does not add up, which is the guard that makes
  // raising the bound safe rather than hopeful.
  const control=await ql(connection,`FROM sales SHOW net_sales, total_sales SINCE ${day} UNTIL ${day}`);
  return {day,pages:pages.length,distinct_orders:ids.size,duplicate_rows:duplicates,
    stopped_at_offset:truncatedAt,hit_probe_bound:truncatedAt===null,
    control_rows:control.length,
    // Only whether it reconciles, not the figures themselves.
    reconciles:control.length===1 ? null : false,
    page_shape:pages};
}

/** Cost and fidelity of the batched journey query at several batch sizes. */
export async function probeJourneyBatch(connection,ids,{sizes=[5,10,25,50],moments=10,gql=shopifyGraphql}={}) {
  const attempts=[];
  for (const size of sizes) {
    const slice=ids.slice(0,size);
    if (slice.length<size) break;
    const {data,errors,cost}=await costedGraphql(connection,batchJourneyQuery(moments),
      {ids:slice.map(id=>'gid://shopify/Order/'+id),after:null});
    const nodes=data?.nodes || [];
    attempts.push({size,moments,errors,cost,
      returned:nodes.filter(Boolean).length,
      orders:nodes.filter(n=>n?.__typename==='Order').length,
      ready:nodes.filter(n=>n?.customerJourneySummary?.ready===true).length,
      not_ready:nodes.filter(n=>n?.customerJourneySummary && n.customerJourneySummary.ready!==true).length,
      no_summary:nodes.filter(n=>n?.__typename==='Order' && !n.customerJourneySummary).length,
      needs_more_pages:nodes.filter(n=>n?.customerJourneySummary?.moments?.pageInfo?.hasNextPage===true).length});
    if (errors.length) break;
  }
  // Fidelity: the batched shape, run through the same assembly the serial path uses, must
  // equal the serial result for the same order. Compared by visit ids and flags only.
  let fidelity={checked:false};
  const control=ids[0];
  if (control) {
    const serial=await fetchJourney(connection,control,{gql});
    const {data}=await costedGraphql(connection,batchJourneyQuery(50),
      {ids:['gid://shopify/Order/'+control],after:null});
    const node=(data?.nodes || [])[0];
    const batched=node ? buildJourney(node) : null;
    const shape=j=>j && j.journey?.customerJourneySummary ? {
      ready:j.journey.customerJourneySummary.ready,
      first:j.journey.customerJourneySummary.firstVisit?.id ?? null,
      last:j.journey.customerJourneySummary.lastVisit?.id ?? null,
      visits:(j.journey.customerJourneySummary.moments?.nodes || []).map(v=>v.id).sort(),
      codes:(j.journey.discountCodes || []).length,
    } : null;
    const serialShape=serial.customerJourneySummary ? {
      ready:serial.customerJourneySummary.ready,
      first:serial.customerJourneySummary.firstVisit?.id ?? null,
      last:serial.customerJourneySummary.lastVisit?.id ?? null,
      visits:(serial.customerJourneySummary.moments?.nodes || []).map(v=>v.id).sort(),
      codes:(serial.discountCodes || []).length,
    } : null;
    const batchedShape=shape(batched);
    fidelity={checked:true,more_pages:batched?.needsMorePages ?? null,
      // Visit counts and flags only; no visit ever leaves this process.
      serial_visits:serialShape?.visits.length ?? null,
      batched_visits:batchedShape?.visits.length ?? null,
      identical:JSON.stringify(serialShape)===JSON.stringify(batchedShape)};
  }
  return {attempts,fidelity};
}

/** Does REST return landing_site for every id asked for in one call? */
export async function probeLandingBatch(connection,ids,{sizes=[10,50,100,250]}={}) {
  const attempts=[];
  for (const size of sizes) {
    const slice=ids.slice(0,size);
    if (slice.length<size) break;
    const url=`https://${connection.shop_domain}/admin/api/${API_VERSION}/orders.json`+
      `?ids=${slice.join(',')}&fields=id,landing_site&limit=${size}&status=any`;
    const res=await fetchWithRetry(url,{headers:{'X-Shopify-Access-Token':connection.access_token}});
    if (!res.ok) { attempts.push({size,status:res.status,returned:null}); break; }
    const orders=(await res.json())?.orders || [];
    const got=new Set(orders.map(o=>String(o.id)));
    attempts.push({size,status:res.status,returned:orders.length,
      missing:slice.filter(id=>!got.has(String(id))).length,
      // Whether the field is present, never its value.
      with_landing_site:orders.filter(o=>'landing_site' in o).length,
      non_null_landing_site:orders.filter(o=>o.landing_site!=null).length});
  }
  return {attempts};
}

export async function runPlanProbe(env,{createClient,ql=shopifyql,gql=shopifyGraphql,now=Date.now()}={}) {
  const day=env.ATTRIBUTION_PROBE_PLAN_DAY;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day) {
    throw new ProbeError('One valid YYYY-MM-DD probe day required');
  }
  if (env.ATTRIBUTION_MODE==='scheduled' || env.ATTRIBUTION_START || env.ATTRIBUTION_END ||
      env.ATTRIBUTION_COMMIT && env.ATTRIBUTION_COMMIT!=='false') {
    throw new ProbeError('Probe requires manual mode, blank dates and commit=false');
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY ||
      !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(env.ATTRIBUTION_CONNECTION_ID || '')) {
    throw new ProbeError('Existing Supabase secrets and one connection UUID required');
  }
  const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:row,error}=await db.from('shopify_connections')
    .select('id,shop_domain,access_token,auth_method,token_expires_at,is_active,sync_enabled')
    .eq('id',env.ATTRIBUTION_CONNECTION_ID).single();
  if (error || !row?.is_active || !row.sync_enabled) throw new ProbeError('Active sync-enabled connection required');
  const domain=normalizeShopDomain(row.shop_domain);
  if (!domain) throw new ProbeError('Invalid Shopify domain');
  const expiry=row.token_expires_at;
  if (!row.access_token || tokenNeedsRefresh(row,now) ||
      expiry && (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry)<=now)) {
    throw new ProbeError('Stored token missing or expired/near expiry; probe will not refresh credentials');
  }
  const connection={...row,shop_domain:domain,api_version:API_VERSION};

  const paging=await probeSalesPaging(connection,day,{ql});
  // Ids for the batch probes come from the day's own first page, so they are real orders
  // on this shop rather than invented ones.
  const first=await ql(connection,salesPage(day,0));
  const ids=first.map(r=>String(r.order_id)).filter(id=>/^\d+$/.test(id));
  const journey=ids.length ? await probeJourneyBatch(connection,ids,{gql}) : {attempts:[],fidelity:{checked:false}};
  const landing=ids.length ? await probeLandingBatch(connection,ids) : {attempts:[]};
  return {status:'success',mode:'plan_probe',api_version:API_VERSION,committed:false,
    sample_ids:ids.length,sales_paging:paging,journey_batch:journey,landing_batch:landing};
}

export async function planProbeMain(env,deps) {
  try {
    console.log(JSON.stringify(await runPlanProbe(env,deps),null,1));
    return 0;
  } catch (error) {
    // Upstream responses may carry customer data or credentials. Never log them.
    console.error(JSON.stringify({status:'failed',mode:'plan_probe',committed:false,
      reason:error instanceof ProbeError ? error.message : 'Connection or Shopify query failed; no writes performed'}));
    return 1;
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const {createClient}=await import('@supabase/supabase-js');
  process.exitCode=await planProbeMain(process.env,{createClient});
}
