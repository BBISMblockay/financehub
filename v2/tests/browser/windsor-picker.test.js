'use strict';
// Real page and picker, mocked auth/database/broker only. No production requests.
const assert = require('node:assert/strict');
const { startSuite } = require('../lib/harness');
(async () => {
  const suite = await startSuite({ secureContext: true });
  const calls = [];
  let failPreview = false;
  let legacyConnector = false;
  let catalogMode = 'current';
  let releaseCatalog;
  let delayed = false;
  let failSync = false;
  let blockUnplaceable = true;
  let failMcp = false;
  const fields = [{ id: 'account_id', name: 'Account ID', type: 'TEXT' },
    { id: 'date', name: 'Date', type: 'DATE' },
    { id: 'watch_minutes', name: 'Minutes watched', type: 'NUMERIC' }];
  await suite.context.route('**/functions/v1/windsor-broker', async (route) => {
    const body = route.request().postDataJSON(); calls.push(body);
    let status = 200; let data;
    if (body.action === 'status') data = { configured: true };
    if (body.action === 'connector_catalog') data = { connectors: [{ id: 'youtube', name: 'YouTube' }, { id: 'new_source', name: 'New Source' }] };
    if (body.action === 'connector_catalog' && legacyConnector) { status = 400; data = { error: 'Unknown action' }; }
    if (body.action === 'mint_link') data = { source: body.source, url: 'https://onboard.windsor.ai/?token=fixture' };
    if (body.action === 'field_catalog') {
      if (delayed && body.linked_account_id === 'a') await new Promise((resolve) => { releaseCatalog = resolve; });
      data = { fields: body.linked_account_id === 'a' ? fields : fields.slice(0, 2),
        default_fields: body.linked_account_id === 'a' ? fields.map((f) => f.id) : ['account_id', 'date'] };
      if (catalogMode === 'legacy') data = { numeric_fields: [fields[2]], total_fields: 100, kind: 'fixed' };
      if (catalogMode === 'missing_identity') data = { fields: [fields[2]], default_fields: [] };
      if (catalogMode === 'bad_defaults') data = { fields, default_fields: [] };
    }
    if (body.action === 'set_sync') {
      data = { sync_enabled: body.enabled };
      // A source whose rows cannot be placed is refused when the toggle is
      // pressed, not hidden from the page: the reason comes back with it.
      if (blockUnplaceable && body.enabled && body.linked_account_id === 'b') {
        status = 409;
        data = { error: 'Sync blocked: Windsor lists no date and account for this source, so a row cannot be placed.' };
      } else if (failSync) { status = 503; data = { error: 'Could not save sync setting' }; }
      else await route.request().frame().evaluate(({ id, enabled }) => {
        window.__FIXTURE_TABLES__.windsor_linked_accounts.find(a => a.id === id).sync_enabled = enabled;
      }, { id: body.linked_account_id, enabled: body.enabled });
    }
    if (body.action === 'set_mcp') {
      data = {mcp_enabled:body.enabled};
      if (failMcp) {status=503;data={error:'Could not save LLM access'};}
      else await route.request().frame().evaluate(({id,enabled}) => {
        window.__FIXTURE_TABLES__.windsor_linked_accounts.find(a => a.id===id).mcp_enabled=enabled;
      },{id:body.linked_account_id,enabled:body.enabled});
    }
    if (body.action === 'preview') {
      if (failPreview) { status = 409; data = { error: 'Account identity could not be verified.' }; }
      else data = { fields: body.fields.split(','), returned: 1, rows: [{ account_id: 'own', date: '2026-11-01', watch_minutes: 42 }] };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  });
  try {
    const page = await suite.open('/v2/windsor-test.html', {
      profiles: [{ id: 'test-user', role: 'admin' }],
      windsor_linked_accounts: [{ id: 'a', ds_id: 'youtube', account_id: 'own', account_name: 'First', mcp_enabled:false },
        { id: 'b', ds_id: 'new_source', account_id: 'own-b', account_name: 'Second', sync_enabled: false },
        { id: 'c', ds_id: 'klaviyo', account_id: 'own-c', account_name: 'Third', sync_enabled: false },
        { id: 'd', ds_id: 'tiktok', account_id: 'own-d', account_name: 'Fourth', sync_enabled: true }],
    }, { ready: () => document.querySelectorAll('#accounts button').length >= 2 });
    assert.equal(await page.locator('#mintBtn').isDisabled(), true);
    await page.locator('#sourceSearch').fill('You');
    assert.equal(await page.locator('#sourceList button').count(), 1);
    await page.getByRole('button', { name: 'YouTube', exact: true }).click();
    await page.locator('#mintBtn').click();
    await page.waitForFunction(() => !document.getElementById('linkBox').hidden);
    assert.equal(calls.find((c) => c.action === 'mint_link').source, 'youtube');
    assert.ok(calls.every((c) => !('company_entity_id' in c)));
    const previews = page.locator('#accounts').getByRole('button', { name: 'Preview', exact: true });
    await previews.nth(0).click();
    await page.waitForFunction(() => !document.getElementById('pvRun').disabled);
    assert.equal(await page.locator('#fieldList input:checked').count(), 3);
    assert.equal(await page.locator('#fieldList input[value="account_id"]').isDisabled(), true);
    await page.locator('#fieldSearch').fill('Minutes');
    assert.equal(await page.locator('#fieldList input').count(), 1);
    await page.locator('#pvRun').click();
    await page.waitForFunction(() => !document.getElementById('pvTable').hidden);
    assert.match(await page.locator('#pvTable').innerText(), /Minutes watched/);
    assert.match(await page.locator('#pvTable').innerText(), /42/);
    failPreview = true;
    await page.locator('#pvRun').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('identity'));
    assert.equal(await page.locator('#pvTable').isHidden(), true, 'failed preview hides prior successful data');
    delayed = true;
    await previews.nth(0).click();
    await page.waitForFunction(() => document.getElementById('fieldStatus').textContent.includes('Loading'));
    await previews.nth(1).click();
    await page.waitForFunction(() => document.getElementById('pvConnector').value === 'New Source' && !document.getElementById('pvRun').disabled);
    releaseCatalog();
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#fieldList input[value="watch_minutes"]').count(), 0, 'late catalog cannot replace the active account');
    delayed = false;
    legacyConnector = true;
    await page.locator('#sourceReload').click();
    await page.waitForFunction(() => document.getElementById('sourceStatus').textContent.includes('service update'));
    assert.equal(await page.locator('#mintBtn').isDisabled(), true);
    assert.doesNotMatch(await page.locator('#sourceStatus').innerText(), /Unknown action/);
    const readsBefore = calls.filter((c) => c.action === 'preview').length;
    for (const [mode, message] of [['legacy', 'service update'], ['missing_identity', 'did not list an account identity field'], ['bad_defaults', 'valid field selection']]) {
      catalogMode = mode;
      await previews.nth(0).click();
      await page.waitForFunction((text) => document.getElementById('fieldStatus').textContent.includes(text), message);
      assert.equal(await page.locator('#pvRun').isDisabled(), true);
      assert.equal(await page.locator('#fieldList input').count(), 0);
    }
    assert.equal(calls.filter((c) => c.action === 'preview').length, readsBefore, 'incompatible catalog never falls back to old preview');
    // Recovery after the administrator updates the service: same page, same account.
    legacyConnector = false; catalogMode = 'current'; failPreview = false;
    await page.locator('#sourceReload').click();
    await page.waitForFunction(() => document.querySelectorAll('#sourceList button').length === 1);
    await previews.nth(0).click();
    await page.waitForFunction(() => !document.getElementById('pvRun').disabled);
    await page.locator('#pvRun').click();
    await page.waitForFunction(() => !document.getElementById('pvTable').hidden);
    // Sync is offered for every source, including ones with no hand-made
    // dataset: where the rows land is decided from the source's own field
    // list when the toggle is pressed. Only a missing consent column disables
    // it, because then there is nowhere to record the answer.
    assert.equal(await page.getByRole('button', { name: 'Sync update required', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Sync update required', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Enable sync', exact: true }).count(), 2,
      'the source with no hand-made dataset is offered too');
    const rowFor = (name) => page.locator('#accounts tr').filter({ hasText: name });

    // Pressed, and refused with the reason: nothing is hidden in advance.
    await rowFor('own-b').getByRole('button', { name: 'Enable sync', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('a row cannot be placed'));
    assert.equal(await rowFor('own-b').getByRole('button', { name: 'Enable sync', exact: true }).count(), 1,
      'a refused source is still offered, not silently switched on');
    blockUnplaceable = false;
    await rowFor('own-b').getByRole('button', { name: 'Enable sync', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('Sync enabled'));
    assert.deepEqual(calls.filter(c => c.action === 'set_sync').at(-1), { action: 'set_sync', linked_account_id: 'b', enabled: true });

    failSync = true;
    await rowFor('own-c').getByRole('button', { name: 'Enable sync', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('Could not save sync'));
    assert.equal(await rowFor('own-c').getByRole('button', { name: 'Enable sync', exact: true }).count(), 1);
    failSync = false;
    await rowFor('own-c').getByRole('button', { name: 'Enable sync', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('Sync enabled'));
    assert.deepEqual(calls.filter(c => c.action === 'set_sync').at(-1), { action: 'set_sync', linked_account_id: 'c', enabled: true });
    assert.equal(await page.getByRole('button', { name: 'Enable sync', exact: true }).count(), 0);
    await page.locator('#accounts tr').filter({ hasText: 'own-d' }).getByRole('button', { name: 'Pause sync', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('Sync paused'));
    assert.deepEqual(calls.filter(c => c.action === 'set_sync').at(-1), { action: 'set_sync', linked_account_id: 'd', enabled: false });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#accounts tr')).find(r => r.textContent.includes('own-d')).textContent.includes('Enable sync'));
    const llm = page.getByRole('button',{name:'Allow LLM access',exact:true});
    await llm.click();
    assert.equal(calls.filter(c=>c.action==='set_mcp').length,0,'publication requires explicit confirmation');
    failMcp=true;
    await page.getByRole('button',{name:'Confirm LLM access',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Could not save LLM access'));
    assert.equal(await page.getByRole('button',{name:'Disable LLM access',exact:true}).count(),0);
    failMcp=false;
    await page.getByRole('button',{name:/Confirm LLM access|Allow LLM access/}).click();
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('LLM access enabled'));
    await page.getByRole('button',{name:'Disable LLM access',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('LLM access disabled'));
    assert.deepEqual(calls.filter(c=>c.action==='set_mcp').at(-1),{action:'set_mcp',linked_account_id:'a',enabled:false});
    console.log('windsor-picker: real page journey, compatibility failures and recovery passed');
  } finally { await suite.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
