import { buildDebtSchedule, calculateFacilityAvailability, computeScenario } from './scenario-model.js';
import { loadSourceSnapshot } from './source-data.js';
import { readContext, createLoadGuard } from './context.js';
import { cashChart, debtChart, sourceTrendChart } from './charts.js';
import { businessView } from './business-view.js';
import { assessFundingCapacity } from './capacity-model.js';
import { assessFacilityPortfolio } from './facility-model.js';
import { applyCashTimingStress, emptyCashTimingAssumptions } from './cash-timing.js';
import { cashTimingEditorHtml, cashTimingImpactHtml } from './timing-view.js';
import { snapshotForReview, reviewChangesHtml, proposalMemoHtml, printEvidenceHtml } from './review-view.js';
import { createFacility, facilityRegisterHtml, facilityEditorHtml } from './facility-view.js';
import { parseInputNumber as number, validateScenarioDocument } from './scenario-file.js';
import { quickLook, draftQuickDebts, quickFactsHtml, quickResultHtml, quickVerdictHtml, quickDebtsHtml, quickPrintHtml } from './quick-look.js';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const monthAdd = (month,n) => { const [y,m] = month.split('-').map(Number); return new Date(Date.UTC(y,m-1+n,1)).toISOString().slice(0,7); };
const initialMonth = new Date().toISOString().slice(0,7);
const state = { context:null, held:false, mode:'quick', quick:{debts:[]}, sources:null, values:{}, overrides:{}, commitments:[], facilities:[], portfolio:null, reviewBaseline:null, cashTiming:emptyCashTimingAssumptions(), cashTimingResult:null, step:'business', result:null, preset:'base', currency:null, ready:false };
const guard = createLoadGuard();
let db, mounted = false, validationPromise = null, printing = false;
const definitions = {
  proposalFields: [
    ['amount','Loan amount','number','','uw-span-all uw-amount'],
    ['rate','Annual interest %','number',''],['term','Term · months','number',''],
    ['repayment','Repayment','select','amortizing','uw-span-all',[['amortizing','Amortizing'],['interest-only','Interest-only + balloon'],['balloon','Amortizing + balloon']]],
    ['frequency','Payment frequency','select','monthly','',[['monthly','Monthly'],['quarterly','Quarterly'],['annual','Annual']]],
    ['upfrontFees','Upfront financing fees','number','','',null,'Fixed fee paid at funding. Enter 0 explicitly if none.'],
    ['amortizationMonths','Amortization · months (required)','number','','uw-span-all',null,'Only for amortizing + balloon; longer than the loan term.'],
    ['useOfProceeds','One-time plan cash use','number','','uw-span-all',null,'Paid in funding month, separate from fees and planned PO payments. Enter 0 if none.'],
    ['termsProvenance','Terms source / illustrative assumptions','text','','uw-span-all',null,'Identify the lender quote or state that these are your illustrative terms.'],
  ],
  capacityCoreFields: [
    ['startingCash','Opening unrestricted cash','number',''],
    ['cashFloor','Retained cash floor','number',''],
    ['normalizedCash','Monthly cash before debt','number',''],
    ['existingPayment','Existing monthly P&I','number',''],
    ['coverageTarget','Monthly DSCR target · illustrative','number','1.25'],
    ['forecastMonths','Forecast months · including funding','number','12', '',null,'1–121 months. A 36-month loan needs 37 to include its final payment.'],
    ['startMonth','Funding / forecast starts','month',initialMonth],
    ['currency','Scenario currency','select','','',[['','Choose currency'],['USD','USD'],['CAD','CAD'],['EUR','EUR'],['GBP','GBP']]],
  ],
  capacityReviewFields: [
    ['debtComplete','I have included every existing required payment, balloon and maturity in this horizon','checkbox',false,'uw-wide'],
    ['cashForecastReviewed','My normalized cash assumptions and monthly overrides cover the full selected forecast horizon','checkbox',false],
  ],
  baselineFields: [
    ['cashProvenance','Cash baseline · source & normalization','text','','uw-wide',null,'Explain the forecast period, ordinary working capital, seasonality, interest add-back and excluded financing / sweeps.'],
    ['debtProvenance','Existing payments · source & as of','text','','uw-wide',null,'Lender statements / contracts and the schedule date. Debt balances are not payments.'],
    ['cashEvidence','Opening cash · source & as of','text','','uw-wide'],
  ],
  stressFields: [
    ['growthPct','Growth in working-capital need %','number','0'],
    ['baselineWorkingCapital','Baseline inventory + operating WC','number',''],
    ['growthSpread','Fund growth over · months','number','3'],
    ['wcProvenance','Working capital · source','text',''],
    ['revenue','Monthly cash revenue baseline','number',''],
    ['revenueDecline','Revenue decline %','number','0'],
    ['grossMargin','Gross margin %','number',''],
    ['marginCompression','Margin compression · points','number','0'],
  ],
  debtSourceFields: [
    ['existingDebtMode','Existing debt service used in capacity','select','manual','',[['manual','Manual aggregate schedule'],['facilities','Sum of facility schedules']]],
  ],
  facilityReviewFields: [
    ['facilitiesComplete','This register covers all existing loans and credit lines in the selected horizon','checkbox',false,'uw-wide'],
    ['facilitiesProvenance','Portfolio review · evidence & as of','text','','uw-wide'],
  ],
  commitmentFields: [
    ['commitmentsComplete','I reviewed the full horizon: planned PO / inventory payments are represented once, including deposits already paid, or no additional commitments apply','checkbox',false,'uw-wide'],
  ],
  intakeFields: [
    ['scenarioName','Scenario name','text',''],['purpose','Use of funds / purpose','text',''],['clientReference','Client reference','text',''],
    ['documentReferences','Document references','textarea','','uw-wide',null,'Filenames or internal reference IDs only; no documents are sent or fetched.'],
    ['creditScore','Credit score · optional context','number','', '',null,'No eligibility, loan multiplier or pricing rule uses this field.'],
    ['lenderRules','Documented lender criteria / questions','textarea','','uw-wide'],
  ],
};
const allDefs = Object.values(definitions).flat();
function field([id,label,type,initial,classes='',options,hint]) {
  state.values[id] = initial;
  if(type==='checkbox')return `<label class="uw-checkbox ${classes}"><input id="${id}" type="checkbox" ${initial?'checked':''}>${esc(label)}</label>`;
  const control = type==='select' ? `<select id="${id}" class="bcn-field">${options.map(([value,text])=>`<option value="${value}" ${value===initial?'selected':''}>${esc(text)}</option>`).join('')}</select>` : type==='textarea' ? `<textarea id="${id}" class="bcn-field" rows="2" maxlength="2000"></textarea>` : `<input id="${id}" class="bcn-field" type="${type}" ${type==='number'?'step="any"':''} value="${esc(initial)}" ${type==='text'?'maxlength="1000"':''} placeholder="${type==='number'?'Not entered':'Add a reference'}">`;
  return `<div class="${classes}"><label class="uw-label" for="${id}">${esc(label)}</label>${control}${hint?`<small class="uw-field-hint">${esc(hint)}</small>`:''}</div>`;
}
function buildFields() {
  for(const [id,defs] of Object.entries(definitions))$(id).innerHTML=defs.map(field).join('');
  $('amortizationMonths').closest('div').hidden=true;
  $('capacityCoreFields').insertAdjacentHTML?.('beforeend','<div id="activeFacilityPI" class="uw-readonly-field" hidden></div>');
}
function money(value, compact=false) {
  if(!Number.isFinite(value))return '—';
  const currency=state.values.currency;
  return new Intl.NumberFormat('en-US',{...(currency?{style:'currency',currency}:{style:'decimal'}),notation:compact?'compact':'standard',maximumFractionDigits:compact?1:0}).format(value);
}
function exactMoney(value) {return Number.isFinite(value)?new Intl.NumberFormat('en-US',{...(state.values.currency?{style:'currency',currency:state.values.currency}:{style:'decimal'}),minimumFractionDigits:2,maximumFractionDigits:2}).format(value):'—';}
function ratio(value) { return Number.isFinite(value)?`${value.toFixed(2)}×`:'—'; }
function inputModel() {
  const v=state.values,start=v.startMonth,enteredHorizon=number(v.forecastMonths),horizon=Number.isInteger(enteredHorizon)&&enteredHorizon>=1&&enteredHorizon<=121?enteredHorizon:null;
  const monthlyOverrides=[]; const monthlyPayments={};
  if(/^\d{4}-(0[1-9]|1[0-2])$/.test(start)&&Number.isInteger(horizon)&&horizon>0&&horizon<=121)for(let i=0;i<horizon;i++) {
    const month=monthAdd(start,i),o=state.overrides[month]||{};
    if(number(o.payment)!==null)monthlyPayments[month]=number(o.payment);
    const use = number(o.otherCashUse);
    const row={month,provenanceByField:{}};
    if(number(o.preDebtCash)!==null){row.preDebtCash=number(o.preDebtCash);row.provenanceByField.preDebtCash=v.cashProvenance;}
    if(number(o.workingCapitalUse)!==null){row.workingCapitalUse=number(o.workingCapitalUse);row.provenanceByField.workingCapitalUse=v.wcProvenance;}
    if(use!==null || i===0){row.otherCashUse=(use??0)+(i===0?(number(v.useOfProceeds)??0):0);row.provenanceByField.otherCashUse=v.purpose||'User-entered cash use';}
    if(Object.keys(row).length>2)monthlyOverrides.push(row);
  }
  const manualDebt={monthlyPayment:number(v.existingPayment),monthlyPayments,complete:v.debtComplete===true,provenance:v.debtProvenance};
  state.portfolio=assessFacilityPortfolio({facilities:state.facilities,accountOptions:state.sources?.accountOptions||[],currency:v.currency,startMonth:start,horizonMonths:horizon,mode:v.existingDebtMode,complete:v.facilitiesComplete===true,provenance:v.facilitiesProvenance,manualDebt});
  const proposalEntered=String(v.amount??'').trim()!=='';
  // The UI balloon option is amortizing: a missing amortization must fail validation, not use the pure model's legacy interest-only fallback.
  const model={currency:v.currency,cashCommitments:{complete:v.commitmentsComplete===true,items:state.commitments},startMonth:start,horizonMonths:horizon,startingCash:number(v.startingCash),requiredCashFloor:number(v.cashFloor),normalizedPreDebtCash:{monthlyAmount:number(v.normalizedCash),provenance:v.cashProvenance},existingDebt:state.portfolio.existingDebt,proposal:proposalEntered?{upfrontFees:number(v.upfrontFees),principal:number(v.amount),annualRatePct:number(v.rate),termMonths:number(v.term),frequency:v.frequency,repayment:v.repayment,startMonth:start,...(v.repayment==='balloon'?{amortizationMonths:number(v.amortizationMonths)??NaN}:{})}:null,growth:{baselineWorkingCapital:number(v.baselineWorkingCapital),growthPct:number(v.growthPct),spreadMonths:number(v.growthSpread),provenance:v.wcProvenance},stress:{monthlyRevenue:number(v.revenue),revenueDeclinePct:number(v.revenueDecline),grossMarginPct:number(v.grossMargin),marginCompressionPct:number(v.marginCompression)},monthlyOverrides};
  state.cashTimingResult=applyCashTimingStress(model,state.cashTiming);
  if(state.cashTimingResult.ready)return state.cashTimingResult.model;
  // Enabled but incomplete timing assumptions cannot retain a prior cash conclusion.
  return {...model,normalizedPreDebtCash:{monthlyAmount:null,provenance:''},monthlyOverrides:model.monthlyOverrides.map(({preDebtCash,...row})=>row)};
}
function kpi(label,value,note,tone='') {return `<div><div class="uw-kpi-label">${esc(label)}</div><div class="uw-kpi-value ${tone}">${esc(value)}</div><div class="uw-kpi-note">${esc(note)}</div></div>`;}
function render() {
  if(!state.ready)return;
  const model=inputModel();
  const result=computeScenario(model);
  const base=computeScenario({...model,proposal:null});
  const missingUses=number(state.values.useOfProceeds)===null || number(state.values.useOfProceeds)<0;
  const missingCashEvidence=!state.values.cashEvidence.trim();
  const missingCurrency=!state.values.currency;
  const uiIncomplete=missingUses||missingCashEvidence||missingCurrency;
  const valid=result.errors.length===0&&!uiIncomplete&&state.values.cashForecastReviewed===true&&result.coverage?.cashPathComplete&&result.coverage?.cashFloorKnown;
  const dscrValid=result.errors.length===0&&result.coverage?.dscrAvailable&&!missingCurrency;
  state.result=result;
  const s=result.summary||{};
  $('scenarioKpis').innerHTML = kpi('Lowest cash above floor',valid?money(s.minCashBuffer,true):'—',valid?s.minCashBufferMonth||'12-month modeled minimum':'Needs a complete cash baseline',s.minCashBuffer<0?'uw-negative':'')+kpi('Lowest monthly DSCR',dscrValid?ratio(s.worstMonthlyDscr):'—','Before growth and commitment cash uses',valid&&Number.isFinite(s.worstMonthlyDscr)&&s.worstMonthlyDscr<Number(state.values.coverageTarget)?'uw-negative':'')+kpi('New scheduled payment',money(result.proposalSchedule?.summary?.periodicPayment ?? result.proposalSchedule?.rows?.find(r=>r.payment>0)?.payment,true),`${state.values.frequency} · illustrative`);
  $('cashChart').innerHTML=cashChart(valid?result.rows:[],base.rows||[],model.requiredCashFloor);
  $('debtChart').innerHTML=debtChart(result.errors.length?[]:result.rows);
  $('chartPeriod').textContent=`${model.startMonth||'—'} → ${/^\d{4}-\d{2}$/.test(model.startMonth)?Number.isInteger(model.horizonMonths)&&model.horizonMonths>0?monthAdd(model.startMonth,model.horizonMonths-1):'—':'—'} · ${state.values.currency||'currency not selected'}`;
  const schedule=model.proposal?buildDebtSchedule(model.proposal):{rows:[],summary:{},errors:[]},sum=schedule.summary||{},payments=schedule.rows?.filter(r=>r.payment>0)||[];
  const standard=payments[0]?.payment;
  const feeLine=model.proposal?`<div class="uw-result-row"><span>Upfront fees / net proceeds</span><strong>${money(number(state.values.upfrontFees))} / ${money(number(state.values.amount)!==null&&number(state.values.upfrontFees)!==null?number(state.values.amount)-number(state.values.upfrontFees):null)}</strong></div>`:'';
  const inputErrors=result.errors.length?`<div class="bcn-status bcn-status--neg" role="status" aria-live="polite">${esc(result.errors.slice(0,2).join(' '))}${result.errors.length>2?` ${result.errors.length-2} more input error(s) in Calculation notes.`:''}</div>`:'';
  $('proposalResult').innerHTML=inputErrors+`<div class="uw-result-row uw-result-primary"><span>First scheduled payment</span><strong>${money(standard)}</strong></div><div class="uw-result-row"><span>Total loan interest</span><strong>${money(sum.totalInterest)}</strong></div><div class="uw-result-row"><span>Final payment / balloon</span><strong>${money(payments.at(-1)?.payment)}</strong></div><div class="uw-result-row"><span>Maturity month</span><strong>${esc(schedule.rows?.at(-1)?.month||'—')}</strong></div>${feeLine}`;
  renderCashInsights(result,base,valid);
  renderDebtSchedule(result,model,schedule,valid);
  renderCapacity(model);
  renderStructureComparison(model);
  const checks=[
    {ok:!!state.values.cashProvenance.trim()&&!missingCashEvidence&&number(state.values.normalizedCash)!==null,label:'Normalized cash is documented',note:'Financing, sweeps and debt service reviewed separately'},
    {ok:model.existingDebt.complete&&!!model.existingDebt.provenance?.trim(),label:'Existing payments cover the horizon',note:'Include every required payment and final balloon'},
    {ok:!missingUses&&number(state.values.growthPct)!==null&&(number(state.values.growthPct)===0||!!state.values.wcProvenance.trim()),label:'Cash uses are entered',note:'One-time uses and growth working capital stay separate'},
    {ok:result.coverage?.commitmentsComplete===true,label:'Commitment cash timing is reviewed',note:'Deposits and PO balances are included once, with explicit payment months'},
    {ok:!!state.sources&&Object.values(state.sources.sources).every(x=>x.status==='available'),label:'Source limitations remain visible',note:'Imported data is evidence, not lender-verified capacity'},
  ];
  $('evidenceCount').textContent=`${checks.filter(x=>x.ok).length} / ${checks.length}`;
  $('evidenceList').innerHTML=checks.map(c=>`<div class="uw-check"><span class="uw-check-icon ${c.ok?'ok':''}">${c.ok?'✓':'○'}</span><div><strong>${esc(c.label)}</strong><small>${esc(c.note)}</small></div></div>`).join('');
  const warnings=[...result.errors,...result.warnings,...(state.portfolio.errors||[]),...(state.portfolio.warnings||[]),...(state.cashTimingResult?.issues||[]),...(state.cashTimingResult?.warnings||[])];
  if(missingUses)warnings.unshift('Enter the one-time use of proceeds explicitly, including 0 when none.');
  if(missingCashEvidence)warnings.unshift('Document the opening cash source and as-of date.');
  if(missingCurrency)warnings.unshift('Choose the scenario currency; do not mix currencies.');
  $('methodology').innerHTML=`<ul>${[...new Set([...warnings,...(result.methodology||[]),...(state.cashTimingResult?.enabled?state.cashTimingResult.methodology:[]),'This is an illustrative pre-debt cash DSCR, not a lender-defined covenant or approval.','The selected forecast does not establish full-term capacity when the final payment is outside it. Full proposed debt payments must be covered by documented cash assumptions.','Unresolved cash classifications are not automatically included as repayment capacity. Net bank cash of zero may reflect LOC or ZBA sweeps, not operating breakeven.','No facility is automatically drawn, no accounting record is changed, and no scenario data is saved to a server.'])].map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`;
  $('amortizationMonths').closest('div').hidden=state.values.repayment!=='balloon';
  renderMonthlyEditor(result.rows||[]);
  renderFacility();
  renderCommitmentEditor();
  renderCashTiming();
  renderReview(model,valid);
  const commitmentIssues=result.cashCommitments?.issues||[];
  $('commitmentIssues').textContent=commitmentIssues.join(' ');
  $('commitmentIssues').hidden=commitmentIssues.length===0;
  renderQuick();
}
// ── Quick look ─────────────────────────────────────────────────────────
// Three typed inputs (shared with the advanced proposal fields, so the
// detailed workflow is pre-seeded), everything else from the loaded sources.
function quickInputs() { const v=state.values; return {amount:v.amount,rate:v.rate,term:v.term,purpose:v.purpose}; }
function currentQuickLook() {
  return quickLook({snapshot:state.sources,inputs:quickInputs(),debts:state.quick.debts,month:/^\d{4}-(0[1-9]|1[0-2])$/.test(state.values.startMonth)?state.values.startMonth:initialMonth});
}
function renderQuick(force=false) {
  const result=currentQuickLook();state.quickResult=result;
  for(const [id,key] of [['q-amount','amount'],['q-rate','rate'],['q-term','term'],['q-purpose','purpose']]){const el=$(id);if(el&&el!==document.activeElement)el.value=state.values[key]??'';}
  $('quickFacts').innerHTML=quickFactsHtml(result,money);
  $('quickResult').innerHTML=quickResultHtml(result,money);
  $('quickVerdict').innerHTML=quickVerdictHtml(result);
  if(force||!$('quickDebts').contains(document.activeElement))$('quickDebts').innerHTML=quickDebtsHtml(state.quick.debts,money);
}
function changeQuickInput(el) {
  const key=el.dataset.quick;if(!['amount','rate','term','purpose'].includes(key))return;
  state.values[key]=el.value;const mirror=$(key);if(mirror)mirror.value=el.value;
  render();
}
function changeQuickDebt(el) {
  const row=state.quick.debts.find(d=>d.id===el.dataset.quickDebt);if(!row)return;
  if(el.dataset.field==='include')row.include=el.checked;
  else if(el.dataset.field==='monthlyPayment')row.monthlyPayment=number(el.value);
  render();renderQuick(true);
}
// Opening cash is the one advanced input the books can answer directly. Seeded
// once per load, only when blank, with provenance that names the source and
// date; the review box stays unchecked because a person still has to agree.
function seedOpeningCash() {
  const cash=state.quickResult?.facts?.openingCash;
  if(!cash||!Number.isFinite(cash.value)||String(state.values.startingCash??'').trim()!=='')return;
  state.values.startingCash=String(cash.value);$('startingCash').value=state.values.startingCash;
  if(!String(state.values.cashEvidence??'').trim()){state.values.cashEvidence=`${cash.source} as of ${String(cash.asOf||'date unknown').slice(0,10)} (auto-filled from Quick look; confirm it is unrestricted)`;$('cashEvidence').value=state.values.cashEvidence;}
}
function setMode(mode) {
  if(!['quick','advanced'].includes(mode))return;state.mode=mode;
  $('step-quick').hidden=mode!=='quick';
  const flow=document.querySelector('.uw-flow');if(flow)flow.hidden=mode!=='advanced';
  if(mode==='advanced')setStep(state.step);else document.querySelectorAll('[data-step-panel]').forEach(el=>{el.hidden=true;});
  document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
  document.querySelector('.silo-main')?.scrollTo?.({top:0,behavior:'auto'});
}

