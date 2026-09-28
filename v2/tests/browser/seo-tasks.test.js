/* The real /v2/seo-tasks.html with a fake Supabase: what an approver and a
 * drafter are each offered, and every write the page makes.
 *
 * What matters is what a person can DO and what reaches the database: approval
 * stamps who approved, a rejection carries its reason, a publication is only
 * recorded for an approved task and never with a future date, and a task that
 * went live cannot be edited from here. */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const R = createReporter('seo-tasks');

const CO = 'test-company';
const SITE = 'https://www.baseballism.com';
const XSS = '<img src=x onerror="window.__PWNED__=1">Evil';
const t = (o) => Object.assign({
  company_entity_id: CO, target_type: 'collection', rationale: 'Rank check 2026-09-26: #3.', proposed_title: null,
  proposed_meta_description: null, proposed_body: null, rejection_reason: null, approved_by: null, approved_at: null,
  current_revision_number: 0,
}, o);

const tables = {
  seo_tasks: [
    t({ id: 'draft-mine', title: 'Caps: add an introduction', approval_status: 'draft', created_by: 'test-user', created_at: '2026-09-27T10:00:00Z', target_url: `${SITE}/collections/caps` }),
    t({ id: 'waiting', title: 'Backpacks: say “Baseball Backpack” in the title ' + XSS, approval_status: 'proposed', created_by: 'sammie', created_at: '2026-09-28T10:00:00Z', target_url: `${SITE}/collections/backpacks`, proposed_title: 'Baseball Backpacks | Baseballism' }),
    t({ id: 'approved', title: 'Hoodies: shorter description', approval_status: 'approved', created_by: 'sammie', created_at: '2026-09-26T10:00:00Z', approved_by: 'test-user', approved_at: '2026-09-27T12:00:00Z', target_url: `${SITE}/collections/hoodies` }),
    t({ id: 'live', title: 'Tees: new title', approval_status: 'approved', created_by: 'sammie', created_at: '2026-09-01T10:00:00Z', approved_by: 'test-user', approved_at: '2026-09-02T12:00:00Z', target_url: `${SITE}/collections/tees` }),
  ],
  seo_task_publications: [{ id: 'p1', company_entity_id: CO, task_id: 'live', published_at: '2026-09-03T18:00:00Z', published_by: 'sammie', method: 'manual_confirmation', note: 'Shopify admin' }],
  profiles: [{ id: 'test-user', name: 'Blake Evetts' }, { id: 'sammie', name: 'Sammie Petitt' }],
};

const ready = () => !!document.querySelector('#list .st-task, #list .st-empty b');
const writes = (page, op) => page.evaluate((o) => window.__QUERIES__.filter((x) => x._op === o).map((x) => ({ table: x.table, rows: x.rows, patch: x.patch })), op);

