/* Affiliate Studio in a real browser: the staff page (v2/affiliates/index.html)
 * and the three affiliate-facing pages (join, portal, apply), against the
 * stubbed Supabase and a stubbed affiliate-portal function.
 *
 * What it proves:
 *   - every tab of the staff page renders from fixture rows without a page error;
 *   - a base SILO could not measure renders as a dash, never as $0;
 *   - a member who cannot manage sees no write buttons (the database refuses
 *     anyway; this is the page not offering what will fail);
 *   - the "how each part works" labels follow the data (verified / manual /
 *     simulated / unconfigured / not measured);
 *   - the affiliate pages strip the token from the address bar, render the
 *     brand's terms as text (an <img onerror> in the terms stays inert), send
 *     the version shown when accepting, and offer renewal on an expired link;
 *   - the affiliate pages carry no SILO navigation.
 *
 * Mutations (each must fail at least one assertion):
 *   AFFILIATE_UI_MUTATION=nullzero    an unknown money amount renders as $0.00
 *   AFFILIATE_UI_MUTATION=termshtml   the program terms are rendered as HTML
 *   AFFILIATE_UI_MUTATION=tokenurl    the token is left in the address bar
 *   AFFILIATE_UI_MUTATION=membergate  a member is shown the manager buttons
 *   AFFILIATE_UI_MUTATION=exportlocal the payout file is built from the page's
 *                                     rows instead of what the database claimed
 *   AFFILIATE_UI_MUTATION=exportctx   the export reads the program after the claim,
 *                                     so a program switch mid-claim mislabels it
 *   AFFILIATE_UI_MUTATION=periodtotal a period total is summed from the 300
 *                                     ledger lines the page holds
 */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const assert = require('node:assert/strict');
const R = createReporter('affiliate-studio');

const MUTATIONS = {
  nullzero: ['/affiliates/studio-core.js', "if (minor === null || minor === undefined || minor === '' || !Number.isFinite(Number(minor))) return '—';", 'if (minor === undefined) return \'—\'; minor = Number(minor) || 0;'],
  termshtml: ['/affiliates/public.js', 'return paras.length ? paras.map((p) => `<p>${esc(p).replace(/\\n/g, \'<br>\')}</p>`).join(\'\')', 'return paras.length ? paras.map((p) => `<p>${p}</p>`).join(\'\')'],
  tokenurl: ['/affiliates/public.js', "if (url.searchParams.has('t')) { url.searchParams.delete('t'); history.replaceState(null, '', url.pathname + url.search); }", ''],
  membergate: ['/affiliates/studio.js', 'const MANAGE = canManage === true;', 'const MANAGE = true;'],
  exportlocal: ['/affiliates/studio.js', 'const csv = toCsv(PAYOUT_HEADER, payoutRows(r.payouts || [], S.d.affById));', "const csv = toCsv(PAYOUT_HEADER, payoutRows(S.d.payouts.filter((x) => x.status === 'approved'), S.d.affById));"],
  exportctx: ['/affiliates/studio.js', 'download(`payouts-${slug}-${today()}.csv`, csv);', 'download(`payouts-${prog().slug}-${today()}.csv`, csv);'],
  periodtotal: ['/affiliates/studio.js', 'const t = d.periodTotals.filter((r) => r.period_id === x.id);', "const t = [{ currency: 'USD', amount_cents: d.ledger.filter((l) => l.period_id === x.id).reduce((a, l) => a + Number(l.amount_cents), 0) }];"],
};
const MUT = process.env.AFFILIATE_UI_MUTATION || '';
assert.ok(!MUT || MUTATIONS[MUT], `Unknown mutation ${MUT}`);
const transform = (rel, source) => {
  if (!MUT || !rel.endsWith(MUTATIONS[MUT][0])) return source;
  const [, from, to] = MUTATIONS[MUT];
  assert.ok(source.includes(from), `mutation ${MUT}: pattern missing in ${rel}`);
  return source.split(from).join(to);
};

