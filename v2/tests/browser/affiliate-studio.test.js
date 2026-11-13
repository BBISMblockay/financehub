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
 *     simulated / waiting / unconfigured);
 *   - the affiliate pages strip the token from the address bar, render the
 *     brand's terms as text (an <img onerror> in the terms stays inert), send
 *     the version shown when accepting, and offer renewal on an expired link;
 *   - the affiliate pages carry no SILO navigation.
 *
 * Mutations (each must fail at least one assertion):
 *   AFFILIATE_UI_MUTATION=nullzero    an unknown money amount renders as $0.00
 *   AFFILIATE_UI_MUTATION=termshtml   the program terms are rendered as HTML
 *   AFFILIATE_UI_MUTATION=tokenurl    the token is left in the address bar
 *   AFFILIATE_UI_MUTATION=silentswitch a link from the brand's team hides the menu with no way forward
 *   AFFILIATE_UI_MUTATION=codeblame   the banner blames a missing code when the store address is missing
 *   AFFILIATE_UI_MUTATION=membergate  a member is shown the manager buttons
 *   AFFILIATE_UI_MUTATION=exportlocal the payout file is built from the page's
 *                                     rows instead of what the database claimed
 *   AFFILIATE_UI_MUTATION=exportctx   the export reads the program after the claim,
 *                                     so a program switch mid-claim mislabels it
 *   AFFILIATE_UI_MUTATION=periodtotal a period total is summed from the 300
 *                                     ledger lines the page holds
 *   AFFILIATE_UI_MUTATION=sendwhileopen a payout with an attempt in flight is offered another Send
 *   AFFILIATE_UI_MUTATION=sendnoaddress a payout is offered Send before the affiliate gave an address
 *   AFFILIATE_UI_MUTATION=connflag   the page looks for a `connected` flag the status view does not have
 *   AFFILIATE_UI_MUTATION=nostalereload a failed send leaves the row offering Send over stale data
 *   AFFILIATE_UI_MUTATION=sandboxlabel a sandbox send is presented as a real payment
 *   AFFILIATE_UI_MUTATION=logoignored the join and portal pages ignore the company logo
 *   AFFILIATE_UI_MUTATION=logoanyurl  the pages show a logo from any address
 *   AFFILIATE_UI_MUTATION=feedhtml    a shared item's title is rendered as HTML in the portal
 *   AFFILIATE_UI_MUTATION=calpast     the calendar keeps drops whose date has passed
 *   AFFILIATE_UI_MUTATION=adnoimage   sharing an ad does not publish its picture for affiliates
 *   AFFILIATE_UI_MUTATION=pendingactive a code for the AI to create is saved as already live
 *   AFFILIATE_UI_MUTATION=codestate   code badges judge dates by UTC, not the company's own day
 *   AFFILIATE_UI_MUTATION=autocodeold settings sends the automatic-code field before the column exists
 *   AFFILIATE_UI_MUTATION=todocodes   the To do list leaves out codes waiting on the AI
 *   AFFILIATE_UI_MUTATION=todomoney   payouts to approve are listed for someone who cannot approve money
 *   AFFILIATE_UI_MUTATION=photonone   a creator's researched photo is not shown on their card
 *   AFFILIATE_UI_MUTATION=photoaff    an affiliate's card ignores the photo of the prospect they came from
 *   AFFILIATE_UI_MUTATION=photobroken a photo that no longer loads leaves an empty square, not the initials
 *   AFFILIATE_UI_MUTATION=photopng    the portal uploads the rep's photo as it is, not a small square JPEG
 *   AFFILIATE_UI_MUTATION=photostuck   removing the photo leaves it on the card
 *   AFFILIATE_UI_MUTATION=affownphoto an affiliate's card ignores the photo the rep set in the portal
 *   AFFILIATE_UI_MUTATION=sillodraft  a new draft ignores the program's own outreach message
 *   AFFILIATE_UI_MUTATION=todopinch  a long To do list is squeezed by a short window and its last rows are cut off
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
  feedhtml: ['/affiliates/portal.html', '<div class="af-cal-title">${esc(i.title)}</div>', '<div class="af-cal-title">${i.title}</div>'],
  calpast: ['/affiliates/portal.html', "    .filter((i) => !today || day(i.event_on) >= today)\n", ''],
  logoignored: ['/affiliates/public.js', "if (typeof logo === 'string' && LOGO_RE.test(logo)) {", 'if (false) {'],
  logoanyurl: ['/affiliates/public.js', "if (typeof logo === 'string' && LOGO_RE.test(logo)) {", "if (typeof logo === 'string' && logo) {"],
  adnoimage: ['/affiliates/studio.js', 'if (x.image_path) x.image_url = await publishAdImage(x.image_path);', ''],
  autocodeold: ['/affiliates/studio.js', "const hasAutoCode = () => S.programs.some((x) => Object.prototype.hasOwnProperty.call(x, 'default_discount_percent'));", 'const hasAutoCode = () => true;'],
  todocodes: ['/affiliates/studio.js', '  add(pending, `', '  add(0, `'],
  photonone: ['/affiliates/studio.js', '  const photo = prospectPhotoUrl(evidence);\n', '  const photo = null;\n'],
  photoaff: ['/affiliates/studio.js', 'd.prospectById[a.from_prospect_id]?.evidence', 'null'],
  photobroken: ['/affiliates/studio.js', "if (ev.target?.classList?.contains('af-avatar-photo')) ev.target.remove();", ''],
  photopng: ['/affiliates/portal.html', "c.toDataURL('image/jpeg', 0.85)", "c.toDataURL('image/png')"],
  photostuck: ['/affiliates/portal.html', "try { showPhoto(await call('photo', { token, remove: true }));", "try { await call('photo', { token, remove: true });"],
  affownphoto: ['/affiliates/studio.js', 'affiliatePhotoUrl(a, d.prospectById[a.from_prospect_id]?.evidence)', 'prospectPhotoUrl(d.prospectById[a.from_prospect_id]?.evidence)'],
  sillodraft: ['/affiliates/studio.js', 'const tpl = outreachTemplate(prog());', 'const tpl = outreachTemplate({});'],
  todopinch: ['/affiliates/index.html', '.silo-main.af-studio > * { flex-shrink: 0; }', ''],
  todomoney: ['/affiliates/studio.js', '  add(MONEY && toApprove,', '  add(toApprove,'],
  codestate: ['/affiliates/portal.html', '${codeState(c, t.today)}', '${codeState(c, new Date().toISOString().slice(0, 10))}'],
  pendingactive: ['/affiliates/studio.js', "...(ai ? { status: 'pending', discount_percent: pct } : {})", '...{}'],
  silentswitch: ['/affiliates/portal.html', '  if (!brands.length) {', '  if (false) {'],
  codeblame: ['/affiliates/portal.html', '      : `<span class="af-sub">${feed?.code', '      : `<span class="af-sub">${false'],
  periodtotal: ['/affiliates/studio.js', 'const t = d.periodTotals.filter((r) => r.period_id === x.id);', "const t = [{ currency: 'USD', amount_cents: d.ledger.filter((l) => l.period_id === x.id).reduce((a, l) => a + Number(l.amount_cents), 0) }];"],
  // The PayPal rail (20261113040000).
  sendwhileopen: ['/affiliates/studio.js', "      const openAttempt = Boolean(sn && ['unknown', 'sent', 'unclaimed'].includes(sn.state));", '      const openAttempt = false;'],
  sandboxlabel: ['/affiliates/studio.js', "        const test = connEnv !== 'live';", '        const test = false;'],
  // The page must block a send on the SAME rule the claim uses, or a sandbox
  // test leaves the real payment unreachable (review cycle 2, finding 3).
  envblock: ['/affiliates/studio.js', "      const blocking = openAttempt && (snEnv === 'live' || snEnv === connEnv);", '      const blocking = openAttempt;'],
  nostalereload: ['/affiliates/studio.js', "    if (RELOAD_AFTER_FAILURE.has(b.dataset.act)) {", '    if (false) {'],
  connflag: ['/affiliates/studio.js', '  return Boolean(conn && conn.is_active !== false && conn.credentials_set);', '  return Boolean(conn && conn.connected);'],
  sendnoaddress: ['/affiliates/studio.js', "      else if (!email) b.push('<span class=\"af-muted\">No PayPal address from them yet</span>');", '      else if (false) b.push(\'\');'],
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
  affiliate_discovery_runs: [{ id: 'r1', company_entity_id: CO, program_id: PROG, query: 'trail running youtube', started_at: now, dry_run: false, status: 'ok', results_returned: 30, profiles_recognized: 4, prospects_new: 1, emails_found: 0, suppressed_skipped: 0, cost_usd: 0.002 }],
  affiliate_prospects: [{ id: 'p1', company_entity_id: CO, program_id: PROG, display_name: 'Sam Runs', platform: 'youtube', handle: '@samruns', profile_url: 'https://www.youtube.com/@samruns', contact_email: null, source: 'serp', source_url: 'https://www.youtube.com/@samruns', collected_at: now, evidence: { title: 'Sam Runs', snippet: 'Trail running every week', query: 'trail running youtube', followers: 12400, followers_source_url: 'https://www.youtube.com/@samruns', followers_as_of: '2026-11-09', profile_image_url: 'https://photos.invalid/samruns.png', profile_image_source_url: 'https://www.youtube.com/@samruns', profile_image_as_of: '2026-11-09' }, confidence: 0.45, confidence_basis: 'recognised youtube profile; niche words in title', status: 'new' }],
  affiliate_suppressions: [],
  affiliate_outreach_drafts: [], affiliate_outreach_batches: [],
  affiliates: [{ id: AFF, company_entity_id: CO, program_id: PROG, display_name: 'Pat Trails', contact_email: 'pat@creator.invalid', status: 'active', terms_version_accepted: 2, terms_accepted_at: now, created_at: now, from_prospect_id: 'p1' }],
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
  affiliate_feed_items: [{ id: 'f1', company_entity_id: CO, program_id: PROG, kind: 'product', source_id: 'trail-hat', title: 'Trail Hat', image_url: null, product_path: '/products/trail-hat', shared_at: now }],
  launch_calendar: [{ id: 'lc1', company_entity_id: CO, title: 'Spring Drop', launch_date: '2099-03-01', launch_image_url: 'https://cdn.invalid/spring.png', landing_page_url: 'https://brand.invalid/collections/spring', status: 'planned' }],
  shopify_connections: [{ company_entity_id: CO, shop_domain: 'brand-a.myshopify.com', is_active: true }, { company_entity_id: CO, shop_domain: 'brand-a-retail.myshopify.com', is_active: true }],
  products_master: [{ company_entity_id: CO, product_title: 'Trail Hat', product_type: 'Hat', image_url: null, shopify_handle: 'trail-hat' }],
  entity_memberships: [{ entity_id: CO, user_id: 'u1' }],
};
const ready = () => !!document.querySelector('#overviewBody .bcn-card');
const openMore = (page) => page.evaluate(() => document.querySelectorAll('details.af-more').forEach((d) => { d.open = true; }));
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel);

