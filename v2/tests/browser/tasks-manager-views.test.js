/* /v2/tasks.html — the Table / Board / Calendar switcher.
 *
 * The real page, a fake Supabase. Every view reads the same filtered set, so
 * what is asserted is that no task falls out of one of them:
 *
 *   1. the three panes toggle, and Table stays the default
 *   2. the board puts every task in a column, including a task whose status
 *      was written by v2/launch-calendar.html as `in_progress` with an
 *      underscore -- the board's own spelling is `in-progress`, and a task
 *      matching neither used to vanish
 *   3. the board's column counts add up to the number the bar reports
 *   4. the calendar places a chip on the task's own due date
 *   5. a day with more tasks than fit still reaches all of them: the overflow
 *      label expands the day and the last task can be opened
 *
 * Screenshots are written only when TM_UX_SCREENSHOT_DIR is set, so CI does
 * not accumulate PNGs nobody reads.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('tasks-manager-views');

const USER = 'test-user';
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const LAUNCH = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const iso = (d) => d.toISOString().slice(0, 10);
// Every date is relative to the 15th of this month, and the page's clock is
// pinned there too. Relative to the real today, day(+2) fell in next month on
// the last two days of a month, off the calendar the page opens on.
const NOW = (() => { const d = new Date(); d.setDate(15); d.setHours(12, 0, 0, 0); return d; })();
const day = (n) => { const d = new Date(NOW); d.setDate(d.getDate() + n); return iso(d); };

const PROFILES = [
  { id: USER, name: 'Alex Rivera', email: 'test@baseballism.com', avatar_url: null, is_active: true, role: 'admin' },
  { id: OTHER, name: 'Jordan Lee', email: 'jordan@baseballism.com', avatar_url: null, is_active: true, role: 'admin' },
];
const LAUNCHES = [{ id: LAUNCH, title: 'Spring Drop 2026', launch_date: day(10) }];

// day(+2) deliberately carries five tasks, so the calendar has to offer more
// than the three chips that fit.
const CROWDED = day(2);

const TASKS = [
  { id: 't1', task_title: 'Finalize hero email copy', task_type: 'Email', status: 'in-progress', priority: 'high',
    due_date: day(-2), estimated_minutes: 60, assigned_to_user_id: USER, assigned_to_name: 'Alex Rivera',
    launch_id: LAUNCH, channel_item_id: null, is_private: false, sort_order: 1, notes: 'Brief by Friday.' },
  // The Launch Calendar's spelling of the same state.
  { id: 't2', task_title: 'Stage the retail window', task_type: 'Ops', status: 'in_progress', priority: 'high',
    due_date: CROWDED, estimated_minutes: 45, assigned_to_user_id: USER, assigned_to_name: 'Alex Rivera',
    launch_id: LAUNCH, channel_item_id: null, is_private: false, sort_order: 2, notes: null },
  { id: 't3', task_title: 'Upload PDP lifestyle shots', task_type: 'Creative', status: 'open', priority: 'critical',
    due_date: CROWDED, estimated_minutes: 120, assigned_to_user_id: USER, assigned_to_name: 'Alex Rivera',
    launch_id: LAUNCH, channel_item_id: null, is_private: false, sort_order: 3, notes: null },
  { id: 't4', task_title: 'Reconcile launch inventory', task_type: 'Ops', status: 'open', priority: 'normal',
    due_date: CROWDED, estimated_minutes: 30, assigned_to_user_id: OTHER, assigned_to_name: 'Jordan Lee',
    launch_id: LAUNCH, channel_item_id: null, is_private: false, sort_order: 4, notes: null },
  { id: 't5', task_title: 'Brief the photographer', task_type: 'Creative', status: 'open', priority: 'normal',
    due_date: CROWDED, estimated_minutes: 30, assigned_to_user_id: OTHER, assigned_to_name: 'Jordan Lee',
    launch_id: LAUNCH, channel_item_id: null, is_private: false, sort_order: 5, notes: null },
  { id: 't6', task_title: 'Confirm freight booking', task_type: 'Ops', status: 'open', priority: 'low',
    due_date: CROWDED, estimated_minutes: 15, assigned_to_user_id: null, assigned_to_name: null,
    launch_id: LAUNCH, channel_item_id: null, is_private: false, sort_order: 6, notes: null },
  { id: 't7', task_title: 'Refresh the social bio link', task_type: 'Social', status: 'open', priority: 'low',
    due_date: null, estimated_minutes: 15, assigned_to_user_id: null, assigned_to_name: null,
    launch_id: null, channel_item_id: null, is_private: false, sort_order: 7, notes: null },
  // A status neither page writes today. Nothing stops one appearing -- the
  // column is free text and other writers exist -- and the board must put it
  // somewhere rather than drop it, which is the whole point of a catch-all.
  { id: 't8', task_title: 'Waiting on the vendor', task_type: 'Ops', status: 'blocked', priority: 'normal',
    due_date: day(5), estimated_minutes: 30, assigned_to_user_id: USER, assigned_to_name: 'Alex Rivera',
    launch_id: LAUNCH, channel_item_id: null, is_private: false, sort_order: 8, notes: null },
];

const TABLES = () => ({
  launch_tasks: TASKS,
  launch_calendar: LAUNCHES,
  launch_channel_items: [],
  profiles: PROFILES,
});

const READY = () => {
  const tb = document.getElementById('tasksTbody');
  return tb && !/Loading/.test(tb.textContent);
};

const OUT = process.env.TM_UX_SCREENSHOT_DIR || '';
async function snap(page, name) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: true });
  console.log('saved ' + file);
}

const hidden = (page, id) => page.$eval('#' + id, (e) => e.hidden);
const cardIds = (page) => page.$$eval('#tmKanban [data-open-task]', (bs) => bs.map((b) => b.dataset.openTask));
const colCounts = (page) => page.$$eval('#tmKanban .tm-k-col', (cs) => cs.map((c) => ({
  label: c.querySelector('.tm-k-col-head span').textContent.trim(),
  n: c.querySelectorAll('[data-open-task]').length,
})));

(async () => {
  const suite = await startSuite({ viewport: { width: 1500, height: 900 } });
  try {
    await suite.context.clock.setFixedTime(NOW);
    const page = await suite.open('/v2/tasks.html', TABLES(), { ready: READY });

    // ── 1: Table is the default; the panes toggle ───────────────────────
    R.test('Table is the default view', async () => {});
    R.eq(await hidden(page, 'tmTablePane'), false, 'table pane shown');
    R.eq(await hidden(page, 'tmBoardPane'), true, 'board pane hidden');
    R.eq(await hidden(page, 'tmCalendarPane'), true, 'calendar pane hidden');
    await snap(page, 'task_manager_table_view.png');

    // The default status filter keeps everything that is not done, so all
    // seven fixtures are in play.
    const shown = Number((await page.textContent('#displayMeta')).match(/^(\d+)/)[1]);
    R.eq(shown, TASKS.length, 'every fixture task is in the filtered set');

    // ── 2 and 3: the board loses nobody ─────────────────────────────────
    await page.click('[data-display="board"]');
    await page.waitForTimeout(150);
    R.test('switching to Board shows only the board', async () => {});
    R.eq(await hidden(page, 'tmBoardPane'), false, 'board pane shown');
    R.eq(await hidden(page, 'tmTablePane'), true, 'table pane hidden');

    const onBoard = await cardIds(page);
    R.test('every task in the filtered set is on the board', async () => {});
    R.eq(onBoard.length, TASKS.length, 'card count matches the filtered set');
    for (const t of TASKS) R.ok(`on the board: ${t.id}`, onBoard.includes(t.id));

    const counts = await colCounts(page);
    R.test('the underscore spelling counts as In progress, not as a lost row', async () => {});
    const byLabel = Object.fromEntries(counts.map((c) => [c.label, c.n]));
    R.eq(byLabel['In progress'], 2, 'both in-progress spellings land in one column');
    R.eq(byLabel['Open'], 6, 'the rest are open, an unknown status among them');
    R.ok('an unrecognised status is on the board, not lost',
      (await page.$$eval('#tmKanban .tm-k-col', (cs) => {
        const open = cs.find((c) => c.querySelector('.tm-k-col-head span').textContent.trim() === 'Open');
        return open ? [...open.querySelectorAll('[data-open-task]')].map((b) => b.dataset.openTask) : [];
      })).includes('t8'));
    R.eq(byLabel['Done'], 0, 'nothing done in the filtered set');
    R.eq(counts.reduce((a, c) => a + c.n, 0), shown, 'the columns add up to what the bar reports');
    await snap(page, 'task_manager_kanban_board.png');

    // ── 4 and 5: the calendar reaches every task on a crowded day ───────
    await page.click('[data-display="calendar"]');
    await page.waitForTimeout(150);
    R.test('switching to Calendar shows only the calendar', async () => {});
    R.eq(await hidden(page, 'tmCalendarPane'), false, 'calendar pane shown');

    const dueOnCrowded = TASKS.filter((t) => t.due_date === CROWDED);
    R.eq(dueOnCrowded.length, 5, 'the fixture really does crowd one day');

    const chipsNow = await page.$$eval('#tmCalGrid [data-open-task]', (bs) => bs.map((b) => b.dataset.openTask));
    R.test('a chip sits on the task’s own due date', async () => {});
    R.ok('the overdue task has a chip', chipsNow.includes('t1'));
    R.ok('an undated task gets no chip', !chipsNow.includes('t7'));
    const cell = await page.$$eval('#tmCalGrid .tm-cal-cell', (cs) => {
      const hit = cs.find((c) => c.querySelector('[data-expand-day]'));
      return hit ? { day: hit.querySelector('.tm-cal-daynum').textContent.trim(), chips: hit.querySelectorAll('[data-open-task]').length } : null;
    });
    R.truthy(cell, 'the crowded day offers to expand');
    R.eq(cell.day, String(Number(CROWDED.slice(8, 10))), 'the overflow is on the crowded day');
    R.eq(cell.chips, 3, 'it shows three chips before expanding');

    const last = dueOnCrowded[dueOnCrowded.length - 1].id;
    R.test('the hidden tasks are not reachable before expanding', async () => {});
    R.ok('the last task of the day is hidden', !chipsNow.includes(last));

    await page.click('[data-expand-day]');
    await page.waitForTimeout(150);
    const chipsOpen = await page.$$eval('#tmCalGrid [data-open-task]', (bs) => bs.map((b) => b.dataset.openTask));
    R.test('expanding the day reveals every task on it', async () => {});
    for (const t of dueOnCrowded) R.ok(`revealed: ${t.id}`, chipsOpen.includes(t.id));
    R.has(await page.textContent('[data-expand-day]'), 'Show less', 'the label offers to collapse again');

    await page.click('[data-expand-day]');
    await page.waitForTimeout(150);
    R.test('collapsing it again goes back to three chips', async () => {});
    R.eq((await page.$$eval('#tmCalGrid [data-open-task]', (bs) => bs.length)),
      chipsNow.length, 'back to the unexpanded chip count');
    await snap(page, 'task_manager_calendar_view.png');

    // and a revealed task opens the same drawer as any other chip -- the
    // point of making it reachable at all. Done last: the drawer covers the
    // grid, so nothing is clicked after it.
    await page.click('[data-expand-day]');
    await page.waitForTimeout(150);
    // scoped to the grid: the hidden board pane holds a card for the same id
    await page.click(`#tmCalGrid [data-open-task="${last}"]`);
    await page.waitForTimeout(200);
    R.test('a revealed task opens the task drawer', async () => {});
    R.eq(await page.inputValue('#dTitle'), dueOnCrowded[dueOnCrowded.length - 1].task_title, 'the drawer holds that task');

    await page.close();
  } catch (err) {
    R.ok('suite ran without throwing', false, err && err.stack);
  } finally {
    await suite.close();
  }
  const out = R.summary();
  process.exit(out.fail ? 1 : 0);
})();
