// QuickBooks sync page: the decisions and the send run, against the shipped
// module. QBSYNC_MUTATION=<name> breaks one protection in the source text;
// every mutation below must make this suite fail (run-mutations at the end of
// the file lists them, and CI runs each).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const MUTATIONS = {
  // An unconfirmed send must outrank a posted/approved reading.
  'claim-not-first': [`if (mine.some((c) => ACTIVE_CLAIM.includes(c.status))) {\n      return set('fix', 'A send went out and QuickBooks never confirmed it. SILO has locked`, `if (false) {\n      return set('fix', 'A send went out and QuickBooks never confirmed it. SILO has locked`],
  // Unread claims must not read as "nothing was sent".
  'unread-claims-ok': [`if (!known(facts.claims)) return set('fix', 'Could not read what was already sent. Refresh before syncing.', { unreadable: true });\n    if (mine.some((c) => ACTIVE_CLAIM.includes(c.status))) {\n      return set('fix', 'A send went out and QuickBooks never confirmed it. SILO has locked`, `if (mine.some((c) => ACTIVE_CLAIM.includes(c.status))) {\n      return set('fix', 'A send went out and QuickBooks never confirmed it. SILO has locked`],
  // A month still filling must not be sendable.
  'open-month-sendable': [`if (!ended) return set('open', 'Every transaction so far is categorized. Syncs after the month ends.');`, ``],
  // A month before SILO's posting start is not SILO's to send.
  'ignore-posting-start': [`if (b.source_posting_start_on && end && end < b.source_posting_start_on) {`, `if (false) {`],
  // Reporting-only companies send nothing.
  'ignore-mode': [`if (facts.mode === 'qbo' && b.status !== 'approved') return null;`, ``],
  // Uncategorized rows block a finished month.
  'uncoded-sendable': [`if (uncoded > 0) {`, `if (false) {`],
  // An entry sent and then marked unposted is never re-sent by default.
  'voided-default-on': [`{ sendable: true, defaultSelected: false });\n      }\n      return set('waiting', failed ? \`Last try failed: \${friendly(failed.error_message)}\` : 'Approved. Goes out on the next sync.', { sendable: true });\n    }\n    return set('waiting', 'Categorized.`, `{ sendable: true });\n      }\n      return set('waiting', failed ? \`Last try failed: \${friendly(failed.error_message)}\` : 'Approved. Goes out on the next sync.', { sendable: true });\n    }\n    return set('waiting', 'Categorized.`],
  // A refusal QuickBooks will repeat is not offered again unchanged.
  'retry-validation': [`if (failed && isValidationFailure(failed.error_message)) {\n        return set('fix', \`\${friendly(failed.error_message)} Reopen the month`, `if (false) {\n        return set('fix', \`\${friendly(failed.error_message)} Reopen the month`],
  // The pre-check refusal must stop the approval and the send.
  'send-despite-blocker': [`if (!p.ready || p.blocker || !p.hash) { done('fix'`, `if (false) { done('fix'`],
  // The send must carry the hash that was just previewed.
  'no-expected-hash': [`? { batch_id: item.id, expected_approval_hash: hash }`, `? { batch_id: item.id }`],
  // Approval must be of the previewed entry.
  'approve-any': [`await api.approve(item.id, hash);`, `await api.approve(item.id, null);`],
  // An unknown outcome stops the run.
  'continue-after-unknown': [`stopped = 'unknown'; break;`, `stopped = 'unknown';`],
  // The company is re-checked before every entry.
  'no-company-check': [`await api.stillActive();\n        let hash`, `let hash`],
  // An unreadable list is unknown, never empty-and-green.
  'unread-list-empty': [`if (!known(facts.batches) || !known(facts.adjustments)) return null;`, `facts = { ...facts, batches: facts.batches || [], adjustments: facts.adjustments || [] };`],
  // The bar scores only what SILO sends.
  'score-open-months': [`const total = synced + waiting + fix;`, `const total = synced + waiting + fix + count('open');`],
};

let source = fs.readFileSync(new URL('../../v2/quickbooks-sync.js', import.meta.url), 'utf8');
const mutation = process.env.QBSYNC_MUTATION;
if (mutation) {
  const m = MUTATIONS[mutation];
  if (!m) throw new Error(`Unknown mutation ${mutation}`);
  if (!source.includes(m[0])) throw new Error(`Mutation ${mutation} no longer matches the source`);
  source = source.replace(m[0], m[1]);
}
const window = {};
vm.runInNewContext(source, { window, Date, Map, Set, Number, Array, Object, Promise, Error, String, Math, Boolean });
const S = window.SiloQuickBooksSync;

