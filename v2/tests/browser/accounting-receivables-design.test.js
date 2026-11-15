/* Populated real screens, synthetic read services; never approve/send/post. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {startSuite} = require('../lib/harness');
const {tables} = require('../lib/payments-fixtures');
const {fixtures,rpc} = require('../fixtures/accounting-overview');
const customer = {id:'wholesale-demo',company_entity_id:'test-company',legal_name:'North Coast Supply',account_type:'wholesale',status:'submitted',contact_email:'buyer@example.test',primary_contact_first_name:'Alex',primary_contact_last_name:'Sample',primary_contact_email:'buyer@example.test',requested_payment_terms:'Net 30',credit_limit:5000,has_card_on_file:false,created_at:'2026-11-01T00:00:00Z'};
(async()=>{
 const suite=await startSuite();
 const out=process.env.ACCOUNTING_UI_SCREENSHOTS;
 if(out)fs.mkdirSync(out,{recursive:true});
 async function capture(page,name) {
  for(const theme of ['light','dark']) for(const width of [1440,390]) {
   await page.setViewportSize({width,height:1000});
   await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
   await page.keyboard.press('Escape');
   if(width<900) await page.waitForFunction(()=>document.querySelector('.silo-sidebar').getBoundingClientRect().right<=1);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${name} ${theme} ${width} fits viewport`);
   if(out)await page.screenshot({path:path.join(out,`${name}-${theme}-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
 }
 try {
  const invoices=await suite.open('/v2/invoicing.html',tables(),{ready:()=>document.querySelector('#invoiceCount')?.textContent==='4 of 4'});
  assert.match(await invoices.locator('#tblInvoices').innerText(),/North Coast Supply/);
  await invoices.locator('#invoiceSearch').fill('cedar');
  assert.equal(await invoices.locator('#invoiceCount').innerText(),'1 of 4');
  await invoices.locator('#invoiceSearch').fill('');
  await capture(invoices,'invoices-populated');
  await invoices.getByRole('button',{name:'View invoice draft',exact:true}).click();
  assert.equal(await invoices.locator('#invoiceDetail [data-act="finalize"]').count(),1);
  assert.equal(await invoices.locator('#invoiceDetail [data-act="send"]').count(),1);
  if(out)await invoices.screenshot({path:path.join(out,'invoice-draft-detail.png'),fullPage:true});
  await invoices.keyboard.press('Escape');
  const customers=await suite.open('/v2/customers.html',{
   ...tables(),customer_accounts_v:[customer,{...customer,id:'approved-demo',legal_name:'Cedar Athletics',status:'approved',approved_payment_terms:'Net 15',has_card_on_file:true,card_brand:'visa',card_last4:'4242'}],
   customer_account_addresses_resolved_v:[],customer_account_tax_profiles:[],customer_account_activity:[]
  },{rpc:{is_owner_admin_of_active_company:()=>false},ready:()=>document.querySelector('#kpiSubmitted')?.textContent==='1'});
  assert.match(await customers.locator('#table').innerText(),/Net 15/);
  await customers.locator('#statusFilter').selectOption('submitted');
  assert.equal(await customers.locator('#table [data-open]').count(),1);
  await customers.locator('#statusFilter').selectOption('');
  await customers.locator('#search').fill('Cedar');
  assert.equal(await customers.locator('#table [data-open]').count(),1);
  await customers.locator('#search').fill('');
  await capture(customers,'customers-populated');
  await customers.locator('[data-open="wholesale-demo"]').click();
  await customers.waitForFunction(()=>document.querySelector('#drawer').dataset.open==='1');
  assert.equal(await customers.locator('#dTerms').inputValue(),'Net 30');
  assert(await customers.locator('#dApprove').isVisible());
  assert(await customers.locator('#dReject').isVisible());
  if(out)await customers.screenshot({path:path.join(out,'customer-application-detail.png'),fullPage:true});
  const month=await suite.open('/v2/accounting-month-end.html?month=2026-11',fixtures(),{rpc,ready:()=>document.querySelector('#workspaceContent')?.getAttribute('aria-busy')==='false'});
  assert.match(await month.locator('#workspaceContent').innerText(),/November adjustment/);
  await capture(month,'month-end-populated');
  for(const key of ['journals','reports','specialists','activity']) {
   await month.locator(`[data-check="${key}"]`).click();
   assert.equal(await month.locator(`[data-check="${key}"]`).getAttribute('aria-pressed'),'true');
   assert(await month.locator('#reviewDetail a').count()>0);
  }
  assert.equal(await month.locator('#reviewDetail a[href*="nov-draft"]').count(),1);
  if(out)await month.screenshot({path:path.join(out,'month-end-review-detail.png'),fullPage:true});
  for(const p of [invoices,customers,month]) {
   const mutations=await p.evaluate(()=>(window.__QUERIES__||[]).filter(q=>['insert','update','delete','upsert'].includes(q._op)));
   assert.deepEqual(mutations,[],'design review performs no financial writes');
   assert.deepEqual(await p.evaluate(()=>window.__INVOKES__||[]),[],'no external sends or posting');
  }
  console.log('PASS populated receivables and month-end layouts, filters, review details, themes and mobile contracts');
 } finally {await suite.close();}
})();
