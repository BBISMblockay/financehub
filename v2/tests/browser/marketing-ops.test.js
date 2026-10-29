/* /v2/marketing-ops.html — the real page, a fake Supabase.
 *
 * This is the integrated call path, not the helpers: the page boots on its
 * own Supabase reads, and what is asserted is what it WRITES (recorded
 * queries) as well as what it shows.
 *
 * The page carried the separate test record until 2026-10-29 (Tests and
 * Learnings tabs over `marketing_tests`). Those tabs were removed: a test is a
 * stage of an idea in the Ad Studio idea bank (`ad_ideas.status = 'testing'`
 * with `testing_element`), and its result is read off the ads the idea is
 * linked to. What is left is the schedule, and what this suite proves:
 *
 *   1. it boots and reads only what it needs: the Launch calendar's own
 *      `launch_channel_items`, plus the launches to attach one to
 *   2. it does NOT read or write `marketing_test_id`. The column was not
 *      dropped, and a payload that sent it as null would unlink a row that
 *      had one the next time anybody edited it -- a silent loss on a surface
 *      that no longer shows the link
 *   3. a scheduled item needs a name, and a javascript: URL is refused before
 *      any write
 *   4. the insert carries company_entity_id and created_by, and an untouched
 *      text box is written as null, never as an empty string
 *   5. a stored <img onerror> in a title renders as text, not as an element
 *   6. the four KPIs count what their labels say, "still open" included
 *   7. the default view is what is still ahead; the filters reach the rest
 *   8. the Ad Studio strip mounts on the page, with this page as the current
 *      tab, so a page with no sidebar row of its own is still escapable
 *   9. a link into the retired test record says where that record went
 */
'use strict';

const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('marketing-ops');

// Dates are built relative to today, because three of the four KPIs and the
// default filter are "ahead of now": a fixture pinned to a calendar date
// starts passing or failing on its own as the clock moves past it.
const iso = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const ITEMS = [
  {
    // Past and still open: overdue, and behind the default filter.
    id: 'i-past', launch_id: null, company_entity_id: 'test-company', channel: 'email',
    item_title: '9am send', item_type: 'campaign', scheduled_date: iso(-9),
    scheduled_time: '09:00:00', time_zone: 'America/Los_Angeles', status: 'scheduled',
    priority: 'normal', owner: 'Sammie', copy_needed: false, creative_needed: true,
    link_url: null, notes: null,
  },
  {
    // Inside the next 7 days, attached to a launch, needs copy.
    id: 'i-soon', launch_id: 'l-1', company_entity_id: 'test-company', channel: 'meta',
    item_title: 'Opening day static', item_type: 'static', scheduled_date: iso(3),
    scheduled_time: null, time_zone: null, status: 'planned',
    priority: 'high', owner: 'Benny', copy_needed: true, creative_needed: false,
    link_url: 'https://example.com/brief', notes: null,
  },
  {
    // Undated and open: work that has not been placed yet, which must ride
    // with "upcoming" rather than disappear.
    id: 'i-undated', launch_id: null, company_entity_id: 'test-company', channel: 'organic',
    item_title: '<img src=x onerror="window.__XSS__=1">', item_type: null, scheduled_date: null,
    scheduled_time: null, time_zone: null, status: 'planned',
    priority: 'low', owner: null, copy_needed: true, creative_needed: true,
    link_url: 'javascript:alert(1)', notes: 'Quote "test" & <angles>.',
  },
  {
    // Past, and finished: not overdue, and never in "needs" either.
    id: 'i-done', launch_id: null, company_entity_id: 'test-company', channel: 'sms',
    item_title: 'Flash sale blast', item_type: 'sms', scheduled_date: iso(-2),
    scheduled_time: null, time_zone: null, status: 'done',
    priority: 'normal', owner: 'Sammie', copy_needed: true, creative_needed: true,
    link_url: null, notes: null,
  },
];

const TABLES = {
  launch_channel_items: ITEMS,
  launch_calendar: [{ id: 'l-1', title: 'Opening Day', launch_date: iso(20), company_entity_id: 'test-company' }],
  profiles: [{ id: 'test-user', role: 'admin' }],
};

