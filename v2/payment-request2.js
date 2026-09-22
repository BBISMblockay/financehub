import { REQUEST_TYPES, ACTIVE_PO_STATUSES, FIELD_NAMES, normalizeName, validateFields, applySuggestions, clearSourceSuggestions, documentMime } from './payment-request2-core.js';
import { saveDraft, listDrafts } from './payment-request2-drafts.js';
import { readDocumentOnDevice } from './payment-request2-reader-browser.js';
import { mountPdfPreview } from './payment-request2-preview.js';
import { interpretMissing } from './payment-request2-reader.js';
import { submitRequest, resumeMessage, repairDraftText } from './payment-request2-submit.js';
import { textRepairPlan, visibleText } from './payment-request2-text.js';
import { createDuplicateChecker, duplicateAcknowledgement } from './payment-request2-duplicates.js';

const $ = id => document.getElementById(id);
const cfg = window.__SILO_CONFIG__ || {};
let db, user, company, scope, draft, busy = false, invalidSession = false;
let vendors = [], pos = [], locations = [], selectedPos = new Set(), duplicateState = null;
let disposePreview, previewUrl = null, readGeneration = 0, dirty = false, readingController;
const duplicateChecker = createDuplicateChecker({ lookup: lookupDuplicates, publish: renderDuplicateStatus });
const feedback = (message, tone = 'info') => {
  $('status').className = `bcn-status bcn-status--${tone}`;
  $('status').textContent = message; $('status').hidden = !message;
};
const element = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
function newDraft() {
  return { id: crypto.randomUUID(), revision: 0, status: 'draft', fields: Object.fromEntries(FIELD_NAMES.map(k => [k, k === 'requester_email' ? user.email || '' : k === 'currency' ? 'USD' : ''])), files: [], poNames: [], primaryId: '', appliedPos: [], applied: {}, suggestion: null, reviewed: false };
}
function capture() {
  if (draft.payload) return;
  for (const key of FIELD_NAMES) draft.fields[key] = $(key).value;
  draft.poNames = [...new Set([...selectedPos, ...$('manualPo').value.split(',').map(x => x.trim()).filter(Boolean)])];
  draft.reviewed = $('reviewed').checked;
}
function changed() {
  if (draft.payload) return;
  capture(); dirty = true; draft.reviewed = false; $('reviewed').checked = false;
  queueDuplicateCheck();
  $('saveState').textContent = 'Unsaved changes · Drafts stay on this device.';
  updateHints();
  renderRepairControl();
}
function renderRepairControl() {
  $('repairText').hidden = !textRepairPlan(draft).length;
  $('repairText').disabled = busy || invalidSession;
}
function lockUI() {
  const frozen = !!draft?.payload;
  $('editFields').disabled = busy || frozen || invalidSession;
  for (const id of ['sourceSelect', 'readDocument', 'addDocuments', 'fileInput', 'saveDraft', 'startPo', 'startManual', 'applySuggestions', 'assistMissing', 'aiConsent', 'reviewed']) {
    $(id).disabled = busy || frozen || invalidSession;
  }
  $('submitBtn').disabled = busy || invalidSession;
  $('dropzone').setAttribute('aria-disabled', String(busy || frozen || invalidSession));
  $('submitBtn').textContent = busy ? 'Working…' : frozen ? 'Retry this request' : 'Submit to AP';
  if (!busy && !frozen && !invalidSession) $('readDocument').disabled = !readablePrimary();
  $('draftBadge').textContent = frozen ? (draft.lastSubmitError ? 'Last attempt rejected' : 'Submission started') : 'Not submitted';
  $('duplicateAck').disabled = busy || frozen || invalidSession;
  for (const button of $('attachmentList').querySelectorAll('button')) button.disabled = busy || frozen || invalidSession;
  renderRepairControl();
}
function reviewTextRepair(changes) {
  const dialog = $('textRepairDialog');
  $('textRepairChanges').replaceChildren();
  for (const change of changes) {
    const block = element('section');
    block.append(element('h3', change.label), element('small', 'Original (unsupported characters marked)'), element('pre', visibleText(change.before)), element('small', 'Corrected'), element('pre', change.after || '(empty)'));
    $('textRepairChanges').append(block);
  }
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'save'), { once: true });
    dialog.showModal();
  });
}
async function repairTextOnDevice() {
  if (busy || invalidSession) return;
  capture();
  if (!navigator.locks) { feedback('Use a current browser to safely repair this saved draft.', 'neg'); return; }
  busy = true; lockUI();
  try {
    await navigator.locks.request(`silo-pr2:${scope}:${draft.id}`, { ifAvailable: true }, async lock => {
      if (!lock) throw Error('This request is open for submission in another tab. Wait, then reload.');
      const repaired = await repairDraftText({ db, draft, userId: user.id, companyId: company.id, assertContext, checkpoint, review: reviewTextRepair });
      if (repaired) {
        renderDraft();
        feedback(draft.payload ? 'Corrected text saved with the same reference. Use Retry this request to submit.' : 'Corrected text saved. Review your request and check the confirmation before submitting.');
      }
    });
  } catch (error) { feedback(error.message, 'neg'); }
  finally { busy = false; lockUI(); }
}
async function assertContext() {
  if (invalidSession) throw Error('Your session changed. Reload this page before continuing.');
  const { data, error } = await db.auth.getUser();
  if (error || data?.user?.id !== user.id) { invalidSession = true; lockUI(); throw Error('Your sign-in changed. Reload and sign in before continuing.'); }
  const { data: profile, error: profileError } = await db.from('profiles').select('is_active,active_company_id').eq('id', user.id).single();
  if (profileError) throw Error('Could not verify your company. Check your connection and retry.');
  if (!profile?.is_active || profile.active_company_id !== company.id) { invalidSession = true; lockUI(); throw Error('Your active company or account access changed. Reload before continuing.'); }
  const { data: member, error: memberError } = await db.from('entity_memberships').select('entity_id').eq('user_id', user.id).eq('entity_id', company.id).maybeSingle();
  if (memberError || !member) throw Error('Company membership could not be verified. Please reload or ask your admin.');
}
async function checkpoint(value) { await saveDraft(scope, value); dirty = false; $('saveState').textContent = 'Saved on this device · Not shared across devices.'; }
async function showDraftShelf() {
  const saved = await listDrafts(scope);
  $('draftList').replaceChildren();
  for (const item of saved) {
    const button = element('button', `${item.fields.vendor_name || 'Untitled request'}${item.payload ? ' · Resume submission' : ' · Resume draft'}`, 'bcn-btn bcn-btn--ghost');
    button.type = 'button';
    button.addEventListener('click', () => {
      if (busy || draft.payload) return;
      if (dirty) { feedback('Save your current draft on this device before opening another.'); return; }
      const resume = resumeMessage(item);
      draft = item; renderDraft(); $('draftShelf').hidden = true;
      feedback(resume.message, resume.tone);
    });
    $('draftList').append(button);
  }
  $('draftShelf').hidden = !saved.length;
}
function renderDraft() {
  for (const key of FIELD_NAMES) $(key).value = draft.fields[key] || '';
  selectedPos = new Set(draft.poNames.filter(n => pos.some(p => p.po_name === n)));
  $('manualPo').value = draft.poNames.filter(n => !selectedPos.has(n)).join(', ');
  draft.reviewed = false; $('reviewed').checked = false;
  duplicateChecker.reset(); queueDuplicateCheck();
  if (draft.payload) $('duplicateText').textContent = 'Duplicate check completed before submission started. Retry to finish this request.';
  renderPOs(); renderFiles(); renderSuggestions(); updateHints(); lockUI(); dirty = false;
}
function updateHints() {
  const f = draft.fields;
  const matching = vendors.some(v => normalizeName(v) === normalizeName(f.vendor_name));
  $('vendorHint').textContent = matching ? 'Name matches a vendor available in this company.' : 'Choose an existing name or enter a new payee.';
  if (draft.applied.vendor_name === f.vendor_name && f.vendor_name) $('vendorHint').textContent += ' Suggested from document — review.';
  $('requesterLabel').textContent = f.requester_email;
  const type = f.request_type;
  $('typeHint').textContent = draft.applied.request_type === type && type ? 'Suggested from document — review the request type.' : type === 'employee_reimbursement' ? 'Payee should be the person being reimbursed; attach their receipts.' : type === 'customer_refund' ? 'Identify the customer and include the order/refund context in notes.' : 'The request goes to AP for review.';
  if (type?.startsWith('inventory_') || draft.poNames.length) $('poDetails').open = true;
  const total = draft.suggestion?.invoice_total;
  $('amountHint').textContent = typeof total === 'number' ? `Document total: ${total.toFixed(2)} ${draft.suggestion.currency || '(currency unclear)'}. Confirm the amount requested, especially for a deposit or balance.` : 'For a deposit or partial payment, enter only the amount requested.';
  $('freightNotice').hidden = type !== 'inventory_freight';
  $('freightText').textContent = draft.poNames.length > 1 ? 'Freight covers multiple POs. Review the allocation in Costing; the full request amount must not be applied to every PO.' : 'Link the relevant PO and review freight in Costing. This request does not update landed costs.';
  $('costingLinks').replaceChildren();
  for (const po of pos.filter(p => draft.poNames.includes(p.po_name))) {
    const a = element('a', `${po.po_name} in Costing ↗`); a.href = `po-costing.html?po_id=${encodeURIComponent(po.id)}`; a.target = '_blank'; a.rel = 'noopener noreferrer'; $('costingLinks').append(a);
  }
}
function renderPOs() {
  $('poList').replaceChildren(); $('poChips').replaceChildren();
  const search = $('poSearch').value.toLowerCase();
  for (const po of pos.filter(p => `${p.po_name} ${p.factory_name} ${p.status}`.toLowerCase().includes(search))) {
    const label = element('label'), check = element('input'); check.type = 'checkbox'; check.checked = selectedPos.has(po.po_name);
    const text = element('span', po.po_name); text.append(element('small', `${po.factory_name || 'Supplier not specified'} · ${po.status}`)); label.append(check, text);
    check.addEventListener('change', () => {
      draft.appliedPos = (draft.appliedPos || []).filter(name => name !== po.po_name);
      if (check.checked) {
        selectedPos.add(po.po_name);
        if (!draft.fields.vendor_name && draft.fields.request_type !== 'inventory_freight' && po.factory_name) $('vendor_name').value = po.factory_name;
      } else selectedPos.delete(po.po_name);
      changed(); renderPOs();
    });
    $('poList').append(label);
  }
  if (!$('poList').childElementCount) $('poList').append(element('small', 'No matching POs in the available list. You can enter a reference below.'));
  for (const name of selectedPos) {
    const button = element('button', `${name} ×`); button.type = 'button'; button.setAttribute('aria-label', `Remove ${name}`);
    button.addEventListener('click', () => { selectedPos.delete(name); draft.appliedPos = (draft.appliedPos || []).filter(n => n !== name); changed(); renderPOs(); }); $('poChips').append(button);
  }
  $('poCount').textContent = draft.poNames.length ? `${draft.poNames.length} linked` : 'Optional';
}
function readablePrimary() {
  const file = draft.files.find(f => f.id === draft.primaryId);
  return file && documentMime(file) && file.blob.size <= 4 * 1024 * 1024;
}
function changeSource(id) {
  readGeneration++;
  if (id !== draft.primaryId) {
    capture();
    for (const name of draft.appliedPos || []) selectedPos.delete(name);
    draft.appliedPos = []; renderPOs();
    draft.fields = clearSourceSuggestions(draft.fields, draft.applied); draft.applied = {}; draft.suggestion = null; draft.localRead = null; $('aiConsent').checked = false;
    for (const key of FIELD_NAMES) $(key).value = draft.fields[key] || '';
    draft.primaryId = id; changed();
  }
  renderFiles(); renderSuggestions();
}
function renderFiles() {
  disposePreview?.(); disposePreview = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null;
  $('sourceSelect').replaceChildren(); $('attachmentList').replaceChildren(); $('preview').replaceChildren();
  for (const file of draft.files) {
    const option = element('option', file.name); option.value = file.id; $('sourceSelect').append(option);
    const row = element('div'), name = element('span', `${file.name} · ${(file.blob.size / 1024).toFixed(0)} KB`), remove = element('button', 'Remove'); remove.type = 'button';
    remove.addEventListener('click', () => {
      if (busy || draft.payload) return;
      draft.files = draft.files.filter(f => f.id !== file.id);
      if (draft.primaryId === file.id) changeSource(draft.files[0]?.id || ''); else { changed(); renderFiles(); }
    }); row.append(name, remove); $('attachmentList').append(row);
  }
  if (!draft.files.length) $('sourceSelect').append(element('option', 'No document selected'));
  $('sourceSelect').value = draft.primaryId;
  const file = draft.files.find(f => f.id === draft.primaryId);
  $('openDocument').hidden = !file;
  if (file) {
    const mime = documentMime(file);
    if (mime) {
      previewUrl = URL.createObjectURL(new Blob([file.blob], { type: mime }));
      $('openDocument').href = previewUrl;
      if (mime === 'application/pdf') disposePreview = mountPdfPreview($('preview'), file.blob);
      else {
        const preview = element('img'); preview.alt = 'Source document for review';
        preview.src = previewUrl; $('preview').append(preview);
      }
    } else {
      $('openDocument').hidden = true;
      $('preview').append(element('p', 'This supporting file will be attached. Automatic reading is available for PDFs and images; enter its details manually.'));
    }
  } else $('preview').append(element('p', 'Your document appears here while you review the request.'));
  lockUI();
}
async function addFiles(files) {
  if (busy || draft.payload || invalidSession) return;
  const incoming = Array.from(files), allowed = /\.(pdf|png|jpe?g|webp|csv|xlsx?|docx?)$/i;
  if (draft.files.length + incoming.length > 10) { feedback('Attach up to 10 documents per request.', 'neg'); return; }
  if (incoming.some(f => !allowed.test(f.name) || !f.size || f.size > 10 * 1024 * 1024)) { feedback('Use supported documents up to 10 MB each. Empty files cannot be attached.', 'neg'); return; }
  if (draft.files.reduce((s, f) => s + f.blob.size, 0) + incoming.reduce((s, f) => s + f.size, 0) > 30 * 1024 * 1024) { feedback('Keep attachments under 30 MB in total.', 'neg'); return; }
  const first = !draft.files.length;
  for (const file of incoming) draft.files.push({ id: crypto.randomUUID(), name: file.name, type: file.type, blob: file });
  if (first) draft.primaryId = draft.files[0].id;
  changed(); renderFiles();
  if (first && readablePrimary()) await readDocument();
  else feedback('Documents added. You can read a selected PDF/image or enter details manually.');
}
function renderSuggestions() {
  const s = draft.suggestion; $('extractionPanel').hidden = !s; $('applySuggestions').hidden = !s;
  $('extractionWarnings').replaceChildren();
  $('localText').textContent = draft.localRead?.text || '';
  $('localTextDetails').hidden = !draft.localRead;
  $('aiHelp').hidden = !draft.localRead || draft.localRead.multipleInvoices || !['vendor_name', 'amount_due', 'currency', 'invoice_number'].some(key => s?.[key] == null);
  if (!s) return;
  $('extractionText').textContent = draft.localRead ? `${draft.localRead.method === 'ocr' ? 'Text read from the scan' : 'PDF text read'} on this device${draft.aiAssisted ? '; AI helped with missing details' : '; no AI used'}. Review the suggestions before filling fields.` : 'Saved document suggestions. Review before filling fields.';
  for (const warning of s.warnings || []) $('extractionWarnings').append(element('li', warning));
  if (s.currency && s.currency !== 'USD') $('extractionWarnings').append(element('li', `This document is in ${s.currency}. This workflow records USD only; ask AP to resolve the currency.`));
  const unmatched = (s.po_references || []).filter(ref => !pos.some(p => p.po_name.toLowerCase() === ref.toLowerCase()));
  if (unmatched.length) $('extractionWarnings').append(element('li', `Check these document PO references: ${unmatched.join(', ')}. They were not matched to the available PO list.`));
}
async function readDocument() {
  if (busy || draft.payload || !readablePrimary()) return;
  busy = true; lockUI(); const generation = ++readGeneration, sourceId = draft.primaryId;
  readingController = new AbortController();
  try {
    const file = draft.files.find(f => f.id === sourceId);
    const result = await readDocumentOnDevice(file, { signal: readingController.signal, progress: feedback });
    if (generation !== readGeneration || draft.primaryId !== sourceId || invalidSession) return;
    draft.localRead = result; draft.suggestion = result.suggestion; draft.aiAssisted = false;
    $('aiConsent').checked = false; changed(); renderSuggestions();
    feedback('Document read on this device. Review the suggested details; fill anything missing manually.');
  } catch (error) { feedback(error.message, 'neg'); }
  finally { readingController = null; busy = false; lockUI(); }
}
async function assistMissing() {
  if (busy || draft.payload || !draft.localRead) return;
  if (!$('aiConsent').checked) { feedback('Check the permission to share extracted text, or continue manually.'); return; }
  busy = true; lockUI(); const generation = ++readGeneration, sourceId = draft.primaryId;
  try {
    await assertContext(); feedback('Checking missing details…');
    const result = await interpretMissing(draft.localRead, { consent: true, companyId: company.id, invoke: (...args) => db.functions.invoke(...args) });
    if (generation !== readGeneration || draft.primaryId !== sourceId || invalidSession) return;
    await assertContext(); draft.suggestion = result; draft.aiAssisted = true;
    changed(); renderSuggestions(); feedback('Additional suggestions are ready. Check them against your document.');
  } catch (error) { feedback(error.message, 'neg'); }
  finally { busy = false; lockUI(); }
}

