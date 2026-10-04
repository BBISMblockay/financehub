'use strict';
/* On Deck · transaction coding, on the real page with a fake database.
 *
 * Proves the approval-first contract in the browser: Review opens the actual
 * output (suggested accounts, the journal entry and its destination) before
 * anything consequential; every final button names its effect; the exact
 * reviewed hash is what is sent; approval in SILO is the finish line and
 * sending to QuickBooks is an optional, extra-effort step; repeated clicks send one request; a stale
 * approval, a missing input and an unknown posting outcome each end in a
 * specific, actionable receipt. Database enforcement of the same rules is in
 * scripts/tests/on-deck-coding-database.test.mjs. */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { startSuite, fakeSupabaseScript } = require('../lib/harness');

const company = 'test-company';
const HASH = 'a'.repeat(64);
const shots = path.resolve(__dirname, '../../../.screenshots'); fs.mkdirSync(shots, { recursive: true });

function item(over) {
  return Object.assign({ batch_id: 'b-code', label: 'September', source_name: 'Company card', status: 'draft',
    entry_date: '2026-09-30', period_start: '2026-09-01', period_end: '2026-09-30', txn_count: 3, uncoded_count: 2,
    excluded_count: 0, coded_amount: 0, open_suggestions: 2, suggested_amount: 142.1, low_confidence: 1, needs_judgment: 0,
    failed: 0, first_txn: '2026-09-02', last_txn: '2026-09-18', posting_enabled: true, posting_status: null,
    qbo_journal_entry_id: null, qbo_doc_number: null, approval_hash: null, approved_at: null, updated_at: '2026-10-01T12:00:00Z',
    account_mix: [{ account: 'Office supplies', count: 1, amount: 42.1 }, { account: 'Meals', count: 1, amount: 100 }],
    currency: 'USD', stage: 'code', stage_reason: null }, over);
}
const preview = (over) => Object.assign({ batch_id: 'b-approve', status: 'categorized', label: 'August', source_name: 'Company card',
  posting_enabled: true, entry_date: '2026-08-31', ready: true, blocker: null, hash: HASH, approval_version: 0,
  memo: 'SILO card coding · Company card · August',
  lines: [
    { posting_type: 'Debit', amount: 25, account_name: 'Office supplies', location_name: 'HQ', description: '2026-08-12 · OFFICE DEPOT' },
    { posting_type: 'Debit', amount: 10.5, account_name: 'Meals', description: '2026-08-14 · CAFE' },
    { posting_type: 'Credit', amount: 35.5, account_name: 'Company card', description: 'Company card August' }],
  debits: 35.5, credits: 35.5, destination: { company_name: 'Test Books', environment: 'production' },
  posting: null, facts: { first_txn: '2026-08-12', last_txn: '2026-08-14', coded: 2, excluded: 1, currency: 'USD' }, can_post: true }, over);

