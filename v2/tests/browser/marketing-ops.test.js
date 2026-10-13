/* /v2/marketing-ops.html — the real page, a fake Supabase.
 *
 * This is the integrated call path, not the helpers: the page boots on its
 * own Supabase reads, and what is asserted is what it WRITES (recorded
 * queries) as well as what it shows.
 *
 *   1. it boots and reads both tables, asking the schedule for
 *      marketing_test_id (without that column the Test column is always empty
 *      and nothing says why)
 *   2. a test is not written until it has a title and a hypothesis
 *   3. concluding is refused, with no write, until an outcome AND a learning
 *      are recorded -- the same rule the database CHECK enforces
 *   4. an outcome cannot be filed on a test that has not concluded
 *   5. the insert carries company_entity_id and created_by, and an untouched
 *      read box is written as null, never 0
 *   6. a started test's frozen fields are disabled AND left out of the patch,
 *      so a disabled input can never be the thing that breaks a save
 *   7. a scheduled item is written to launch_channel_items (the Launch
 *      calendar's own table) with its test link, and a javascript: URL is
 *      refused before any write
 *   8. a stored <img onerror> in a title renders as text, not as an element
 *   9. the Ad Studio strip mounts on the page, with this page as the current
 *      tab, so a page with no sidebar row of its own is still escapable
 *  10. the Learnings tab shows concluded tests only, grouped by what varied,
 *      with the two readings as recorded (a missing one is "not measured",
 *      never 0) and nothing computed from them
 */
'use strict';

const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('marketing-ops');

const TESTS = [
  {
    id: 't-planned', company_entity_id: 'test-company', title: 'Hook test',
    channel: 'meta', element: 'creative', hypothesis: 'A player in frame lowers CPA.',
    control: 'current best', variant: 'founder cut', metric: 'cpa', metric_note: 'Purchase workspace',
    starts_on: null, ends_on: null, status: 'planned', outcome: null,
    control_value: null, variant_value: null, result_summary: null,
    launch_id: null, ad_idea_id: null, notes: null,
    created_by: 'test-user', created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z',
    concluded_by: null, concluded_at: null, started_at: null,
  },
  {
    id: 't-running', company_entity_id: 'test-company', title: 'Send time test',
    channel: 'email', element: 'send_time', hypothesis: 'A 9am send beats 6pm on opens.',
    control: '6pm', variant: '9am', metric: 'open_rate', metric_note: 'Email + SMS workspace',
    starts_on: '2026-10-01', ends_on: '2026-10-14', status: 'running', outcome: null,
    control_value: null, variant_value: null, result_summary: null,
    launch_id: null, ad_idea_id: null, notes: null,
    created_by: 'test-user', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
    concluded_by: null, concluded_at: null, started_at: '2026-10-01T00:00:00Z',
  },
  {
    // Moved back to `planned` after running. The database keeps it frozen
    // (started_at survives), so the drawer must too -- otherwise the page
    // offers edits the save will be refused for.
    id: 't-rewound', company_entity_id: 'test-company', title: 'Rewound test',
    channel: 'meta', element: 'audience', hypothesis: 'Broad beats interest stacks.',
    control: 'interest stack', variant: 'broad', metric: 'cpa', metric_note: null,
    starts_on: '2026-09-20', ends_on: null, status: 'planned', outcome: null,
    control_value: null, variant_value: null, result_summary: null,
    launch_id: null, ad_idea_id: null, notes: null,
    created_by: 'test-user', created_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-25T00:00:00Z',
    concluded_by: null, concluded_at: null, started_at: '2026-09-20T00:00:00Z',
  },
  {
    // A stored title that would run if the page interpolated it unescaped.
    id: 't-xss', company_entity_id: 'test-company', title: '<img src=x onerror="window.__XSS__=1">',
    channel: 'organic', element: 'copy', hypothesis: 'Quote "test" & <angles>.',
    control: null, variant: null, metric: 'ctr', metric_note: null,
    starts_on: '2026-09-01', ends_on: '2026-09-08', status: 'concluded', outcome: 'inconclusive',
    control_value: null, variant_value: null, result_summary: 'Not enough volume.',
    launch_id: null, ad_idea_id: null, notes: null,
    created_by: 'test-user', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-09T00:00:00Z',
    concluded_by: 'test-user', concluded_at: '2026-09-09T00:00:00Z', started_at: '2026-09-01T00:00:00Z',
  },
];

