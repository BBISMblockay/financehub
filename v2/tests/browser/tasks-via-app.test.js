/* /v2/tasks.html — "Via <app>" on a task an app opened.
 *
 * work:write lets a connected application open a task for the person who
 * granted it. The row then carries `created_via = 'app'` and the
 * application's own name in `created_by_app`, and the list has to say so:
 * a task nobody on the team typed must not read as if a colleague typed it.
 *
 * What is asserted:
 *   1. the chip renders beside the title, naming the app, in Table and Board
 *   2. a row with no app name still says so, rather than rendering "Via "
 *   3. a task a person typed carries no chip at all
 *   4. the "Anyone / Opened by an app / Opened by a person" filter splits the
 *      list the way the chips do
 *   5. the filter is HIDDEN entirely where no app has opened a task -- which
 *      is every company until someone grants work:write, and every database
 *      where the migration has not been applied yet (the columns come back
 *      undefined and every task reads as a person's)
 */
'use strict';

const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('tasks-via-app');

const USER = 'test-user';
const PROFILES = [
  { id: USER, name: 'Alex Rivera', email: 'test@baseballism.com', avatar_url: null, is_active: true, role: 'admin' },
];

const base = {
  task_type: 'Ops', status: 'open', priority: 'normal', due_date: null,
  estimated_minutes: null, assigned_to_user_id: USER, assigned_to_name: 'Alex Rivera',
  launch_id: null, channel_item_id: null, is_private: false, notes: null,
};

// Three apps' worth of provenance, and two tasks a person typed.
const WITH_APPS = [
  { ...base, id: 't1', task_title: 'Pull the Redo refund rate', sort_order: 1,
    created_via: 'app', created_by_app: 'Claude' },
  { ...base, id: 't2', task_title: 'Check Meta spend pacing', sort_order: 2,
    created_via: 'app', created_by_app: 'Claude' },
  // An application that registered without a name: the chip must not read "Via ".
  { ...base, id: 't3', task_title: 'Reconcile the bank feed', sort_order: 3,
    created_via: 'app', created_by_app: null },
  { ...base, id: 't4', task_title: 'Stage the retail window', sort_order: 4,
    created_via: null, created_by_app: null },
  { ...base, id: 't5', task_title: 'Brief the photographer', sort_order: 5,
    created_via: 'ask_silo', created_by_app: null },
];

// The same page before anybody granted work:write -- and the same shape a
// database serves when 20261104230000 has not been applied.
const NO_APPS = [
  { ...base, id: 'p1', task_title: 'Stage the retail window', sort_order: 1 },
  { ...base, id: 'p2', task_title: 'Brief the photographer', sort_order: 2 },
];

const TABLES = (tasks) => ({
  launch_tasks: tasks,
  launch_calendar: [],
  launch_channel_items: [],
  profiles: PROFILES,
});

const READY = () => {
  const tb = document.getElementById('tasksTbody');
  return tb && !/Loading/.test(tb.textContent);
};

// id -> the chip text on that row, '' where there is none.
const chips = (page) => page.$$eval('#tasksTbody tr[data-task-id]', (rows) => {
  const out = {};
  for (const r of rows) {
    const pill = [...r.querySelectorAll('.bcn-pill')].find((p) => /^Via /.test(p.textContent.trim()));
    out[r.dataset.taskId] = pill ? pill.textContent.trim() : '';
  }
  return out;
});
const rowIds = (page) => page.$$eval('#tasksTbody tr[data-task-id]', (rs) => rs.map((r) => r.dataset.taskId));

(async () => {
  const suite = await startSuite({ viewport: { width: 1500, height: 900 } });
  try {
    let page = await suite.open('/v2/tasks.html', TABLES(WITH_APPS), { ready: READY });

    // ── 1 and 2: the chip, in the table ─────────────────────────────────
    const c = await chips(page);
    R.test('a task an app opened names the app beside its title', async () => {});
    R.eq(c.t1, 'Via Claude', 'the app’s own name is on the row');
    R.eq(c.t2, 'Via Claude', 'and on every row it opened');
    R.test('an app with no registered name still reads as an app', async () => {});
    R.eq(c.t3, 'Via an app', 'not "Via " with nothing after it');

    // ── 3: a person's task is untouched ─────────────────────────────────
    R.test('a task a person typed carries no chip', async () => {});
    R.eq(c.t4, '', 'nothing beside a hand-typed task');
    R.eq(c.t5, '', 'and nothing on an Ask SILO task either -- that is a person asking');

    // the title itself is still there next to the chip
    R.has(await page.textContent('#tasksTbody tr[data-task-id="t1"]'), 'Pull the Redo refund rate',
      'the chip is added to the title, not instead of it');

    // ── the chip survives the view switch ───────────────────────────────
    await page.click('[data-display="board"]');
    await page.waitForTimeout(150);
    R.test('the board carries the same chip', async () => {});
    R.has(await page.textContent('#tmKanban [data-open-task="t1"]'), 'Via Claude', 'on the kanban card');
    R.ok('and not on a person’s card',
      !/Via /.test(await page.textContent('#tmKanban [data-open-task="t4"]')));
    await page.click('[data-display="table"]');
    await page.waitForTimeout(150);

    // ── 4: the filter ───────────────────────────────────────────────────
    R.test('the source filter is offered once an app has opened a task', async () => {});
    R.eq(await page.$eval('#fSourceWrap', (e) => e.hidden), false, 'the control is shown');
    R.eq(await page.$eval('#fSource', (e) => e.value), '', 'and starts on Anyone');
    R.eq((await rowIds(page)).length, WITH_APPS.length, 'every task is listed to begin with');

    await page.selectOption('#fSource', 'app');
    await page.waitForTimeout(150);
    R.test('"Opened by an app" lists exactly the app’s tasks', async () => {});
    R.eq((await rowIds(page)).sort().join(','), 't1,t2,t3', 'the three app tasks, and only those');

    await page.selectOption('#fSource', 'person');
    await page.waitForTimeout(150);
    R.test('"Opened by a person" is the complement', async () => {});
    R.eq((await rowIds(page)).sort().join(','), 't4,t5', 'the two a person typed');

    await page.selectOption('#fSource', '');
    await page.waitForTimeout(150);
    R.eq((await rowIds(page)).length, WITH_APPS.length, 'Anyone brings everything back');
    await page.close();

    // ── 5: no apps, no filter ───────────────────────────────────────────
    page = await suite.open('/v2/tasks.html', TABLES(NO_APPS), { ready: READY });
    R.test('where no app has opened a task the filter is not offered', async () => {});
    R.eq(await page.$eval('#fSourceWrap', (e) => e.hidden), true, 'the control is hidden');
    R.eq((await rowIds(page)).length, NO_APPS.length, 'and the list is unaffected');
    const none = await chips(page);
    R.eq(Object.values(none).join(''), '', 'no chips anywhere');
    await page.close();
  } catch (err) {
    R.ok('suite ran without throwing', false, err && err.stack);
  } finally {
    await suite.close();
  }
  const out = R.summary();
  process.exit(out.fail ? 1 : 0);
})();