function tables(extra = {}) {
  return Object.assign({
    profiles: [{ id: 'test-user', email: 'fin@example.test', role: 'user', department: 'finance' }],
    entity_memberships: [{ entity_id: company, user_id: 'test-user', role: 'member' }],
    coding_items: [item(), item({ batch_id: 'b-approve', label: 'August', stage: 'approve', open_suggestions: 0, suggested_amount: 0,
      uncoded_count: 0, excluded_count: 1, coded_amount: 35.5, account_mix: [] }),
      item({ batch_id: 'b-stuck', label: 'July', stage: 'needs_input', stage_reason: 'uncoded_without_suggestion', open_suggestions: 0, uncoded_count: 4, account_mix: [] })],
    previews: { 'b-approve': preview() },
    card_transactions: [
      { id: 't1', company_entity_id: company, batch_id: 'b-code', txn_date: '2026-09-02', description: 'OFFICE DEPOT #221', clean_merchant: 'Office Depot', amount: 42.1, card_name: 'Supplies', status: 'uncoded', qbo_account_id: null },
      { id: 't2', company_entity_id: company, batch_id: 'b-code', txn_date: '2026-09-18', description: '<img src=x onerror="window.__XSS__=1">', clean_merchant: null, amount: 100, card_name: 'Travel', status: 'uncoded', qbo_account_id: null }],
    card_coding_suggestions_v: [
      { id: 's1', transaction_id: 't1', company_entity_id: company, review_status: 'open', outcome: 'suggested', qbo_account_id: 'supplies', qbo_account_name: 'Office supplies', qbo_location_name: 'HQ', confidence: 0.86, reasoning: 'Office supplies retailer.', evidence: 'CONSISTENT: 3 confirmed codings', history_status: 'consistent', stale_reason: null },
      { id: 's2', transaction_id: 't2', company_entity_id: company, review_status: 'open', outcome: 'suggested', qbo_account_id: 'meals', qbo_account_name: 'Meals', qbo_location_name: null, confidence: 0.41, reasoning: '<b>bold claim</b>', evidence: null, history_status: 'missing', stale_reason: null }],
  }, extra);
}
const advance = (batch, stage, patch = {}) => { const i = window.__FIXTURE_TABLES__.coding_items.find(x => x.batch_id === batch); Object.assign(i, { stage }, patch); };
const rpc = {
  on_deck_can_review: () => false,
  on_deck_coding_access: () => ({ review: true, post: true }),
  on_deck_coding_items: () => window.__FIXTURE_TABLES__.coding_items,
  card_import_batch_preview: (a) => window.__FIXTURE_TABLES__.previews[a.p_batch_id] || { __error: { message: 'Batch not found' } },
  accept_card_coding_suggestions: (a) => {
    window.__FIXTURE_TABLES__.card_coding_suggestions_v.forEach(s => { if (a.p_ids.includes(s.id)) s.review_status = 'accepted'; });
    return { accepted: a.p_ids.slice(0, 1).map(id => ({ id })), refused: a.p_ids.slice(1).map(id => ({ id, reason: 'facts_changed' })) };
  },
  approve_reviewed_card_import_batch: (a) => {
    const mode = window.__APPROVE_MODE__ || 'ok';
    if (mode === 'stale') return { __error: { message: 'This journal entry changed after you reviewed it.', code: '40001' } };
    const p = window.__FIXTURE_TABLES__.previews[a.p_batch_id]; p.status = 'approved'; p.approval_version = 1;
    const i = window.__FIXTURE_TABLES__.coding_items.find(x => x.batch_id === a.p_batch_id); Object.assign(i, { stage: 'approved', status: 'approved', approval_hash: a.p_expected_hash });
    return { id: a.p_batch_id, approval_hash: a.p_expected_hash, approval_version: 1 };
  },
};
// Two clicks in the same task: the second lands before the first request can
// resolve, which is exactly what a double click or an impatient retry does.
const doubleClick = (page, label) => page.evaluate(l => { const b = [...document.querySelectorAll('button')].find(x => x.textContent === l); b.click(); b.click(); }, label);
const calls = (page, name) => page.evaluate(n => window.__QUERIES__.filter(q => q.table === 'rpc:' + n), name);