function renderCashInsights(result,baseline,valid) {
  const s=result.summary||{},b=baseline.summary||{};
  const pinch=result.rows?.find(r=>r.month===s.minCashBufferMonth);
  const gap=Number.isFinite(b.minCashBuffer)?Math.max(0,-b.minCashBuffer):null;
  const peak=(result.rows||[]).filter(r=>Number.isFinite(r.totalDebtService)).sort((a,b)=>(b.totalDebtService+(b.workingCapitalUse||0)+(b.otherCashUse||0)+(b.commitmentCashUse||0)+(b.financingFees||0))-(a.totalDebtService+(a.workingCapitalUse||0)+(a.otherCashUse||0)+(a.commitmentCashUse||0)+(a.financingFees||0)))[0];
  const insight=(label,value,note)=>`<div class="uw-insight"><span class="uw-data-label">${esc(label)}</span><strong>${esc(value)}</strong><p>${esc(note)}</p></div>`;
  $('cashInsights').innerHTML=insight('Cash shortfall without new debt',valid?money(gap,true):'Review required',valid?`Amount below the cash floor at ${b.minCashBufferMonth}. Existing credit is not automatically drawn.`:'Complete normalized cash, existing debt and planned-payment review to identify the gap.')+insight('Lowest cash-buffer month',valid?s.minCashBufferMonth||'—':'—',valid?`${money(Math.abs(s.minCashBuffer))} ${s.minCashBuffer<0?'below':'above'} floor.${pinch?` ${money(pinch.preDebtCash,true)} normalized cash vs ${money(pinch.totalDebtService,true)} P&I in that month.`:' Opening cash is part of the test.'}`:'Missing commitments or payment terms keep cash conclusions unknown.')+insight('Peak monthly cash demand',valid&&peak?money(peak.totalDebtService+peak.workingCapitalUse+peak.otherCashUse+peak.commitmentCashUse+peak.financingFees,true):'—',valid&&peak?`${peak.month}: ${money(peak.totalDebtService,true)} P&I + ${money(peak.workingCapitalUse+peak.otherCashUse+peak.commitmentCashUse+peak.financingFees,true)} plan cash uses / fees.`:'Debt service, growth and incremental commitments are tracked separately.');
}
function scheduleRows(result,model,schedule) {
  if(result.rows?.length)return result.rows;
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(model.startMonth))return [];
  const proposalByMonth=new Map((schedule.rows||[]).map(r=>[r.month,r]));
  return Array.from({length:Number.isInteger(model.horizonMonths)&&model.horizonMonths>0&&model.horizonMonths<=121?model.horizonMonths:0},(_,i)=>{
    const month=monthAdd(model.startMonth,i),p=proposalByMonth.get(month),entered=model.existingDebt.monthlyPayments[month]??model.existingDebt.monthlyPayment;
    const existing=Number.isFinite(entered)&&entered>=0?entered:null,proposed=model.proposal?(schedule.errors?.length?null:p?.payment??0):0;
    return {month,existingDebtService:existing,proposedPrincipal:model.proposal?(schedule.errors?.length?null:p?.principal??0):0,proposedInterest:model.proposal?(schedule.errors?.length?null:p?.interest??0):0,proposedDebtService:proposed,totalDebtService:existing!==null&&proposed!==null?existing+proposed:null,preDebtCash:null,workingCapitalUse:null,otherCashUse:null,commitmentCashUse:null,closingCash:null,dscr:null};
  });
}
function renderDebtSchedule(result,model,schedule,cashValid) {
  const rows=scheduleRows(result,model,schedule),s=result.summary||{};
  $('debtChart').innerHTML=debtChart(rows);
  $('debtSummary').innerHTML=kpi(`Existing P&I · ${model.horizonMonths} months`,money(s.totalExistingDebtService,true),model.existingDebt.complete?(state.values.existingDebtMode==='facilities'?'Sum of reviewed facility schedules':'Manual aggregate schedule'):'Completeness not confirmed')+kpi(`Proposed P&I · ${model.horizonMonths} months`,money(s.totalProposedDebtService,true),model.proposal?'Calculated from proposal terms':'No proposal entered');
  const uses=r=>[r.workingCapitalUse,r.otherCashUse,r.commitmentCashUse,r.financingFees].every(Number.isFinite)?r.workingCapitalUse+r.otherCashUse+r.commitmentCashUse+r.financingFees:null;
  $('debtSchedule').innerHTML=`<table class="uw-table"><thead><tr><th>Month</th><th>Cash before debt</th><th>Existing P&I</th><th>New principal</th><th>New interest</th><th>Combined P&I</th><th>Plan cash uses + fees</th><th>Closing cash</th><th>DSCR</th></tr></thead><tbody>${rows.map(r=>`<tr class="${cashValid&&r.cashBuffer<0?'uw-row-pinch':''}"><td>${esc(r.month)}</td><td>${money(r.preDebtCash)}</td><td>${money(r.existingDebtService)}</td><td class="uw-proposed-col">${money(r.proposedPrincipal)}</td><td class="uw-proposed-col">${money(r.proposedInterest)}</td><td><strong>${money(r.totalDebtService)}</strong></td><td>${money(uses(r))}</td><td>${cashValid?money(r.closingCash):'—'}</td><td>${ratio(r.dscr)}</td></tr>`).join('')||'<tr><td colspan="9">Choose a valid funding month to show the payment horizon.</td></tr>'}</tbody></table>${!model.existingDebt.complete?'<p class="uw-data-warning">Existing payment completeness is unconfirmed. Enter documented monthly obligations, including balloons and maturities; balances alone do not establish P&I.</p>':''}${model.proposal&&!schedule.errors?.length?`<details class="uw-disclosure"><summary>Full proposed-loan amortization <span>${esc(schedule.summary?.maturityMonth||'')} maturity · includes final payment</span></summary>${renderFullSchedule(schedule)}</details>`:''}`;
}
function capacityTerms(repayment=state.values.repayment) {
  const v=state.values;
  return {annualRatePct:number(v.rate),termMonths:number(v.term),frequency:v.frequency,repayment,startMonth:v.startMonth,upfrontFees:number(v.upfrontFees),...(repayment==='balloon'?{amortizationMonths:number(v.amortizationMonths)??NaN}:{})};
}
function assessCurrentCapacity(model,terms=capacityTerms()) {
  return assessFundingCapacity({scenario:model,terms,coverageTarget:number(state.values.coverageTarget),forecastReviewed:state.values.cashForecastReviewed===true&&!!state.values.cashEvidence.trim()&&number(state.values.useOfProceeds)!==null&&number(state.values.useOfProceeds)>=0,termsProvenance:state.values.termsProvenance});
}
function capacityRange(cap) {
  if(cap.status==='incomplete')return 'Needs evidence';
  if(cap.status==='infeasible')return 'No overlap';
  if(cap.status==='unassessed')return 'Unassessed';
  if(!Number.isFinite(cap.maximumAdditionalPrincipal))return 'Unassessed';
  const positive=cap.minimumPositivePrincipal;
  if(cap.zeroFeasible&&cap.maximumAdditionalPrincipal===0&&cap.verification?.exact)return money(0);
  if(cap.verification?.interval!==true||cap.verification?.exact!==true)return 'Unassessed';
  if(Number.isFinite(positive)&&positive>0)return `≈ ${cap.zeroFeasible?'0 or ':''}${money(positive,true)} – ${money(cap.maximumAdditionalPrincipal,true)}`;
  if(Number.isFinite(cap.minimumAdditionalPrincipal))return `≈ ${money(cap.minimumAdditionalPrincipal,true)} – ${money(cap.maximumAdditionalPrincipal,true)}`;
  return 'Unassessed';
}
function renderCapacity(model) {
  const cap=assessCurrentCapacity(model);state.capacity=cap;
  const rows=(cap.monthlyHeadroom||[]).filter(r=>r.dscrApplicable&&Number.isFinite(r.availableForNewDebtService));
  const tightest=rows.slice().sort((a,b)=>a.availableForNewDebtService-b.availableForNewDebtService)[0];
  const boundaryMonth=rows.find(r=>r.month===cap.limitingCapacity?.month);
  const limit=boundaryMonth&&tightest&&boundaryMonth.availableForNewDebtService<=tightest.availableForNewDebtService+.01?boundaryMonth:tightest;
  const windowOnly=cap.scope==='window-only',target=number(state.values.coverageTarget);
  const hasTerms=Number.isInteger(number(state.values.term))&&number(state.values.term)>0&&number(state.values.term)<=1200;
  const maturity=cap.maturityMonth||(hasTerms&&/^\d{4}-(0[1-9]|1[0-2])$/.test(state.values.startMonth)?monthAdd(state.values.startMonth,number(state.values.term)):'unknown');
  const forecastEnd=Number.isInteger(model.horizonMonths)&&model.horizonMonths>0&&/^\d{4}-(0[1-9]|1[0-2])$/.test(model.startMonth)?monthAdd(model.startMonth,model.horizonMonths-1):null;
  const untestedMaturity=cap.maturityMonth&&forecastEnd&&cap.maturityMonth>forecastEnd;
  $('capacityScope').textContent=cap.status==='incomplete'?'Review inputs':cap.preFundingShortfall?'Pre-funding timing unresolved':windowOnly?`${model.horizonMonths}-month window only`:cap.scope==='full-term'?'Through final payment':'Review inputs';
  $('capacitySummary').innerHTML=kpi('Cash need before new financing',money(cap.rawCashGap,true),cap.rawCashGapMonth?`${cap.rawCashGapMonth} · excludes new loan payments and fees`:Number.isFinite(cap.rawCashGap)?'No pre-financing cash-floor shortfall':'Requires a complete cash plan')+kpi('Tightest incremental P&I room',money(limit?.availableForNewDebtService,true),limit?`${limit.month} · after existing obligations`:'Requires documented cash and debt',limit?.availableForNewDebtService<0?'uw-negative':'')+kpi(windowOnly?'Conservative window-only interval':'Conservative funding interval',capacityRange(cap),cap.status==='infeasible'?'Cash need and repayment constraints do not overlap':windowOnly?'Full-term capacity remains unassessed':'Subject to all stated cash and coverage inputs');
  const title=cap.status==='infeasible'?'These assumptions do not support an overlapping funding amount':cap.status==='incomplete'?'Complete the evidence before using a funding amount':cap.status==='unassessed'?'Capacity is not established by this forecast':windowOnly?'The range only applies inside the selected forecast':'A modeled funding interval is available for these assumptions';
  const points=[];
  const enteredPrincipal=number(state.values.amount);
  if(cap.status==='feasible'&&cap.verification?.interval===true&&Number.isFinite(enteredPrincipal)&&enteredPrincipal>0){
    const inside=enteredPrincipal>=cap.minimumPositivePrincipal&&enteredPrincipal<=cap.maximumAdditionalPrincipal;
    points.push(`Entered amount ${exactMoney(enteredPrincipal)} is ${inside?'inside':'outside'} this conservative ${windowOnly?'window-only':'full-forecast'} interval.${windowOnly?' Full-term capacity remains unassessed.':''}`);
  }
  if(untestedMaturity)points.push(`The ${state.values.term}-month loan matures in ${maturity}, beyond this ${model.horizonMonths}-month forecast. This is not full-term capacity; include that final payment and supported cash assumptions before relying on it.`);
  if(cap.preFundingShortfall)points.push(`${cap.preFundingShortfall.month}: ${exactMoney(cap.preFundingShortfall.amount)} is missing before the assumed funding date. This loan cannot repair an earlier shortfall; resolve funding timing separately.`);
  points.push(...(cap.reasons||[]).slice(0,2));
  if(limit&&Number.isFinite(target))points.push(`${limit.month}: ${money(limit.preDebtCash)} pre-debt cash ÷ ${target.toFixed(2)} target − ${money(limit.existingDebtService)} existing P&I = ${money(limit.availableForNewDebtService)} additional payment room.`);
  if(cap.limitingNeed)points.push(`Cash-floor constraint: ${cap.limitingNeed.month} · ${cap.limitingNeed.reason}`);
  if(cap.limitingCapacity&&cap.limitingCapacity.month!==limit?.month)points.push(`Capacity constraint: ${cap.limitingCapacity.month} · ${cap.limitingCapacity.reason}`);
  if(number(state.values.useOfProceeds)===null||number(state.values.useOfProceeds)<0)points.push('Enter the one-time plan cash use explicitly, including 0 when none.');
  if(!state.values.cashEvidence.trim())points.push('Add the opening unrestricted cash source and as-of date in the evidence section.');
  points.push(...(cap.errors||[]).slice(0,2));
  if(!points.length)points.push(...(cap.warnings||[]).slice(0,2));
  const action=cap.status==='feasible'&&cap.verification?.interval===true&&cap.verification?.exact===true&&cap.verification?.suggested===true&&Number.isFinite(cap.suggestedPrincipal)&&cap.suggestedPrincipal>0?`<button type="button" class="bcn-btn uw-capacity-action" data-use-capacity="${cap.suggestedPrincipal}">Test ${exactMoney(cap.suggestedPrincipal)} ${windowOnly?'window':'conservative'} minimum</button>`:'';
  $('capacityExplanation').className=`uw-capacity-explanation ${cap.status!=='feasible'||windowOnly?'uw-capacity-warning':''}`;
  $('capacityExplanation').innerHTML=`<strong>${esc(title)}</strong>${[...new Set(points)].slice(0,4).map(p=>`<p>${esc(p)}</p>`).join('')}${action}`;
}
function renderStructureComparison(model) {
  const variants=[['Amortizing','amortizing'],['Interest-only + balloon','interest-only']].map(([label,repayment])=>{
    const terms=capacityTerms(repayment),cap=assessCurrentCapacity(model,terms);
    const proposal=model.proposal?{...model.proposal}:null;if(proposal)delete proposal.amortizationMonths;
    const entered=proposal?computeScenario({...model,proposal:{...proposal,...terms}}):null;
    return {label,cap,entered};
  });
  $('structureComparison').innerHTML=`<div class="uw-table-wrap"><table class="uw-table"><thead><tr><th>Structure · selected rate & term</th><th>Conservative cash-floor minimum</th><th>Conservative principal ceiling</th><th>Limiting month / status</th><th>Entered amount · lowest DSCR</th><th>Coverage scope</th></tr></thead><tbody>${variants.map(({label,cap,entered})=>`<tr><td>${esc(label)}<span class="uw-constraint-label">${esc(state.values.rate||'—')}% · ${esc(state.values.term||'—')} months · ${esc(state.values.frequency)}</span></td><td>${cap.status==='feasible'&&cap.verification?.interval===true?exactMoney(cap.minimumPositivePrincipal):'—'}</td><td>${cap.status==='feasible'&&(cap.verification?.interval===true||cap.zeroFeasible&&cap.maximumAdditionalPrincipal===0)?exactMoney(cap.maximumAdditionalPrincipal):'—'}</td><td>${esc(cap.limitingCapacity?.month||cap.limitingNeed?.month||'—')}<span class="uw-constraint-label">${({feasible:'Constraints overlap in tested period',infeasible:'Constraints do not overlap',incomplete:'Evidence incomplete',unassessed:'Capacity unassessed'})[cap.status]||'Unassessed'}</span></td><td>${ratio(entered?.summary?.worstMonthlyDscr)}</td><td class="${cap.scope==='window-only'?'uw-bound-warning':''}">${cap.preFundingShortfall?'Pre-funding timing unresolved':cap.status==='incomplete'?'Unassessed':cap.scope==='window-only'?'Window only · maturity untested':cap.scope==='full-term'?'Through maturity':'Unassessed'}</td></tr>`).join('')}</tbody></table></div><p class="uw-fine">These are bounded scenarios at your selected rate, term and fixed fees, not lender offers. The cash-floor minimum includes the new debt’s own payments; the ceiling applies your target in every tested month, including quarterly or annual payment months. This is not an annual lender-covenant calculation. If no proposed payment falls inside the forecast, a repayment ceiling is unassessed. The rounding-safe interval may be narrower than the theoretical bounds. Existing LOC availability is separate and is not drawn automatically.</p>`;
}

