import {classify,journeyVisits} from './silo-attribution-model.js';
import {reportOverview} from './silo-attribution-visuals.js';
import {mountOverview} from './silo-attribution-overview-ui.js';
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function platformMark(channel) {
  const key=/^Meta/.test(channel)?'meta':/^Redo/.test(channel)?'redo':/^Google Ads/.test(channel)?'google-ads':/^TikTok/.test(channel)?'tiktok':/^Shop/.test(channel)?'shopify':null;
  return key?`<svg class="attr-logo" aria-hidden="true"><use href="../assets/landing/integration-icons.svg#icon-${key}"></use></svg>`:'<span class="attr-fallback" aria-hidden="true">•</span>';
}
export function summarize(rows,controls,windowDays) {
  const unique=new Set(),byDay=new Map(),orders=new Map(),channels=new Map();
  if(!controls.length)throw Error('No published snapshots for this period');
  if(new Set(controls.map(d=>d.currency)).size!==1||new Set(controls.map(d=>d.shop_timezone)).size!==1)throw Error('Currency or store timezone changed within this period');
  for(const r of rows){
    if(r.window_days!==windowDays)throw Error('Mixed attribution windows');
    const key=r.day+'|'+r.order_id;if(unique.has(key))throw Error('Duplicate order/day revenue');unique.add(key);
    if(!Number.isSafeInteger(Number(r.net_cents))||!Number.isSafeInteger(Number(r.total_cents)))throw Error('Invalid revenue cents');
    const d=byDay.get(r.day)||{net:0,total:0,stamp:r.extracted_at};
    if(d.stamp!==r.extracted_at)throw Error('Snapshots changed during load; reload');
    d.net+=Number(r.net_cents);d.total+=Number(r.total_cents);byDay.set(r.day,d);
    const prior=orders.get(r.order_id);
    if(prior && (prior.channel!==r.channel || prior.evidence_fetched_at!==r.evidence_fetched_at))throw Error('Order evidence changed during load; reload');
    const a=prior||{...r,net_cents:0,total_cents:0};a.net_cents+=Number(r.net_cents);a.total_cents+=Number(r.total_cents);orders.set(r.order_id,a);
  }
  for(const c of controls){const d=byDay.get(c.day)||{net:0,total:0,stamp:c.extracted_at};if(d.stamp!==c.extracted_at||d.net!==Number(c.net_cents)||d.total!==Number(c.total_cents))throw Error('Shopify reconciliation failed; reload or refresh snapshots');byDay.delete(c.day);}
  if(byDay.size)throw Error('Revenue without a daily control');
  for(const a of orders.values()){
    const c=channels.get(a.channel)||{channel:a.channel,orders:0,net_cents:0,total_cents:0,introduced_orders:0,assisted_orders:0};
    c.orders++;c.net_cents+=a.net_cents;c.total_cents+=a.total_cents;channels.set(a.channel,c);
  }
  for(const a of orders.values()){
    for(const channel of new Set([a.allocation?.introduced_channel,...(a.allocation?.assisting_channels||[])].filter(Boolean))){
      const c=channels.get(channel)||{channel,orders:0,net_cents:0,total_cents:0,introduced_orders:0,assisted_orders:0};
      c.introduced_orders+=a.allocation?.introduced_channel===channel?1:0;
      c.assisted_orders+=(a.allocation?.assisting_channels||[]).includes(channel)?1:0;channels.set(channel,c);
    }
  }
  return {reconciliation:controls.map(c=>({...c,net_difference:0,total_difference:0})),orders:[...orders.values()],channels:[...channels.values()].sort((a,b)=>b.net_cents-a.net_cents),net:controls.reduce((s,c)=>s+Number(c.net_cents),0),total:controls.reduce((s,c)=>s+Number(c.total_cents),0),currency:controls[0].currency,timezone:controls[0].shop_timezone,days:controls.length};
}
export function journeyFlow(evidence,allocation,timezone,currency,netCents,windowDays=allocation?.window_days||30) {
  if(![7,14,30,60].includes(windowDays))throw Error('Unsupported journey window');
  const order=evidence.order,created=Date.parse(order.createdAt);
  const formatTime=value=>value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('en-US',{timeZone:timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'Purchase time unavailable';
  const visits=journeyVisits(order).filter(v=>Date.parse(v.occurredAt)<=created);
  const steps=visits.map(v=>{
    let channel=classify(v,{ownHosts:evidence.own_hosts||[]}).channel||'Unknown source';
    const credited=v.id===allocation?.visit_id;
    if(credited)channel=allocation.channel;
    const inside=Date.parse(v.occurredAt)<=created&&Date.parse(v.occurredAt)>=created-windowDays*86400000;
    const roles=[credited?'Credited touch':null,v.id===allocation?.introduced_visit_id?'Introducing touch':null,!inside?'Outside selected window':null,inside&&channel==='Direct'?'Direct visit':null,inside&&!credited&&(allocation?.assisting_channels||[]).includes(channel)?'Assist':null].filter(Boolean);
    return `<li class="attr-step ${credited?'attr-step--credited':''} ${!inside?'attr-step--outside':''}"><div class="attr-node">${platformMark(channel)}</div><div class="attr-step-body"><div class="attr-step-title">${escapeHtml(channel)} ${roles.map(r=>`<span class="bcn-pill ${r==='Credited touch'?'bcn-pill--accent':''}">${escapeHtml(r)}</span>`).join(' ')}</div><div class="bcn-mono attr-time">${escapeHtml(formatTime(v.occurredAt))}</div><p>${escapeHtml(v.utmParameters?.campaign||'No campaign identified')}</p><details><summary>Visit evidence</summary><div>Source: ${escapeHtml(v.utmParameters?.source||v.source||'Unknown')} · Medium: ${escapeHtml(v.utmParameters?.medium||'Unknown')}</div><div class="attr-url">${escapeHtml(v.landingPage||'No landing page')}</div></details></div></li>`;
  });
  if(!visits.length)steps.push('<li class="attr-step"><div class="attr-node">?</div><div class="attr-step-body">No captured visits. Missing evidence is not Direct.</div></li>');
  if(allocation?.assignment==='first_touch_fallback')steps.push(`<li class="attr-step attr-step--credited"><div class="attr-node">${platformMark(allocation.channel)}</div><div class="attr-step-body"><div class="attr-step-title">${escapeHtml(allocation.channel)} <span class="bcn-pill bcn-pill--accent">Credited first-touch fallback</span></div><div class="attr-time">Order landing evidence · visit time unavailable</div><p>${escapeHtml(allocation.campaign_name||allocation.campaign||'No campaign identified')}</p><details><summary>Landing evidence</summary><div>Source: ${escapeHtml(allocation.source||'Unknown')} · Medium: ${escapeHtml(allocation.medium||'Unknown')}</div><div class="attr-url">${escapeHtml(evidence.raw?.landing_path||'No landing path')}</div></details></div></li>`);
  steps.push(`<li class="attr-step attr-step--purchase"><div class="attr-node">${platformMark('Shopify')}</div><div class="attr-step-body"><strong>Purchase ${escapeHtml(order.name)}</strong><div class="bcn-mono attr-time">${escapeHtml(formatTime(order.createdAt))}</div><p>${escapeHtml(new Intl.NumberFormat('en-US',{style:'currency',currency}).format(netCents/100))} net sales activity in the selected reporting period</p></div></li>`);
  const summary=`<div class="attr-journey-summary"><div class="attr-path-stage">${platformMark(allocation?.introduced_channel||'Unknown')}<small>Observed introduction</small><strong>${escapeHtml(allocation?.introduced_channel||'Not identified')}</strong></div><span class="attr-path-arrow">→</span><div class="attr-path-stage">${platformMark(allocation?.channel||'Unattributed')}<small>Revenue credit</small><strong>${escapeHtml(allocation?.channel||'Unattributed')}</strong></div><span class="attr-path-arrow">→</span><div class="attr-path-stage">${platformMark('Shopify')}<small>Purchase</small><strong>${escapeHtml(order.name)}</strong></div></div><p class="attr-context">Role summary for the ${windowDays}-day window. Other observed assists: ${escapeHtml((allocation?.assisting_channels||[]).join(', ')||'None identified')}.</p>`;
  return summary+`<details class="attr-all-visits"><summary>Explore ${visits.length} observed visits and supporting evidence</summary><ol class="attr-flow" aria-label="Customer journey in chronological order">${steps.join('')}</ol></details>`;
}
export async function loadRows(db,companyId,connectionId,start,end,windowDays) {
  if(![companyId,connectionId].every(v=>/^[0-9a-f-]{36}$/i.test(v))||![start,end].every(v=>/^\d{4}-\d{2}-\d{2}$/.test(v))||![7,14,30,60].includes(windowDays))throw Error('Invalid report filters');
  const {data:controls,error}=await db.from('shopify_attribution_days').select('day,currency,shop_timezone,net_cents,total_cents,extracted_at').eq('company_entity_id',companyId).eq('connection_id',connectionId).gte('day',start).lte('day',end).order('day');
  if(error)throw error;
  const expected=Math.round((Date.parse(end)-Date.parse(start))/86400000)+1;
  if(expected<1||expected>31)throw Error('Choose an inclusive period of 1–31 days');
  if(controls.length!==expected)throw Error('Some days have not been backfilled. No full-period report is available yet.');
  const rows=[];
  for(let offset=0;offset<100000;offset+=1000){
    const {data,error}=await db.rpc('chat_run_readonly_query',{query:`select * from public.silo_attribution_ledger_v where company_entity_id='${companyId}'::uuid and connection_id='${connectionId}'::uuid and window_days=${windowDays} and day between '${start}'::date and '${end}'::date order by day,order_id`,p_offset:offset});
    if(error)throw error;if(!Array.isArray(data))throw Error('Unexpected reporting result');rows.push(...data);if(data.length<1000)return summarize(rows,controls,windowDays);
  }
  throw Error('Report row limit reached; choose a smaller period');
}
export function mountReport(root,{load,evidence,journeys,owners=[],saveDraft}) {
  let report=null,page=0,sequence=0;
  const $=id=>root.querySelector('#'+id),money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:report.currency}).format(n/100);
  function status(message,type='info'){$('status').textContent=message;$('status').className='bcn-status bcn-status--'+type;$('status').hidden=!message;}
  function drawOrders(){
    if(!report)return;
    const query=$('search').value.toLowerCase(),channel=$('channel').value;
    const rows=report.orders.filter(a=>(!channel||a.channel===channel)&&[a.order_name,a.order_id,a.channel,a.allocation?.campaign_name,a.allocation?.campaign,a.allocation?.reason].join(' ').toLowerCase().includes(query));
    page=Math.min(page,Math.max(0,Math.ceil(rows.length/12)-1));
    $('orders').innerHTML=rows.slice(page*12,page*12+12).map(a=>`<button class="attr-order-card" data-order="${escapeHtml(a.order_id)}"><span class="attr-order-top"><strong>Order ${escapeHtml(a.order_name||a.order_id)}</strong><strong>${money(a.net_cents)}</strong></span><span class="attr-order-path"><span>${platformMark(a.allocation?.introduced_channel||'Unknown')}<small>Introduced</small><strong>${escapeHtml(a.allocation?.introduced_channel||'Not identified')}</strong></span><b>→</b><span>${platformMark(a.channel)}<small>Credited</small><strong>${escapeHtml(a.channel)}</strong></span><b>→</b><span>${platformMark('Shopify')}<small>Purchased</small><strong>Shopify</strong></span></span><span class="attr-order-bottom">${escapeHtml((a.allocation?.assisting_channels||[]).join(', ')||'No other assists observed')}<span>Explore journey ↗</span></span></button>`).join('');
    $('count').textContent=`${rows.length.toLocaleString()} orders with sales activity · Page ${page+1} of ${Math.max(1,Math.ceil(rows.length/12))}`;
    $('previous').disabled=page===0;$('next').disabled=(page+1)*12>=rows.length;
  }
  function draw(){
    $('legacy-overview').innerHTML=reportOverview(report);
    $('net').textContent=money(report.net);$('total').textContent=money(report.total);$('ordercount').textContent=report.orders.length.toLocaleString();$('reconciled').textContent=`${report.days} of ${report.days} days matched`;
    const selected=$('channel').value;
    $('channel').innerHTML='<option value="">All credited channels</option>'+report.channels.map(c=>`<option>${escapeHtml(c.channel)}</option>`).join('');$('channel').value=selected;
    $('channels').innerHTML=report.channels.map(c=>`<tr><td><button class="bcn-btn bcn-btn--ghost" data-channel="${escapeHtml(c.channel)}">${platformMark(c.channel)} ${escapeHtml(c.channel)}</button></td><td class="bcn-mono">${money(c.net_cents)}</td><td class="bcn-mono">${c.orders.toLocaleString()}</td><td class="bcn-mono">${c.introduced_orders.toLocaleString()}</td><td class="bcn-mono">${c.assisted_orders.toLocaleString()}</td></tr>`).join('');
    $('daily').innerHTML=report.reconciliation.map(d=>`<tr><td>${escapeHtml(d.day)}</td><td class="bcn-mono">${money(Number(d.net_cents))}</td><td class="bcn-mono">${money(Number(d.total_cents))}</td><td class="bcn-mono">${money(0)}</td><td class="bcn-mono">${money(0)}</td></tr>`).join('');
    $('results').hidden=false;drawOrders();
  }
  const filters=()=>({start:$('start').value,end:$('end').value,windowDays:Number($('window').value),connectionId:$('store').value});
  function showJourneys(show){$('ordersection').hidden=!show;$('overview').hidden=show;for(const [id,on] of [['overview-tab',!show],['journeys-tab',show]]){$(id).classList.toggle('bcn-tab--active',on);$(id).setAttribute('aria-pressed',String(on));}}
  $('overview-tab').onclick=()=>showJourneys(false);$('journeys-tab').onclick=()=>showJourneys(true);
  async function refresh(){
    const current=++sequence,args=filters();report=null;$('results').hidden=true;$('journey').close();
    root.querySelectorAll('#overview dialog[open]').forEach(d=>d.close());status('Loading verified snapshots.');
    try{
      const result=await load(args);if(current!==sequence)return;report=result;page=0;draw();
      $('overview').textContent='Loading captured journeys…';
      try {
        const records=await journeys(result.orders,args);if(current!==sequence)return;
        mountOverview($('overview'),{report:result,records,context:args,owners,saveDraft:fields=>saveDraft({...fields,context:args}),isCurrent:()=>current===sequence&&JSON.stringify(args)===JSON.stringify(filters())});
      } catch(e){if(current!==sequence)return;$('overview').textContent='Journey overview unavailable: '+e.message+'. Published sales remain available below.';}
      status('');
    }catch(e){if(current===sequence)status(e.message||String(e),'neg');}
  }
  for(const id of ['start','end','store'])$(id).onchange=()=>{++sequence;report=null;$('results').hidden=true;$('journey').close();root.querySelectorAll('#overview dialog[open]').forEach(d=>d.close());status('Filters changed. Load report to view verified results.');};
  $('load').onclick=refresh;$('window').onchange=refresh;$('search').oninput=()=>{page=0;drawOrders();};$('channel').onchange=()=>{page=0;drawOrders();};$('previous').onclick=()=>{page--;drawOrders();};$('next').onclick=()=>{page++;drawOrders();};$('close').onclick=()=>$('journey').close();
  root.addEventListener('click',async event=>{
    const channel=event.target.closest('[data-channel]');if(channel){showJourneys(true);$('channel').value=channel.dataset.channel;page=0;drawOrders();$('ordersection').scrollIntoView({behavior:'smooth'});}
    const button=event.target.closest('[data-order]');if(!button||!report)return;
    const a=report.orders.find(r=>r.order_id===button.dataset.order),stamp=sequence;if(!a)return;
    button.disabled=true;
    try{
      const e=await evidence(a);
      if(stamp!==sequence)return;
      if(e.fetched_at&&e.fetched_at!==a.evidence_fetched_at)throw Error('Journey refreshed since report loaded; reload the report');
      const payload=e.evidence||e;
      $('journeytitle').textContent=`${a.order_name||a.order_id} · ${a.channel}`;
      $('journeyreason').textContent=a.allocation?.reason||'Model not yet backfilled';
      $('flow').innerHTML=journeyFlow(payload,a.allocation,report.timezone,report.currency,a.net_cents,a.window_days);
      $('journey').showModal();
    }catch(e){status(e.message,'neg');}finally{button.disabled=false;}
  });
  return {refresh};
}
