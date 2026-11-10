// Interactive company journey studio — presentation only.
import {GAPS} from './silo-attribution-together.js';
import {platformMark} from './silo-attribution-visuals.js';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function buildJourneyStudioData(report,analysis,rows,paths=[]){
  const nodes=rows.filter(r=>!GAPS.includes(r.channel));
  const byChannel=new Map(nodes.map(n=>[n.channel,n]));
  let lanes=paths.filter(p=>p.path?.length).slice(0,6).map(p=>({key:p.key||JSON.stringify(p.path),path:p.path,count:p.count,net_cents:p.net_cents,medianMs:p.medianMs,orderIds:p.orderIds||[]}));
  if(!lanes.length){
    const acc=new Map();
    for(const o of report.orders){
      const a=o.allocation||{},seq=[];
      if(a.introduced_channel&&!GAPS.includes(a.introduced_channel))seq.push(a.introduced_channel);
      for(const c of a.assisting_channels||[])if(c&&!GAPS.includes(c)&&!seq.includes(c))seq.push(c);
      if(!GAPS.includes(o.channel)&&!seq.includes(o.channel))seq.push(o.channel);
      if(!seq.length)continue;
      const key=JSON.stringify(seq),g=acc.get(key)||{key,path:seq,count:0,net_cents:0,orderIds:[]};
      g.count++;g.net_cents+=o.net_cents;g.orderIds.push(o.order_id);acc.set(key,g);
    }
    lanes=[...acc.values()].sort((a,b)=>b.count-a.count).slice(0,6);
  }
  const multiShare=report.orders.length?Math.round(report.orders.filter(o=>{const a=o.allocation||{},set=new Set([o.channel,a.introduced_channel,...(a.assisting_channels||[])].filter(c=>c&&!GAPS.includes(c)));return set.size>1;}).length/report.orders.length*100):0;
  const maxCount=Math.max(1,...lanes.map(l=>l.count));
  return {lanes,nodes:byChannel,multiShare,maxCount,orders:report.orders.length};
}

function laneCols(length){
  if(length<=1)return [0,3];
  if(length===2)return [0,2,3];
  return [0,1,2,3];
}

function lanePoints(path,cols,xs,y){
  const ix=laneCols(path.length);
  return path.map((ch,i)=>({ch,x:xs[ix[i]],y})).concat([{ch:'Shopify',x:xs[3],y,isPurchase:true}]);
}

function spineD(x1,y1,x2,y2){
  const cx=Math.abs(x2-x1)*.42;
  return `M${x1} ${y1}C${x1+cx} ${y1},${x2-cx} ${y2},${x2} ${y2}`;
}

function ribbonD(x1,y1,x2,y2,half){
  const cx=Math.abs(x2-x1)*.42;
  return `M${x1} ${y1-half}C${x1+cx} ${y1-half},${x2-cx} ${y2-half},${x2} ${y2-half}L${x2} ${y2+half}C${x2-cx} ${y2+half},${x1+cx} ${y1+half},${x1} ${y1+half}Z`;
}

