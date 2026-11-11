// Company journey snapshot — one featured path, obvious labels, path picker.
import {platformMark} from './silo-attribution-visuals.js';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const role=(path,i)=>i===0?'First visit':i===path.length-1?'Last click':'In between';

export function renderPathSpotlight(paths,{money,days,multiPct,orderTotal}){
  if(!paths.length)return '';
  const picks=paths.slice(0,5).map((p,i)=>`<button type="button" class="attr-spotlight-pick${i===0?' is-active':''}" data-path="${i}" aria-pressed="${i===0}"><span class="attr-spotlight-pick-flow">${p.path.map(c=>platformMark(c)).join('<span class="attr-spotlight-pick-dot">›</span>')}<span class="attr-spotlight-pick-dot">›</span>${platformMark('Shopify')}</span><span class="attr-spotlight-pick-meta">${p.count.toLocaleString()} · ${esc(money(p.net_cents))}</span></button>`).join('');
  return `<section class="bcn-card attr-path-spotlight" aria-labelledby="attr-spotlight-title">
    <div class="bcn-card-header attr-spotlight-header"><div><span class="attr-eyebrow">COMPANY JOURNEY</span><h2 id="attr-spotlight-title">How customers reached purchase</h2><p class="attr-context">Observed visit order before each sale — not a channel’s total credit.</p></div>
    <div class="attr-spotlight-chips"><span class="attr-spotlight-chip attr-spotlight-chip--accent"><strong>${multiPct}%</strong><span>multi-channel</span></span><span class="attr-spotlight-chip"><strong>${orderTotal.toLocaleString()}</strong><span>orders</span></span></div></div>
    <div class="bcn-card-body attr-spotlight-body">
      <div class="attr-spotlight-stage" data-path="0"></div>
      <div class="attr-spotlight-picker" role="tablist" aria-label="Journey patterns">${picks}</div>
    </div></section>`;
}

export function spotlightStage(p,index,money,days,duration){
  const steps=p.path.map((c,j)=>`<li class="attr-spotlight-step"><button type="button" class="attr-spotlight-step-btn" data-channel="${esc(c)}" data-role="${j===0?'started':j===p.path.length-1?'credited':'any'}"><span class="attr-spotlight-step-role">${esc(role(p.path,j))}</span>${platformMark(c)}<strong>${esc(c)}</strong><small>${esc(duration(p.steps[j].medianMs))} until ${j===p.path.length-1?'purchase':'next step'}</small></button></li>`).join('');
  return `<div class="attr-spotlight-meta"><span class="attr-spotlight-rank">Pattern ${index+1}</span><p><strong>${p.count.toLocaleString()} order${p.count===1?'':'s'}</strong> · ${esc(money(p.net_cents))} sales · about ${esc(days(p.medianMs))} first visit to purchase</p></div>
    <ol class="attr-spotlight-flow" aria-label="${esc(p.path.join(' then '))}">${steps}<li class="attr-spotlight-step attr-spotlight-step--buy"><span class="attr-spotlight-step-role">Purchase</span>${platformMark('Shopify')}<strong>Purchase</strong></li></ol>
    <div class="attr-spotlight-actions"><button type="button" class="bcn-btn bcn-btn--primary" data-spotlight-orders="${index}">See these orders</button><span class="attr-context">Click a channel to filter all journeys</span></div>`;
}

export function wirePathSpotlight(section,paths,ctx){
  if(!section||!paths.length)return;
  const stage=section.querySelector('.attr-spotlight-stage');
  const paint=i=>{const p=paths[i];if(!p)return;stage.dataset.path=String(i);stage.innerHTML=spotlightStage(p,i,ctx.money,ctx.days,ctx.duration);
    section.querySelectorAll('.attr-spotlight-pick').forEach(b=>{const on=Number(b.dataset.path)===i;b.classList.toggle('is-active',on);b.setAttribute('aria-pressed',on);});
  };
  paint(0);
  section.querySelectorAll('.attr-spotlight-pick').forEach(b=>b.addEventListener('click',()=>paint(Number(b.dataset.path))));
  section.addEventListener('click',e=>{
    const o=e.target.closest('[data-spotlight-orders]');if(o)ctx.onPath(Number(o.dataset.spotlightOrders));
  });
}
