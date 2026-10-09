// Read-only sensitivity analysis. Published ledger allocations remain authoritative.
import {classify, journeyVisits, WINDOWS} from './silo-attribution-model.js';
const DAY=86400000;
export const median=values=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b),n=a.length;return n?(a[Math.floor((n-1)/2)]+a[Math.floor(n/2)])/2:null;};
const safe=n=>{if(!Number.isSafeInteger(n))throw Error('Unsafe revenue cents');return n;};

export function observedJourney(row,record) {
  const unavailable=reason=>({orderId:row.order_id,reason,touches:[],eligible:false});
  if(!record)return unavailable('Missing evidence');
  if(record.company_entity_id!==row.company_entity_id||record.connection_id!==row.connection_id||record.order_id!==row.order_id)throw Error('Journey identity mismatch');
  if(record.fetched_at!==row.evidence_fetched_at)throw Error('Journey refreshed since report loaded; reload the report');
  const order=record.evidence?.order,j=order?.customerJourneySummary,a=row.allocation;
  if(order?.id?.split('/').at(-1)!==row.order_id)return unavailable('Order identity unavailable');
  if(!WINDOWS.includes(row.window_days))throw Error('Unsupported journey window');
  if(!a)return unavailable('Model not backfilled');
  if(a.assignment==='sales_channel')return unavailable('Commerce channel');
  if(!j)return unavailable('Missing journey');
  if(!j.ready)return unavailable('Pending journey');
  if(!j.moments?.pageInfo||j.moments.pageInfo.hasNextPage)return unavailable('Incomplete pagination');
  const created=Date.parse(order.createdAt),visits=journeyVisits(order);
  if(!Number.isFinite(created)||visits.some(v=>!Number.isFinite(Date.parse(v.occurredAt))||Date.parse(v.occurredAt)>created))return unavailable('Invalid chronology');
  let unknown=0,direct=0,internal=0;
  const touches=visits.filter(v=>Date.parse(v.occurredAt)>=created-row.window_days*DAY).flatMap(v=>{
    const c=classify(v,{ownHosts:record.evidence.own_hosts||[]});
    // Use only classifications recorded by the published allocation. Do not join
    // a current campaign catalog to historical evidence or guess missing labels.
    const channel=v.id===a.visit_id?a.channel:v.id===a.introduced_visit_id?a.introduced_channel:c.channel;
    if(channel==='Direct'){direct++;return [];}
    if(!channel){if(c.reason==='Internal or checkout referral excluded')internal++;else unknown++;return [];}
    return [{id:v.id,channel,time:Date.parse(v.occurredAt)}];
  });
  if(!touches.length)return unavailable(direct&&!unknown?'Direct only':'No eligible non-direct touches');
  if(unknown)return unavailable('Unknown source in journey');
  if(a.assignment!=='last_non_direct'||touches.at(-1).id!==a.visit_id||touches.at(-1).channel!==row.channel)return unavailable('Baseline cannot be reproduced');
  const observedAssists=[...new Set(touches.filter(t=>t.id!==a.visit_id&&t.channel!==row.channel).map(t=>t.channel))].sort();
  if(touches[0].channel!==a.introduced_channel||JSON.stringify(observedAssists)!==JSON.stringify([...(a.assisting_channels||[])].sort()))return unavailable('Historical channel mapping unavailable');
  return {orderId:row.order_id,eligible:true,touches,created,direct,internal,reason:null};
}

// Largest remainder, at channel level. Negative amounts mirror positive amounts,
// including residual cents. Deterministic lexical ties; no lost reversal cents.
export function splitCents(amount,weights) {
  safe(amount);
  const entries=[...weights].filter(([,w])=>w>0).sort(([a],[b])=>a.localeCompare(b));
  if(!entries.length||entries.some(([,w])=>!Number.isFinite(w)))throw Error('Invalid model weights');
  const total=entries.reduce((s,[,w])=>s+w,0),magnitude=Math.abs(amount);
  const shares=entries.map(([channel,w])=>{const raw=magnitude*(w/total);return {channel,value:Math.floor(raw),remainder:raw-Math.floor(raw)};});
  let rest=magnitude-shares.reduce((s,x)=>s+x.value,0);
  if(rest<0||rest>shares.length)throw Error('Model rounding exceeds precision');
  const priority=[...shares].sort((a,b)=>b.remainder-a.remainder||a.channel.localeCompare(b.channel));
  for(let i=0;i<rest;i++)priority[i].value++;
  return new Map(shares.map(x=>[x.channel,(amount<0?-1:1)*x.value]));
}