function invalidateCommitmentReview() {
  state.values.commitmentsComplete=false;$('commitmentsComplete').checked=false;
}
function renderCommitmentEditor(force=false) {
  if(!force&&$('commitmentEditor').contains(document.activeElement))return;
  const select=(row,key,options)=>`<select class="bcn-field" data-commitment="${esc(row.id)}" data-field="${key}" aria-label="${key} for ${esc(row.sourceReference||'planned payment')}">${options.map(([value,label])=>`<option value="${value}" ${row[key]===value?'selected':''}>${label}</option>`).join('')}</select>`;
  const input=(row,key,type)=>`<input type="${type}" ${type==='number'?'step="any"':''} maxlength="2000" class="bcn-field ${key==='sourceReference'?'uw-reference-input':''}" data-commitment="${esc(row.id)}" data-field="${key}" aria-label="${key} for planned payment" value="${esc(row[key]??'')}">`;
  $('commitmentEditor').innerHTML=state.commitments.length?`<table class="uw-table"><thead><tr><th>PO / plan reference</th><th>Payment month</th><th>Amount</th><th>Currency</th><th>Payment stage</th><th>Cash treatment</th><th>Reviewed</th><th></th></tr></thead><tbody>${state.commitments.map(row=>`<tr class="uw-commitment-row"><td>${input(row,'sourceReference','text')}</td><td>${input(row,'month','month')}</td><td>${input(row,'amount','number')}</td><td>${select(row,'currency',[['','Unknown'],['USD','USD'],['CAD','CAD'],['EUR','EUR'],['GBP','GBP']])}</td><td>${select(row,'paymentType',[['','Choose stage'],['deposit','Deposit'],['balance','Remaining balance'],['other','Other payment']])}</td><td>${select(row,'inclusion',[['','Choose cash treatment'],['incremental','Additional cash use'],['included-in-pre-debt-cash','Already in cash baseline'],['included-in-working-capital','Already in growth WC'],['included-in-other-cash-use','Already in other use']])}</td><td><input type="checkbox" data-commitment="${esc(row.id)}" data-field="reviewed" aria-label="Reviewed ${esc(row.sourceReference||'planned payment')}" ${row.reviewed?'checked':''}></td><td><button type="button" class="uw-remove" data-remove-commitment="${esc(row.id)}" aria-label="Remove planned payment">×</button></td></tr>`).join('')}</tbody></table>`:'<p class="uw-fine">No payment assumptions entered. Imported POs remain visible above. Add their reviewed cash timing, or confirm that no additional commitments apply.</p>';
}

