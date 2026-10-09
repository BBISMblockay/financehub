// Private review tasks use the existing Task Manager. No platform mutations.
export function suggestions(report,analysis) {
  const out=[],top=analysis.paths[0];
  const gaps=analysis.total-analysis.eligible;
  if(gaps)out.push({key:'coverage',title:'Investigate journey coverage',observation:`${gaps} of ${analysis.total} orders with sales activity are excluded from timed comparisons.`,hypothesis:'Source gaps or pending evidence may change the visible paths.',next:'Inspect the exclusion reasons and supporting orders. Verify capture readiness and dates before proposing a bounded refresh; do not infer Direct from missing data.',orderIds:report.orders.filter(r=>!analysis.journeys.get(r.order_id)?.eligible).map(r=>r.order_id)});
  if(top)out.push({key:'path:'+top.key,title:'Review the most observed path',observation:`${top.path.join(' → ')} appears in ${top.count} of ${analysis.eligible} eligible observed journeys.`,hypothesis:'This sequence may be useful for a coordinated message test; observed association does not establish lift.',next:'Review the supporting journeys and campaign context. Propose a human-approved holdout test with an outcome and stop rule before changing messaging or budget.',orderIds:top.orderIds});
  const baseline=analysis.models.baseline,equal=analysis.models.equal;
  const changed=[...new Set([...baseline.keys(),...equal.keys()])].filter(c=>(baseline.get(c)?.net_cents||0)!==(equal.get(c)?.net_cents||0));
  if(changed.length)out.push({key:'model-sensitivity',title:'Review model sensitivity',observation:`${changed.length} channel allocations differ between last-non-direct and equal-share.`,hypothesis:'A conclusion based only on the closing touch may depend on the credit rule.',next:'Compare channel allocations and inspect multi-channel journeys. Record which conclusion changes under equal-share and time-decay; use this as a sensitivity check, not causal evidence.',orderIds:report.orders.filter(r=>analysis.journeys.get(r.order_id)?.eligible).map(r=>r.order_id)});
  return out.slice(0,3);
}
export async function draftId(context,key) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['silo-attribution-review-v1',context.companyId,context.connectionId,context.start,context.end,context.windowDays,context.userId,key])));
  const a=new Uint8Array(bytes).slice(0,16);a[6]=(a[6]&15)|80;a[8]=(a[8]&63)|128;
  const h=[...a].map(n=>n.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export async function saveReviewTask({db,context,suggestion,owner,reviewDate,checkCompany,assertCurrent=()=>{},now=new Date()}) {
  if(!owner?.id)throw Error('Select a company owner');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(reviewDate)||new Date(reviewDate+'T00:00:00Z').toISOString().slice(0,10)!==reviewDate||reviewDate<now.toISOString().slice(0,10))throw Error('Choose a valid review date today or later');
  await checkCompany();
  const member=await db.from('entity_memberships').select('user_id').eq('entity_id',context.companyId).eq('user_id',owner.id).maybeSingle();
  if(member.error)throw member.error;if(!member.data)throw Error('Owner is no longer a member of this company');
  const id=await draftId(context,suggestion.key);
  const read=()=>db.from('launch_tasks').select('id').eq('company_entity_id',context.companyId).eq('created_by',context.userId).eq('id',id).maybeSingle();
  const prior=await read();if(prior.error)throw prior.error;if(prior.data){await checkCompany();return {id,existing:true};}
  const link='/v2/silo-attribution.html?'+new URLSearchParams({store:context.connectionId,start:context.start,end:context.end,window:String(context.windowDays)});
  const payload={id,company_entity_id:context.companyId,created_by:context.userId,launch_id:null,is_private:true,status:'open',priority:'normal',task_type:'Attribution review',task_title:'Review draft: '+suggestion.title,assigned_to_user_id:owner.id,assigned_to_name:owner.name,due_date:reviewDate,notes:[
    'DRAFT FOR HUMAN REVIEW — no campaign or budget change approved.',
    `Sales activity: ${context.start} through ${context.end}; lookback: ${context.windowDays} days; store: ${context.connectionId}.`,
    'Observation: '+suggestion.observation,'Hypothesis (unproven): '+suggestion.hypothesis,'Proposed next step: '+suggestion.next,
    'Supporting order IDs: '+suggestion.orderIds.slice(0,50).join(', ')+(suggestion.orderIds.length>50?` (first 50 of ${suggestion.orderIds.length}; full set in report)`:''),
    'Report: '+link,`Review date: ${reviewDate}. Reopen the report to verify current evidence; this draft captures the observation at creation.`].join('\n\n')};
  await checkCompany();
  assertCurrent();
  const saved=await db.from('launch_tasks').insert(payload);
  if(saved.error){const recovered=await read();if(recovered.error||!recovered.data)throw saved.error;await checkCompany();return {id,existing:true};}
  await checkCompany();return {id,existing:false};
}
