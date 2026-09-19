import { normalizeName, normalizeInvoice, money, duplicateMatches } from './payment-request2-core.js';

// Acknowledgement belongs to both the checked details and the exact set of matches.
export const duplicateAcknowledgement = result => result ? JSON.stringify([result.key, result.matches.map(m => m.id).sort()]) : null;
const snapshotKey = s => JSON.stringify([s.companyId, s.draftId, normalizeName(s.fields.vendor_name), normalizeInvoice(s.fields.invoice_number), money(s.fields.amount_due), s.fields.currency]);
const eligible = s => s && normalizeName(s.fields.vendor_name) && money(s.fields.amount_due) !== null;

export function createDuplicateChecker({ lookup, publish, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let current = null, key = null, generation = 0, timer, stopped = false;
  const cancel = () => { clearTimer(timer); timer = null; generation++; };
  function update(snapshot, schedule = true) {
    if (stopped) return;
    const next = { ...snapshot, fields: { ...snapshot.fields } }, nextKey = snapshotKey(next);
    current = next;
    if (nextKey === key) return;
    cancel(); key = nextKey;
    publish({ phase: eligible(current) ? 'waiting' : 'idle', result: null });
    if (schedule && eligible(current)) timer = setTimer(() => { timer = null; void run().catch(() => {}); }, 500);
  }
  async function run() {
    if (stopped) throw Error('Duplicate checking stopped. Reload before submitting.');
    cancel();
    if (!eligible(current)) throw Error('Enter a payee and valid amount before submitting.');
    const snapshot = current, checkedKey = key, mine = generation;
    publish({ phase: 'checking' });
    try {
      const rows = await lookup(snapshot);
      if (stopped || mine !== generation) throw Error('The request changed during the check. Review the latest details before submitting.');
      const result = { key: checkedKey, matches: duplicateMatches(rows, snapshot.fields, snapshot.draftId), fields: snapshot.fields, limited: rows.length === 1000 };
      publish({ phase: 'complete', result }); return result;
    } catch (error) {
      if (!stopped && mine === generation) publish({ phase: 'error', result: null });
      throw error;
    }
  }
  return {
    update,
    async checkNow(snapshot) { update(snapshot, false); return run(); },
    reset() { cancel(); current = null; key = null; if (!stopped) publish({ phase: 'idle', result: null }); },
    dispose() { stopped = true; cancel(); current = null; key = null; },
  };
}
