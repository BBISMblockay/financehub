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
  'unread-claims-ok': [`if (!known(facts.claims)) return set('fix', 'Could not read what was already sent. Refresh before syncing.', { unreadable: true });\n    if (!MODES.includes(facts.mode)) return set('fix', MODE_UNREAD, { unreadable: true });\n    if (mine.some((c) => ACTIVE_CLAIM.includes(c.status))) {\n      return set('fix', 'A send went out and QuickBooks never confirmed it. SILO has locked`, `if (!MODES.includes(facts.mode)) return set('fix', MODE_UNREAD, { unreadable: true });\n    if (mine.some((c) => ACTIVE_CLAIM.includes(c.status))) {\n      return set('fix', 'A send went out and QuickBooks never confirmed it. SILO has locked`],
  // A month still filling must not be sendable.
  'open-month-sendable': [`if (!ended) return set('open', 'Every transaction so far is categorized. Syncs after the month ends.');`, ``],
  // A month before SILO's posting start is not SILO's to send.
  'ignore-posting-start': [`if (b.source_posting_start_on && end && end < b.source_posting_start_on) {`, `if (false) {`],
  // Reporting-only companies send nothing.
  'ignore-mode': [`if (facts.mode === 'qbo') return b.status === 'approved' ? set('outside', QBO_KEEPS) : null;`, ``],
  // ...including a month approved before the company switched.
  'qbo-approved-sendable': [`if (facts.mode === 'qbo') return b.status === 'approved' ? set('outside', QBO_KEEPS) : null;`, `if (facts.mode === 'qbo' && b.status !== 'approved') return null;`],
  // An unread bookkeeping setting is unknown, never "SILO keeps the books".
  'unread-mode-ok': [`mode: settings === undefined ? undefined : (settings?.bookkeeping_mode || 'silo')`, `mode: settings?.bookkeeping_mode || 'silo'`],
  'unread-mode-sendable': [`if (!MODES.includes(facts.mode)) return set('fix', MODE_UNREAD, { unreadable: true });\n    if (mine.some((c) => ACTIVE_CLAIM.includes(c.status))) {\n      return set('fix', 'A send went out and QuickBooks never confirmed it. SILO has locked`, `if (mine.some((c) => ACTIVE_CLAIM.includes(c.status))) {\n      return set('fix', 'A send went out and QuickBooks never confirmed it. SILO has locked`],
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
  // An entry marked as already in QuickBooks is never offered for sending.
  'by-hand-sendable': [`if (marked === 'current') return set('synced', BY_HAND, { byHand: true });\n    if (marked === 'stale') item.staleMark = true;\n    const uncoded`, `const uncoded`],
  'by-hand-entry-sendable': [`const marked = a.status === 'approved' ? byHandMark(facts, source, ref, a.approval_hash || null) : null;`, `const marked = null;`],
  'stale-mark-still-synced': [`return h.snapshot && is && h.snapshot === is ? 'current' : 'stale';`, `return 'current';`],
  'stale-mark-preticked': [`if (i.staleMark && i.canMark) { i.defaultSelected = false; i.reason = BY_HAND_CHANGED; }`, ``],
  'unread-marks-sendable': [`if (facts.byHand === undefined) return set('fix', BY_HAND_UNREAD, { unreadable: true });\n    const marked = byHandMark(facts, 'card_import', b.id);`, `const marked = byHandMark(facts, 'card_import', b.id);`],
  'unread-marks-entry-sendable': [`if (facts.byHand === undefined) return set('fix', BY_HAND_UNREAD, { unreadable: true });\n    const marked = a.status`, `const marked = a.status`],
  // The button is offered only where the database can hold the mark.
  'mark-without-table': [`i.canMark = known(facts.byHand) && i.status === 'waiting' && i.sendable === true;`, `i.canMark = i.status === 'waiting' && i.sendable === true;`],
  // A missing feature is "not installed", not a failed read.
  'missing-table-is-error': [`if (r.error.code === 'PGRST202' || r.error.code === '42883') return null;`, ``],
  // an unticked row is sent
  'send-unticked': [`return (items || []).filter((i) => keys.has(i.key) && (action === 'mark'`, `return (items || []).filter((i) => (action === 'mark'`],
  // a ticked row that can no longer be sent is sent anyway
  'send-unsendable': [`action === 'mark' ? i.canMark === true : i.sendable === true));`, `action === 'mark' ? i.canMark === true : true));`],
  // a ticked row that cannot hold a mark is marked anyway
  'mark-unmarkable': [`action === 'mark' ? i.canMark === true : i.sendable === true));`, `action === 'mark' ? true : i.sendable === true));`],
  // a row needing a fix is dropped from the to-do list
  'todo-drops-fix': [`todo: list.filter((i) => i.status === 'fix' || i.status === 'waiting'),`, `todo: list.filter((i) => i.status === 'waiting'),`],
  // an open month is shown as a task
  'todo-shows-open': [`todo: list.filter((i) => i.status === 'fix' || i.status === 'waiting'),`, `todo: list.filter((i) => i.status === 'fix' || i.status === 'waiting' || i.status === 'open'),`],
  // a month nobody read back is called agreed
  'agree-unread-month': [`      if (!m) continue;
      const entries = num(r.entries);`, `      if (!m) { out[r.month] = { state: 'agree' }; continue; }
      const entries = num(r.entries);`],
  // a changed entry is called agreed
  'agree-despite-change': [`state: changed > 0 || amount !== 0 ? 'differs' : 'agree' });`, `state: 'agree' });`],
  // an unreadable comparison is called agreed
  'agree-when-unread': [`if (!known(periods) || !known(rows)) return out;`, `if (!known(periods)) return out; rows = rows || [];`],
  // a malformed row is read as no difference
  'agree-on-garbage': [`if (entries === null || changed === null || amount === null) { delete out[r.month]; continue; }`, `if (entries === null || changed === null || amount === null) continue;`],
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
const facts = (over = {}) => ({ companyId: 'co', today: '2026-11-25', mode: 'silo', batches: [], adjustments: [], claims: [], ledger: [], byHand: null, ...over });
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
  for (const hash of ['h1', null]) {
    const left = one(batch({ status: 'approved', approval_hash: hash }), { mode: 'qbo' });
    assert.equal(left.status, 'outside', 'a month approved before the switch is listed, not offered');
    assert.equal(left.sendable, false);
  }
  assert.equal(S.summarize(S.classify(facts({ mode: 'qbo', batches: [batch({ status: 'approved', approval_hash: 'h1' })], adjustments: [adj()] }))).sendable, 0);
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
  const page = fs.readFileSync(new URL('../../v2/quickbooks-sync.html', import.meta.url), 'utf8');
  for (const id of ['status', 'qsSummary', 'btnSync', 'qsSyncNote', 'qsProgress', 'qsProgressBar', 'qsProgressText', 'qsRows', 'qsEmpty', 'qsConfirm', 'qsConfirmList', 'qsAck', 'qsConfirmGo', 'qsConfirmCancel', 'btnRefresh', 'qsToday',
    'qsAll', 'qsTodoTable', 'qsMore', 'btnMarkSelected', 'qsLater', 'qsLaterSum', 'qsLaterRows', 'qsDone', 'qsMonths']) {
    assert.ok(page.includes(`id="${id}"`), id);
  }
  assert.ok(page.indexOf('nav-config.js') < page.indexOf('silo-chrome.js'));
  const raw = fs.readFileSync(new URL('../../v2/quickbooks-sync.js', import.meta.url), 'utf8');
  assert.doesNotMatch(raw + page, /\balert\(/);
  assert.doesNotMatch(raw, /\.from\([^;]*?\.(insert|update|upsert|delete)\(/, 'no table writes from the page');
  assert.equal((raw.match(/\.from\(/g) || []).length, 3, 'three table reads: settings, the paged lists, the read-back months');
  const rpcs = [...raw.matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(rpcs)], ['can_manage_journal_entries', 'card_import_batch_preview', 'approve_reviewed_card_import_batch', 'chat_run_readonly_query', 'is_exec_or_owner', 'quickbooks_entered_by_hand_list', 'set_entry_entered_in_quickbooks', 'silo_business_today', 'silo_ledger_batch_status'].sort());
  assert.doesNotMatch(raw, /innerHTML/);
});

export const mutationNames = Object.keys(MUTATIONS);

// A stand-in for the SDK: every read answers from `tables`, or fails by name.
function fakeDb(tables, failing = []) {
  const rpc = { can_manage_journal_entries: true, is_exec_or_owner: false, silo_business_today: '2026-11-25', silo_ledger_batch_status: [] };
  const chain = (table) => {
    const answer = failing.includes(table) ? { data: null, error: { message: 'timeout' } }
      : tables[table] === 'missing' ? { data: null, error: { code: 'PGRST205', message: 'no such table' } } : { data: tables[table], error: null };
    const q = { select: () => q, eq: () => q, in: () => q, not: () => q, order: () => q, range: () => q, limit: () => q, maybeSingle: () => q, then: (ok, no) => Promise.resolve(answer).then(ok, no) };
    return q;
  };
  return { from: chain, rpc: async (name) => (failing.includes(name) ? { data: null, error: { message: 'timeout' } }
    : tables[name] === 'missing' ? { data: null, error: { code: 'PGRST202', message: 'no such function' } }
      : { data: name in tables ? tables[name] : rpc[name], error: null }) };
}
const company = { ensureActiveCompany: async () => ({ id: 'co', name: 'Co' }) };
const approved = batch({ status: 'approved', approval_hash: H1 });
const tables = (mode) => ({ accounting_settings: mode === null ? null : { bookkeeping_mode: mode }, card_import_batches_v: [approved, batch({ id: 'b2' })],
  journal_adjustments: [adj()], journal_adjustments_v: [{ id: 'a1', debits: 500 }], quickbooks_journal_postings: [] });

test('load: a reporting-only company has nothing to send, approved months included', async () => {
  const model = await S.load(fakeDb(tables('qbo')), company);
  assert.equal(model.mode, 'qbo');
  assert.equal(S.summarize(model.items).sendable, 0);
  assert.ok(model.items.every((i) => i.status === 'outside'));
  const silo = await S.load(fakeDb(tables('silo')), company);
  assert.equal(S.summarize(silo.items).sendable, 3, 'the same rows are sendable when SILO keeps the books');
  assert.equal((await S.load(fakeDb(tables(null)), company)).mode, 'silo', 'no settings row is the default, SILO');
});

test('load: an unread bookkeeping setting sends nothing', async () => {
  const model = await S.load(fakeDb(tables('qbo'), ['accounting_settings']), company);
  assert.equal(model.mode, undefined);
  assert.equal(S.summarize(model.items).sendable, 0);
  assert.ok(model.items.length === 3 && model.items.every((i) => i.status === 'fix' && i.unreadable));
  assert.match(model.errors.join(), /settings/);
});

test('an unknown bookkeeping mode is never read as SILO', () => {
  for (const mode of [undefined, null, 'other']) {
    const b = one(batch({ status: 'approved', approval_hash: H1 }), { mode });
    assert.equal(b.status, 'fix'); assert.equal(b.sendable, false);
    const a = S.classifyAdjustment(adj(), facts({ mode }));
    assert.equal(a.status, 'fix'); assert.equal(a.sendable, false);
  }
});

const F1 = 'f'.repeat(32);
const monthMark = (over = {}) => ({ source: 'card_import', source_ref: 'b1', snapshot: F1, current: F1, ...over });
const entryMark = (over = {}) => ({ source: 'prepaid_amortization', source_ref: '2026-10', snapshot: H1, current: null, ...over });

test('an entry marked as already in QuickBooks is synced by hand, never sendable, and can be undone', () => {
  const marks = [monthMark(), entryMark()];
  const month = one(batch({ status: 'approved', approval_hash: H1 }), { byHand: marks });
  assert.deepEqual([month.status, month.sendable, month.byHand, month.reason], ['synced', false, true, 'Entered in QuickBooks by hand.']);
  assert.equal(one(batch(), { byHand: marks }).status, 'synced', 'a categorized month too');
  const entry = S.classifyAdjustment(adj(), facts({ byHand: marks }));
  assert.deepEqual([entry.status, entry.sendable, entry.byHand], ['synced', false, true]);
  // A legacy entry is keyed the way its sending claim is.
  const legacy = S.classifyAdjustment(adj({ id: 'a9', accounting_source: null, accounting_source_ref: null }), facts({ byHand: [entryMark({ source: 'journal_adjustment', source_ref: 'a9' })] }));
  assert.equal(legacy.byHand, true);
  // Another entry's mark is not this one's.
  assert.equal(one(batch({ id: 'b2' }), { byHand: marks }).status, 'waiting');
  assert.equal(S.classifyAdjustment(adj({ accounting_source_ref: '2026-09' }), facts({ byHand: marks })).status, 'waiting');
  const list = S.classify(facts({ byHand: marks, batches: [batch()], adjustments: [adj()] }));
  assert.equal(S.summarize(list).sendable, 0); assert.equal(S.summarize(list).synced, 2);
});

test('a mark speaks only for the content it was made on: a changed entry is offered again, unticked', () => {
  // A late bank row or a recoding changed the month after it was marked.
  const marks = [monthMark({ current: 'e'.repeat(32) }), entryMark({ snapshot: 'old-approval' })];
  const [month] = S.classify(facts({ byHand: marks, batches: [batch()] }));
  assert.deepEqual([month.status, month.sendable, month.byHand ?? false, month.defaultSelected, month.canMark],
    ['waiting', true, false, false, true]);
  assert.match(month.reason, /Changed since it was marked/);
  // A re-approved journal entry under the same reference does not inherit the old mark.
  const [entry] = S.classify(facts({ byHand: marks, adjustments: [adj()] }));
  assert.deepEqual([entry.status, entry.sendable, entry.defaultSelected, entry.canMark], ['waiting', true, false, true]);
  // A changed month with rows still to categorize says so, rather than hiding behind the mark.
  assert.equal(one(batch({ uncoded_count: 2 }), { byHand: marks }).status, 'fix');
  // A mark that cannot be compared never counts as current.
  for (const odd of [monthMark({ current: null }), monthMark({ snapshot: null, current: null })]) {
    assert.equal(one(batch(), { byHand: [odd] }).status, 'waiting');
  }
});

test('marks that could not be read: nothing is sendable, and the row says why', () => {
  const list = S.classify(facts({ byHand: undefined, batches: [batch(), batch({ id: 'b3', status: 'posted', qbo_doc_number: 'JE-9' })], adjustments: [adj()] }));
  assert.equal(S.summarize(list).sendable, 0);
  for (const key of ['batch:b1', 'adjustment:a1']) {
    const i = list.find((x) => x.key === key);
    assert.deepEqual([i.status, i.unreadable, i.sendable, i.canMark], ['fix', true, false, false]);
    assert.match(i.reason, /entered in QuickBooks by hand/);
  }
  assert.equal(list.find((x) => x.key === 'batch:b3').status, 'synced', 'what SILO posted is still known');
});

test('a send nobody confirmed still outranks a by-hand mark, and a posted entry shows its QuickBooks number', () => {
  const marks = [monthMark()];
  const stuck = one(batch({ status: 'approved', approval_hash: H1 }), { byHand: marks, claims: [{ source: 'card_import', source_ref: 'b1', status: 'unknown', payload_hash: H1 }] });
  assert.equal(stuck.status, 'fix');
  const posted = one(batch({ status: 'posted', qbo_doc_number: 'JE-9' }), { byHand: marks });
  assert.deepEqual([posted.status, posted.byHand ?? false, posted.reason], ['synced', false, 'QuickBooks entry JE-9']);
});

test('the button is offered only on rows SILO would send, and only where marks can be stored', () => {
  const rows = (byHand) => S.classify(facts({ byHand, batches: [batch(), batch({ id: 'b2', uncoded_count: 2 }), batch({ id: 'b3', status: 'posted' }), batch({ id: 'b4', period_end: '2026-11-30' })], adjustments: [adj()] }));
  same(rows([]).filter((i) => i.canMark).map((i) => i.key).sort(), ['adjustment:a1', 'batch:b1']);
  for (const unavailable of [null, undefined]) assert.equal(rows(unavailable).some((i) => i.canMark), false);
  // An entry sent before and marked unposted is offered unticked AND can be marked: that is its way out.
  const voided = one(batch({ status: 'approved', approval_hash: H1 }), { byHand: [], claims: [{ source: 'card_import', source_ref: 'b1', status: 'voided', payload_hash: H1 }] });
  assert.deepEqual([voided.status, voided.defaultSelected], ['waiting', false]);
  assert.equal(S.classify(facts({ byHand: [], batches: [batch({ status: 'approved', approval_hash: H1 })], claims: [{ source: 'card_import', source_ref: 'b1', status: 'voided', payload_hash: H1 }] }))[0].canMark, true);
});

test('load: marks are read; a database without the feature has no button and no error; an unread list sends nothing', async () => {
  const withMarks = await S.load(fakeDb({ ...tables('silo'), quickbooks_entered_by_hand_list: [monthMark()] }), company);
  assert.equal(withMarks.items.find((i) => i.key === 'batch:b1').byHand, true);
  assert.equal(S.summarize(withMarks.items).sendable, 2);
  assert.ok(withMarks.items.some((i) => i.canMark));
  const missing = await S.load(fakeDb({ ...tables('silo'), quickbooks_entered_by_hand_list: 'missing' }), company);
  same(missing.errors, []); assert.equal(missing.items.some((i) => i.canMark), false);
  assert.equal(S.summarize(missing.items).sendable, 3, 'everything else still works');
  const unread = await S.load(fakeDb(tables('silo'), ['quickbooks_entered_by_hand_list']), company);
  assert.match(unread.errors.join(), /entered by hand/); assert.equal(unread.items.some((i) => i.canMark), false);
  assert.equal(S.summarize(unread.items).sendable, 0, 'a marked entry may be among them');
});

// ── the screen: to do first, ticks decide, one line a month for the rest ──
const screenItems = () => S.classify(facts({ byHand: [], batches: [
  batch({ id: 'w1' }), batch({ id: 'w2', source_name: 'Amex' }),
  batch({ id: 'f1', period_start: '2026-09-01', period_end: '2026-09-30', entry_date: '2026-09-30', uncoded_count: 2 }),
  batch({ id: 'o1', period_start: '2026-11-01', period_end: '2026-11-30', entry_date: '2026-11-30' }),
  batch({ id: 'x1', source_posting_enabled: false }),
  batch({ id: 'p1', status: 'posted', qbo_doc_number: 'SILO-1', period_start: '2026-09-01', period_end: '2026-09-30', entry_date: '2026-09-30' }),
  batch({ id: 'p2', status: 'posted', qbo_doc_number: 'SILO-2', period_start: '2026-08-01', period_end: '2026-08-31', entry_date: '2026-08-31' }),
  batch({ id: 'p3', status: 'posted', qbo_doc_number: 'SILO-3', source_name: 'Amex', period_start: '2026-08-01', period_end: '2026-08-31', entry_date: '2026-08-31' }),
] }));

test('the screen opens on what is left to do; open months and finished months are not tasks', () => {
  const parts = S.sections(screenItems());
  same(parts.todo.map((i) => `${i.id}:${i.status}`).sort(), ['f1:fix', 'w1:waiting', 'w2:waiting']);
  same(parts.later.map((i) => `${i.id}:${i.status}`).sort(), ['o1:open', 'x1:outside']);
  same(parts.months.map((m) => `${m.month}:${m.items.map((i) => i.id).sort().join('+')}`), ['2026-09:p1', '2026-08:p2+p3']);
  same(S.sections(null), { todo: [], later: [], months: [] });
});

test('only a ticked row is sent or marked, and only while it still may be', () => {
  const items = screenItems();
  const ids = (rows) => rows.map((i) => i.id).sort();
  same(ids(S.chosen(items, new Set(), 'send')), []);
  same(ids(S.chosen(items, new Set(), 'mark')), []);
  same(ids(S.chosen(items, new Set(['batch:w1']), 'send')), ['w1']);
  same(ids(S.chosen(items, ['batch:w1', 'batch:w2'], 'mark')), ['w1', 'w2']);
  // Ticks on rows that cannot be sent (a fix, an open month, a posted month) do nothing.
  same(ids(S.chosen(items, new Set(['batch:f1', 'batch:o1', 'batch:p1', 'batch:x1', 'batch:w2']), 'send')), ['w2']);
  same(ids(S.chosen(items, new Set(['batch:f1', 'batch:o1', 'batch:p1', 'batch:x1', 'batch:w2']), 'mark')), ['w2']);
  // A row that can be sent but cannot hold a mark (no table for marks) is not marked.
  const noMarks = S.classify(facts({ byHand: null, batches: [batch({ id: 'w1' })] }));
  same(ids(S.chosen(noMarks, new Set(['batch:w1']), 'send')), ['w1']);
  same(ids(S.chosen(noMarks, new Set(['batch:w1']), 'mark')), []);
});

test('a month is judged only where QuickBooks was read back, and only from a clean comparison', () => {
  const periods = [{ period_start: '2026-09-01', read_through: '2026-09-30' }, { period_start: '2026-08-01', read_through: '2026-08-31' }, { period_start: '2026-07-01', read_through: '2026-07-31' }];
  const got = S.agreement(periods, [
    { month: '2026-09', entries: 3, changed: 0, amount: 0 },
    { month: '2026-08', entries: 2, changed: 1, amount: '120.5' },
    { month: '2026-10', entries: 1, changed: 0, amount: 0 },       // never read back
  ]);
  same(Object.keys(got).sort(), ['2026-07', '2026-08', '2026-09']);
  assert.equal(got['2026-09'].state, 'agree');
  assert.equal(got['2026-08'].state, 'differs');
  assert.equal(got['2026-07'].state, 'agree', 'read back, and SILO sent nothing that month');
  same(S.agreementLabel(got['2026-09']), { text: 'QuickBooks and SILO agree', tone: 'pos' });
  same(S.agreementLabel(got['2026-08']), { text: 'Differs by 120.50', tone: 'neg' });
  same(S.agreementLabel({ state: 'differs', changed: 1, amount: 0 }), { text: '1 entry changed in QuickBooks', tone: 'neg' });
  same(S.agreementLabel({ state: 'differs', changed: 2, amount: 0 }), { text: '2 entries changed in QuickBooks', tone: 'neg' });
  assert.equal(S.agreementLabel(undefined), null);
  // The comparison could not be read: no month is called agreed.
  same(S.agreement(periods, null), {});
  same(S.agreement(null, []), {});
  // A row that is not numbers takes its month's verdict away.
  same(Object.keys(S.agreement(periods, [{ month: '2026-09', entries: 'x', changed: 0, amount: 0 }])).sort(), ['2026-07', '2026-08']);
});

test('load: the read-back is read when it is there and its absence changes nothing else', async () => {
  const withMirror = { ...tables('silo'), quickbooks_ledger_mirror_periods: [{ period_start: '2026-10-01', read_through: '2026-10-31' }],
    chat_run_readonly_query: [{ month: '2026-10', entries: 1, changed: 0, amount: 0 }] };
  const company = { ensureActiveCompany: async () => ({ id: '11111111-1111-4111-8111-111111111111', name: 'Co' }) };
  const a = await S.load(fakeDb(withMirror), { ...company });
  same(a.agreement, { '2026-10': { state: 'agree', entries: 1, changed: 0, amount: 0, through: '2026-10-31' } });
  same(a.errors, []);
  for (const broken of [fakeDb({ ...withMirror, quickbooks_ledger_mirror_periods: 'missing' }), fakeDb(withMirror, ['chat_run_readonly_query']), fakeDb(tables('silo'))]) {
    const b = await S.load(broken, { ...company });
    same(b.agreement, {});
    same(b.errors, []);
    assert.equal(b.items.filter((i) => i.sendable).length, a.items.filter((i) => i.sendable).length);
  }
});
