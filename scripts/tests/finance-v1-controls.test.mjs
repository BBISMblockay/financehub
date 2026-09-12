import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildApprovedPayload,
  classifyPostHttpStatus,
  compareJournalEntry,
  makeDocNumber,
  qboQueryForDocNumber,
} from '../../supabase/functions/quickbooks-post-journal/posting-core.mjs';

let assertions = 0;
const check = (condition, message) => {
  assertions += 1;
  assert.ok(condition, message);
};

const hash = '0123456789abcdef'.repeat(4);
check(makeDocNumber(hash) === 'SILO-0123456789ABCDEF', 'DocNumber is deterministic and bounded');
assert.throws(() => makeDocNumber('short'), /approval_hash/, 'invalid approval hashes fail closed');
assertions += 1;

const line = (amount, side, account, location = '', entityType = '', entityId = '') => ({
  DetailType: 'JournalEntryLineDetail',
  Amount: amount,
  JournalEntryLineDetail: {
    PostingType: side,
    AccountRef: { value: account },
    ...(location ? { DepartmentRef: { value: location } } : {}),
    ...(entityId ? { Entity: { Type: entityType, EntityRef: { value: entityId } } } : {}),
  },
});
const snapshot = {
  schema_version: 1,
  payload: {
    TxnDate: '2026-08-31',
    PrivateNote: 'Approved entry',
    Line: [line(10, 'Debit', '1', 'L1'), line(10, 'Credit', '2', '', 'Vendor', 'V1')],
  },
};
const payload = buildApprovedPayload(snapshot, makeDocNumber(hash));
check(payload.DocNumber === 'SILO-0123456789ABCDEF', 'approved payload receives recovery identity');
check(snapshot.payload.DocNumber === undefined, 'payload builder does not mutate the approval snapshot');
check(compareJournalEntry(payload, { Line: [...payload.Line].reverse() }),
  'line readback tolerates QBO ordering');
check(!compareJournalEntry(payload, {
  Line: [line(10, 'Debit', '9', 'L1'), line(10, 'Credit', '2', '', 'Vendor', 'V1')],
}), 'readback catches an account mismatch even when totals match');
check(!compareJournalEntry(payload, {
  Line: [line(10, 'Debit', '1', 'L2'), line(10, 'Credit', '2', '', 'Vendor', 'V1')],
}), 'readback catches a location mismatch');
check(!compareJournalEntry(payload, {
  Line: [line(10, 'Debit', '1', 'L1'), line(10, 'Credit', '2', '', 'Customer', 'V1')],
}), 'readback catches an entity-type mismatch');

for (const status of [408, 429, 500, 503]) {
  check(classifyPostHttpStatus(status) === 'unknown', `${status} keeps the posting lock`);
}
for (const status of [400, 401, 403, 422]) {
  check(classifyPostHttpStatus(status) === 'failed', `${status} is a clear rejection`);
}
check(qboQueryForDocNumber('SILO-ABC').includes("DocNumber = 'SILO-ABC'"),
  'recovery query is keyed by DocNumber');

const [migration, cardPage, composer, posting] = await Promise.all([
  readFile(new URL('../../supabase/migrations/20260912000000_finance_v1_posting_controls.sql', import.meta.url), 'utf8'),
  readFile(new URL('../../v2/card-coding.html', import.meta.url), 'utf8'),
  readFile(new URL('../../v2/je-composer.js', import.meta.url), 'utf8'),
  readFile(new URL('../../supabase/functions/quickbooks-post-journal/index.ts', import.meta.url), 'utf8'),
]);
const cardAiPath = cardPage.slice(cardPage.indexOf('async function aiCategorise()'),
  cardPage.indexOf("el('btnPost').addEventListener"));
const cardPostPath = cardPage.slice(cardPage.indexOf("el('btnPost').addEventListener"));

check(migration.includes("status in ('submitting', 'unknown', 'posted')"),
  'active posting index covers every ambiguous/confirmed state');
check(migration.includes('(company_entity_id, source, source_ref)'),
  'posting identity stays unique even if a source is rebound to another QBO connection');
check(migration.includes('approval_snapshot = v_snapshot'),
  'approval RPC persists the server-built snapshot');
check(migration.includes('finance_approval_snapshot_hash(v_snapshot)'),
  'approval hashes use one database-canonical implementation');
check(migration.match(/already_approved/g)?.length === 2,
  'approval RPC retries are idempotent so the same UI can recover posting');
check(migration.includes("status in ('draft', 'categorized')"),
  'card writes are limited to mutable lifecycle states');
check(migration.includes("and status = 'draft'"),
  'adjustment writes are limited to draft');
check(migration.includes('uq_journal_adjustments_active_source'),
  'generated entries have stable active-source uniqueness');
check(cardPage.includes("sb.rpc('approve_card_import_batch'"),
  'card UI uses the existing screen with server-side approval');
check(!cardPage.includes("status: 'approved',\n      approved_at:"),
  'card UI no longer authors approval fields');
check(!cardAiPath.includes('recovery_action'),
  'QBO recovery controls do not leak into the AI categorization call');
check(cardPostPath.includes("recovery_action: 'confirm_not_posted'"),
  'card posting path carries the explicit unknown-outcome recovery action');
check(composer.includes("db.rpc('approve_journal_adjustment'"),
  'composer uses server-side approval');
check(!composer.includes("status: 'approved',\n          approved_at:"),
  'composer no longer authors approval fields');
check(posting.includes(".eq('id', parent.qbo_connection_id)"),
  'posting uses the approved connection id');
check(posting.includes(".rpc('finance_approval_hash_matches'"),
  'posting verifies the stored snapshot and approval revision in the database');
check(!posting.includes(".eq('company_entity_id', companyId).limit(1)"),
  'posting no longer picks an arbitrary company connection');
check(posting.includes("status: 'unknown'"),
  'posting persists unknown outcomes');
check(posting.includes('findByDocNumber'),
  'retry recovery searches QBO before posting again');
check(!posting.includes(".from('card_transactions')")
  && !posting.includes(".from('journal_adjustment_lines')"),
  'posting consumes the frozen approval snapshot rather than mutable source rows');
check(posting.includes('posting_confirmation_persist_failed'),
  'confirmed QBO writes check local persistence');

console.log(`finance-v1-controls: ${assertions} assertions passed`);
