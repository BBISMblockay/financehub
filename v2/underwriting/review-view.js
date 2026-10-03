import { parseInputNumber } from './scenario-file.js';
import { buildReviewSnapshot, compareReviewSnapshots } from './review-snapshot.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const finite=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const token=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(v)?v:null;
export function snapshotForReview({state,definitions,number,createdAt}) {
  // Currency belongs to each monetary fact, not just the scenario selection.
  // Facility and commitment currencies can differ or remain unknown; never
  // replace either with the scenario currency when comparing review baselines.
  const moneyContext=currency=>({unit:'currency',currency:currency||null});
  const scenarioMoney=moneyContext(state.values.currency);
  const monetaryIds=new Set(['amount','upfrontFees','useOfProceeds','startingCash','cashFloor','normalizedCash','existingPayment','baselineWorkingCapital','revenue']);
  const units={rate:'percent',term:'months',amortizationMonths:'months',coverageTarget:'ratio',forecastMonths:'months',growthPct:'percent',growthSpread:'months',revenueDecline:'percent',grossMargin:'percent',marginCompression:'percentage-points',creditScore:'score'};
  const assumptions=definitions.filter(d=>['number','select','checkbox','month','date'].includes(d[2])).map(([id,label,type])=>({id,label,value:type==='number'?number(state.values[id]):type==='checkbox'?state.values[id]===true:token(state.values[id]),...(type==='number'?(monetaryIds.has(id)?scenarioMoney:units[id]?{unit:units[id]}:{}):{})}));
  const add=(prefix,row,omit=[],contexts={})=>{for(const [key,value]of Object.entries(row||{}))if(!omit.includes(key)&&(['number','boolean','string'].includes(typeof value)||value===null)){const safe=typeof value==='string'?token(value):value;if(typeof value==='string'&&!safe)continue;assumptions.push({id:`${prefix}:${key}`,value:safe,...(contexts[key]||{})});}};
  for(const [month,row]of Object.entries(state.overrides))for(const [key,value]of Object.entries(row))assumptions.push({id:`override:${month}:${key}`,value:number(value),...scenarioMoney});
  for(const f of state.facilities){
    const facilityMoney=moneyContext(f.currency);
    const contexts=Object.fromEntries(['manualBalance','limit','borrowingBase','reserves','lenderAvailable','monthlyPayment'].map(key=>[key,facilityMoney]));
    add('facility:'+f.id,f,['name','balanceProvenance','availabilityProvenance','scheduleProvenance','monthlyPayments','terms'],contexts);
    add('terms:'+f.id,f.terms,[],{annualRatePct:{unit:'percent'},amortizationMonths:{unit:'months'}});
    for(const [month,value]of Object.entries(f.monthlyPayments))assumptions.push({id:`payment:${f.id}:${month}`,value,...facilityMoney});
  }
  for(const item of state.commitments)add('commitment:'+item.id,item,['sourceReference'],{amount:moneyContext(item.currency)});
  if(state.cashTiming){for(const key of ['collections','inventory'])add('timing:'+key,state.cashTiming[key],['sourceReference'],{amount:scenarioMoney,baselineReceipts:scenarioMoney});assumptions.push({id:'timing:distinct',value:state.cashTiming.distinctReceiptPoolsReviewed===true});}
  // IDs are semantic and scoped by source. Never use array positions or
  // display labels as persisted identity: insertion/reordering must not compare
  // different measures. Explicit adapter IDs take precedence; unknown metrics
  // are deliberately outside this selected-facts review snapshot.
  const metricIds={
    balanceSheet:{'Total assets':'total-assets','Total liabilities':'total-liabilities','Total equity':'total-equity','Book bank balances':'book-bank-balances'},
    profitAndLoss:{'Income':'income','Gross profit':'gross-profit','Net operating income':'net-operating-income','Net income':'net-income'},
    cashflow:{'Monthly periods in saved report':'monthly-periods','Complete calendar months':'complete-calendar-months'},
    bank:{'Depository accounts loaded':'depository-account-count','Pending transactions (not subtracted)':'pending-transaction-count'},
    inventory:{'Snapshot rows':'snapshot-row-count','Reported on-hand units':'on-hand-units','Rows missing quantity':'missing-quantity-count','Rows missing inventory value':'missing-value-count','Rows with zero inventory value':'zero-value-count'},
    purchaseOrders:{'Visible POs (all statuses)':'visible-po-count','PO lines':'line-count','Lines missing cost':'missing-cost-count','Lines with zero cost':'zero-cost-count','Lines with negative cost':'negative-cost-count','POs without lines':'empty-po-count','POs missing arrival dates':'undated-arrival-count'},
    revenuePlan:{'Months with saved revenue plan':'planned-month-count','Months with recorded actuals':'actual-month-count'},
  };
  const sources=Object.entries(state.sources?.sources||{}).filter(([key])=>key!=='accounts').map(([id,s])=>({
    id,status:['available','partial','missing','error'].includes(s.status)?s.status:'unknown',asOf:s.asOf||null,
    fetchedAt:s.fetchedAt||null,periodStart:s.periodStart||null,periodEnd:s.periodEnd||null,basis:s.basis||null,
    currency:s.currency||null,reportId:token(s.reportId),truncated:s.truncated===true,
    metrics:['available','partial'].includes(s.status)?(s.metrics||[]).flatMap(m=>{
      const metricId=token(m.id)||metricIds[id]?.[m.label];
      return metricId?[{id:metricId,label:m.label,value:finite(m.value),unit:m.unit||null,currency:m.currency||s.currency||null,
        periodStart:m.periodStart||s.periodStart||null,periodEnd:m.periodEnd||s.periodEnd||null}]:[];
    }):[],
  }));
  const start=state.values.startMonth,n=number(state.values.forecastMonths);
  const periodStart=/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(start)?start:null;
  const periodEnd=periodStart&&Number.isInteger(n)&&n>=1&&n<=121?new Date(Date.UTC(Number(start.slice(0,4)),Number(start.slice(5))-1+n-1,1)).toISOString().slice(0,7):null;
  const outcomes=[['minimumPrincipal',state.capacity?.minimumPositivePrincipal],['maximumPrincipal',state.capacity?.maximumAdditionalPrincipal],['rawCashGap',state.capacity?.rawCashGap],['minimumCashBuffer',state.result?.summary?.minCashBuffer],['lowestMonthlyDscr',state.result?.summary?.worstMonthlyDscr],['existingDebtService',state.result?.summary?.totalExistingDebtService],['availableCredit',state.portfolio?.totalAvailable]].map(([id,value])=>({id,value:finite(value),unit:id==='lowestMonthlyDscr'?'ratio':'currency',currency:id==='lowestMonthlyDscr'?null:state.values.currency||null,periodStart,periodEnd}));
  return buildReviewSnapshot({companyId:state.context.company.id,createdAt,assumptions,sources,outcomes});
}
export function reviewChangesHtml(current,baseline,money) {
  const changes=compareReviewSnapshots(current,baseline);
  if(changes.status!=='comparable')return `<p class="uw-review-empty">${esc(changes.reason)}. Capture a baseline after reviewing the inputs, or open a scenario that contains one.</p>`;
  const all=[...changes.assumptionChanges,...changes.sourceValueChanges,...changes.outcomeChanges];
  return `<div class="uw-review-summary"><strong>${changes.counts.total?changes.counts.total+' changes to review':'No selected numeric or configuration changes'}</strong><span>Since ${esc(changes.baselineCreatedAt)}</span></div>${changes.sourceChanges.length?`<p class="uw-fine">${changes.sourceChanges.length} source coverage / as-of changes. Different periods or currencies are not presented as like-for-like numeric deltas.</p>`:''}<details class="uw-disclosure"><summary>Inspect changed inputs and results <span>${all.length} selected facts</span></summary><div class="uw-table-wrap"><table class="uw-table"><thead><tr><th>Selected fact</th><th>Prior</th><th>Current</th><th>Comparable change</th></tr></thead><tbody>${all.map(x=>`<tr><td>${esc(x.label||x.id)}</td><td>${esc(x.before??'Unknown')}</td><td>${esc(x.after??'Unknown')}</td><td>${x.delta===null||x.delta===undefined?esc(x.reason||x.kind):esc(x.delta)}</td></tr>`).join('')}</tbody></table></div>${changes.sourceChanges.map(x=>`<p class="uw-fine">${esc(x.label||x.id)}: ${esc(x.kind)} · ${esc(x.before?.asOf||'unknown')} → ${esc(x.after?.asOf||'unknown')}</p>`).join('')}</details>`;
}
export function proposalMemoHtml({state,model,valid,money,exactMoney,ratio}) {
  const v=state.values,s=state.result?.summary||{},cap=state.capacity||{},p=state.portfolio||{};
  const amount=Number(v.amount),proposed=Number.isFinite(amount)&&amount>0,within=cap.status==='feasible'&&cap.verification?.interval===true&&amount>=cap.minimumPositivePrincipal&&amount<=cap.maximumAdditionalPrincipal;
  const qualified=valid&&within&&cap.scope==='full-term'&&!cap.preFundingShortfall&&s.minCashBuffer>=0;
  const sourceGaps=Object.entries(state.sources?.sources||{}).filter(([key,x])=>key!=='accounts'&&x.status!=='available').map(([key,x])=>`${({inventory:'Inventory valuation',purchaseOrders:'Purchase-order costs',revenuePlan:'Sales plan',balanceSheet:'Balance sheet',profitAndLoss:'P&L',cashflow:'Cash flow',bank:'Bank balances'})[key]||key}: ${x.status||'missing'} coverage`);
  const risks=[];
  if(!valid)risks.push('Cash or debt evidence is incomplete. Repayment capacity and the cash-floor conclusion need resolution before this proposal can be relied on.');
  if(cap.preFundingShortfall)risks.push(`Funding arrives after a ${money(cap.preFundingShortfall.amount)} shortfall in ${cap.preFundingShortfall.month}. Resolve timing before using the proposed structure.`);
  if(cap.scope==='window-only'&&!cap.preFundingShortfall)risks.push(`Final maturity ${cap.maturityMonth||'unknown'} is outside the cash forecast. Full-term affordability is unassessed.`);
  if(proposed&&!within)risks.push('The entered amount is outside the certified interval, or no interval has been established.');
  if(valid&&s.minCashBuffer<0)risks.push(`The cash floor is breached in ${s.minCashBufferMonth} by ${money(-s.minCashBuffer)}.`);
  if(state.cashTimingResult?.recoveryBeyondHorizon>0)risks.push(`${money(state.cashTimingResult.recoveryBeyondHorizon)} of delayed receipts remain outside this forecast.`);
  if(!p.availabilityComplete)risks.push('Existing credit access is not fully evidenced; undrawn credit has not been counted as cash.');
  if(sourceGaps.length)risks.push(sourceGaps.join('; ')+'.');
  const conditions=[...(cap.errors||[]),...(state.cashTimingResult?.issues||[]),...(p.errors||[])];
  if(!v.cashEvidence.trim())conditions.push('Reconcile opening unrestricted cash to an as-of bank or cash report.');
  if(!model.existingDebt.complete)conditions.push('Complete every existing payment, maturity and balloon, then confirm the selected debt-service source.');
  if(!v.commitmentsComplete)conditions.push('Review PO deposits and remaining payments, with cash timing included once.');
  if(Number.isFinite(p.totalAvailable)&&p.totalAvailable>0)conditions.push(`Assess ${money(p.totalAvailable)} existing undrawn access against separately scheduled draws and repayments before choosing new financing.`);
  conditions.push('Confirm quoted terms, fees, current drawable availability and lender-specific covenant definitions.');
  const list=items=>`<ul>${[...new Set(items)].map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`;
  const rate=esc(v.rate||'—'),term=esc(v.term||'—');
  return `<div class="uw-memo-lead"><div><span class="uw-eyebrow">REQUEST FOR HUMAN UNDERWRITER REVIEW</span><h3>${proposed?money(amount):'Amount not entered'} · ${term} months</h3><p>${rate}% nominal annual rate · ${esc(v.frequency)} · ${esc(v.repayment)}${v.upfrontFees!==''?` · ${money(Number(v.upfrontFees))} upfront fees`:''}</p></div><span class="uw-tag ${qualified?'uw-tag-ok':''}">${qualified?'Within modeled constraints':valid&&within&&cap.scope==='window-only'&&!cap.preFundingShortfall?'Window-only · maturity unassessed':'Evidence / structure needs review'}</span></div><p class="uw-memo-purpose">${esc(v.purpose||'Funding purpose has not been documented.')}</p><div class="uw-memo-metrics"><div><span>Cash need before financing</span><strong>${money(cap.rawCashGap)}</strong><small>${esc(cap.rawCashGapMonth||'Not established')}</small></div><div><span>Conservative interval</span><strong>${cap.status==='feasible'&&cap.verification?.interval?exactMoney(cap.minimumPositivePrincipal)+' – '+exactMoney(cap.maximumAdditionalPrincipal):'Unassessed / no overlap'}</strong><small>${cap.scope==='full-term'?'Through final proposed payment':'Window only / unassessed'}</small></div><div><span>Lowest monthly DSCR</span><strong>${valid?ratio(s.worstMonthlyDscr):'Unassessed'}</strong><small>Selected target ${esc(v.coverageTarget||'—')}×</small></div><div><span>Minimum cash above floor</span><strong>${valid?money(s.minCashBuffer):'Unassessed'}</strong><small>${esc(s.minCashBufferMonth||'Not established')}</small></div></div><div class="uw-memo-sections"><section><h4>Repayment basis & binding constraint</h4><p>${money(parseInputNumber(v.normalizedCash))} baseline monthly cash before debt, with reviewed monthly overrides. Existing P&I uses ${v.existingDebtMode==='facilities'?'the facility schedules':'the manual aggregate'} once.</p><p>${cap.limitingCapacity?esc(cap.limitingCapacity.month+': '+cap.limitingCapacity.reason)+'.':'A repayment ceiling has not been established.'}${cap.limitingNeed?' Cash need binds at '+esc(cap.limitingNeed.month)+'.':''}</p>${state.cashTimingResult?.enabled&&state.cashTimingResult.ready?`<p>Receipt timing tested: ${state.cashTimingResult.transfers.map(t=>`${money(t.amount)} from ${esc(t.fromMonth)} to ${esc(t.toMonth)}`).join('; ')}.</p>`:''}${Number(v.revenueDecline)||Number(v.marginCompression)?`<p>Gross-contribution downside: sales −${esc(v.revenueDecline)}%, margin −${esc(v.marginCompression)} points. No automatic expense offset.</p>`:''}</section><section><h4>Material risks</h4>${list(risks.length?risks.slice(0,5):['The result depends on the entered cash forecast, payment completeness and selected monthly coverage target. It is not a lender covenant test.'])}</section><section><h4>Conditions to resolve</h4>${list(conditions.slice(0,5))}</section><section><h4>Decision requested</h4><p>Review the amount, structure, repayment evidence and conditions. Record the approver’s own decision outside this scenario; no credit approval, commitment or lender offer is recorded here.</p></section></div><div class="uw-memo-signoff">Draft analyst proposal · ${esc(state.context.company.title||'Current company')} · ${esc(v.startMonth)} forecast · Illustrative assumptions require human review</div>`;
}

