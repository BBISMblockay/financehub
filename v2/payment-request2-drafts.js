let connection;
function open() {
  if (!connection) connection = new Promise((resolve, reject) => {
    const req = indexedDB.open('silo-payment-request2', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('drafts', { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { connection = null; reject(Error('Device draft storage is unavailable. Enable browser storage to submit safely.')); };
  });
  return connection;
}
export async function saveDraft(scope, draft) {
  const db = await open(), key = `${scope}:${draft.id}`, expected = draft.revision || 0;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite'), store = tx.objectStore('drafts');
    let conflict = false;
    const read = store.get(key);
    read.onsuccess = () => {
      if ((read.result?.revision || 0) !== expected) { conflict = true; tx.abort(); return; }
      store.put({ ...draft, key, scope, revision: expected + 1, savedAt: new Date().toISOString() });
    };
    tx.oncomplete = () => { draft.revision = expected + 1; resolve(draft); };
    tx.onabort = tx.onerror = () => reject(Error(conflict ? 'This draft changed in another tab. Reload and resume the saved version before continuing.' : 'Could not save this draft on your device. Free storage and retry before closing this page.'));
  });
}
export async function listDrafts(scope) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction('drafts').objectStore('drafts').getAll();
    req.onsuccess = () => resolve(req.result.filter(d => d.scope === scope && d.status !== 'submitted').sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
    req.onerror = () => reject(Error('Could not read saved drafts on this device.'));
  });
}
