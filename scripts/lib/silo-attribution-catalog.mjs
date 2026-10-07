export function buildCatalog(ads=[],campaigns=[]) {
  const catalog={ads:new Map(),campaigns:new Map(),campaignNames:new Map(),googleCampaigns:new Map()};
  for(const a of ads)catalog.ads.set(a.ad_id,a);
  const names=new Map();
  for(const c of campaigns){
    if(c.platform==='google_ads')catalog.googleCampaigns.set(c.campaign_id,c.campaign_name||'');
    if(c.platform!=='meta_ads')continue;
    catalog.campaigns.set(c.campaign_id,{name:c.campaign_name||''});
    if(!names.has(c.campaign_name))names.set(c.campaign_name,new Map());
    names.get(c.campaign_name).set(c.campaign_id,{id:c.campaign_id});
  }
  for(const [name,ids] of names)catalog.campaignNames.set(name,[...ids.values()]);
  return catalog;
}
export async function loadCatalog(db,companyId) {
  async function all(table,columns,sort){
    const rows=[];
    for(let offset=0;offset<100000;offset+=1000){
      const {data,error}=await db.from(table).select(columns).eq('company_entity_id',companyId).order(sort).range(offset,offset+999);
      if(error)throw Error('Attribution catalog unavailable: '+error.message);
      rows.push(...data);if(data.length<1000)return rows;
    }
    throw Error('Attribution catalog row cap exceeded');
  }
  return buildCatalog(await all('meta_ad_creatives','ad_id,ad_name,campaign_id','ad_id'),await all('silo_attribution_campaigns_v','platform,campaign_id,campaign_name','campaign_id'));
}
