// Marketing spend beside attributed revenue. Read-only; every table read is
// active-company RLS. Unknown spend is never shown as $0: a day counts as zero
// only inside a window a sync actually completed (the Redo and ad-platform
// contract), so coverage comes from successful sync_jobs windows, not from
// whether a later row exists.
// Each source says where its rows come from (`rows`, the key loadSpend
// returns them under), which column carries the money, which column carries
// the CURRENCY -- and `assumed` when there is no such column and a currency is
// being taken on faith. That last one is the honest bit: a source with no
// currency column cannot prove its figures are dollars.
export const SPEND_SOURCES=[
  {channel:'Meta Ads',table:'marketing_kpis_daily',rows:'kpi',connections:'ads',column:'platform',key:'meta_ads',job:'meta_ads_kpis',kind:'Ad spend',spendColumn:'spend',currencyColumn:null},
  {channel:'Google Ads',table:'marketing_kpis_daily',rows:'kpi',connections:'ads',column:'platform',key:'google_ads',job:'google_ads_kpis',kind:'Ad spend',spendColumn:'spend',currencyColumn:null},
  {channel:'TikTok Ads',table:'marketing_kpis_daily',rows:'kpi',connections:'ads',column:'platform',key:'tiktok_ads',job:'tiktok_ads_kpis',kind:'Ad spend',spendColumn:'spend',currencyColumn:null},
  {channel:'Redo Email',table:'redo_marketing_daily',rows:'redo',connections:'redo',column:'channel',key:'EMAIL',job:'redo_marketing',kind:'Sending cost',spendColumn:'spend',currencyColumn:'spend_currency'},
  {channel:'Redo SMS',table:'redo_marketing_daily',rows:'redo',connections:'redo',column:'channel',key:'SMS',job:'redo_marketing',kind:'Sending cost',spendColumn:'spend',currencyColumn:'spend_currency'},
  // Klaviyo's SMS sending cost for FLOWS, by day. Klaviyo charges for email by
  // plan rather than per send, so a Klaviyo Email row would never exist.
  // Currency: Klaviyo's Reporting API defines text_message_spend as "The total
  // text message spend in USD" -- whatever the account's preferred currency.
  // So it is USD by the vendor's own definition, not by assumption, and it is
  // never re-labelled with klaviyo_connections.account_currency: an account
  // that prefers CAD is still billed SMS in USD here. Campaign SMS cost lives in
  // klaviyo_message_performance and is a total over a measurement window, not
  // a daily figure, so it cannot be added to a date-range total. It is read
  // anyway, through `uncosted`, so that its existence stops this source from
  // certifying itself complete: a company sending paid SMS campaigns and no
  // flows would otherwise read as a COMPLETE $0, which overstates return.
  {channel:'Klaviyo SMS (flows)',table:'klaviyo_flow_daily',rows:'klaviyo',connections:'klaviyo',column:'channel',key:'sms',job:'klaviyo',kind:'Sending cost',spendColumn:'text_message_spend',currencyColumn:null,
   uncosted:{rows:'klaviyoCampaign',why:'campaign sending cost is reported per measurement window, not per day'}},
];
const PAGE=1000,LIMIT=50000,uuid=/^[0-9a-f-]{36}$/i,isoDay=/^\d{4}-\d{2}-\d{2}$/;

// Pages against an exact count, so a server row cap below PAGE cannot end the
// read early and undercount spend.
async function pages(query){
  const rows=[];let count=null;
  while(rows.length<LIMIT){
    const {data,error,count:total}=await query().range(rows.length,rows.length+PAGE-1);
    if(error)throw error;if(!Array.isArray(data)||!Number.isSafeInteger(total))throw Error('Unexpected spend response');
    if(count===null)count=total;else if(total!==count)throw Error('Spend changed while loading; reload');
    rows.push(...data);
    if(rows.length>=count)return rows.length===count?rows:Promise.reject(Error('Spend changed while loading; reload'));
    if(!data.length)throw Error('Spend read ended early; reload');
  }
  throw Error('Spend row limit reached; choose a smaller period');
}