const H1 = 'a'.repeat(64); const H2 = 'b'.repeat(64);
const facts = (over = {}) => ({ companyId: 'co', today: '2026-11-25', mode: 'silo', batches: [], adjustments: [], claims: [], ledger: [], ...over });
const batch = (over = {}) => ({ id: 'b1', source_name: 'Operating', label: 'October 2026', status: 'categorized', period_start: '2026-10-01', period_end: '2026-10-31',
  entry_date: '2026-10-31', txn_count: 10, uncoded_count: 0, excluded_count: 2, coded_amount: '1234.50', source_posting_enabled: true, source_posting_start_on: null, approval_hash: null, ...over });
const adj = (over = {}) => ({ id: 'a1', entry_date: '2026-10-31', memo: 'Prepaid amortization', status: 'approved', accounting_source: 'prepaid_amortization', accounting_source_ref: '2026-10', approval_hash: H1, debits: 500, ...over });
const one = (b, f = {}) => S.classifyBatch(b, facts(f));
// Objects built inside the vm context have another realm's prototypes.
const same = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);

test('a finished, fully categorized month is waiting and sendable', () => {
  const i = one(batch());
  assert.equal(i.status, 'waiting'); assert.equal(i.sendable, true); assert.equal(i.month, '2026-10'); assert.equal(i.amount, 1234.5);
});

test('a posted month is synced and names its QuickBooks entry', () => {
  const i = one(batch({ status: 'posted', qbo_doc_number: 'SILO-123' }));
  assert.equal(i.status, 'synced'); assert.equal(i.sendable, false); assert.match(i.reason, /SILO-123/);
});

test('an unconfirmed send outranks every other reading', () => {
  for (const status of ['approved', 'posted', 'categorized']) {
    const i = one(batch({ status, approval_hash: H1 }), { claims: [{ source: 'card_import', source_ref: 'b1', status: 'unknown', payload_hash: H1 }] });
    assert.equal(i.status, 'fix', status); assert.equal(i.sendable, false); assert.match(i.reason, /never confirmed/);
  }
  // ...including when sending is switched off or the month predates SILO.
  const off = one(batch({ status: 'approved', source_posting_enabled: false, source_posting_start_on: '2027-01-01' }),
    { claims: [{ source: 'card_import', source_ref: 'b1', status: 'submitting' }] });
  assert.equal(off.status, 'fix');
});

test('claims that could not be read never read as nothing sent', () => {
  const i = one(batch(), { claims: undefined });
  assert.equal(i.status, 'fix'); assert.equal(i.sendable, false); assert.equal(i.unreadable, true);
  const a = S.classifyAdjustment(adj(), facts({ claims: undefined }));
  assert.equal(a.status, 'fix'); assert.equal(a.sendable, false);
});

test('a month that has not ended is open, never sendable', () => {
  const coded = one(batch({ period_end: '2026-11-30', entry_date: '2026-11-30' }));
  assert.equal(coded.status, 'open'); assert.equal(coded.sendable, false);
  const lastDay = one(batch({ period_end: '2026-11-25', entry_date: '2026-11-25' }));
  assert.equal(lastDay.status, 'open', 'the month ends when the business day is past it');
  const filling = one(batch({ period_end: '2026-11-30', uncoded_count: 4 }));
  assert.equal(filling.status, 'open'); assert.match(filling.reason, /4 transactions to categorize/);
});

test('uncategorized rows in a finished month need a fix', () => {
  const i = one(batch({ uncoded_count: 1 }));
  assert.equal(i.status, 'fix'); assert.equal(i.sendable, false); assert.match(i.reason, /1 transaction still/);
});

test('months SILO is not to send are listed, not sendable', () => {
  const before = one(batch({ source_posting_start_on: '2026-11-01' }));
  assert.equal(before.status, 'outside'); assert.equal(before.sendable, false);
  const boundary = one(batch({ source_posting_start_on: '2026-10-31' }));
  assert.equal(boundary.status, 'waiting', 'a month ending on the start date is SILO’s');
  const off = one(batch({ source_posting_enabled: false }));
  assert.equal(off.status, 'outside'); assert.equal(off.sendable, false);
});

test('a reporting-only company sends nothing', () => {
  assert.equal(one(batch(), { mode: 'qbo' }), null);
  const a = S.classifyAdjustment(adj(), facts({ mode: 'qbo' }));
  assert.equal(a.status, 'outside'); assert.equal(a.sendable, false);
});