(async () => {
  const suite = await startSuite({ transform });
  const errors = [];
  try {
    // ── staff page, as a manager ──────────────────────────────────────────
    const AD_IMG = `${CO}/${'ab12'.repeat(16)}.jpg`;
    const PHOTO_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await suite.context.route('https://photos.invalid/samruns.png', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PHOTO_PNG }));
    const page = await suite.open('/v2/affiliates/index.html', tables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true,
      ad_studio_ads: () => [
        { ad_id: 'ad1', ad_name: 'Mud season v2', title: 'Mud season', body: 'Grip that holds.', link_path: '/products/mud-shoe', image_path: `test-company/${'ab12'.repeat(16)}.jpg`, image_shared_by: 1, recent_spend: 50, last_day: '2026-11-08', effective_status: 'ACTIVE' },
        { ad_id: 'ad2', ad_name: 'Catalog', title: 'All releases', body: 'x', image_path: `test-company/${'cd34'.repeat(16)}.jpg`, image_shared_by: 9, recent_spend: 90, last_day: '2026-11-08' },
        { ad_id: 'ad3', ad_name: 'No picture', title: 'Text only', body: 'y', image_path: null, recent_spend: 10, last_day: '2026-11-08' }] } });
    page.on('pageerror', (e) => errors.push(e.message));
    // Simple page: six tabs (Overview added), Overview first, the To do list on it.
    R.ok('the page has six tabs', (await page.$$('#tabs [data-tab]')).length === 6);
    R.ok('the page opens on Overview', await page.evaluate(() => document.querySelector('#tabs .bcn-tab--active')?.dataset.tab === 'overview'));
    const over = await text(page, '#overviewBody');
    R.has(over, 'Sales from codes', 'Overview leads with how the program is doing');
    R.has(over, '$50', 'sales come from the EARNING attribution only, not the refused one');
    R.has(over, 'Commission unpaid', 'owed money is what has not been paid, not what no payout has claimed');
    R.has(over, 'Top affiliates', 'Overview names who is carrying the program');
    R.has(over, 'Reach out', 'Overview names who needs a message');
    R.has(over, 'PAT10', 'a live code with no order is a reason to reach out');
    R.ok('the nudge can be copied', !!(await page.$('#overviewBody [data-act="ov-copy"]')));
    R.ok('the window can be widened', !!(await page.$('#overviewBody [data-act="ov-window"]')));
    R.not(over, 'undefined', 'no number renders as undefined');
    R.not(over, 'NaN', 'no number renders as NaN');
    R.ok('the strip above the tabs does not repeat the To do list', !(await page.evaluate(() => {
      const el = document.getElementById('nextStep');
      return el && !el.hidden && el.textContent.trim().length > 0;
    })));
    const next = over;
    R.has(next, 'waiting for your review', 'the next-step line says what to do now');
    R.has(next, 'not credited', 'uncredited code orders are surfaced');
    R.has(next, 'To do', 'everything waiting on a person is one list');
    R.has(next, 'earnings to put in a payout', 'unpaid earnings are on the list for a manager');
    R.has(next, 'commissions update every night', 'one line says what runs by itself');
    R.not(await text(page, '#prospectsBody'), 'Fit is scored', 'no scoring jargon on the main list');
    await page.click('#btnSettings');
    await page.waitForFunction(() => !!document.querySelector('#programBody .bcn-card'), null, { timeout: 5000 });
    const ov = await text(page, '#programBody');
    R.has(ov, 'Outreach to prospects', 'settings state how each part works');
    R.ok('a live, successful run makes discovery verified', /Discovery\s*verified/.test(ov))
    R.not(ov, 'Stripe Connect', 'an unbuilt feature is not advertised')
    R.not(ov, 'SILO never', 'the overview says how it works, not what SILO does not do')
    R.not(ov, 'Incremental sales', 'the card lists what SILO does, not what it does not')
    R.ok('a code seen on an order makes code tracking verified', /Code tracking\s*verified/.test(ov))
    for (const tab of ['prospects', 'outreach', 'affiliates', 'share', 'payouts']) {
      await page.click(`#tabs [data-tab="${tab}"]`);
      await page.waitForFunction((t) => !!document.querySelector(`#${t}Body .bcn-card`), tab, { timeout: 5000 });
    }
    // ── Affiliates: a code the person's own AI creates in Shopify ─────────
    await page.click('#tabs [data-tab="affiliates"]');
    R.ok('Affiliates says links wait for a store address', !!(await page.$('#affiliatesBody #storeNeeded')));
    const ab = await text(page, '#affiliatesBody');
    R.has(ab, 'Connect your AI', 'with no AI that can make codes, Affiliates offers to connect one');
    R.eq(await page.inputValue('#cPct'), '10', 'percent off defaults to 10');
    R.eq(await page.inputValue('#cHow'), 'exists', 'with no AI that can make codes, the code is one you made');
    await page.fill('#cCode', 'pat15');
    await openMore(page);
    await page.selectOption('#cHow', 'ai');
    await page.fill('#cPct', '');
    await page.click('#affiliatesBody [data-act="code-add"]');
    await page.waitForFunction(() => !document.getElementById('status').hidden, null, { timeout: 5000 });
    R.has(await text(page, '#status'), 'percent off', 'a code for the AI needs the percent off');
    await page.fill('#cPct', '15');
    await page.click('#affiliatesBody [data-act="code-add"]');
    await page.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_codes' && q._op === 'insert'), null, { timeout: 5000 });
    const codeRow = await page.evaluate(() => { const r = window.__QUERIES__.filter((q) => q.table === 'affiliate_codes' && q._op === 'insert').pop().rows; return Array.isArray(r) ? r[0] : r; });
    R.eq(codeRow?.status, 'pending', 'a code for the AI waits for Shopify');
    R.eq(codeRow?.discount_percent, 15);
    await page.click('#tabs [data-tab="outreach"]');
    const ob = await text(page, '#outreachBody');
    R.has(ob, 'Your own MCP client sends approved messages', 'Messages leads with sending through a connected MCP client');
    R.ok('Connect your AI is the primary action on Messages', !!(await page.$('#outreachBody a.bcn-btn--primary[href="../settings-connect-ai.html"]')));
    R.has(ob, 'while this company is selected', 'with no connection, Messages says to connect for this company');
    await page.click('#tabs [data-tab="prospects"]');
    const pr = await text(page, '#prospectsBody');
    R.has(pr, 'Trail running every week', 'a prospect shows the search result it came from');
    // Creator photo: shown over the initials when research found one; a photo
    // that no longer loads is removed so the initials show again.
    const photoLoaded = (sel) => page.waitForFunction((q) => { const i = document.querySelector(q); return !!i && i.complete && i.naturalWidth > 0; }, sel, { timeout: 5000 }).then(() => true, () => false);
    R.ok('a prospect card shows the researched photo', await photoLoaded('#prospectsBody .af-catalog-thumb img.af-avatar-photo[src="https://photos.invalid/samruns.png"]'));
    R.ok('the photo has no referrer', (await page.getAttribute('#prospectsBody img.af-avatar-photo', 'referrerpolicy').catch(() => null)) === 'no-referrer');
    const broken = await page.evaluate(() => new Promise((done) => {
      const thumb = document.querySelector('#prospectsBody .af-catalog-thumb');
      const img = document.createElement('img'); img.className = 'af-avatar-photo'; img.src = 'https://photos.invalid/expired.png';
      thumb.appendChild(img);
      setTimeout(() => done({ gone: !thumb.contains(img), initials: (thumb.textContent || '').trim() }), 1500);
    }));
    R.ok('an expired photo is removed so the initials show', broken.gone && broken.initials.length > 0);
    await page.click('#tabs [data-tab="affiliates"]');
    R.ok('an affiliate card shows the photo of the prospect they came from', await photoLoaded('#affiliatesBody .af-catalog-thumb img.af-avatar-photo[src="https://photos.invalid/samruns.png"]'));
    await page.click('#tabs [data-tab="prospects"]');
    R.not(pr, '$0.0020', 'discovery cost is not shown to the company');
    R.not(pr, 'GitHub Actions', 'discovery copy names no internal tooling');
    R.not(pr, 'Saved Google searches', 'there are no saved searches to manage: a run searches what was typed');
    R.ok('no saved-search form', !(await page.$('#srcQuery')) && !(await page.$('[data-act="source-add"]')));
    R.ok('there is one search button, not two', !(await page.$('#prospectsBody [data-act="discovery-run"]')) && !!(await page.$('#prospectsBody [data-act="research-run"]')));
    R.ok('a manager can approve a prospect', await page.$('#prospectsBody [data-act="prospect-status"][data-s="approved"]'))
    R.has(await text(page, '#prospectsBody'), '12,400', 'a follower count a page stated is shown');
    R.ok('the follower count links to where it was stated', await page.$('#prospectsBody a[href="https://www.youtube.com/@samruns"]'));
    // Find creators with AI: starts a background run and says so; the company is never sent.
    const researchCalls = [];
    await suite.context.route('**/functions/v1/affiliate-research', (route) => {
      const body = JSON.parse(route.request().postData() || '{}'); researchCalls.push(body);
      if (body.action === 'refresh_photos') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checked: 3, stored: 2 }) });
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
    await openMore(page);
    await page.click('#prospectsBody [data-act="photos-refresh"]');
    await page.waitForFunction(() => /Found 2 photos/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
    const ph = researchCalls.find((c) => c.action === 'refresh_photos');
    R.ok('Refresh photos asks for this program only, never a company', ph && ph.program_id === PROG && !('company_entity_id' in ph));
    R.has(await text(page, '#status'), 'Found 2 photos for 3 creators', 'Refresh photos says what it found');
    await page.click('#tabs [data-tab="payouts"]');
    const cm = await text(page, '#commissionsBody');
    R.has(cm, 'refunds not measured', 'an unmeasured order says why');
    R.has(cm, '—', 'an unknown base renders as a dash');
    R.not(cm, '$0.00', 'an unknown base is never shown as $0');
    await page.click('#tabs [data-tab="payouts"]');
    R.has(await text(page, '#payoutsBody'), 'Pay from your bank or payment tool', 'the payout tab says where money moves');
    // ── Share tab: the brand picks what affiliates see ──────────────────
    await page.click('#tabs [data-tab="share"]');
    await page.waitForFunction(() => /Spring Drop/.test(document.getElementById('shareBody').textContent), null, { timeout: 5000 });
    const sb = await text(page, '#shareBody');
    R.has(sb, 'Trail Hat', 'what is already shared is listed first');
    R.has(sb, 'Mud season', 'recent ads can be shared');
    R.not(sb, 'All releases', 'a catalog template image is not offered as an ad');
    R.not(sb, 'Text only', 'an ad with no picture is not offered');
    R.ok('each recent ad shows its picture', await page.evaluate((p) => [...document.querySelectorAll('#shareBody img')].some((i) => i.getAttribute('src') === 'https://fixture.local/signed/' + p), AD_IMG));
    R.ok('with several Shopify stores and no store address, Studio asks for the address', !!(await page.$('#shareBody #storeNeeded')));
    await page.click('#shareBody [data-act="feed-add"][data-kind="launch"]');
    await page.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_feed_items' && q._op === 'insert'), null, { timeout: 5000 });
    const shared = await page.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_feed_items' && q._op === 'insert').pop().rows);
    const row = Array.isArray(shared) ? shared[0] : shared;
    R.eq(row?.kind, 'launch');
    R.eq(row?.product_path, '/collections/spring', 'a launch shares its store page as a path, never another site');
    R.eq(row?.event_on, '2099-03-01');
    R.ok('only the snapshot fields are shared', row && Object.keys(row).sort().join() === 'company_entity_id,event_on,image_url,kind,note,product_path,program_id,source_id,title');
    await page.waitForFunction(() => document.querySelector('#shareBody [data-act="feed-add"][data-kind="ad"]'), null, { timeout: 5000 });
    await page.click('#shareBody [data-act="feed-add"][data-kind="ad"]');
    await page.waitForFunction(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_feed_items' && q._op === 'insert').length >= 2, null, { timeout: 5000 });
    const adRow = await page.evaluate(() => { const r = window.__QUERIES__.filter((q) => q.table === 'affiliate_feed_items' && q._op === 'insert').pop().rows; return Array.isArray(r) ? r[0] : r; });
    const ups = await page.evaluate(() => window.__UPLOADS__ || []);
    R.ok('sharing an ad publishes exactly its picture to the public feed bucket', ups.some((u) => u.bucket === 'affiliate-feed-images' && u.path === `test-company/${'ab12'.repeat(16)}.jpg`));
    R.eq(adRow?.image_url, `about:blank#test-company/${'ab12'.repeat(16)}.jpg`, 'and the shared ad carries that public picture');
    R.eq(adRow?.note, 'Grip that holds.', 'with its copy, to repost');
    R.eq(adRow?.product_path, '/products/mud-shoe');
    await page.click('#btnSettings');
    R.has(await text(page, '#programBody'), '/v2/affiliates/apply.html?c=test-company&p=creators', 'an open program shows its application link');
    R.ok('before the loop migration, settings has no automatic-code field (saving still works)', !(await page.$('#pAutoPct')));
    R.ok('before 20261111020000, settings has no outreach message box (saving still works)', !(await page.$('#pOutBody')));
    await page.close();

    // ── the loop: after 20261110180000 ────────────────────────────────────
    const loopTables = { ...tables,
      affiliate_programs: [{ ...tables.affiliate_programs[0], default_discount_percent: 10, outreach_subject: 'Ride with {brand}', outreach_body: 'Yo {name}! Join us: {signup_link}' }],
      affiliates: [{ ...tables.affiliates[0], photo_url: 'https://photos.invalid/pat-own.png', photo_hidden: false }],
      affiliate_codes: [...tables.affiliate_codes, { id: 'c2', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, code: 'PAT10-2', starts_on: '2026-11-10', ends_on: null, status: 'pending', discount_percent: 10 }],
      affiliate_payouts: [{ id: 'po-d', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, status: 'draft', amount_cents: 500, currency: 'USD', item_count: 1, created_at: now }] };
    const loop = await suite.open('/v2/affiliates/index.html', loopTables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true } });
    loop.on('pageerror', (e) => errors.push(e.message));
    const todo = await text(loop, '#overviewBody');
    R.has(todo, 'code(s) waiting for your MCP agent to create', 'a code waiting on the AI is on the list');
    R.ok('with a prompt to copy', !!(await loop.$('#overviewBody [data-act="copy-codes-prompt"]')));
    R.has(todo, 'payout(s) to approve', 'a payout to approve is on the list for someone who may approve money');
    // A short window scrolls the page; it never squeezes the To do list and cuts off its last rows.
    await loop.setViewportSize({ width: 1280, height: 520 });
    // The strip above the tabs carries the list on every tab but Overview, and
    // it is the one that clips: measured there, because a child that shrinks to
    // fit a short window cuts off its own last rows.
    await loop.click('#tabs [data-tab="prospects"]');
    await loop.waitForFunction(() => { const el = document.getElementById('nextStep'); return el && !el.hidden && el.textContent.trim().length > 0; }, null, { timeout: 5000 });
    const pinch = await loop.$eval('#nextStep', (el) => el.scrollHeight - el.clientHeight);
    R.ok(`a long To do list is shown whole in a short window (hidden by ${pinch}px)`, pinch <= 1);
    await loop.setViewportSize({ width: 1280, height: 900 });
    // The rep's own photo wins over the one found for them.
    await loop.context().route('https://photos.invalid/pat-own.png', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PHOTO_PNG }));
    await loop.click('#tabs [data-tab="affiliates"]');
    await loop.waitForFunction(() => !!document.querySelector('#affiliatesBody .af-catalog-thumb'), null, { timeout: 5000 });
    R.ok('an affiliate card shows the photo the rep set in the portal', !!(await loop.$('#affiliatesBody img.af-avatar-photo[src="https://photos.invalid/pat-own.png"]')));
    // Approving a creator drafts the program's own message, filled in.
    await loop.click('#tabs [data-tab="prospects"]');
    await loop.waitForFunction(() => !!document.querySelector('#prospectsBody [data-act="prospect-status"][data-s="approved"]'), null, { timeout: 5000 });
    await loop.click('#prospectsBody [data-act="prospect-status"][data-s="approved"]');
    await loop.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'insert'), null, { timeout: 5000 }).catch(() => {});
    const draft = await loop.evaluate(() => { const q = window.__QUERIES__.filter((x) => x.table === 'affiliate_outreach_drafts' && x._op === 'insert').pop(); const r = q?.rows; return Array.isArray(r) ? r[0] : r; });
    R.eq([draft?.subject, draft?.body], ['Ride with Brand A', 'Yo Sam Runs! Join us: {signup_link}'], 'a new draft starts from the program\'s own message, filled in');
    await loop.click('#tabs [data-tab="payouts"]');
    await loop.waitForFunction(() => !!document.querySelector('#payoutsBody .bcn-card'), null, { timeout: 5000 });
    R.has(await text(loop, '#commissionsBody'), 'Commissions update every night', 'the Update button is no longer the way commissions happen');
    await loop.click('#btnSettings');
    R.eq(await loop.inputValue('#pAutoPct'), '10', 'settings shows the % off for new affiliates');
    await loop.fill('#pAutoPct', '');
    R.eq([await loop.inputValue('#pOutSubject'), await loop.inputValue('#pOutBody')], ['Ride with {brand}', 'Yo {name}! Join us: {signup_link}'], 'settings shows the program\'s own outreach message');
    await loop.fill('#pOutBody', 'Hey {name}, here: {signup_link}');
    await loop.click('#programBody [data-act="save-program"]');
    await loop.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_programs' && q._op === 'update'), null, { timeout: 5000 });
    const progRow = await loop.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_programs' && q._op === 'update').pop().patch);
    R.ok('blank saves as off (null), not 0', progRow && 'default_discount_percent' in progRow && progRow.default_discount_percent === null);
    R.eq(progRow?.outreach_body, 'Hey {name}, here: {signup_link}', 'the edited outreach message is saved');
    await loop.close();
    const nomoney = await suite.open('/v2/affiliates/index.html', loopTables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: false } });
    R.not(await text(nomoney, '#overviewBody'), 'payout(s) to approve', 'someone who cannot approve money is not asked to');
    await nomoney.close();

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
    // Send/code allowed on a SILO grant; tab copy stays vendor-neutral (no app name).
    const withAi = { ...tables, silo_api_grants: [
      { id: 'g1', user_id: 'test-user', company_entity_id: CO, client_id: 'c-claude', scopes: ['data:read', 'outreach:send', 'codes:create'], expires_at: '2099-01-01T00:00:00Z', revoked_at: null },
      { id: 'g2', user_id: 'test-user', company_entity_id: CO, client_id: 'c-gpt', scopes: ['data:read'], expires_at: '2099-01-01T00:00:00Z', revoked_at: null },
      { id: 'g3', user_id: 'test-user', company_entity_id: CO, client_id: 'c-old', scopes: ['outreach:send'], expires_at: '2099-01-01T00:00:00Z', revoked_at: '2026-11-01T00:00:00Z' },
    ] };
    const ai = await suite.open('/v2/affiliates/index.html', withAi, { ready, rpc: {
      can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true,
      silo_api_connection_labels: `function () { return [{ grant_id: 'g1', client_name: 'Claude' }, { grant_id: 'g2', client_name: 'ChatGPT' }, { grant_id: 'g3', client_name: 'Old Bot' }]; }`,
    } });
    await ai.click('#tabs [data-tab="outreach"]');
    await ai.waitForFunction(() => !!document.querySelector('#outreachBody .bcn-card'), null, { timeout: 5000 });
    const how = await text(ai, '#aiSendHow');
    R.has(how, 'send approved messages', 'Messages explains send via a connected MCP client');
    R.has(how, 'send allowed', 'Messages ties copy to SILO connection permission');
    R.not(how, 'Claude', 'tab copy does not hardcode an app vendor name');
    R.not(how, 'ChatGPT', 'tab copy does not name other connections');
    R.ok('with an app that can send, the button manages connections instead', !!(await ai.$('#outreachBody a.bcn-btn[href="../settings-connect-ai.html"]:not(.bcn-btn--primary)')) && !(await ai.$('#outreachBody a.bcn-btn--primary[href="../settings-connect-ai.html"]')));
    await ai.click('#tabs [data-tab="affiliates"]');
    await ai.waitForFunction(() => !!document.querySelector('#affiliatesBody #cHow'), null, { timeout: 5000 });
    R.eq(await ai.inputValue('#cHow'), 'ai', 'with an AI that can make codes, new codes default to it');
    R.has(await text(ai, '#aiCodesHow'), 'Shopify codes', 'Affiliates explains codes via MCP without naming an app');
    await ai.evaluate(() => { window.__COPIED__ = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__COPIED__ = t; } } }); });
    await ai.click('#aiCodesHow [data-act="copy-codes-prompt"]');
    await ai.waitForFunction(() => window.__COPIED__ !== null, null, { timeout: 5000 });
    R.has(await ai.evaluate(() => window.__COPIED__), 'mark each one created in SILO', 'one click copies the prompt for their AI');
    await ai.close();

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
      if (body.action === 'signin') return reply(200, { status: 'sent_if_eligible', message: 'If that email belongs to an affiliate, a sign-in link is on its way.' });
      if (body.token === 'E'.repeat(43)) {
        if (body.action === 'renew') return reply(200, { status: 'sent_if_eligible', message: 'If this link belongs to an active affiliate, a new one is on its way to the address on file.' });
        return reply(404, { error: 'This link has expired or is no longer valid.', code: 'invalid_link' });
      }
      // A join link gets a real logo address; a portal link gets one outside the bucket, which must not be shown.
      // The brand menu: [] means this link did not reach the rep's own inbox.
      if (body.action === 'brands') return reply(200, { brands: [] });
      // An N link is a rep whose brand has set no store address: a live code,
      // but no link to build from it.
      if (body.token?.startsWith('N') && body.action === 'statement') {
        return reply(200, { brand: 'Brand A', feed: { code: 'PAT10', store_link: null, items: [] },
          statement: { currency: 'USD', totals: { earned_cents: 0, paid_cents: 0, unclaimed_cents: 0, orders: 0, today: '2026-11-09' }, monthly: [], codes: [{ code: 'PAT10', starts_on: '2026-10-01', ends_on: null, status: 'active' }], links: [], payouts: [], affiliate: { status: 'active', display_name: 'Pat', terms_version_accepted: 3, terms_accepted_at: now } } });
      }
      if (body.action === 'resolve') return reply(200, { purpose: body.token.startsWith('P') || body.token.startsWith('N') ? 'portal' : 'signup', brand: 'Brand A', brand_logo: body.token.startsWith('P') ? 'https://evil.test/pixel.png' : LOGO, program, affiliate: { display_name: 'Pat', status: 'invited' }, expires_at: now });
      if (body.action === 'accept') return reply(200, { status: 'active', portal_url: 'https://app.test/v2/affiliates/portal.html?t=' + 'P'.repeat(43), confirmation_email: 'sent' });
      if (body.action === 'statement') return reply(200, { brand: 'Brand A', photo_url: 'https://photos.invalid/samruns.png', photo_own: false, feed: { code: 'PAT10', store_link: 'https://shop.invalid/discount/PAT10?redirect=%2F', items: [
        { kind: 'launch', title: 'Spring <b>Drop</b>', event_on: '2099-03-01', note: null, image_url: null, link: 'https://shop.invalid/discount/PAT10?redirect=%2Fcollections%2Fspring' },
        { kind: 'launch', title: 'Old drop', event_on: '2026-11-01', note: null, image_url: null, link: 'https://shop.invalid/discount/PAT10?redirect=%2Fcollections%2Fold' },
        { kind: 'launch', title: 'Holiday cap', event_on: '2026-11-12', note: 'Limited run.', image_url: 'https://cdn.invalid/cap.jpg', link: 'https://shop.invalid/discount/PAT10?redirect=%2Fproducts%2Fcap' },
        { kind: 'product', title: 'Trail Hat', image_url: null, link: 'https://shop.invalid/discount/PAT10?redirect=%2Fproducts%2Ftrail-hat' },
        { kind: 'ad', title: 'Mud season', note: 'Grip that holds.', image_url: 'https://cdn.invalid/mud.jpg', link: 'https://shop.invalid/discount/PAT10?redirect=%2Fproducts%2Fmud-shoe' }] }, statement: { currency: 'USD', totals: { earned_cents: 1250, paid_cents: 0, unclaimed_cents: 1250, orders: 2, sales_cents: 12500, today: '2026-11-09' }, monthly: [{ month: '2026-11', orders: 2, amount_cents: 1250 }], codes: [{ code: 'PAT10', starts_on: '2026-10-01', ends_on: '2026-11-09', status: 'active' }, { code: 'PATNEXT', starts_on: '2026-11-10', ends_on: null, status: 'active' }, { code: 'PATOLD', starts_on: '2026-01-01', ends_on: '2026-02-01', status: 'retired' }],
        links: [{ destination_url: 'https://shop.invalid/collections/caps', link: 'https://shop.invalid/discount/PAT10?redirect=%2Fcollections%2Fcaps', starts_on: '2026-10-01', status: 'active' }], payouts: [], affiliate: { status: 'active', terms_version_accepted: 3, terms_accepted_at: now } } });
      if (body.action === 'photo') return reply(200, body.remove ? { photo_url: null, own: false } : { photo_url: 'https://photos.invalid/me.jpg?v=2', own: true });
      if (body.action === 'apply') return reply(200, { status: 'received' });
      return reply(400, { error: 'unexpected' });
    });
    const LOGO = `https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/company-logos/${PROG}/logo-1762758000000.png`;
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await suite.context.route('**/company-logos/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    await suite.context.route('https://cdn.invalid/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    await suite.context.route('https://evil.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    const join = await suite.open('/v2/affiliates/join.html?t=' + 'S'.repeat(43), {}, { ready: () => !!document.getElementById('form') });
    join.on('pageerror', (e) => errors.push(e.message));
    R.ok('the token is removed from the address bar', !(await join.evaluate(() => location.search.includes('t='))))
    R.ok('terms are rendered as text: no element from the brand text', !(await join.evaluate(() => document.querySelector('.af-terms img'))))
    R.ok('nothing in the terms runs', !(await join.evaluate(() => window.__pwned)))
    R.ok('the affiliate page carries no SILO navigation', !(await join.$('.silo-sidebar, nav.silo-nav, #silo-app')))
    const hero = await text(join, '#hero');
    R.ok('the invitation names the brand and leads with the offer', /Join the .+ affiliate program/.test(hero) && /\S/.test(await text(join, '.af-offer-num')));
    R.has(hero, 'Accept the terms', 'the three steps say what happens next');
    R.eq(await join.evaluate(() => document.querySelector('#hero .af-brand img.af-logo')?.getAttribute('src')), LOGO, 'the company logo heads the invitation');
    R.eq(await join.evaluate(() => document.querySelector('#hero img.af-logo')?.alt), 'Brand A', 'with the brand name as its text');
    R.ok('the platform terms are linked next to the program terms', !!(await join.$('a[href="/legal/affiliate-terms.html"]')));
    await join.fill('#signed', 'Pat Trails');
    await join.check('#agree');
    await join.click('#go');
    await join.waitForFunction(() => /You are in/.test(document.body.textContent), null, { timeout: 5000 });
    const acc = calls.find((c) => c.action === 'accept');
    R.eq(acc?.terms_version, 3, 'acceptance sends the version that was on screen');
    R.eq(acc?.platform_terms_version, 1, 'and the platform terms version');
    R.eq(acc?.signed_name, 'Pat Trails');
    await join.close();

    // ── portal page ───────────────────────────────────────────────────────
    const portal = await suite.open('/v2/affiliates/portal.html?t=' + 'P'.repeat(43), {}, { ready: () => !document.getElementById('kpis').hidden });
    R.has(await text(portal, '#kpis'), '$12.50', 'the portal shows earnings in the program currency');
    R.has(await text(portal, '#body'), 'PAT10', 'the portal lists the affiliate code');
    const kp = await text(portal, '#kpis');
    R.has(kp, 'Sales you drove', 'the portal shows the sales the rep drove');
    R.has(kp, '$125.00', 'in the program currency');
    R.has(kp, '10% of each order', 'Earned says what it is a share of');
    const states = await portal.$$eval('.af-chip', (cs) => Object.fromEntries(cs.map((c) => [c.querySelector('.af-chip-code').textContent, c.querySelector('[data-code-state]')?.textContent])));
    // The company's day is Nov 9 (its evening is already Nov 10 in UTC): a code
    // ending Nov 9 still works and one starting Nov 10 has not started.
    R.eq(states, { PAT10: 'Active', PATNEXT: 'Starts 2026-11-10', PATOLD: 'Ended' }, 'each code says whether it works at checkout, on the company\'s own day');
    // The rep's photo: the one SILO found, which they can change or remove.
    R.ok('the portal shows the photo SILO found for the rep', !!(await portal.$('#meCard img[src="https://photos.invalid/samruns.png"]')));
    R.has(await text(portal, '#meCard'), 'We found this photo', 'and says where it came from');
    await suite.context.route('https://photos.invalid/me.jpg?v=2', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PHOTO_PNG }));
    await portal.setInputFiles('#meFile', { name: 'me.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGP4z8AARww4OQD1MQv1NXv7ggAAAABJRU5ErkJggg==', 'base64') });
    await portal.waitForFunction(() => !!document.querySelector('#meCard img[src="https://photos.invalid/me.jpg?v=2"]'), null, { timeout: 5000 }).catch(() => {});
    const up = calls.filter((c) => c.action === 'photo' && c.image);
    R.ok('a picked photo is sent once, as a square JPEG the page made', up.length === 1 && up[0].image.startsWith('/9j/') && up[0].token === 'P'.repeat(43) && !('affiliate_id' in up[0]));
    R.ok('the card shows the new photo', !!(await portal.$('#meCard img[src="https://photos.invalid/me.jpg?v=2"]')));
    await portal.click('#meRemove');
    await portal.waitForFunction(() => (document.getElementById('meCard')?.textContent || '').includes('Add photo'), null, { timeout: 5000 }).catch(() => {});
    R.ok('removing asks the portal to remove it', calls.some((c) => c.action === 'photo' && c.remove === true));
    R.ok('a removed photo leaves the initial', !(await portal.$('#meCard img')) && (await text(portal, '#meCard')).includes('Add photo'));
    const fb = await text(portal, '#body');
    R.has(fb, 'Share and earn', 'the portal shows what the brand shared');
    R.has(fb, 'Spring <b>Drop</b>', 'shared titles are text, never markup');
    R.ok('no element is built from a shared title', !(await portal.$('#body b')));
    if (process.env.PORTAL_SHOT) { await portal.setViewportSize({ width: 1280, height: 900 }); await portal.screenshot({ path: process.env.PORTAL_SHOT, fullPage: true }); await portal.setViewportSize({ width: 390, height: 844 }); await portal.screenshot({ path: process.env.PORTAL_SHOT.replace('.png', '-phone.png'), fullPage: true }); }
    const copies = await portal.$$eval('#hero [data-copy], #body [data-copy]', (b) => b.map((x) => x.dataset.copy));
    R.eq(copies.length, 6, 'a copy button for the store link, each upcoming drop and shared item, and the ad\'s caption');
    const cal = await portal.$$eval('#calendar [data-cal-date]', (rows) => rows.map((r) => r.dataset.cal_date || r.getAttribute('data-cal-date')));
    R.eq(cal, ['2026-11-12', '2099-03-01'], 'the calendar lists upcoming drops soonest first, past ones left off (company day)');
    R.ok('a drop within a week is marked', !!(await portal.$('#calendar [data-cal-date="2026-11-12"].is-soon')) && !(await portal.$('#calendar [data-cal-date="2099-03-01"].is-soon')));
    R.ok('drops sit in the calendar, not the tile grid', !(await portal.$('#feed [data-kind="launch"]')));
    R.ok('an ad\'s caption can be copied to repost', copies.includes('Grip that holds.'));
    R.has(fb, 'Ads to repost', 'shared ads have their own section');
    R.ok('a shared ad shows its picture, with a way to save it', !!(await portal.$('#body .af-media img[src="https://cdn.invalid/mud.jpg"]')) && !!(await portal.$('#body a[href="https://cdn.invalid/mud.jpg"][download]')));
    R.has(fb, 'https://shop.invalid/discount/PAT10?redirect=%2Fcollections%2Fcaps', 'a link to a store page is the code link');
    R.ok('the portal says the link carries the code', /Your code\s*PAT10\s*is applied at checkout/.test(await text(portal, '#hero')));
    R.has(await text(portal, '#hero'), 'Hi Pat', 'the portal greets the affiliate');
    R.ok('a logo address outside the logo bucket is never shown; the initial is', !(await portal.$('#mark img')) && (await text(portal, '#mark .af-badge')) === 'B');
    // A link that did not come from the rep's own inbox opens one brand only.
    // The page says how to get the rest, instead of hiding the menu silently.
    await portal.waitForSelector('#switch #switchBtn', { timeout: 5000 });
    R.eq(await text(portal, '#switch'), 'Switch brand', 'a link from the brand’s team offers a way to switch');
    await portal.click('#switchBtn');
    await portal.waitForSelector('#signin #siEmail', { timeout: 5000 });
    R.has(await text(portal, '#body'), 'came from your brand’s team', 'and says why the menu is not there');
    R.ok('switching asks for the email, never sends a link on its own', !calls.some((c) => c.action === 'signin' || c.action === 'switch'));
    await portal.close();

    // A rep with a live code whose brand has no store address: the banner
    // names the code they can use and the real gap, not a missing code.
    const nostore = await suite.open('/v2/affiliates/portal.html?t=' + 'N'.repeat(43), {}, { ready: () => !document.getElementById('kpis').hidden });
    const nh = await text(nostore, '#hero');
    R.ok('the banner says the code is live', /Your code\s*PAT10\s*is live/.test(nh));
    R.has(nh, 'sets its store address', 'and that the store address is what the link is waiting on');
    R.ok('it never claims there is no code', !nh.includes('once you have a code'));
    await nostore.close();
    const expiredPortal = await suite.open('/v2/affiliates/portal.html?t=' + 'E'.repeat(43), {}, { ready: () => !!document.getElementById('renew') });
    await expiredPortal.click('#renew');
    await expiredPortal.waitForFunction(() => !document.getElementById('status').hidden, null, { timeout: 5000 });
    R.has(await text(expiredPortal, '#status'), 'If this link belongs to an active affiliate', 'renewal never confirms whose link it was');
    R.ok('an expired link also offers email sign-in', !!(await expiredPortal.$('#signin #siEmail')));
    await expiredPortal.close();
    const signin = await suite.open('/v2/affiliates/portal.html', {}, { ready: () => !!document.getElementById('signin') });
    signin.on('pageerror', (e) => errors.push(e.message));
    await signin.fill('#siEmail', 'pat@creator.invalid');
    await signin.click('#siGo');
    await signin.waitForFunction(() => !document.getElementById('status').hidden, null, { timeout: 5000 });
    R.eq(calls.filter((c) => c.action === 'signin').pop()?.email, 'pat@creator.invalid', 'a rep without a link signs in with their email');
    R.has(await text(signin, '#status'), 'If that email belongs to an affiliate', 'sign-in never confirms whose email it is');
    await signin.close();

    // ── company logo upload (Settings -> Company) ─────────────────────────
    const coTables = {
      entities: [{ id: CO, title: 'Brand A', entity_key: 'brand-a', created_at: now }],
      company_settings: [{ company_entity_id: CO, business_timezone: 'America/Los_Angeles', default_currency: 'USD', logo_url: null }],
      entity_memberships: [{ entity_id: CO, user_id: 'test-user', role: 'owner_admin' }],
      supported_business_timezones: [{ tz_name: 'America/Los_Angeles', is_supported: true }],
    };
    const settings = await suite.open('/v2/settings-company.html', coTables, { ready: () => !document.getElementById('btnLogo').disabled });
    R.eq(await text(settings, '#logoPreview .ws-logo-initial'), 'B', 'without a logo the initial shows, as on the affiliate pages');
    await settings.setInputFiles('#logoFile', { name: 'logo.png', mimeType: 'image/png', buffer: PNG });
    await settings.waitForFunction(() => !!document.querySelector('#logoPreview img'), null, { timeout: 5000 });
    const lastLogo = (page) => page.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'company_settings' && q._op === 'update' && 'logo_url' in (q.patch || {})).pop()?.patch.logo_url);
    const saved = await lastLogo(settings);
    R.ok('the logo is saved under this company\'s own folder, with a fresh name', new RegExp(`#${CO}/logo-[0-9]{13}\\.png$`).test(String(saved)));
    R.ok('a replace and a remove are offered once a logo is set', (await text(settings, '#btnLogo')) === 'Replace logo' && !(await settings.$eval('#btnLogoRemove', (b) => b.hidden)));
    await settings.click('#btnLogoRemove');
    await settings.waitForFunction(() => !document.querySelector('#logoPreview img'), null, { timeout: 5000 });
    R.eq(await lastLogo(settings), null, 'remove clears the saved logo');
    await settings.close();
    const viewer = await suite.open('/v2/settings-company.html', { ...coTables, entity_memberships: [{ entity_id: CO, user_id: 'test-user', role: 'admin' }] },
      { ready: () => /Only a workspace owner can change the logo/.test(document.getElementById('logoHint').textContent) });
    R.ok('only an owner is offered the upload', await viewer.$eval('#btnLogo', (b) => b.disabled));
    await viewer.close();

    // ── the PayPal rail (20261113040000) ──────────────────────────────────
    // The page's job here is to never offer a second payment for the same
    // commission. The database refuses one anyway; the UI must not invite it.
    const PP = '66666666-6666-4666-8666-666666666666';
    const ppProgram = [{ ...tables.affiliate_programs[0], payout_method: 'paypal_payouts' }];
    const ppPayout = [{ id: PP, company_entity_id: CO, program_id: PROG, affiliate_id: AFF, status: 'approved', method: 'paypal_payouts', amount_cents: 500, currency: 'USD', item_count: 1, created_at: now, approved_at: now }];
    const ppRpc = { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true };

    const ppOff = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: ppProgram, affiliate_payouts: ppPayout }, { ready, rpc: ppRpc });
    ppOff.on('pageerror', (e) => errors.push(e.message));
    await ppOff.click('#tabs [data-tab="payouts"]');
    const offText = await text(ppOff, '#payoutsBody');
    R.has(offText, 'Connect PayPal', 'an unconnected program is asked to connect');
    R.ok('with somewhere to get Payouts access', !!(await ppOff.$('#payoutsBody a[href*="payoutsweb/landing"]')));
    R.ok('no Send button before PayPal is connected', !(await ppOff.$('#payoutsBody [data-act="pp-send"]')));
    R.has(offText, 'Connect PayPal first', 'and the payout says why it cannot be sent');
    await ppOff.close();

    const connected = [{ company_entity_id: CO, provider: 'paypal', environment: 'sandbox', is_active: true, account_email: 'brand@pay.invalid', payouts_enabled: true, credentials_set: true, last_tested_at: now, last_test_success: true, last_test_error: null, last_send_at: null }];

    const ppNoAddr = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: ppProgram, affiliate_payouts: ppPayout, affiliate_payout_connection_status_v: connected },
      { ready, rpc: ppRpc });
    ppNoAddr.on('pageerror', (e) => errors.push(e.message));
    await ppNoAddr.click('#tabs [data-tab="payouts"]');
    const noAddr = await text(ppNoAddr, '#payoutsBody');
    R.has(noAddr, 'brand@pay.invalid', 'a connected rail names the account it pays from');
    R.has(noAddr, 'No PayPal address from them yet', 'an affiliate who has not given an address cannot be paid');
    R.ok('and there is nothing to click', !(await ppNoAddr.$('#payoutsBody [data-act="pp-send"]')));
    await ppNoAddr.close();

    const ppReady = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: ppProgram, affiliate_payouts: ppPayout, affiliate_payout_connection_status_v: connected,
        affiliate_payout_accounts: [{ company_entity_id: CO, affiliate_id: AFF, provider: 'paypal', payout_email: 'pat@pay.invalid' }] },
      { ready, rpc: ppRpc });
    ppReady.on('pageerror', (e) => errors.push(e.message));
    await ppReady.click('#tabs [data-tab="payouts"]');
    R.ok('an approved payout with an address can be sent', !!(await ppReady.$('#payoutsBody [data-act="pp-send"]')));
    // A sandbox connection pays nobody, and the page must not let anyone
    // believe otherwise: the card says so and the button says which it is.
    const readyText = await text(ppReady, '#payoutsBody');
    R.has(readyText, 'Sandbox: test payments only', 'a sandbox rail says it pays nobody');
    R.has(readyText, 'Test send (sandbox)', 'and the button says which kind of send it is');
    await ppReady.close();

    const ppLive = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: ppProgram, affiliate_payouts: ppPayout,
        affiliate_payout_connection_status_v: [{ ...connected[0], environment: 'live' }],
        affiliate_payout_accounts: [{ company_entity_id: CO, affiliate_id: AFF, provider: 'paypal', payout_email: 'pat@pay.invalid' }] },
      { ready, rpc: ppRpc });
    ppLive.on('pageerror', (e) => errors.push(e.message));
    await ppLive.click('#tabs [data-tab="payouts"]');
    const liveText = await text(ppLive, '#payoutsBody');
    R.has(liveText, 'Send with PayPal', 'a live rail sends for real');
    R.ok('and says nothing about sandbox', !/Sandbox: test payments only/.test(liveText));
    await ppLive.close();

    // The case the whole design is built around: an attempt that never
    // answered. PayPal may already have taken the money, so the page offers
    // Check status and NOT another Send.
    const ppFlight = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: ppProgram, affiliate_payouts: ppPayout, affiliate_payout_connection_status_v: connected,
        affiliate_payout_accounts: [{ company_entity_id: CO, affiliate_id: AFF, provider: 'paypal', payout_email: 'pat@pay.invalid' }],
        affiliate_payout_sends: [{ id: 'send-1', payout_id: PP, attempt: 1, state: 'unknown', provider_status: null, provider_item_id: null, error_code: null, error_message: null, environment: 'sandbox', created_at: now }] },
      { ready, rpc: ppRpc });
    ppFlight.on('pageerror', (e) => errors.push(e.message));
    await ppFlight.click('#tabs [data-tab="payouts"]');
    const flight = await text(ppFlight, '#payoutsBody');
    R.ok('an attempt with no answer is never offered another Send', !(await ppFlight.$('#payoutsBody [data-act="pp-send"]')));
    R.ok('it offers Check status instead', !!(await ppFlight.$('#payoutsBody [data-act="pp-refresh"][data-id]')));
    R.has(flight, 'no answer yet', 'and the row says so in words');
    await ppFlight.close();

    // A sandbox test settles nothing, so it does not stand in the way of the
    // real payment either -- and the database would allow that payment, so a
    // page that hides it strands the payout (review cycle 2, finding 3).
    const ppAfterTest = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: ppProgram, affiliate_payouts: ppPayout,
        affiliate_payout_connection_status_v: [{ ...connected[0], environment: 'live' }],
        affiliate_payout_accounts: [{ company_entity_id: CO, affiliate_id: AFF, provider: 'paypal', payout_email: 'pat@pay.invalid' }],
        affiliate_payout_sends: [{ id: 'send-sbx', payout_id: PP, attempt: 1, state: 'unknown', provider_status: null, provider_item_id: null, error_code: null, error_message: null, environment: 'sandbox', created_at: now }] },
      { ready, rpc: ppRpc });
    ppAfterTest.on('pageerror', (e) => errors.push(e.message));
    await ppAfterTest.click('#tabs [data-tab="payouts"]');
    const afterTest = await text(ppAfterTest, '#payoutsBody');
    R.ok('an open SANDBOX attempt does not block the live payment',
      !!(await ppAfterTest.$('#payoutsBody [data-act="pp-send"]')));
    R.has(afterTest, 'Send with PayPal', 'and it is offered as the real send');
    R.ok('the sandbox attempt is not offered for checking against the live account',
      !(await ppAfterTest.$('#payoutsBody [data-act="pp-refresh"][data-id]')));
    await ppAfterTest.close();

    // The mirror of it: a LIVE attempt in flight blocks everything, and when
    // the sandbox app is the one connected it cannot be checked either, so the
    // page says which account to reconnect.
    const ppLiveFlight = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: ppProgram, affiliate_payouts: ppPayout, affiliate_payout_connection_status_v: connected,
        affiliate_payout_accounts: [{ company_entity_id: CO, affiliate_id: AFF, provider: 'paypal', payout_email: 'pat@pay.invalid' }],
        affiliate_payout_sends: [{ id: 'send-live', payout_id: PP, attempt: 1, state: 'unknown', provider_status: null, provider_item_id: null, error_code: null, error_message: null, environment: 'live', created_at: now }] },
      { ready, rpc: ppRpc });
    ppLiveFlight.on('pageerror', (e) => errors.push(e.message));
    await ppLiveFlight.click('#tabs [data-tab="payouts"]');
    const liveFlight = await text(ppLiveFlight, '#payoutsBody');
    R.ok('a live attempt in flight blocks the sandbox send',
      !(await ppLiveFlight.$('#payoutsBody [data-act="pp-send"]')));
    R.has(liveFlight, 'Reconnect the live PayPal account', 'and says which account can check it');
    await ppLiveFlight.close();

    // A send that fell over mid-call. The attempt is on file as `unknown`, so
    // the page must re-read after the failure: the row that still offers Send
    // is an invitation to pay twice.
    const ppFail = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: ppProgram, affiliate_payouts: ppPayout, affiliate_payout_connection_status_v: connected,
        affiliate_payout_accounts: [{ company_entity_id: CO, affiliate_id: AFF, provider: 'paypal', payout_email: 'pat@pay.invalid' }],
        affiliate_payout_sends: [] },
      { ready,
        rpc: ppRpc,
        edge: { 'affiliate-payouts': { status: 502, body: { state: 'unknown', error: 'PayPal did not answer (socket hang up). The payment may have gone through — use Check status before trying again.' } } } });
    ppFail.on('pageerror', (e) => errors.push(e.message));
    await ppFail.click('#tabs [data-tab="payouts"]');
    // What the failed call left behind at the database.
    await ppFail.evaluate((row) => { window.__FIXTURE_TABLES__.affiliate_payout_sends = [row]; }, {
      id: 'send-f', payout_id: PP, attempt: 1, state: 'unknown', provider_status: null, provider_item_id: null,
      error_code: null, error_message: null, environment: 'sandbox', created_at: now,
    });
    await ppFail.click('#payoutsBody [data-act="pp-send"]');
    await ppFail.click('#payoutsBody [data-act="pp-send"]');   // the confirm
    await ppFail.waitForFunction(() => !document.querySelector('#payoutsBody [data-act="pp-send"]'), { timeout: 5000 }).catch(() => {});
    R.has(await text(ppFail, '#status'), 'may have gone through', 'the person is told the money may have moved');
    R.ok('and the row stops offering Send', !(await ppFail.$('#payoutsBody [data-act="pp-send"]')));
    R.ok('offering Check status instead', !!(await ppFail.$('#payoutsBody [data-act="pp-refresh"]')));
    R.ok('and it was sent to PayPal exactly once', (await ppFail.evaluate(() => window.__EDGE_CALLS__.length)) === 1);
    await ppFail.close();

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
