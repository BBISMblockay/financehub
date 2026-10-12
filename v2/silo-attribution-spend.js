// Marketing spend beside attributed revenue. Read-only; both tables are
// active-company RLS. Unknown spend is never shown as $0: a source that never
// synced, or synced only part of the period, says so.
export const SPEND_SOURCES=[
  {channel:'Meta Ads',table:'marketing_kpis_daily',column:'platform',key:'meta_ads',kind:'Ad spend'},
  {channel:'Google Ads',table:'marketing_kpis_daily',column:'platform',key:'google_ads',kind:'Ad spend'},
  {channel:'TikTok Ads',table:'marketing_kpis_daily',column:'platform',key:'tiktok_ads',kind:'Ad spend'},
  {channel:'Redo Email',table:'redo_marketing_daily',column:'channel',key:'EMAIL',kind:'Sending cost'},
  {channel:'Redo SMS',table:'redo_marketing_daily',column:'channel',key:'SMS',kind:'Sending cost'},
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
  const of=table=>SPEND_SOURCES.filter(s=>s.table===table).map(s=>s.key);
  const [kpi,redo,latest]=await Promise.all([
    pages(()=>db.from('marketing_kpis_daily').select('platform,day_date,spend',{count:'exact'}).eq('company_entity_id',companyId).in('platform',of('marketing_kpis_daily')).gte('day_date',start).lte('day_date',end).order('id')),
    pages(()=>db.from('redo_marketing_daily').select('channel,day_date,spend,spend_currency',{count:'exact'}).eq('company_entity_id',companyId).in('channel',of('redo_marketing_daily')).gte('day_date',start).lte('day_date',end).order('id')),
    // How far each source has synced decides whether "no rows" means $0 or unknown.
    Promise.all(SPEND_SOURCES.map(async s=>{
      const {data,error}=await db.from(s.table).select('day_date').eq('company_entity_id',companyId).eq(s.column,s.key).order('day_date',{ascending:false}).limit(1);
      if(error)throw error;return [s.channel,data?.[0]?.day_date||null];
    })),
  ]);
  return {kpi,redo,latest:Object.fromEntries(latest)};
}

// status: complete | partial (synced through a day before `end`) |
// not_connected (never synced) | currency (cannot confirm the currency).
export function summarizeSpend({kpi=[],redo=[],latest={}},{start,end,currency}){
  const out=new Map();
  for(const s of SPEND_SOURCES){
    const rows=s.table==='marketing_kpis_daily'?kpi.filter(r=>r.platform===s.key):redo.filter(r=>r.channel===s.key);
    const through=latest[s.channel]||null;
    // marketing_kpis_daily stores no currency; the ad accounts report USD.
    const usable=s.table==='marketing_kpis_daily'?(currency==='USD'?rows:[]):rows.filter(r=>r.spend_currency===currency);
    let total=0;
    for(const r of usable){const n=Number(r.spend);if(!Number.isFinite(n))throw Error('Invalid spend value');if(r.day_date<start||r.day_date>end)throw Error('Spend outside the selected period');total+=n;}
    const status=s.table==='marketing_kpis_daily'&&currency!=='USD'?'currency':!through?'not_connected':through<end?'partial':'complete';
    out.set(s.channel,{...s,status,through,cents:status==='currency'||status==='not_connected'?null:Math.round(total*100),excluded:rows.length-usable.length});
  }
  return out;
}

export const knownSpend=spend=>[...(spend?.values()||[])].filter(s=>s.cents!=null);
export function spendNote(s){
  if(s.status==='not_connected')return 'No spend has synced for this source';
  if(s.status==='currency')return 'Spend currency cannot be confirmed for this store';
  if(s.status==='partial')return `Synced only through ${s.through}; spend after that is missing`;
  return s.excluded?`${s.excluded} rows in another currency excluded`:'';
}
