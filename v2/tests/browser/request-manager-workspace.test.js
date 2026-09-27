'use strict';
const assert = require('node:assert/strict');
const { startSuite, fakeSupabaseScript } = require('../lib/harness');

(async () => {
  const suite = await startSuite({ secureContext: true });
  let passed = 0;
  const check = async (name, fn) => { await fn(); console.log(`  PASS ${name}`); passed++; };
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: `request-${i}`, effective_vendor_name: ['Northline Supply', 'Harbor Freight', 'Alex Morgan'][i] || `Supplier ${i}`,
    request_type: 'invoice_vendor_payment', workflow_status: 'new', priority: 'normal', completed: false,
    amount_due: 3480 + i, submitted_at: '2026-09-25T12:00:00Z', due_date: '2026-09-29',
    invoice_number: `INV-${i}`, internal_po_number: `PO-${i}`, requester_email: 'requester@example.test',
    notes_comments: 'Deposit for the autumn order.', assigned_to: null,
  }));
  const files = [
    { id: 'file-a', payment_request_id: 'request-0', file_path: 'request-0/submitted/invoice.pdf', file_name: 'Invoice.pdf', mime_type: 'application/pdf' },
    { id: 'file-b', payment_request_id: 'request-1', file_path: 'request-1/submitted/photo.png', file_name: 'Receipt.png', mime_type: 'image/png' },
    { id: 'file-c', payment_request_id: 'request-0', file_path: 'request-0/submitted/sheet.xlsx', file_name: 'Costs.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    { id: 'file-d', payment_request_id: 'request-3', file_url: 'https://external.example.test/invoice.pdf', file_name: 'Legacy.pdf', mime_type: 'application/pdf', legacy: true },
  ];
  const fixture = {
    profiles: [{ id: 'test-user', name: 'Test Owner', email: 'owner@example.test', role: 'owner', department: 'exec', is_active: true }],
    payment_requests_v: rows, payment_requests: rows, payment_request_files: files,
    payment_request_activity_v: [{ id:'activity-1', payment_request_id:'request-0', activity_type:'submitted', message:'Request submitted', created_at:'2026-09-25T12:00:00Z' }],
  };
  try {
    // Signed URLs are fixture-only. A controllable promise exercises the actual
    // integrated renderer's late-success/late-error path; no private data fetched.
    await suite.context.route('**/cdn.jsdelivr.net/**supabase**', route => route.fulfill({ contentType:'text/javascript', body: fakeSupabaseScript().replace(
      'list: function ()',
      `createSignedUrl: function (path, expiry) {
        (window.__SIGNED__ = window.__SIGNED__ || []).push({path, expiry});
        if (window.__HOLD_PREVIEW__) return new Promise(function(resolve) { window.__RELEASE_PREVIEW__ = resolve; });
        if (window.__FAIL_PREVIEW__) return Promise.resolve({error:{message:'fixture denied'}});
        return Promise.resolve({data:{signedUrl:'https://files.example.test/'+path}});
      }, list: function ()`
    ) }));
    const page = await suite.open('/v2/request_manager.html', fixture, { ready: () => document.getElementById('rowCount')?.textContent === '12' });
    await page.addStyleTag({content:'*, *::before, *::after { transition: none !important; animation: none !important; }'});
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await check('compact queue and hidden bulk controls until selected', async () => {
      assert.equal(await page.locator('#bulkActionBar').isVisible(), false);
      assert.equal(await page.locator('#requestFilters').isVisible(), false);
      assert.equal(await page.locator('#workbenchDrawer').isVisible(), false);
      assert((await page.locator('#mainBody tr').first().boundingBox()).height < 95);
    });
    await check('selection and open request are independent; mixed select-all state', async () => {
      await page.getByRole('button', {name:'Review Northline Supply',exact:true}).click();
      await page.getByRole('checkbox', {name:'Select Harbor Freight',exact:true}).check();
      assert.equal(await page.locator('#drawerTitle').textContent(), 'Northline Supply');
      assert.equal(await page.locator('#selectAllCheckbox').evaluate(el=>el.indeterminate), true);
      assert.equal(await page.locator('#bulkForwardMelioBtn').textContent(),'Forward selected (1)');
      assert.equal(await page.locator('#documentPreview iframe').count(), 1);
    });
    await check('bulk includes hidden selections with explicit count; clearing respects current view', async () => {
      await page.locator('#searchInput').fill('Northline');
      assert.match(await page.locator('#bulkSelectedCount').textContent(), /1 outside filter/);
      await page.locator('#selectAllCheckbox').check();
      assert.match(await page.locator('#bulkSelectedCount').textContent(), /^2/);
      await page.locator('#selectAllCheckbox').uncheck();
      assert.match(await page.locator('#bulkSelectedCount').textContent(), /^1/);
      await page.locator('#searchInput').fill('');
    });
    await check('Reports and Activity use original report and history surfaces', async () => {
      await page.locator('#tabReportingBtn').click();
      assert.equal(await page.locator('#viewReporting').isVisible(), true);
      assert.equal(await page.locator('#kpiRequests').textContent(), '12');
      assert.equal(await page.locator('#workbenchDrawer').isVisible(), false);
      await page.locator('#tabActivityBtn').click();
      assert.match(await page.locator('#activityFeed').textContent(), /Request submitted/);
      await page.locator('#tabRequestsBtn').click();
      assert.equal(await page.locator('#drawerTitle').textContent(), 'Northline Supply');
    });
    await check('filter disclosure and empty queue keep open details separate', async () => {
      await page.locator('#toggleFiltersBtn').click();
      assert.equal(await page.locator('#requestFilters').isVisible(), true);
      await page.locator('#typeFilter').selectOption('customer_refund');
      assert.match(await page.locator('#mainBody').textContent(), /No requests match/);
      assert.equal(await page.locator('#drawerTitle').textContent(), 'Northline Supply');
      await page.locator('#clearFiltersBtn').click();
      await page.locator('#toggleFiltersBtn').click();
    });
    await check('dirty editor refuses a different request; no write on open or selection', async () => {
      await page.locator('#fAmountDue').fill('999');
      page.once('dialog', dialog=>dialog.dismiss());
      await page.getByRole('button',{name:'Review Harbor Freight',exact:true}).click();
      assert.equal(await page.locator('#drawerTitle').textContent(),'Northline Supply');
      assert.equal(await page.locator('#fAmountDue').inputValue(),'999');
      page.once('dialog', dialog=>dialog.accept());
      await page.getByRole('button',{name:'Review Harbor Freight',exact:true}).click();
      assert.equal(await page.locator('#drawerTitle').textContent(),'Harbor Freight');
      assert.equal(await page.evaluate(()=>window.__QUERIES__.filter(q=>['insert','update','delete'].includes(q._op)).length),0);
    });
    await check('late document resolution never replaces a different request', async () => {
      await page.evaluate(()=>{ window.__HOLD_PREVIEW__=true; });
      await page.getByRole('button',{name:'Review Northline Supply',exact:true}).click();
      await page.evaluate(()=>{ window.__HOLD_PREVIEW__=false; });
      await page.getByRole('button',{name:'Review Alex Morgan',exact:true}).click();
      await page.evaluate(()=>window.__RELEASE_PREVIEW__({data:{signedUrl:'https://files.example.test/stale.pdf'}}));
      assert.equal(await page.locator('#documentPreview iframe').count(),0);
      assert.match(await page.locator('#documentPreview').textContent(), /No attachment/);
    });
    await check('unsupported and external files stay explicit Open original, never embedded', async () => {
      await page.getByRole('button',{name:'Review Northline Supply',exact:true}).click();
      await page.locator('#previewFileSelect').selectOption('1');
      assert.match(await page.locator('#documentPreview').textContent(), /Preview unavailable/);
      assert.equal(await page.locator('#documentPreview iframe').count(),0);
      await page.getByRole('button',{name:'Review Supplier 3',exact:true}).click();
      assert.match(await page.locator('#documentPreview').textContent(), /Preview unavailable/);
    });
    await check('signed URL failure is visible and reload recovers', async () => {
      await page.evaluate(()=>{window.__FAIL_PREVIEW__=true;});
      await page.getByRole('button',{name:'Review Northline Supply',exact:true}).click();
      await page.waitForFunction(()=>document.getElementById('documentPreview').textContent.includes('could not load'));
      await page.evaluate(()=>{window.__FAIL_PREVIEW__=false;});
      await page.locator('#previewRetryBtn').click();
      await page.locator('#documentPreview iframe').waitFor();
      assert.equal(await page.evaluate(()=>window.__SIGNED__.at(-1).expiry),600);
    });
    await check('bulk forward retains exact selected IDs and original edge function path', async () => {
      await page.locator('#bulkForwardMelioBtn').click();
      await page.waitForFunction(()=>document.getElementById('bulkActionBar').hidden);
      assert.deepEqual(await page.evaluate(()=>window.__INVOKES__.filter(x=>x.name==='payment-request-forward-melio').map(x=>x.body.payment_request_id)), ['request-1']);
      assert.equal(await page.locator('#drawerTitle').textContent(),'Northline Supply');
    });
    await check('processing and uploads remain reachable', async () => {
      await page.getByRole('button',{name:'Processing',exact:true}).click();
      for (const id of ['fWorkflowStatus','fAssignedTo','fPaymentType','fCompleted','fInternalNotes']) assert.equal(await page.locator('#'+id).isVisible(),true);
      await page.getByText('Documents, forwarding & payment proof',{exact:true}).click();
      assert.equal(await page.locator('#forwardMelioBtn').isVisible(),true);
      assert.equal(await page.locator('#confirmationFileInput').isVisible(),true);
      assert.equal(await page.locator('#submittedFileInput').isVisible(),true);
      await page.getByRole('button',{name:'Details',exact:true}).click();
    });
    await check('explicit Save writes the edited amount and records its change', async () => {
      await page.locator('#fAmountDue').fill('3510.25');
      await page.locator('#saveDrawerBtn').click();
      await page.waitForFunction(()=>!document.getElementById('saveDrawerBtn').disabled);
      const updates = await page.evaluate(()=>window.__QUERIES__.filter(q=>q.table==='payment_requests' && q._op==='update'));
      assert.equal(updates.at(-1).patch.amount_due,3510.25);
      assert.equal(await page.evaluate(()=>window.__QUERIES__.some(q=>q._op==='insert' && q.rows?.activity_type==='amount_changed')),true);
    });
    await check('bulk edits cannot overwrite or silently discard the open draft', async () => {
      await page.getByRole('checkbox',{name:'Select Northline Supply',exact:true}).check();
      await page.locator('.rm-bulk-more summary').click();
      await page.locator('#bulkStatusSelect').selectOption('needs_info');
      await page.locator('#fAmountDue').fill('888');
      const before = await page.evaluate(()=>window.__QUERIES__.filter(q=>q._op==='update').length);
      page.once('dialog', d=>d.dismiss());
      await page.locator('#bulkApplyStatusBtn').click();
      assert.equal(await page.evaluate(()=>window.__QUERIES__.filter(q=>q._op==='update').length),before);
      assert.equal(await page.locator('#fAmountDue').inputValue(),'888');
      page.once('dialog', d=>d.accept());
      await page.locator('#bulkApplyStatusBtn').click();
      await page.waitForFunction(()=>document.getElementById('bulkActionBar').hidden);
      assert.equal(await page.locator('#workbenchDrawer').isVisible(),false);
      assert.equal(await page.evaluate(()=>window.__QUERIES__.filter(q=>q._op==='update').at(-1).patch.workflow_status),'needs_info');
      await page.getByRole('button',{name:'Review Northline Supply',exact:true}).click();
    });
    await page.locator('#toastWrap').evaluate(el=>el.replaceChildren());
    for (const width of [1440, 1100, 768, 390]) {
      await check(`responsive layout at ${width}px, both themes`, async () => {
        await page.setViewportSize({width,height:900});
        for (const theme of ['light','dark']) {
          await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
          assert.equal(await page.locator('.queue-card:not(.active)').first().evaluate(el=>getComputedStyle(el).color === getComputedStyle(document.body).color || getComputedStyle(el).color !== 'rgb(0, 0, 0)'),true);
          const shape=await page.locator('#workbenchDrawer').boundingBox();
          assert(shape.width <= width);
          assert.equal(await page.locator('#documentPane').isVisible(),true);
          if (process.env.RM_SCREENSHOT && ((width===390 && theme==='light') || (width===1440 && theme==='dark'))) {
            await page.screenshot({path:process.env.RM_SCREENSHOT.replace(/\.png$/, `-${width}-${theme}.png`),fullPage:true,animations:'disabled'});
          }
        }
      });
    }
    await page.setViewportSize({width:1600,height:1000});
    await page.evaluate(()=>document.documentElement.setAttribute('data-theme','light'));
    await page.locator('.rm-document-tools').evaluate(el=>{el.open=false;});
    if (process.env.RM_SCREENSHOT) await page.screenshot({path:process.env.RM_SCREENSHOT,fullPage:true,animations:'disabled'});
    await check('Escape closes detail and returns focus to its queue row', async () => {
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#workbenchDrawer').isVisible(),false);
      assert.equal(await page.locator('#documentPane').isVisible(),false);
      assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Review Northline Supply');
      assert.equal(await page.locator('#documentPreview iframe').count(),0);
    });
    assert.deepEqual(errors,[]);
    console.log(`${passed} Request Manager checks passed`);
  } finally { await suite.close(); }
})().catch(err=>{ console.error(err); process.exit(1); });
