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
(async () => {
  const suite = await startSuite();
  const screenshots = process.env.ACCOUNTING_UI_SCREENSHOTS;
  if (screenshots) fs.mkdirSync(screenshots, {recursive:true});
  try {
    for (const [name, ids] of Object.entries(PAGES)) {
      const page = await suite.open(`/v2/${name}.html`, {}, {ready:() => !!document.querySelector('[data-accounting-suite]')});
      try {
        for (const id of ids) r.eq(await page.locator(`#${id}`).count(),1,`${name}: #${id} retained once`);
        r.eq(await page.locator('body.accounting-specialist').count(),1,`${name}: scoped design`);
        if (name === 'schedules') {
          r.eq(await page.locator('.sc-bar #btnFetch').count(),1,'Fetch beside inputs');
          r.eq(await page.locator('#scheduleLedger #btnStamp').count(),1,'Create beside source selection');
          r.eq(await page.locator('#scheduleLedger #btnExclude').count(),1,'Exclude beside source selection');
        }
        for (const theme of ['light','dark']) {
          await page.evaluate(t => document.documentElement.setAttribute('data-theme',t),theme);
          for (const [width,height] of [[1440,1000],[390,844]]) {
            await page.setViewportSize({width,height});
            await page.waitForTimeout(80);
            const m = await page.evaluate(() => {
              const main = document.querySelector('.accounting-workspace');
              return {right:main.getBoundingClientRect().right,width:innerWidth,
                headers:Array.from(main.querySelectorAll('.sc-card-head,.fa-card-head,.ax-card-header')).filter(n=>n.getClientRects().length).map(n=>({width:n.getBoundingClientRect().width,scroll:n.scrollWidth})),
                hidden:Array.from(main.querySelectorAll('[hidden]')).every(n=>getComputedStyle(n).display==='none')};
            });
            r.truthy(m.right<=m.width+2,`${name} ${theme} ${width}: workspace fits`);
            r.truthy(m.headers.every(x=>x.scroll<=x.width+3),`${name} ${theme} ${width}: toolbar does not clip`);
            r.truthy(m.hidden,`${name} ${theme} ${width}: hidden states retained`);
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
