/* v2/product-concepts.html -- who may attach a reference image, and what
 * happens when the database refuses the write.
 *
 * The bug (PR #830 review, 2026-09-30): "Add reference image" rendered for
 * EVERY visible concept, including another member's already-approved
 * concept or another member's still-draft one. product_concepts' UPDATE
 * policy (20260821110000) only allows the creator (while status='draft') or
 * po_builder_can_write(). An RLS refusal on an UPDATE is a SUCCESS WITH ZERO
 * ROWS, not an error -- the old code checked only `upErr` (which stayed
 * null), optimistically wrote the merged url list onto the in-memory
 * concept, and told the person "Added". A reload lost the attachment; the
 * file the browser had already uploaded stayed behind in the PUBLIC
 * product-concept-images bucket.
 *
 * What must hold, against the REAL script slice (not a reimplementation):
 *   - canEditConcept(): creator+draft or po_builder_can_write()-equivalent
 *     is editable; anyone else, on any other status, is not
 *   - a successful UPDATE (a row comes back) shows success and never calls
 *     storage.remove()
 *   - an RLS-refused UPDATE (.maybeSingle() resolves { data: null, error:
 *     null } -- the real shape of a zero-row update) shows FAILURE, never
 *     "Added", and cleans up the just-uploaded object via storage.remove()
 *   - a hard update error behaves the same way (failure shown, cleanup run)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');

const r = createReporter('product-concepts-image-attach');

const HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', 'product-concepts.html'), 'utf8');
const lines = HTML.split('\n');
const startIdx = lines.findIndex((l) => l.trim() === 'let concepts = [];');
const endIdx = lines.findIndex((l) => l.trim().startsWith("el('list').addEventListener"));
if (startIdx < 0 || endIdx < 0) {
  throw new Error('product-concepts.html changed shape -- update the slice markers in this test');
}
const SLICE = lines.slice(startIdx, endIdx).join('\n');

/** Element stub: enough surface for uploadImages' el('btnAddImage') / el('fileImage'). */
function fakeEl() {
  const listeners = {};
  return {
    value: '',
    classList: { add() {}, remove() {} },
    addEventListener(type, fn) { listeners[type] = fn; },
    listeners,
  };
}

function makeSandbox(db) {
  const g = {};
  g.window = g;
  g.globalThis = g;
  g.console = console;
  g.Array = Array; g.Object = Object; g.JSON = JSON; g.Set = Set;
  g.crypto = { randomUUID: () => 'fixed-uuid' };
  g.db = db;
  const els = {};
  g.el = (id) => (els[id] || (els[id] = fakeEl()));
  const statuses = [];
  g.setStatus = (msg, kind, ms) => statuses.push({ msg, kind, ms });
  vm.createContext(g);
  vm.runInContext(SLICE, g, { filename: 'product-concepts-slice.js' });
  // renderDetail is real DOM/markup code (window.SiloEvidenceCard, CONCEPT_SPEC,
  // esc/h helpers) none of which this slice defines on its own -- neither is
  // under test here, so it's replaced with a spy rather than reproducing that
  // rendering machinery just to make it not throw.
  g.renderDetail = function () { g.__renderDetailCalls = (g.__renderDetailCalls || 0) + 1; };
  return { g, els, statuses };
}

/** A minimal db covering exactly what uploadImages/canEditConcept touch. */
function fakeDb({ uploadError = null, freshUrls = [], updateResult } = {}) {
  const removed = [];
  const uploaded = [];
  return {
    storage: {
      from: () => ({
        upload: async (p) => { uploaded.push(p); return { error: uploadError }; },
        getPublicUrl: (p) => ({ data: { publicUrl: 'https://fixture.local/' + p } }),
        remove: async (paths) => { removed.push(...paths); return { data: null, error: null }; },
      }),
    },
    from: (table) => {
      if (table !== 'product_concepts') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { reference_image_urls: freshUrls }, error: null }),
          }),
        }),
        update: () => ({
          eq: () => ({
            select: () => ({
              maybeSingle: async () => updateResult,
            }),
          }),
        }),
      };
    },
    _removed: removed,
    _uploaded: uploaded,
  };
}

