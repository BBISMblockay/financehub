/* Initiative Type and task Type are FREE TEXT — /v2/launch-calendar.html
 * and the Task Manager's drawer (/v2/tasks.html).
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
    await tm.close();
  } catch (err) {
    R.ok('suite ran without throwing', false, err && err.stack);
  } finally {
    await suite.close();
  }
  const out = R.summary();
  process.exit(out.fail ? 1 : 0);
})();