export function renderJourneyStudio(data,{money,medianDays=null}){
  if(!data.lanes.length)return '';
  const width=1000,height=56+data.lanes.length*78+52;
  const xs=[130,380,630,860],y0=54,laneGap=78;
  const colLabels=['Discover','Consider','Decide','Buy'];
  const laneSvg=data.lanes.map((lane,li)=>{
    const y=y0+li*laneGap+laneGap/2;
    const pts=lanePoints(lane.path,laneCols(lane.path.length),xs,y);
    const half=4+(lane.count/data.maxCount)*18;
    const segs=pts.slice(0,-1).map((a,i)=>{const b=pts[i+1];return `<path class="attr-studio-ribbon" data-lane="${li}" data-from="${esc(a.ch)}" data-to="${esc(b.ch)}" d="${ribbonD(a.x,a.y,b.x,b.y,half)}" fill="url(#attrStudioRibbon${li===0?'Hi':''})" opacity="${li===0?0.95:0.42}"/><path class="attr-studio-spine" data-lane="${li}" d="${spineD(a.x,a.y,b.x,b.y)}" stroke="url(#attrStudioSpine)" fill="none" stroke-width="1.25"/>`;}).join('');
    const nodes=pts.map(p=>{
      if(p.isPurchase)return `<g class="attr-studio-node attr-studio-node--buy" transform="translate(${p.x} ${p.y})"><circle r="26" class="attr-studio-node-ring"/><circle r="18" class="attr-studio-node-core"/><foreignObject x="-14" y="-14" width="28" height="28">${platformMark('Shopify')}</foreignObject></g>`;
      return `<g class="attr-studio-node" data-lane="${li}" data-map-channel="${esc(p.ch)}" data-channel="${esc(p.ch)}" data-role="${p.x===xs[0]?'started':p.x===xs[2]?'credited':'any'}" tabindex="0" transform="translate(${p.x} ${p.y})"><circle r="24" class="attr-studio-node-glow"/><circle r="22" class="attr-studio-node-ring"/><circle r="16" class="attr-studio-node-core"/><foreignObject x="-14" y="-14" width="28" height="28">${platformMark(p.ch)}</foreignObject><text y="40" class="attr-studio-node-name">${esc(p.ch)}</text></g>`;
    }).join('');
    return `<g class="attr-studio-lane" data-lane="${li}">${segs}${nodes}</g>`;
  }).join('');
  const rail=data.lanes.map((lane,li)=>`<button type="button" class="attr-studio-path${li===0?' is-active':''}" role="tab" aria-selected="${li===0}" data-lane="${li}" data-path-key="${esc(lane.key)}"><span class="attr-studio-path-flow">${lane.path.map(c=>`<span class="attr-studio-path-step">${platformMark(c)}<span>${esc(c)}</span></span>`).join('<span class="attr-studio-path-arrow">→</span>')}<span class="attr-studio-path-arrow">→</span><span class="attr-studio-path-step">${platformMark('Shopify')}<span>Purchase</span></span></span><span class="attr-studio-path-meta"><strong>${lane.count.toLocaleString()}</strong> orders<span class="bcn-mono">${esc(money(lane.net_cents))}</span></span></button>`).join('');
  const timing=medianDays?`<span class="attr-studio-kpi"><span>Median</span><strong>${esc(medianDays)}</strong></span>`:'';
  return `<section class="bcn-card attr-journey-studio" aria-labelledby="attr-journey-studio-title">
    <div class="bcn-card-header attr-journey-studio-head"><div><span class="attr-eyebrow">COMPANY CUSTOMER JOURNEY</span><h2 id="attr-journey-studio-title">Follow the paths that actually convert</h2><p class="attr-context attr-journey-studio-lede">Each row is a real journey pattern. Pick one to see it move.</p></div>
    <div class="attr-studio-kpis"><span class="attr-studio-kpi attr-studio-kpi--accent"><span>Multi-channel</span><strong>${data.multiShare}%</strong></span>${timing}<span class="attr-studio-kpi"><span>Patterns</span><strong>${data.lanes.length}</strong></span></div></div>
    <div class="bcn-card-body attr-journey-studio-body">
      <div class="attr-studio-stage" data-lanes="${data.lanes.length}">
        <canvas class="attr-studio-fx" aria-hidden="true"></canvas>
        <svg class="attr-studio-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Customer journey paths by pattern">
          <defs>
            <pattern id="attrStudioGrid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="var(--bcn-border)" stroke-width=".6" opacity=".35"/></pattern>
            <linearGradient id="attrStudioRibbon" x1="0%" x2="100%"><stop offset="0%" stop-color="var(--bcn-accent)" stop-opacity=".25"/><stop offset="100%" stop-color="var(--bcn-pos)" stop-opacity=".45"/></linearGradient>
            <linearGradient id="attrStudioRibbonHi" x1="0%" x2="100%"><stop offset="0%" stop-color="var(--bcn-accent)"/><stop offset="100%" stop-color="var(--bcn-pos)"/></linearGradient>
            <linearGradient id="attrStudioSpine" x1="0%" x2="100%"><stop offset="0%" stop-color="#fff" stop-opacity=".8"/><stop offset="100%" stop-color="var(--bcn-accent-border)" stop-opacity=".5"/></linearGradient>
            <radialGradient id="attrStudioGlow"><stop offset="0%" stop-color="var(--bcn-accent)" stop-opacity=".35"/><stop offset="100%" stop-color="var(--bcn-accent)" stop-opacity="0"/></radialGradient>
          </defs>
          <rect width="${width}" height="${height}" fill="url(#attrStudioGrid)" rx="18"/>
          ${colLabels.map((l,i)=>`<text x="${xs[i]}" y="32" class="attr-studio-col">${esc(l)}</text>`).join('')}
          ${laneSvg}
        </svg>
        <div class="attr-studio-tip" hidden role="status"></div>
      </div>
      <div class="attr-studio-rail" role="tablist" aria-label="Journey patterns">${rail}</div>
    </div></section>`;
}

function pathFromSpine(svg,lane){
  const parts=svg.querySelectorAll(`.attr-studio-spine[data-lane="${lane}"]`);
  const d=[...parts].map(p=>p.getAttribute('d')).join(' ');
  if(!d)return null;
  const probe=document.createElementNS('http://www.w3.org/2000/svg','path');
  probe.setAttribute('d',d);
  return probe;
}