(async () => {
  const suite = await startSuite();
  try {
    // ── An approver ──────────────────────────────────────────────────────
    let page = await suite.open('/v2/seo-tasks.html', tables, { ready, rpc: { can_approve_seo_tasks: true } });
    const tabs = await page.evaluate(() => [...document.querySelectorAll('[data-seo-suite] a')].map((a) => [a.getAttribute('href'), a.getAttribute('aria-current')]));
    R.eq(JSON.stringify(tabs.pop()), JSON.stringify(['/v2/seo-tasks.html', 'page']), 'Tasks is the current SEO tab');

    const titles = await page.evaluate(() => [...document.querySelectorAll('#list .st-title')].map((h) => h.textContent));
    R.eq(titles.length, 3, 'Open shows the three unpublished tasks');
    R.has(titles[0], 'Backpacks', 'the task waiting for approval comes first');
    R.ok('the published task is not in Open', !titles.some((x) => /Tees/.test(x)));
    R.ok('a hostile title renders as text', (await page.evaluate(() => window.__PWNED__)) === undefined);
    const list = await page.locator('#list').innerText();
    R.has(list, 'Drafted by Sammie Petitt');
    R.has(list, 'Baseball Backpacks | Baseballism', 'the proposed title is shown');
    R.has(list, 'Not written yet', 'an empty proposal reads as not written, never as blank');
    const studio = await page.locator('[data-task="waiting"] a[href*="seo-studio.html"]').getAttribute('href');
    R.eq(studio, '/v2/seo-studio.html?page=' + encodeURIComponent('page:/collections/backpacks'), 'each task links to its page in Studio');

    // Approve: stamps who.
    await page.click('[data-task="waiting"] [data-act="approve"]');
    await page.waitForFunction(() => window.__QUERIES__.some((x) => x._op === 'update'));
    let up = (await writes(page, 'update')).pop();
    R.eq(up.table, 'seo_tasks');
    R.eq(up.patch.approval_status, 'approved');
    R.eq(up.patch.approved_by, 'test-user', 'approval records who approved');

    // Reject: refused without a reason, then carries it.
    const before = (await writes(page, 'update')).length;
    await page.click('[data-task="waiting"] [data-act="reject"]');
    await page.click('#btnRejectSave');
    R.ok('no reason: the dialog stays open with an error', await page.evaluate(() => document.getElementById('dlgReject').open && !document.getElementById('rError').hidden));
    R.eq((await writes(page, 'update')).length, before, 'nothing written without a reason');
    await page.fill('#rReason', 'Keep the brand name first.');
    await page.click('#btnRejectSave');
    await page.waitForFunction(() => !document.getElementById('dlgReject').open);
    up = (await writes(page, 'update')).pop();
    R.eq(up.patch.approval_status, 'rejected');
    R.eq(up.patch.rejection_reason, 'Keep the brand name first.');

    // Publish: only offered on the approved task; a future date is refused.
    R.eq(await page.locator('[data-task="draft-mine"] [data-act="publish"]').count(), 0, 'a draft cannot be marked published');
    await page.click('[data-task="approved"] [data-act="publish"]');
    await page.fill('#pWhen', '2099-01-01T09:00');
    await page.click('#btnPublishSave');
    R.ok('a future date is refused', await page.evaluate(() => document.getElementById('dlgPublish').open && /never scheduled/.test(document.getElementById('pError').textContent)));
    R.eq((await writes(page, 'insert')).length, 0, 'nothing recorded for a future date');
    await page.fill('#pWhen', '2026-09-28T09:00');
    await page.fill('#pNote', 'Collection SEO settings');
    await page.click('#btnPublishSave');
    await page.waitForFunction(() => !document.getElementById('dlgPublish').open);
    const ins = (await writes(page, 'insert')).pop();
    R.eq(ins.table, 'seo_task_publications');
    R.eq(ins.rows.task_id, 'approved');
    R.eq(ins.rows.method, 'manual_confirmation');
    R.eq(ins.rows.published_by, 'test-user');
    R.eq(ins.rows.note, 'Collection SEO settings');

    // Edit: writes only the task's own fields.
    await page.click('[data-task="draft-mine"] [data-act="edit"]');
    await page.fill('#eSeoTitle', 'Baseball Caps | Baseballism');
    await page.click('#btnEditSave');
    await page.waitForFunction(() => !document.getElementById('dlgEdit').open);
    up = (await writes(page, 'update')).pop();
    R.eq(up.patch.proposed_title, 'Baseball Caps | Baseballism');
    R.ok('an edit never changes the approval status', !('approval_status' in up.patch) && !('approved_by' in up.patch));

    // Published: frozen, with its follow-up dates.
    await page.click('[data-filter="published"]');
    const pub = await page.locator('[data-task="live"]').innerText();
    R.has(pub, 'Live since');
    R.has(pub, '30 days on Oct 3, 2026');
    R.eq(await page.locator('[data-task="live"] [data-act]').count(), 0, 'a published task offers no actions');
    await page.close();

    // ── A drafter who cannot approve ─────────────────────────────────────
    page = await suite.open('/v2/seo-tasks.html', tables, { ready, rpc: { can_approve_seo_tasks: false } });
    R.eq(await page.locator('[data-act="approve"], [data-act="reject"]').count(), 0, 'no approval buttons for a non-approver');
    R.eq(await page.locator('[data-task="waiting"] [data-act]').count(), 0, 'someone else\'s task offers nothing to edit');
    R.eq(await page.locator('[data-task="draft-mine"] [data-act="submit"]').count(), 1, 'their own draft can be sent for approval');
    await page.click('[data-task="draft-mine"] [data-act="submit"]');
    await page.waitForFunction(() => window.__QUERIES__.some((x) => x._op === 'update'));
    up = (await writes(page, 'update')).pop();
    R.eq(up.patch.approval_status, 'proposed');
    R.eq(await page.locator('[data-task="approved"] [data-act="publish"]').count(), 1, 'anyone may record that an approved change went live');
  } finally {
    await suite.close();
  }
  const out = R.summary();
  process.exit(out.fail ? 1 : 0);
})();
