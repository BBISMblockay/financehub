let connection;
// Keep the revision barrier, but never retain completed invoice content.
function completedRecord(value) {
  return { key: value.key, scope: value.scope, id: value.id, revision: value.revision, status: 'submitted', savedAt: value.savedAt };
}
function open() {
  if (!connection) connection = new Promise((resolve, reject) => {
    const req = indexedDB.open('silo-payment-request2', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'key' });
      else {
        const cursor = req.transaction.objectStore('drafts').openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          if (row.value.status === 'submitted') row.update(completedRecord(row.value));
          row.continue();
        };
      }
    };
    let blocked = false;
    req.onblocked = () => { blocked = true; connection = null; reject(Error('Close other Payment Request 2 tabs, then retry to update device draft storage.')); };
    req.onsuccess = () => { if (blocked) { req.result.close(); return; } req.result.onversionchange = () => { req.result.close(); connection = null; }; resolve(req.result); };
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
      if ((read.result?.revision || 0) !== expected || (read.result?.status === 'submitted' && draft.status !== 'submitted')) { conflict = true; tx.abort(); return; }
      const value = { ...draft, key, scope, revision: expected + 1, savedAt: new Date().toISOString() };
      store.put(draft.status === 'submitted' ? completedRecord(value) : value);
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
