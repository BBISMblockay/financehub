/* /v2/seo-tasks.html's decisions: where a task stands, which buttons a person
 * is offered, and what each button writes.
 *
 * Why: this is the approval step for changes to live pages. A publication is
 * the fact that matters most, so it must outrank every status; approval must
 * never be offered to someone who cannot approve; and a rejection must carry
 * its reason, because the person who drafted the task reads it. */
'use strict';

const { createReporter } = require('../lib/assert');
const { loadV2 } = require('../lib/load');

const W = loadV2(['seo-keywords.js', 'seo-studio.js', 'seo-tasks.js']);
const T = W.SiloSeoTasks;
const r = createReporter('seo-tasks');

const task = (o) => Object.assign({ id: 't1', approval_status: 'draft', created_by: 'me', created_at: '2026-09-28T00:00:00Z' }, o);
const pub = { task_id: 't1', published_at: '2026-09-20T10:00:00Z' };
const has = (list, a) => list.indexOf(a) >= 0;

console.log('\n── stage ──');
r.test('a publication outranks every status', () => {
  r.eq(T.stage(task({ approval_status: 'approved' }), [pub]), 'published');
  r.eq(T.stage(task({ approval_status: 'approved' }), [{ task_id: 'other', published_at: 'x' }]), 'approved');
});
r.test('each status reads as itself; an unknown one as draft', () => {
  ['draft', 'proposed', 'approved', 'rejected'].forEach((s) => r.eq(T.stage(task({ approval_status: s }), []), s));
  r.eq(T.stage(task({ approval_status: 'weird' }), []), 'draft');
});

console.log('\n── who is offered what ──');
const drafter = { userId: 'me', canApprove: false };
const stranger = { userId: 'someone', canApprove: false };
const approver = { userId: 'boss', canApprove: true };
r.test('a drafter can edit and send their own draft, never approve it', () => {
  const a = T.actions(task(), [], drafter);
  r.truthy(has(a, 'edit') && has(a, 'submit') && has(a, 'delete'), a.join(','));
  r.truthy(!has(a, 'approve') && !has(a, 'reject'), 'approval offered to a non-approver');
});
r.test('a member who did not draft it can only look', () => {
  r.eq(T.actions(task(), [], stranger).length, 0);
  r.eq(T.actions(task({ approval_status: 'proposed' }), [], stranger).length, 0);
});
r.test('an approver can approve or reject a waiting task', () => {
  const a = T.actions(task({ approval_status: 'proposed' }), [], approver);
  r.truthy(has(a, 'approve') && has(a, 'reject') && has(a, 'edit'), a.join(','));
});
r.test('an approved task offers publication to anyone who can see it, and nobody can edit it', () => {
  const t = task({ approval_status: 'approved' });
  r.truthy(has(T.actions(t, [], stranger), 'publish'), 'publish not offered');
  [drafter, approver, stranger].forEach((w) => r.truthy(!has(T.actions(t, [], w), 'edit'), 'approved task editable'));
  r.truthy(has(T.actions(t, [], approver), 'unapprove'), 'no way back from approved');
});
r.test('a published task is frozen for everyone', () => {
  [drafter, approver, stranger].forEach((w) => r.eq(T.actions(task({ approval_status: 'approved' }), [pub], w).length, 0));
});
r.test('a rejected task can be reopened or deleted by its drafter', () => {
  const a = T.actions(task({ approval_status: 'rejected' }), [], drafter);
  r.truthy(has(a, 'reopen') && has(a, 'delete') && has(a, 'edit'), a.join(','));
});

console.log('\n── what a button writes ──');
r.test('approve stamps who and when and clears an old rejection', () => {
  const p = T.patchFor('approve', { userId: 'boss', now: '2026-09-28T12:00:00Z' });
  r.truthy(p.ok);
  r.eq(p.patch.approval_status, 'approved'); r.eq(p.patch.approved_by, 'boss'); r.eq(p.patch.approved_at, '2026-09-28T12:00:00Z'); r.eq(p.patch.rejection_reason, null);
});
r.test('reject needs a reason and clears approval', () => {
  r.eq(T.patchFor('reject', { reason: '  ' }).ok, false);
  const p = T.patchFor('reject', { reason: 'Title is too long' });
  r.eq(p.patch.approval_status, 'rejected'); r.eq(p.patch.rejection_reason, 'Title is too long'); r.eq(p.patch.approved_by, null);
});
r.test('an edit writes only the fields given, blanks as null, never a blank title or a non-http URL', () => {
  const p = T.patchFor('edit', { fields: { proposed_title: ' Baseball Backpacks | Baseballism ', proposed_body: '' } });
  r.eq(p.patch.proposed_title, 'Baseball Backpacks | Baseballism'); r.eq(p.patch.proposed_body, null);
  r.truthy(!('title' in p.patch) && !('approval_status' in p.patch), 'edit wrote more than it was given');
  r.eq(T.patchFor('edit', { fields: { title: ' ' } }).ok, false);
  r.eq(T.patchFor('edit', { fields: { target_url: 'javascript:alert(1)' } }).ok, false);
});
r.test('every write captions its revision', () => {
  ['submit', 'withdraw', 'unapprove', 'reopen'].forEach((a) => r.truthy(T.patchFor(a).patch.revision_note, a));
});

console.log('\n── publication ──');
const now = Date.parse('2026-09-28T12:00:00Z');
r.test('a publication date is required and never in the future', () => {
  r.eq(T.publishedAt('', now).ok, false);
  r.eq(T.publishedAt('not a date', now).ok, false);
  r.eq(T.publishedAt('2026-10-05T09:00', now).ok, false);
  r.truthy(T.publishedAt('2026-09-27T09:00', now).ok);
});
r.test('follow-ups are 30 and 90 days after it went live', () => {
  r.eq(T.followUps('2026-09-01T00:00:00Z').map((f) => f.on).join(','), '2026-10-01,2026-11-30');
  r.eq(T.followUps(null).length, 0);
});

console.log('\n── list ──');
r.test('the Studio link is the Studio page key for the task\'s URL', () => {
  r.eq(T.studioHref('https://www.baseballism.com/collections/backpacks?srsltid=X', W.SiloSeoStudio),
    '/v2/seo-studio.html?page=' + encodeURIComponent('page:/collections/backpacks'));
  r.eq(T.studioHref(null, W.SiloSeoStudio), null);
});
r.test('waiting-for-approval first, then approved, drafts, published, rejected', () => {
  const ts = [task({ id: 'a', approval_status: 'rejected' }), task({ id: 'b', approval_status: 'draft' }), task({ id: 'c', approval_status: 'approved' }),
    task({ id: 'd', approval_status: 'proposed' }), task({ id: 'e', approval_status: 'approved' })];
  r.eq(T.sort(ts, [{ task_id: 'e', published_at: 'x' }]).map((t) => t.id).join(''), 'dcbea');
  const c = T.counts(ts, [{ task_id: 'e', published_at: 'x' }]);
  r.eq(JSON.stringify(c), JSON.stringify({ all: 5, draft: 1, proposed: 1, approved: 1, published: 1, rejected: 1 }));
});

const out = r.summary();
process.exit(out.fail ? 1 : 0);
