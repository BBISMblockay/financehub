const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const compact = n => !Number.isFinite(n) ? '—' : Math.abs(n) >= 1e6 ? `${(n/1e6).toFixed(1)}m` : Math.abs(n)>=1000 ? `${Math.round(n/1000)}k` : Math.round(n).toString();
const mon = value => new Date(`${value}-01T00:00:00Z`).toLocaleDateString('en-US',{month:'short',timeZone:'UTC'});
export function cashChart(rows, baselineRows, floor) {
  if (!rows?.length || rows.some(r=>!Number.isFinite(r.closingCash)) || !Number.isFinite(floor)) return '<div class="uw-empty"><strong>Start with the cash baseline</strong>Enter documented cash, existing payments and the proposal to see the monthly path.</div>';
  const W=800,H=270,L=58,R=20,T=20,B=32;
  const values=[floor,...rows.map(r=>r.closingCash),...baselineRows.map(r=>r.closingCash).filter(Number.isFinite)];
  let low=Math.min(0,...values),high=Math.max(...values); const pad=Math.max((high-low)*.14,100); low-=pad*.25;high+=pad;
  const x=i=>L+i*(W-L-R)/Math.max(1,rows.length-1),y=v=>T+(high-v)*(H-T-B)/(high-low);
  const path = list=>list.map((r,i)=>`${i?'L':'M'}${x(i).toFixed(1)},${y(r.closingCash).toFixed(1)}`).join(' ');
  let grid='';for(let i=0;i<5;i++){const v=low+(high-low)*i/4;grid+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--bcn-border)" stroke-width=".6"/><text x="${L-10}" y="${y(v)+3}" text-anchor="end">${esc(compact(v))}</text>`;}
  const labels=rows.map((r,i)=>rows.length>14&&i%3? '':`<text x="${x(i)}" y="${H-8}" text-anchor="middle">${esc(mon(r.month))}</text>`).join('');
  const baseline=baselineRows.length===rows.length&&baselineRows.every(r=>Number.isFinite(r.closingCash))?`<path d="${path(baselineRows)}" fill="none" stroke="var(--bcn-ink-4)" stroke-width="2" stroke-dasharray="4 4"/>`:'';
  const p=path(rows),last=rows.length-1;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Modeled monthly cash with proposed debt, without proposed debt, and the retained cash floor. Values also available in monthly schedule."><defs><linearGradient id="cash-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--bcn-accent)" stop-opacity=".12"/><stop offset="1" stop-color="var(--bcn-accent)" stop-opacity="0"/></linearGradient></defs>${grid}<path d="${p} L${x(last)},${H-B} L${x(0)},${H-B} Z" fill="url(#cash-fill)"/>${baseline}<line x1="${L}" x2="${W-R}" y1="${y(floor)}" y2="${y(floor)}" stroke="var(--bcn-warn)" stroke-dasharray="5 4"/><path d="${p}" fill="none" stroke="var(--bcn-accent)" stroke-width="2.5"/>${rows.map((r,i)=>`<circle cx="${x(i)}" cy="${y(r.closingCash)}" r="2.5" fill="var(--bcn-surface)" stroke="var(--bcn-accent)" stroke-width="1.5"><title>${esc(r.month)}: ${esc(r.closingCash.toFixed(2))}</title></circle>`).join('')}${labels}</svg>`;
}
export function debtChart(rows) {
  if(!rows?.length||rows.some(r=>!Number.isFinite(r.totalDebtService)))return '<div class="uw-empty" style="min-height:140px;padding:25px">Complete the existing payment schedule to compare debt service.</div>';
  const W=390,H=155,L=40,R=8,T=8,B=25,max=Math.max(1,...rows.map(r=>r.totalDebtService))*1.2;
  const step=(W-L-R)/rows.length,bw=Math.min(16,step*.5),y=v=>H-B-v*(H-T-B)/max;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly principal and interest, existing versus proposed"><line x1="${L}" x2="${W-R}" y1="${H-B}" y2="${H-B}" stroke="var(--bcn-border)"/><text x="${L-5}" y="${T+10}" text-anchor="end">${compact(max)}</text><text x="${L-5}" y="${H-B}" text-anchor="end">0</text>${rows.map((r,i)=>{const x=L+step*i+(step-bw)/2;return `<rect x="${x}" y="${y(r.existingDebtService)}" width="${bw}" height="${(H-B)-y(r.existingDebtService)}" fill="var(--bcn-ink-4)" rx="1"/><rect x="${x}" y="${y(r.totalDebtService)}" width="${bw}" height="${y(r.existingDebtService)-y(r.totalDebtService)}" fill="var(--bcn-accent)" rx="1"><title>${esc(r.month)}: ${r.totalDebtService.toFixed(2)}</title></rect>${i%Math.max(1,Math.ceil(rows.length/6))?'':`<text x="${x+bw/2}" y="${H-6}" text-anchor="middle">${esc(mon(r.month))}</text>`}`;}).join('')}</svg>`;
}