export function wireJourneyStudio(section,data,{money,rows}){
  if(!section)return;
  const stage=section.querySelector('.attr-studio-stage');
  const canvas=section.querySelector('.attr-studio-fx');
  const svg=section.querySelector('.attr-studio-svg');
  const tip=section.querySelector('.attr-studio-tip');
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  let active=0,frame=0,particles=[],pathEl=null,raf=0;
  const byCh=new Map(rows.filter(r=>!GAPS.includes(r.channel)).map(r=>[r.channel,r]));
  const resize=()=>{
    if(!canvas||!stage)return;
    const r=stage.getBoundingClientRect();
    canvas.width=Math.round(r.width*devicePixelRatio);
    canvas.height=Math.round(r.height*devicePixelRatio);
    canvas.style.width=`${r.width}px`;
    canvas.style.height=`${r.height}px`;
  };
  const setLane=i=>{
    active=Number(i);
    section.querySelectorAll('.attr-studio-path').forEach(b=>{const on=b.dataset.lane===String(active);b.classList.toggle('is-active',on);b.setAttribute('aria-selected',on);});
    svg.querySelectorAll('.attr-studio-lane').forEach(g=>g.classList.toggle('is-dimmed',g.dataset.lane!==String(active)));
    pathEl=pathFromSpine(svg,active);
    particles=reduce?[]:Array.from({length:14},(_,k)=>({t:(k/14),speed:.003+Math.random()*.002}));
    drawParticles(0);
  };
  const drawParticles=ts=>{
    if(!canvas||!pathEl||reduce){if(raf)cancelAnimationFrame(raf);return;}
    const ctx=canvas.getContext('2d');
    const len=pathEl.getTotalLength();
    if(!len){raf=requestAnimationFrame(drawParticles);return;}
    ctx.clearRect(0,0,canvas.width,canvas.height);
    const r=stage.getBoundingClientRect();
    const vb=svg.viewBox.baseVal;
    const sx=canvas.width/vb.width, sy=canvas.height/vb.height;
    const dt=frame?Math.min(32,ts-frame):16; frame=ts;
    for(const p of particles){
      p.t=(p.t+p.speed*dt/16)%1;
      const pt=pathEl.getPointAtLength(p.t*len);
      const x=pt.x*sx,y=pt.y*sy;
      const g=ctx.createRadialGradient(x,y,0,x,y,8*devicePixelRatio);
      g.addColorStop(0,'rgba(255,255,255,.95)');
      g.addColorStop(1,'rgba(59,130,246,0)');
      ctx.fillStyle=g;
      ctx.beginPath();ctx.arc(x,y,3.2*devicePixelRatio,0,Math.PI*2);ctx.fill();
    }
    raf=requestAnimationFrame(drawParticles);
  };
  const showTip=(target,clientX,clientY)=>{
    if(!tip)return;
    const ch=target.dataset?.mapChannel;
    const lane=target.closest('[data-lane]')?.dataset?.lane??active;
    const laneData=data.lanes[Number(lane)];
    const row=ch?byCh.get(ch):null;
    const lines=ch&&row?[`<strong>${esc(ch)}</strong>`,`Started ${row.started.toLocaleString()} · Assisted ${row.assisted.toLocaleString()} · Closed ${row.closed.toLocaleString()}`,`Last-click ${money(row.net_cents)}${row.shared_cents!=null?` · Shared ${money(row.shared_cents)}`:''}`]:laneData?[`<strong>${esc(laneData.path.join(' → '))}</strong>`,`${laneData.count.toLocaleString()} orders · ${money(laneData.net_cents)}`]:[];
    if(!lines.length)return;
    tip.innerHTML=`${lines.join('<br>')}<span class="attr-studio-tip-cta">Click to view orders</span>`;
    tip.hidden=false;
    const box=stage.getBoundingClientRect();
    tip.style.left=`${Math.min(clientX-box.left+12,box.width-220)}px`;
    tip.style.top=`${Math.max(clientY-box.top-8,8)}px`;
  };
  section.querySelectorAll('.attr-studio-path').forEach(btn=>btn.addEventListener('click',()=>setLane(btn.dataset.lane)));
  stage?.addEventListener('pointermove',e=>{
    const n=e.target.closest('[data-map-channel]');
    if(n)showTip(n,e.clientX,e.clientY);else if(tip)tip.hidden=true;
  });
  stage?.addEventListener('pointerleave',()=>{if(tip)tip.hidden=true;});
  setLane(0);
  resize();
  new ResizeObserver(resize).observe(stage);
  return {setLane};
}
