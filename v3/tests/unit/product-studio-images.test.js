'use strict';
// Concept reference images in Product Studio (v3/product-studio-images.js),
// ported from v2/tests/unit/product-concepts-image-attach.test.js when
// /v2/product-concepts.html became a forward to Studio. Same bug, same rules:
// an RLS refusal on an UPDATE is a success with ZERO rows, so success must be
// read from the returned row, and a refused attach must clean up the file it
// already put in the public bucket and never report "Added".
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.resolve(__dirname, '../../product-studio-images.js'), 'utf8');
const g = { window: {} }; vm.createContext(g); vm.runInContext(src, g);
const S = g.window.SiloStudioImages;

function fakeDb({ uploadError = null, freshUrls = [], updateResult }) {
  const removed = [], uploaded = [], filters = [];
  const chain = (result) => { const q = { eq: (k, v) => { filters.push([k, v]); return q; }, single: async () => result, select: () => q, maybeSingle: async () => updateResult }; return q; };
  return {
    storage: { from: () => ({
      upload: async (p) => { uploaded.push(p); return { error: uploadError }; },
      getPublicUrl: (p) => ({ data: { publicUrl: 'https://fixture.local/' + p } }),
      remove: async (paths) => { removed.push(...paths); return { error: null }; },
    }) },
    from: (table) => { assert.equal(table, 'product_concepts'); return { select: () => chain({ data: { reference_image_urls: freshUrls }, error: null }), update: () => chain(null) }; },
    removed, uploaded, filters,
  };
}
const file = (name) => ({ type: 'image/png', name });
const opts = { uuid: () => 'fixed-uuid' };

(async () => {
  assert.equal(S.canEditConcept({ created_by: 'me', status: 'draft' }, { userId: 'me' }), true, 'own draft');
  assert.equal(S.canEditConcept({ created_by: 'me', status: 'approved' }, { userId: 'me' }), false, 'own approved needs purchasing');
  assert.equal(S.canEditConcept({ created_by: 'x', status: 'draft' }, { userId: 'me' }), false, "someone else's draft");
  assert.equal(S.canEditConcept(null, { canWrite: true }), false, 'no concept');
  assert.equal(S.canEditConcept({ created_by: 'x', status: 'approved' }, { canWrite: true, userId: 'me' }), true, 'purchasing writer');

  let db = fakeDb({ freshUrls: ['https://fixture.local/existing.png'], updateResult: { data: { id: 'c1', reference_image_urls: ['https://fixture.local/existing.png', 'https://fixture.local/concepts/fixed-uuid/x.png'] }, error: null } });
  const ok = await S.attachConceptImages(db, 'C1', { id: 'c1', reference_image_urls: [] }, [file('x.png'), { type: 'text/plain', name: 'n.txt' }], opts);
  assert.equal(ok.added, 1); assert.equal(ok.urls.length, 2, 'merged with an image added elsewhere');
  assert.deepEqual(db.removed, []); assert.deepEqual(db.uploaded, ['concepts/fixed-uuid/x.png'], 'non-images are skipped');
  assert.ok(db.filters.some(([k, v]) => k === 'company_entity_id' && v === 'C1'), 'writes are scoped to the active company');

  db = fakeDb({ updateResult: { data: null, error: null } });
  await assert.rejects(() => S.attachConceptImages(db, 'C1', { id: 'c2' }, [file('y.png')], opts), (e) => !/Added/.test(e.message) && /cannot edit/.test(e.message));
  assert.deepEqual(db.removed, db.uploaded, 'an RLS-refused attach removes the orphaned upload');

  db = fakeDb({ updateResult: { data: null, error: { message: 'permission denied' } } });
  await assert.rejects(() => S.attachConceptImages(db, 'C1', { id: 'c3' }, [file('z.png')], opts), /permission denied/);
  assert.equal(db.removed.length, 1, 'a hard error also cleans up');

  db = fakeDb({ uploadError: { message: 'bucket full' }, updateResult: null });
  await assert.rejects(() => S.attachConceptImages(db, 'C1', { id: 'c4' }, [file('a.png')], opts), /Upload failed: bucket full/);

  console.log('Product Studio concept image attach: permission mirror, verified write, orphan cleanup passed.');
})().catch((e) => { console.error(e); process.exit(1); });