export function printEvidenceHtml(state,money) {
  const pairs=rows=>`<dl>${rows.map(([label,value])=>`<dt>${esc(label)}</dt><dd>${esc(value===null||value===undefined||value===''?'Not documented':String(value))}</dd>`).join('')}</dl>`;
  const facilities=state.facilities.map(f=>{
    const r=state.portfolio?.facilities?.find(x=>x.id===f.id);
    const localMoney=value=>Number.isFinite(value)?new Intl.NumberFormat('en-US',{...(/^[A-Z]{3}$/.test(f.currency)?{style:'currency',currency:f.currency}:{style:'decimal'}),maximumFractionDigits:2}).format(value)+(!/^[A-Z]{3}$/.test(f.currency)?' · currency unknown':''):'Unknown';
    const rows=[['Facility type',({loc:'Credit line',loan:'Term loan'})[f.kind]||'Not documented'],['Stable scenario ID',f.id],['Balance evidence',({account:'Read-only linked QBO account',manual:'Documented manual lender balance'})[f.balanceSource]||'Not documented'],['Matched account ID',f.balanceSource==='account'?f.accountId:'Not matched'],['Outstanding balance',r?.comparable?money(r.balance):'Unknown or currency mismatch'],['Balance as of',r?.balanceAsOf],['Facility currency',f.currency],['Balance reference',r?.balanceProvenance||f.balanceProvenance]];
    if(f.kind==='loc')rows.push(['Committed limit · entered',localMoney(f.limit)],['Borrowing base · entered',localMoney(f.borrowingBase)],['Reserves / restrictions · entered',localMoney(f.reserves)],['Lender net availability · entered',localMoney(f.lenderAvailable)],['Usable undrawn · calculated',money(r?.availability)],['Availability evidence date',f.availabilityAsOf],['Availability reference',f.availabilityProvenance]);
    rows.push(['Payment method',({terms:'Calculated remaining loan terms',payments:'Documented monthly P&I'})[f.scheduleMode]||'Not documented'],['Payment schedule reviewed',f.scheduleComplete?'Yes':'No'],['Payment evidence and assumptions',f.scheduleProvenance]);
    if(f.scheduleMode==='terms')rows.push(['Nominal annual rate',f.terms.annualRatePct===null?'Unknown':f.terms.annualRatePct+'%'],['Payment frequency',f.terms.frequency],['Repayment structure',f.terms.repayment],['First payment month',f.terms.firstPaymentMonth],['Final payment month',f.terms.maturityMonth],...(f.terms.repayment==='balloon'?[['Remaining amortization months',f.terms.amortizationMonths]]:[]));
    else if(f.scheduleMode==='payments')rows.push(['Baseline monthly P&I',localMoney(f.monthlyPayment)],['Amortization status','Total P&I alone does not establish a remaining principal balance. Monthly exceptions appear in the facility schedule.']);
    return `<h4>${esc(f.name||'Unnamed facility')}</h4>${pairs(rows)}`;
  }).join('');
  const timing=['collections','inventory'].filter(key=>state.cashTiming[key].enabled).map(key=>{const r=state.cashTiming[key];return `<h4>${key==='collections'?'Slower customer collections':'Delayed inventory cash recovery'}</h4>${pairs([['Receipt pool already in forecast',money(r.baselineReceipts)],['Amount delayed',money(r.amount)],['Original receipt month',r.fromMonth],['Recovery month',r.toMonth],['Evidence / assumption',r.sourceReference],['Baseline inclusion and loss-overlap reviewed',r.reviewed?'Yes':'No']])}`;}).join('')||'<p>No receipt delays selected.</p>';
  return {facilities,timing:timing+(state.cashTiming.collections.enabled&&state.cashTiming.inventory.enabled?pairs([['Receipt pools reviewed as distinct',state.cashTiming.distinctReceiptPoolsReviewed?'Yes':'No']]):'')};
}
