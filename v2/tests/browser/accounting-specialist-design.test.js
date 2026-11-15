/* Real specialist pages with fixture services. No financial writes. */
'use strict';
const fs = require('fs');
const path = require('path');
const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');
const r = createReporter('accounting-specialist-design');
const PAGES = {
  schedules: ['account','from','to','btnFetch','btnExclude','btnStamp','amMonth','btnBuildAmort','tblItems','tblTxns'],
  'fixed-assets': ['btnAddAsset','assetFilter','depMonth','btnBuildDep','tblAssets','tblDep'],
  'accounting-export': ['month','btnRun','btnExportRegister','btnExportJournal','btnPostAdjustment','axTabs'],
  'cash-forecast': ['currency','group','unit','horizon','lookback','trend','jump','planToggle','overrideAdd','add'],
};
// Synthetic but production-shaped rows: values are deliberately nonzero so an
// empty/error surface cannot pass as a loaded working screen.
const accounts = [
  {id:'q1',qbo_account_id:'prepaid',name:'Prepaid expenses',fully_qualified_name:'Prepaid expenses',account_type:'Other Current Asset',is_active:true},
  {id:'q2',qbo_account_id:'expense',name:'Software',fully_qualified_name:'Software',account_type:'Expense',is_active:true},
  {id:'q3',qbo_account_id:'asset',name:'Equipment',fully_qualified_name:'Equipment',account_type:'Fixed Asset',is_active:true},
];
const fixture = {
  quickbooks_accounts: accounts,
  quickbooks_report_runs: [{report_name:'GeneralLedger',status:'ok',params:{account:'prepaid'},fetched_at:'2026-11-15T00:00:00Z',raw_response:{Rows:{Row:[{ColData:[{value:'2026-11-01'},{id:'txn-1',value:'Bill'},{value:''},{value:'Cloud software'},{value:'Annual subscription'},{value:''},{value:'1200'},{value:'1200'}]}]}}}],
  schedule_item_balances_v:[{schedule_item_id:'schedule-1',qbo_account_id:'prepaid',label:'Annual hosting',schedule_type:'prepaid',total_amount:1200,recognized_to_date:200,remaining_balance:1000,service_start:'2026-09-01',service_end:'2027-08-31',months:12,periods_elapsed:2}],
  schedule_items:[{id:'schedule-1',qbo_expense_account_id:'expense',qbo_expense_account_name:'Software'}],
  fixed_asset_balances_v:[{fixed_asset_id:'asset-1',label:'Warehouse scanner',qbo_asset_account_id:'asset',qbo_asset_account_name:'Equipment',status:'active',cost:2400,depreciable_base:2400,accumulated_depreciation:400,net_book_value:2000,months:24,periods_elapsed:4,depreciation_start:'2026-07-01',depreciation_end:'2028-06-30'}],
  fixed_assets:[{id:'asset-1',in_service_date:'2026-07-01',useful_life_months:24,salvage_value:0,vendor_name:'Scanner supplier',qbo_depreciation_expense_account_id:'expense',qbo_depreciation_expense_account_name:'Software',qbo_accum_depreciation_account_id:'asset',qbo_accum_depreciation_account_name:'Equipment'}],
  plaid_connections:[{id:'bank-connection',institution_name:'Fixture bank',status:'active'}],
  plaid_accounts:[{id:'bank-1',connection_id:'bank-connection',name:'Operating checking',mask:'1234',type:'depository',subtype:'checking',iso_currency_code:'USD',current_balance:25000,balance_updated_at:'2026-11-15T00:00:00Z',last_synced_at:'2026-11-15T00:00:00Z'}],
  accounting_settings:[{base_currency:'USD'}],
  cash_forecast_items:[{id:'plan-1',label:'November rent',category:'Rent',amount:-3000,kind:'one_time',cadence:'once',start_date:'2026-11-20',is_active:true,account_id:'bank-1'}],
  shopify_connections:[{shop_domain:'fixture.myshopify.com',shop_name:'Fixture shop'}],
  shopify_payouts:[{id:'payout-1',shop_domain:'fixture.myshopify.com',payout_date:'2026-11-10',status:'paid',amount_net:970,charges_gross:1000,charges_fee:30,refunds_gross:0,refunds_fee:0,adjustments_gross:0,adjustments_fee:0}],
};
const rpc = {
  silo_business_today: ()=>'2026-11-15',
  can_manage_journal_entries: ()=>true,
  is_exec_or_owner: ()=>true,
  accounting_sales_buckets: ()=>[{location_tag:'online',location_name:'Online store',gross:1000,discounts:0,refunds:0,shipping:0,taxes:0,total:1000}],
};
async function exercise(page,name) {
  if(name==='schedules') {
    await page.waitForFunction(()=>document.querySelector('#tblItems').textContent.includes('Annual hosting'));
    r.has(await page.locator('#tblItems').innerText(),'1,000','Populated remaining balance');
    await page.locator('#tblTxns [data-txn]').first().check();
    r.truthy(await page.locator('#btnStamp').isEnabled(),'Selection enables schedule action');
    r.truthy(await page.locator('#btnExclude').isEnabled(),'Selection enables exclude action');
    await page.locator('#btnStamp').click();
    await page.locator('#dlg').waitFor({state:'visible'});
    r.has(await page.locator('#dlgPreview').innerText(),'1,200','Selected transaction preview');
    await page.locator('#dlg button[value="cancel"]').click();
    r.truthy(await page.locator('#tblTxns [data-txn]').first().isChecked(),'Cancel preserves selection');
    await page.locator('#tblTxns [data-txn]').first().uncheck();
    r.truthy(await page.locator('#btnStamp').isDisabled(),'Cleared selection disables action');
  } else if(name==='fixed-assets') {
    await page.waitForFunction(()=>document.querySelector('#tblAssets').textContent.includes('Warehouse scanner'));
    r.has(await page.locator('#tblAssets').innerText(),'2,000','Populated net book value');
    await page.locator('#assetFilter').fill('no such asset');
    await page.waitForFunction(()=>document.querySelector('#tblAssets').textContent.includes('No assets match'));
    await page.locator('#assetFilter').fill('scanner');
    await page.waitForFunction(()=>document.querySelector('#tblAssets').textContent.includes('Warehouse scanner'));
    await page.locator('#btnAddAsset').click();
    await page.locator('#dlg').waitFor({state:'visible'});
    await page.locator('#dlg button[value="cancel"]').click();
    r.has(await page.locator('#tblAssets').innerText(),'Warehouse scanner','Cancel leaves loaded register intact');
    await page.locator('#assetFilter').fill('');
  } else if(name==='accounting-export') {
    await page.locator('#month').fill('2026-11');
    await page.locator('#btnRun').click();
    await page.waitForFunction(()=>document.querySelector('#kpiTotal').textContent.includes('1,000'));
    await page.locator('#axTabs [data-pane="register"]').click();
    await page.locator('section[data-pane="register"]').waitFor({state:'visible'});
    r.has(await page.locator('section[data-pane="register"]').innerText(),'2026-11-10','Payout detail survives view switch');
    await page.locator('#axTabs [data-pane="journal"]').click();
    r.has(await page.locator('section[data-pane="journal"]').innerText(),'Online store','Return retains loaded journal');
  } else {
    await page.waitForFunction(()=>document.querySelector('#accounts').textContent.includes('Operating checking'));
    await page.waitForFunction(()=>document.querySelector('#matrix').textContent.trim().length>20);
    r.has(await page.locator('#accounts').innerText(),'Operating checking','Loaded connected account');
    await page.locator('#planToggle').click();
    await page.locator('#planDrawer').waitFor({state:'visible'});
    await page.locator('#planClose').click();
    r.truthy(await page.locator('#planDrawer').isHidden(),'Close restores forecast workspace');
    await page.locator('#unit').selectOption('month');
    r.eq(await page.locator('#unit').inputValue(),'month','Forecast grouping control works');
  }
  const writes=await page.evaluate(()=>(window.__QUERIES__||[]).filter(q=>['insert','update','upsert','delete'].includes(q._op)));
  r.eq(writes,[],'Review/cancel interactions issue no data writes');
}
(async () => {
  const suite = await startSuite();
  const screenshots = process.env.ACCOUNTING_UI_SCREENSHOTS;
  if (screenshots) fs.mkdirSync(screenshots, {recursive:true});
  try {
    for (const [name, ids] of Object.entries(PAGES)) {
      const page = await suite.open(`/v2/${name}.html`, fixture, {rpc,ready:() => !!document.querySelector('[data-accounting-suite]')});
      try {
        for (const id of ids) r.eq(await page.locator(`#${id}`).count(),1,`${name}: #${id} retained once`);
        r.eq(await page.locator('body.accounting-specialist').count(),1,`${name}: scoped design`);
        if (name === 'schedules') {
          r.eq(await page.locator('.sc-bar #btnFetch').count(),1,'Fetch beside inputs');
          r.eq(await page.locator('#scheduleLedger #btnStamp').count(),1,'Create beside source selection');
          r.eq(await page.locator('#scheduleLedger #btnExclude').count(),1,'Exclude beside source selection');
        }
        await exercise(page,name);
        for (const theme of ['light','dark']) {
          await page.evaluate(t => document.documentElement.setAttribute('data-theme',t),theme);
          for (const [width,height] of [[1440,1000],[390,844]]) {
            await page.setViewportSize({width,height});
            await page.waitForTimeout(80);
            const m = await page.evaluate(() => {
              const main = document.querySelector('.accounting-workspace');
              return {right:main.getBoundingClientRect().right,width:innerWidth,
                headers:Array.from(main.querySelectorAll('.sc-card-head,.fa-card-head,.ax-card-header')).filter(n=>n.getClientRects().length).map(n=>({width:n.getBoundingClientRect().width,scroll:n.scrollWidth})),
                visibleHidden:Array.from(main.querySelectorAll('[hidden]')).filter(n=>getComputedStyle(n).display!=='none').map(n=>n.id||n.className||n.tagName)};
            });
            r.truthy(m.right<=m.width+2,`${name} ${theme} ${width}: workspace fits`);
            r.truthy(m.headers.every(x=>x.scroll<=x.width+3),`${name} ${theme} ${width}: toolbar does not clip`);
            r.eq(m.visibleHidden,[],`${name} ${theme} ${width}: hidden states retained (leaking element IDs/classes)`);
            if (screenshots) await page.screenshot({path:path.join(screenshots,`${name}-${theme}-${width}.png`),fullPage:true});
          }
        }
        const help=page.locator('.as-help').first();
        if(await help.count()) {
          await help.locator('summary').click();
          r.truthy(await help.evaluate(n=>n.open),`${name}: mechanics expand`);
          await help.locator('summary').click();
          r.truthy(!(await help.evaluate(n=>n.open)),`${name}: mechanics collapse`);
        }
        r.ok(`${name}: controls, responsive layout, themes and disclosure`,true);
      } catch(error) {r.ok(`${name}: specialist workspace`,false,error.message);}
      finally {await page.close();}
    }
  } finally {await suite.close();}
  process.exit(r.summary().fail?1:0);
})();