/** A source-history chart. Null observations remain gaps, never zero. */
export function sourceTrendChart(rows, series, { height=210, labelKey='month', bars=false, ariaLabel='Reported monthly source values' }={}) {
  const points=rows||[],values=points.flatMap(r=>series.map(s=>r[s.key]).filter(Number.isFinite));
  if(!points.length||!values.length)return '<div class="uw-empty" style="min-height:180px;padding:25px"><strong>No comparable monthly observations</strong>The source details show what is available. No monthly values were inferred.</div>';
  const W=760,H=height,L=56,R=18,T=18,B=30;
  let low=Math.min(0,...values),high=Math.max(0,...values);const range=high-low||1;high+=range*.15;low-=low<0?range*.05:0;
  const x=i=>L+(i+.5)*(W-L-R)/points.length,y=v=>T+(high-v)*(H-T-B)/(high-low);
  let grid='';for(let i=0;i<4;i++){const v=low+(high-low)*i/3;grid+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--bcn-border)" stroke-width=".6"/><text x="${L-9}" y="${y(v)+3}" text-anchor="end">${esc(compact(v))}</text>`;}
  const plot=series.map((s,si)=>{
    if(bars){const width=Math.min(23,(W-L-R)/points.length/(series.length+1));return points.map((r,i)=>Number.isFinite(r[s.key])?`<rect x="${x(i)+(si-(series.length-1)/2)*width-width*.43}" y="${Math.min(y(0),y(r[s.key]))}" width="${width*.86}" height="${Math.abs(y(0)-y(r[s.key]))}" fill="${s.color}" rx="2"><title>${esc(r[labelKey])} · ${esc(s.label)}: ${esc(r[s.key])}</title></rect>`:'').join('');}
    let open=false;const path=points.map((r,i)=>{if(!Number.isFinite(r[s.key])){open=false;return '';}const p=`${open?'L':'M'}${x(i)},${y(r[s.key])}`;open=true;return p;}).join(' ');
    return `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2.5" ${s.dashed?'stroke-dasharray="5 4"':''}/>`+points.map((r,i)=>Number.isFinite(r[s.key])?`<circle cx="${x(i)}" cy="${y(r[s.key])}" r="2.6" fill="${s.color}"><title>${esc(r[labelKey])} · ${esc(s.label)}: ${esc(r[s.key])}</title></circle>`:'').join('');
  }).join('');
  const labels=points.map((r,i)=>points.length>12&&i%2?'':`<text x="${x(i)}" y="${H-8}" text-anchor="middle">${esc(/^\d{4}-\d{2}/.test(r[labelKey]||'')?mon(r[labelKey].slice(0,7)):r[labelKey]||'Unknown')}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">${grid}${plot}${labels}</svg>`;
}