test('empty and all-excluded months are not listed', () => {
  assert.equal(one(batch({ txn_count: 0, excluded_count: 0 })), null);
  assert.equal(one(batch({ txn_count: 804, excluded_count: 804 })), null);
});

test('a row the ledger refused blocks the month with its reason', () => {
  const i = one(batch(), { ledger: [{ batch_id: 'b1', unrecorded: 2, reason: 'Accounts Payable needs a vendor' }] });
  assert.equal(i.status, 'fix'); assert.match(i.reason, /2 categorized transactions/); assert.match(i.reason, /vendor/);
});

test('a refusal QuickBooks would repeat is a fix; a transient failure is retried', () => {
  const fault = '{"Fault":{"Error":[{"Message":"A business validation error","Detail":"Business Validation Error: When you use Accounts Payable, you must choose a vendor in the Name field."}],"type":"ValidationFault"}}';
  const v = one(batch({ status: 'approved', approval_hash: H1 }), { claims: [{ source: 'card_import', source_ref: 'b1', status: 'failed', payload_hash: H1, error_message: `post_failed_400: ${fault}`, created_at: '2026-10-07' }] });
  assert.equal(v.status, 'fix'); assert.equal(v.sendable, false); assert.match(v.reason, /no vendor/); assert.doesNotMatch(v.reason, /Fault|post_failed/);
  const t = one(batch({ status: 'approved', approval_hash: H1 }), { claims: [{ source: 'card_import', source_ref: 'b1', status: 'failed', payload_hash: H1, error_message: 'token_refresh_failed', created_at: '2026-10-07' }] });
  assert.equal(t.status, 'waiting'); assert.equal(t.sendable, true); assert.match(t.reason, /Last try failed/);
  // A failure of an EARLIER approval says nothing about this one.
  const old = one(batch({ status: 'approved', approval_hash: H2 }), { claims: [{ source: 'card_import', source_ref: 'b1', status: 'failed', payload_hash: H1, error_message: `post_failed_400: ${fault}` }] });
  assert.equal(old.status, 'waiting'); assert.equal(old.sendable, true);
});

test('an entry sent and then marked unposted is offered unticked', () => {
  const b = one(batch({ status: 'approved', approval_hash: H1 }), { claims: [{ source: 'card_import', source_ref: 'b1', status: 'voided', payload_hash: H1 }] });
  assert.equal(b.status, 'waiting'); assert.equal(b.sendable, true); assert.equal(b.defaultSelected, false);
  const a = S.classifyAdjustment(adj(), facts({ claims: [{ source: 'prepaid_amortization', source_ref: '2026-10', status: 'voided', payload_hash: H1 }] }));
  assert.equal(a.sendable, true); assert.equal(a.defaultSelected, false); assert.match(a.reason, /no longer in QuickBooks/);
  const plain = S.classifyAdjustment(adj(), facts());
  assert.equal(plain.defaultSelected, true);
});

test('journal entries: draft needs review, approved waits, posted is synced, claims correlate by source', () => {
  assert.equal(S.classifyAdjustment(adj({ status: 'draft' }), facts()).status, 'fix');
  assert.equal(S.classifyAdjustment(adj({ status: 'posted', qbo_doc_number: 'SILO-9' }), facts()).status, 'synced');
  assert.equal(S.classifyAdjustment(adj({ approval_hash: null }), facts()).status, 'fix');
  const legacy = S.classifyAdjustment(adj({ accounting_source: null, accounting_source_ref: null }), facts({ claims: [{ source: 'journal_adjustment', source_ref: 'a1', status: 'unknown' }] }));
  assert.equal(legacy.status, 'fix'); assert.match(legacy.reason, /never confirmed/);
  const other = S.classifyAdjustment(adj(), facts({ claims: [{ source: 'prepaid_amortization', source_ref: '2026-09', status: 'unknown' }] }));
  assert.equal(other.status, 'waiting', 'another month’s claim is not this entry’s');
});

test('an unreadable list is unknown, and the bar scores only what SILO sends', () => {
  assert.equal(S.classify(facts({ batches: undefined })), null);
  assert.equal(S.classify(facts({ adjustments: undefined })), null);
  const items = S.classify(facts({ batches: [batch({ id: 'p', status: 'posted' }), batch({ id: 'w' }), batch({ id: 'f', uncoded_count: 2 }),
    batch({ id: 'o', period_end: '2026-11-30' }), batch({ id: 'x', source_posting_enabled: false })], adjustments: [adj()] }));
  const s = S.summarize(items);
  assert.deepEqual([s.synced, s.waiting, s.fix, s.open, s.outside, s.total, s.sendable], [1, 2, 1, 1, 1, 4, 2]);
  assert.equal(s.percent, 25); assert.equal(s.allGreen, false);
  assert.equal(items[0].month, '2026-11', 'newest month first');
  assert.equal(S.summarize([]).percent, null); assert.equal(S.summarize([]).allGreen, false);
  assert.equal(S.summarize(S.classify(facts({ batches: [batch({ status: 'posted' })] }))).allGreen, true);
});

