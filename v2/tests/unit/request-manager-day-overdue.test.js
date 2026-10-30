/* Request Manager: a paid request is never shown as overdue.
 *
 * Why this exists. The By day and Calendar views titled a group from its DATE
 * alone -- `dueBucket({ due_date: key, completed: false })` -- so three paid
 * Fanatics invoices with 2026 due dates sat under red "Overdue · Mar 31, 2026"
 * headers (Blake, 2026-10-30). The KPI and queue-strip counts were already
 * right: they filter `!r.completed` first. Only the day headers judged the day
 * without looking at what was in it.
 *
 * The page's own dueBucket, dayGroupIsOverdue and daySectionTitle are executed
 * here, lifted out of the HTML the way backend-user-role-payload.test.js does.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');
const { REPO_ROOT } = require('../lib/load');

const r = createReporter('request-manager-day-overdue');
const html = fs.readFileSync(path.join(REPO_ROOT, 'v2', 'request_manager.html'), 'utf8');

const grab = (startMarker, endMarker) => {
  const i = html.indexOf(startMarker);
  if (i < 0) throw new Error(`${startMarker} not found in v2/request_manager.html`);
  const j = html.indexOf(endMarker, i);
  if (j <= i) throw new Error(`${endMarker} not found after ${startMarker}`);
  return html.slice(i, j);
};

const src = [
  grab('function dueBucket(row) {', 'function dueBucketLabel('),
  grab('function dayGroupIsOverdue(rows) {', 'function requestOpenButtonHtml(')
].join('\n');

const ctx = {
  module: {},
  todayStart: () => new Date(new Date().toDateString()),
  formatDate: (ymd) => ymd
};
vm.createContext(ctx);
vm.runInContext(src + '\nmodule.exports = { dueBucket, dayGroupIsOverdue, daySectionTitle };', ctx);
const { dueBucket, dayGroupIsOverdue, daySectionTitle } = ctx.module.exports;

const ymd = (offsetDays) => {
  const d = new Date(new Date().toDateString());
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};
const PAST = ymd(-30);
const FUTURE = ymd(30);
const paid = (due) => ({ due_date: due, completed: true, workflow_status: 'paid' });
const rejected = (due) => ({ due_date: due, completed: true, workflow_status: 'rejected' });
const cancelled = (due) => ({ due_date: due, completed: true, workflow_status: 'cancelled' });
const open = (due) => ({ due_date: due, completed: false, workflow_status: 'new' });

// ── 1. The bug: a past-due day holding only finished requests ──────────────
r.test('a day of paid requests past its due date is not overdue', () => {
  r.eq(dayGroupIsOverdue([paid(PAST), paid(PAST)]), false);
  r.eq(daySectionTitle(PAST, [paid(PAST)]), PAST, 'the header must be the plain date');
});

r.test('rejected and cancelled are finished too', () => {
  r.eq(dayGroupIsOverdue([rejected(PAST), cancelled(PAST)]), false);
  r.eq(daySectionTitle(PAST, [rejected(PAST)]), PAST);
});

// ── 2. A real overdue day still reads Overdue ─────────────────────────────
r.test('an open request past its due date still makes the day overdue', () => {
  r.eq(dayGroupIsOverdue([open(PAST)]), true);
  r.eq(daySectionTitle(PAST, [open(PAST)]), `Overdue · ${PAST}`);
});

r.test('one open request among paid ones is enough', () => {
  r.eq(dayGroupIsOverdue([paid(PAST), open(PAST), paid(PAST)]), true);
  r.eq(daySectionTitle(PAST, [paid(PAST), open(PAST)]), `Overdue · ${PAST}`);
});

// ── 3. Everything else about the header is unchanged ──────────────────────
r.test('today, tomorrow, future and no-due headers are untouched', () => {
  r.has(daySectionTitle(ymd(0), [open(ymd(0))]), 'Today · ');
  r.has(daySectionTitle(ymd(1), [open(ymd(1))]), 'Tomorrow · ');
  r.eq(daySectionTitle(FUTURE, [open(FUTURE)]), FUTURE);
  r.eq(daySectionTitle('', []), 'No due date');
});

r.test('an empty or missing group is not overdue', () => {
  r.eq(dayGroupIsOverdue([]), false);
  r.eq(dayGroupIsOverdue(undefined), false);
  r.eq(daySectionTitle(PAST, []), PAST, 'a day with nothing in it cannot be overdue');
});

// ── 4. Both views title their groups from their own rows ──────────────────
r.test('By day and Calendar pass their rows to the title', () => {
  const daySrc = grab('function renderDayQueue() {', 'function renderCalendarQueue(');
  r.has(daySrc, 'const overdue = dayGroupIsOverdue(rows);');
  r.has(daySrc, 'daySectionTitle(key, rows)');
  r.not(daySrc, 'completed: false', 'the day header must not assume the group is open');

  const calSrc = grab('function renderCalendarQueue() {', 'function renderTableList(');
  r.has(calSrc, 'daySectionTitle(selected, dayRows)');
});

// ── 5. The counts were already right -- keep them that way ────────────────
r.test('the KPI and queue-strip overdue counts filter completed out first', () => {
  const kpiSrc = grab('function renderKpis() {', 'function renderSummaryCards(');
  r.has(kpiSrc, 'const openRows = state.filteredRows.filter(r => !r.completed);');
  r.has(kpiSrc, 'const overdueRows = openRows.filter(r => dueBucket(r) === "overdue");');
  const cardSrc = grab('function renderSummaryCards() {', 'function renderRecentRequests(');
  r.has(cardSrc, 'openRows.filter(r => dueBucket(r) === "overdue").length');
});

const out = r.summary();
if (out.fail) process.exitCode = 1;
