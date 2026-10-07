export const MODEL_VERSION = 'silo-last-non-direct-v1.1';
const DAY = 86400000;
export const WINDOWS = [7,14,30,60];
const ignoreHosts = /(^|\.)(paypal\.com|shopify\.com|shop\.app|klarna\.com|affirm\.com|afterpay\.com|shopifypay\.com)$/;
export const cents = value => {
  const s=String(value ?? '0');
  if(!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error('Invalid monetary value: '+s);
  const [whole,frac='']=s.replace('-','').split('.');
  const n=(Number(whole)*100+Number(frac.padEnd(2,'0')))*(s.startsWith('-')?-1:1);
  if(!Number.isSafeInteger(n))throw Error('Monetary value exceeds integer range');
  return n;
};
export function tracking(raw={}) {
  const result={};
  for(const [key,value] of Object.entries(raw)) {
    try { result[key.toLowerCase()]=decodeURIComponent(String(value).replace(/\+/g,' ')).trim(); }
    catch { result[key.toLowerCase()]=String(value).trim(); }
  }
  return result;
}
function domain(value) { try { return new URL(value).hostname.toLowerCase(); } catch { return ''; } }
function path(value) { try { return new URL(value,'https://invalid.local').pathname.replace(/\/$/,'')||'/'; } catch { return ''; } }
export function classify(v, {ownHosts=[]}={}) {
  ownHosts = new Set(ownHosts.map(h=>String(h).toLowerCase()));
  const u=v.utmParameters||{},s=(u.source||'').trim().toLowerCase(),m=(u.medium||'').trim().toLowerCase();
  const source=(v.source||'').trim().toLowerCase(),type=v.sourceType||'',host=domain(v.referrerUrl)||domain(v.source);
  const result=(channel,reason)=>({channel,reason,source:u.source||v.source||'',medium:u.medium||'',campaign:u.campaign||'',ad:u.content||'',adset:u.term||''});
  if(s==='website'||m==='internal'||ownHosts.has(host)||ignoreHosts.test(host))return result(null,'Internal or checkout referral excluded');
  if(s==='redo'&&/^(email|sms)$/.test(m))return result('Redo '+(m==='email'?'Email':'SMS'),'Explicit Redo source and medium');
  if(s==='attentive'&&/sms/.test(m))return result('Attentive SMS','Explicit Attentive SMS UTM');
  if(s==='attentive'&&/email/.test(m))return result('Attentive Email','Explicit Attentive email UTM');
  if(/^(facebook|fb|instagram|ig|meta)$/.test(s)&&/paid|cpc|ppc/.test(m))return result('Meta Ads','Explicit Meta paid UTM');
  if(/^(google|googleads|google_ads|adwords)$/.test(s)&&/paid|cpc|ppc/.test(m))return result('Google Ads','Explicit Google paid UTM');
  if(s==='google'&&m==='product_sync')return result('Google Organic Shopping','Google product_sync UTM');
  if(/^(tiktok|tik_tok)$/.test(s)&&/paid|cpc|ppc/.test(m))return result('TikTok Ads','Explicit TikTok paid UTM');
  if(/^(bing|microsoft|microsoftads)$/.test(s)&&/paid|cpc|ppc/.test(m))return result('Microsoft Ads','Explicit Microsoft paid UTM');
  if(s==='shopify_email'&&m==='email')return result('Shopify Email','Explicit Shopify email UTM');
  if(/sms/.test(m))return result('SMS — Other','SMS medium; provider not mapped');
  if(/email|newsletter/.test(m))return result('Email — Other','Email medium; provider not mapped');
  if(s&&/paid|cpc|ppc/.test(m))return result('Paid — Other','Paid medium; platform not mapped');
  if(s&&/affiliate/.test(m))return result('Affiliate','Explicit affiliate medium');
  if(s&&/organic/.test(m)&&/facebook|instagram|^fb$|^ig$/.test(s))return result('Meta Organic Social','Explicit organic medium');
  if(s&&/social/.test(m)&&/facebook|instagram|^fb$|^ig$/.test(s))return result('Meta Social — Unspecified','Social medium does not establish paid versus organic');
  if(s==='website'||m==='internal'||ownHosts.has(host)||ignoreHosts.test(host))return result(null,'Internal or checkout referral excluded');
  if(s==='direct'||source==='direct')return result('Direct','Observed direct visit');
  if(source==='email'||type==='NEWSLETTER'||/mail\.google|google\.android\.gm|mail\.yahoo|outlook/.test(source+' '+host))return result('Email — Other','Email referral without provider UTM');
  if(type==='SEO')return result('Organic Search','Shopify SEO source type');
  if(/google|bing|yahoo|duckduckgo/.test(s+' '+source)||/(^|\.)(google|bing|yahoo)\./.test(host))return result('Search — Unspecified','Search referral without paid or organic source type');
  if(/facebook|instagram|m\.facebook|l\.facebook/.test(s+' '+source+' '+host))return result('Meta Social — Unspecified','Meta referral without evidence separating paid and organic');
  if(/tiktok/.test(s+' '+source+' '+host))return result('TikTok Social — Unspecified','TikTok referral without paid evidence');
  if(s&&s!=='unknown'&&s!=='(not set)')return result('Other Tagged','Identified UTM source without a mapped medium');
  if(host)return result('Referral','External referral');
  return result(null,'No usable source evidence');
}
function rawClassification(raw) {
  const t=tracking(raw?.tracking),s=(t.utm_source||t.tw_source||'').toLowerCase();
  if(t.gclid||t.gbraid||t.wbraid||s==='google'&&(t.tw_adid||t.tw_campaign))return {channel:'Google Ads',source:'google',medium:'paid',campaign:t.utm_campaign||t.gad_campaignid||t.tw_campaign||'',ad:t.tw_adid||'',adset:'',reason:'Google click/campaign identifier in order landing evidence'};
  if((t.fbadid||t.tw_adid)&&/^(facebook|fb|instagram|ig|meta)$/.test(s))return {channel:'Meta Ads',source:s,medium:'paid',campaign:t.utm_campaign||t.campaign_id||t.utm_id||'',ad:t.fbadid||t.tw_adid||t.ad_id||'',adset:t.adset_id||t.utm_term||'',reason:'Meta ad identifier and source in order landing evidence'};
  const c=classify({utmParameters:{source:t.utm_source,medium:t.utm_medium,campaign:t.utm_campaign||t.utm_id,content:t.utm_content,term:t.utm_term}});
  return c.channel&&c.channel!=='Direct'?c:null;
}
const salesChannels={web:'Online Store',pos:'Retail (POS)',tiktok:'TikTok Shop',amazon:'Amazon','amazon-us':'Amazon',faire:'Faire Wholesale','2329312':'Meta Shop','3890849':'Shop App','3426665':'AfterSell Upsell',shopify_draft_order:'Draft Orders',Canal:'Canal','Edit Order':'Order Edits'};
const commerceCategories={pos:'Retail (POS)',tiktok:'TikTok Shop',amazon:'Amazon','amazon-us':'Amazon',faire:'Faire Wholesale','2329312':'Meta Shop','3890849':'Shop App',shopify_draft_order:'Draft / Assisted Sales',Canal:'Canal'};
function allocateCredit(order,raw,catalog,{windowDays,ownHosts}) {
  const id=order.id.split('/').at(-1),j=order.customerJourneySummary;
  const base={order_id:id,order_name:order.name,created_at:order.createdAt,sales_source:order.sourceName||'',sales_channel:salesChannels[order.sourceName]||order.sourceName||'Unknown',model_version:MODEL_VERSION,weight:1,window_days:windowDays,campaign_id:'',campaign_name:'',ad_id:'',ad_name:'',campaign_match:'none',visit_id:'',visit_time:'',source:'',medium:'',campaign:'',content:'',term:'',evidence_type:'',raw_landing_truncated:!!raw?.landing_truncated};
  if(commerceCategories[order.sourceName])return {...base,channel:commerceCategories[order.sourceName],assignment:'sales_channel',reason:'Commerce channel identified by Shopify; no advertising credit inferred'};
  if(!j||!j.ready)return {...base,channel:j?'Pending':'Unattributed',assignment:j?'pending':'missing_journey',reason:j?'Shopify journey is not ready':'Shopify supplied no journey'};
  if(j.moments?.pageInfo?.hasNextPage)throw new Error('Unpaginated journey for '+id);
  const unique=new Map();for(const v of [j.firstVisit,...(j.moments?.nodes||[]),j.lastVisit])if(v?.id&&(!v.__typename||v.__typename==='CustomerVisit'))unique.set(v.id,v);
  const created=Date.parse(order.createdAt),visits=[...unique.values()].filter(v=>Date.parse(v.occurredAt)<=created&&Date.parse(v.occurredAt)>=created-windowDays*DAY).sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||a.id.localeCompare(b.id));
  const firstId=j.firstVisit?.id,rawC=rawClassification(raw);
  const candidates=visits.map(v=>{
    let c=classify(v,{ownHosts}),evidence='shopify_journey';
    const mappedAd=catalog?.ads?.get(c.ad);
    if(c.channel==='Meta Social — Unspecified'&&mappedAd&&(!/^\d+$/.test(c.campaign)||mappedAd.campaign_id===c.campaign))c={...c,channel:'Meta Ads',reason:'Meta social UTM identifies a stored ad'};
    // Only attach raw first-touch evidence to Shopify's sole captured visit.
    // A matching path across multiple visits does not establish chronology.
    if(rawC&&c.reason!=='Internal or checkout referral excluded'&&visits.length===1&&v.id===firstId&&j.lastVisit?.id===firstId&&path(v.landingPage)===path(raw.landing_path)&&(!c.channel||['Direct','Organic Search','Search — Unspecified','Meta Social — Unspecified','Other Tagged'].includes(c.channel))) {c=rawC;evidence='single_visit_plus_order_landing';}
    return {v,c,evidence};
  });
  const qualifying=candidates.filter(x=>x.c.channel&&x.c.channel!=='Direct');
  const chosen=qualifying.at(-1);
  if(!chosen){
    // Missing/unknown evidence never becomes Direct by default.
    if(visits.length&&candidates.every(x=>x.c.channel==='Direct'))return {...base,channel:'Direct',assignment:'observed_direct',reason:'All eligible observed visits are direct',visit_id:visits.at(-1).id,visit_time:visits.at(-1).occurredAt,evidence_type:'shopify_journey'};
    // A raw landing is useful fallback evidence, but not a timestamped last click.
    if(rawC&&visits.length===0&&unique.size===0)return {...base,channel:rawC.channel,assignment:'first_touch_fallback',reason:'No eligible journey visit; '+rawC.reason,source:rawC.source,medium:rawC.medium,campaign:rawC.campaign,content:rawC.ad,term:rawC.adset,evidence_type:'order_landing_first_touch'};
    return {...base,channel:'Unattributed',assignment:'insufficient_evidence',reason:order.sourceName==='3426665'?'AfterSell order origin not linked to a parent order':'No eligible identifiable non-direct visit; missing evidence retained'};
  }
  const {v,c,evidence}=chosen;
  const result={...base,channel:c.channel,assignment:'last_non_direct',reason:c.reason,visit_id:v.id,visit_time:v.occurredAt,source:c.source,medium:c.medium,campaign:c.campaign,content:c.ad,term:c.adset,evidence_type:evidence};
  if(c.channel==='Meta Ads') {
    const ad=catalog?.ads?.get(c.ad);
    const campaign=catalog?.campaigns?.get(c.campaign);
    if(ad&&(!/^\d+$/.test(c.campaign)||ad.campaign_id===c.campaign))Object.assign(result,{ad_id:ad.ad_id,ad_name:ad.ad_name,campaign_id:ad.campaign_id,campaign_name:catalog.campaigns.get(ad.campaign_id)?.name||'',campaign_match:'ad_id'});
    else if(campaign)Object.assign(result,{campaign_id:c.campaign,campaign_name:campaign.name,campaign_match:'campaign_id'});
    else {const matches=catalog?.campaignNames?.get(c.campaign)||[];if(matches.length===1)Object.assign(result,{campaign_id:matches[0].id,campaign_name:c.campaign,campaign_match:'unique_campaign_name'});}
  }
  return result;
}