const CO = 'test-company';
const PROG = '11111111-1111-4111-8111-111111111111';
const AFF = '22222222-2222-4222-8222-222222222222';
const now = new Date().toISOString();
const tables = {
  profiles: [{ id: 'u1', name: 'Dana Ops', email: 'dana@brand.invalid', role: 'admin', is_active: true }],
  entities: [{ id: CO, title: 'Brand A' }],
  affiliate_programs: [{
    id: PROG, company_entity_id: CO, name: 'Creators', slug: 'creators', status: 'active', niche: 'trail running',
    platforms: ['youtube'], geographies: ['US'], intake_mode: 'open', commission_kind: 'percent_of_net', commission_percent: 10,
    commission_fixed_cents: null, currency: 'USD', attribution_window_days: 0, code_precedence: 'first_affiliate_code',
    refund_hold_days: 30, payout_minimum_cents: 0, payout_method: 'manual', discovery_max_cost_usd: 0.5,
    terms_markdown: 'Be honest.', terms_version: 2, created_at: now,
  }],
  affiliate_program_health_v: [{ company_entity_id: CO, program_id: PROG, prospects_new: 1, prospects_approved: 0, outreach_approved: 0, outreach_exported: 0, outreach_marked_sent: 0, affiliates_active: 1, codes_active: 1, codes_never_seen: 0, attributions_earning: 1, attributions_ambiguous: 1 }],
  affiliate_prospect_sources: [{ id: 's1', company_entity_id: CO, program_id: PROG, kind: 'serp_query', query: 'trail running youtube', location_code: 2840, language_code: 'en', enabled: true, max_results: 30, created_at: now }],
  affiliate_discovery_runs: [{ id: 'r1', company_entity_id: CO, program_id: PROG, query: 'trail running youtube', started_at: now, dry_run: false, status: 'success', results_returned: 30, profiles_recognized: 4, prospects_new: 1, emails_found: 0, suppressed_skipped: 0, cost_usd: 0.002 }],
  affiliate_prospects: [{ id: 'p1', company_entity_id: CO, program_id: PROG, display_name: 'Sam Runs', platform: 'youtube', handle: '@samruns', profile_url: 'https://www.youtube.com/@samruns', contact_email: null, source: 'serp', source_url: 'https://www.youtube.com/@samruns', collected_at: now, evidence: { title: 'Sam Runs', snippet: 'Trail running every week', query: 'trail running youtube', followers: 12400, followers_source_url: 'https://www.youtube.com/@samruns', followers_as_of: '2026-11-09' }, confidence: 0.45, confidence_basis: 'recognised youtube profile; niche words in title', status: 'new' }],
  affiliate_suppressions: [],
  affiliate_outreach_drafts: [], affiliate_outreach_batches: [],
  affiliates: [{ id: AFF, company_entity_id: CO, program_id: PROG, display_name: 'Pat Trails', contact_email: 'pat@creator.invalid', status: 'active', terms_version_accepted: 2, terms_accepted_at: now, created_at: now }],
  affiliate_codes: [{ id: 'c1', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, code: 'PAT10', starts_on: '2026-10-01', ends_on: null, status: 'active', verified_at: now, first_seen_order_id: '1001' }],
  affiliate_links: [],
  affiliate_attributions: [
    { id: 'a1', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, order_id: '1001', order_number: '#1001', order_day: '2026-11-01', order_currency: 'USD', codes_on_order: 1, matched_code: 'PAT10', basis: 'single_affiliate_code', gross_subtotal_cents: 5000, refunded_subtotal_cents: 0, commissionable_cents: 5000 },
    { id: 'a2', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, order_id: '1002', order_number: '#1002', order_day: '2026-11-02', order_currency: 'USD', codes_on_order: 1, matched_code: 'PAT10', basis: 'refunds_not_measured', gross_subtotal_cents: 7000, refunded_subtotal_cents: null, commissionable_cents: null },
  ],
  affiliate_performance_v: [{ company_entity_id: CO, program_id: PROG, affiliate_id: AFF, attributed_orders: 1, orders_with_unknown_base: 0, gross_subtotal_cents: 5000, refunded_subtotal_cents: 0, commissionable_cents: 5000, order_currency: 'USD' }],
  affiliate_commission_periods: [{ id: 'per1', company_entity_id: CO, program_id: PROG, period_start: '2026-10-01', period_end: '2026-10-31', status: 'under_review' }],
  affiliate_period_totals_v: [{ company_entity_id: CO, program_id: PROG, period_id: 'per1', currency: 'USD', amount_cents: 123456, entry_count: 412 }],
  affiliate_commission_ledger: [{ id: 'l1', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, kind: 'accrual', amount_cents: 500, currency: 'USD', rate_kind: 'percent_of_net', rate_value: 10, basis_cents: 5000, order_id: '1001', created_at: now }],
  affiliate_balances_v: [{ company_entity_id: CO, program_id: PROG, affiliate_id: AFF, currency: 'USD', earned_cents: 500, refund_adjustment_cents: null, claimed_cents: 0, paid_cents: 0, unclaimed_cents: 500 }],
  affiliate_payouts: [], affiliate_payout_items: [],
  affiliate_notifications: [],
  entity_memberships: [{ entity_id: CO, user_id: 'u1' }],
};
const ready = () => !!document.querySelector('#prospectsBody .bcn-card');
const openMore = (page) => page.evaluate(() => document.querySelectorAll('details.af-more').forEach((d) => { d.open = true; }));
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel);

