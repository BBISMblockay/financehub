// Synthetic-only browser fixture. No production auth bypass or demo route exists.
// --contract-only checks the current v4 fixture without importing or launching a browser.
import assert from 'node:assert/strict';
import {installSyntheticFixture as fixture, syntheticScenarioValues, syntheticFacilities} from './synthetic-fixture.js';
import {validateScenarioDocument} from '../scenario-file.js';
import {emptyCashTimingAssumptions} from '../cash-timing.js';
import {assessFacilityPortfolio} from '../facility-model.js';
import {loadSourceSnapshot} from '../source-data.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const companyId='11111111-1111-4111-8111-111111111111';
const displayMoney=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(value);

function syntheticDocument(currentValues) {
 return {format:'silo-underwriting-scenario',version:4,companyId,
  values:{...currentValues,...syntheticScenarioValues,currency:'USD',repayment:'amortizing',frequency:'monthly',
   coverageTarget:'1.25',growthPct:'0',revenueDecline:'0',marginCompression:'0',
   existingDebtMode:'facilities',facilitiesComplete:true,
   facilitiesProvenance:'Synthetic portfolio review 2026-09-30: all three loans and lines, required payments and maturity timing reviewed for the full 37-month forecast.',
   debtComplete:true,cashForecastReviewed:true,commitmentsComplete:true},
  overrides:{},commitments:[],facilities:structuredClone(syntheticFacilities),
  cashTiming:emptyCashTimingAssumptions(),reviewBaseline:null};
}

function portfolioFor(doc,accountOptions,overrides={}) {
 const v=doc.values;
 return assessFacilityPortfolio({facilities:doc.facilities,accountOptions,currency:v.currency,startMonth:v.startMonth,
  horizonMonths:Number(v.forecastMonths),mode:v.existingDebtMode,complete:v.facilitiesComplete,
  provenance:v.facilitiesProvenance,manualDebt:{monthlyPayment:Number(v.existingPayment),monthlyPayments:{},complete:v.debtComplete,provenance:v.debtProvenance},...overrides});
}

async function syntheticAccounts() {
 // The same fictional read-only adapter used by the browser, with no network or real DB.
 const sandbox={window:{}};
 vm.runInNewContext(`(${fixture.toString()})();`,sandbox);
 return (await loadSourceSnapshot(sandbox.window.__fixtureDB,companyId)).accountOptions;
}

async function checkContract() {
 const source=await fs.readFile(path.join(root,'v2/underwriting/workspace.js'),'utf8');
 const definitionLiteral=source.match(/const definitions = ([\s\S]*?);\nconst allDefs/);
 assert.ok(definitionLiteral,'current workspace field definitions are available');
 const definitions=JSON.parse(JSON.stringify(vm.runInNewContext(`(${definitionLiteral[1]})`,{initialMonth:'2026-10'})));
 const allDefs=Object.values(definitions).flat();
 const doc=syntheticDocument(Object.fromEntries(allDefs.map(([id,,,initial])=>[id,initial??''])));
 const validated=validateScenarioDocument(doc,allDefs,companyId);
 assert.equal(Object.keys(validated.values).length,allDefs.length,'v4 contains every current form field');
 assert.equal(validated.facilities.length,3);
 assert.deepEqual(validated.cashTiming,emptyCashTimingAssumptions());
 assert.equal(validated.reviewBaseline,null);
 const accounts=await syntheticAccounts(),portfolio=portfolioFor(doc,accounts);
 assert.deepEqual(portfolio.errors,[]);
 assert.equal(portfolio.totalAvailable,465000,'two documented LOC amounts aggregate once');
 assert.equal(portfolio.existingDebt.complete,true);
 assert.equal(portfolio.rows.length,37);
 const first=portfolio.rows[0];
 assert.equal(first.payment,Math.round(first.byFacility.reduce((total,row)=>total+row.payment,0)*100)/100);
 assert.equal(portfolio.existingDebt.monthlyPayments[first.month],first.payment,'manual reference is not added');
 assert.notEqual(first.payment,Number(doc.values.existingPayment));
 assert.equal(portfolioFor(doc,accounts,{complete:false}).existingDebt.complete,false,'coverage review gates facility-derived debt');
 const incomplete=structuredClone(doc);incomplete.facilities[0].scheduleComplete=false;
 assert.equal(portfolioFor(incomplete,accounts).existingDebt.complete,false,'one unreviewed facility blocks coverage');
 const duplicate=structuredClone(doc);duplicate.facilities[1].accountId=duplicate.facilities[0].accountId;
 assert.equal(portfolioFor(duplicate,accounts).existingDebt.complete,false,'duplicate account matches cannot qualify');
 return {doc,portfolio};
}

