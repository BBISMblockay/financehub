// How channels work together: one row per channel joining published credit,
// observed roles, shared credit and spend. Presentation of reconciled results
// only; the published last-non-direct ledger is never changed.
export const GAPS=['Unattributed','Pending'];
const row=channel=>({channel,orders:0,net_cents:0,started:0,started_net:0,assisted:0,closed:0,closed_after_other:0,touched:0,touched_net:0,shared_cents:null,spend:null});

export function channelTeamwork(report,analysis,spend){
  const rows=new Map(),get=c=>{if(!rows.has(c))rows.set(c,row(c));return rows.get(c);};
  for(const o of report.orders){
    const a=o.allocation||{},net=o.net_cents,credited=get(o.channel),intro=a.introduced_channel||null,assists=a.assisting_channels||[];
    credited.orders++;credited.net_cents+=net;
    if(intro){const r=get(intro);r.started++;r.started_net+=net;}
    // Roles are distinct per order: an assist is a channel seen between the start and the close.
    for(const c of new Set(assists))if(c!==intro&&c!==o.channel)get(c).assisted++;
    if(!GAPS.includes(o.channel)){credited.closed++;if(intro&&intro!==o.channel)credited.closed_after_other++;}
    for(const c of new Set([o.channel,intro,...assists].filter(c=>c&&!GAPS.includes(c)))){const r=get(c);r.touched++;r.touched_net+=net;}
  }
  if(analysis)for(const [c,m] of analysis.models.equal)get(c).shared_cents=m.net_cents;
  for(const s of spend?.values()||[])get(s.channel).spend=s;
  const out=[...rows.values()].map(r=>{
    // Return needs a full-period denominator: partial or unverified spend gets none.
    const cents=r.spend?.status==='complete'?r.spend.cents:null;
    return {...r,shared_cents:analysis?(r.shared_cents||0):null,roas:cents>0?r.net_cents/cents:null,shared_roas:cents>0&&analysis?(r.shared_cents||0)/cents:null};
  });
  const rank=r=>GAPS.includes(r.channel)?2:r.spend?.cents>0?0:1;
  return out.sort((a,b)=>rank(a)-rank(b)||(b.spend?.cents||0)-(a.spend?.cents||0)||b.net_cents-a.net_cents||a.channel.localeCompare(b.channel));
}

export const ratio=n=>n==null||!Number.isFinite(n)?'—':`${n.toFixed(1)}x`;
export function pathRevenue(report,paths){
  const net=new Map(report.orders.map(o=>[o.order_id,o.net_cents]));
  return paths.map(p=>({...p,net_cents:p.orderIds.reduce((s,id)=>s+(net.get(id)||0),0)}));
}

// Plain-language findings. Evidence gaps are never headlined as a channel.
const n=(count,word)=>`${count.toLocaleString()} ${word}${count===1?'':'s'}`;
export function findings(report,rows,analysis,money){
  const out=[],named=rows.filter(r=>!GAPS.includes(r.channel)),pct=(a,b)=>b?Math.round(a/b*100):0;
  const starter=[...named].filter(r=>r.started>r.closed&&r.started>0).sort((a,b)=>(b.started-b.closed)-(a.started-a.closed)||a.channel.localeCompare(b.channel))[0];
  if(starter){
    const shared=starter.shared_cents!=null&&starter.shared_cents>starter.net_cents?` With shared credit it gets ${money(starter.shared_cents)} instead of ${money(starter.net_cents)}${starter.roas!=null&&starter.shared_roas!=null?` (return ${ratio(starter.shared_roas)} instead of ${ratio(starter.roas)} on ${money(starter.spend.cents)} spent)`:''}.`:'';
    out.push({key:'starter',title:`${starter.channel} starts more sales than it gets credit for`,text:`It started ${n(starter.started,'order')} but was the last click on ${starter.closed.toLocaleString()}.${shared}`,orderIds:report.orders.filter(o=>o.allocation?.introduced_channel===starter.channel&&o.channel!==starter.channel).map(o=>o.order_id)});
  }
  const closer=[...named].filter(r=>r.closed_after_other>0&&r.channel!==starter?.channel).sort((a,b)=>b.closed_after_other-a.closed_after_other||a.channel.localeCompare(b.channel))[0];
  if(closer){
    const from=new Map();for(const o of report.orders)if(o.channel===closer.channel){const i=o.allocation?.introduced_channel;if(i&&i!==o.channel)from.set(i,(from.get(i)||0)+1);}
    const top=[...from].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0];
    out.push({key:'closer',title:`${closer.channel} mostly finishes what others start`,text:`${pct(closer.closed_after_other,closer.closed)}% of its ${n(closer.closed,'order')} ${closer.closed===1?'was':'were'} started by another channel, mostly ${top[0]}.`,orderIds:report.orders.filter(o=>o.channel===closer.channel&&o.allocation?.introduced_channel&&o.allocation.introduced_channel!==o.channel).map(o=>o.order_id)});
  }
  const path=analysis?pathRevenue(report,analysis.paths).find(p=>p.path.length>1):null;
  if(path)out.push({key:'path',title:`Most common path: ${path.path.join(' → ')}`,text:`${n(path.count,'order')}, ${money(path.net_cents)} in sales, about ${days(path.medianMs)} from first visit to purchase.`,orderIds:path.orderIds});
  const idle=named.find(r=>r.spend?.cents>0&&r.net_cents<=0&&!(r.shared_cents>0));
  if(idle)out.push({key:'idle',title:`${idle.channel} spent ${money(idle.spend.cents)} with no sales`,text:'No sales were credited to it this period. Check its tracking links (UTMs) before judging the spend.',orderIds:[]});
  return out.slice(0,3);
}
export const days=ms=>ms==null?'unavailable':ms<86400000?`${(ms/3600000).toFixed(1)} hours`:`${(ms/86400000).toFixed(1)} days`;