function renderFullSchedule(schedule) {
  if(schedule.errors?.length)return '';
  return `<h3>Full proposed-loan schedule</h3><div class="uw-table-wrap"><table class="uw-table"><thead><tr><th>Month</th><th>Principal</th><th>Interest</th><th>Total payment</th><th>Closing balance</th></tr></thead><tbody>${(schedule.rows||[]).map(r=>`<tr><td>${esc(r.month)}</td><td>${money(r.principal)}</td><td>${money(r.interest)}</td><td>${money(r.payment)}</td><td>${money(r.endingBalance)}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderMonthlyEditor(rows) {
  const focus=document.activeElement;
  if($('monthlyEditor').contains(focus)){
    // Preserve the active input, but never preserve results from an invalid edit.
    $('monthlyEditor').querySelectorAll('[data-cash], [data-dscr]').forEach(cell=>{cell.textContent='—';});
    for(const r of rows){const tr=$('monthlyEditor').querySelector(`[data-month-row="${r.month}"]`);if(tr){tr.querySelector('[data-cash]').textContent=money(r.closingCash);tr.querySelector('[data-dscr]').textContent=ratio(r.dscr);}}
    return;
  }
  $('monthlyEditor').innerHTML=`<table class="uw-table"><thead><tr><th>Month</th><th>Pre-debt cash override</th><th>Existing P&I override</th><th>Growth WC override</th><th>Other cash use</th><th>Closing cash</th><th>DSCR</th></tr></thead><tbody>${rows.map(r=>`<tr data-month-row="${esc(r.month)}"><td>${esc(r.month)}</td>${[['preDebtCash','Cash'],['payment','Payment'],['workingCapitalUse','Growth working capital'],['otherCashUse','Other use']].map(([key,label])=>`<td><input type="number" step="any" class="bcn-field" data-month="${esc(r.month)}" data-key="${key}" aria-label="${label} ${esc(r.month)}" value="${esc(state.overrides[r.month]?.[key]??'')}" ${key==='payment'&&state.values.existingDebtMode==='facilities'?'disabled':''} placeholder="Use baseline"></td>`).join('')}<td data-cash>${money(r.closingCash)}</td><td data-dscr>${ratio(r.dscr)}</td></tr>`).join('')}</tbody></table>`;
}
function invalidateFacilityReview() {state.values.facilitiesComplete=false;$('facilitiesComplete').checked=false;}
function facilityMonths() {
  const v=state.values,n=number(v.forecastMonths);return /^\d{4}-(0[1-9]|1[0-2])$/.test(v.startMonth)&&Number.isInteger(n)&&n>0&&n<=121?Array.from({length:n},(_,i)=>monthAdd(v.startMonth,i)):[];
}
function renderFacility(force=false) {
  const p=state.portfolio||{},v=state.values;
  $('currentCreditRegister').innerHTML=facilityRegisterHtml({facilities:state.facilities,portfolio:p,money})+`<div class="uw-credit-bridge"><span>Outstanding <strong>${money(p.totalBalance,true)}</strong></span><span>Undrawn available <strong>${money(p.totalAvailable,true)}</strong></span><span>Cash need before financing <strong>${money(state.capacity?.rawCashGap,true)}</strong></span></div><p class="uw-fine">${p.availabilityComplete?'Reviewed register coverage.':'Register or availability evidence incomplete. Known availability subtotal: '+money(p.knownAvailable)+'.'} Undrawn credit is separate from cash and is not automatically drawn or netted against the funding need.</p>`;
  $('creditSummary').innerHTML=`<div class="uw-result-row"><span>Registered debt outstanding</span><strong>${money(p.totalBalance,true)}</strong></div><div class="uw-result-row"><span>Undrawn credit · documented inputs</span><strong>${money(p.totalAvailable,true)}</strong></div><p>${state.facilities.length} facilities. ${v.existingDebtMode==='facilities'?'Reviewed facility payments feed capacity.':'Manual aggregate P&I feeds capacity; facility payments are comparison only.'}</p>`;
  if(force||!$('facilityEditor').contains(document.activeElement)){
    const openIds=[...$('facilityEditor').querySelectorAll('[data-facility-panel][open]')].map(el=>el.dataset.facilityPanel);
    // A forced rebuild after a change event replaces the focused control (and, on
    // Tab, the control Tab had just reached). Re-find it by its data attributes.
    const active=document.activeElement,focused=active&&$('facilityEditor').contains(active)&&active.dataset?.facility?Object.entries(active.dataset).filter(([key])=>['facility','field','term','paymentMonth'].includes(key)).map(([key,value])=>`[data-${key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}="${String(value).replace(/["\\]/g,'\\$&')}"]`).join(''):null;
    $('facilityEditor').innerHTML=facilityEditorHtml({facilities:state.facilities,accountOptions:state.sources?.accountOptions||[],portfolio:p,months:facilityMonths(),money,openIds});
    if(focused){const again=$('facilityEditor').querySelector(focused);if(again)again.focus?.({preventScroll:true});}
  }
  const manual=v.existingDebtMode==='manual';$('existingPayment').disabled=!manual;$('existingPayment').closest('div').hidden=!manual;$('debtComplete').disabled=!manual;$('debtComplete').closest('label').hidden=!manual;$('debtProvenance').disabled=!manual;const first=p.rows?.[0];$('activeFacilityPI').hidden=manual;$('activeFacilityPI').innerHTML=`<span class="uw-label">Existing P&I · facility schedules</span><strong>${money(first?.payment)}</strong><small>${esc(first?.month||'No schedule')} · varies with payment timing</small>`;
  $('debtReconciliation').innerHTML=`<p class="uw-fine">Active: ${manual?'manual aggregate only':'facility schedules only'}. These are alternatives, never added together. A difference needs investigation, not automatic balancing.</p><table class="uw-table"><thead><tr><th>Month</th><th>Facility total</th><th>Manual aggregate</th><th>Difference</th></tr></thead><tbody>${(p.reconciliation||[]).map(r=>`<tr><td>${esc(r.month)}</td><td>${money(r.facilityPayment)}</td><td>${money(r.manualPayment)}</td><td>${money(r.difference)}</td></tr>`).join('')}</tbody></table>`;
}
function changeFacility(el) {
  const f=state.facilities.find(r=>r.id===el.dataset.facility);if(!f)return;
  if(el.dataset.paymentMonth){const value=number(el.value);if(value===null)delete f.monthlyPayments[el.dataset.paymentMonth];else f.monthlyPayments[el.dataset.paymentMonth]=value;f.scheduleComplete=false;}
  else {
    const key=el.dataset.field,target=el.dataset.term?f.terms:f,value=el.type==='checkbox'?el.checked:el.type==='number'?number(el.value):el.value;
    if((key==='accountId'&&f.accountId&&f.accountId!==value)||(key==='balanceSource'&&f.balanceSource!==value)){const next=createFacility(f.id,f.kind,f.currency);Object.assign(next,{name:f.name,...(key==='accountId'?{accountId:value}:{balanceSource:value})});Object.assign(f,next);setStatus('Balance source changed. Prior lender terms and payment evidence were cleared for this facility.');}
    else {target[key]=value;if(key!=='name'&&key!=='scheduleComplete')f.scheduleComplete=false;if(key==='kind'&&value==='loc')f.scheduleMode='payments';}
  }
  if(el.dataset.field==='repayment'&&f.terms.repayment!=='balloon')f.terms.amortizationMonths=null;
  if(el.dataset.field!=='name')invalidateFacilityReview();
  render();renderFacility(true);
}
function setStep(step) {
  if(!['business','funding','test','review'].includes(step))return;state.step=step;
  document.querySelectorAll('[data-step-panel]').forEach(el=>{el.hidden=el.dataset.stepPanel!==step;});
  document.querySelectorAll('[role="tab"][data-step]').forEach(el=>{const on=el.dataset.step===step;el.setAttribute('aria-selected',String(on));el.tabIndex=on?0:-1;});
  document.querySelector('.silo-main')?.scrollTo?.({top:0,behavior:'auto'});
}
function invalidateTimingReview(){for(const key of ['collections','inventory'])state.cashTiming[key].reviewed=false;state.cashTiming.distinctReceiptPoolsReviewed=false;}
function changeCashTiming(el){const row=state.cashTiming[el.dataset.timing];if(!row)return;const key=el.dataset.field;row[key]=el.type==='checkbox'?el.checked:el.type==='number'?number(el.value):el.value;if(key!=='reviewed'){row.reviewed=false;state.cashTiming.distinctReceiptPoolsReviewed=false;}render();renderCashTiming(true);}
function renderCashTiming(force=false){if(force||!$('cashTimingEditor').contains(document.activeElement))$('cashTimingEditor').innerHTML=cashTimingEditorHtml(state.cashTiming);$('cashTimingImpact').innerHTML=cashTimingImpactHtml(state.cashTimingResult,money);}
function renderReview(model,valid) {
  $('captureReview').textContent=state.reviewBaseline?'Replace reviewed baseline':'Mark reviewed baseline';
  $('proposalMemo').innerHTML=proposalMemoHtml({state,model,valid,money,exactMoney,ratio});
  try{state.currentReview=snapshotForReview({state,definitions:allDefs,number,createdAt:new Date().toISOString()});$('reviewChanges').innerHTML=reviewChangesHtml(state.currentReview,state.reviewBaseline,money);}
  catch(error){state.currentReview=null;$('reviewChanges').innerHTML=`<p class="uw-data-warning">Review comparison unavailable: ${esc(error.message)}</p>`;}
}
async function captureReview() {
  await revalidate();if(!state.ready||state.held)return;render();
  if(!state.currentReview){setStatus('The current inputs cannot yet be captured as a review baseline. Resolve the review comparison warning.','neg');return;}
  state.reviewBaseline=state.currentReview;render();
  setStatus('Reviewed baseline captured locally. Download the scenario to retain it; later changes will be compared with this snapshot.');
}
async function printProposal() {
  await revalidate();if(!state.ready||state.held)return;
  buildPrintPacket();
  printing=true;try{window.print();}finally{printing=false;}
}
// Built from CURRENT state every time, including for Ctrl+P / File > Print: the
// print stylesheet shows only #printPacket, so a packet left over from an
// earlier button print would otherwise print an old amount with nothing on the
// page saying so. afterprint empties it again for the same reason.
function buildPrintPacket() {
  render();
  if(state.mode==='quick'){
    $('printPacket').innerHTML=quickPrintHtml({result:state.quickResult,debts:state.quick.debts,money,companyTitle:state.context.company.title,preparedAt:new Date().toISOString()});
    return;
  }
  const sources=$('sourceDetail').innerHTML,evidence=printEvidenceHtml(state,money);
  $('printPacket').innerHTML=`<header><h1>Underwriting proposal</h1><p>Draft analyst scenario · ${esc(state.context.company.title||'Current company')} · Prepared ${esc(new Date().toISOString())}</p></header>${$('proposalMemo').innerHTML}<section class="uw-print-appendix"><h2>Supporting schedules & evidence</h2><h3>Existing facilities</h3>${$('currentCreditRegister').innerHTML}<h3>Debt service, cash uses & cash coverage</h3>${$('debtSchedule').innerHTML}<h3>Assumptions and provenance</h3><dl>${allDefs.filter(([id])=>!(['amortizationMonths'].includes(id)&&state.values.repayment!=='balloon')&&!(['creditScore','clientReference','documentReferences','lenderRules','scenarioName'].includes(id)&&String(state.values[id]??'').trim()==='')).map(([id,label])=>`<dt>${esc(label)}</dt><dd>${esc(String(state.values[id]??'Unknown'))||'Unknown'}</dd>`).join('')}</dl><h3>Planned payments</h3><table class="uw-table"><thead><tr><th>Reference</th><th>Month</th><th>Amount</th><th>Treatment</th></tr></thead><tbody>${state.commitments.map(r=>`<tr><td>${esc(r.sourceReference)}</td><td>${esc(r.month)}</td><td>${money(r.amount)} ${esc(r.currency)}</td><td>${esc(r.inclusion)} · ${r.reviewed?'reviewed':'not reviewed'}</td></tr>`).join('')}</tbody></table><h3>Source coverage</h3>${sources}<h3>Facility evidence and remaining terms</h3>${evidence.facilities}<h3>Existing P&I by facility</h3><table class="uw-table"><thead><tr><th>Month</th>${state.facilities.map(f=>`<th>${esc(f.name||f.id)}</th>`).join('')}<th>Combined</th></tr></thead><tbody>${(state.portfolio.rows||[]).map(r=>`<tr><td>${esc(r.month)}</td>${r.byFacility.map(f=>`<td>${money(f.payment)}</td>`).join('')}<td>${money(r.payment)}</td></tr>`).join('')}</tbody></table><h3>Receipt timing assumptions</h3>${evidence.timing}${$('cashTimingImpact').innerHTML}<h3>Monthly input overrides</h3><table class="uw-table"><thead><tr><th>Month</th><th>Cash before debt</th><th>Manual P&I reference</th><th>Growth WC</th><th>Other cash use</th></tr></thead><tbody>${Object.entries(state.overrides).map(([month,row])=>`<tr><td>${esc(month)}</td>${['preDebtCash','payment','workingCapitalUse','otherCashUse'].map(key=>`<td>${number(row[key])===null?'Baseline':money(number(row[key]))}</td>`).join('')}</tr>`).join('')}</tbody></table><h3>Calculation notes</h3>${$('methodology').innerHTML}</section>`;
  $('printPacket').querySelectorAll('details').forEach(el=>{el.open=true;});
}
const sourceNames={revenuePlan:'Sales plan',balanceSheet:'Balance sheet',profitAndLoss:'P&L',cashflow:'Cash flow',bank:'Bank',inventory:'Inventory',purchaseOrders:'Purchase orders'};
function renderSources() {
  const sources=state.sources?.sources||{};
  $('sourceStrip').innerHTML=Object.entries(sourceNames).map(([key,name])=>{const s=sources[key]||{status:'missing'};return `<div class="uw-source"><div class="uw-source-name"><span class="uw-dot ${esc(s.status)}"></span>${name}</div><div class="uw-source-date">${esc(String(s.asOf||s.periodEnd||'').slice(0,10)||'No date available')}</div><div class="uw-source-state">${({available:'Imported · review required',partial:'Partial coverage',missing:'Not available',error:'Read failed'})[s.status]||'Not verified'}</div></div>`;}).join('');
  $('sourceDetail').innerHTML=`<div class="uw-source-details-grid">${Object.entries(sourceNames).map(([key,name])=>{const s=sources[key]||{};return `<section class="uw-source-fact"><h3>${name} · ${esc(s.status||'missing')}</h3><p>${esc(s.periodStart||'')} ${s.periodEnd?'→ '+esc(s.periodEnd):''} · As of ${esc(s.asOf||'unknown')} · ${esc(s.currency||'currency unknown')} · ${esc(s.basis||'basis not specified')}</p><dl>${(s.metrics||[]).map(m=>`<div><dt>${esc(m.label)}${m.periodStart?` · ${esc(m.periodStart)} → ${esc(m.periodEnd)}`:''}</dt><dd>${m.value==null?'—':esc(m.unit==='currency'?new Intl.NumberFormat('en-US',{style:'decimal',maximumFractionDigits:0}).format(m.value)+' '+(m.currency||s.currency||''):String(m.value))}</dd></div>`).join('')}</dl>${sourceRows(key,s)}${s.error?`<p>Read error: ${esc(s.error.message||s.error)}</p>`:''}${(s.warnings||[]).map(w=>`<p>• ${esc(w)}</p>`).join('')}</section>`;}).join('')}</div>`;
  const business=businessView(state.sources);
  for(const [id,key] of Object.entries({businessKpis:'kpis',performanceView:'performance',liquidityView:'liquidity',planningView:'planning',exposureView:'exposure',purchaseOrderView:'orders',bookLiabilityView:'liabilityAccounts'}))$(id).innerHTML=business[key];

}
function sourceRows(key,s) {
  const n=v=>v==null?'—':new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(v);
  if(key==='bank')return `<div class="uw-table-wrap"><table class="uw-table"><thead><tr><th>Account</th><th>Current</th><th>Provider available</th><th>Currency</th><th>Balance as of</th><th>Connection status</th><th>Environment</th></tr></thead><tbody>${(s.rows||[]).map(r=>`<tr><td>${esc(r.name||r.id)}</td><td>${n(r.current_balance)}</td><td>${n(r.available_balance)}</td><td>${esc(r.iso_currency_code||'Unknown')}</td><td>${esc(r.balance_updated_at||'Unknown')}</td><td>${esc(r.connection_status||'Unknown')}</td><td>${esc(r.environment||'Unknown')}</td></tr>`).join('')}</tbody></table></div>`;
  if(key==='cashflow')return `<div class="uw-table-wrap"><table class="uw-table"><thead><tr><th>Period end</th><th>Operating</th><th>Investing</th><th>Financing</th></tr></thead><tbody>${(s.monthly||[]).map(r=>`<tr><td>${esc(r.periodEnd)}${r.completeMonth?'':' · partial'}</td><td>${n(r.operating)}</td><td>${n(r.investing)}</td><td>${n(r.financing)}</td></tr>`).join('')}</tbody></table></div>`;
  return '';
}
function setStatus(message,tone='info') {$('status').textContent=message;$('status').className=`bcn-status bcn-status--${tone}`;$('status').hidden=!message;}
function clearSensitive(message) {
  guard.invalidate();state.ready=false;state.held=false;state.quick={debts:[]};state.quickResult=null;state.sources=null;state.context=null;state.result=null;state.capacity=null;state.facilities=[];state.portfolio=null;state.reviewBaseline=null;state.currentReview=null;state.cashTiming=emptyCashTimingAssumptions();state.cashTimingResult=null;state.overrides={};state.commitments=[];
  $('workspace').hidden=true;$('gate').hidden=false;
  const note=document.createElement('p');note.textContent=message;
  const signedOut=/sign in|signed out/i.test(message||'');
  const action=document.createElement(signedOut?'a':'button');action.className='bcn-btn bcn-btn--dark';
  if(signedOut){action.textContent='Sign in to SILO';action.href='/pages/login.html?next=%2Fv2%2Funderwriting%2Findex.html';}
  else{action.type='button';action.textContent='Refresh page';action.addEventListener('click',()=>window.location.reload());}
  $('gate').replaceChildren(note,action);
  buildFields();for(const id of ['sourceStrip','sourceDetail','businessKpis','performanceView','liquidityView','planningView','exposureView','purchaseOrderView','bookLiabilityView','creditSummary','cashChart','cashInsights','debtChart','debtSummary','debtSchedule','commitmentEditor','commitmentIssues','capacitySummary','capacityExplanation','structureComparison','currentCreditRegister','facilityEditor','debtReconciliation','proposalMemo','reviewChanges','printPacket','cashTimingEditor','cashTimingImpact','activeFacilityPI','quickFacts','quickResult','quickVerdict','quickDebts'])$(id).replaceChildren();
}
async function load() {
  const ticket=guard.begin();
  $('refresh').disabled=true;
  try {
    const context=await readContext(db,window.__SILO_CONFIG__);
    if(!guard.current(ticket))return;
    if(state.context && context.key!==state.context.key){clearSensitive('Company changed. The previous scenario was cleared. Refresh this page to start for the new company.');return;}
    state.context=context;
    const snapshot=await loadSourceSnapshot(db,context.company.id,{signal:ticket.signal});
    if(!guard.current(ticket))return;
    const after=await readContext(db,window.__SILO_CONFIG__);
    if(!guard.current(ticket))return;
    if(after.key!==context.key){clearSensitive('Company changed while sources were loading. Refresh to continue.');return;}
    if(state.sources){const old=state.sources.accountOptions||[],next=snapshot.accountOptions||[];for(const f of state.facilities)if(f.balanceSource==='account'){const before=old.find(a=>a.id===f.accountId),after=next.find(a=>a.id===f.accountId);if(JSON.stringify([before?.balance,before?.balanceAsOf,before?.balanceCurrency])!==JSON.stringify([after?.balance,after?.balanceAsOf,after?.balanceCurrency])){f.scheduleComplete=false;invalidateFacilityReview();}}}
    state.sources=snapshot;state.ready=true;state.held=false;
    state.quick.debts=draftQuickDebts(snapshot.accountOptions,state.quick.debts);
    if(!mounted){window.SiloChrome?.mount({appEl:'#silo-app',active:'',user:{email:context.user.email,role:context.profile.role},crumbs:['Finance','Underwriting'],supabaseClient:db});mounted=true;}
    $('company').textContent=context.company.title||'Current company';
    $('workspace').hidden=false;$('gate').hidden=true;
    if(!state.values.currency&&snapshot.currency&&[...$('currency').options].some(o=>o.value===snapshot.currency)){state.values.currency=snapshot.currency;$('currency').value=snapshot.currency;}
    renderSources();render();seedOpeningCash();render();setMode(state.mode);
    const errors=Object.values(snapshot.sources).filter(s=>s.status==='error');
    setStatus(errors.length?`${errors.length} source read${errors.length===1?'':'s'} failed. Other sources are shown; missing values remain unknown.`:'');
  } catch(error) {
    if(!guard.current(ticket))return;
    if(error?.transient&&state.ready&&state.sources){setStatus(`${error.message} The previously loaded sources are still shown.`,'neg');}
    else if(error?.transient)holdForRetry(error.message,load);
    else clearSensitive(error.message||'Could not verify access or read the source data. Refresh to try again.');
  } finally {if(guard.current(ticket))$('refresh').disabled=false;}
}
// A read that did not come back is not a verdict. The scenario stays in memory,
// the workspace stays hidden, and the person retries; only a DEFINITIVE answer
// (signed out, disabled, another company, no finance gate) clears anything.
function holdForRetry(message,retry) {
  state.held=true;$('workspace').hidden=true;$('gate').hidden=false;
  const note=document.createElement('p');note.textContent=`${message} Your scenario inputs are kept in this tab until verification succeeds.`;
  const action=document.createElement('button');action.type='button';action.className='bcn-btn bcn-btn--dark';action.textContent='Retry verification';action.addEventListener('click',()=>retry().catch(e=>setStatus(e.message,'neg')));
  $('gate').replaceChildren(note,action);
}
function release() {
  state.held=false;$('gate').hidden=true;
  if(state.ready&&document.visibilityState==='visible')$('workspace').hidden=false;
}
async function revalidate() {
  if(validationPromise)return validationPromise;
  if(!state.ready)return;
  const key=state.context?.key;
  validationPromise=(async()=>{
    try {const next=await readContext(db,window.__SILO_CONFIG__);if(state.context?.key!==key)return;if(next.key!==key)clearSensitive('Your active company changed. This scenario was cleared. Refresh to continue.');else if(state.held)release();}
    catch(error){if(error?.transient)holdForRetry(error.message,retryVerification);else clearSensitive(error.message);}
    finally{validationPromise=null;}
  })();
  return validationPromise;
}
async function retryVerification() {await revalidate();}
async function resumeView() {
  if(!state.ready)return;
  $('workspace').hidden=true;
  await revalidate();
  if(state.ready&&!state.held&&document.visibilityState==='visible')$('workspace').hidden=false;
}
function setValues(values) {
  for(const def of allDefs){const id=def[0];if(!Object.hasOwn(values,id))continue;state.values[id]=values[id];if(def[2]==='checkbox')$(id).checked=values[id]===true;else $(id).value=values[id];}
}
const PRESETS={base:{growthPct:'0',revenueDecline:'0',marginCompression:'0'},downside:{growthPct:'0',revenueDecline:'10',marginCompression:'3'},growth:{growthPct:'20',revenueDecline:'0',marginCompression:'0'}};
const PRESET_NOTES={base:'Base: no revenue reduction or incremental growth working capital. All other inputs remain yours.',downside:'Illustrative downside: revenue −10%, margin −3 points. Requires revenue and gross-margin assumptions.',growth:'Illustrative growth: fund 20% more inventory / operating working capital. No automatic revenue uplift.',custom:'Custom assumptions: the entered growth, revenue-decline and margin inputs do not match an illustrative preset.'};
// The pressed preset is DERIVED from the three values, never remembered: an
// imported scenario or a hand edit would otherwise leave "Base" lit over a 20%
// growth case.
function presetFromValues(v) {
  return Object.keys(PRESETS).find(key=>['growthPct','revenueDecline','marginCompression'].every(id=>number(v[id])!==null&&number(v[id])===Number(PRESETS[key][id])))||null;
}
function reflectPreset() {
  const preset=presetFromValues(state.values);state.preset=preset;
  document.querySelectorAll('[data-preset]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.preset===preset)));
  $('presetNote').textContent=PRESET_NOTES[preset||'custom'];
}
function choosePreset(preset) {
  if(!PRESETS[preset])return;
  setValues(PRESETS[preset]);invalidateTimingReview();
  reflectPreset();
  render();
}
async function download() {
  await revalidate();if(!state.ready||state.held)return;
  const payload={format:'silo-underwriting-scenario',version:4,companyId:state.context.company.id,exportedAt:new Date().toISOString(),values:state.values,overrides:state.overrides,commitments:state.commitments,facilities:state.facilities,cashTiming:state.cashTiming,reviewBaseline:state.reviewBaseline,quick:{debts:state.quick.debts.map(({id,include,monthlyPayment})=>({id,include,monthlyPayment}))},sourceDates:Object.fromEntries(Object.entries(state.sources.sources).map(([k,s])=>[k,{asOf:s.asOf,periodStart:s.periodStart,periodEnd:s.periodEnd,status:s.status}]))};
  // Compact on purpose: the import bound is the raw file size, and a pretty-printed
  // copy measured 1.46x larger, so a file that imported could fail to download.
  const serialized=JSON.stringify(payload);if(new TextEncoder().encode(serialized).length>2000000)throw new Error('This scenario exceeds the 2 MB import limit. Reduce oversized notes or schedules before downloading.');
  const blob=new Blob([serialized],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`silo-underwriting-${state.values.startMonth}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setStatus('Scenario downloaded. It contains your local inputs and references; no source records were changed.');
}
async function importScenario(file) {
  if(!file)return;
  if(file.size>2000000)throw new Error('Choose a scenario JSON file smaller than 2 MB.');
  await revalidate();if(!state.ready||state.held)return;
  const doc=JSON.parse(await file.text());
  const imported=validateScenarioDocument(doc,allDefs,state.context.company.id);
  // Async file reads cannot carry an old tenant's inputs into a new context.
  await revalidate();if(!state.ready||doc.companyId!==state.context.company.id)return;
  setValues(imported.values);state.overrides=imported.overrides;state.commitments=imported.commitments;
  state.facilities=imported.facilities;state.reviewBaseline=imported.reviewBaseline;state.cashTiming=imported.cashTiming;
  state.quick.debts=draftQuickDebts(state.sources?.accountOptions||[],imported.quick.debts);
  reflectPreset();render();renderQuick(true);renderCommitmentEditor(true);renderFacility(true);renderCashTiming(true);setStatus('Local scenario opened. Imported inputs are user-provided assumptions; current source records were refreshed separately.');
}
async function boot() {
  buildFields();
  const cfg=window.__SILO_CONFIG__;
  if(!cfg?.SUPABASE_URL||!cfg?.SUPABASE_ANON_KEY||!window.supabase?.createClient){clearSensitive('Missing SILO configuration.');return;}
  db=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);
  $('workspace').addEventListener('change',e=>{if(!state.ready)return;if(e.target.dataset?.quick){changeQuickInput(e.target);return;}if(e.target.dataset?.quickDebt){changeQuickDebt(e.target);return;}const def=allDefs.find(d=>d[0]===e.target.id);if(def){state.values[e.target.id]=def[2]==='checkbox'?e.target.checked:e.target.value;if(['normalizedCash','cashProvenance','revenue','revenueDecline','grossMargin','marginCompression'].includes(e.target.id))invalidateTimingReview();if(['growthPct','revenueDecline','marginCompression'].includes(e.target.id))reflectPreset();if(['normalizedCash','cashProvenance'].includes(e.target.id)){state.values.cashForecastReviewed=false;$('cashForecastReviewed').checked=false;}if(['existingDebtMode','facilitiesProvenance'].includes(e.target.id))invalidateFacilityReview();if(['existingPayment','debtProvenance'].includes(e.target.id)){state.values.debtComplete=false;$('debtComplete').checked=false;}if(['startMonth','currency','forecastMonths'].includes(e.target.id)){invalidateFacilityReview();state.facilities.forEach(f=>f.scheduleComplete=false);invalidateTimingReview();invalidateCommitmentReview();state.values.cashForecastReviewed=false;$('cashForecastReviewed').checked=false;state.values.debtComplete=false;$('debtComplete').checked=false;}render();}if(e.target.dataset.month){const {month,key}=e.target.dataset;state.overrides[month]??={};state.overrides[month][key]=e.target.value;if(key==='preDebtCash'){invalidateTimingReview();state.values.cashForecastReviewed=false;$('cashForecastReviewed').checked=false;}if(key==='payment'){state.values.debtComplete=false;$('debtComplete').checked=false;}render();}if(e.target.dataset.commitment){const row=state.commitments.find(r=>r.id===e.target.dataset.commitment);if(row){const key=e.target.dataset.field;row[key]=key==='reviewed'?e.target.checked:key==='amount'?number(e.target.value):e.target.value;invalidateCommitmentReview();if(key!=='reviewed'){row.reviewed=false;$('commitmentEditor').querySelectorAll('[data-field="reviewed"]').forEach(el=>{if(el.dataset.commitment===row.id)el.checked=false;});}render();}}if(e.target.dataset.facility)changeFacility(e.target);if(e.target.dataset.timing)changeCashTiming(e.target);if(e.target.hasAttribute?.('data-timing-distinct')){state.cashTiming.distinctReceiptPoolsReviewed=e.target.checked;render();}});
  $('workspace').addEventListener('click',e=>{const mode=e.target.closest('[data-mode]');if(mode){setMode(mode.dataset.mode);return;}const step=e.target.closest('[data-step]');if(step)setStep(step.dataset.step);const anchor=e.target.closest('[data-go-step]');if(anchor){setStep(anchor.dataset.goStep);const target=$(anchor.getAttribute('href').slice(1));let parent=target?.parentElement;while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}}const add=e.target.closest('[data-add-facility]');if(add&&state.ready&&state.facilities.length<50){invalidateFacilityReview();const f=createFacility(globalThis.crypto?.randomUUID?.()||`facility-${Date.now()}-${state.facilities.length}`,add.dataset.addFacility,state.values.currency);state.facilities.push(f);render();renderFacility(true);const panel=[...$('facilityEditor').querySelectorAll('[data-facility-panel]')].find(el=>el.dataset.facilityPanel===f.id);if(panel)panel.open=true;}const edit=e.target.closest('[data-edit-facility]');if(edit){const panel=[...$('facilityEditor').querySelectorAll('[data-facility-panel]')].find(el=>el.dataset.facilityPanel===edit.dataset.editFacility);if(panel){panel.open=true;panel.scrollIntoView?.({block:'nearest',behavior:'smooth'});}}const removeFacility=e.target.closest('[data-remove-facility]');if(removeFacility){invalidateFacilityReview();state.facilities=state.facilities.filter(f=>f.id!==removeFacility.dataset.removeFacility);render();renderFacility(true);}const b=e.target.closest('[data-preset]');if(b)choosePreset(b.dataset.preset);const capacityChoice=e.target.closest('[data-use-capacity]');if(capacityChoice){const candidate=number(capacityChoice.dataset.useCapacity);if(candidate!==null&&candidate>0){setValues({amount:String(candidate)});render();}}const remove=e.target.closest('[data-remove-commitment]');if(remove){invalidateCommitmentReview();state.commitments=state.commitments.filter(r=>r.id!==remove.dataset.removeCommitment);render();renderCommitmentEditor(true);}});
  document.querySelector('.uw-flow')?.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;const steps=['business','funding','test','review'];const i=steps.indexOf(state.step),next=e.key==='Home'?0:e.key==='End'?3:(i+(e.key==='ArrowRight'?1:3))%4;setStep(steps[next]);$('tab-'+steps[next]).focus();e.preventDefault();});
  $('addCommitment').addEventListener('click',()=>{if(!state.ready||state.commitments.length>=500)return;invalidateCommitmentReview();state.commitments.push({id:globalThis.crypto?.randomUUID?.()||`payment-${Date.now()}-${state.commitments.length}`,month:'',amount:null,currency:state.values.currency||'',sourceReference:'',paymentType:'deposit',inclusion:'incremental',reviewed:false});render();renderCommitmentEditor(true);});
  $('captureReview').addEventListener('click',()=>captureReview().catch(e=>setStatus(e.message,'neg')));$('printQuick').addEventListener('click',()=>printProposal().catch(e=>setStatus(e.message,'neg')));$('printProposal').addEventListener('click',()=>printProposal().catch(e=>setStatus(e.message,'neg')));
  $('refresh').addEventListener('click',load);$('download').addEventListener('click',()=>download().catch(e=>setStatus(e.message,'neg')));
  $('import').addEventListener('click',()=>$('importFile').click());$('importFile').addEventListener('change',e=>importScenario(e.target.files[0]).catch(e=>setStatus(e.message,'neg')).finally(()=>{e.target.value='';}));
  db.auth.onAuthStateChange((event)=>{if(event==='SIGNED_OUT'||event==='USER_DELETED')clearSensitive('Signed out. Sign in to SILO and refresh this page.');else if(event==='SIGNED_IN'||event==='USER_UPDATED')setTimeout(resumeView,0);});
  window.addEventListener('focus',resumeView);
  window.addEventListener('beforeprint',()=>{if(printing)return;if(state.ready&&!state.held)buildPrintPacket();else $('printPacket').replaceChildren();});
  window.addEventListener('afterprint',()=>{if(!printing)$('printPacket').replaceChildren();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')resumeView();else if(state.ready)$('workspace').hidden=true;});
  await load();
}
boot().catch(error=>clearSensitive(error.message));
