/* Initiative Type and task Type are FREE TEXT — /v2/launch-calendar.html
 * and the Task Manager's drawer (/v2/tasks.html) — and the Task Manager's
 * table names the LAUNCH a task rolls up to, and its NOTES, with no Est.
 *
 * Both columns are plain `text` in the database with no CHECK and no enum, but
 * the drawer used to offer a closed <select>. That did two things: it refused a
 * new word, and — worse — opening a row whose stored type was not one of the
 * options silently reset the field to blank (tasks) or to the first option
 * (initiatives), so merely editing anything else on that row rewrote its type.
 *
 * The real page, a fake Supabase. What is asserted is what the page WRITES:
 *
 *   1. editing a row with an off-list type keeps that type, in the field and
 *      in the saved payload
 *   2. a type nobody has used before can be typed and is written verbatim
 *   3. the known values are still offered, as <datalist> suggestions, next to
 *      the types actually in use
 *   4. a blank initiative type is refused in the page (`channel` is NOT NULL)
 *   5. the Task Manager table has a Launch column (derived from the task's
 *      initiative, linking to that launch) and a Notes column, and no Est.
 */
'use strict';

const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('free-text-types');

const iso = (d) => d.toISOString().slice(0, 10);
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

const LAUNCH = {
  id: 'l-1', title: 'Fall Drop', launch_date: day(3), launch_time: '09:00',
  launch_type: 'Limited Time Event', status: 'planned', launch_readiness: 'not_reviewed',
  linked_po_id: 'po-1', company_entity_id: 'test-company',
};

const TABLES = () => ({
  launch_calendar: [LAUNCH],
  // Both rows carry a type the old closed lists did not contain.
  launch_channel_items: [{
    id: 'ci-1', launch_id: 'l-1', channel: 'podcast', item_title: 'Podcast read',
    scheduled_date: day(2), status: 'planned', company_entity_id: 'test-company',
  }],
  launch_tasks: [{
    id: 't-1', launch_id: 'l-1', task_title: 'Brief the agency',
    task_type: 'Lower Funnel', status: 'open', priority: 'normal',
    notes: 'Agency needs the brief by Friday.', estimated_minutes: 240,
    // assigned, so it also appears in one person's ordered list
    assigned_to_user_id: 'test-user', assigned_to_name: 'Test User',
    company_entity_id: 'test-company',
  }, {
    // On an initiative, with NO launch_id of its own: the Launch column has
    // to derive it from the initiative.
    id: 't-2', launch_id: null, channel_item_id: 'ci-1',
    task_title: 'Record the read', task_type: 'creative',
    status: 'open', priority: 'normal', notes: null,
    company_entity_id: 'test-company',
  }, {
    // Attached to nothing at all.
    id: 't-3', launch_id: null, task_title: 'Tidy the shared drive',
    task_type: null, status: 'open', priority: 'low', notes: null,
    company_entity_id: 'test-company',
  }],
  launch_assets: [], launch_comments: [], launch_system_links: [],
  launch_product_readiness: [], product_tracker: [],
  profiles: [{ id: 'test-user', name: 'Test User', email: 'test@baseballism.com', role: 'admin', is_active: true }],
});

const READY = () => {
  const s = document.getElementById('page-status');
  return s && /Ready\.|Load failed/.test(s.textContent);
};

const writes = (page, table) => page.evaluate((t) => (window.__QUERIES__ || [])
  .filter((q) => q.table === t && (q._op === 'insert' || q._op === 'update'))
  .map((q) => ({ op: q._op, body: q._op === 'insert' ? q.rows : q.patch })), table);

const datalist = (page, id) => page.$$eval(`#${id} option`, (os) => os.map((o) => o.value));

const tab = async (page, name) => {
  await page.click(`.drawer-tab[data-dp="${name}"]`);
  await page.waitForTimeout(80);
};