export async function loadSpend(db,companyId,start,end){
  if(!uuid.test(companyId)||![start,end].every(v=>isoDay.test(v))||start>end)throw Error('Invalid spend filters');
  const of=table=>SPEND_SOURCES.filter(s=>s.table===table).map(s=>s.key),jobs=[...new Set(SPEND_SOURCES.map(s=>s.job))];
  // The connection tables are admin-only under RLS, and RLS hides rows rather
  // than erroring, so an empty list proves nothing for a non-admin. Only a
  // confirmed admin's list counts; otherwise the count is unknown (null).
  const {data:isAdmin,error:adminError}=await db.rpc('is_admin_user');
  const readable=async q=>{if(adminError||isAdmin!==true)return null;const {data,error}=await q;return error||!Array.isArray(data)?null:data;};
  const [kpi,redo,klaviyo,klaviyoCampaign,windows,attempted,adConnections,redoConnections,klaviyoConnections]=await Promise.all([
    pages(()=>db.from('marketing_kpis_daily').select('platform,day_date,spend,connection_id',{count:'exact'}).eq('company_entity_id',companyId).in('platform',of('marketing_kpis_daily')).gte('day_date',start).lte('day_date',end).order('id')),
    pages(()=>db.from('redo_marketing_daily').select('channel,day_date,spend,spend_currency,connection_id',{count:'exact'}).eq('company_entity_id',companyId).in('channel',of('redo_marketing_daily')).gte('day_date',start).lte('day_date',end).order('id')),
    pages(()=>db.from('klaviyo_flow_daily').select('channel,day_date,text_message_spend,connection_id',{count:'exact'}).eq('company_entity_id',companyId).in('channel',of('klaviyo_flow_daily')).gte('day_date',start).lte('day_date',end).order('id')),
    // Campaign SMS cost, for the completeness check only: any window that
    // overlaps the period. Never summed -- a window total is not a day's cost.
    pages(()=>db.from('klaviyo_message_performance').select('kind,channel,timeframe_start,timeframe_end,text_message_spend,connection_id',{count:'exact'}).eq('company_entity_id',companyId).eq('kind','campaign').eq('channel','sms').lte('timeframe_start',end+'T23:59:59Z').gte('timeframe_end',start+'T00:00:00Z').order('id')),
    pages(()=>db.from('sync_jobs').select('job_type,window:result->window',{count:'exact'}).eq('company_entity_id',companyId).eq('status','success').in('job_type',jobs).lte('result->window->>startDate',end).gte('result->window->>endDate',start).order('id')),
    // Any run at all (even failed) means the source is connected, so no rows is not "untracked".
    Promise.all(jobs.map(async job=>{const {data,error}=await db.from('sync_jobs').select('id').eq('company_entity_id',companyId).eq('job_type',job).limit(1);if(error)throw error;return [job,!!data?.length];})),
    readable(db.from('ad_platform_connections').select('id,platform').eq('company_entity_id',companyId).eq('is_active',true).in('platform',of('marketing_kpis_daily'))),
    readable(db.from('redo_connections').select('id').eq('company_entity_id',companyId)),
    readable(db.from('klaviyo_connections').select('id').eq('company_entity_id',companyId).eq('is_active',true)),
  ]);
  return {kpi,redo,klaviyo,klaviyoCampaign,windows,attempted:Object.fromEntries(attempted),connections:{ads:adConnections,redo:redoConnections,klaviyo:klaviyoConnections}};
}

