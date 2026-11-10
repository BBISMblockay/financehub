// Company-wide journey map: presentation only; reads reconciled report + journey analysis.
import {GAPS} from './silo-attribution-together.js';
import {platformMark} from './silo-attribution-visuals.js';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function buildJourneyMapData(report,analysis,rows){
  const nodes=rows.filter(r=>!GAPS.includes(r.channel)).map(r=>({channel:r.channel,started:r.started,assisted:r.assisted,closed:r.closed,touched:r.touched,net_cents:r.net_cents,shared_cents:r.shared_cents}));
  const flows=new Map();
  const addFlow=(from,to,net)=>{
    if(GAPS.includes(from)||GAPS.includes(to))return;
    const key=`${from}\0${to}`,f=flows.get(key)||{from,to,count:0,net_cents:0};
    f.count++;f.net_cents+=net;flows.set(key,f);
  };
  for(const o of report.orders){
    const a=o.allocation||{},intro=a.introduced_channel,close=o.channel;
    if(GAPS.includes(close)&&(!intro||GAPS.includes(intro)))continue;
    const from=intro&&!GAPS.includes(intro)?intro:close;
    addFlow(from,close,o.net_cents);
  }
  const segments=new Map();
  const middle=new Map();
  if(analysis){
    for(const p of analysis.paths){
      for(let i=0;i<p.path.length-1;i++){
        const from=p.path[i],to=p.path[i+1],key=`${from}\0${to}`,s=segments.get(key)||{from,to,count:0};
        s.count+=p.count;segments.set(key,s);
      }
      for(let i=1;i<p.path.length-1;i++){
        const c=p.path[i],m=middle.get(c)||{channel:c,count:0};
        m.count+=p.count;middle.set(c,m);
      }
    }
  }
  const maxFlow=Math.max(1,...[...flows.values()].map(f=>f.count));
  const topFlow=flows.size?[...flows.values()].sort((a,b)=>b.count-a.count)[0]:null;
  return {
    nodes,
    flows:[...flows.values()].sort((a,b)=>b.count-a.count||a.from.localeCompare(b.from)),
    segments:[...segments.values()].sort((a,b)=>b.count-a.count),
    middle:[...middle.values()].sort((a,b)=>b.count-a.count),
    maxFlow,
    topFlow,
    multiShare:report.orders.length?Math.round(report.orders.filter(o=>{const a=o.allocation||{},set=new Set([o.channel,a.introduced_channel,...(a.assisting_channels||[])].filter(c=>c&&!GAPS.includes(c)));return set.size>1;}).length/report.orders.length*100):0,
  };
}

function stackY(entries,height,gap=12){
  const total=entries.reduce((s,e)=>s+e.weight,0)||1;
  const usable=height-gap*Math.max(0,entries.length-1);
  let y=gap;
  return entries.map(e=>{const h=Math.max(34,usable*e.weight/total);const center=y+h/2;y+=h+gap;return {...e,y:center,h,w:h};});
}

function ribbon(x1,y1,x2,y2,half){
  const sx=x1+30,ex=x2-30,cx=(ex-sx)*.48;
  return `M${sx} ${y1-half}C${sx+cx} ${y1-half},${ex-cx} ${y2-half},${ex} ${y2-half}L${ex} ${y2+half}C${ex-cx} ${y2+half},${sx+cx} ${y1+half},${sx} ${y1+half}Z`;
}

function spine(x1,y1,x2,y2){
  const sx=x1+30,ex=x2-30,cx=(ex-sx)*.48;
  return `M${sx} ${y1}C${sx+cx} ${y1},${ex-cx} ${y2},${ex} ${y2}`;
}