(async () => {
  const suite = await startSuite();
  try {
    const page = await suite.open('/v2/launch-calendar.html?launch=l-1', TABLES(), { ready: READY });
    R.eq(await page.textContent('#page-status'), 'Ready.', 'boot');

    // ── Type is an input, not a closed list ─────────────────────────────
    R.test('neither Type field is a <select> any more', async () => {});
    R.eq(await page.$eval('#channelName', (e) => e.tagName), 'INPUT', 'initiative Type is an input');
    R.eq(await page.$eval('#taskType', (e) => e.tagName), 'INPUT', 'task Type is an input');

    // ── 1: an off-list initiative type survives an edit ─────────────────
    await tab(page, 'dp-channels');
    await page.click('[data-edit-ch="ci-1"]');
    await page.waitForTimeout(80);
    R.test('editing an initiative shows its stored type verbatim', async () => {});
    R.eq(await page.inputValue('#channelName'), 'podcast', 'off-list type is not rewritten');

    await page.click('#channelFormSaveBtn');
    await page.waitForTimeout(200);
    const chUpdates = (await writes(page, 'launch_channel_items')).filter((w) => w.op === 'update');
    R.eq(chUpdates.length, 1, 'the edit was saved');
    R.eq(chUpdates[0].body.channel, 'podcast', 'saving an untouched row keeps its type');

    // ── 2: a brand new initiative type can be typed ─────────────────────
    await tab(page, 'dp-channels');
    await page.click('#showChannelFormBtn');
    await page.waitForTimeout(80);
    R.eq(await page.inputValue('#channelName'), 'email', 'a new initiative still defaults to email');
    await page.fill('#channelTitle', 'Podcast tour');
    await page.fill('#channelName', 'Podcast Tour');
    await page.click('#channelFormSaveBtn');
    await page.waitForTimeout(200);
    const chInserts = (await writes(page, 'launch_channel_items')).filter((w) => w.op === 'insert');
    R.eq(chInserts.length, 1, 'the new initiative was inserted');
    R.eq(chInserts[0].body[0].channel, 'Podcast Tour', 'a never-before-used type is written verbatim');

    // ── 4: a blank initiative type is refused here, not by Postgres ─────
    await tab(page, 'dp-channels');
    await page.click('#showChannelFormBtn');
    await page.waitForTimeout(80);
    await page.fill('#channelTitle', 'No type');
    await page.fill('#channelName', '   ');
    await page.click('#channelFormSaveBtn');
    await page.waitForTimeout(200);
    R.eq((await writes(page, 'launch_channel_items')).filter((w) => w.op === 'insert').length, 1,
      'a blank type writes nothing');
    R.has((await page.textContent('#page-status')).toLowerCase(), 'type is required');

    // ── 1 again, for tasks ──────────────────────────────────────────────
    await tab(page, 'dp-tasks');
    await page.click('[data-edit-task="t-1"]');
    await page.waitForTimeout(80);
    R.test('editing a task shows its stored type verbatim', async () => {});
    R.eq(await page.inputValue('#taskType'), 'Lower Funnel', 'off-list task type is not cleared');

    await page.click('#taskFormSaveBtn');
    await page.waitForTimeout(200);
    const tUpdates = (await writes(page, 'launch_tasks')).filter((w) => w.op === 'update');
    R.eq(tUpdates.length, 1, 'the task edit was saved');
    R.eq(tUpdates[0].body.task_type, 'Lower Funnel', 'saving an untouched task keeps its type');

    // ── 2 again, for tasks ──────────────────────────────────────────────
    await tab(page, 'dp-tasks');
    await page.click('#showTaskFormBtn');
    await page.waitForTimeout(80);
    await page.fill('#taskTitle', 'Book the retail window');
    await page.fill('#taskType', 'Retail Ops');
    await page.click('#taskFormSaveBtn');
    await page.waitForTimeout(200);
    const tInserts = (await writes(page, 'launch_tasks')).filter((w) => w.op === 'insert');
    R.eq(tInserts.length, 1, 'the new task was inserted');
    R.eq(tInserts[0].body[0].task_type, 'Retail Ops', 'a never-before-used task type is written verbatim');

    // ── 3: the old lists survive as suggestions ─────────────────────────
    const chOpts = (await datalist(page, 'channelTypeList')).map((v) => v.toLowerCase());
    const tOpts = (await datalist(page, 'taskTypeList')).map((v) => v.toLowerCase());
    R.test('the former options are offered as suggestions, with what is in use', async () => {});
    for (const v of ['email', 'sms', 'organic', 'meta', 'website', 'retail', 'other']) {
      R.ok(`initiative suggestion: ${v}`, chOpts.includes(v));
    }
    R.ok('an in-use initiative type is suggested too', chOpts.includes('podcast'));
    for (const v of ['creative', 'inventory', 'website', 'email', 'sms', 'qa']) {
      R.ok(`task suggestion: ${v}`, tOpts.includes(v));
    }
    R.ok('an in-use task type is suggested too', tOpts.includes('lower funnel'));
    R.eq(new Set(chOpts).size, chOpts.length, 'no duplicate initiative suggestions');
    R.eq(new Set(tOpts).size, tOpts.length, 'no duplicate task suggestions');

    await page.close();

    // ── the Task Manager drawer: Type was already free text; the same
    //    vocabulary is offered there as suggestions ──────────────────────
    // The page hides its status banner on success, so wait for the work it
    // does last: the filter dropdowns, built from the loaded tasks.
    const tm = await suite.open('/v2/tasks.html', TABLES(), {
      ready: () => {
        const f = document.getElementById('fType');
        return f && f.options.length > 1;
      },
    });
    R.test('the Task Manager Type field is free text with suggestions', async () => {});
    R.eq(await tm.$eval('#dType', (e) => e.tagName), 'INPUT', 'Task Manager Type is an input');
    R.eq(await tm.$eval('#dType', (e) => e.getAttribute('list')), 'dTypeList', 'it is wired to a datalist');
    const tmOpts = await tm.$$eval('#dTypeList option', (os) => os.map((o) => o.value));
    R.ok('a type already in use is suggested', tmOpts.includes('Lower Funnel'));

    // ── the table names the launch and the notes, and no estimate ───────
    const headers = await tm.$$eval('#tasksTable thead th', (ths) => ths.map((t) => t.textContent.trim()));
    R.test('the table has Launch and Notes columns and no Est.', async () => {});
    R.ok('Launch is a column', headers.includes('Launch'));
    R.ok('Notes is a column', headers.includes('Notes'));
    R.ok('Est. is gone', !headers.some((h) => /^Est/i.test(h)));
    R.ok('Attached to is still there', headers.includes('Attached to'));

    const row = (id) => tm.$$eval(`#tasksTbody tr[data-task-id="${id}"] td`,
      (tds) => tds.map((td) => ({ text: td.textContent.trim(), href: td.querySelector('a') && td.querySelector('a').getAttribute('href') })));
    // The Order column's <th> is always present (hidden by CSS in the All
    // Tasks view) but its <td> is only rendered for one person's list, so
    // line the two up by the difference rather than by a fixed offset.
    const col = (cells, name) => cells[headers.indexOf(name) - (headers.length - cells.length)];

    const direct = await row('t-1');
    R.test('a task on a launch names that launch, and shows its notes', async () => {});
    R.eq(col(direct, 'Launch').text, 'Fall Drop', 'launch cell');
    R.has(col(direct, 'Launch').href || '', 'launch=l-1', 'the launch cell links to the launch');
    R.eq(col(direct, 'Notes').text, 'Agency needs the brief by Friday.', 'notes cell');
    R.not(direct.map((c) => c.text).join('|'), '4h', 'no estimate is rendered');

    const viaInit = await row('t-2');
    R.test('a task on an initiative still names the launch underneath it', async () => {});
    R.has(col(viaInit, 'Attached to').text, 'Podcast read', 'the initiative is named');
    R.eq(col(viaInit, 'Launch').text, 'Fall Drop', 'the launch is derived from the initiative');
    R.has(col(viaInit, 'Launch').href || '', 'launch=l-1', 'and still links there');
    R.eq(col(viaInit, 'Notes').text, '\u2014', 'a task with no notes shows a dash');

    // One person's ordered list renders an extra Order <td> that the All
    // Tasks view does not, so the columns have to line up in both views --
    // a table whose Launch column shows the notes is worse than no column.
    await tm.click('#viewMyTab');
    await tm.waitForTimeout(120);
    const ordered = await row('t-1');
    R.test('the columns still line up in one person\u2019s ordered list', async () => {});
    R.eq(ordered.length, headers.length, 'every header has a cell in this view');
    R.eq(ordered[headers.indexOf('Launch')].text, 'Fall Drop', 'Launch is still the launch');
    R.eq(ordered[headers.indexOf('Notes')].text, 'Agency needs the brief by Friday.', 'Notes is still the notes');
    await tm.click('#viewAllTab');
    await tm.waitForTimeout(120);

    const evergreen = await row('t-3');
    R.test('an evergreen task belongs to no launch', async () => {});
    R.eq(col(evergreen, 'Attached to').text, 'Evergreen', 'attached to nothing');
    R.eq(col(evergreen, 'Launch').text, '\u2014', 'no launch');
    R.eq(col(evergreen, 'Launch').href, null, 'and no link to one');

    await tm.close();
  } catch (err) {
    R.ok('suite ran without throwing', false, err && err.stack);
  } finally {
    await suite.close();
  }
  const out = R.summary();
  process.exit(out.fail ? 1 : 0);
})();