const WIN = {
  // A concluded win with both readings, in a different element from the
  // concluded test above, so Learnings has two groups and a count to get
  // wrong.
  id: 't-win', company_entity_id: 'test-company', title: 'Free shipping over $75',
  channel: 'meta', element: 'offer', hypothesis: 'A shipping threshold beats a percentage off.',
  control: '15% off', variant: 'free shipping over $75', metric: 'cvr',
  metric_note: 'Purchase workspace', starts_on: '2026-09-10', ends_on: '2026-09-24',
  status: 'concluded', outcome: 'win', control_value: 2.1, variant_value: 2.9,
  result_summary: 'Threshold won on CVR and on AOV. Keep it for sitewide sales.',
  launch_id: null, ad_idea_id: null, notes: null,
  created_by: 'test-user', created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-25T00:00:00Z',
  concluded_by: 'test-user', concluded_at: '2026-09-25T00:00:00Z', started_at: '2026-09-10T00:00:00Z',
};
TESTS.push(WIN);

const ITEMS = [
  {
    id: 'i-1', launch_id: null, company_entity_id: 'test-company', channel: 'email',
    item_title: '9am send', item_type: 'campaign', scheduled_date: '2026-10-02',
    scheduled_time: '09:00:00', time_zone: 'America/Los_Angeles', status: 'scheduled',
    priority: 'normal', owner: 'Sammie', copy_needed: false, creative_needed: true,
    link_url: null, notes: null, marketing_test_id: 't-running',
  },
];

const TABLES = {
  marketing_tests: TESTS,
  launch_channel_items: ITEMS,
  launch_calendar: [{ id: 'l-1', title: 'Opening Day', launch_date: '2026-10-20', company_entity_id: 'test-company' }],
  ad_ideas: [{ id: 'a-1', title: 'Founder story', status: 'approved', company_entity_id: 'test-company', updated_at: '2026-10-01' }],
  profiles: [{ id: 'test-user', role: 'admin' }],
};

// Booted once the tests table has rendered a row (or said it could not).
const READY = () => {
  const b = document.getElementById('testsTbody');
  return !!b && !/Loading…/.test(b.textContent);
};

const writes = (page, table) => page.evaluate((t) => (window.__QUERIES__ || [])
  .filter((q) => q.table === t && (q._op === 'insert' || q._op === 'update'))
  .map((q) => ({ op: q._op, body: q._op === 'insert' ? q.rows : q.patch })), table);

const reads = (page) => page.evaluate(() => (window.__QUERIES__ || [])
  .filter((q) => q._op === 'select')
  .map((q) => ({ table: q.table, columns: q.columns })));

const statusText = (page) => page.textContent('#status');