function useSuggestions() {
  if (busy || draft.payload || !draft.suggestion) return;
  capture(); const s = draft.suggestion;
  const result = applySuggestions(draft.fields, s);
  draft.fields = result.fields; draft.applied = { ...draft.applied, ...result.applied };
  for (const key of FIELD_NAMES) $(key).value = draft.fields[key] || '';
  if (!draft.poNames.length) for (const ref of s.po_references || []) {
    const matches = pos.filter(p => p.po_name.toLowerCase() === ref.toLowerCase());
    if (matches.length === 1) { selectedPos.add(matches[0].po_name); (draft.appliedPos ||= []).push(matches[0].po_name); }
  }
  changed(); renderPOs(); feedback('Suggestions filled. Confirm the request type, payee, amount, currency and PO links before submitting.');
}
function duplicateSnapshot() { return { companyId: company.id, draftId: draft.id, fields: draft.fields }; }
function queueDuplicateCheck() {
  if (invalidSession || !draft || draft.payload) return;
  duplicateChecker.update(duplicateSnapshot());
}
async function lookupDuplicates(snapshot) {
  await assertContext();
  // Same access/company scope and matching rules as the standard manual lookup.
  const { data, error } = await db.from('payment_requests').select('id,vendor_name,invoice_number,amount_due,workflow_status').eq('company_entity_id', snapshot.companyId).eq('vendor_name_norm', normalizeName(snapshot.fields.vendor_name)).order('created_at', { ascending: false }).limit(1000);
  if (error) throw Error('Could not check for existing requests. Try submitting again once your connection returns.');
  return data || [];
}
function renderDuplicateStatus({ phase, result }) {
  if (phase === 'checking') { $('duplicateText').textContent = 'Checking for existing requests…'; return; }
  if (duplicateAcknowledgement(result) !== duplicateAcknowledgement(duplicateState)) $('duplicateAck').checked = false;
  duplicateState = result;
  $('duplicateList').replaceChildren(); $('duplicateAckWrap').hidden = !result?.matches.length;
  if (phase !== 'complete') {
    $('duplicateText').textContent = phase === 'idle' ? 'Enter a payee and amount. We’ll check for existing requests automatically.' : phase === 'waiting' ? 'Checking automatically when you finish editing…' : 'Could not check for existing requests. We’ll try again when you edit the details or submit. Nothing has been cleared.';
    return;
  }
  for (const match of result.matches.slice(0, 8)) $('duplicateList').append(element('li', `${match.invoice_number || 'No invoice reference'} · $${Number(match.amount_due).toFixed(2)} · ${match.workflow_status} · ${match.id}`));
  $('duplicateText').textContent = result.matches.length ? `${result.matches.length} possible matching request(s). Review before continuing.` : `${result.limited ? 'No match in the latest 1,000 accessible requests for this payee.' : 'No match found among accessible requests for this payee.'} ${result.fields.invoice_number ? 'Compared invoice reference; amounts may differ for a partial payment.' : 'Compared amount. Add an invoice reference when available.'}`;
}
async function checkDuplicates() {
  capture();
  return duplicateChecker.checkNow(duplicateSnapshot());
}
async function submit(event) {
  event.preventDefault(); if (busy || invalidSession) return;
  capture();
  try {
    if (!draft.payload) {
      validateFields(draft.fields, $('reviewed').checked);
      if (draft.suggestion?.currency && draft.suggestion.currency !== 'USD') throw Error('The source document uses another currency. Ask AP to resolve it before submitting; it cannot be relabeled USD.');
    }
    if (!navigator.locks) throw Error('This browser cannot safely coordinate a resumed submission. Use a current browser or the standard form.');
    busy = true; lockUI();
    if (!draft.payload) {
      const priorAck = $('duplicateAck').checked;
      const acknowledgement = duplicateAcknowledgement(duplicateState);
      const checked = await checkDuplicates();
      if (checked.matches.length && (!priorAck || acknowledgement !== duplicateAcknowledgement(checked))) { $('duplicateAck').checked = false; throw Error('Review and acknowledge the possible duplicate requests before continuing.'); }
    }
    await navigator.locks.request(`silo-pr2:${scope}:${draft.id}`, { ifAvailable: true }, async lock => {
      if (!lock) throw Error('This request is being submitted in another tab. Wait, then reload its saved draft.');
      const result = await submitRequest({ db, draft, userId: user.id, companyId: company.id, assertContext, checkpoint, progress: text => feedback(text) });
      $('successText').textContent = result.message; $('successId').textContent = result.requestId;
      $('app').hidden = true; $('success').hidden = false; feedback(''); dirty = false;
    });
  } catch (error) { feedback(`${draft.requestSaved ? 'AP has the request. ' : ''}${error.message}`, 'neg'); }
  finally { busy = false; lockUI(); }
}
async function loadLookups() {
  const reads = await Promise.allSettled([
    db.from('payment_requests').select('vendor_name').eq('company_entity_id', company.id).order('created_at', { ascending: false }).limit(1000),
    db.from('factories').select('id,factory_name').eq('company_entity_id', company.id).eq('is_active', true).limit(1000),
    db.from('po_headers').select('id,po_name,factory_id,status').eq('company_entity_id', company.id).in('status', ACTIVE_PO_STATUSES).order('created_at', { ascending: false }).limit(300),
    db.from('locations').select('location_name').eq('company_entity_id', company.id).eq('is_active', true).limit(1000),
  ]);
  const rows = index => reads[index].status === 'fulfilled' && !reads[index].value.error ? reads[index].value.data || [] : [];
  const factories = rows(1);
  vendors = [...new Set([...rows(0).map(r => r.vendor_name), ...factories.map(r => r.factory_name)].filter(Boolean))].sort();
  pos = rows(2).map(po => ({ ...po, factory_name: factories.find(f => f.id === po.factory_id)?.factory_name || '' }));
  locations = [...new Set(rows(3).map(r => r.location_name))].sort();
  for (const [id, values] of [['vendorOptions', vendors], ['locationOptions', locations]]) {
    $(id).replaceChildren(...values.map(value => { const o = element('option'); o.value = value; return o; }));
  }
  $('poHelp').textContent = reads[2].status === 'rejected' || reads[2].value.error ? 'PO lookup unavailable. Enter the references manually below.' : `${pos.length} accessible POs, newest first (up to 300). Enter any missing reference below.`;
  renderPOs();
  if (reads.some(r => r.status === 'rejected' || r.value.error)) feedback('Some suggestions could not load. You can still enter the request manually.');
}
function bind() {
  $('repairText').addEventListener('click', repairTextOnDevice);
  $('requestForm').addEventListener('submit', submit);
  for (const key of FIELD_NAMES) $(key).addEventListener('input', changed);
  $('manualPo').addEventListener('input', () => { changed(); renderPOs(); });
  $('poSearch').addEventListener('input', renderPOs);
  $('request_type').addEventListener('change', () => { changed(); updateHints(); });
  $('saveDraft').addEventListener('click', async () => {
    if (busy || draft.payload) return;
    busy = true; lockUI();
    try { capture(); await assertContext(); await checkpoint(draft); feedback('Draft and documents saved on this device. AP has not received anything.'); await showDraftShelf(); }
    catch (error) { feedback(error.message, 'neg'); }
    finally { busy = false; lockUI(); }
  });
  const chooseFiles = () => { if (!busy && !draft.payload && !invalidSession) $('fileInput').click(); };
  $('dropzone').addEventListener('click', chooseFiles); $('addDocuments').addEventListener('click', chooseFiles);
  $('dropzone').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseFiles(); } });
  $('fileInput').addEventListener('change', async e => { await addFiles(e.target.files); e.target.value = ''; });
  $('dropzone').addEventListener('dragover', e => { e.preventDefault(); $('dropzone').classList.add('is-over'); });
  $('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('is-over'));
  $('dropzone').addEventListener('drop', e => { e.preventDefault(); $('dropzone').classList.remove('is-over'); void addFiles(e.dataTransfer.files); });
  $('sourceSelect').addEventListener('change', e => changeSource(e.target.value));
  $('readDocument').addEventListener('click', readDocument); $('assistMissing').addEventListener('click', assistMissing); $('applySuggestions').addEventListener('click', useSuggestions);
  $('startManual').addEventListener('click', () => $('vendor_name').focus());
  $('startPo').addEventListener('click', () => { $('poDetails').open = true; $('poSearch').focus(); });
  window.addEventListener('beforeunload', e => { if (dirty || busy) { e.preventDefault(); e.returnValue = ''; } });
  db.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || session?.user?.id && session.user.id !== user.id) {
      if ($('textRepairDialog').open) $('textRepairDialog').close('cancel');
      invalidSession = true; readingController?.abort(); readGeneration++; duplicateChecker.dispose(); lockUI();
      $('app').hidden = true; $('success').hidden = true; $('signedOut').hidden = false;
      disposePreview?.(); disposePreview = null;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      feedback('Your sign-in changed. Reload before continuing. Saved drafts remain associated with their original user and company.');
    }
  });
}
async function boot() {
  try {
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !window.supabase) throw Error('SILO configuration could not load. Reload the page.');
    db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const { data, error } = await db.auth.getUser();
    if (error || !data?.user) { $('signedOut').hidden = false; feedback(''); return; }
    user = data.user;
    company = await cfg.ensureActiveCompany(db);
    if (!company?.id) throw Error('Your account needs company access before you can submit. Ask your admin to activate it.');
    scope = `${company.id}:${user.id}`; draft = newDraft();
    await assertContext();
    const { data: settings, error: settingsError } = await db.from('company_settings').select('default_currency').eq('company_entity_id', company.id).maybeSingle();
    if (settingsError) throw Error('Could not verify the company currency. Reload before creating a request.');
    if (settings && settings.default_currency !== 'USD') throw Error('Payment Request 2 currently supports USD companies only. Ask AP about your company’s payment workflow.');
    if (!window.SiloChrome) $('silo-app').classList.add('pr2-standalone');
    window.SiloChrome?.mount({ appEl: '#silo-app', active: 'finance/payment-request-2', user: { email: user.email, role: 'MEMBER' }, crumbs: ['Requests', 'Payment Request 2'], supabaseClient: db });
    $('app').hidden = false; bind(); renderDraft(); feedback('');
    await loadLookups(); await showDraftShelf();
  } catch (error) { feedback(error.message || 'Could not load this page. Please retry.', 'neg'); }
}
void boot();
