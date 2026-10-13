// Presentation only: consumes reconciled results; never changes attribution.
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function platformMark(channel) {
  const key=/^Meta/.test(channel)?'meta':/^Redo/.test(channel)?'redo':/^Google Ads/.test(channel)?'google-ads':/^TikTok/.test(channel)?'tiktok':/^Shop/.test(channel)?'shopify':null;
  return key?`<svg class="attr-logo" aria-hidden="true"><use href="../assets/landing/integration-icons.svg#icon-${key}"></use></svg>`:'<span class="attr-fallback" aria-hidden="true">•</span>';
}
export function trendChart(report){
 const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:report.currency,maximumFractionDigits:0}).format(n/100);
 const daily=report.reconciliation,peak=[...daily].sort((a,b)=>Number(b.net_cents)-Number(a.net_cents))[0];
 const max=Math.max(0,...daily.map(d=>Number(d.net_cents))),min=Math.min(0,...daily.map(d=>Number(d.net_cents))),range=max-min||1;
 const coords=daily.map((d,i)=>({x:42+i*666/Math.max(1,daily.length-1),y:158-(Number(d.net_cents)-min)*130/range,day:d.day,net:Number(d.net_cents)}));
 return `<section class="attr-chart"><h3>Daily net sales</h3><p class="attr-context">Highest day: ${escape(peak?.day||'—')} · ${escape(money(Number(peak?.net_cents||0)))}</p><svg class="attr-trend" viewBox="0 0 740 200" role="img" aria-label="Daily Shopify net sales"><title>Daily net sales, including reversals. Values rounded for display.</title><line x1="42" x2="708" y1="${158+min*130/range}" y2="${158+min*130/range}" stroke="var(--bcn-border)"/><polyline points="${coords.map(p=>`${p.x},${p.y}`).join(' ')}" fill="none" stroke="var(--bcn-accent)" stroke-width="3" stroke-linejoin="round"/>${coords.map(p=>`<circle cx="${p.x}" cy="${p.y}" r="5" fill="var(--bcn-accent)" tabindex="0"><title>${escape(p.day)}: ${escape(money(p.net))} net sales</title></circle>`).join('')}<text x="42" y="185">${escape(daily[0]?.day||'')}</text><text x="708" y="185" text-anchor="end">${escape(daily.at(-1)?.day||'')}</text><text x="42" y="18">${escape(money(max))}</text><text x="708" y="18" text-anchor="end">Axis floor ${escape(money(min))}</text></svg></section>`;
}