export function touchWeights(journey,model,{halfLifeDays=7,roles=[40,20,40]}={}) {
  if(!Number.isFinite(halfLifeDays)||halfLifeDays<1||halfLifeDays>60)throw Error('Half-life must be 1–60 days');
  if(roles.length!==3||roles.some(n=>!Number.isFinite(n)||n<0)||roles.reduce((a,b)=>a+b,0)<=0)throw Error('Role weights must be nonnegative with a positive sum');
  const t=journey.touches,n=t.length,weights=new Map();
  const add=(channel,w)=>weights.set(channel,(weights.get(channel)||0)+w);
  if(model==='equal')for(const channel of new Set(t.map(x=>x.channel)))add(channel,1);
  else if(model==='decay') {
    // One weight per channel: latest eligible touch prevents repeat-volume bias.
    for(const x of t)weights.set(x.channel,Math.pow(2,-(journey.created-x.time)/DAY/halfLifeDays));
  } else if(model==='roles') {
    if(n===1)add(t[0].channel,1);
    else {
      const assists=[...new Set(t.slice(1,-1).map(x=>x.channel))];
      add(t[0].channel,roles[0]);add(t.at(-1).channel,roles[2]);
      if(assists.length)for(const channel of assists)add(channel,roles[1]/assists.length);
      // No eligible assist => normalize intro/close. Assist-only settings have
      // no available role on a two-touch path, so use equal-share explicitly.
      if(![...weights.values()].some(w=>w>0))for(const channel of new Set(t.map(x=>x.channel)))add(channel,1);
    }
  } else throw Error('Unknown comparison model');
  return weights;
}

export function analyzeJourneys(report,records,settings={}) {
  touchWeights({touches:[{channel:'validation'}]},'roles',settings);
  const byId=new Map();for(const r of records){if(byId.has(r.order_id))throw Error('Duplicate journey evidence');byId.set(r.order_id,r);}
  const groups=new Map(),exclusions=new Map(),roles=new Map(),journeys=new Map();
  const models=Object.fromEntries(['baseline','equal','decay','roles'].map(k=>[k,new Map()]));
  const add=(model,channel,net,total)=>{const c=models[model].get(channel)||{channel,net_cents:0,total_cents:0};c.net_cents=safe(c.net_cents+net);c.total_cents=safe(c.total_cents+total);models[model].set(channel,c);};
  const seen=new Set();let eligible=0;
  for(const row of report.orders) {
    if(seen.has(row.order_id))throw Error('Expected unique orders, not day rows');seen.add(row.order_id);
    const j=observedJourney(row,byId.get(row.order_id));journeys.set(row.order_id,j);
    add('baseline',row.channel,row.net_cents,row.total_cents);
    if(!j.eligible)exclusions.set(j.reason,(exclusions.get(j.reason)||0)+1);
    else {
      eligible++;
      // Consecutive repeats collapse into a channel run; a later return remains
      // a separate step. Timing uses each run's first observed touch.
      const runs=[];for(const t of j.touches){if(runs.at(-1)?.channel!==t.channel)runs.push(t);}
      const path=runs.map(t=>t.channel),key=JSON.stringify(path);
      const g=groups.get(key)||{key,path,orderIds:[],durations:[],intervals:Array.from({length:runs.length},()=>[])};
      g.orderIds.push(row.order_id);g.durations.push(j.created-runs[0].time);
      runs.forEach((t,i)=>g.intervals[i].push((runs[i+1]?.time??j.created)-t.time));groups.set(key,g);
      const intro=j.touches[0].channel,close=j.touches.at(-1).channel;
      const assists=new Set(j.touches.filter(t=>t.id!==row.allocation.visit_id&&t.channel!==close).map(t=>t.channel));
      for(const channel of new Set([intro,close,...assists])){
        const r=roles.get(channel)||{channel,introductions:0,assists:0,closes:0};
        r.introductions+=Number(channel===intro);r.assists+=Number(assists.has(channel));r.closes+=Number(channel===close);roles.set(channel,r);
      }
    }
    for(const model of ['equal','decay','roles']) {
      if(!j.eligible){add(model,row.channel,row.net_cents,row.total_cents);continue;}
      const weights=touchWeights(j,model,settings),net=splitCents(row.net_cents,weights),total=splitCents(row.total_cents,weights);
      for(const channel of weights.keys())add(model,channel,net.get(channel)||0,total.get(channel)||0);
    }
  }
  for(const model of Object.values(models))if([...model.values()].reduce((s,c)=>s+c.net_cents,0)!==report.net||[...model.values()].reduce((s,c)=>s+c.total_cents,0)!==report.total)throw Error('Comparison reconciliation failed');
  const paths=[...groups.values()].map(g=>({...g,count:g.orderIds.length,medianMs:median(g.durations),steps:g.intervals.map(x=>({medianMs:median(x),count:x.length}))})).sort((a,b)=>b.count-a.count||a.key.localeCompare(b.key));
  return {paths,roles:[...roles.values()],eligible,total:seen.size,exclusions:[...exclusions].map(([reason,count])=>({reason,count})),journeys,models};
}

export async function loadJourneyRecords(db,companyId,connectionId,orders) {
  const records=[];
  for(let i=0;i<orders.length;i+=200){
    const ids=orders.slice(i,i+200).map(o=>o.order_id);
    const {data,error}=await db.from('shopify_attribution_orders').select('company_entity_id,connection_id,order_id,evidence,fetched_at').eq('company_entity_id',companyId).eq('connection_id',connectionId).in('order_id',ids);
    if(error)throw error;if(!Array.isArray(data))throw Error('Unexpected journey response');
    if(data.some(r=>!ids.includes(r.order_id)||r.company_entity_id!==companyId||r.connection_id!==connectionId))throw Error('Journey scope mismatch');
    records.push(...data);
  }
  return records;
}