async function runBrowser() {
 const require=createRequire(import.meta.url);
 const {chromium}=process.env.PLAYWRIGHT_MODULE?await import(process.env.PLAYWRIGHT_MODULE):require('playwright');
 const output=process.env.UW_OUTPUT||'/tmp/underwriting-preview';await fs.mkdir(output,{recursive:true});
 const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
 const server=http.createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,'http://local').pathname);const file=path.resolve(root,'.'+pathname);if(!file.startsWith(root+'/'))throw Error('Path');const body=await fs.readFile(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]||'text/plain'});res.end(body);}catch{res.writeHead(404);res.end('Not found');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}/v2/underwriting/index.html`;
 let browser;
 try {
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,headless:true,chromiumSandbox:true});
  async function setup(viewport={width:1600,height:1100}) {
   const page=await browser.newPage({viewport,deviceScaleFactor:1});const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(fixture);
   await page.route('https://cdn.jsdelivr.net/**',r=>r.fulfill({contentType:'text/javascript',body:'window.supabase={createClient:()=>window.__fixtureDB};'}));
   await page.route('https://*.supabase.co/**',r=>r.abort());
   await page.goto(url);await page.waitForFunction(()=>!document.getElementById('workspace').hidden);
   return {page,errors};
  }
  async function openDocument(page,doc) {
   // A prior successful import can leave identical status text. Wait for a new
   // status mutation so reopening never races the asynchronous file read.
   await page.evaluate(()=>{
    window.__fixture.importObserved=false;
    const status=document.getElementById('status');
    const observer=new MutationObserver(()=>{
     if(status.textContent.startsWith('Local scenario opened.')){window.__fixture.importObserved=true;observer.disconnect();}
    });
    observer.observe(status,{childList:true,characterData:true,subtree:true});
   });
   await page.locator('#importFile').setInputFiles({name:'synthetic-underwriting-v4.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});
   await page.waitForFunction(()=>window.__fixture.importObserved===true);
  }
  async function fill(page) {
   // Read the complete current form snapshot, including hidden steps and booleans.
   const currentValues=await page.locator('#workspace input[id]:not([type="file"]), #workspace select[id], #workspace textarea[id]').evaluateAll(elements=>Object.fromEntries(elements.map(el=>[el.id,el.type==='checkbox'?el.checked:el.value])));
   const doc=syntheticDocument(currentValues);
   await openDocument(page,doc);
   return doc;
  }
  async function step(page,name) {
   await page.locator(`[role="tab"][data-step="${name}"]`).click();
   assert.equal(await page.locator(`#step-${name}`).isVisible(),true,`${name} panel is visible`);
   assert.equal(await page.locator('[data-step-panel]:visible').count(),1,'exactly one step is visible');
   assert.equal(await page.locator(`[role="tab"][data-step="${name}"]`).getAttribute('aria-selected'),'true');
  }
  const {page,errors}=await setup();const doc=await fill(page);
  // Quick look lands first: the synthetic doc's amount/rate/term produce a payment and a verdict.
  assert.equal(await page.locator('#step-quick').isVisible(),true,'quick look is the landing view');
  assert.equal(await page.locator('.uw-flow').isVisible(),false,'advanced tabs are hidden in quick mode');
  assert.equal(await page.locator('#q-amount').inputValue(),doc.values.amount,'quick inputs mirror the proposal fields');
  assert.match(await page.locator('#quickResult').innerText(),/Monthly payment/);
  assert.match(await page.locator('#quickVerdict').innerText(),/on recent results|until existing payments/);
  assert.equal(await page.locator('#quickDebts tbody tr').count(),2,'both synthetic liability accounts are offered as debt');
  await page.locator('#quickProposalDetails summary').click();
  // The <details> toggle event fires asynchronously after the click; the
  // preview is rendered by that handler, so wait for it rather than racing it.
  await page.waitForFunction(()=>document.getElementById('quickProposalPreview').innerText.includes('Sources and dates'));
  assert.match(await page.locator('#quickProposalPreview').innerText(),/DRAFT FINANCING PROPOSAL[\s\S]*Business performance[\s\S]*Forward outlook from the sales plan[\s\S]*Sources and dates/);
  await page.locator('#quickProposalDetails summary').click();
  await page.screenshot({path:path.join(output,'underwriting-quick.png'),fullPage:false});
  await page.locator('[data-mode="advanced"]').first().click();
  assert.equal(await page.locator('.uw-flow').isVisible(),true);
  const portfolio=portfolioFor(doc,await syntheticAccounts());
  for(const name of ['business','funding','test','review','funding'])await step(page,name);
  assert.equal(await page.locator('#currentCreditRegister tbody tr').count(),3,'multiple stable-ID facilities render');
  assert.match(await page.locator('#creditSummary').innerText(),/465K|465,000/,'documented LOC availability is $465k');
  assert.equal(await page.locator('#existingPayment').isDisabled(),true,'manual aggregate is reference-only in facility mode');
  for(const facility of syntheticFacilities)assert.equal(await page.locator(`[data-facility-panel="${facility.id}"]`).count(),1);
  await step(page,'test');
  await page.waitForSelector('#cashChart svg');
  assert.equal((await page.locator('#scenarioKpis').innerText()).includes('—'),false,'scenario metrics render after reviewed evidence');
  const firstCells=await page.locator('#debtSchedule > table > tbody > tr').first().locator('td').allTextContents();
  const existing=portfolio.rows[0].payment;
  assert.equal(firstCells[2],displayMoney(existing),'existing P&I includes facilities once');
  assert.equal(firstCells[5],displayMoney(existing),'funding month has no proposed payment or manual double count');
  const closing=Number(doc.values.startingCash)+Number(doc.values.amount)-Number(doc.values.upfrontFees)+Number(doc.values.normalizedCash)-existing-Number(doc.values.useOfProceeds);
  assert.equal(firstCells[7],displayMoney(closing),'undrawn availability is not a cash inflow');
  const baseKpis=await page.locator('#scenarioKpis').innerText();
  await page.locator('[data-preset=downside]').click();assert.notEqual(await page.locator('#scenarioKpis').innerText(),baseKpis);
  await page.locator('[data-preset=growth]').click();assert.match(await page.locator('#presetNote').innerText(),/20%/);
  await page.locator('[data-preset=base]').click();
  await step(page,'funding');await page.locator('#facilitiesComplete').uncheck();
  await step(page,'test');assert.equal(await page.locator('#cashChart svg').count(),0,'unreviewed portfolio removes cash conclusions');
  await step(page,'funding');await page.locator('#facilitiesComplete').check();
  await step(page,'test');await page.waitForSelector('#cashChart svg');
  await step(page,'funding');
  const removed=syntheticFacilities.at(-1);
  await page.locator(`[data-edit-facility="${removed.id}"]`).click();
  await page.locator(`[data-remove-facility="${removed.id}"]`).click();
  assert.equal(await page.locator('#currentCreditRegister tbody tr').count(),2);
  assert.equal(await page.locator('#facilitiesComplete').isChecked(),false,'removal invalidates portfolio review');
  await step(page,'test');assert.equal(await page.locator('#cashChart svg').count(),0);
  // Reopening the full local scenario restores the same IDs and reviewed coverage.
  await openDocument(page,doc);await step(page,'funding');
  assert.equal(await page.locator('#currentCreditRegister tbody tr').count(),3);
  assert.equal(await page.locator(`[data-facility-panel="${removed.id}"]`).count(),1);
  await page.locator('#rate').fill('0');await page.locator('#rate').dispatchEvent('change');assert.match(await page.locator('#proposalResult').innerText(),/\$0/);
  await page.locator('#rate').fill(doc.values.rate);await page.locator('#rate').dispatchEvent('change');
  await step(page,'business');
  await page.evaluate(()=>{const badge=document.createElement('div');badge.className='uw-demo';badge.textContent='DESIGN PREVIEW · SYNTHETIC COMPANY & INPUTS · NO CUSTOMER FINANCIAL DATA';document.querySelector('.uw-heading').before(badge);document.querySelector('.silo-main').scrollTop=0;});
  await page.screenshot({path:path.join(output,'underwriting-desktop.png'),fullPage:false});
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>document.querySelector('.silo-main').scrollTop=0);await page.screenshot({path:path.join(output,'underwriting-mobile.png'),fullPage:false});
  for(const name of ['business','funding','test','review']){await step(page,name);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,`${name}: no page horizontal overflow`);}
  assert.deepEqual(errors,[],'no runtime errors');
  await page.evaluate(()=>{window.__fixture.company='33333333-3333-4333-8333-333333333333';window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>document.getElementById('workspace').hidden&&document.getElementById('gate').textContent.includes('changed'));
  assert.equal(await page.locator('#amount').inputValue(),'','company change clears scenario');
  assert.equal(await page.locator('#currentCreditRegister tbody tr').count(),0,'company change clears facility records');
  await page.close();
  const {page:signedOut}=await setup();await signedOut.evaluate(()=>window.__fixtureDB.auth.signOut());assert.equal(await signedOut.locator('#workspace').isVisible(),false);await signedOut.close();
  console.log('PASS browser: v4 local import, four steps, multiple facilities, exclusive P&I, no implicit draws, review gates, remove/restore, presets, zero rate, mobile overflow, company invalidation, sign out');
  console.log(`SCREENSHOTS ${output}`);
 } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
}

if(process.argv.includes('--contract-only')) {
 await checkContract();
 console.log('PASS contract-only: complete v4 fixture, 3 facilities, $465k availability, exclusive P&I and review gates. Browser not executed.');
} else {
 await runBrowser();
}
