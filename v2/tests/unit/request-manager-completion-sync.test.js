/* Request Manager: completion and workflow status move together.
 *
 * Why this exists. The drawer treated "Completed" and "Workflow status" as two
 * independent dropdowns, so saving a request as Completed while its status was
 * still New stored both. On production 2026-10-30 that was 65 completed rows
 * still reading 'new' and 15 reading 'approved' — the table badge said
 * Completed (it reads the boolean) while every status-sliced report, and the
 * org calendar, still counted them as New.
 *
 * The page's own syncCompletionFields is lifted out of the HTML and executed
 * here, the way backend-user-role-payload.test.js does, because the rule is
 * about which field the user CHANGED and a source pattern cannot show that. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');
const { REPO_ROOT } = require('../lib/load');

const r = createReporter('request-manager-completion-sync');
const html = fs.readFileSync(path.join(REPO_ROOT, 'v2', 'request_manager.html'), 'utf8');

const grab = (startMarker, endMarker) => {
  const i = html.indexOf(startMarker);
  if (i < 0) throw new Error(`${startMarker} not found in v2/request_manager.html`);
  const j = html.indexOf(endMarker, i);
  if (j <= i) throw new Error(`${endMarker} not found after ${startMarker}`);
  return html.slice(i, j);
};

const src = grab('const TERMINAL_STATUSES =', '    function badgeHtmlCompleted(');
const ctx = { module: {} };
vm.createContext(ctx);
vm.runInContext(src + '\nmodule.exports = { syncCompletionFields, isTerminalStatus, todayIso };', ctx);
const { syncCompletionFields, isTerminalStatus, todayIso } = ctx.module.exports;
const TODAY = todayIso();

// ── 1. The bug this fixes: completing a request cannot leave status 'new' ────
r.test('marking completed on a new request stores paid, not new', () => {
  r.eq(
    syncCompletionFields({
      workflowStatus: 'new',
      completed: true,
      dateCompleted: '2026-10-30',
      previous: { workflow_status: 'new', completed: false }
    }),
    { workflowStatus: 'paid', completed: true, dateCompleted: '2026-10-30' }
  );
});

r.test('completing without a date stamps today rather than storing null', () => {
  const out = syncCompletionFields({
    workflowStatus: 'approved',
    completed: true,
    dateCompleted: null,
    previous: { workflow_status: 'approved', completed: false }
  });
  r.eq(out, { workflowStatus: 'paid', completed: true, dateCompleted: TODAY });
});

// ── 2. Completing does NOT overwrite a terminal status the user chose ───────
r.test('rejected and cancelled survive being completed', () => {
  for (const status of ['rejected', 'cancelled']) {
    const out = syncCompletionFields({
      workflowStatus: status,
      completed: true,
      dateCompleted: '2026-10-30',
      previous: { workflow_status: status, completed: false }
    });
    r.eq(out.workflowStatus, status, `${status} must not become paid`);
    r.eq(out.completed, true);
  }
});

// ── 3. Status is the driver when the status is what changed ─────────────────
r.test('moving a request to paid marks it completed', () => {
  r.eq(
    syncCompletionFields({
      workflowStatus: 'paid',
      completed: false,
      dateCompleted: null,
      previous: { workflow_status: 'approved', completed: false }
    }),
    { workflowStatus: 'paid', completed: true, dateCompleted: TODAY }
  );
});

r.test('moving a paid request back to in_review reopens it and clears the date', () => {
  r.eq(
    syncCompletionFields({
      workflowStatus: 'in_review',
      completed: true,
      dateCompleted: '2026-10-30',
      previous: { workflow_status: 'paid', completed: true }
    }),
    { workflowStatus: 'in_review', completed: false, dateCompleted: null }
  );
});

// ── 4. Reopening demotes a terminal status instead of contradicting it ─────
r.test('reopening a paid request leaves it approved, not paid-and-open', () => {
  r.eq(
    syncCompletionFields({
      workflowStatus: 'paid',
      completed: false,
      dateCompleted: '2026-10-30',
      previous: { workflow_status: 'paid', completed: true }
    }),
    { workflowStatus: 'approved', completed: false, dateCompleted: null }
  );
});

// ── 5. A legacy mismatch is repaired by any save, even an unrelated one ────
r.test('saving a stored completed+new row repairs it to paid', () => {
  r.eq(
    syncCompletionFields({
      workflowStatus: 'new',
      completed: true,
      dateCompleted: '2026-09-04',
      previous: { workflow_status: 'new', completed: true }
    }),
    { workflowStatus: 'paid', completed: true, dateCompleted: '2026-09-04' }
  );
});

r.test('an already consistent row is returned untouched', () => {
  r.eq(
    syncCompletionFields({
      workflowStatus: 'paid',
      completed: true,
      dateCompleted: '2026-10-01',
      previous: { workflow_status: 'paid', completed: true }
    }),
    { workflowStatus: 'paid', completed: true, dateCompleted: '2026-10-01' }
  );
  r.eq(
    syncCompletionFields({
      workflowStatus: 'needs_info',
      completed: false,
      dateCompleted: null,
      previous: { workflow_status: 'needs_info', completed: false }
    }),
    { workflowStatus: 'needs_info', completed: false, dateCompleted: null }
  );
});

// ── 6. The terminal set is the one the backfill migration uses ─────────────
r.test('terminal statuses are exactly paid, rejected, cancelled', () => {
  for (const s of ['paid', 'rejected', 'cancelled']) r.truthy(isTerminalStatus(s), `${s} must be terminal`);
  for (const s of ['new', 'in_review', 'needs_info', 'approved', 'processing']) {
    r.truthy(!isTerminalStatus(s), `${s} must not be terminal`);
  }
});

// ── 7. Every write path runs through the helper ────────────────────────────
r.test('the drawer save and the bulk status action both call syncCompletionFields', () => {
  const saveSrc = grab('async function saveRow({ markPaid = false } = {}) {', 'async function quickMarkPaid(');
  r.has(saveSrc, 'syncCompletionFields(', 'drawer save must normalise before writing');
  const bulkSrc = grab('async function bulkApplyStatus() {', 'async function bulkApplyAssign(');
  r.has(bulkSrc, 'syncCompletionFields(', 'bulk status must normalise before writing');
  r.has(bulkSrc, 'completed: synced.completed');
});

// ── 8. The paid-confirmation email follows "paid", not "completed" ─────────
// Rejected and cancelled also mark a request completed, and the requester email
// says "has been paid" -- found in review of PR #1081.
r.test('the requester is notified on becoming paid, not on becoming completed', () => {
  const saveSrc = grab('async function saveRow({ markPaid = false } = {}) {', 'async function quickMarkPaid(');
  r.has(saveSrc, 'const justPaid = oldRow.workflow_status !== "paid" && payload.workflow_status === "paid"');
  r.has(saveSrc, 'if (justPaid) {');
  r.not(saveSrc, '!oldRow.completed && payload.completed',
    'completion alone must not trigger the paid confirmation');

  const quickSrc = grab('async function quickMarkPaid(id) {', 'function clearFilters(');
  r.has(quickSrc, 'const wasPaid = row?.workflow_status === "paid"');
  const bulkSrc = grab('async function bulkMarkPaid() {', 'async function bulkForwardMelio(');
  r.has(bulkSrc, 'if (!wasPaid) notifyPromises.push(');

  const rowSrc = grab('function renderNotifyRequesterRow(row) {', 'async function notifyRequester(');
  r.has(rowSrc, 'row?.workflow_status !== "paid"',
    'the manual resend row belongs to paid requests only');
});

const out = r.summary();
if (out.fail) process.exitCode = 1;