(async () => {
  const suite = await startSuite();
  try {
    const page = await suite.open('/v2/marketing-ops.html', TABLES, { ready: READY, dialogAction: 'accept' });

    // ── 1. Boot and reads ────────────────────────────────────────────────
    const read = await reads(page);
    R.test('the page reads both of its tables on boot', () => {
      R.truthy(read.some((r) => r.table === 'marketing_tests'), 'marketing_tests was read');
      const items = read.find((r) => r.table === 'launch_channel_items');
      R.truthy(items, 'launch_channel_items was read');
      R.has(items.columns, 'marketing_test_id', 'the schedule read asks for the test link');
      R.has(items.columns, 'scheduled_time', 'and for the time, not only the date');
    });
    R.test('it reads the schedule SILO already has, and creates no table of its own', () => {
      R.not(read.map((r) => r.table).join(','), 'marketing_schedule');
      R.not(read.map((r) => r.table).join(','), 'marketing_queue');
    });

    // ── 8. Escaping. The concluded row is hidden by the default "open"
    // filter, so show every status first -- and leave it there, since the
    // steps below address rows by id rather than by position.
    await page.selectOption('#fTestStatus', '');
    await page.waitForFunction(() => /onerror/.test(document.getElementById('testsTbody').textContent));
    R.test('a stored <img onerror> title is text, not an element', async () => {
      R.eq(await page.evaluate(() => window.__XSS__ || null), null, 'no injected handler ran');
    });
    R.eq(await page.evaluate(() => document.querySelectorAll('#testsTbody img').length), 0,
      'no image element came from a title');
    R.test('and its characters survive as characters', async () => {});
    R.has(await page.textContent('#testsTbody'), '<img src=x onerror=', 'the title is shown verbatim');

    // ── 2. A test needs a title and a hypothesis ─────────────────────────
    await page.click('#btnNewTest');
    await page.click('#testSave');
    await page.waitForTimeout(120);
    R.eq((await writes(page, 'marketing_tests')).length, 0, 'no write without a title');
    R.has(await statusText(page), 'needs a title', 'the refusal names the missing box');

    await page.fill('#tTitle', 'Offer test — free shipping');
    await page.click('#testSave');
    await page.waitForTimeout(120);
    R.eq((await writes(page, 'marketing_tests')).length, 0, 'no write without a hypothesis');
    R.has(await statusText(page), 'hypothesis', 'the refusal names the hypothesis');

    // ── 3 + 4. Concluding, and an outcome out of place ───────────────────
    // A started test needs a start date, and that is reported first, because
    // it is the earlier of the two things missing. The database carries both
    // rules as CHECKs, so the order here is only which one the person is
    // asked to fix first.
    await page.fill('#tHypothesis', 'Free shipping over $75 lifts conversion rate.');
    await page.selectOption('#tStatus', 'concluded');
    await page.click('#testSave');
    await page.waitForTimeout(120);
    R.eq((await writes(page, 'marketing_tests')).length, 0, 'no write for a started test with no start date');
    R.has(await statusText(page), 'start date', 'the refusal names the start date');

    await page.fill('#tStart', '2026-10-05');
    await page.click('#testSave');
    await page.waitForTimeout(120);
    R.eq((await writes(page, 'marketing_tests')).length, 0, 'no write concluding with nothing recorded');
    R.has(await statusText(page), 'what you learned', 'the refusal asks for the outcome and the learning');

    await page.selectOption('#tOutcome', 'win');
    await page.click('#testSave');
    await page.waitForTimeout(120);
    R.eq((await writes(page, 'marketing_tests')).length, 0, 'an outcome alone is still not a conclusion');

    await page.selectOption('#tStatus', 'running');
    await page.click('#testSave');
    await page.waitForTimeout(120);
    R.eq((await writes(page, 'marketing_tests')).length, 0, 'an outcome on a running test is refused');
    R.has(await statusText(page), 'belongs to a concluded test', 'and says why');

    // A typed read that is not a number is refused, rather than being sent as
    // NaN or quietly becoming 0.
    await page.selectOption('#tOutcome', '');
    await page.fill('#tControlValue', 'about two');
    await page.click('#testSave');
    await page.waitForTimeout(120);
    R.eq((await writes(page, 'marketing_tests')).length, 0, 'a non-numeric read is refused');
    R.has(await statusText(page), 'must be a number', 'and says so');
    await page.fill('#tControlValue', '');

    // ── 5. The insert ────────────────────────────────────────────────────
    await page.selectOption('#tStatus', 'planned');
    await page.fill('#tStart', '');
    await page.selectOption('#tChannel', 'email');
    await page.selectOption('#tElement', 'offer');
    await page.selectOption('#tMetric', 'cvr');
    await page.fill('#tControl', 'standard shipping');
    await page.fill('#tVariant', 'free over $75');
    await page.click('#testSave');
    await page.waitForFunction(() => !document.getElementById('testDrawer').classList.contains('open'));
    const inserted = (await writes(page, 'marketing_tests')).filter((w) => w.op === 'insert');
    R.eq(inserted.length, 1, 'exactly one insert');
    const body = Array.isArray(inserted[0].body) ? inserted[0].body[0] : inserted[0].body;
    R.test('the insert carries the company and the real author', () => {
      R.eq(body.company_entity_id, 'test-company', 'company_entity_id');
      R.eq(body.created_by, 'test-user', 'created_by is the session user, which the policy requires');
    });
    R.test('an untouched read box is null, never 0', () => {
      R.eq(body.control_value, null, 'control_value');
      R.eq(body.variant_value, null, 'variant_value');
      R.eq(body.metric_note, null, 'an empty text box is null too');
      R.eq(body.outcome, null, 'no outcome on a planned test');
    });
    R.test('and the design fields are the ones chosen', () => {
      R.eq(body.channel, 'email');
      R.eq(body.element, 'offer');
      R.eq(body.metric, 'cvr');
      R.eq(body.status, 'planned');
    });

    // ── 6. A started test's frozen fields ────────────────────────────────
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('#testsTbody [data-test]'))
        .find((b) => b.dataset.test === 't-running');
      btn.click();
    });
    await page.waitForFunction(() => document.getElementById('testDrawer').classList.contains('open'));
    R.test('the frozen inputs are disabled, and the reason is on screen', async () => {});
    for (const id of ['tHypothesis', 'tElement', 'tControl', 'tVariant', 'tMetric']) {
      R.ok(`${id} is disabled on a running test`,
        await page.$eval('#' + id, (e) => e.disabled));
    }
    R.ok('the frozen note is visible', !(await page.$eval('#tFrozenNote', (e) => e.hidden)));
    R.ok('the hypothesis is still readable while frozen',
      (await page.$eval('#tHypothesis', (e) => e.value)).includes('9am send beats'));

    await page.fill('#tEnd', '2026-10-21');
    await page.fill('#tControlValue', '18.4');
    await page.click('#testSave');
    await page.waitForFunction(() => !document.getElementById('testDrawer').classList.contains('open'));
    const patches = (await writes(page, 'marketing_tests')).filter((w) => w.op === 'update');
    R.eq(patches.length, 1, 'one update');
    const patch = patches[0].body;
    R.test('the patch leaves out every frozen field', () => {
      for (const k of ['hypothesis', 'element', 'control', 'variant', 'metric']) {
        R.ok(`${k} is not sent`, !(k in patch), `patch: ${JSON.stringify(patch)}`);
      }
    });
    R.test('and sends what a running test may still change', () => {
      R.eq(patch.ends_on, '2026-10-21', 'the window');
      R.eq(patch.control_value, 18.4, 'the recorded read, as a number');
      R.eq(patch.variant_value, null, 'the unmeasured one stays null');
    });

    // A test that RAN and was moved back to Planned stays frozen: the database
    // reads started_at, which it never clears, so the drawer must not offer an
    // edit the save would be refused for.
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('#testsTbody [data-test]'))
        .find((b) => b.dataset.test === 't-rewound').click();
    });
    await page.waitForFunction(() => document.getElementById('testDrawer').classList.contains('open'));
    R.ok('a test rewound to Planned keeps its design frozen',
      await page.$eval('#tMetric', (e) => e.disabled));
    R.ok('and says the freeze survives the rewind',
      /back to Planned does not reopen them/.test(await page.textContent('#tFrozenNote')));
    await page.click('#testCancel');

    // A test that has NEVER run is still fully editable, frozen fields included.
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('#testsTbody [data-test]'))
        .find((b) => b.dataset.test === 't-planned').click();
    });
    await page.waitForFunction(() => document.getElementById('testDrawer').classList.contains('open'));
    R.ok('a planned test keeps its design editable',
      !(await page.$eval('#tMetric', (e) => e.disabled)));
    await page.selectOption('#tMetric', 'roas');
    await page.click('#testSave');
    await page.waitForFunction(() => !document.getElementById('testDrawer').classList.contains('open'));
    const plannedPatch = (await writes(page, 'marketing_tests')).filter((w) => w.op === 'update').pop().body;
    R.eq(plannedPatch.metric, 'roas', 'the metric change is sent for a planned test');

    // ── 7. The scheduled item ────────────────────────────────────────────
    await page.click('#btnNewItem');
    await page.waitForFunction(() => document.getElementById('itemDrawer').classList.contains('open'));
    await page.fill('#iTitle', 'Reel — teaser');
    await page.selectOption('#iChannel', 'organic');
    await page.fill('#iDate', '2026-10-18');
    await page.fill('#iLink', 'javascript:alert(1)');
    await page.click('#itemSave');
    await page.waitForTimeout(120);
    R.eq((await writes(page, 'launch_channel_items')).length, 0, 'a javascript: link is refused before any write');
    R.has(await statusText(page), 'http://', 'and the refusal says what a link must look like');

    await page.fill('#iLink', 'https://example.com/post');
    await page.selectOption('#iTestSel', 't-planned');
    await page.click('#itemSave');
    await page.waitForFunction(() => !document.getElementById('itemDrawer').classList.contains('open'));
    const itemWrites = (await writes(page, 'launch_channel_items')).filter((w) => w.op === 'insert');
    R.eq(itemWrites.length, 1, 'one item insert');
    const ibody = Array.isArray(itemWrites[0].body) ? itemWrites[0].body[0] : itemWrites[0].body;
    R.test('the item is written to the schedule that already exists, linked to its test', () => {
      R.eq(ibody.item_title, 'Reel — teaser');
      R.eq(ibody.marketing_test_id, 't-planned', 'the test link');
      R.eq(ibody.launch_id, null, 'no launch: an item does not need one');
      R.eq(ibody.company_entity_id, 'test-company');
      R.eq(ibody.created_by, 'test-user');
      R.eq(ibody.link_url, 'https://example.com/post');
    });

    // The schedule tab defaults to what is still ahead, so an item whose date
    // has passed is behind the filter rather than at the top of the list.
    await page.click('#tabQueue');
    R.not(await page.textContent('#itemsTbody'), '9am send',
      'a past item is not in the default upcoming view');
    // (The fixture layer records the insert rather than storing it, so the
    // item just written is not expected back in the list here. What it wrote
    // is asserted above, from the recorded query.)

    await page.selectOption('#fItemWhen', '');
    await page.waitForFunction(() => /9am send/.test(document.getElementById('itemsTbody').textContent));
    const queueText = await page.textContent('#itemsTbody');
    R.has(queueText, 'Send time test', 'the test an item belongs to is named');
    R.has(queueText, '09:00', 'with the time it goes out');
    R.has(queueText, 'Sammie', 'and its owner');

    // Filtering by test reaches the schedule through the link column.
    await page.selectOption('#fItemTest', 't-running');
    await page.waitForFunction(() => !/Reel/.test(document.getElementById('itemsTbody').textContent));
    R.has(await page.textContent('#itemsTbody'), '9am send', 'the running test\'s item');
    await page.selectOption('#fItemTest', '__none__');
    await page.waitForFunction(() => !/9am send/.test(document.getElementById('itemsTbody').textContent));
    R.ok('"not part of a test" excludes linked items', true);

    // ── 9. The Ad Studio strip, on the real page ────────────────────────
    // The page has no sidebar row of its own any more, so the strip IS the way
    // back to Ad Studio. The harness has no active company, which is the paint
    // where resolveNavProfile answers 'standard' -- and the tab being viewed
    // has to be in its own strip even then.
    R.test('the Ad Studio strip mounts, with this page as the current tab', async () => {
      const strip = await page.evaluate(() => {
        const nav = document.querySelector('.ads-suite-nav');
        if (!nav) return null;
        return {
          links: [...nav.querySelectorAll('a')].map((a) => ({
            href: a.getAttribute('href'),
            current: a.getAttribute('aria-current') === 'page',
          })),
          imgs: nav.querySelectorAll('img').length,
        };
      });
      R.truthy(strip, 'the strip is on the page');
      R.eq(strip.imgs, 0, 'the strip draws inline SVG, not remote images');
      R.eq(strip.links.length, 2, 'Ad Studio and this page');
      R.eq(strip.links[0].href, '/v2/ad-studio.html', 'the way back to Ad Studio');
      R.eq(strip.links[1].href, '/v2/marketing-ops.html');
      R.eq(strip.links[1].current, true, 'this page is the current tab');
    });

    // ── 10. Learnings ───────────────────────────────────────────────────
    await page.click('#tabLearn');
    await page.waitForFunction(() => /Free shipping over/.test(document.getElementById('learnBody').textContent));
    const learn = await page.textContent('#learnBody');
    R.test('Learnings holds the concluded tests, and only those', () => {
      R.has(learn, 'Free shipping over $75', 'the concluded win');
      R.has(learn, 'Threshold won on CVR', 'with what was learned');
      R.not(learn, 'Send time test', 'a running test is not a learning');
      R.not(learn, 'Rewound test', 'nor is a plan that never concluded');
    });
    R.test('it groups by what varied, and counts the wins in each group', () => {
      R.has(learn, 'Offer', 'the element is the group heading');
      R.has(learn, '1 concluded · 1 won', 'the group says how many won');
    });
    R.test('both readings are shown as recorded, and a missing pair is named as missing', () => {
      R.has(learn, '2.1 → 2.9', 'the two values a person recorded');
      R.not(learn, '38', 'no lift, ratio or percentage is computed from them');
      R.has(learn, 'no reading recorded', 'the concluded test with no values says so');
      R.not(learn, '0 → 0', 'a missing reading is never shown as zero');
    });
    R.test('a stored <img onerror> is text here too', async () => {
      R.eq(await page.evaluate(() => window.__XSS__ || null), null, 'no injected handler ran');
      R.eq(await page.evaluate(() => document.querySelectorAll('#learnBody img').length), 0,
        'no image element came from a title');
    });

    // The outcome filter is how "what has ever won" is asked.
    await page.selectOption('#fLearnOutcome', 'win');
    await page.waitForFunction(() => !/Not enough volume/.test(document.getElementById('learnBody').textContent));
    R.has(await page.textContent('#learnBody'), 'Free shipping over $75', 'the win stays');
    await page.selectOption('#fLearnOutcome', 'loss');
    await page.waitForFunction(() => /No concluded test matches/.test(document.getElementById('learnBody').textContent));
    R.ok('with no losses recorded, the list says so rather than showing wins', true);

    // A card opens the test it describes, so a learning is one click from the
    // record behind it.
    await page.selectOption('#fLearnOutcome', '');
    await page.waitForFunction(() => /Free shipping over/.test(document.getElementById('learnBody').textContent));
    // By card, not by position: the groups follow ELEMENTS' own order, so the
    // first .mo-linkbtn on the page belongs to whichever element sorts first.
    await page.click('#learnBody .mo-learn-card:has-text("Free shipping over") .mo-linkbtn');
    await page.waitForFunction(() => document.getElementById('testDrawer').classList.contains('open'));
    R.eq(await page.inputValue('#tTitle'), 'Free shipping over $75', 'the card opened its own test');
    R.eq(await page.evaluate(() => document.getElementById('tMetric').disabled), true,
      'and it is frozen, as a concluded test must be');

    await page.close();
  } catch (err) {
    R.ok('suite ran without throwing', false, err && err.stack);
  } finally {
    await suite.close();
  }
  const out = R.summary();
  process.exit(out.fail ? 1 : 0);
})();
