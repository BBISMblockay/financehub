const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function makeDocNumber(approvalHash) {
  const hash = String(approvalHash || '').replace(/[^a-f0-9]/gi, '').toUpperCase();
  if (hash.length < 16) throw new Error('approval_hash_missing_or_invalid');
  return `SILO-${hash.slice(0, 16)}`;
}

export function buildApprovedPayload(snapshot, docNumber) {
  if (!snapshot || snapshot.schema_version !== 1 || !snapshot.payload) {
    throw new Error('approval_snapshot_missing_or_unsupported');
  }
  const payload = structuredClone(snapshot.payload);
  if (!payload.TxnDate || !payload.PrivateNote || !Array.isArray(payload.Line)) {
    throw new Error('approval_snapshot_payload_invalid');
  }
  if (payload.Line.length < 2) throw new Error('approval_snapshot_needs_two_lines');
  payload.DocNumber = docNumber;
  return payload;
}

export function classifyPostHttpStatus(status) {
  if (status === 408 || status === 429 || status >= 500) return 'unknown';
  return 'failed';
}

function normalizedLine(line) {
  const detail = line?.JournalEntryLineDetail || {};
  return {
    amount: round2(line?.Amount || 0),
    posting_type: String(detail.PostingType || ''),
    account_id: String(detail.AccountRef?.value || ''),
    location_id: String(detail.DepartmentRef?.value || ''),
    entity_type: String(detail.Entity?.Type || ''),
    entity_id: String(detail.Entity?.EntityRef?.value || ''),
  };
}

const lineKey = (line) => JSON.stringify(normalizedLine(line));

export function compareJournalEntry(expectedPayload, actualEntry) {
  const expected = (expectedPayload?.Line || []).map(lineKey).sort();
  const actual = (actualEntry?.Line || [])
    .filter((line) => line?.DetailType === 'JournalEntryLineDetail')
    .map(lineKey)
    .sort();
  return expected.length === actual.length
    && expected.every((line, index) => line === actual[index]);
}

export function qboQueryForDocNumber(docNumber) {
  const escaped = String(docNumber).replace(/'/g, "\\'");
  return `select * from JournalEntry where DocNumber = '${escaped}' maxresults 2`;
}
