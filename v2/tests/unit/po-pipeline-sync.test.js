/* PO -> Pipeline sync (v2/po-pipeline-sync.js) and its wiring in
 * /v2/po-builder.html.
 *
 * The bug: a new-product PO reached the Pipeline one LINE at a time, on line
 * save only, and each save wrote that one line's qty into expected_units. A
 * Pipeline item is a PRODUCT and a PO carries a line per SIZE, so the last
 * size saved won -- Incotexco-496's youth tee read 105 (its YXL line) against
 * the 550 its four size lines add up to. And lines that arrived by import,
 * bulk SKU, catalog or concept never reached the Pipeline until someone
 * edited one of them.
 *
 * What must hold:
 *   - expected units is the product's total across EVERY size line on the PO,
 *     whatever order lines were saved in
 *   - a new-product PO's products reach the Pipeline after ANY line change,
 *     with no Save or -> TRK press
 *   - an item another PO already owns is never overwritten or duplicated
 *   - expected units is the only field a PO overwrites
 *   - overlapping autosaves cannot create the same item twice
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createReporter } = require('../lib/assert');
const { loadV2, V2 } = require('../lib/load');

const r = createReporter('po-pipeline-sync');
const P = loadV2(['po-pipeline-sync.js']).SiloPoPipeline;

// Incotexco-496 as it stands in production (2026-09-23): six adult sizes and
// four youth sizes, both "New product PO".
const PO = {
  id: 'po-496', po_name: 'Incotexco-496', factory_id: 'fac-inco', factory_name: 'Incotexco',
  expected_arrival_date: '2026-12-25', is_new_product_po: true,
};
const MEN = 'Elevate & Celebrate T-Shirt';
const YOUTH = 'Elevate & Celebrate T-Shirt - Youth';
const LINES = [
  ['S', 75], ['M', 75], ['L', 95], ['XL', 40], ['2XL', 30], ['3XL', 10],
].map(([v, q]) => ({ title_snapshot: MEN, product_type_snapshot: 'T-Shirts', variant_title_snapshot: v, qty: q, po_header_id: PO.id }))
  .concat([['YS', 95], ['YM', 180], ['YL', 170], ['YXL', 105]]
    .map(([v, q]) => ({ title_snapshot: YOUTH, product_type_snapshot: 'Youth', variant_title_snapshot: v, qty: q, po_header_id: PO.id })));

const byTitle = (rows) => Object.fromEntries(rows.map((x) => [x.title, x]));

// ── productTotals ────────────────────────────────────────────────────────────

r.test('expected units is the sum of every size line, not one line', () => {
  const t = byTitle(P.productTotals(LINES));
  r.eq(t[YOUTH].units, 550, 'youth: 95 + 180 + 170 + 105');
  r.eq(t[MEN].units, 325, 'adult: 75 + 75 + 95 + 40 + 30 + 10');
  r.eq(t[YOUTH].lineCount, 4);
  r.eq(t[MEN].lineCount, 6);
  r.eq(t[YOUTH].productType, 'Youth');
});

r.test('the total does not depend on which line was saved last', () => {
  const reversed = LINES.slice().reverse();
  r.eq(byTitle(P.productTotals(reversed))[YOUTH].units, 550);
});

r.test('case and surrounding whitespace do not split one product', () => {
  const t = P.productTotals([
    { title_snapshot: 'Hustle Tee', qty: 10 },
    { title_snapshot: '  hustle tee ', qty: 5 },
  ]);
  r.eq(t.length, 1);
  r.eq(t[0].units, 15);
  r.eq(t[0].title, 'Hustle Tee', 'the title as first written');
});

r.test('an untitled line is not a product', () => {
  r.eq(P.productTotals([{ title_snapshot: '  ', qty: 40 }, { title_snapshot: null, qty: 3 }]), []);
});

r.test('a product with no quantity yet reports null, never a confident 0', () => {
  const t = P.productTotals([{ title_snapshot: 'New Cap', qty: 0 }, { title_snapshot: 'New Cap', qty: null }]);
  r.eq(t[0].units, null);
  r.eq(t[0].lineCount, 2);
});

// ── plan ─────────────────────────────────────────────────────────────────────

const totals = P.productTotals(LINES);
const planFor = (trackers, keys) => byTitle(P.plan(PO, totals, trackers, keys));

r.test('a product with no Pipeline item is added, linked to the PO, with the full total', () => {
  const a = planFor([])[YOUTH];
  r.eq(a.kind, 'insert');
  r.eq(a.patch.expected_units, 550);
  r.eq(a.patch.po_header_id, 'po-496');
  r.eq(a.patch.factory_id, 'fac-inco');
  r.eq(a.patch.manufacturer, 'Incotexco', 'the Pipeline table shows manufacturer; it read "—" until someone re-saved');
  r.eq(a.patch.bulk_eta, '2026-12-25');
  r.eq(a.patch.product_type, 'Youth');
  r.eq(a.patch.notes, 'Auto-added from PO: Incotexco-496');
});

r.test('the reported bug: an item holding one line\'s qty is corrected to the PO total', () => {
  const stored = { id: 't-y', product_title: YOUTH, po_header_id: null, expected_units: 105, factory_id: 'fac-inco',
    manufacturer: null, product_type: 'Youth', bulk_eta: '2026-12-25', notes: 'Auto-added from PO: Incotexco-496' };
  const a = planFor([stored])[YOUTH];
  r.eq(a.kind, 'update');
  r.eq(a.patch, { po_header_id: 'po-496', expected_units: 550, manufacturer: 'Incotexco' });
});

r.test('the PO note is matched case-insensitively (KCMTar-34 vs KCMTAR-34)', () => {
  const stored = { id: 't', product_title: MEN, po_header_id: null, expected_units: 10, notes: 'Auto-added from PO: INCOTEXCO-496' };
  r.eq(planFor([stored])[MEN].kind, 'update');
});

r.test('an item this PO already owns is kept in step', () => {
  const stored = { id: 't', product_title: MEN, po_header_id: 'po-496', expected_units: 300, factory_id: 'fac-inco',
    manufacturer: 'Incotexco', product_type: 'T-Shirts', bulk_eta: '2026-12-25', notes: 'Auto-added from PO: Incotexco-496' };
  r.eq(planFor([stored])[MEN].patch, { expected_units: 325 });
});

r.test('an item already right writes nothing', () => {
  const stored = { id: 't', product_title: MEN, po_header_id: 'po-496', expected_units: 325, factory_id: 'fac-inco',
    manufacturer: 'Incotexco', product_type: 'T-Shirts', bulk_eta: '2026-12-25' };
  r.eq(planFor([stored])[MEN].kind, 'unchanged');
});

r.test('expected units is the ONLY field a PO overwrites', () => {
  const stored = { id: 't', product_title: MEN, po_header_id: 'po-496', expected_units: 1, factory_id: 'fac-other',
    manufacturer: 'Somebody Else', product_type: 'Tees', bulk_eta: '2027-01-15' };
  r.eq(planFor([stored])[MEN].patch, { expected_units: 325 }, 'factory, manufacturer, type and ETA a person set are kept');
});

r.test('a Pipeline item a person created before the PO existed is claimed, not duplicated', () => {
  const stored = { id: 'manual', product_title: 'elevate & celebrate t-shirt', po_header_id: null, expected_units: null, notes: 'photo shoot Tuesday' };
  const a = planFor([stored])[MEN];
  r.eq(a.kind, 'update');
  r.eq(a.row.id, 'manual');
  r.eq(a.patch.po_header_id, 'po-496');
  r.eq(a.patch.expected_units, 325);
});

r.test('an item auto-added from a DIFFERENT PO is left alone', () => {
  const stored = { id: 't', product_title: MEN, po_header_id: null, expected_units: 999, notes: 'Auto-added from PO: Incotexco-487' };
  const a = planFor([stored])[MEN];
  r.eq(a.kind, 'other_po');
  r.truthy(!a.patch, 'nothing written');
});

r.test('an item linked to another PO is neither overwritten nor duplicated (duplicated / split PO)', () => {
  const stored = { id: 't', product_title: MEN, po_header_id: 'po-original', expected_units: 325 };
  const a = planFor([stored])[MEN];
  r.eq(a.kind, 'other_po');
  r.eq(a.row.id, 't');
});

r.test('an item whose note names a PO that no longer carries the product is claimed', () => {
  // Creytex-335's hoodies now sit on ShaoxingTianyun-111: the PO was recreated
  // under the new factory, and the note still names the old one.
  const stored = { id: 'moved', product_title: MEN, po_header_id: null, expected_units: 10, notes: 'Auto-added from PO: Creytex-335' };
  const a = byTitle(P.plan(PO, totals, [stored], null, () => false))[MEN];
  r.eq(a.kind, 'update');
  r.eq(a.patch.po_header_id, 'po-496');
  r.eq(a.patch.expected_units, 325);
});

r.test('...but not when the noted PO still carries it, and not when that is unknown', () => {
  const stored = { id: 't', product_title: MEN, po_header_id: null, expected_units: 10, notes: 'Auto-added from PO: Incotexco-487' };
  r.eq(byTitle(P.plan(PO, totals, [stored], null, () => true))[MEN].kind, 'other_po', 'still carried');
  r.eq(byTitle(P.plan(PO, totals, [stored], null, undefined))[MEN].kind, 'other_po', 'unknown = leave it');
});

r.test('-> TRK creates only the product it was pressed on', () => {
  const acts = P.plan(PO, totals, [], [P.titleKey(YOUTH)]);
  r.eq(acts.map((a) => a.title), [YOUTH]);
});

// ── lifecycle: a product leaving its PO, and unticking "New product PO" ─────

const owned = (title, units, extra) => Object.assign({ id: `own-${title}`, product_title: title, po_header_id: 'po-496',
  expected_units: units, factory_id: 'fac-inco', manufacturer: 'Incotexco', product_type: 'T-Shirts', bulk_eta: '2026-12-25' }, extra);

r.test('the last line of a product deleted: its item is released, not left at the old figure', () => {
  // The reviewer's reproduction: an empty line set used to return no actions.
  const acts = P.plan(PO, [], [owned('Solo Tee', 100)]);
  r.eq(acts.length, 1);
  r.eq(acts[0].kind, 'release');
  r.eq(acts[0].patch, { po_header_id: null, expected_units: null });
});

r.test('a renamed product: the old item is released, the new title gets its own item', () => {
  const lines = [{ title_snapshot: 'Solo Tee - Black', qty: 100 }];
  const acts = byTitle(P.plan(PO, P.productTotals(lines), [owned('Solo Tee', 100)]));
  r.eq(acts['Solo Tee'].kind, 'release');
  r.eq(acts['Solo Tee - Black'].kind, 'insert');
  r.eq(acts['Solo Tee - Black'].patch.expected_units, 100);
});

r.test('an item another PO owns is never released by this one', () => {
  r.eq(P.plan(PO, [], [owned('Solo Tee', 100, { po_header_id: 'po-other' })]), []);
});

r.test('an unlinked item is never released (it is not this PO\'s)', () => {
  r.eq(P.plan(PO, [], [owned('Solo Tee', 100, { po_header_id: null })]), []);
});

r.test('"New product PO" unticked: owned items stay in step, nothing is created or claimed', () => {
  const manual = { id: 'manual', product_title: YOUTH, po_header_id: null, expected_units: null, notes: null };
  const acts = byTitle(P.plan(PO, totals, [owned(MEN, 300), manual], false));
  r.eq(acts[MEN].kind, 'update');
  r.eq(acts[MEN].patch, { expected_units: 325 });
  r.truthy(!acts[YOUTH], 'the unlinked youth item is not claimed and nothing is inserted');
});

r.test('an item released and then re-added to the same PO is claimed back', () => {
  const released = owned('Solo Tee', null, { po_header_id: null, notes: 'Auto-added from PO: Incotexco-496' });
  const a = P.plan(PO, P.productTotals([{ title_snapshot: 'Solo Tee', qty: 40 }]), [released])[0];
  r.eq(a.kind, 'update');
  r.eq(a.patch.po_header_id, 'po-496');
  r.eq(a.patch.expected_units, 40);
});

r.test('notedPoName reads the first line of the note only', () => {
  r.eq(P.notedPoName('Auto-added from PO: KCMTar-34\nreorder planned'), 'KCMTar-34');
  r.eq(P.notedPoName('Pushed from PO: X-1'), 'X-1');
  r.eq(P.notedPoName('photo shoot Tuesday'), null);
  r.eq(P.notedPoName('Auto-added from PO: '), null);
});

// ── sync, against a fake Supabase ────────────────────────────────────────────

function fakeSb(tables, opts = {}) {
  const db = JSON.parse(JSON.stringify(tables));
  const calls = [];
  let seq = 0;
  const exec = (q) => {
    calls.push(q);
    if (opts.fail && opts.fail(q)) return { data: null, error: { message: 'refused by RLS' } };
    const rows = db[q.table] || (db[q.table] = []);
    const match = (row) => q.filters.every(([c, v, op]) => (op === 'in'
      ? v.map(String).includes(String(row[c]))
      : String(row[c]) === String(v)));
    if (q.op === 'select') {
      let got = rows.filter(match).map((x) => ({ ...x }));
      if (q.range) got = got.slice(q.range[0], q.range[1] + 1);
      return { data: got, error: null };
    }
    // product_tracker_po_product_uniq: one linked item per (PO, product).
    const clash = (candidate, selfId) => opts.unique && q.table === 'product_tracker' && candidate.po_header_id
      && rows.some((x) => x.id !== selfId && x.po_header_id === candidate.po_header_id
        && P.titleKey(x.product_title) === P.titleKey(candidate.product_title));
    const dup = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "product_tracker_po_product_uniq"' } };
    if (q.op === 'insert') {
      if (clash(q.payload, null)) return dup;
      rows.push({ id: `new-${++seq}`, ...q.payload }); return { data: null, error: null };
    }
    if (q.op === 'update') {
      const targets = rows.filter(match);
      if (targets.some((x) => clash({ ...x, ...q.payload }, x.id))) return dup;
      targets.forEach((x) => Object.assign(x, q.payload)); return { data: null, error: null };
    }
    throw new Error('unexpected op ' + q.op);
  };
  const from = (table) => {
    const q = { table, op: 'select', filters: [], payload: null };
    const b = {
      select() { return b; },
      insert(p) { q.op = 'insert'; q.payload = p; return b; },
      update(p) { q.op = 'update'; q.payload = p; return b; },
      eq(c, v) { q.filters.push([c, v]); return b; },
      in(c, vals) { q.filters.push([c, vals, 'in']); return b; },
      order() { return b; },
      range(a, z) { q.range = [a, z]; return b; },
      then(ok, bad) {
        const run = () => exec(q);
        const p = opts.delayMs ? new Promise((res) => setTimeout(() => res(run()), opts.delayMs)) : Promise.resolve().then(run);
        return p.then(ok, bad);
      },
    };
    return b;
  };
  return { from, db, calls };
}

const run = async (name, fn) => {
  try { await fn(); r.ok(name, true); }
  catch (e) { r.ok(name, false, e && e.message); }
};

(async () => {
  await run('sync adds both products of a freshly imported PO, each with its full total', async () => {
    const sb = fakeSb({ po_lines: LINES.map((l) => ({ ...l, company_entity_id: 'co-1' })), product_tracker: [] });
    const res = await P.sync(sb, { po: PO, companyId: 'co-1' });
    r.eq(res.errors, []);
    r.eq(res.inserted.length, 2);
    const rows = byTitleRows(sb.db.product_tracker);
    r.eq(rows[YOUTH].expected_units, 550);
    r.eq(rows[MEN].expected_units, 325);
    r.eq(rows[YOUTH].po_header_id, 'po-496');
    r.eq(rows[YOUTH].company_entity_id, 'co-1');
  });

  await run('saving the lines one by one, in any order, ends at the total (the reported 105)', async () => {
    const sb = fakeSb({ po_lines: [], product_tracker: [] });
    // Lines arrive and are saved one at a time, YXL last -- exactly the
    // sequence that used to leave 105 behind.
    for (const line of LINES) {
      sb.db.po_lines.push({ ...line });
      await P.sync(sb, { po: PO });
    }
    const rows = byTitleRows(sb.db.product_tracker);
    r.eq(sb.db.product_tracker.length, 2, 'one item per product, not per size');
    r.eq(rows[YOUTH].expected_units, 550);
    r.eq(rows[MEN].expected_units, 325);
  });

  await run('deleting a size line brings the total down', async () => {
    const sb = fakeSb({ po_lines: LINES, product_tracker: [] });
    await P.sync(sb, { po: PO });
    sb.db.po_lines = sb.db.po_lines.filter((l) => l.variant_title_snapshot !== 'YXL');
    await P.sync(sb, { po: PO });
    r.eq(byTitleRows(sb.db.product_tracker)[YOUTH].expected_units, 445);
  });

  await run('only this PO\'s lines are read', async () => {
    const sb = fakeSb({ po_lines: LINES.concat([{ title_snapshot: YOUTH, qty: 5000, po_header_id: 'po-other' }]), product_tracker: [] });
    await P.sync(sb, { po: PO });
    r.eq(byTitleRows(sb.db.product_tracker)[YOUTH].expected_units, 550);
  });

  await run('a launch-linked item carries the new total into its launch readiness copy', async () => {
    const sb = fakeSb({
      po_lines: LINES,
      product_tracker: [{ id: 't-y', product_title: YOUTH, po_header_id: 'po-496', expected_units: 105, launch_id: 'launch-1' }],
      launch_product_readiness: [{ id: 'lpr', product_tracker_id: 't-y', expected_units: 105 }],
    });
    await P.sync(sb, { po: PO });
    r.eq(sb.db.launch_product_readiness[0].expected_units, 550);
  });

  await run('an item with no launch never touches launch readiness', async () => {
    const sb = fakeSb({ po_lines: LINES, product_tracker: [{ id: 't-y', product_title: YOUTH, po_header_id: 'po-496', expected_units: 105 }] });
    await P.sync(sb, { po: PO });
    r.eq(sb.calls.filter((c) => c.table === 'launch_product_readiness').length, 0);
  });

  await run('a refused write is reported per product, never thrown, and the others still land', async () => {
    const sb = fakeSb({ po_lines: LINES, product_tracker: [] }, {
      fail: (q) => q.op === 'insert' && q.payload.product_title === MEN,
    });
    const res = await P.sync(sb, { po: PO });
    r.eq(res.errors.length, 1);
    r.eq(res.errors[0].title, MEN);
    r.has(res.errors[0].message, 'refused');
    r.eq(res.inserted.map((a) => a.title), [YOUTH]);
  });

  await run('a readiness failure says the Pipeline WAS updated', async () => {
    const sb = fakeSb({
      po_lines: LINES,
      product_tracker: [{ id: 't-y', product_title: YOUTH, po_header_id: 'po-496', expected_units: 105, launch_id: 'launch-1' }],
      launch_product_readiness: [{ id: 'lpr', product_tracker_id: 't-y', expected_units: 105 }],
    }, { fail: (q) => q.table === 'launch_product_readiness' });
    const res = await P.sync(sb, { po: PO });
    r.eq(res.updated.length, 1, 'the tracker update is not hidden');
    r.has(res.errors[0].message, 'Pipeline updated');
    r.eq(sb.db.product_tracker[0].expected_units, 550);
  });

  await run('an unreadable Pipeline writes nothing and says so', async () => {
    const sb = fakeSb({ po_lines: LINES, product_tracker: [] }, { fail: (q) => q.table === 'product_tracker' && q.op === 'select' });
    const res = await P.sync(sb, { po: PO });
    r.has(res.errors[0].message, 'Could not read the Pipeline');
    r.eq(sb.calls.filter((c) => c.op !== 'select').length, 0);
  });

  const MOVED = { id: 't-moved', product_title: YOUTH, po_header_id: null, expected_units: 105,
    notes: 'Auto-added from PO: Creytex-335' };

  await run('sync claims an item whose noted PO no longer exists', async () => {
    const sb = fakeSb({ po_lines: LINES, po_headers: [{ id: 'po-496', po_name: 'Incotexco-496' }], product_tracker: [MOVED] });
    const res = await P.sync(sb, { po: PO });
    const row = byTitleRows(sb.db.product_tracker)[YOUTH];
    r.eq(sb.db.product_tracker.filter((x) => x.product_title === YOUTH).length, 1, 'claimed, not duplicated');
    r.eq(row.po_header_id, 'po-496');
    r.eq(row.expected_units, 550);
    r.eq(res.errors, []);
  });

  await run('sync claims it when the noted PO exists but no longer carries the product (the KCMTAR-6 -> 58 case)', async () => {
    const sb = fakeSb({
      po_lines: LINES.concat([{ po_header_id: 'po-335', title_snapshot: 'Some Other Hoodie', qty: 50 }]),
      po_headers: [{ id: 'po-496', po_name: 'Incotexco-496' }, { id: 'po-335', po_name: 'CREYTEX-335' }],
      product_tracker: [MOVED],
    });
    await P.sync(sb, { po: PO });
    r.eq(byTitleRows(sb.db.product_tracker)[YOUTH].po_header_id, 'po-496');
  });

  await run('sync leaves it alone while the noted PO still carries the product', async () => {
    const sb = fakeSb({
      po_lines: LINES.concat([{ po_header_id: 'po-335', title_snapshot: ` ${YOUTH.toUpperCase()} `, qty: 50 }]),
      po_headers: [{ id: 'po-496', po_name: 'Incotexco-496' }, { id: 'po-335', po_name: 'Creytex-335' }],
      product_tracker: [MOVED],
    });
    const res = await P.sync(sb, { po: PO });
    const youth = sb.db.product_tracker.filter((x) => x.product_title === YOUTH);
    r.eq(youth.length, 1, 'no second item');
    r.eq(youth[0].po_header_id, null);
    r.eq(youth[0].expected_units, 105);
    r.eq(res.otherPo.map((a) => a.title), [YOUTH]);
  });

  await run('a failed PO lookup never turns into claiming another PO\'s item', async () => {
    for (const table of ['po_headers', 'po_lines']) {
      const sb = fakeSb({
        po_lines: LINES, po_headers: [{ id: 'po-496', po_name: 'Incotexco-496' }], product_tracker: [MOVED],
      }, { fail: (q) => q.table === table && q.op === 'select' && (table === 'po_headers' || q.filters.some((f) => f[2] === 'in')) });
      // make the noted PO exist so the po_lines read is actually reached
      if (table === 'po_lines') sb.db.po_headers.push({ id: 'po-335', po_name: 'Creytex-335' });
      await P.sync(sb, { po: PO });
      const youth = sb.db.product_tracker.filter((x) => x.product_title === YOUTH);
      r.eq(youth.length, 1, `${table} failure: no duplicate`);
      r.eq(youth[0].po_header_id, null, `${table} failure: not claimed`);
    }
  });

  await run('a noted PO past the first 1,000 headers is still found (the lookup pages)', async () => {
    const filler = Array.from({ length: 1000 }, (_, i) => ({ id: `po-f${String(i).padStart(4, '0')}`, po_name: `Filler-${i}` }));
    const sb = fakeSb({
      po_lines: LINES.concat([{ po_header_id: 'po-zzz', title_snapshot: YOUTH, qty: 50 }]),
      po_headers: filler.concat([{ id: 'po-zzz', po_name: 'Creytex-335' }]),
      product_tracker: [MOVED],
    });
    await P.sync(sb, { po: PO });
    const youth = sb.db.product_tracker.filter((x) => x.product_title === YOUTH);
    r.eq(youth[0].po_header_id, null, 'Creytex-335 still carries it, so it is not claimed');
    r.eq(sb.calls.filter((c) => c.table === 'po_headers').length, 2, 'two pages read');
  });

  await run('the PO lookup only happens when an item actually needs it', async () => {
    const sb = fakeSb({ po_lines: LINES, product_tracker: [] });
    await P.sync(sb, { po: PO });
    r.eq(sb.calls.filter((c) => c.table === 'po_headers').length, 0);
  });

  await run('no PO id: nothing is read or written', async () => {
    const sb = fakeSb({ po_lines: LINES, product_tracker: [] });
    const res = await P.sync(sb, { po: {} });
    r.eq(sb.calls.length, 0);
    r.eq(res.inserted, []);
  });

  // ── createQueue ────────────────────────────────────────────────────────────

  await run('the race is real: without the unique index, two tabs add the item twice', async () => {
    const sb = fakeSb({ po_lines: LINES.slice(6), product_tracker: [] }, { delayMs: 5 });
    await Promise.all([P.sync(sb, { po: PO }), P.sync(sb, { po: PO })]);
    r.eq(sb.db.product_tracker.length, 2, 'this is what product_tracker_po_product_uniq exists to prevent');
  });

  await run('two tabs (two independent queues) add ONE item, and neither reports an error', async () => {
    const sb = fakeSb({ po_lines: LINES.slice(6), product_tracker: [] }, { delayMs: 5, unique: true });
    const tabA = P.createQueue((arg) => P.sync(sb, arg));
    const tabB = P.createQueue((arg) => P.sync(sb, arg));
    const [a, b] = await Promise.all([tabA('po-496', { po: PO }), tabB('po-496', { po: PO })]);
    r.eq(sb.db.product_tracker.length, 1, 'one item');
    r.eq(sb.db.product_tracker[0].expected_units, 550);
    r.eq(a.errors.concat(b.errors), [], 'the loser re-read the winner instead of failing');
    r.eq(a.inserted.length + b.inserted.length, 1);
    r.eq(a.unchanged.length + b.unchanged.length, 1, 'the loser found it already right');
  });

  /** Make "another tab" land a row between this tab's read and its write. */
  function interleave(sb, verb, when, row) {
    const origFrom = sb.from;
    let done = false;
    sb.from = (table) => {
      const b = origFrom(table);
      const orig = b[verb];
      b[verb] = (payload) => {
        if (table === 'product_tracker' && !done && when(payload)) { done = true; sb.db.product_tracker.push(row); }
        return orig(payload);
      };
      return b;
    };
  }

  await run('a losing tab brings the winner in step when its own figure is newer', async () => {
    // This tab's lines total 650 (a YXL edit the other tab never saw); the
    // other tab's insert of 550 lands between this tab's read and its insert.
    const sb = fakeSb({
      po_lines: LINES.slice(6).map((l) => (l.variant_title_snapshot === 'YXL' ? { ...l, qty: 205 } : l)),
      product_tracker: [],
    }, { unique: true });
    interleave(sb, 'insert', (p) => p.product_title === YOUTH,
      { id: 'won', product_title: YOUTH, po_header_id: 'po-496', expected_units: 550 });
    const res = await P.sync(sb, { po: PO, create: true });
    r.eq(sb.db.product_tracker.length, 1, 'no duplicate');
    r.eq(sb.db.product_tracker[0].id, 'won');
    r.eq(sb.db.product_tracker[0].expected_units, 650, 'the conflict path re-read the winner and updated it');
    r.eq(res.errors, []);
    r.eq(res.updated.map((a) => a.title), [YOUTH]);
  });

  await run('a claim that collides with an item another tab just created resolves to that item', async () => {
    const manual = { id: 'manual', product_title: YOUTH, po_header_id: null, expected_units: null, notes: null };
    const sb = fakeSb({ po_lines: LINES.slice(6), product_tracker: [manual] }, { unique: true });
    interleave(sb, 'update', (p) => p.po_header_id === 'po-496',
      { id: 'other-tab', product_title: YOUTH, po_header_id: 'po-496', expected_units: 550 });
    const res = await P.sync(sb, { po: PO, create: true });
    r.eq(res.errors, []);
    r.eq(sb.db.product_tracker.find((x) => x.id === 'manual').po_header_id, null, 'the unlinked item stays unlinked');
    r.eq(sb.db.product_tracker.filter((x) => x.po_header_id === 'po-496').length, 1, 'one linked item');
  });

  await run('deleting the last line of a product releases its item and clears its launch copy', async () => {
    const sb = fakeSb({
      po_lines: LINES.filter((l) => l.title_snapshot === MEN),
      product_tracker: [
        { id: 't-y', product_title: YOUTH, po_header_id: 'po-496', expected_units: 550, launch_id: 'launch-1' },
        { id: 't-m', product_title: MEN, po_header_id: 'po-496', expected_units: 325 },
      ],
      launch_product_readiness: [{ id: 'lpr', product_tracker_id: 't-y', expected_units: 550 }],
    });
    const res = await P.sync(sb, { po: PO });
    const youth = sb.db.product_tracker.find((x) => x.id === 't-y');
    r.eq(youth.po_header_id, null);
    r.eq(youth.expected_units, null, 'cleared, never left reporting units the PO no longer has');
    r.eq(sb.db.launch_product_readiness[0].expected_units, null);
    r.eq(res.released.map((a) => a.title), [YOUTH]);
    r.eq(sb.db.product_tracker.length, 2, 'released, never deleted');
  });

  await run('a PO with no lines left still releases what it owns (it used to return early)', async () => {
    const sb = fakeSb({ po_lines: [], product_tracker: [{ id: 't', product_title: 'Solo Tee', po_header_id: 'po-496', expected_units: 100 }] });
    const res = await P.sync(sb, { po: PO });
    r.eq(res.released.length, 1);
    r.eq(sb.db.product_tracker[0].expected_units, null);
  });

  await run('"New product PO" unticked: an owned item keeps following the PO; no new item appears', async () => {
    const restock = { ...PO, is_new_product_po: false };
    const sb = fakeSb({ po_lines: LINES, product_tracker: [{ id: 't-m', product_title: MEN, po_header_id: 'po-496', expected_units: 300 }] });
    const res = await P.sync(sb, { po: restock });
    r.eq(sb.db.product_tracker.length, 1, 'the youth tee was not added');
    r.eq(sb.db.product_tracker[0].expected_units, 325);
    r.eq(res.inserted, []);
  });

  await run('through the queue, overlapping requests add it once, and the last change is still synced', async () => {
    const sb = fakeSb({ po_lines: LINES.slice(6), product_tracker: [] }, { delayMs: 5 });
    let runs = 0;
    const q = P.createQueue(async (arg) => { runs += 1; return P.sync(sb, arg); });
    const first = q('po-496', { po: PO });
    // A qty edit lands while the first sync is still in flight.
    sb.db.po_lines.find((l) => l.variant_title_snapshot === 'YXL').qty = 205;
    const second = q('po-496', { po: PO });
    const third = q('po-496', { po: PO });
    await Promise.all([first, second, third]);
    r.eq(sb.db.product_tracker.length, 1, 'one item');
    r.eq(sb.db.product_tracker[0].expected_units, 650, 'the edit made mid-flight is reflected');
    r.eq(runs, 2, 'two requests while running coalesce into one more run');
  });

  await run('the queue merges what was asked for while waiting', async () => {
    const seen = [];
    let release;
    const gate = new Promise((res) => { release = res; });
    const q = P.createQueue(async (arg) => { seen.push(arg); if (seen.length === 1) await gate; return arg; },
      (a, b) => ({ keys: a.keys.concat(b.keys) }));
    const p1 = q('k', { keys: ['first'] });
    q('k', { keys: ['a'] });
    q('k', { keys: ['b'] });
    release();
    await p1;
    await new Promise((res) => setTimeout(res, 0));
    r.eq(seen.map((x) => x.keys), [['first'], ['a', 'b']]);
  });

  await run('different POs do not wait on each other', async () => {
    let active = 0; let peak = 0;
    const q = P.createQueue(async () => { active += 1; peak = Math.max(peak, active); await new Promise((res) => setTimeout(res, 5)); active -= 1; });
    await Promise.all([q('po-a', {}), q('po-b', {})]);
    r.eq(peak, 2);
  });

  // ── wiring in po-builder.html ──────────────────────────────────────────────

  const page = fs.readFileSync(path.join(V2, 'po-builder.html'), 'utf8');
  const pageHas = (needle) => r.truthy(page.includes(needle), `po-builder.html should contain ${JSON.stringify(needle)}`);
  const pageLacks = (needle) => r.truthy(!page.includes(needle), `po-builder.html should not contain ${JSON.stringify(needle)}`);

  /** The body of the function declared as `async function NAME(` / `function NAME(`. */
  function fnBody(name) {
    const start = page.search(new RegExp(`\\n\\s*(async\\s+)?function\\s+${name}\\s*\\(`));
    if (start < 0) throw new Error(`no function ${name} in po-builder.html`);
    const rest = page.slice(start + 1);
    const next = rest.slice(1).search(/\n\s*(async\s+)?function\s+\w+\s*\(/);
    return next < 0 ? rest : rest.slice(0, next + 1);
  }

  r.test('po-builder loads the sync module', () => {
    pageHas('<script src="po-pipeline-sync.js"></script>');
  });

  r.test('the per-line sync that wrote one size\'s qty is gone', () => {
    pageLacks('autoSyncLineToTracker');
    pageLacks('expected_units:Number(linePayload.qty)');
  });

  r.test('every function that writes PO lines syncs the Pipeline afterwards', () => {
    // Find every function containing a po_lines insert / delete / line save,
    // rather than listing them: a new line-writing path added later is caught
    // here without anyone remembering to add it to a list.
    const writers = new Set();
    const re = /from\('po_lines'\)\.(insert|delete|update\(payload\))/g;
    let m;
    while ((m = re.exec(page))) {
      const before = page.slice(0, m.index);
      const decls = [...before.matchAll(/\n\s*(?:async\s+)?function\s+(\w+)\s*\(/g)];
      writers.add(decls[decls.length - 1][1]);
    }
    r.truthy(writers.size >= 8, `expected the eight line-writing paths, found ${[...writers].join(', ')}`);
    const missing = [...writers].filter((name) => !/syncPipeline\(/.test(fnBody(name)));
    r.eq(missing, [], 'functions that write po_lines without syncing the Pipeline');
  });

  r.test('saving the header syncs too (ticking "New product PO" on a PO that already has lines)', () => {
    r.has(fnBody('saveHeader'), 'syncPipeline(');
  });

  r.test('restock POs are never auto-added; -> TRK is the explicit path', () => {
    pageHas("const create=po.is_new_product_po ? true : (keys.length ? keys : false);");
    r.has(fnBody('pushLineToPipeline'), 'syncPipeline({keys:');
  });

  r.test('-> TRK reads the real line list (it looked in state.lines, which never existed)', () => {
    r.truthy(!/state\.lines\s*\|\||state\.po\?\./.test(page), 'state.lines / state.po are not fields of state');
    r.has(fnBody('pushLineToPipeline'), 'state.currentLines');
  });

  r.test('a company-scoped sync reads only that company\'s rows', () => {
    // (covered by the first sync case: the fake filters on company_entity_id,
    // and an unscoped fixture there returned nothing)
    r.has(fnBody('pipelineCompanyId'), 'ensureActiveCompany');
  });

  r.test('-> TRK is hidden where the sync is automatic', () => {
    pageHas("state.currentPO?.is_new_product_po ? '' : `<button");
  });

  process.exit(r.summary().fail ? 1 : 0);
})();

function byTitleRows(rows) { return Object.fromEntries(rows.map((x) => [x.product_title, x])); }
