/* Real Backend dialog and event wiring, synthetic Supabase transport only.
 * Database enforcement is tested independently in admin-profile-owner-escalation.
 * ACTIVITY_UI_MUTATION=send-status|offer-disable must fail this suite. */
'use strict';
const assert = require('node:assert/strict');
const { startSuite } = require('../lib/harness');
const mutation = process.env.ACTIVITY_UI_MUTATION || '';
assert.ok(['','send-status','offer-disable'].includes(mutation));
(async () => {
  const suite = await startSuite({ transform(rel, source) {
    if (!rel.endsWith('backend.html')) return source;
    if (mutation === 'send-status') return source.replace('p_is_active: null,','p_is_active: true,');
    if (mutation === 'offer-disable') return source.replace('<div id="dlgStatus" class="text-sm mt-1"></div>',
      '<select id="dlgStatus"><option>active</option><option>disabled</option></select>');
    return source;
  }});
  try {
    const users = [
      {id:'test-user',name:'Admin',role:'admin',department:'ops',is_active:true},
      {id:'member',name:'Member',role:'member',department:'ops',is_active:true},
      {id:'inactive',name:'Inactive',role:'admin',department:'finance',is_active:false},
    ];
    const page = await suite.open('/v2/backend.html', {
      profiles: users, admin_list_profiles: users, admin_counts: [{}],
    }, {ready: () => document.querySelector('[data-action="edit"][data-uid="member"]')});
    for (const [id, status] of [['member','active'],['inactive','disabled']]) {
      await page.click(`[data-action="edit"][data-uid="${id}"]`);
      assert.equal(await page.locator('#dlgStatus').evaluate(e=>e.tagName),'DIV');
      assert.equal(await page.locator('#dlgStatus').textContent(),status);
      assert.equal(await page.locator('#dlgDisableBtn').count(),0);
      assert.equal(await page.locator('#userDialog a[href="/v2/settings-team.html"]').count(),1);
      await page.fill('#dlgName','Renamed '+id);
      await page.click('#dlgSaveBtn');
      await page.waitForFunction(() => document.querySelector('#dlgMsg').textContent === 'Saved.');
      const call = await page.evaluate(() => window.__QUERIES__.filter(q=>q.table==='rpc:admin_update_profile').at(-1));
      assert.equal(call.args.p_is_active,null);
      assert.equal(call.args.p_role,null);
      assert.equal(call.args.p_name,'Renamed '+id);
      await page.click('#dlgCloseBtn');
    }
    // A real RPC failure must stay visible and permit a retry.
    await page.evaluate(() => { window.__FIXTURE_RPC__.admin_update_profile = () => ({__error:{message:'fixture refusal'}}); });
    await page.click('[data-action="edit"][data-uid="member"]');
    await page.selectOption('#dlgRole','viewer');
    await page.click('#dlgSaveBtn');
    await page.waitForFunction(() => document.querySelector('#dlgMsg').textContent.includes('fixture refusal'));
    await page.evaluate(() => { window.__FIXTURE_RPC__.admin_update_profile = () => []; });
    await page.click('#dlgSaveBtn');
    await page.waitForFunction(() => document.querySelector('#dlgMsg').textContent === 'Saved.');
    const last = await page.evaluate(() => window.__QUERIES__.filter(q=>q.table==='rpc:admin_update_profile').at(-1));
    assert.equal(last.args.p_role,'viewer');
    assert.equal(last.args.p_is_active,null);
    console.log('PASS Backend activity: active/inactive saves, read-only status, Team link, role edit and error/retry');
  } finally { await suite.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
