import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {allocate} from '../../v2/silo-attribution-model.js';
import {analyzeJourneys} from '../../v2/silo-attribution-overview.js';
import {channelTeamwork} from '../../v2/silo-attribution-together.js';
import {buildJourneyMapData,renderJourneyMap} from '../../v2/silo-attribution-journey-map.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const recipes=[
  {w:28,touches:[['facebook','paid',1],['redo','sms',3],['google','cpc',4]]},
  {w:12,touches:[['facebook','paid',2],['google','cpc',4]]},
  {w:6,touches:[['google','cpc',2]]},
  {w:4,touches:[['redo','sms',1],['facebook','paid',3],['google','cpc',5]]},
];
const rows=[],records=[];let n=0;
for(const recipe of recipes)for(let k=0;k<recipe.w;k++,n++){
  const visits=recipe.touches.map(([source,medium,day],i)=>({id:`${n}-${i}`,occurredAt:`2026-09-0${day}T12:00:00Z`,utmParameters:{source,medium}}));
  const order={id:'gid://shopify/Order/'+n,name:'#PREVIEW-'+n,sourceName:'web',createdAt:'2026-09-05T12:00:00Z',customerJourneySummary:{ready:true,firstVisit:visits[0],lastVisit:visits.at(-1),moments:{nodes:visits,pageInfo:{hasNextPage:false}}}};
  const allocation=allocate(order,null,null,{windowDays:30});
  const row={company_entity_id:'c',connection_id:'s',order_id:String(n),order_name:order.name,window_days:30,allocation,channel:allocation.channel,net_cents:12501,total_cents:13503,evidence_fetched_at:'t',extracted_at:'t',day:'2026-09-30'};
  rows.push(row);records.push({...row,fetched_at:'t',evidence:{order,own_hosts:[]}});
}
const report={orders:rows,net:rows.reduce((s,r)=>s+r.net_cents,0),total:rows.reduce((s,r)=>s+r.total_cents,0),currency:'USD'};
const analysis=analyzeJourneys(report,records);
const teamwork=channelTeamwork(report,analysis,null);
const map=buildJourneyMapData(report,analysis,teamwork);
const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(n/100);
const section=renderJourneyMap(map,{money,medianDays:'2.0 days',topPath:analysis.paths[0]?.path});
const html=`<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Journey map preview</title>
<link rel="stylesheet" href="../v2/beacon.css"><link rel="stylesheet" href="../v2/silo-brand.css"><link rel="stylesheet" href="../v2/silo-attribution.css"></head>
<body style="margin:0;background:var(--bcn-band);padding:24px"><main style="max-width:1200px;margin:0 auto" id="overview">${section}</main>
<script>document.querySelectorAll('use').forEach(u=>u.setAttribute('href','../../assets/landing/integration-icons.svg#'+u.getAttribute('href').split('#').pop()));</script></body></html>`;
const out=path.join(root,'scripts/dev/journey-map-preview.html');
const artifact='/opt/cursor/artifacts/journey-map-preview.html';
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.mkdirSync(path.dirname(artifact),{recursive:true});
fs.writeFileSync(out,html);
fs.writeFileSync(artifact,html);
console.log('wrote',out);