// Booted once the schedule has rendered a row (or said it could not).
const READY = () => {
  const b = document.getElementById('itemsTbody');
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
    const page = await suite.open('/v2/marketing-ops.html?tab=learnings', TABLES, { ready: READY, dialogAction: 'accept' });

    // ── 1 + 2. Boot and reads ────────────────────────────────────────────
    const read = await reads(page);
    R.test('the page reads the schedule SILO already has, and nothing it dropped', () => {
      const items = read.find((r) => r.table === 'launch_channel_items');
      R.truthy(items, 'launch_channel_items was read');
      R.has(items.columns, 'scheduled_time', 'the time, not only the date');
      R.has(items.columns, 'copy_needed', 'and what an item still needs');
      R.not(items.columns, 'marketing_test_id',
        'the retired test link is not read; the column survives on rows that have one');
      R.truthy(read.some((r) => r.table === 'launch_calendar'), 'the launches to attach an item to');
      // The chrome's own grant reads (entity_memberships, seo_approvers and
      // friends) ride along on every Pattern 1 page, so what is asserted is
      // the absence of the page's retired reads, not the whole set.
      const tables = [...new Set(read.map((r) => r.table))];
      for (const gone of ['marketing_tests', 'ad_ideas', 'marketing_schedule', 'marketing_queue']) {
        R.eq(tables.includes(gone), false, `${gone} is still read`);
      }
    });

    // ── 9. The old link into the test record ─────────────────────────────
    // The page was opened on ?tab=learnings, which used to be a tab here.
    R.test('a link into the retired test record says where it went', async () => {
      R.has(await statusText(page), 'idea bank', 'it names the Ad Studio idea bank');
    });

    // ── 6. The KPIs ──────────────────────────────────────────────────────
    const kpi = (id) => page.textContent('#' + id);
    R.test('each KPI counts what its label says', async () => {});
    R.eq(await kpi('kpiScheduled'), '1', 'next 7 days: the one dated inside the window');
    R.eq(await kpi('kpiNeeds'), '3', 'needs copy or creative: the three still open, not the finished one');
    R.eq(await kpi('kpiUndated'), '1', 'no date yet: the undated open item');
    R.eq(await kpi('kpiOverdue'), '1', 'past, still open: the scheduled one, never the done one');

    // ── 5 + 7. What the default view shows ───────────────────────────────
    const table = () => page.textContent('#itemsTbody');
    R.test('the default view is what is still ahead, undated work included', async () => {
      const t = await table();
      R.has(t, 'Opening day static', 'the item inside the window');
      R.has(t, 'Opening Day', 'with the launch it is attached to');
      R.has(t, 'Benny', 'and its owner');
      R.not(t, '9am send', 'a past item is behind the default filter');
      R.has(t, '<img src=x onerror=', 'the undated item rides with upcoming');
    });
    R.test('a stored <img onerror> title is text, not an element', async () => {
      R.eq(await page.evaluate(() => window.__XSS__ || null), null, 'no injected handler ran');
      R.eq(await page.evaluate(() => document.querySelectorAll('#itemsTbody img').length), 0,
        'no image element came from a title');
    });
    R.test('a stored javascript: link never becomes an anchor', async () => {
      R.eq(await page.evaluate(() => [...document.querySelectorAll('#itemsTbody a')]
        .filter((a) => /^javascript:/i.test(a.getAttribute('href') || '')).length), 0);
      R.eq(await page.evaluate(() => [...document.querySelectorAll('#itemsTbody a')]
        .some((a) => a.getAttribute('href') === 'https://example.com/brief')), true,
        'an http(s) link is still a link');
    });

    await page.selectOption('#fItemWhen', '');
    await page.waitForFunction(() => /9am send/.test(document.getElementById('itemsTbody').textContent));
    R.test('"everything" reaches the past, with the time it went out', async () => {
      R.has(await table(), '09:00', 'the time is shown');
      R.has(await table(), 'Flash sale blast', 'and a finished item is still findable');
    });

    await page.selectOption('#fItemStatus', 'done');
    await page.waitForFunction(() => !/9am send/.test(document.getElementById('itemsTbody').textContent));
    R.test('the status filter narrows to one status, and only that one', async () => {
      R.has(await table(), 'Flash sale blast');
      R.not(await table(), 'Opening day static');
    });
    await page.selectOption('#fItemStatus', '');
    await page.selectOption('#fItemChannel', 'sms');
    await page.waitForFunction(() => !/Opening day static/.test(document.getElementById('itemsTbody').textContent));
    R.test('and so does the channel filter', async () => {
      R.has(await table(), 'Flash sale blast');
    });
    await page.selectOption('#fItemChannel', '');
    await page.fill('#fItemSearch', 'zzz-nothing');
    await page.waitForFunction(() => /No item matches/.test(document.getElementById('itemsTbody').textContent));
    R.test('an empty result says the filters hid it, not that nothing is scheduled', async () => {
      R.has(await table(), 'No item matches these filters.');
    });
    await page.fill('#fItemSearch', '');

    // ── 3 + 4. The write ─────────────────────────────────────────────────
    await page.click('#btnNewItem');
    await page.waitForFunction(() => document.getElementById('itemDrawer').classList.contains('open'));
    await page.click('#itemSave');
    await page.waitForTimeout(120);
    R.eq((await writes(page, 'launch_channel_items')).length, 0, 'no write without a name');
    R.has(await statusText(page), 'needs a name', 'and the refusal says which box');

    await page.fill('#iTitle', 'Reel — teaser');
    await page.selectOption('#iChannel', 'organic');
    await page.fill('#iDate', iso(5));
    await page.fill('#iLink', 'javascript:alert(1)');
    await page.click('#itemSave');
    await page.waitForTimeout(120);
    R.eq((await writes(page, 'launch_channel_items')).length, 0, 'a javascript: link is refused before any write');
    R.has(await statusText(page), 'http://', 'and the refusal says what a link must look like');

    await page.fill('#iLink', 'https://example.com/post');
    await page.check('#iCreative');
    await page.click('#itemSave');
    await page.waitForFunction(() => !document.getElementById('itemDrawer').classList.contains('open'));
    const itemWrites = (await writes(page, 'launch_channel_items')).filter((w) => w.op === 'insert');
    R.eq(itemWrites.length, 1, 'one item insert');
    const body = Array.isArray(itemWrites[0].body) ? itemWrites[0].body[0] : itemWrites[0].body;
    R.test('the item is written to the schedule that already exists', () => {
      R.eq(body.item_title, 'Reel — teaser');
      R.eq(body.launch_id, null, 'no launch: an item does not need one');
      R.eq(body.company_entity_id, 'test-company');
      R.eq(body.created_by, 'test-user', 'created_by is the session user, which the policy requires');
      R.eq(body.link_url, 'https://example.com/post');
      R.eq(body.creative_needed, true);
      R.eq(body.copy_needed, false, 'an unticked box is false, not absent');
    });
    R.test('an untouched text box is null, never an empty string', () => {
      R.eq(body.item_type, null);
      R.eq(body.owner, null);
      R.eq(body.notes, null);
      R.eq(body.scheduled_time, null, 'a date with no time is a date');
    });
    R.test('and the retired test link is not in the payload at all', () => {
      R.eq('marketing_test_id' in body, false,
        'sending it would null a surviving link on the next edit');
    });

    // An edit of an existing row is the dangerous one: the patch is what would
    // overwrite a link the page no longer shows.
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('#itemsTbody [data-item]'))
        .find((b) => b.dataset.item === 'i-soon').click();
    });
    await page.waitForFunction(() => document.getElementById('itemDrawer').classList.contains('open'));
    R.eq(await page.inputValue('#iTitle'), 'Opening day static', 'the drawer opens the row it was asked for');
    R.eq(await page.evaluate(() => document.getElementById('iLaunchSel').value), 'l-1',
      'with the launch it is attached to');
    await page.selectOption('#iStatus', 'live');
    await page.click('#itemSave');
    await page.waitForFunction(() => !document.getElementById('itemDrawer').classList.contains('open'));
    const patch = (await writes(page, 'launch_channel_items')).filter((w) => w.op === 'update').pop().body;
    R.test('an edit sends the change and leaves the retired link alone', () => {
      R.eq(patch.status, 'live', 'the status change');
      R.eq(patch.launch_id, 'l-1', 'the launch it keeps');
      R.eq('marketing_test_id' in patch, false, 'and nothing that would unlink a test');
    });

    // ── 8. The Ad Studio strip, on the real page ────────────────────────
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
            text: a.textContent.trim(),
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
      R.has(strip.links[1].text, 'Schedule', 'and it is named for what it now holds');
    });

    await page.close();
  } catch (err) {
    R.ok('suite ran without throwing', false, err && err.stack);
  } finally {
    await suite.close();
  }
  const out = R.summary();
  process.exit(out.fail ? 1 : 0);
})();