test('friendly never shows a raw QuickBooks fault', () => {
  assert.match(S.friendly('When you use Accounts Receivable, you must choose a customer in the Name field.'), /no customer/);
  assert.match(S.friendly('Posting is disabled for this card source'), /switched off/);
  assert.equal(S.friendly('post_failed_400: {"Fault":{"Error":[{"Detail":"Business Validation Error: Something odd."}]}}'), 'Something odd.');
  assert.ok(S.friendly('').length > 0);
  assert.ok(S.friendly('x'.repeat(500)).length <= 220);
});

// ── the run ────────────────────────────────────────────────────────────────
function fakeApi(script = {}) {
  const calls = [];
  return { calls,
    async stillActive() { calls.push(['active']); if (script.companyChangesAt === calls.filter((c) => c[0] === 'active').length) throw Object.assign(new Error('changed'), { code: 'COMPANY_CHANGED' }); },
    async preview(id) { calls.push(['preview', id]); const p = (script.preview || {})[id]; if (p instanceof Error) throw p; return p || { status: 'categorized', ready: true, blocker: null, hash: H1, can_post: true }; },
    async approve(id, hash) { calls.push(['approve', id, hash]); const a = (script.approve || {})[id]; if (a instanceof Error) throw a; return { approval_hash: hash }; },
    async post(body) { calls.push(['post', body]); return (script.post || {})[body.batch_id || body.adjustment_id] || { status: 200, body: { ok: true, doc_number: 'SILO-1' } }; },
  };
}
const item = (over = {}) => ({ key: `batch:${over.id || 'b1'}`, kind: 'batch', id: 'b1', title: 'Operating', month: '2026-10', hash: null, ...over });

test('run: preview, approve the previewed hash, send with that hash', async () => {
  const api = fakeApi();
  const out = await S.run([item()], api);
  assert.deepEqual(api.calls.map((c) => c[0]), ['active', 'preview', 'approve', 'post']);
  assert.deepEqual(api.calls[2], ['approve', 'b1', H1]);
  same(api.calls[3][1], { batch_id: 'b1', expected_approval_hash: H1 });
  assert.equal(out.sent, 1); assert.equal(out.outcomes[0].status, 'synced'); assert.match(out.outcomes[0].reason, /SILO-1/);
});

test('run: an already approved month is not approved again, and an entry sends its own hash', async () => {
  const api = fakeApi({ preview: { b1: { status: 'approved', ready: true, hash: H2, can_post: true } } });
  await S.run([item(), { key: 'adjustment:a1', kind: 'adjustment', id: 'a1', title: 'Prepaid', month: '2026-10', hash: H1 }], api);
  assert.equal(api.calls.filter((c) => c[0] === 'approve').length, 0);
  const posts = api.calls.filter((c) => c[0] === 'post').map((c) => c[1]);
  same(posts, [{ batch_id: 'b1', expected_approval_hash: H2 }, { adjustment_id: 'a1', expected_approval_hash: H1 }]);
});

test('run: a pre-check refusal approves nothing and sends nothing, then moves on', async () => {
  const api = fakeApi({ preview: { b1: { status: 'categorized', ready: false, blocker: 'When you use Accounts Payable, you must choose a vendor in the Name field.', hash: null } } });
  const out = await S.run([item(), item({ id: 'b2', key: 'batch:b2' })], api);
  assert.equal(out.outcomes[0].status, 'fix'); assert.match(out.outcomes[0].reason, /no vendor/);
  assert.equal(api.calls.filter((c) => c[1] === 'b1' && c[0] !== 'preview').length, 0);
  assert.equal(out.outcomes[1].status, 'synced'); assert.equal(out.sent, 1); assert.equal(out.failed, 1);
});

