'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {startSuite}=require('../lib/harness');
const fixtures=()=>({
 accounting_settings:[{qbo_connection_id:'qbo',bookkeeping_mode:'silo',accounting_start_date:'2026-08-01',accounting_basis:'Accrual',fiscal_year_start_month:1}],
 accounting_qbo_connections:[{id:'qbo',company_name:'Example Company',environment:'production',accounts_synced_at:'2026-11-12T09:00:00Z'}],
 accounting_accounts:[{id:'a',name:'Operating checking',account_type:'Bank',qbo_account_id:'bank',is_active:true}],
 plaid_connections:[{id:'p',institution_name:'Example Bank',status:'active'}],
 card_sources:[{id:'s',source_key:'checking',display_name:'Operating checking',source_type:'bank',ingest_mode:'plaid',is_active:true,qbo_connection_id:'qbo',credit_qbo_account_id:'bank'}],
 can_manage_journal_entries:[true],is_exec_or_owner:[true],silo_business_today:['2026-11-12']
});
const ready=()=>window.SiloBooks&&document.getElementById('setupMappingStatus').textContent.includes('1 of 1');
(async()=>{const suite=await startSuite();try{
 const p=await suite.open('/v2/accounting-books.html#setup',fixtures(),{ready});
 assert.equal(await p.locator('#openingSetup').getAttribute('open'),null);
 assert.equal(await p.locator('[data-mode-disclosure]').getAttribute('open'),null);
 assert.match(await p.locator('[data-mode-state]').innerText(),/SILO keeps/);
 assert.equal(await p.locator('#seedForm').isVisible(),false);
 await p.click('#openingSetup > summary');assert.equal(await p.locator('#seedForm').isVisible(),true);
 await p.click('#openingSetup > summary');
 await p.click('a[href="#accounts"]');await p.locator('#accountsTable').waitFor({state:'visible'});
 await p.goBack();await p.waitForURL(/#setup$/);await p.locator('#setupQboStatus').waitFor({state:'visible'});
 // Collapse before Forward so this verifies that hash routing opens it again.
 await p.locator('#accounts [data-subsection] > summary').click();
 await p.goForward();await p.waitForURL(/#accounts$/);await p.locator('#accountsTable').waitFor({state:'visible'});
 await p.click('[data-surface="ledger"]');assert.equal(await p.locator('#ledger').isVisible(),true);
 await p.click('[data-surface="register"]');assert.equal(await p.locator('#register').isVisible(),true);
 await p.click('[data-surface="setup"]');
 await p.click('[data-mode-disclosure] > summary');assert.equal(await p.locator('[data-save-mode]').isVisible(),true);
 await p.click('[data-mode-disclosure] > summary');
 fs.mkdirSync('/tmp/accounting-qa',{recursive:true});
 for(const theme of ['light','dark'])for(const width of [1440,390]){
  await p.evaluate(t=>document.documentElement.dataset.theme=t,theme);await p.setViewportSize({width,height:1000});
  // The real shell handles Escape; never remove drawer classes in a fixture.
  await p.keyboard.press('Escape');
  await p.waitForFunction(()=>!document.getElementById('silo-app').classList.contains('silo-nav-open'));
  const clearAtCenter=selector=>p.waitForFunction(sel=>{
   const n=document.querySelector(sel);if(!n)return false;const r=n.getBoundingClientRect();
   const x=r.left+r.width/2,y=r.top+r.height/2;
   return x>0&&x<innerWidth&&y>0&&y<innerHeight&&n.contains(document.elementFromPoint(x,y));
  },selector);
  await p.locator('#setupQboStatus').scrollIntoViewIfNeeded();await clearAtCenter('#setupQboStatus');
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${theme} ${width} overflow`);
  await p.screenshot({path:`/tmp/accounting-qa/setup-${theme}-${width}.png`,fullPage:true});
  await p.locator('#openingSetup > summary').scrollIntoViewIfNeeded();await clearAtCenter('#openingSetup > summary');
  await p.screenshot({path:`/tmp/accounting-qa/setup-${theme}-${width}-lower.png`,fullPage:true});
 }
 const linked=await suite.open('/v2/accounting-books.html#openingSetup',fixtures(),{ready});
 await linked.locator('#seedForm').waitFor({state:'visible'});
 assert.equal(await linked.locator('#openingSetup').getAttribute('open'),'');
 await linked.close();
 const failed=await suite.open('/v2/accounting-books.html#setup',fixtures(),{broken:['plaid_connections'],ready:()=>document.getElementById('setupBankStatus').textContent.includes('could not be read')});
 assert.equal(await failed.locator('#setupMappingStatus').isVisible(),true);
 assert.match(await failed.locator('#setupBankStatus').innerText(),/could not be read/);
 console.log('PASS setup: actual boot, disclosures, chart hash, ledger/register, mode editor, provider failure, light/dark desktop/mobile');
}finally{await suite.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