(async () => {
  // ── canEditConcept() ──────────────────────────────────────────────────
  {
    const { g } = makeSandbox(fakeDb({ updateResult: { data: null, error: null } }));
    g.currentUserId = 'u-me'; // no-op: let-bindings aren't globals; set via eval below
    vm.runInContext("currentUserId = 'u-me'; canWritePO = false;", g);

    r.ok('own draft is editable',
      g.canEditConcept({ created_by: 'u-me', status: 'draft' }) === true);
    r.ok('own APPROVED concept is not editable without PO-write',
      g.canEditConcept({ created_by: 'u-me', status: 'approved' }) === false);
    r.ok('someone else\'s draft is not editable',
      g.canEditConcept({ created_by: 'someone-else', status: 'draft' }) === false);
    r.ok('someone else\'s approved concept is not editable',
      g.canEditConcept({ created_by: 'someone-else', status: 'approved' }) === false);
    r.ok('null concept is not editable', g.canEditConcept(null) === false);

    vm.runInContext('canWritePO = true;', g);
    r.ok('po_builder_can_write() edits anyone\'s draft',
      g.canEditConcept({ created_by: 'someone-else', status: 'draft' }) === true);
    r.ok('po_builder_can_write() edits anyone\'s approved concept too',
      g.canEditConcept({ created_by: 'someone-else', status: 'approved' }) === true);
  }

  // ── uploadImages(): success path ────────────────────────────────────
  {
    const db = fakeDb({
      freshUrls: ['https://fixture.local/existing.png'],
      updateResult: {
        data: { id: 'c-1', reference_image_urls: ['https://fixture.local/existing.png', 'https://fixture.local/concepts/fixed-uuid/x.png'] },
        error: null,
      },
    });
    const { g, els, statuses } = makeSandbox(db);
    const concept = { id: 'c-1', reference_image_urls: [] };
    g.concepts = [concept];
    const file = { type: 'image/png', name: 'x.png' };
    await g.uploadImages([file], concept);

    r.ok('a successful update reports a positive status',
      statuses.some((s) => s.kind === 'pos' && /Added/.test(s.msg)), JSON.stringify(statuses));
    r.ok('the concept object is updated with the merged list',
      concept.reference_image_urls.includes('https://fixture.local/concepts/fixed-uuid/x.png'));
    r.ok('nothing is removed from storage on success', db._removed.length === 0, JSON.stringify(db._removed));
    r.ok('renderDetail is called to redraw the card', g.__renderDetailCalls === 1);
  }

  // ── uploadImages(): RLS refusal -- the exact bug ────────────────────
  {
    const db = fakeDb({
      updateResult: { data: null, error: null }, // the real shape of a zero-row RLS-refused update
    });
    const { g, statuses } = makeSandbox(db);
    const concept = { id: 'c-2', reference_image_urls: ['https://fixture.local/old.png'] };
    g.concepts = [concept];
    const file = { type: 'image/png', name: 'y.png' };
    await g.uploadImages([file], concept);

    r.ok('an RLS-refused update is reported as a FAILURE, not success',
      statuses.some((s) => s.kind === 'neg'), JSON.stringify(statuses));
    r.ok('the failure is never worded as "Added"',
      !statuses.some((s) => /^Added/.test(s.msg)), JSON.stringify(statuses));
    r.ok('the concept object is left unchanged -- no false attachment',
      concept.reference_image_urls.length === 1 && concept.reference_image_urls[0] === 'https://fixture.local/old.png');
    r.ok('the orphaned upload is cleaned up from the public bucket',
      db._removed.length === 1 && db._removed[0] === db._uploaded[0], JSON.stringify({ removed: db._removed, uploaded: db._uploaded }));
  }

  // ── uploadImages(): a real update error behaves the same way ───────
  {
    const db = fakeDb({
      updateResult: { data: null, error: { message: 'permission denied' } },
    });
    const { g, statuses } = makeSandbox(db);
    const concept = { id: 'c-3', reference_image_urls: [] };
    g.concepts = [concept];
    await g.uploadImages([{ type: 'image/png', name: 'z.png' }], concept);

    r.ok('a hard update error is also reported as a failure',
      statuses.some((s) => s.kind === 'neg'), JSON.stringify(statuses));
    r.ok('a hard update error also cleans up the orphaned upload',
      db._removed.length === 1);
  }

  process.exit(r.summary().fail ? 1 : 0);
})();
