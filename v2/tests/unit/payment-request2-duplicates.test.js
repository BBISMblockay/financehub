const assert = require('node:assert/strict');
(async () => {
  const { createDuplicateChecker, duplicateAcknowledgement } = await import('../../payment-request2-duplicates.js');
  let passed = 0;
  const test = async (name, fn) => { await fn(); passed++; console.log('PASS', name); };
  const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  const snapshot = (fields = {}, extra = {}) => ({ companyId: 'company-a', draftId: 'draft-a', fields: { vendor_name: 'Vendor A', amount_due: '10.00', invoice_number: 'INV-1', currency: 'USD', ...fields }, ...extra });
  const row = (id = 'match-a') => ({ id, vendor_name: 'Vendor A', amount_due: 20, invoice_number: 'INV-1', workflow_status: 'new' });
  function fixture() {
    const timers = new Map(), events = [], calls = []; let next = 0;
    const checker = createDuplicateChecker({
      lookup(s) { const d = deferred(); calls.push({ ...d, snapshot: s }); return d.promise; },
      publish: e => events.push(e),
      setTimer(fn, delay) { assert.equal(delay, 500); timers.set(++next, fn); return next; },
      clearTimer(id) { timers.delete(id); },
    });
    return { checker, timers, events, calls, async tick() { const jobs = [...timers.values()]; timers.clear(); for (const job of jobs) job(); await Promise.resolve(); }, async settle() { await new Promise(r => setImmediate(r)); } };
  }
  await test('waits for valid payee/amount and debounces edits into one automatic lookup', async () => {
    const f = fixture(); f.checker.update(snapshot({ vendor_name: '' })); f.checker.update(snapshot({ amount_due: '' }));
    await f.tick(); assert.equal(f.calls.length, 0); assert.equal(f.events.at(-1).phase, 'idle');
    f.checker.update(snapshot({ vendor_name: 'V' })); f.checker.update(snapshot({ vendor_name: 'Vendor' })); f.checker.update(snapshot());
    assert.equal(f.timers.size, 1); await f.tick(); assert.equal(f.calls.length, 1);
    f.calls[0].resolve([row()]); await f.settle(); assert.equal(f.events.at(-1).result.matches[0].id, 'match-a');
  });
  await test('suggestion/restored snapshot checks automatically; unrelated edits do not query again', async () => {
    const f = fixture(); const s = snapshot(); f.checker.update(s); s.fields.vendor_name = 'mutated later'; await f.tick();
    assert.equal(f.calls[0].snapshot.fields.vendor_name, 'Vendor A'); f.calls[0].resolve([]); await f.settle();
    f.checker.update(snapshot({ notes_comments: 'Updated note', due_date: '2026-10-01' })); assert.equal(f.timers.size, 0);
    f.checker.update(snapshot({}, { draftId: 'restored-draft' })); await f.tick(); assert.equal(f.calls.length, 2);
    f.calls[1].resolve([]); await f.settle();
    f.checker.update(snapshot({}, { companyId: 'company-b', draftId: 'restored-draft' })); await f.tick(); assert.equal(f.calls[2].snapshot.companyId, 'company-b'); f.calls[2].resolve([]); await f.settle();
  });
  await test('each relevant edit immediately invalidates previous results', async () => {
    for (const edit of [{ vendor_name: 'Vendor B' }, { amount_due: '11' }, { invoice_number: 'INV-2' }, { currency: 'CAD' }, { amount_due: '' }]) {
      const f = fixture(); const pending = f.checker.checkNow(snapshot()); f.calls[0].resolve([row()]); await pending;
      f.checker.update(snapshot(edit)); assert.equal(f.events.at(-1).result, null); assert.ok(['waiting', 'idle'].includes(f.events.at(-1).phase)); f.checker.dispose();
    }
  });
  await test('older results and errors cannot replace the current request check', async () => {
    for (const fail of [false, true]) {
      const f = fixture(); f.checker.update(snapshot()); await f.tick();
      f.checker.update(snapshot({ invoice_number: 'INV-2' })); await f.tick(); f.calls[1].resolve([]); await f.settle();
      const current = f.events.at(-1); if (fail) f.calls[0].reject(Error('old lookup failed')); else f.calls[0].resolve([row()]);
      await f.settle(); assert.equal(f.events.at(-1), current); assert.equal(current.result.matches.length, 0);
    }
  });
  await test('fresh submission check supersedes timer/in-flight lookup and requires exact acknowledgement', async () => {
    const f = fixture(); f.checker.update(snapshot()); await f.tick();
    const submitCheck = f.checker.checkNow(snapshot()); assert.equal(f.calls.length, 2); f.calls[1].resolve([row()]);
    const checked = await submitCheck, ack = duplicateAcknowledgement(checked);
    f.calls[0].resolve([]); await f.settle(); assert.equal(f.events.at(-1).result, checked);
    assert.notEqual(ack, duplicateAcknowledgement({ ...checked, matches: [row('new-match')] }));
    assert.notEqual(ack, duplicateAcknowledgement({ ...checked, key: 'other-details' }));
    assert.equal(ack, duplicateAcknowledgement({ ...checked, matches: [row()] }));
    f.checker.update(snapshot({ invoice_number: 'INV-2' })); const immediate = f.checker.checkNow(snapshot({ invoice_number: 'INV-2' }));
    await f.tick(); assert.equal(f.calls.length, 3); f.calls[2].resolve([]); await immediate;
  });
  await test('lookup failure is never clearance and next submission automatically retries', async () => {
    const f = fixture(); const first = f.checker.checkNow(snapshot()); f.calls[0].reject(Error('offline')); await assert.rejects(first, /offline/);
    assert.equal(f.events.at(-1).phase, 'error'); assert.equal(f.events.at(-1).result, null);
    const retry = f.checker.checkNow(snapshot()); f.calls[1].resolve([]); assert.equal((await retry).matches.length, 0);
  });
  await test('sign-out cancels scheduled checks and suppresses in-flight results', async () => {
    const f = fixture(); f.checker.update(snapshot()); f.checker.dispose(); await f.tick(); assert.equal(f.calls.length, 0);
    const g = fixture(); g.checker.update(snapshot()); await g.tick(); g.checker.dispose(); const count = g.events.length;
    g.calls[0].resolve([row()]); await g.settle(); assert.equal(g.events.length, count);
    await assert.rejects(g.checker.checkNow(snapshot()), /stopped/);
  });
  await test('real form wiring auto-checks with company scope and blocks changed matches or lookup failures at submission', async () => {
    const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
    const core = await import('../../payment-request2-core.js');
    const source = fs.readFileSync(path.join(__dirname, '../../payment-request2.js'), 'utf8').replace(/^import .*;$/gm, '').replace('void boot();', '');
    const html = fs.readFileSync(path.join(__dirname, '../../purchase_request2.html'), 'utf8');
    const node = () => ({ value: '', checked: false, hidden: false, children: [], append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, setAttribute() {}, querySelectorAll() { return []; } });
    const nodes = Object.fromEntries([...html.matchAll(/id="([^" ]+)"/g)].map(m => [m[1], node()]));
    assert.equal(nodes.checkDuplicates, undefined);
    const draftValue = { id: 'draft-a', fields: { ...snapshot().fields, request_type: 'invoice_vendor_payment', requester_email: 'test@example.invalid', due_date: '', flex_id: '', location_name: '', notes_comments: '' }, files: [], poNames: [], applied: {} };
    for (const key of core.FIELD_NAMES) nodes[key].value = draftValue.fields[key];
    const timers = new Map(), queries = []; let sequence = 0, writes = 0, rows = [row()], failed = false;
    const dbMock = {
      auth: { async getUser() { return { data: { user: { id: 'user-a' } } }; } },
      from(table) {
        const filters = {}; return {
          select() { return this; }, eq(k, v) { filters[k] = v; return this; }, order() { return this; },
          async single() { return { data: { is_active: true, active_company_id: 'company-a' } }; },
          async maybeSingle() { return { data: { entity_id: 'company-a' } }; },
          async limit(count) { queries.push({ table, filters, count }); return failed ? { error: Error('offline') } : { data: rows }; },
        };
      },
    };
    const context = vm.createContext({ ...core, createDuplicateChecker: io => createDuplicateChecker({ ...io, setTimer(fn) { timers.set(++sequence, fn); return sequence; }, clearTimer(id) { timers.delete(id); } }), duplicateAcknowledgement,
      window: {}, document: { getElementById: id => nodes[id] || null, createElement: node }, navigator: { locks: { request: async (name, opts, fn) => fn({}) } },
      submitRequest: async () => { writes++; return { message: 'Submitted', requestId: 'draft-a' }; }, dbMock, draftValue,
    });
    const app = vm.runInContext(source + `
 db = dbMock; user = { id: 'user-a' }; company = { id: 'company-a' }; scope = 'company-a:user-a'; draft = draftValue; ({ changed, submit });`, context);
    app.changed(); assert.equal(queries.length, 0); assert.equal(timers.size, 1);
    for (const fn of timers.values()) fn(); timers.clear(); await new Promise(r => setImmediate(r));
    assert.equal(queries.length, 1); assert.equal(queries[0].filters.company_entity_id, 'company-a'); assert.equal(queries[0].filters.vendor_name_norm, 'vendor a');
    assert.equal(nodes.duplicateAckWrap.hidden, false); assert.equal(nodes.duplicateAck.checked, false);
    nodes.duplicateAck.checked = true; nodes.reviewed.checked = true; rows = [row('new-match')];
    await app.submit({ preventDefault() {} }); assert.equal(writes, 0); assert.equal(nodes.duplicateAck.checked, false); assert.match(nodes.status.textContent, /acknowledge/);
    nodes.duplicateAck.checked = true; failed = true;
    await app.submit({ preventDefault() {} }); assert.equal(writes, 0); assert.match(nodes.duplicateText.textContent, /Could not check/); assert.equal(nodes.duplicateAck.checked, false);
    failed = false; rows = []; await app.submit({ preventDefault() {} }); assert.equal(writes, 1);
  });
  console.log(`${passed} automatic duplicate checks passed`);
})().catch(error => { console.error(error); process.exit(1); });