test('run: a refused approval or a refused send is a fix and the run continues', async () => {
  const api = fakeApi({ approve: { b1: new Error('This journal entry changed after you reviewed it.') }, post: { b2: { status: 409, body: { error: 'Posting is disabled for this card source' } } } });
  const out = await S.run([item(), item({ id: 'b2', key: 'batch:b2' }), item({ id: 'b3', key: 'batch:b3' })], api);
  same(out.outcomes.map((o) => o.status), ['fix', 'fix', 'synced']);
  assert.equal(api.calls.filter((c) => c[0] === 'post' && c[1].batch_id === 'b1').length, 0, 'nothing is sent when approval is refused');
  assert.equal(out.stopped, null);
});

test('run: an unknown outcome stops the run', async () => {
  for (const res of [{ status: 0, body: {} }, { status: 502, body: {} }, { status: 409, body: { code: 'UNKNOWN_OUTCOME' } }]) {
    const api = fakeApi({ post: { b1: res } });
    const out = await S.run([item(), item({ id: 'b2', key: 'batch:b2' })], api);
    assert.equal(out.stopped, 'unknown'); assert.equal(out.outcomes.length, 1); assert.equal(out.outcomes[0].unknown, true);
    assert.equal(api.calls.filter((c) => c[1] === 'b2').length, 0);
  }
});

test('run: the company is checked before every entry and a change stops it', async () => {
  const api = fakeApi({ companyChangesAt: 2 });
  const out = await S.run([item(), item({ id: 'b2', key: 'batch:b2' })], api);
  assert.equal(api.calls.filter((c) => c[0] === 'active').length, 2);
  assert.equal(out.stopped, 'company'); assert.equal(out.sent, 1);
  assert.equal(api.calls.filter((c) => c[1] === 'b2' || c[1]?.batch_id === 'b2').length, 0);
});

test('run: "already posted" is synced, and progress reports every entry', async () => {
  const api = fakeApi({ post: { b1: { status: 409, body: { error: 'This entry is already posted' } } } });
  const seen = [];
  const out = await S.run([item()], api, (p) => seen.push(`${p.phase}:${p.index}/${p.total}`));
  assert.equal(out.outcomes[0].status, 'synced');
  assert.deepEqual(seen, ['checking:0/1', 'approving:0/1', 'sending:0/1', 'done:1/1']);
});

test('precheck turns a waiting month into a fix before anyone presses Sync', async () => {
  const items = [{ ...item(), sendable: true, status: 'waiting' }, { ...item({ id: 'b2', key: 'batch:b2' }), sendable: true, status: 'waiting' },
    { key: 'adjustment:a1', kind: 'adjustment', id: 'a1', sendable: true, status: 'waiting' }];
  const api = fakeApi({ preview: { b1: { status: 'categorized', ready: false, blocker: 'Split lines do not total the transaction' }, b2: new Error('timeout') } });
  const changed = [];
  await S.precheck(items, api, (i) => changed.push(i.key));
  assert.equal(items[0].status, 'fix'); assert.equal(items[0].sendable, false); assert.deepEqual(changed, ['batch:b1']);
  assert.equal(items[1].status, 'waiting', 'a failed check leaves the row alone');
  assert.equal(api.calls.filter((c) => c[0] === 'approve' || c[0] === 'post').length, 0, 'a pre-check never approves or sends');
  assert.equal(api.calls.length, 2, 'entries have no preview to run');
});

test('the page wires the module and leaves no write path of its own', () => {
  const page = fs.readFileSync(new URL('../../testing/quickbooks-sync.html', import.meta.url), 'utf8');
  for (const id of ['status', 'qsSummary', 'btnSync', 'qsSyncNote', 'qsProgress', 'qsProgressBar', 'qsProgressText', 'qsRows', 'qsEmpty', 'qsConfirm', 'qsConfirmList', 'qsAck', 'qsConfirmGo', 'qsConfirmCancel', 'btnRefresh', 'qsToday']) {
    assert.ok(page.includes(`id="${id}"`), id);
  }
  assert.ok(page.indexOf('nav-config.js') < page.indexOf('silo-chrome.js'));
  const raw = fs.readFileSync(new URL('../../v2/quickbooks-sync.js', import.meta.url), 'utf8');
  assert.doesNotMatch(raw + page, /\balert\(/);
  assert.doesNotMatch(raw, /\.(insert|update|upsert|delete)\(/, 'no table writes from the page');
  const rpcs = [...raw.matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(rpcs)], ['can_manage_journal_entries', 'card_import_batch_preview', 'approve_reviewed_card_import_batch', 'is_exec_or_owner', 'silo_business_today', 'silo_ledger_batch_status'].sort());
  assert.doesNotMatch(raw, /innerHTML/);
});

export const mutationNames = Object.keys(MUTATIONS);
