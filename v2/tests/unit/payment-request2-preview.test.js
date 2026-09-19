const assert = require('node:assert/strict');
(async () => {
  const { createPdfPreview } = await import('../../payment-request2-preview.js');
  let passed = 0;
  const test = async (name, fn) => { await fn(); passed++; console.log('PASS', name); };
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  function fixture(overrides = {}) {
    const state = { shown: [], statuses: [], destroyed: 0, cancelled: 0, cleaned: 0, canvases: [], pages: [] };
    const page = { getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }), render: () => ({ promise: Promise.resolve(), cancel() { state.cancelled++; } }), cleanup() { state.cleaned++; } };
    const doc = { numPages: 3, async getPage(n) { state.pages.push(n); return page; } };
    const loading = { promise: Promise.resolve(doc), async destroy() { state.destroyed++; } };
    const io = { loadPdf: async () => ({ getDocument(options) { state.options = options; return loading; } }), createCanvas() { const canvas = { getContext: () => ({}) }; state.canvases.push(canvas); return canvas; }, present(canvas, n, total) { state.shown.push({ canvas, n, total }); }, status(message) { state.statuses.push(message); }, width: () => 400, pixelRatio: () => 2, ...overrides };
    return { state, page, doc, loading, io, start: () => createPdfPreview(new Blob(['PDF bytes']), io) };
  }
  await test('renders local bytes safely and navigates within page bounds', async () => {
    const f = fixture(), p = f.start(); assert.equal(await p.ready, true);
    assert.equal(f.state.options.isEvalSupported, false); assert.equal(f.state.options.enableXfa, false);
    assert.equal(new TextDecoder().decode(f.state.options.data), 'PDF bytes');
    assert.deepEqual(f.state.shown.map(x => [x.n, x.total]), [[1, 3]]);
    await p.showPage(2); await p.showPage(3); await p.showPage(4); await p.showPage(0); await p.showPage(1.5);
    assert.deepEqual(f.state.pages, [1, 2, 3]); assert.equal(f.state.canvases[0].width, 0);
    p.dispose(); assert.equal(f.state.destroyed, 1); assert.equal(f.state.canvases[2].width, 0);
  });
  await test('bounds canvas pixels for unusually large pages', async () => {
    const f = fixture({ width: () => 10000, pixelRatio: () => 10 });
    f.page.getViewport = ({ scale }) => ({ width: 100000 * scale, height: 200000 * scale });
    const p = f.start(); await p.ready; const c = f.state.shown[0].canvas;
    assert.ok(c.width * c.height <= 8000000); assert.ok(c.width > 0); p.dispose();
  });
  await test('source switch during library load never opens or paints old document', async () => {
    const d = deferred(), f = fixture({ loadPdf: () => d.promise }), p = f.start(); p.dispose();
    let opened = 0; d.resolve({ getDocument() { opened++; throw Error('stale loader used'); } }); await p.ready;
    assert.equal(opened, 0);
    assert.equal(f.state.shown.length, 0); assert.deepEqual(f.state.statuses, ['Loading document…']);
  });
  await test('source switch during render cancels and suppresses stale canvas', async () => {
    const d = deferred(), started = deferred(), f = fixture();
    f.page.render = () => { started.resolve(); return { promise: d.promise, cancel() { f.state.cancelled++; } }; };
    const p = f.start(); await started.promise; p.dispose(); d.resolve(); await p.ready;
    assert.equal(f.state.shown.length, 0); assert.equal(f.state.cancelled, 1); assert.equal(f.state.destroyed, 1); assert.equal(f.state.canvases[0].width, 0);
  });
  await test('failed download and corrupt PDF show Open fallback without rejecting', async () => {
    for (const stage of ['library', 'pdf']) {
      const f = fixture(); if (stage === 'library') f.io.loadPdf = async () => { throw Error('offline'); };
      else f.loading.promise = Promise.reject(Error('invalid PDF'));
      const p = f.start(); assert.equal(await p.ready, false);
      assert.match(f.state.statuses.at(-1), /Open/); assert.equal(f.state.shown.length, 0); p.dispose();
    }
  });
  await test('password prompt releases loading task and shows fallback', async () => {
    const pending = deferred(), f = fixture(); f.loading.promise = pending.promise;
    const p = f.start(); while (!f.loading.onPassword) await new Promise(r => setImmediate(r));
    f.loading.onPassword(); assert.equal(await p.ready, false); assert.equal(f.state.destroyed, 1); assert.match(f.state.statuses.at(-1), /Open/);
  });
  await test('stalled renderer times out and releases resources', async () => {
    const f = fixture({ timeoutMs: 5 }); f.loading.promise = new Promise(() => {});
    const p = f.start(); assert.equal(await p.ready, false); assert.equal(f.state.destroyed, 1); assert.match(f.state.statuses.at(-1), /Open/);
  });
  console.log(`${passed} preview checks passed`);
})().catch(error => { console.error(error); process.exit(1); });