(async () => {
  const suite = await startSuite({ transform });
  const errors = [];
  try {
    // ── staff page, as a manager ──────────────────────────────────────────
    const page = await suite.open('/v2/affiliates/index.html', tables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true } });
    page.on('pageerror', (e) => errors.push(e.message));
    // Simple page: four tabs, Find creators first, one next-step line.
    R.ok('the page has four tabs', (await page.$$('#tabs [data-tab]')).length === 4);
    const next = await text(page, '#nextStep');
    R.has(next, 'waiting for your review', 'the next-step line says what to do now');
    R.has(next, 'not credited', 'uncredited code orders are surfaced');
    R.not(await text(page, '#prospectsBody'), 'Fit is scored', 'no scoring jargon on the main list');
    await page.click('#btnSettings');
    await page.waitForFunction(() => !!document.querySelector('#programBody .bcn-card'), null, { timeout: 5000 });
    const ov = await text(page, '#programBody');
    R.has(ov, 'Outreach to prospects', 'settings state how each part works');
    R.ok('a live, successful run makes discovery verified', /Discovery\s*verified/.test(ov))
    R.not(ov, 'Stripe Connect', 'an unbuilt feature is not advertised')
    R.not(ov, 'SILO never', 'the overview says how it works, not what SILO does not do')
    R.ok('incrementality is labelled not measured', /Incremental sales\s*not measured/.test(ov))
    for (const tab of ['prospects', 'outreach', 'affiliates', 'payouts']) {
      await page.click(`#tabs [data-tab="${tab}"]`);
      await page.waitForFunction((t) => !!document.querySelector(`#${t}Body .bcn-card`), tab, { timeout: 5000 });
    }
    await page.click('#tabs [data-tab="outreach"]');
    const ob = await text(page, '#outreachBody');
    R.has(ob, 'your own AI sends it', 'Messages leads with sending through your own AI');
    R.ok('Connect your AI is the primary action on Messages', !!(await page.$('#outreachBody a.bcn-btn--primary[href="../settings-connect-ai.html"]')));
    await page.click('#tabs [data-tab="prospects"]');
    const pr = await text(page, '#prospectsBody');
    R.has(pr, 'Trail running every week', 'a prospect shows the search result it came from');
    R.not(pr, '$0.0020', 'discovery cost is not shown to the company');
    R.not(pr, 'GitHub Actions', 'discovery copy names no internal tooling');
    R.has(pr, 'United States', 'a search shows its country by name, not a provider code');
    R.ok('the country picker offers names', await page.$('#srcLoc option[value="2840"]'));
    R.ok('there is one search button, not two', !(await page.$('#prospectsBody [data-act="discovery-run"]')) && !!(await page.$('#prospectsBody [data-act="research-run"]')));
    R.ok('a manager can approve a prospect', await page.$('#prospectsBody [data-act="prospect-status"][data-s="approved"]'))
    R.has(await text(page, '#prospectsBody'), '12,400', 'a follower count a page stated is shown');
    R.ok('the follower count links to where it was stated', await page.$('#prospectsBody a[href="https://www.youtube.com/@samruns"]'));
    // Find creators with AI: starts a background run and says so; the company is never sent.
    const researchCalls = [];
    await suite.context.route('**/functions/v1/affiliate-research', (route) => {
      const body = JSON.parse(route.request().postData() || '{}'); researchCalls.push(body);
      if (body.action === 'import') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kept: 2, prospects_new: 2, prospects_updated: 0, skipped_minors: 1, skipped_not_profile: 0, suppressed_skipped: 0 }) });
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ run_id: 'r9' }) });
    });
    await page.fill('#rsFocus', 'trail running moms');
    await page.click('#prospectsBody [data-act="research-run"]');
    await page.waitForFunction(() => /Research started/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 5000 });
    R.ok('research asks for this program with the focus, never a company', researchCalls.length === 1 && researchCalls[0].action === 'research' && researchCalls[0].program_id === PROG && researchCalls[0].focus === 'trail running moms' && !('company_entity_id' in researchCalls[0]));
    // Import a list: the file is parsed in the page and sent as rows.
    await page.setInputFiles('#impFile', { name: 'list.csv', mimeType: 'text/csv', buffer: Buffer.from('name,url,followers,minor\r\n"Ann, Runs",https://www.tiktok.com/@annruns,41.2K,FALSE\r\nKid,https://www.tiktok.com/@kid,10,TRUE\r\n') });
    await openMore(page);
    await page.click('#prospectsBody [data-act="import-run"]');
    await page.waitForFunction(() => /Imported/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 5000 });
    const imp = researchCalls.find((c) => c.action === 'import');
    R.ok('the import sends parsed rows', imp && imp.rows.length === 2 && imp.rows[0].name === 'Ann, Runs' && imp.rows[0].url === 'https://www.tiktok.com/@annruns');
    R.has(await text(page, '#status'), '1 skipped as likely minors', 'the import says what it skipped');
    await page.click('#tabs [data-tab="payouts"]');
    const cm = await page.evaluate(() => [...document.querySelectorAll('#commissionsBody tr')].map((r) => r.textContent).find((t) => t.includes('#1002')) || '');
    R.has(cm, 'refunds not measured', 'an unmeasured order says why');
    R.has(cm, '—', 'an unknown base renders as a dash');
    R.not(cm, '$0.00', 'an unknown base is never shown as $0');
    await page.click('#tabs [data-tab="payouts"]');
    R.has(await text(page, '#payoutsBody'), 'pay it from your bank or payment tool', 'the payout tab says where money moves');
    await page.click('#btnSettings');
    R.has(await text(page, '#programBody'), '/v2/affiliates/apply.html?c=test-company&p=creators', 'an open program shows its application link');
    await page.close();

    // ── payout export: the file is what the database claimed ─────────────
    // Two payouts look approved on the page; by the time Export runs one was
    // voided elsewhere, so the claim returns only the other. The file must
    // hold exactly the claimed one, and its fingerprint goes to that batch.
    const PA = '33333333-3333-4333-8333-333333333333';
    const PB = '44444444-4444-4444-8444-444444444444';
    const PROG2 = '55555555-5555-4555-8555-555555555555';
    const payTables = { ...tables, affiliate_programs: [...tables.affiliate_programs, { ...tables.affiliate_programs[0], id: PROG2, name: 'Beta', slug: 'beta' }], affiliate_payouts: [
      { id: PA, company_entity_id: CO, program_id: PROG, affiliate_id: AFF, status: 'approved', amount_cents: 500, currency: 'USD', item_count: 1, created_at: now, approved_at: now },
      { id: PB, company_entity_id: CO, program_id: PROG, affiliate_id: AFF, status: 'approved', amount_cents: 900, currency: 'USD', item_count: 2, created_at: now, approved_at: now },
    ] };
    const pay = await suite.open('/v2/affiliates/index.html', payTables, { ready, rpc: {
      can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true,
      // The user switches program while the claim is in flight.
      affiliate_claim_payout_export: (args) => { (window.__rpcCalls = window.__rpcCalls || []).push(['claim', args]); const sel = document.getElementById('programSel'); sel.value = '55555555-5555-4555-8555-555555555555'; sel.dispatchEvent(new Event('change')); return { batch_id: 'batch-1', payouts: [{ id: '33333333-3333-4333-8333-333333333333', affiliate_id: '22222222-2222-4222-8222-222222222222', amount_cents: 500, currency: 'USD', item_count: 1, approved_at: new Date().toISOString(), status: 'exported' }], skipped: ['44444444-4444-4444-8444-444444444444'] }; },
      affiliate_set_payout_export_fingerprint: (args) => { (window.__rpcCalls = window.__rpcCalls || []).push(['fp', args]); return 1; },
    } });
    pay.on('pageerror', (e) => errors.push(e.message));
    await pay.evaluate(() => { window.__files = []; window.__names = []; const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__names.push(this.download); return click.call(this); }; const orig = URL.createObjectURL; URL.createObjectURL = (b) => { b.text().then((t) => window.__files.push(t)); return orig.call(URL, b); };
      // The test server is plain http, where browsers withhold crypto.subtle.
      if (!crypto.subtle) Object.defineProperty(crypto, 'subtle', { value: { digest: async () => new Uint8Array(32).buffer } }); });
    await pay.click('#tabs [data-tab="payouts"]');
    await pay.click('#payoutsBody [data-act="payout-export"]');
    await pay.click('#payoutsBody [data-act="payout-export"]');
    await pay.waitForFunction(() => (window.__files || []).length && (window.__rpcCalls || []).some((c) => c[0] === 'fp'), null, { timeout: 5000 });
    const [file] = await pay.evaluate(() => window.__files);
    const rpcCalls = await pay.evaluate(() => window.__rpcCalls);
    R.ok('the claim runs before the file exists', rpcCalls[0][0] === 'claim');
    const [fname] = await pay.evaluate(() => window.__names);
    R.ok('a program switch mid-claim does not relabel the file', /^payouts-creators-/.test(fname || ''));
    R.has(file, 'Pat Trails', 'the payee comes from the program that was exported');
    R.has(file, PA, 'the claimed payout is in the file');
    R.not(file, PB, 'a payout the database did not claim is not in the file');
    R.ok('the fingerprint is recorded against the claimed batch', rpcCalls.some((c) => c[0] === 'fp' && c[1].p_batch === 'batch-1'));
    await pay.selectOption('#programSel', PROG);
    await pay.waitForFunction(() => /Pat Trails/.test(document.querySelector('#payoutsBody')?.textContent || ''), null, { timeout: 5000 });
    await pay.click('#tabs [data-tab="payouts"]');
    R.has(await text(pay, '#commissionsBody'), '$1,234.56', 'a period total comes from the database, not the lines on the page');
    await pay.close();

    // ── staff page, as a member who cannot manage ─────────────────────────
    const member = await suite.open('/v2/affiliates/index.html', tables, { ready, rpc: { can_manage_affiliate_programs: false, can_approve_affiliate_commissions: false } });
    member.on('pageerror', (e) => errors.push(e.message));
    await member.click('#tabs [data-tab="prospects"]');
    R.ok('a member is not offered approve/reject', !(await member.$('#prospectsBody [data-act="prospect-status"]')))
    R.ok('a member is not offered AI research or import', !(await member.$('#prospectsBody [data-act="research-run"]')) && !(await member.$('#prospectsBody [data-act="import-run"]')));
    await member.click('#tabs [data-tab="payouts"]');
    R.ok('a member is not offered payouts', !(await member.$('#payoutsBody [data-act="payout-build"]')))
    R.has(await text(member, '#status'), 'You can view Affiliate Studio', 'the page says why the buttons are missing');
    await member.close();

    // ── join page ─────────────────────────────────────────────────────────
    const calls = [];
    let program = { name: 'Creators', status: 'active', terms_markdown: 'Rule one.\n\n<img src=x onerror="window.__pwned=1">', terms_version: 3, currency: 'USD', commission: { kind: 'percent_of_net', percent: 10, fixed_cents: null } };
    await suite.context.route('**/functions/v1/affiliate-portal', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      const reply = (status, json) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
      if (body.token === 'E'.repeat(43)) {
        if (body.action === 'renew') return reply(200, { status: 'sent_if_eligible', message: 'If this link belongs to an active affiliate, a new one is on its way to the address on file.' });
        return reply(404, { error: 'This link has expired or is no longer valid.', code: 'invalid_link' });
      }
      if (body.action === 'resolve') return reply(200, { purpose: body.token.startsWith('P') ? 'portal' : 'signup', brand: 'Brand A', program, affiliate: { display_name: 'Pat', status: 'invited' }, expires_at: now });
      if (body.action === 'accept') return reply(200, { status: 'active', portal_url: 'https://app.test/v2/affiliates/portal.html?t=' + 'P'.repeat(43), confirmation_email: 'sent' });
      if (body.action === 'statement') return reply(200, { brand: 'Brand A', statement: { currency: 'USD', totals: { earned_cents: 1250, paid_cents: 0, unclaimed_cents: 1250, orders: 2 }, monthly: [{ month: '2026-11', orders: 2, amount_cents: 1250 }], codes: [{ code: 'PAT10', starts_on: '2026-10-01', ends_on: null, status: 'active' }], links: [], payouts: [], affiliate: { status: 'active', terms_version_accepted: 3, terms_accepted_at: now } } });
      if (body.action === 'apply') return reply(200, { status: 'received' });
      return reply(400, { error: 'unexpected' });
    });
    const join = await suite.open('/v2/affiliates/join.html?t=' + 'S'.repeat(43), {}, { ready: () => !!document.getElementById('form') });
    join.on('pageerror', (e) => errors.push(e.message));
    R.ok('the token is removed from the address bar', !(await join.evaluate(() => location.search.includes('t='))))
    R.ok('terms are rendered as text: no element from the brand text', !(await join.evaluate(() => document.querySelector('.af-terms img'))))
    R.ok('nothing in the terms runs', !(await join.evaluate(() => window.__pwned)))
    R.ok('the affiliate page carries no SILO navigation', !(await join.$('.silo-sidebar, nav.silo-nav, #silo-app')))
    await join.fill('#signed', 'Pat Trails');
    await join.check('#agree');
    await join.click('#go');
    await join.waitForFunction(() => /You are in/.test(document.body.textContent), null, { timeout: 5000 });
    const acc = calls.find((c) => c.action === 'accept');
    R.eq(acc?.terms_version, 3, 'acceptance sends the version that was on screen');
    R.eq(acc?.signed_name, 'Pat Trails');
    await join.close();

    // ── portal page ───────────────────────────────────────────────────────
    const portal = await suite.open('/v2/affiliates/portal.html?t=' + 'P'.repeat(43), {}, { ready: () => !document.getElementById('kpis').hidden });
    R.has(await text(portal, '#kpis'), '$12.50', 'the portal shows earnings in the program currency');
    R.has(await text(portal, '#body'), 'PAT10', 'the portal lists the affiliate code');
    await portal.close();
    const expiredPortal = await suite.open('/v2/affiliates/portal.html?t=' + 'E'.repeat(43), {}, { ready: () => !!document.getElementById('renew') });
    await expiredPortal.click('#renew');
    await expiredPortal.waitForFunction(() => !document.getElementById('status').hidden, null, { timeout: 5000 });
    R.has(await text(expiredPortal, '#status'), 'If this link belongs to an active affiliate', 'renewal never confirms whose link it was');
    await expiredPortal.close();

    // ── apply page ────────────────────────────────────────────────────────
    const apply = await suite.open('/v2/affiliates/apply.html?c=' + PROG + '&p=creators', {}, { ready: () => !!document.getElementById('form') });
    await apply.fill('#name', 'Lee'); await apply.fill('#email', 'lee@creator.invalid'); await apply.fill('#handle', '@lee');
    await apply.click('#go');
    await apply.waitForFunction(() => /received/.test(document.body.textContent), null, { timeout: 5000 });
    const ap = calls.find((c) => c.action === 'apply');
    R.eq(ap?.company_id, PROG, 'the application carries the company from the link');
    R.eq(ap?.website, '', 'the honeypot is sent empty by a person');
    await apply.close();

    R.eq(errors, [], 'no page errors on any affiliate page');
    R.ok('the whole flow ran to the end', true);
  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
