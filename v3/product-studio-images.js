/* Concept reference images in Product Studio. Moved here from
 * /v2/product-concepts.html (now a forward to Studio) with its rules intact:
 *
 *   - canEditConcept() mirrors product_concepts' UPDATE policy
 *     (20260821110000): purchasing writers edit any concept, a creator edits
 *     their own draft. UX only -- RLS decides.
 *   - an RLS refusal on an UPDATE is a SUCCESS WITH ZERO ROWS, not an error,
 *     so a missing returned row is the failure signal. On any failure the
 *     just-uploaded files are removed from the PUBLIC bucket rather than left
 *     orphaned, and nothing claims the image was added (PR #830 review).
 *   - the current url list is re-read and merged, so an image added from Ask
 *     SILO or another tab since the page loaded is kept.
 *
 * Images are not purchasing details: attaching one never changes Ready for PO.
 */
(function (root) {
  'use strict';
  const BUCKET = 'product-concept-images';
  function canEditConcept(concept, { canWrite = false, userId = null } = {}) {
    if (!concept) return false;
    if (canWrite) return true;
    return concept.created_by === userId && concept.status === 'draft';
  }
  async function attachConceptImages(db, companyId, concept, files, { uuid = () => crypto.randomUUID() } = {}) {
    const added = [], paths = [];
    for (const file of files || []) {
      if (!String(file?.type || '').startsWith('image/')) continue;
      const path = `concepts/${uuid()}/${file.name}`;
      const { error } = await db.storage.from(BUCKET).upload(path, file, { upsert: false });
      if (error) {
        if (paths.length) await db.storage.from(BUCKET).remove(paths).catch(() => {});
        throw new Error('Upload failed: ' + error.message);
      }
      const { data: pub } = db.storage.from(BUCKET).getPublicUrl(path);
      if (pub?.publicUrl) { added.push(pub.publicUrl); paths.push(path); }
    }
    if (!added.length) return { added: 0, urls: concept.reference_image_urls || [] };
    const cleanup = () => db.storage.from(BUCKET).remove(paths).catch(() => {});
    const { data: fresh, error: readError } = await db.from('product_concepts').select('reference_image_urls')
      .eq('company_entity_id', companyId).eq('id', concept.id).single();
    if (readError) { await cleanup(); throw new Error('Could not attach the image: ' + readError.message); }
    const merged = [...new Set([...(fresh?.reference_image_urls || []), ...added])];
    const { data: saved, error } = await db.from('product_concepts')
      .update({ reference_image_urls: merged, revision_note: `Added ${added.length} reference image${added.length === 1 ? '' : 's'} in Product Studio.` })
      .eq('company_entity_id', companyId).eq('id', concept.id)
      .select('id, reference_image_urls').maybeSingle();
    if (error || !saved) {
      await cleanup();
      throw new Error(error ? 'Could not attach the image: ' + error.message : 'You cannot edit this concept, so the image was not attached.');
    }
    return { added: added.length, urls: saved.reference_image_urls };
  }
  root.SiloStudioImages = { canEditConcept, attachConceptImages, BUCKET };
})(typeof window !== 'undefined' ? window : globalThis);