(async () => {
  const suite = await startSuite({ secureContext: true });
  await suite.context.route('**/v2/lib/supabase-js.min.js', route => route.fulfill({ contentType: 'text/javascript', body: fakeSupabaseScript().replace('all = all(args) || [];', 'all = all(args);') }));
  // The posting function. Every request is recorded; the response is chosen per test.
  const posts = []; let postReply = { status: 200, body: { ok: true, qbo_journal_entry_id: '9001', doc_number: 'SILO-aaaa' } };
  await suite.context.route('**/functions/v1/quickbooks-post-journal', async route => {
    posts.push(JSON.parse(route.request().postData() || '{}'));
    await new Promise(r => setTimeout(r, 150)); // long enough for a second click to land
    route.fulfill({ status: postReply.status, contentType: 'application/json', body: JSON.stringify(postReply.body) });
  });
  let checks = 0;
  const test = async (name, fn) => { await fn(); console.log(`ok ${++checks} - ${name}`); };
  const ready = () => !!document.querySelector('#ready-cards .od-rcard, #after-cards .od-after') || /requires|not installed/.test(document.getElementById('status').textContent);
  const open = (t = tables(), extraRpc = {}) => suite.open('/v2/on-deck.html', t, { rpc: { ...rpc, ...extraRpc }, ready });
  try {
    let page = await open();
    await test('finance sees real coding cards; proposals, preparation and settings stay hidden', async () => {
      assert.equal(await page.locator('#ready-cards .od-rcard').count(), 2, 'the batch waiting only on the optional QuickBooks entry is a receipt');
      const code = page.locator('[data-batch=b-code]');
      assert.match(await code.textContent(), /Code 2 transactions/);
      assert.match(await code.locator('.od-rcard-figure').textContent(), /\$142\.10/);
      assert.match(await code.locator('.od-mix-legend').textContent(), /Office supplies1Meals1/);
      assert.match(await page.locator('[data-batch=b-stuck]').textContent(), /4 transactions need a person/);
      assert.equal(await page.locator('[data-batch=b-stuck] a').getAttribute('href'), '/v2/transactions.html?batch=b-stuck&company=test-company');
      assert.equal(await page.locator('#ready-count').textContent(), '1', 'only transactions waiting to be categorized count');
      assert.equal(await page.locator('#workspace').isHidden(), true);
      assert.equal(await page.locator('#prepare').isHidden(), true);
      assert.equal(await page.locator('#settings-link').isHidden(), true);
      assert.equal((await page.evaluate(() => window.__QUERIES__.filter(q => q.table === 'on_deck_proposals'))).length, 0);
      await page.screenshot({ path: path.join(shots, 'on-deck-coding-cards.png'), fullPage: true });
    });

    await test('Review opens the actual suggestions; low confidence starts unticked; untrusted text stays text', async () => {
      await page.locator('[data-batch=b-code] button').click();
      await page.waitForSelector('#coding-review .od-review-table');
      const rows = page.locator('#coding-review tbody tr');
      assert.equal(await rows.count(), 2);
      assert.equal(await rows.nth(0).locator('input').isChecked(), true);
      assert.equal(await rows.nth(1).locator('input').isChecked(), false, '41% confidence is left for a person');
      assert.match(await page.locator('.od-review-summary').textContent(), /1 of 2 selected · \$42\.10/);
      await rows.nth(1).getByText('Evidence').click();
      assert.match(await rows.nth(1).textContent(), /<b>bold claim<\/b>/);
      assert.equal(await page.evaluate(() => !!window.__XSS__), false);
      assert.equal(await page.locator('#coding-review img').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Save 1 categorization' }).isEnabled(), true);
      await page.screenshot({ path: path.join(shots, 'on-deck-coding-review.png'), fullPage: true });
    });

    await test('saving sends only the reviewed selection once and shows a receipt with refusals', async () => {
      await page.locator('#coding-review tbody tr').nth(1).locator('input').check();
      await doubleClick(page, 'Save 2 categorizations');
      await page.waitForSelector('.od-receipt');
      const sent = await calls(page, 'accept_card_coding_suggestions');
      assert.equal(sent.length, 1, 'one request despite two clicks'); assert.deepEqual(sent[0].args.p_ids.sort(), ['s1', 's2']);
      const receipt = await page.locator('.od-receipt').textContent();
      assert.match(receipt, /Saved 1 categorization/); assert.match(receipt, /1 not saved: the bank or card details changed/);
    });
    await page.close();

    page = await open();
    await test('a save is bound to the batch and selection at the click, even if the page changes while it waits', async () => {
      await page.locator('[data-batch=b-code] button').click();
      await page.waitForSelector('#coding-review .od-review-table');
      await page.locator('#coding-review tbody tr').nth(1).locator('input').check();
      // Hold the company check open so the request is in flight.
      await page.evaluate(() => { const c = window.__SILO_CONFIG__, orig = c.ensureActiveCompany.bind(c);
        c.ensureActiveCompany = (...a) => new Promise(r => setTimeout(() => r(orig(...a)), 400)); });
      await page.getByRole('button', { name: 'Save 2 categorizations' }).click();
      await page.locator('#coding-review tbody tr').nth(0).locator('input').uncheck().catch(() => {});
      await page.locator('#after-cards [data-batch=b-approve] button').click();
      assert.match(await page.locator('#status').textContent(), /Wait for the current action to finish/);
      await page.waitForSelector('.od-receipt');
      const sent = await calls(page, 'accept_card_coding_suggestions');
      assert.equal(sent.length, 1); assert.deepEqual(sent[0].args.p_ids.sort(), ['s1', 's2'], 'exactly what was selected at the click');
      assert.equal((await calls(page, 'card_import_batch_preview')).length, 0, 'the other batch never opened mid-save');
    });
    await page.close();

    {
      const t = tables();
      t.coding_items.push(item({ batch_id: 'b-code2', label: 'October', open_suggestions: 1, suggested_amount: 9, low_confidence: 0, account_mix: [{ account: 'Meals', count: 1, amount: 9 }] }));
      t.card_transactions.push({ id: 't3', company_entity_id: company, batch_id: 'b-code2', txn_date: '2026-10-01', description: 'CAFE', clean_merchant: 'Cafe', amount: 9, card_name: 'Travel', status: 'uncoded', qbo_account_id: null });
      t.card_coding_suggestions_v.push({ id: 's3', transaction_id: 't3', company_entity_id: company, review_status: 'open', outcome: 'suggested', qbo_account_id: 'meals', qbo_account_name: 'Meals', confidence: 0.9, reasoning: 'Cafe.', stale_reason: null });
      page = await open(t);
      await test('a slow load for one batch never replaces the batch that is open', async () => {
        // Batch A's suggestions resolve late; batch B is opened meanwhile.
        await page.evaluate(() => { const S = window.SiloCodingSuggestions, orig = S.load;
          S.load = (db, co, ids) => ids.includes('t1') ? new Promise(r => setTimeout(() => r(orig(db, co, ids)), 500)) : orig(db, co, ids); });
        await page.locator('#ready-cards [data-batch=b-code] button').click();
        await page.locator('#ready-cards [data-batch=b-code2] button').click();
        await page.waitForSelector('#coding-review .od-review-table');
        await page.waitForTimeout(700); // A has now resolved
        assert.match(await page.locator('#coding-review h2').textContent(), /Code 1 transaction/);
        assert.equal(await page.locator('#coding-review tbody tr').count(), 1);
        await page.getByRole('button', { name: 'Save 1 categorization' }).click();
        await page.waitForSelector('.od-receipt');
        const sent = await calls(page, 'accept_card_coding_suggestions');
        assert.deepEqual(sent.map(c => c.args.p_ids), [['s3']], 'only the open batch\'s suggestion is saved');
      });
      await page.close();
    }

    page = await open();
    await test('the journal entry preview shows destination, dates, lines and balanced totals before approval', async () => {
      await page.locator('[data-batch=b-approve] button').click();
      await page.waitForSelector('#coding-review .od-entry');
      const text = await page.locator('#coding-review').textContent();
      assert.match(text, /Already recorded, day by day/); assert.match(text, /Test Books · from QuickBooks/); assert.match(text, /2026-08-31/); assert.match(text, /Aug 12, 2026 – Aug 14, 2026/);
      assert.match(text, /2 coded · 1 excluded/);
      const total = await page.locator('.od-total').textContent();
      assert.match(total, /\$35\.50.*\$35\.50/);
      assert.match(text, /Optional\. Your SILO ledger already has these transactions/);
      assert.equal(await page.locator('.od-qbo-optional').count(), 0, 'QuickBooks is not offered before SILO approval');
      await page.screenshot({ path: path.join(shots, 'on-deck-coding-entry.png'), fullPage: true });
    });

    await test('a change since the preview refuses approval and refreshes the preview', async () => {
      await page.evaluate(() => { window.__APPROVE_MODE__ = 'stale'; });
      const before = (await calls(page, 'card_import_batch_preview')).length;
      await page.getByRole('button', { name: 'Approve QuickBooks entry' }).click();
      await page.waitForSelector('.od-receipt--failed');
      assert.match(await page.locator('.od-receipt').textContent(), /changed — review it again/);
      assert.ok((await calls(page, 'card_import_batch_preview')).length > before, 'the preview was fetched again');
      assert.equal(await page.evaluate(() => window.__FIXTURE_TABLES__.previews['b-approve'].status), 'categorized');
    });

    await test('approval in SILO sends the exact reviewed hash once and is the finish line', async () => {
      await page.evaluate(() => { window.__APPROVE_MODE__ = 'ok'; });
      await doubleClick(page, 'Approve QuickBooks entry');
      await page.waitForFunction(() => /Frozen for QuickBooks/.test(document.querySelector('.od-receipt')?.textContent || ''));
      const sent = (await calls(page, 'approve_reviewed_card_import_batch')).filter(c => c.args.p_expected_hash === HASH);
      assert.equal(sent.length, 2, 'one stale attempt, then exactly one approval');
      assert.match(await page.locator('#coding-review').textContent(), /Nothing was sent to QuickBooks/);
      assert.match(await page.locator('#coding-review .od-footer').textContent(), /already in the SILO ledger/);
      assert.equal(await page.locator('#ready-cards [data-batch=b-approve]').count(), 0, 'it leaves Ready for your review');
      assert.match(await page.locator('#after-cards [data-batch=b-approve]').textContent(), /Not sent \(optional\)/);
      assert.equal(await page.locator('#ready-count').textContent(), '1');
      assert.equal(await page.getByRole('button', { name: 'Send to QuickBooks…' }).isVisible(), false, 'QuickBooks stays folded away');
      assert.equal(posts.length, 0);
      await page.getByText('Also send to QuickBooks (optional)').click();
      await page.locator('#coding-review').screenshot({ path: path.join(shots, 'on-deck-coding-approved.png') });
      await page.getByText('Also send to QuickBooks (optional)').click();
    });

    await test('sending to QuickBooks takes extra steps, sends the reviewed approval hash once, and shows the receipt', async () => {
      await page.getByText('Also send to QuickBooks (optional)').click();
      await page.getByRole('button', { name: 'Send to QuickBooks…' }).click();
      assert.match(await page.locator('#coding-post-summary').textContent(), /\$35\.50.*Test Books.*already in the SILO ledger/);
      assert.equal(await page.locator('#coding-post-confirm').isDisabled(), true, 'nothing sends until acknowledged');
      await page.evaluate(() => document.getElementById('coding-post-confirm').click());
      assert.equal(posts.length, 0);
      await page.locator('#coding-post-ack').check();
      await page.evaluate(() => { const b = document.getElementById('coding-post-confirm'); b.click(); b.click(); });
      await page.waitForFunction(() => /SILO-aaaa/.test(document.querySelector('.od-receipt')?.textContent || ''));
      assert.equal(posts.length, 1); assert.deepEqual(posts[0], { batch_id: 'b-approve', expected_approval_hash: HASH });
      assert.match(await page.locator('.od-receipt').textContent(), /SILO-aaaa/);
    });
    await page.close();

    for (const [name, reply, expect] of [
      ['an unknown QuickBooks outcome is reported honestly with the recovery path', { status: 502, body: { error: 'timeout', code: 'UNKNOWN_OUTCOME' } }, /still approved in SILO.*cannot post twice/],
      ['a reapproval after review is refused with a fresh-review instruction', { status: 409, body: { error: 'This journal entry was reapproved after you reviewed it.', code: 'APPROVAL_CHANGED' } }, /approval changed — review it again/],
    ]) {
      const t = tables(); t.coding_items = [item({ batch_id: 'b-approve', stage: 'approved', status: 'approved', approval_hash: HASH, account_mix: [] })];
      t.previews['b-approve'].status = 'approved';
      page = await open(t); postReply = reply; posts.length = 0;
      await test(name, async () => {
        await page.locator('[data-batch=b-approve] button').click();
        await page.getByText('Also send to QuickBooks (optional)').click();
        await page.getByRole('button', { name: 'Send to QuickBooks…' }).click();
        await page.locator('#coding-post-ack').check();
        await page.locator('#coding-post-confirm').click();
        await page.waitForSelector('.od-receipt--failed');
        assert.match(await page.locator('.od-receipt').textContent(), expect);
        assert.equal(posts.length, 1);
        if (reply.body.code === 'UNKNOWN_OUTCOME') assert.equal(await page.locator('.od-receipt a').getAttribute('href'), '/v2/transactions.html?batch=b-approve&company=test-company');
      });
      await page.close();
    }
    postReply = { status: 200, body: { ok: true, qbo_journal_entry_id: '9001' } };

    {
      const t = tables(); t.previews['b-approve'] = preview({ ready: false, hash: null, lines: [], blocker: 'A coded line has an invalid QuickBooks account' });
      page = await open(t);
      await test('a QuickBooks blocker is specific, says the SILO ledger is unaffected, and offers no approval button', async () => {
        await page.locator('[data-batch=b-approve] button').click();
        await page.waitForSelector('.od-needs');
        assert.match(await page.locator('.od-needs').textContent(), /QuickBooks entry needs input.*invalid QuickBooks account.*SILO ledger is unaffected/);
        assert.equal(await page.getByRole('button', { name: 'Approve QuickBooks entry' }).count(), 0);
      });
      await page.close();
    }
    {
      const t = tables(); t.coding_items = [item({ batch_id: 'b-approve', stage: 'approved', status: 'approved', account_mix: [] })];
      t.previews['b-approve'].status = 'approved';
      page = await open(t, { on_deck_coding_access: () => ({ review: true, post: false }) });
      await test('a reviewer without posting authority is told why instead of offered a button', async () => {
        await page.locator('[data-batch=b-approve] button').click();
        await page.waitForSelector('#coding-review .od-entry');
        assert.equal(await page.getByRole('button', { name: 'Send to QuickBooks…' }).count(), 0);
        assert.match(await page.locator('#coding-review .od-qbo-optional').textContent(), /requires finance access/);
      });
      await page.close();
    }

    page = await open(tables(), { silo_ledger_batch_status: () => [{ batch_id: 'b-approve', unrecorded: 2, reason: 'A category is not an active account in the chart of accounts' }] });
    await test('categorized transactions the SILO ledger refused are needs input, never a receipt', async () => {
      const card = page.locator('#ready-cards [data-batch=b-approve]');
      assert.equal(await card.count(), 1, 'the import is back in Ready, not under After approval');
      assert.match(await card.textContent(), /Needs input.*2 categorized transactions not in the SILO ledger yet.*not an active account/);
      assert.equal(await card.locator('a').getAttribute('href'), '/v2/transactions.html?batch=b-approve&company=test-company');
      assert.equal(await page.locator('#after-cards [data-batch=b-approve]').count(), 0);
    });
    await page.close();

    page = await open(tables(), { silo_ledger_batch_status: () => ({ __error: { message: 'Could not find the function public.silo_ledger_batch_status', code: 'PGRST202' } }) });
    await test('before the ledger migration, a categorized import is still waiting on its monthly entry, never "recorded"', async () => {
      const card = page.locator('#ready-cards [data-batch=b-approve]');
      assert.equal(await card.count(), 1, 'it stays in Ready');
      assert.match(await card.textContent(), /Not recorded in SILO yet.*daily ledger is not switched on/);
      assert.doesNotMatch(await page.locator('main').textContent(), /In SILO ledger/);
      assert.equal(await page.locator('#ready-count').textContent(), '2', 'and it counts as waiting');
      assert.equal(await card.getByRole('button', { name: /Review/ }).count(), 1, 'the approval review is still reachable');
    });
    await page.close();

    page = await open();
    await test('narrow mobile keeps the cards and the review inside the viewport', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('[data-batch=b-approve] button').click();
      await page.waitForSelector('#coding-review .od-entry');
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.equal(await page.evaluate(() => document.getElementById('coding-review').getBoundingClientRect().right <= innerWidth), true);
      await page.screenshot({ path: path.join(shots, 'on-deck-coding-mobile.png'), fullPage: true });
    });
    await page.close();

    page = await open(tables(), { on_deck_coding_access: () => ({ review: false, post: false }) });
    await test('a member with neither finance access nor admin membership sees nothing', async () => {
      assert.match(await page.locator('#status').textContent(), /requires an active company owner or admin membership, or finance access/);
      assert.equal(await page.locator('#ready-section').isHidden(), true);
      assert.equal((await calls(page, 'on_deck_coding_items')).length, 0);
    });
    await page.close();

    const homeReady = () => document.getElementById('onDeckReady') && window.__QUERIES__.some(q => q.table === 'rpc:on_deck_ready_count');
    page = await suite.open('/v2/finance.html', tables(), { rpc: { on_deck_ready_count: () => ({ coding: 2, needs_input: 1, proposals: 1 }) }, ready: homeReady });
    await test('Home keeps its tools and adds only a compact count of real ready work', async () => {
      await page.waitForFunction(() => !document.getElementById('onDeckReady').hidden);
      assert.equal(await page.locator('#onDeckReadyCount').textContent(), '3', 'needs-input is not counted as ready');
      assert.equal(await page.locator('#onDeckReady').getAttribute('href'), '/v2/on-deck.html');
      assert.ok(await page.locator('.fin-card').count() >= 3, 'tool cards remain');
      assert.equal(await page.locator('a.fin-link[href="/v2/profile.html"]').count(), 1, 'My Profile link remains');
      await page.screenshot({ path: path.join(shots, 'home-ready-link.png'), fullPage: true });
    });
    await page.close();
    for (const [label, fn] of [['zero', () => ({ coding: 0, proposals: 0 })], ['an error', () => ({ __error: { message: 'function does not exist' } })]]) {
      page = await suite.open('/v2/finance.html', tables(), { rpc: { on_deck_ready_count: fn }, ready: homeReady });
      await test(`Home shows no link when the count is ${label}`, async () => {
        await page.waitForTimeout(150);
        assert.equal(await page.locator('#onDeckReady').isHidden(), true);
      });
      await page.close();
    }
    console.log(`${checks} browser checks passed`);
  } finally { await suite.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
