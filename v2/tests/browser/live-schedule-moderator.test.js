/* The moderator on /v2/live-schedule.html, driven through the real inline page
 * script and DOM against the shared in-memory Supabase stand-in. No
 * credentials, external requests or production writes.
 *
 * What it pins:
 *   - a moderator named on the CLAIM is stored on the slot, linked to a
 *     teammate's profile when the name is one and left a bare name when it is
 *     not (a contractor with no SILO login still has to be paid);
 *   - finalizing files the host's AP request and the moderator's in ONE
 *     insert, so AP cannot end up with one of the two people;
 *   - the moderator is paid the hourly rate and NOTHING else -- the 3%
 *     commission is the host's share of what the stream sold;
 *   - the pay route chosen (payroll vs vendor) is the request_type filed;
 *   - clearing the moderator at finalize clears the row and files one request;
 *   - the payout a finalized slot reports, on the day board and in the month
 *     KPI, is what BOTH people cost.
 *
 * Mutations (each must break a named assertion):
 *   LIVE_MOD_MUTATION=no-moderator-row    the second AP row is never filed
 *   LIVE_MOD_MUTATION=moderator-commission the moderator is paid commission too
 *   LIVE_MOD_MUTATION=payroll-only        the vendor route is ignored
 *   LIVE_MOD_MUTATION=clear-keeps-payout  a cleared moderator keeps a payout
 *   LIVE_MOD_MUTATION=split-insert        the two AP rows are filed separately
 *   LIVE_MOD_MUTATION=day-payout          the day KPI drops the moderator
 *   LIVE_MOD_MUTATION=month-payout        the month KPI drops the moderator
 *   LIVE_MOD_MUTATION=no-feature-detect   the moderator keys are written before
 *                                         the migration is applied, which
 *                                         PostgREST rejects WHOLE -- so the page
 *                                         would stop claiming slots at all
 *                                         between the merge and the apply
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startSuite, REPO_ROOT } = require('../lib/harness');

// The page is copied, not mutated in place: a mutation run must never be able
// to leave a changed v2/live-schedule.html behind in the checkout.
const SOURCE = path.join(REPO_ROOT, 'v2/live-schedule.html');
const UNDER_TEST = path.join(REPO_ROOT, 'v2/tests/fixtures/live-schedule-under-test.html');
const UNDER_TEST_URL = '/v2/tests/fixtures/live-schedule-under-test.html';

const MUTATIONS = {
  'no-moderator-row': ['      if (moderator) {\n        apRows.push({', '      if (false) {\n        apRows.push({'],
  'moderator-commission': ['          amount_due: moderatorTotal,', '          amount_due: total,'],
  'payroll-only': ["          request_type: moderatorPay,", "          request_type: 'payroll_payment',"],
  'clear-keeps-payout': ['        moderator_payout_total: moderator ? moderatorTotal : null,', '        moderator_payout_total: MODERATOR_HOURLY_RATE,'],
  'split-insert': [
    "      const { error: apError } = await supabaseClient.from('payment_requests').insert(apRows);",
    "      const { error: apError } = await (async () => {\n"
    + "        for (const row of apRows) {\n"
    + "          const r = await supabaseClient.from('payment_requests').insert(row);\n"
    + "          if (r.error) return r;\n"
    + "        }\n"
    + "        return { error: null };\n"
    + "      })();",
  ],
  'day-payout': ['        commission += payout + moderatorPayout;', '        commission += payout;'],
  'month-payout': ['          + (Number(row.moderator_payout_total) || 0);', '          + 0;'],
  'no-feature-detect': ['    return state.moderatorReady ? fields : {};', '    return fields;'],
};

function writePageUnderTest() {
  let source = fs.readFileSync(SOURCE, 'utf8');
  const name = process.env.LIVE_MOD_MUTATION;
  if (name) {
    const mutation = MUTATIONS[name];
    assert.ok(mutation, `unknown mutation: ${name}`);
    assert.ok(source.includes(mutation[0]), `mutation target still present: ${name}`);
    source = source.replace(mutation[0], mutation[1]);
  }
  // The page is a sibling of beacon.css / nav-config.js in v2/, and this copy
  // is not, so those relative URLs 404 here. The stylesheets do not matter
  // (the modal's own display rules are inline in the page), but the chrome
  // scripts do: SiloChrome.mount() is called at the top level, and an
  // undefined SiloChrome throws there and the page never boots.
  source = source.replace('<script src="nav-config.js"></script>',
    '<script>window.SiloNav={items:[]};window.SiloChrome={mount(){}};</script>');
  source = source.replace('<script src="silo-chrome.js"></script>', '');
  source = source.replace('<script src="v2-shell.js" defer></script>', '');
  fs.mkdirSync(path.dirname(UNDER_TEST), { recursive: true });
  fs.writeFileSync(UNDER_TEST, source);
}

const PROFILES = [
  { id: 'test-user', name: 'Blake Host', email: 'test@baseballism.com', role: 'admin', is_active: true },
  { id: 'u-dana', name: 'Dana Reyes', email: 'dana@baseballism.com', role: 'member', is_active: true },
];

const money = (n) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

(async () => {
  writePageUnderTest();
  // Loopback, so the origin is a SECURE context: the page files its AP
  // requests with crypto.randomUUID(), which does not exist on an insecure one.
  const suite = await startSuite({ secureContext: true });
  let failed = false;
  try {
    const page = await suite.open(UNDER_TEST_URL, { profiles: PROFILES, live_sessions_v: [] }, {
      ready: () => document.querySelectorAll('#monthGrid [data-day]').length > 0,
    });
    page.on('pageerror', (e) => { console.log('  [pageerror] ' + e.message); });

    const queries = () => page.evaluate(() => window.__QUERIES__.map((q) => ({
      table: q.table, op: q._op, rows: q.rows, patch: q.patch,
    })));
    const reset = () => page.evaluate(() => { window.__QUERIES__.length = 0; });
    // The slots are hourly moments in ET; let the page's own clock math build
    // them rather than re-deriving the daylight-saving rules in the test.
    const slotIso = (index) => page.evaluate((i) => state.slots[i].toISOString(), index);
    const setSessions = (rows) => page.evaluate(async (r) => {
      window.__FIXTURE_TABLES__.live_sessions_v = r;
      await loadDay();
    }, rows);

    await page.click('[data-view="day"]');
    await page.waitForFunction(() => document.querySelectorAll('#boardTbody tr').length === 20);

    // ── The moderator is offered, and is a suggestion, not a constraint ──
    assert.match(await page.locator('#moderatorNames').innerHTML(), /Dana Reyes/,
      'teammates are suggested for the moderator field');
    assert.equal(await page.locator('#claimModeratorPay').count(), 1);

    // ── Claim with a teammate as moderator ──────────────────────────────
    await reset();
    await page.locator('#boardTbody tr').nth(0).locator('[data-claim]').click();
    await page.fill('#claimModerator', 'Dana Reyes');
    await page.click('#claimSubmitBtn');
    await page.waitForFunction(() => !document.getElementById('claimBackdrop').classList.contains('open'));
    let claim = (await queries()).find((q) => q.table === 'live_sessions' && q.op === 'insert');
    assert.ok(claim, 'the claim is still written to live_sessions');
    assert.equal(claim.rows.moderator_name, 'Dana Reyes');
    assert.equal(claim.rows.moderator_user_id, 'u-dana', 'a teammate is linked to their profile');
    assert.equal(claim.rows.moderator_pay_type, 'payroll_payment', 'payroll is the default route');
    assert.equal(claim.rows.moderator_hourly_rate, undefined,
      'the rate is stamped at finalize, not at claim, so the hour is paid at the rate it was worked at');

    // ── Claim with someone who has no SILO login, paid as a vendor ──────
    await reset();
    await page.locator('#boardTbody tr').nth(1).locator('[data-claim]').click();
    await page.fill('#claimModerator', 'Outside Moderator');
    await page.selectOption('#claimModeratorPay', 'invoice_vendor_payment');
    await page.click('#claimSubmitBtn');
    await page.waitForFunction(() => !document.getElementById('claimBackdrop').classList.contains('open'));
    claim = (await queries()).find((q) => q.table === 'live_sessions' && q.op === 'insert');
    assert.equal(claim.rows.moderator_name, 'Outside Moderator');
    assert.equal(claim.rows.moderator_user_id, null, 'a name that is not a teammate stays a name');
    assert.equal(claim.rows.moderator_pay_type, 'invoice_vendor_payment');

    // ── Claiming alone is still a claim, with nothing to pay ────────────
    await reset();
    await page.locator('#boardTbody tr').nth(2).locator('[data-claim]').click();
    await page.click('#claimSubmitBtn');
    await page.waitForFunction(() => !document.getElementById('claimBackdrop').classList.contains('open'));
    claim = (await queries()).find((q) => q.table === 'live_sessions' && q.op === 'insert');
    assert.equal(claim.rows.moderator_name, null);
    assert.equal(claim.rows.moderator_pay_type, null,
      'no moderator means no pay route — the CHECK constraint forbids one without a name');

    // ── Finalize: two people, one insert ────────────────────────────────
    const claimed = (id, iso, extra) => ({
      id, slot_start: iso, status: 'claimed', claimed_by: 'test-user',
      claimed_by_name: 'Blake Host', claimed_by_email: 'test@baseballism.com',
      live_location: 'Studio', commission_rate: 0.03, hourly_rate: 25,
      moderator_name: null, moderator_user_id: null, moderator_pay_type: null,
      moderator_hourly_rate: null, moderator_payout_total: null,
      moderator_payment_request_id: null, ...extra,
    });

    await setSessions([claimed('sess-1', await slotIso(3), {
      moderator_name: 'Dana Reyes', moderator_user_id: 'u-dana',
      moderator_pay_type: 'payroll_payment', moderator_user_email: 'dana@baseballism.com',
    })]);
    const row = () => page.locator('#boardTbody tr').nth(3);
    assert.match(await row().textContent(), /Dana Reyes/, 'the board names who is moderating');
    assert.match(await row().textContent(), /\$25\.00\/hr/, 'and what that costs');

    await reset();
    await row().locator('[data-finalize]').click();
    assert.equal(await page.locator('#finalizeModerator').inputValue(), 'Dana Reyes',
      'the moderator named at claim is carried into finalize');
    await page.fill('#grossSalesInput', '1000');
    assert.equal(await page.locator('#totalPreview').textContent(), money(55), 'host: $25 + 3% of $1,000');
    assert.equal(await page.locator('#moderatorPreview').textContent(), money(25), 'moderator: the hour, no commission');
    assert.equal(await page.locator('#apTotalPreview').textContent(), money(80), 'what AP is actually being asked for');
    await page.click('#finalizeSubmitBtn');
    await page.waitForFunction(() => !document.getElementById('finalizeBackdrop').classList.contains('open'));

    let q = await queries();
    const apInserts = q.filter((x) => x.table === 'payment_requests' && x.op === 'insert');
    assert.equal(apInserts.length, 1,
      'ONE insert: AP gets both people or neither, never the host alone');
    const apRows = [].concat(apInserts[0].rows);
    assert.equal(apRows.length, 2, 'the host and the moderator are both filed');
    const host = apRows[0];
    const mod = apRows[1];
    assert.equal(host.vendor_name, 'Blake Host');
    assert.equal(host.request_type, 'payroll_payment');
    assert.equal(host.amount_due, 55);
    assert.equal(mod.vendor_name, 'Dana Reyes');
    assert.equal(mod.request_type, 'payroll_payment', 'the moderator rides the same AP pipeline as the host');
    assert.equal(mod.amount_due, 25, 'the hourly rate and nothing else');
    assert.match(mod.notes_comments, /no commission/, 'and the request says so');
    assert.equal(mod.workflow_status, 'new');
    assert.notEqual(mod.id, host.id, 'two requests, two ids');

    const upd = q.find((x) => x.table === 'live_sessions' && x.op === 'update');
    assert.equal(upd.patch.moderator_name, 'Dana Reyes');
    assert.equal(upd.patch.moderator_hourly_rate, 25, 'the rate is stamped, so history survives a rate change');
    assert.equal(upd.patch.moderator_payout_total, 25);
    assert.equal(upd.patch.moderator_pay_type, 'payroll_payment');
    assert.equal(upd.patch.moderator_payment_request_id, mod.id, 'the slot links the request it filed');
    assert.equal(upd.patch.payment_request_id, host.id);

    const invokes = await page.evaluate(() => (window.__INVOKES__ || []).map((i) => i.body.payment_request_id));
    assert.ok(invokes.includes(host.id) && invokes.includes(mod.id),
      'both requests are announced, or one of the two people is invisible to AP notifications');

    // ── A moderator cleared at finalize comes off the row ───────────────
    await setSessions([claimed('sess-2', await slotIso(4), {
      moderator_name: 'Dana Reyes', moderator_user_id: 'u-dana', moderator_pay_type: 'payroll_payment',
    })]);
    await reset();
    await page.locator('#boardTbody tr').nth(4).locator('[data-finalize]').click();
    await page.fill('#finalizeModerator', '');
    await page.fill('#grossSalesInput', '500');
    assert.equal(await page.locator('#moderatorPreview').textContent(), '—');
    assert.equal(await page.locator('#apTotalPreview').textContent(), money(40));
    await page.click('#finalizeSubmitBtn');
    await page.waitForFunction(() => !document.getElementById('finalizeBackdrop').classList.contains('open'));
    q = await queries();
    assert.equal([].concat(q.find((x) => x.table === 'payment_requests' && x.op === 'insert').rows).length, 1,
      'nobody moderated it, so nobody is paid for moderating it');
    const cleared = q.find((x) => x.table === 'live_sessions' && x.op === 'update').patch;
    assert.equal(cleared.moderator_name, null);
    assert.equal(cleared.moderator_pay_type, null);
    assert.equal(cleared.moderator_payout_total, null, 'a cleared moderator leaves no payout behind');
    assert.equal(cleared.moderator_payment_request_id, null);

    // ── The vendor route is the request type that gets filed ────────────
    await setSessions([claimed('sess-3', await slotIso(5), {
      moderator_name: 'Outside Moderator', moderator_pay_type: 'invoice_vendor_payment',
    })]);
    await reset();
    await page.locator('#boardTbody tr').nth(5).locator('[data-finalize]').click();
    assert.equal(await page.locator('#finalizeModeratorPay').inputValue(), 'invoice_vendor_payment');
    await page.fill('#grossSalesInput', '0');
    await page.click('#finalizeSubmitBtn');
    await page.waitForFunction(() => !document.getElementById('finalizeBackdrop').classList.contains('open'));
    q = await queries();
    const vendorRows = [].concat(q.find((x) => x.table === 'payment_requests' && x.op === 'insert').rows);
    assert.equal(vendorRows.length, 2);
    assert.equal(vendorRows[1].request_type, 'invoice_vendor_payment',
      'a contractor is filed as a vendor payment, not as payroll');
    assert.equal(vendorRows[1].amount_due, 25);
    assert.equal(vendorRows[0].request_type, 'payroll_payment', 'the host is unaffected by the moderator route');

    // ── What a finalized slot reports having cost ───────────────────────
    const finalized = {
      id: 'sess-done', slot_start: await slotIso(6), status: 'finalized', claimed_by: 'test-user',
      claimed_by_name: 'Blake Host', gross_sales: 1000, commission_rate: 0.03, commission_amount: 30,
      hourly_rate: 25, payout_total: 55, payee_name: 'Blake Host', payment_request_id: 'pr-host',
      moderator_name: 'Dana Reyes', moderator_user_id: 'u-dana', moderator_pay_type: 'payroll_payment',
      moderator_hourly_rate: 25, moderator_payout_total: 25, moderator_payment_request_id: 'pr-mod',
    };
    await setSessions([finalized]);
    const doneRow = page.locator('#boardTbody tr').nth(6);
    assert.match(await doneRow.textContent(), /Dana Reyes/);
    assert.match(await doneRow.textContent(), /AP FILED/);
    assert.equal(await page.locator('#kpiCommission').textContent(), money(80),
      'the day payout is what the slot cost: both people');

    await page.click('[data-view="month"]');
    await page.waitForFunction(() => document.querySelectorAll('#monthGrid [data-day]').length > 0);
    assert.equal(await page.locator('#kpiCommission').textContent(), money(80),
      'and so is the month payout');

    // ── Before the migration is applied ────────────────────────────────
    // Merging does not apply it, so this is the state production is in for as
    // long as the gap lasts. A write naming a column PostgREST does not know is
    // rejected WHOLE, so the page must not send one -- claiming a slot has to
    // keep working, and the moderator surface must not offer what the database
    // cannot store.
    const unapplied = await suite.open(UNDER_TEST_URL, { profiles: PROFILES, live_sessions_v: [] }, {
      ready: () => document.querySelectorAll('#monthGrid [data-day]').length > 0,
      missingColumns: { live_sessions_v: ['moderator_name'], live_sessions: ['moderator_name'] },
    });
    unapplied.on('pageerror', (e) => { console.log('  [pageerror] ' + e.message); });
    await unapplied.click('[data-view="day"]');
    await unapplied.waitForFunction(() => document.querySelectorAll('#boardTbody tr').length === 20);
    assert.equal(await unapplied.locator('#claimModeratorFields').isHidden(), true,
      'the moderator field is not offered by a database that cannot store one');
    await unapplied.evaluate(() => { window.__QUERIES__.length = 0; });
    await unapplied.locator('#boardTbody tr').nth(0).locator('[data-claim]').click();
    await unapplied.click('#claimSubmitBtn');
    await unapplied.waitForFunction(() => !document.getElementById('claimBackdrop').classList.contains('open'));
    const preMigrationClaim = await unapplied.evaluate(() => window.__QUERIES__
      .filter((x) => x.table === 'live_sessions' && x._op === 'insert').map((x) => x.rows));
    assert.equal(preMigrationClaim.length, 1, 'claiming a slot still works');
    assert.deepEqual(Object.keys(preMigrationClaim[0]).filter((k) => k.startsWith('moderator')), [],
      'and names no column the database does not have yet');
    assert.match(await unapplied.locator('#status').textContent(), /Slot claimed/,
      'the claim succeeded, with no error on screen');

    console.log('live-schedule-moderator: ok');
  } catch (err) {
    failed = true;
    console.error(err);
  } finally {
    await suite.close();
    fs.rmSync(UNDER_TEST, { force: true });
  }
  process.exit(failed ? 1 : 0);
})();
