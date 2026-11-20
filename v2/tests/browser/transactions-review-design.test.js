/* Real register and fixture rows. No live accounting writes. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {startSuite}=require('../lib/harness');
// Dates inside the page's default period (this month), so the register's own
// date presets load them without the suite driving the date form.
const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const day = (n) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(Math.min(n, 28))}`;

const CONNECTION = 'conn-1';
const SOURCE = 'src-1';
const BATCH = 'batch-1';

const accounts = [
  { qbo_account_id: 'acc_rent', name: 'Lease & Rent', fully_qualified_name: 'Lease & Rent', account_type: 'Expense', account_sub_type: 'Rent', is_active: true, connection_id: CONNECTION },
  { qbo_account_id: 'acc_int', name: 'Interest Expense', fully_qualified_name: 'Interest Expense', account_type: 'Expense', account_sub_type: 'Interest', is_active: true, connection_id: CONNECTION },
  { qbo_account_id: 'acc_loan', name: 'Biz2Credit Loan', fully_qualified_name: 'Biz2Credit Loan', account_type: 'Other Current Liability', account_sub_type: 'Loan', is_active: true, connection_id: CONNECTION },
];

const txn = (over) => Object.assign({
  company_entity_id: 'test-company', batch_id: BATCH, row_no: 1,
  txn_date: day(5), description: 'A CHARGE', clean_merchant: null, amount: 10,
  status: 'uncoded', coding_source: null, confidence: null, coding_conflict: null,
  accounting_treatment: 'purchase', origin: 'csv', provider_status: null,
  qbo_account_id: null, qbo_account_name: null, qbo_location_id: null,
  qbo_location_name: null, entity_qbo_id: null, entity_name: null, entity_type: null,
  card_name: 'Ops', cardholder: null, cardholder_email: null, memo: null,
  vendor_name: null, exclude_reason: null, currency: 'USD', last4: null,
  external_transaction_id: null, rule_id: null, ai_reasoning: null, raw: {},
}, over);

const transactions = [
  txn({ id: 't-amazon', row_no: 1, txn_date: day(4), description: 'AMZN Mktp US*2A4XY9',
    clean_merchant: 'Amazon', amount: 120.5, status: 'coded', coding_source: 'manual',
    qbo_account_id: 'acc_rent', qbo_account_name: 'Lease & Rent' }),
  txn({ id: 't-loan', row_no: 2, txn_date: day(6), description: 'BIZ2CREDIT PAYMENT',
    clean_merchant: null, amount: 25187.68, status: 'coded', coding_source: 'manual' }),
  txn({ id: 't-refund', row_no: 3, txn_date: day(8), description: 'RETURN CREDIT 8841',
    clean_merchant: 'Amazon', amount: -45.25, accounting_treatment: 'refund',
    status: 'coded', coding_source: 'manual', qbo_account_id: 'acc_rent', qbo_account_name: 'Lease & Rent' }),
  txn({ id: 't-bare', row_no: 4, txn_date: day(10), description: 'CHECKCARD 0412 SQ *TST',
    clean_merchant: null, amount: 62 }),
  txn({ id: 't-comcast', row_no: 5, txn_date: day(12), description: 'COMCAST BUSINESS',
    clean_merchant: 'Comcast', amount: 310 }),
  // The same merchant under a second casing, which production really carries:
  // Portland General Electric, Wave Pro and TikTok Ads each appear both ways.
  txn({ id: 't-comcast-caps', row_no: 6, txn_date: day(14), description: 'COMCAST BUSINESS',
    clean_merchant: 'COMCAST', amount: 320 }),
];

const splitLines = [
  { id: 's1', company_entity_id: 'test-company', transaction_id: 't-loan', line_no: 1, amount: 22000,
    qbo_account_id: 'acc_loan', qbo_account_name: 'Biz2Credit Loan', qbo_location_id: null,
    qbo_location_name: null, entity_qbo_id: null, entity_type: null, memo: 'principal' },
  { id: 's2', company_entity_id: 'test-company', transaction_id: 't-loan', line_no: 2, amount: 3187.68,
    qbo_account_id: 'acc_int', qbo_account_name: 'Interest Expense', qbo_location_id: null,
    qbo_location_name: null, entity_qbo_id: null, entity_type: null, memo: 'interest' },
];

// 60 rules, so 25-per-page paging has three pages and 10-per-page has six.
const codingRules = Array.from({ length: 60 }, (_, i) => ({
  id: 'rule-' + i, company_entity_id: 'test-company', source_id: SOURCE,
  match_field: i % 3 === 0 ? 'card_name' : 'merchant',
  match_type: i % 2 === 0 ? 'normalized' : 'contains',
  pattern: (i === 7 ? 'sugar hill' : 'vendor ' + i),
  qbo_account_id: i % 2 ? 'acc_rent' : 'acc_int',
  qbo_account_name: i % 2 ? 'Lease & Rent' : 'Interest Expense',
  entity_qbo_id: null, entity_name: null, qbo_location_id: null, qbo_location_name: null,
  direction: 'outflow', accounting_treatment: 'purchase', is_active: true,
  priority: 100, hit_count: i,
}));

const TABLES = {
  card_sources: [{
    id: SOURCE, company_entity_id: 'test-company', display_name: 'Amex Platinum',
    source_key: 'amex', source_type: 'card', is_active: true, ingest_mode: 'csv',
    qbo_connection_id: CONNECTION, posting_enabled: false, column_map: {},
    credit_account_name: 'Amex', credit_account_type: 'Credit Card',
    default_qbo_location_id: null, authoritative_from: null,
  }],
  quickbooks_accounts: accounts,
  quickbooks_locations: [{ qbo_location_id: 'loc_hq', name: 'HQ', fully_qualified_name: 'HQ', is_active: true, connection_id: CONNECTION }],
  quickbooks_customers: [],
  quickbooks_vendors: [],
  card_import_batches_v: [{
    id: BATCH, company_entity_id: 'test-company', source_id: SOURCE, source_name: 'Amex Platinum',
    source_key: 'amex', label: 'September', file_name: 'amex.csv', status: 'draft',
    created_at: day(1) + 'T00:00:00Z', entry_date: day(28), period_start: day(1), period_end: day(28),
    total_amount: 0, txn_count: transactions.length, uncoded_count: 2, excluded_count: 0,
    coded_amount: 0, qbo_journal_entry_id: null, qbo_doc_number: null, posting_status: null,
    posting_id: null, qbo_connection_id: CONNECTION, origin: 'csv', feed_sequence: null,
    approved_at: null, approved_by: null, approval_version: null, approval_hash: null,
    source_posting_enabled: false,
  }],
  card_transactions: transactions,
  card_transaction_splits: splitLines,
  card_coding_rules: codingRules,
  card_split_rules: [{
    id: 'split-rule-1', company_entity_id: 'test-company', source_id: SOURCE,
    match_field: 'merchant', pattern: 'biz2credit', priority: 100, hit_count: 4,
  }],
  card_split_rule_lines: [
    { rule_id: 'split-rule-1', line_no: 1, qbo_account_id: 'acc_loan', qbo_account_name: 'Biz2Credit Loan' },
    { rule_id: 'split-rule-1', line_no: 2, qbo_account_id: 'acc_int', qbo_account_name: 'Interest Expense' },
  ],
  profiles: [{ id: 'test-user', name: 'Test', email: 'test@baseballism.com', role: 'owner', department: 'finance' }],
};


(async()=>{
 const suite=await startSuite();
 try {
  const page=await suite.open('/v2/transactions.html',TABLES,{ready:()=>document.querySelectorAll('#tblCoding .txn-row').length>0});
  fs.mkdirSync('/tmp/accounting-suite-ui',{recursive:true});
  for(const theme of ['light','dark']) {
   await page.setViewportSize({width:1600,height:1100});
   await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
   await page.click('#codeFilterSegments [data-code-filter="all"]');
   assert.equal(await page.locator('.txn-card-head .txn-sr-only').innerText(),'Review transactions');
   assert.equal(await page.locator('#codeSearch').getAttribute('aria-label'),'Search transactions');
   const geometry=()=>page.locator('.transaction-list').evaluate(n=>({width:n.getBoundingClientRect().width,scroll:n.querySelector('.cc-body').scrollTop}));
   const before=await geometry();
   const row=page.locator('#tblCoding [data-txn="t-amazon"]');
   await row.locator('[data-review]').first().click();
   assert.equal(await page.locator('#txnDetailDrawer').isVisible(),true);
   assert.equal(await page.locator('#txnDetailDrawer').getAttribute('role'),'dialog');
   assert.equal(await page.locator('#txnDetailDrawer').getAttribute('aria-modal'),'false');
   assert.equal(await page.locator('#btnTxnDetailClose').evaluate(n=>n===document.activeElement),true,'keyboard lands in inspector');
   await page.keyboard.press('Tab');
   assert.equal(await page.locator('#txnDetailDrawer').evaluate(n=>n.contains(document.activeElement)),true,'next tab reaches detail action');
   assert.equal((await geometry()).width,before.width,'drawer does not reserve a permanent column');
   assert.equal((await geometry()).scroll,before.scroll,'opening detail preserves the register position');
   for(const selector of ['[data-raw]','[data-journal]','[data-split]','[data-toggle-exclude]','[data-edit="location"]'])
    assert.equal(await page.locator('#txnDetailBody '+selector).isVisible(),true,selector+' is retained');
   await page.screenshot({path:`/tmp/accounting-suite-ui/transactions-detail-${theme}.png`,fullPage:true});
   await page.click('#btnTxnDetailClose');
   assert.equal(await page.locator('#txnDetailDrawer').isVisible(),false);
   assert.equal(await row.locator('[data-review]').first().evaluate(n=>n===document.activeElement),true,'Close restores recreated opener');
   await page.keyboard.press('Enter');
   await page.keyboard.press('Escape');
   assert.equal(await page.locator('#txnDetailDrawer').isVisible(),false);
   assert.equal(await row.locator('[data-review]').first().evaluate(n=>n===document.activeElement),true,'Escape restores opener');
   assert.equal((await geometry()).width,before.width);
   assert.equal((await geometry()).scroll,before.scroll);
   assert.ok(await page.locator('#tblCoding thead th').count()>=10,'bookkeeper columns remain in wide table');
   await page.screenshot({path:`/tmp/accounting-suite-ui/transactions-wide-${theme}.png`,fullPage:true});
   await page.setViewportSize({width:390,height:1000});
   await page.keyboard.press('Escape');
   await page.waitForFunction(()=>document.querySelector('.silo-sidebar').getBoundingClientRect().right<=1);
   await row.locator('[data-review]').first().click();
   const drawer=await page.locator('#txnDetailDrawer').boundingBox();
   assert.ok(drawer.x>=0&&drawer.x+drawer.width<=391,'drawer stays inside phone');
   await page.screenshot({path:`/tmp/accounting-suite-ui/transactions-detail-phone-${theme}.png`,fullPage:true});
   await page.click('#btnTxnDetailClose');
   await page.locator('.transaction-list .txn-card-head').scrollIntoViewIfNeeded();
   await page.screenshot({path:`/tmp/accounting-suite-ui/transactions-phone-${theme}.png`,fullPage:true});
  }
  // Populated review -> save -> approval -> explicit posting confirmation.
  // All database and edge writes are intercepted by the fixture harness.
  const flow=structuredClone(TABLES);
  flow.card_transactions=[{...flow.card_transactions[3],id:'workflow-row',row_no:1}];
  flow.card_transaction_splits=[];
  Object.assign(flow.card_sources[0],{posting_enabled:true,credit_qbo_account_id:'credit',credit_account_name:'Amex'});
  flow.quickbooks_accounts.push({qbo_account_id:'credit',name:'Amex',account_type:'Credit Card',is_active:true,connection_id:CONNECTION});
  Object.assign(flow.card_import_batches_v[0],{txn_count:1,uncoded_count:1,source_posting_enabled:true});
  const work=await suite.open('/v2/transactions.html?batch=batch-1',flow,{
   ready:()=>!!document.querySelector('#tblCoding [data-txn="workflow-row"]'),
   rpc:{
    apply_card_coding:args=>{
     window.__saveAttempts=(window.__saveAttempts||0)+1;
     if(window.__saveAttempts===1)return {__error:{message:'Fixture save temporarily unavailable'}};
     const tables=window.__FIXTURE_TABLES__;
     for(const patch of args.p_rows)Object.assign(tables.card_transactions.find(t=>t.id===patch.id),patch);
     tables.card_import_batches_v[0].uncoded_count=0;
     return args.p_rows.length;
    },
    approve_card_import_batch:args=>{
     const b=window.__FIXTURE_TABLES__.card_import_batches_v.find(b=>b.id===args.p_batch_id);
     b.status='approved';b.approved_at=new Date().toISOString();return true;
    }
   },
   edge:{'quickbooks-post-journal':{status:503,body:{error:'Fixture posting unavailable'}}}
  });
  const wrow=work.locator('#tblCoding [data-txn="workflow-row"]');
  await wrow.locator('[data-edit="account"]').click();
  await wrow.locator('select[data-field="account"]').selectOption('acc_rent');
  await work.click('#ccTabs [data-pane="entry"]');
  assert.equal(await work.locator('#btnApprove').isDisabled(),true,'unsaved edit blocks approval');
  await work.click('#ccTabs [data-pane="coding"]');
  await work.click('#btnSaveCoding');
  await work.waitForFunction(()=>document.getElementById('status').textContent.includes('Fixture save temporarily unavailable'));
  assert.match(await work.locator('#unsavedCount').innerText(),/1/,'failure retains edit');
  await work.click('#btnSaveCoding');
  await work.waitForFunction(()=>document.getElementById('status').textContent.includes('Saved 1'));
  const saveCalls=await work.evaluate(()=>window.__QUERIES__.filter(q=>q.table==='rpc:apply_card_coding').map(q=>q.args));
  assert.equal(saveCalls.length,2);assert.equal(saveCalls[1].p_rows[0].qbo_account_id,'acc_rent');
  await work.click('#ccTabs [data-pane="entry"]');
  await work.locator('#tblEntry [data-entry-batch="batch-1"]').click();
  assert.equal(await work.locator('#btnPost').isDisabled(),true,'saving is not approval');
  assert.equal(await work.locator('#btnApprove').isEnabled(),true);
  await work.click('#btnApprove');
  await work.waitForFunction(()=>!document.getElementById('btnPost').disabled);
  assert.equal(await work.evaluate(()=>window.__QUERIES__.filter(q=>q.table==='rpc:approve_card_import_batch').length),1);
  work.once('dialog',d=>d.dismiss());
  await work.click('#btnPost');
  assert.equal(await work.evaluate(()=>window.__EDGE_CALLS__.length),0,'cancel sends nothing');
  work.once('dialog',d=>d.accept());
  await work.click('#btnPost');
  await work.waitForFunction(()=>document.getElementById('status').textContent.includes('Fixture posting unavailable'));
  assert.deepEqual(await work.evaluate(()=>window.__EDGE_CALLS__),[{name:'quickbooks-post-journal',body:{batch_id:'batch-1'}}]);
  assert.match(await work.locator('#status').innerText(),/Post failed/,'failed posting is not shown as success');
  console.log('PASS transaction design: retained fields, wide register, overlay drawer, themes, mobile.');
 } finally {await suite.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
