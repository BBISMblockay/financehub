'use strict';
const assert = require('node:assert/strict');
const { startSuite, fakeSupabaseScript } = require('../lib/harness');
const co = { id: 'test-company', title: 'Acme', entity_key: 'acme' };
const tables = role => ({
  profiles: [{id:'test-user',email:'test@example.com',role:'user',department:'exec',active_company_id:co.id}],
  entity_memberships: [{user_id:'test-user',entity_id:co.id,role}],
  workspace_module_visibility: [],
});
const ready = () => !!document.querySelector('#module-permission').textContent || !document.querySelector('#status').hidden;
(async () => {
  const suite = await startSuite({ secureContext: true });
  let checks = 0;
  try {
    // Actual page + shell; only transport is synthetic. Persist the one-row
    // upsert in fixture storage, including refused/zero-row responses.
    const sdk = fakeSupabaseScript().replace(
      "upsert: function (r) { q._op = 'upsert'; q.rows = r; window.__QUERIES__.push(q); return Promise.resolve({ data: r, error: null }); },",
      `upsert: function (r) {
        q._op='upsert';q.rows=r;window.__QUERIES__.push(q);
        var result;
        if(window.__REFUSE_MODULE_SAVE__) result={data:null,error:{message:'permission denied'}};
        else if(window.__ZERO_MODULE_SAVE__) result={data:null,error:null};
        else {
          var rows=window.__FIXTURE_TABLES__[table];
          var i=rows.findIndex(x=>x.company_entity_id===r.company_entity_id && x.module_id===r.module_id);
          if(i<0) rows.push(r); else rows[i]=r;
          result={data:r,error:null};
        }
        return {select:function(){return this;},single:function(){return Promise.resolve(result);}};
      },`);
    await suite.context.route('**/*supabase-js*', route => route.fulfill({contentType:'text/javascript',body:sdk}));
    for(const role of ['owner_admin','admin','member','viewer']) {
      const page = await suite.open('/v2/settings-modules.html',tables(role),{cachedCompany:co,ready});
      const switches=page.getByRole('switch');
      assert.equal(await switches.count(),5); checks++;
      assert.equal(await switches.first().isDisabled(), !['owner_admin','admin'].includes(role)); checks++;
      assert.equal(await page.locator('[data-workspace-settings] [aria-current="page"]').innerText(),'Silo Modules'); checks++;
      if(role==='admin') {
        const marketing=page.locator('input[value="marketing"]');
        await marketing.uncheck();
        await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('saved'));
        await page.waitForFunction(()=>!document.querySelector('#siloSbNav a[href="/v2/marketing-overview.html"]'));
        assert.ok(await page.locator('#siloSbNav a[href="/v2/po-builder.html"]').count()); checks++;
        await page.locator('#module-reload').click();
        await page.waitForFunction(()=>document.querySelector('#status').textContent==='Module settings loaded.');
        assert.equal(await marketing.isChecked(),false); checks++;
        const persisted=await page.evaluate(()=>window.__FIXTURE_TABLES__);
        const next=await suite.open('/v2/settings-modules.html',persisted,{cachedCompany:co,ready});
        assert.equal(await next.locator('input[value="marketing"]').isChecked(),false); checks++;
        await next.close();
        await marketing.check();
        await page.waitForFunction(()=>!!document.querySelector('#siloSbNav a[href="/v2/marketing-overview.html"]'));
        checks++;
        // The existing destination still loads with its module off.
        const direct=await suite.open('/v2/marketing-overview.html',persisted,{cachedCompany:co,ready:()=>!!document.querySelector('#silo-app')});
        assert.ok(direct.url().endsWith('/v2/marketing-overview.html')); checks++; await direct.close();
        for (const flag of ['__REFUSE_MODULE_SAVE__','__ZERO_MODULE_SAVE__']) {
          await page.evaluate(flag=>{window[flag]=true;},flag);
          await marketing.uncheck();
          await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('before retrying'));
          assert.equal(await marketing.isDisabled(),true); checks++;
          await page.evaluate(flag=>{window[flag]=false;},flag);
          await page.locator('#module-reload').click();
          await page.waitForFunction(()=>!document.querySelector('input[value="marketing"]').disabled);
          assert.equal(await marketing.isChecked(),true); checks++;
        }
        await page.evaluate(()=>{window.__FIXTURE_SERVER_COMPANY__={id:'other-company'};});
        const count=await page.evaluate(()=>window.__QUERIES__.filter(q=>q._op==='upsert').length);
        await marketing.uncheck();
        await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Workspace changed'));
        assert.equal(await page.evaluate(()=>window.__QUERIES__.filter(q=>q._op==='upsert').length),count); checks++;
      }
      await page.close();
    }
    const failed=await suite.open('/v2/settings-modules.html',tables('admin'),{cachedCompany:co,broken:['workspace_module_visibility'],ready});
    assert.equal(await failed.getByRole('switch').first().isDisabled(),true); checks++;
    assert.match(await failed.locator('#status').textContent(),/could not be loaded/); checks++;
    await failed.waitForFunction(()=>!!document.querySelector('#siloSbNav a[href="/v2/marketing-overview.html"]')); checks++;
    await failed.close();
    console.log(`${checks} browser assertions passed (actual page/shell, synthetic transport).`);
  } finally { await suite.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