export function renderJourneyMap(data,{money,medianDays=null,topPath=null}){
  if(!data.nodes.length)return '';
  const width=980,height=360,xStart=148,xMid=490,xEnd=652,xBuy=868,plotH=248,y0=68;
  const left=stackY(data.nodes.filter(n=>n.started>0).map(n=>({...n,weight:n.started,side:'start'})),plotH);
  const right=stackY(data.nodes.filter(n=>n.closed>0).map(n=>({...n,weight:n.closed,side:'end'})),plotH);
  const mid=stackY(data.middle.map(m=>{const row=data.nodes.find(n=>n.channel===m.channel);return {channel:m.channel,weight:m.count,assisted:row?.assisted||m.count,side:'mid'};}),plotH);
  const pos=new Map([...left,...right,...mid].map(n=>[n.side+'\0'+n.channel,n]));
  const topKey=data.topFlow?`${data.topFlow.from}\0${data.topFlow.to}`:'';
  const ribbonHalf=f=>3+(f.count/data.maxFlow)*22;
  const ribbons=data.flows.map((f,i)=>{
    const a=pos.get('start\0'+f.from),b=pos.get('end\0'+f.to);
    if(!a||!b)return '';
    const half=ribbonHalf(f),hero=`${f.from}\0${f.to}`===topKey;
    const title=`${f.count} order${f.count===1?'':'s'} · ${money(f.net_cents)}`;
    return `<path class="attr-map-ribbon${hero?' attr-map-ribbon--hero':''}" data-map-from="${esc(f.from)}" data-map-to="${esc(f.to)}" d="${ribbon(xStart,a.y,xEnd,b.y,half)}" fill="${hero?'url(#attrMapRibbonHi)':'url(#attrMapRibbon)'}" opacity="${hero?0.92:0.5}"><title>${esc(title)}</title></path>
    <path class="attr-map-spine" d="${spine(xStart,a.y,xEnd,b.y)}" stroke="${hero?'url(#attrMapSpineHi)':'url(#attrMapSpine)'}" stroke-width="${hero?1.8:1}" fill="none" data-map-from="${esc(f.from)}" data-map-to="${esc(f.to)}"/>`;
  }).join('');
  const xFor=side=>side==='start'?xStart:side==='mid'?xMid:xEnd;
  const hops=data.segments.slice(0,14).map(s=>{
    const fromN=pos.get('start\0'+s.from)||pos.get('mid\0'+s.from);
    const toN=pos.get('end\0'+s.to)||pos.get('mid\0'+s.to);
    if(!fromN||!toN||s.from===s.to)return '';
    const w=1.4+(s.count/data.maxFlow)*5.5;
    return `<path class="attr-map-hop" d="${spine(xFor(fromN.side),fromN.y,xFor(toN.side),toN.y)}" stroke="url(#attrMapHop)" stroke-width="${w.toFixed(2)}" fill="none" data-map-from="${esc(s.from)}" data-map-to="${esc(s.to)}"><title>${esc(s.from)} → ${esc(s.to)} · ${s.count.toLocaleString()} steps</title></path>`;
  }).join('');
  const node=(n,x,side,metric,label,compact=false)=>{
    const r=Math.max(16,Math.min(28,12+Math.sqrt(n.weight)));
    const pad=compact?10:14;
    return `<g class="attr-map-node${compact?' attr-map-node--mid':''}" data-map-channel="${esc(n.channel)}" data-channel="${esc(n.channel)}" data-role="${side==='start'?'started':side==='end'?'credited':'any'}" tabindex="0">
      <circle cx="${x}" cy="${n.y}" r="${r+pad}" class="attr-map-node-glow" fill="url(#attrMapNodeGlow)" filter="url(#attrMapNodeBlur)"/>
      <circle cx="${x}" cy="${n.y}" r="${r+6}" class="attr-map-node-ring"/>
      <circle cx="${x}" cy="${n.y}" r="${r}" class="attr-map-node-core"/>
      <foreignObject x="${x-16}" y="${n.y-16}" width="32" height="32">${platformMark(n.channel)}</foreignObject>
      <text x="${x}" y="${n.y+r+24}" text-anchor="middle" class="attr-map-node-count">${(n[metric]??n.weight).toLocaleString()}</text>
      <text x="${x}" y="${n.y+r+38}" text-anchor="middle" class="attr-map-node-label">${esc(label)}</text>
    </g>`;
  };
  const nodes=[...left.map(n=>node(n,xStart,'start','started','started')),...mid.map(n=>node(n,xMid,'mid','assisted','assisted',true)),...right.map(n=>node(n,xEnd,'end','closed','closed'))].join('');
  const timing=medianDays?`<span class="attr-map-stat"><span class="attr-map-stat-k">Median journey</span><span class="attr-map-stat-v">${esc(medianDays)}</span></span>`:'';
  const pathNote=topPath?.length?`<span class="attr-map-stat"><span class="attr-map-stat-k">Top path</span><span class="attr-map-stat-v">${esc(topPath.join(' → '))}</span></span>`:'';
  return `<section class="bcn-card attr-journey-map-card" aria-labelledby="attr-journey-map-title">
    <div class="bcn-card-header attr-journey-map-header"><div><span class="attr-eyebrow">COMPANY CUSTOMER JOURNEY</span><h2 id="attr-journey-map-title">How shoppers move before they buy</h2></div>
    <div class="attr-map-stats"><span class="attr-map-stat attr-map-stat--accent"><span class="attr-map-stat-k">Multi-channel</span><span class="attr-map-stat-v">${data.multiShare}%</span></span>${timing}${pathNote}</div></div>
    <div class="bcn-card-body attr-journey-map-body">
    <div class="attr-journey-map" role="group" aria-label="How customers move between channels before purchase">
    <svg class="attr-map-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Customer paths from first touch to last click">
      <defs>
        <pattern id="attrMapDots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1" fill="var(--bcn-ink-3)" opacity=".22"/></pattern>
        <linearGradient id="attrMapRibbon" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="var(--bcn-accent)" stop-opacity=".35"/><stop offset="50%" stop-color="var(--bcn-accent)" stop-opacity=".65"/><stop offset="100%" stop-color="var(--bcn-pos)" stop-opacity=".55"/></linearGradient>
        <linearGradient id="attrMapRibbonHi" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="var(--bcn-accent)"/><stop offset="55%" stop-color="color-mix(in oklab,var(--bcn-accent) 70%,var(--bcn-pos))"/><stop offset="100%" stop-color="var(--bcn-pos)"/></linearGradient>
        <linearGradient id="attrMapSpine" x1="0%" x2="100%"><stop stop-color="var(--bcn-surface)" stop-opacity=".9"/><stop offset="1" stop-color="var(--bcn-accent-soft)"/></linearGradient>
        <linearGradient id="attrMapSpineHi" x1="0%" x2="100%"><stop stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="var(--bcn-accent-border)"/></linearGradient>
        <linearGradient id="attrMapHop" x1="0%" x2="100%"><stop stop-color="var(--bcn-ink-3)" stop-opacity=".15"/><stop offset="1" stop-color="var(--bcn-accent)" stop-opacity=".5"/></linearGradient>
        <radialGradient id="attrMapNodeGlow"><stop offset="0%" stop-color="var(--bcn-accent)" stop-opacity=".28"/><stop offset="100%" stop-color="var(--bcn-accent)" stop-opacity="0"/></radialGradient>
        <filter id="attrMapNodeBlur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
        <filter id="attrMapPurchaseGlow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="10" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <linearGradient id="attrMapLaneStart" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="var(--bcn-accent-soft)" stop-opacity=".7"/><stop offset="100%" stop-color="transparent"/></linearGradient>
        <linearGradient id="attrMapLaneMid" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="color-mix(in oklab,var(--bcn-ink-3) 22%,transparent)"/><stop offset="100%" stop-color="transparent"/></linearGradient>
        <linearGradient id="attrMapLaneEnd" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="color-mix(in oklab,var(--bcn-pos) 24%,transparent)"/><stop offset="100%" stop-color="transparent"/></linearGradient>
      </defs>
      <rect x="0" y="40" width="${width}" height="${height-48}" rx="16" fill="url(#attrMapDots)" opacity=".55"/>
      <rect x="44" y="${y0}" width="168" height="${plotH}" rx="14" class="attr-map-lane" fill="url(#attrMapLaneStart)"/>
      <rect x="${xMid-84}" y="${y0}" width="168" height="${plotH}" rx="14" class="attr-map-lane attr-map-lane--mid" fill="url(#attrMapLaneMid)"/>
      <rect x="${xEnd-84}" y="${y0}" width="168" height="${plotH}" rx="14" class="attr-map-lane" fill="url(#attrMapLaneEnd)"/>
      <text x="${xStart}" y="34" class="attr-map-stage">First touch</text>
      <text x="${xMid}" y="34" class="attr-map-stage">Assisted</text>
      <text x="${xEnd}" y="34" class="attr-map-stage">Last click</text>
      <text x="${xBuy}" y="34" class="attr-map-stage">Purchase</text>
      <g class="attr-map-ribbons" aria-hidden="true">${hops}${ribbons}</g>
      <line x1="${xBuy}" y1="${y0-6}" x2="${xBuy}" y2="${y0+plotH+6}" class="attr-map-finish-line"/>
      <g class="attr-map-purchase" transform="translate(${xBuy} ${y0+plotH/2})" filter="url(#attrMapPurchaseGlow)">
        <circle r="38" class="attr-map-purchase-ring"/><circle r="28" class="attr-map-purchase-core"/>
        <foreignObject x="-18" y="-18" width="36" height="36">${platformMark('Shopify')}</foreignObject>
        <text y="54" text-anchor="middle" class="attr-map-node-label">Purchase</text>
      </g>
      ${nodes}
    </svg>
    <p class="attr-map-legend"><span>Ribbon width · order volume</span><span>Highlight · busiest start→close pair</span><span class="attr-map-hint">Click a channel to drill into orders</span></p>
    </div></div></section>`;
}
