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
  if(analysis)for(const p of analysis.paths)for(let i=0;i<p.path.length-1;i++){
    const from=p.path[i],to=p.path[i+1],key=`${from}\0${to}`,s=segments.get(key)||{from,to,count:0};
    s.count+=p.count;segments.set(key,s);
  }
  const maxFlow=Math.max(1,...[...flows.values()].map(f=>f.count));
  return {nodes,flows:[...flows.values()].sort((a,b)=>b.count-a.count||a.from.localeCompare(b.from)),segments:[...segments.values()].sort((a,b)=>b.count-a.count),maxFlow,multiShare:report.orders.length?Math.round(report.orders.filter(o=>{const a=o.allocation||{},set=new Set([o.channel,a.introduced_channel,...(a.assisting_channels||[])].filter(c=>c&&!GAPS.includes(c)));return set.size>1;}).length/report.orders.length*100):0};
}

function stackY(entries,height,gap=10){
  const total=entries.reduce((s,e)=>s+e.weight,0)||1;
  const usable=height-gap*(entries.length-1);
  let y=gap;
  return entries.map(e=>{const h=Math.max(28,usable*e.weight/total);const center=y+h/2;y+=h+gap;return {...e,y:center,h};});
}

export function renderJourneyMap(data,{money,medianDays=null}){
  if(!data.nodes.length)return '';
  const width=920,height=300,xStart=130,xEnd=560,xBuy=820,plotH=220,y0=52;
  const left=stackY(data.nodes.filter(n=>n.started>0).map(n=>({...n,weight:n.started,id:n.channel,side:'start'})),plotH);
  const right=stackY(data.nodes.filter(n=>n.closed>0).map(n=>({...n,weight:n.closed,id:n.channel,side:'end'})),plotH);
  const pos=new Map([...left,...right].map(n=>[n.side+'\0'+n.channel,n]));
  const flowSvg=data.flows.map(f=>{
    const a=pos.get('start\0'+f.from),b=pos.get('end\0'+f.to);
    if(!a||!b)return '';
    const w=2+(f.count/data.maxFlow)*16;
    const cx=(xEnd-xStart)*.45;
    const title=`${f.count} order${f.count===1?'':'s'} · ${money(f.net_cents)}`;
    return `<path class="attr-map-flow${f.from===f.to?' attr-map-flow--solo':''}" data-map-from="${esc(f.from)}" data-map-to="${esc(f.to)}" d="M${xStart+26} ${a.y} C${xStart+26+cx} ${a.y}, ${xEnd-26-cx} ${b.y}, ${xEnd-26} ${b.y}" fill="none" stroke="var(--bcn-accent)" stroke-width="${w.toFixed(2)}" stroke-linecap="round"><title>${esc(title)}</title></path>`;
  }).join('');
  const node=(n,x,side,metric,label)=>{
    const r=Math.max(14,Math.min(26,10+Math.sqrt(n.weight)));
    return `<g class="attr-map-node" data-map-channel="${esc(n.channel)}" data-channel="${esc(n.channel)}" data-role="${side==='start'?'started':'credited'}" tabindex="0">
      <circle cx="${x}" cy="${n.y}" r="${r+10}" class="attr-map-node-halo" fill="var(--bcn-accent-soft)" stroke="var(--bcn-accent-border)"/>
      <foreignObject x="${x-14}" y="${n.y-14}" width="28" height="28">${platformMark(n.channel)}</foreignObject>
      <text x="${x}" y="${n.y+r+22}" text-anchor="middle" class="attr-map-node-count">${n[metric].toLocaleString()}</text>
      <text x="${x}" y="${n.y+r+36}" text-anchor="middle" class="attr-map-node-label">${esc(label)}</text>
    </g>`;
  };
  const nodes=[...left.map(n=>node(n,xStart,'start','started','started')),...right.map(n=>node(n,xEnd,'end','closed','closed'))].join('');
  const timing=medianDays!=null?`<span class="attr-map-chip">Typical path · ${esc(medianDays)}</span>`:'';
  return `<div class="attr-journey-map" role="group" aria-label="How customers move between channels before purchase">
    <div class="attr-map-head"><span class="attr-map-chip attr-map-chip--accent">${data.multiShare}% multi-channel</span>${timing}<span class="attr-map-chip">Thicker ribbons · more orders</span><span class="attr-map-hint">Click a channel to see its orders</span></div>
    <svg class="attr-map-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Customer paths from first touch to last click">
      <text x="${xStart}" y="24" class="attr-map-stage">First touch</text>
      <text x="${xEnd}" y="24" text-anchor="middle" class="attr-map-stage">Last click</text>
      <text x="${xBuy}" y="24" text-anchor="middle" class="attr-map-stage">Purchase</text>
      <line x1="${xBuy}" y1="${y0}" x2="${xBuy}" y2="${y0+plotH}" stroke="var(--bcn-border)" stroke-dasharray="3 6"/>
      ${flowSvg}
      <g class="attr-map-purchase" transform="translate(${xBuy} ${y0+plotH/2})">${platformMark('Shopify')}<text x="0" y="42" text-anchor="middle" class="attr-map-node-label">Shopify</text></g>
      ${nodes}
    </svg></div>`;
}