export function journeyVisits(order) {
 const j=order.customerJourneySummary, seen=new Map();
 for(const v of [j?.firstVisit,...(j?.moments?.nodes||[]),j?.lastVisit])if(v?.id&&(!v.__typename||v.__typename==='CustomerVisit'))seen.set(v.id,v);
 return [...seen.values()].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||a.id.localeCompare(b.id));
}
export function allocate(order,raw,catalog,{windowDays=30,ownHosts=[]}={}) {
 if(!WINDOWS.includes(windowDays))throw Error('Unsupported attribution window');
 const result=allocateCredit(order,raw,catalog,{windowDays,ownHosts});
 if(['sales_channel','pending','missing_journey'].includes(result.assignment))return {...result,introduced_channel:null,introduced_visit_id:null,assisting_channels:[]};
 const created=Date.parse(order.createdAt);
 const eligible=journeyVisits(order).filter(v=>Date.parse(v.occurredAt)<=created&&Date.parse(v.occurredAt)>=created-windowDays*DAY);
 const touches=eligible.map(v=>{
   let c=classify(v,{ownHosts});
   if(v.id===result.visit_id&&result.evidence_type==='single_visit_plus_order_landing')c={...c,channel:result.channel};
   const ad=catalog?.ads?.get(c.ad);
   if(c.channel==='Meta Social — Unspecified'&&ad&&(!/^\d+$/.test(c.campaign)||ad.campaign_id===c.campaign))c={...c,channel:'Meta Ads'};
   return {visit_id:v.id,channel:c.channel};
 }).filter(t=>t.channel&&t.channel!=='Direct');
 if(result.channel==='Google Ads'&&catalog?.googleCampaigns?.has(result.campaign))Object.assign(result,{campaign_id:result.campaign,campaign_name:catalog.googleCampaigns.get(result.campaign),campaign_match:'campaign_id'});
 return {...result,introduced_channel:touches[0]?.channel||null,introduced_visit_id:touches[0]?.visit_id||null,
   assisting_channels:[...new Set(touches.filter(t=>t.visit_id!==result.visit_id&&t.channel!==result.channel).map(t=>t.channel))]};
}
export function allocationWindows(evidence,catalog) {
 return Object.fromEntries(WINDOWS.map(windowDays=>[windowDays,allocate(evidence.order,evidence.raw,catalog,{windowDays,ownHosts:evidence.own_hosts||[]})]));
}