const addDay=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
// status: complete | partial (some days outside every completed sync window) |
// unknown (connected, no completed window covers the period) | unverified (more
// than one connection, or the connection list is not visible to this viewer:
// windows are company-level, not per connection) | none (not tracked) |
// currency (cannot confirm the currency).
export function summarizeSpend({kpi=[],redo=[],klaviyo=[],klaviyoCampaign=[],windows=[],attempted={},connections={ads:null,redo:null,klaviyo:null}},{start,end,currency}){
  const out=new Map(),days=[],rowsByKey={kpi,redo,klaviyo,klaviyoCampaign};
  for(let d=start;d<=end;d=addDay(d,1))days.push(d);
  for(const s of SPEND_SOURCES){
    const rows=(rowsByKey[s.rows]||[]).filter(r=>r[s.column]===s.key);
    const spans=windows.filter(w=>w.job_type===s.job&&isoDay.test(w.window?.startDate)&&isoDay.test(w.window?.endDate)).map(w=>w.window);
    const covered=days.filter(d=>spans.some(w=>w.startDate<=d&&d<=w.endDate)).length;
    const list=connections?.[s.connections],listKnown=Array.isArray(list);
    // Only the ad list is per platform; the vendor lists are one row per
    // connection, so there is nothing to narrow them by.
    const readable=listKnown&&s.connections==='ads'?list.filter(c=>c.platform===s.key):list;
    const connectionCount=Math.max(readable?.length||0,new Set(rows.map(r=>r.connection_id).filter(Boolean)).size);
    // Real cost this source cannot sum: rows that report a figure above zero,
    // or report none at all. A row of exactly 0 costs nothing and hides nothing.
    const uncostedRows=s.uncosted?(rowsByKey[s.uncosted.rows]||[]).filter(r=>r[s.spendColumn]==null||Number(r[s.spendColumn])>0).length:0;
    const tracked=connectionCount>0||attempted[s.job]||spans.length>0||rows.length>0||uncostedRows>0;
    // A source with no currency column cannot prove its figures are dollars:
    // it is usable only while the page is asking for the currency it assumes.
    // For such a source this filter is belt-and-braces -- the status below
    // already refuses any other currency -- and a mutation removing it stays
    // green for exactly that reason. It is kept so the money does not depend
    // on one branch staying correct.
    const usable=s.currencyColumn?rows.filter(r=>r[s.currencyColumn]===currency):(currency===(s.assumed||'USD')?rows:[]);
    let total=0,unreported=0;
    // null is "not reported", which is NOT zero: this vendor leaves SMS cost
    // null on a contracted plan and before its supported date. Number(null) is
    // 0 and finite, so a null has to be taken out before the arithmetic or an
    // unknown cost silently becomes a free send.
    for(const r of usable){
      const v=r[s.spendColumn];
      if(r.day_date<start||r.day_date>end)throw Error('Spend outside the selected period');
      if(v==null){unreported+=1;continue;}
      const n=Number(v);if(!Number.isFinite(n))throw Error('Invalid spend value');
      total+=n;
    }
    const base=!tracked?'none':!s.currencyColumn&&currency!==(s.assumed||'USD')?'currency':connectionCount>1||!listKnown?'unverified':covered===days.length?'complete':covered===0&&!rows.length&&!uncostedRows?'unknown':'partial';
    // Synced days prove the rows arrived, not that they carry a cost. A source
    // whose period is covered but whose cost is part-missing is not complete.
    const status=base==='complete'&&(unreported||uncostedRows)?'incomplete':base;
    out.set(s.channel,{...s,status,days:days.length,covered,connections:connectionCount,listKnown,unreported,uncostedRows,cents:['none','currency','unknown'].includes(status)?null:Math.round(total*100),excluded:rows.length-usable.length});
  }
  return out;
}

export const knownSpend=spend=>[...(spend?.values()||[])].filter(s=>s.cents!=null);
// A total is a real denominator only when every tracked source covers the whole period.
export function spendTotal(spend){
  const tracked=[...(spend?.values()||[])].filter(s=>s.status!=='none'),known=knownSpend(spend);
  return {cents:known.reduce((t,s)=>t+s.cents,0),complete:tracked.length>0&&tracked.every(s=>s.status==='complete'),anyKnown:known.length>0,gaps:tracked.filter(s=>s.status!=='complete')};
}
export function spendNote(s){
  if(s.status==='none')return 'Not connected';
  if(s.status==='unknown')return "Connected, but this period hasn't synced";
  if(s.status==='currency')return "Can't confirm the currency for this store";
  if(s.status==='unverified')return s.listKnown?`${s.connections} connected accounts; can't confirm each one synced`:'Only admins can confirm this spend is complete, so return is hidden';
  const gaps=[
    s.uncostedRows?`${s.uncostedRows} campaign cost rows not included (${s.uncosted.why})`:'',
    s.unreported?`${s.unreported} rows report no cost`:'',
  ].filter(Boolean);
  if(s.status==='incomplete')return `Part of this cost is not counted: ${gaps.join('; ')}`+(s.assumed?` · assumed ${s.assumed}`:'');
  if(s.status==='partial')return `Synced ${s.covered} of ${s.days} days; the rest is missing`+(gaps.length?` · ${gaps.join('; ')}`:'')+(s.assumed?` · assumed ${s.assumed}`:'');
  if(s.excluded)return `${s.excluded} rows in another currency left out`;
  // An assumed currency is never silent: the vendor does not report one.
  return s.assumed?`Assumed ${s.assumed} — this vendor does not report a currency`:'';
}
