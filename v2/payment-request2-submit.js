import { requestPayload, safeFileName } from './payment-request2-core.js';

function cleanErrorPart(value, max = 280) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// PostgREST/Supabase errors are already written for API callers, but keep the
// displayed text bounded and free of control characters. Persisting the same
// safe shape in the local draft means a retry never erases the reason the
// first attempt failed.
export function safeInsertFailure(error) {
  const code = cleanErrorPart(error?.code, 40);
  const message = cleanErrorPart(error?.message || error, 280) || 'The database did not accept the request.';
  const details = cleanErrorPart(error?.details, 180);
  const hint = cleanErrorPart(error?.hint, 180);
  return { code: code || null, message, details: details || null, hint: hint || null };
}

export function insertFailureMessage(failure) {
  const suffix = failure.code ? ` [${failure.code}]` : '';
  return `Request was not created: ${failure.message}${suffix}`;
}

// Every side effect is reached through this function in both the page and tests.
// A checkpoint must succeed BEFORE the first write and before receipt delivery.
export async function submitRequest({ db, draft, userId, companyId, assertContext, checkpoint, progress = () => {} }) {
  await assertContext();
  if (!draft.payload) {
    draft.payload = requestPayload(draft, userId, companyId);
    draft.status = 'submitting';
  }
  // Also on retry: a failed checkpoint must never become a way around the
  // revision guard merely because the in-memory payload is already frozen.
  await checkpoint(draft);
  const payload = draft.payload;
  if (payload.id !== draft.id || payload.created_by !== userId || payload.company_entity_id !== companyId) throw Error('This saved request belongs to a different session. Sign back into its company.');
  const readRequest = async () => {
    await assertContext();
    const { data, error } = await db.from('payment_requests').select('id,created_by,company_entity_id,workflow_status').eq('id', draft.id).eq('company_entity_id', companyId).maybeSingle();
    if (error) throw Error('Could not confirm whether AP received this request. Retry here using the same reference.');
    if (data && (data.created_by !== userId || data.company_entity_id !== companyId)) throw Error('The saved reference does not belong to this session.');
    return data;
  };
  let row = await readRequest();
  if (!row) {
    progress('Sending your reviewed request to AP…');
    await assertContext();
    let insertError;
    try { ({ error: insertError } = await db.from('payment_requests').insert(payload)); }
    catch (error) { insertError = error; }
    if (insertError) {
      row = await readRequest();
      if (!row) {
        const failure = safeInsertFailure(insertError);
        draft.lastSubmitError = { ...failure, at: new Date().toISOString() };
        await checkpoint(draft);
        throw Error(`${insertFailureMessage(failure)} Your saved draft keeps the same reference; retry here.`);
      }
    } else row = { ...payload };
  }
  delete draft.lastSubmitError;
  draft.requestSaved = true;
  await checkpoint(draft);
  if (!['new', 'in_review', 'needs_info'].includes(row.workflow_status)) {
    if (draft.status === 'submitted') return { requestId: draft.id, filesComplete: true, message: 'Your completed request is already with AP.' };
    draft.status = 'needs_ap_help';
    await checkpoint(draft);
    return { requestId: draft.id, filesComplete: false, message: 'AP has already moved this request forward. Contact AP about any remaining documents. They remain in the saved draft on this device.' };
  }
  for (const [index, attachment] of draft.files.entries()) {
    await assertContext();
    progress(`Attaching document ${index + 1} of ${draft.files.length}…`);
    const path = `${draft.id}/${attachment.id}-${safeFileName(attachment.name)}`;
    const readMetadata = async () => {
      const { data, error } = await db.from('payment_request_files').select('id,file_path,payment_request_id').eq('id', attachment.id).eq('payment_request_id', draft.id).eq('company_entity_id', companyId).maybeSingle();
      if (error) throw Error('Request saved. Could not check its attachments; retry here.');
      if (data && data.file_path !== path) throw Error('Request saved. An attachment reference conflicts; contact AP.');
      return data;
    };
    if (await readMetadata()) continue;
    const bucket = db.storage.from('payment-request-files');
    await assertContext();
    const { error: uploadError } = await bucket.upload(path, attachment.blob, { upsert: false, contentType: attachment.type || 'application/octet-stream' });
    if (uploadError) {
      // A timed-out upload may have landed. Verify the bytes, never overwrite.
      const { data: existing, error } = await bucket.download(path);
      if (error || !existing) throw Error('Request saved, but a document could not be attached. Retry here; do not create another request.');
      const digest = async blob => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))).join(',');
      if (await digest(existing) !== await digest(attachment.blob)) throw Error('Request saved. A stored document differs from this draft; contact AP.');
    }
    await assertContext();
    const { error: metadataError } = await db.from('payment_request_files').insert({
      id: attachment.id, payment_request_id: draft.id, company_entity_id: companyId,
      file_name: attachment.name, file_path: path, file_url: null,
      file_size: attachment.blob.size, mime_type: attachment.type || null, sort_order: index + 1, created_by: userId,
    });
    if (metadataError && !await readMetadata()) throw Error('Request saved; a document uploaded but could not be linked. Retry here to finish linking it.');
  }
  if (!draft.receiptAttempted) {
    draft.receiptAttempted = true;
    await checkpoint(draft); // at-most-once attempt, including an ambiguous response
    await assertContext();
    try {
      const { data, error } = await db.functions.invoke('payment-request-submitted-notify', { body: { payment_request_id: draft.id } });
      draft.receiptStatus = error || data?.error ? 'unconfirmed' : 'requested';
    } catch { draft.receiptStatus = 'unconfirmed'; }
  }
  draft.status = 'submitted';
  await checkpoint(draft);
  return { requestId: draft.id, filesComplete: true, message: draft.receiptStatus === 'unconfirmed' ? 'Request and documents saved. Email receipt delivery could not be confirmed.' : 'Your request and documents are with AP for review.' };
}
