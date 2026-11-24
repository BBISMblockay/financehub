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
 *   AFFILIATE_UI_MUTATION=endnoshopify ending an affiliate leaves their code working in Shopify
 *   AFFILIATE_UI_MUTATION=endretry    a retry after a half-done ending never reaches Shopify
 *   AFFILIATE_UI_MUTATION=poststate   a post dialog offers decisions the server refuses for that state
 *   AFFILIATE_UI_MUTATION=postbulk    a list of turned-down posts is offered Pay
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
 *   AFFILIATE_UI_MUTATION=seedpush    a launch's products cannot be asked for at the seeding price
 *   AFFILIATE_UI_MUTATION=seedstick   a product asked for keeps offering the button
 *   AFFILIATE_UI_MUTATION=feedhtml    a shared item's title is rendered as HTML in the portal
 *   AFFILIATE_UI_MUTATION=badgenone   a creator who never bought is badged a past customer too
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
 *   AFFILIATE_UI_MUTATION=claimany   claiming one drop marks a different one
 *   AFFILIATE_UI_MUTATION=pushalways a drop says what to push before anyone claimed it
 *   AFFILIATE_UI_MUTATION=ordersrestart Show more asks for the first page again
 *   AFFILIATE_UI_MUTATION=ordersshut   Show more closes an order the rep had opened
 *   AFFILIATE_UI_MUTATION=ordersgid    an order with no shop number shows its raw store id
 *   AFFILIATE_UI_MUTATION=qmsgsent    Approve all also approves messages already sent
 *   AFFILIATE_UI_MUTATION=qcodesall   Make codes gives a second code to an affiliate who has one
 *   AFFILIATE_UI_MUTATION=qpayanycur  Build payouts includes balances in another currency
 *   AFFILIATE_UI_MUTATION=autopaymoney the Friday auto-pay switch is live for someone who cannot approve money
 *   AFFILIATE_UI_MUTATION=autopayearly the Friday auto-pay switch is shown before its columns exist
 *   AFFILIATE_UI_MUTATION=listnophoto the list view drops the photos
 *   AFFILIATE_UI_MUTATION=bulkunsent  a refused invite in a bulk approval is dropped silently
 *   AFFILIATE_UI_MUTATION=addlinkhidden a refused invite for someone added by hand puts the link on a hidden tab
 *   AFFILIATE_UI_MUTATION=grantall    a grant made for one program is made for every program
 *   AFFILIATE_UI_MUTATION=grantlabel  a grant that covers one program is listed as covering all
 *   AFFILIATE_UI_MUTATION=mgrhard     the grant list is blank where program_id is not applied yet
 *   AFFILIATE_UI_MUTATION=whoeveryone a share named for some creators still says everyone sees it
 *   AFFILIATE_UI_MUTATION=audsilent   an audience that could not be read is treated as nobody named
 *   AFFILIATE_UI_MUTATION=audknown    the page offers to change an audience it never read
 *   AFFILIATE_UI_MUTATION=whoprecheck the audience dialog opens with everyone ticked, changing what the share means
 *   AFFILIATE_UI_MUTATION=whoscope    a save replaces the whole audience, not only the creators it offered
 *   AFFILIATE_UI_MUTATION=personprog a program they are already in is offered again
 *   AFFILIATE_UI_MUTATION=affpaged    the creator list is not read paged, so a big program is cut at one page
 *   AFFILIATE_UI_MUTATION=whoended    a creator who left the program is offered a share
 *   AFFILIATE_UI_MUTATION=peoplescope People reads only the program picked
 *   AFFILIATE_UI_MUTATION=peopletwice somebody in two programs is two Discovery cards
 *   AFFILIATE_UI_MUTATION=pickershown the program picker still shows on People
 *   AFFILIATE_UI_MUTATION=ctxprog     a People button works in the picked program, not its row's
 *   AFFILIATE_UI_MUTATION=draftownprog a drafted message is filed under the picked program
 *   AFFILIATE_UI_MUTATION=drafttemplate a drafted message uses the picked program's wording
 *   AFFILIATE_UI_MUTATION=supoffer    somebody on do not contact is offered to another program
 *   AFFILIATE_UI_MUTATION=afftwice    an affiliate in two programs is two cards
 *   AFFILIATE_UI_MUTATION=loadgen     a slower People read lands last and shows every program on a program tab
 *   AFFILIATE_UI_MUTATION=supignored  the do-not-contact list is not checked when grouping people
 *   AFFILIATE_UI_MUTATION=supfailopen an unread do-not-contact list still offers people to other programs
 *   AFFILIATE_UI_MUTATION=suppaged    the do-not-contact list is one capped read
 *   AFFILIATE_UI_MUTATION=prospaged   People reads a capped prospect list instead of every page
 */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const assert = require('node:assert/strict');
const R = createReporter('affiliate-studio');

const MUTATIONS = {
  // ── Access: a grant may name one program, a share may name creators ──
  // A grant that ignores the program picked puts the person over every one.
  grantall: ['/affiliates/studio.js', "    const forProgram = $('mgrProgram') ? (val('mgrProgram') || null) : null;", '    const forProgram = null;'],
  // A grant list that calls every grant company-wide hides who is scoped.
  grantlabel: ['/affiliates/studio.js', "  const covers = (r) => (r.program_id ? `${progLabel(r.program_id)} only` : 'All programs');", "  const covers = () => 'All programs';"],
  // Reading the grant list must survive the column not being there yet.
  mgrhard: ['/affiliates/studio.js', "  if (full.error) {\n"
    + "    scoped = false;\n"
    + "    rows = (await db.from('affiliate_program_managers').select('id, user_id, created_at').eq('company_entity_id', CO)).data || [];\n"
    + "  } else { rows = full.data || []; }",
    '  rows = full.data || [];'],
  // A share that says "Everyone" when creators are named misstates who sees it.
  whoeveryone: ['/affiliates/studio.js', "  const who = (f) => { const n = audOf(f.id).length; return n ? `${num(n)} of ${num(inProgram.length)}` : 'Everyone'; };", "  const who = () => 'Everyone';"],
  // A read that failed must not be saved over as "nobody named", which
  // would hand a narrowed share to the whole program.
  audsilent: ['/affiliates/studio.js', "      if (error) return error.code === '42P01' ? [] : null;", '      if (error) return [];'],
  audknown: ['/affiliates/studio.js', '  const audKnown = Array.isArray(d.audience);', '  const audKnown = true;'],
  // The dialog must open on what the share means now, not pre-tick everyone.
  whoprecheck: ['/affiliates/studio.js', "${picked.has(x.id) ? ' checked' : ''}", " checked"],
  whoscope: ['/affiliates/studio.js', 'p_affiliates: want, p_scope: boxes.map((x) => x.value)', 'p_affiliates: want'],
  personprog: ['/affiliates/studio.js', '    const canAdd = otherPrograms().filter((x) => !inIds.has(x.id));', '    const canAdd = otherPrograms();'],
  affpaged: ['/affiliates/studio.js', '  const [res, affRead] = await Promise.all([Promise.all(Object.values(q)), loadAffiliates(p)]);',
    '  const [res, affRead] = await Promise.all([Promise.all(Object.values(q)), Promise.resolve(null)]);'],
  // Somebody who left the program is not someone to share with.
  whoended: ['/affiliates/studio.js', "      const live = (d.affiliates || []).filter((x) => x.status !== 'ended');", '      const live = (d.affiliates || []);'],
  listnophoto: ['/affiliates/studio.js', 'const listThumb = (person, photo) => `<span class="af-list-thumb">${photoAvatar(person, photo)}</span>`;', 'const listThumb = (person) => `<span class="af-list-thumb">${personAvatar(person)}</span>`;'],
  bulkunsent: ['/affiliates/studio.js', " else unsent.push({ name: x.display_name || x.handle || x.contact_email, out }); }", ' }'],
  addlinkhidden: ['/affiliates/studio.js', "sendInvite(row.id, email, 'mpOut')", 'sendInvite(row.id, email)'],
  // Autosave reads the form and the program when it fires, not when edited.
  storepickall: ['/affiliates/studio-core.js', 'row.shop_domains = on.length === f.shop_domains.length ? null : on;', 'row.shop_domains = null;'],
  // A store whose list HAS been read and holds no match must not fall back to
  // the company-wide list, which offers handles that store cannot use.
  storeunread: ['/affiliates/studio.js', "    return (seen.error || !seen.data || !seen.data.length) ? null : [];", '    return null;'],
  // The media is taken out of flow so a percentage height resolves; laid out
  // in the grid cell instead, a tall photo stands outside its tile.
  tilefree: ['/affiliates/index.html', `    .af-studio .af-ctile-media > img, .af-studio .af-ctile-media > video {
      position: absolute; inset: 0; width: 100%; height: 100%;
      max-width: 100%; max-height: 100%; object-fit: cover;
    }
    /* And a hard ceiling in pixels on anything else that turns up in a row,
       since a percentage is only as good as the box it resolves against. */
    .af-studio .af-ctile img:not(.af-avatar-photo), .af-studio .af-ctile video {
      max-width: 72px; max-height: 54px;
    }`, ''],
  // A message sent by hand must be markable where the draft is.
  draftsent: ['/affiliates/studio.js', "${btn('Mark as sent', 'draft-sent-now', { id: x.id }, 'primary')}", ''],
  // Marking it sent without recording the approval leaves the row half-told.
  draftsentappr: ['/affiliates/studio.js', "        approved_by: x.approved_by || me.id,\n        approved_at: x.approved_at || stamp,", ''],
  // A hundred posts to review means a wall of tiles, not a column of rows.
  qgrid: ['/affiliates/studio.js', "want === 'new' ? 'Nothing new. Affiliates post from their portal.' : 'Nothing here.', { grid: true }",
    "want === 'new' ? 'Nothing new. Affiliates post from their portal.' : 'Nothing here.'"],
  // The creator's photo in no wrapper draws at whatever size they uploaded,
  // which is how it became the big image on the tile.
  ctilephoto: ['/affiliates/studio.js', '<div class="af-ctile-who">${listThumb({ name: a?.display_name, email: a?.contact_email }, affiliatePhotoUrl(a || {}))}<span class="af-ctile-name">',
    '<div class="af-ctile-who">${photoAvatar({ name: a?.display_name, email: a?.contact_email }, affiliatePhotoUrl(a || {}))}<span class="af-ctile-name">'],
  // Opening a post is the only way to see it whole; without it the wall is
  // a wall of thumbnails and nothing can be judged.
  ctileopen: ['/affiliates/studio.js', "  'content-open': ({ id }) => { S.contentOpen = id; render(); return null; },", ''],
  // A decision taken on the opened post must be about that post.
  // The dialog offers what the server will do to a post in THIS state.
  poststate: ['/affiliates/studio.js', "  const live = ['submitted', 'approved'].includes(x.state);", '  const live = true;'],
  postbulk: ['/affiliates/studio.js', "    ...(canUse && !['paid', 'no'].includes(want) ? [[payLabel, 'q-content-use', 'primary', { confirm: bonus > 0 }]] : []),", "    ...(canUse && want !== 'paid' ? [[payLabel, 'q-content-use', 'primary', { confirm: bonus > 0 }]] : []),"],
  ctileone: ['/affiliates/studio.js', 'const act = (lbl, k, kind, opts) => btn(lbl, \'content-decide\', { id: x.id, k }, kind, opts);',
    "const act = (lbl, k, kind, opts) => btn(lbl, 'content-decide', { id: (S.d.content || []).map((y) => y.id).join(','), k }, kind, opts);"],
  // A file the browser cannot play must say so, not sit there as a blank box.
  vidblank: ['/affiliates/studio.js', "  if (!t?.classList?.contains('af-content-media')) return;", '  return;'],
  // The picture has to survive the two lists disagreeing about the handle.
  picnotitle: ['/affiliates/studio.js', '  const bare = out.filter((x) => !x.image_url && x.product_title);\n  if (!bare.length) return out;', '  return out;'],
  // A chip swap rebuilds the body, so it must carry what is typed with it.
  // Your Customers (20261124030000).
  custeager: ['/affiliates/studio.js',
    "  if (S.peopleSub === 'customers' && !c.loaded && !c.loading) queueMicrotask(() => loadCustomers());",
    '  if (!c.loaded && !c.loading) queueMicrotask(() => loadCustomers());'],
  custgate: ['/affiliates/studio.js',
    "    if (spec.consentIsNull) q = q.is('email_consent_state', null);\n    else if (spec.consentState) q = q.eq('email_consent_state', spec.consentState);",
    "    q = q.eq('email_consent_state', spec.consentState || 'subscribed');"],
  custsuppick: ['/affiliates/studio.js',
    "  const pickable = (x) => MANAGE && !!customerContactPath(x, c.social[x.customer_key], S.d?.suppressions || []);",
    '  const pickable = (x) => MANAGE && !!x.email_lc;'],
  // Blake 2026-11-24: everyone found is listed, and the consent tag picks the
  // path -- an unsubscribed customer gets a DM draft, never an email one.
  unsubemail: ['/affiliates/studio.js',
    "channel: path.channel,\n            recipient_email: path.email, recipient_handle: path.handle,",
    "channel: 'email',\n            recipient_email: x.email_lc, recipient_handle: null,"],
  consentsnap: ['/affiliates/studio.js', "      .map((x) => ({ ...x, email_consent_state: nowConsent.get(x.customer_key) }));", '      ;'],
  poolcopyall: ['/affiliates/studio.js', "  const row = assignedProspectRow(x, p.id, status);", "  const { id: _drop, ...rest } = x; const row = { ...rest, program_id: p.id, status };"],
  // People sit above programs (Blake 2026-11-24).
  peoplescope: ['/affiliates/studio.js', "  const company = peopleScope();\n  if (!company && isAll()) return loadAllData(gen);", "  const company = false;\n  if (isAll()) return loadAllData(gen);"],
  peopletwice: ['/affiliates/studio.js', '  const people = groupPeople(d.prospects, d.suppressions);', '  const people = d.prospects.map((x) => ({ key: x.id, x, rows: [x], programIds: [x.program_id], suppressed: x.status === \'suppressed\' }));'],
  pickershown: ['/affiliates/studio.js', "  const sel = $('programSel'); if (sel) sel.hidden = company;", ''],
  ctxprog: ['/affiliates/studio.js', '    if (pg && pg !== S.programId) { S.programId = pg;', '    if (false) { S.programId = pg;'],
  draftownprog: ['/affiliates/studio.js', "      company_entity_id: CO, program_id: x.program_id, prospect_id: id, channel: path.channel,", "      company_entity_id: CO, program_id: S.programId, prospect_id: id, channel: path.channel,"],
  drafttemplate: ['/affiliates/studio.js', '  const p = progOf(x) || prog();\n  return x?.source', '  const p = prog();\n  return x?.source'],
  supoffer: ['/affiliates/studio.js', '  const addTo = (g) => (MANAGE && !g.suppressed', '  const addTo = (g) => (MANAGE'],
  loadgen: ['/affiliates/studio.js', '  if (gen !== loadGen) return;\n  S.d = d;\n  // A research run', '  S.d = d;\n  // A research run'],
  supignored: ['/affiliates/studio.js', '  const people = groupPeople(d.prospects, d.suppressions);', '  const people = groupPeople(d.prospects);'],
  supfailopen: ['/affiliates/studio.js', '  d.supUnknown = !supRead;', '  d.supUnknown = false;'],
  suppaged: ['/affiliates/studio.js', "      const { data, error } = await db.from('affiliate_suppressions').select('*').eq('company_entity_id', CO)\n        .order('created_at', { ascending: false }).order('id', { ascending: true })\n        .range(i * OV_PAGE_SIZE, i * OV_PAGE_SIZE + OV_PAGE_SIZE - 1);", "      const { data, error } = await db.from('affiliate_suppressions').select('*').eq('company_entity_id', CO)\n        .order('created_at', { ascending: false }).order('id', { ascending: true });"],
  prospaged: ['/affiliates/studio.js', ".order('collected_at', { ascending: false }).order('id', { ascending: true })\n        .range(i * OV_PAGE_SIZE, i * OV_PAGE_SIZE + OV_PAGE_SIZE - 1);", ".order('collected_at', { ascending: false }).limit(2000);"],
  afftwice: ['/affiliates/studio.js', "(multiProg ? itemList(shownP, personCard, affEmpty, 'grid') : itemList(affShown, affiliateRow, affEmpty, 'grid'))", "itemList(affShown, affiliateRow, affEmpty, 'grid')"],
  unsubhidden: ['/affiliates/studio.js', "const HUNT_NEVER = ['redacted'];", "const HUNT_NEVER = ['unsubscribed', 'redacted'];"],
  // Source is what picks the template, on every path that writes a draft.
  custcreatorpitch: ['/affiliates/studio.js',
    "  return x?.source === 'customer'\n    ? { tpl: customerOutreachTemplate(p)",
    "  return false\n    ? { tpl: customerOutreachTemplate(p)"],
  // Redrafting a mixed queue must read each draft's own source.
  custmixedredraft: ['/affiliates/studio.js',
    '      const { tpl, vars } = draftFor(S.d.prospectById[x.prospect_id]);',
    '      const { tpl, vars } = { tpl: outreachTemplate(prog()), vars: outreachVars(S.d.prospectById[x.prospect_id]) };'],
  // A read that has been superseded must not land on the newer one's view.
  custstale: ['/affiliates/studio.js',
    "    if (!mine()) return;\n    c.rows = data || [];",
    '    c.rows = data || [];'],
  // The database's duplicate refusal is adopted, not reported as a failure.
  custdupeadopt: ['/affiliates/studio.js',
    "            if (e?.code !== '23505') throw e;\n            id = must(await db.from('affiliate_prospects').select('id')",
    "            throw e;\n            id = must(await db.from('affiliate_prospects').select('id')"],
  // Find their social accounts (20261124170000).
  scanjoinbtn: ['/affiliates/studio.js', "{ disabled: running })", "{ disabled: false })"],
  scannopoll: ['/affiliates/studio.js', "  if (c.scan?.status !== 'running' || S.peopleSub !== 'customers') return;", '  return;'],
  scanfilters: ['/affiliates/studio.js', "filters: { sort: spec.sort, minOrders: spec.minOrders, consent: spec.consent, from: spec.from, to: c.to || null },", 'filters: {},'],
  // The scan is the company's: a program filter on its reads hides finds
  // when the person switches program, and a program in the press makes it
  // one program's again.
  scanprogram: ['/affiliates/studio.js', "    db.from('affiliate_customer_scans').select(SCAN_COLS).eq('company_entity_id', CO)\n", "    db.from('affiliate_customer_scans').select(SCAN_COLS).eq('company_entity_id', CO).eq('program_id', S.programId)\n"],
  socialprogram: ['/affiliates/studio.js', "db.from('affiliate_customer_social').select(SOCIAL_COLS).eq('company_entity_id', CO).in('customer_key', keys)", "db.from('affiliate_customer_social').select(SOCIAL_COLS).eq('company_entity_id', CO).eq('program_id', S.programId).in('customer_key', keys)"],
  hiddenpage: ['/affiliates/studio.js', "    if (!page || page.length < 1000) break;\n    after = page[page.length - 1].id;", '    break;'],
  termsnotsent: ['/affiliates/studio.js', "      ...(c.scanTerms === null ? {} : { terms: c.scanTerms }),", ''],
  pressprogram: ['/affiliates/studio.js', "      action: 'customer_scan', finds: c.scanCount,", "      action: 'customer_scan', program_id: S.programId, finds: c.scanCount,"],
  foundbaronly: ['/affiliates/studio.js', ".eq('company_entity_id', CO).in('status', ['found', 'below', 'no_count'])", ".eq('company_entity_id', CO).eq('status', 'found')"],
  huntall: ['/affiliates/studio.js', "  q = q.in('status', HUNT_TIERS[t]);", "  q = q.in('status', [...HUNT_TIERS.top, ...HUNT_TIERS.more]);"],
  // Likely is the score's call: a name-only find over the bar must not sit
  // with the Likely ones.
  huntnoscore: ['/affiliates/studio.js', "  if (t === 'top') return q.gte('match_score', LIKELY_SCORE);", "  if (t === 'top') return q;"],
  huntoptout: ['/affiliates/studio.js', "      .or(`email_consent_state.is.null,email_consent_state.not.in.(${HUNT_NEVER.join(',')})`);\n    if (p.error) throw p.error;", "      ;\n    if (p.error) throw p.error;"],
  huntnolive: ['/affiliates/studio.js', "  const live = running\n    ? `<div class=\"af-hunt-live\"", "  const live = false\n    ? `<div class=\"af-hunt-live\""],
  huntrecent: ['/affiliates/studio.js', "  if (sc?.status === 'running') {\n    const r = await", "  if (false) {\n    const r = await"],
  huntlanding: ['/affiliates/studio.js', "  view: 'hunt', huntTier: 'top', hunt: null,", "  view: 'all', huntTier: 'top', hunt: null,"],
  nothemrpc: ['/affiliates/studio.js', "    must(await db.rpc('affiliate_customer_social_reject', { p_id: id }));\n", ''],
  tierpill: ['/affiliates/studio.js', "pill(v.pill, v.trust === 'likely' ? 'pos' : 'warn')", "pill('Likely', 'pos')"],
  socialevidence: ['/affiliates/studio.js', "customerProspectRow({ customer: x, social: c.social[x.customer_key] || null })", 'customerProspectRow({ customer: x })'],
  // A prospect whose message never landed is finished on a retry.
  custnoresume: ['/affiliates/studio.js',
    "          const has = drafted.has(id) || (must(await db.from('affiliate_outreach_drafts').select('id')",
    "          const has = true || (must(await db.from('affiliate_outreach_drafts').select('id')"],
  chipwipe: ['/affiliates/studio.js', "    if (k === S.commsTab) return null;\n"
    + "    if ($('tplBody')) S.tplDraft = { subject: val('tplSubject'), body: $('tplBody').value };\n"
    + "    if ($('custTplBody')) S.custTplDraft = { subject: val('custTplSubject'), body: $('custTplBody').value };\n"
    + "    S.commsTab = k;\n    keepFields('outreachBody', renderOutreach);",
    '    S.commsTab = k;\n    renderOutreach();'],
  // Drafts and archived products have no public page, so a share of one is a
  // dead link.
  storedrafts: ['/affiliates/studio.js', "    .or('shopify_status.eq.active,shopify_status.is.null')\n", ''],
  autonothrottle: ['/affiliates/studio.js', "if (!MANAGE || !id || autoRefreshing === id || !autoRefreshDue(id)) return;", "if (!MANAGE || !id || autoRefreshing === id) return;"],
  paidsilent: ['/affiliates/studio.js', 'return `Recorded as paid.${await tellPayout(id)}`;', "return 'Recorded as paid.';"],
  refreshwipes: ['/affiliates/studio.js', "S.tab !== 'program' && !formDirty();", "S.tab !== 'program';"],
  norecheck: ['/affiliates/studio.js', '      if (quiet()) render();', '      render();'],
  nocatchup: ['/affiliates/studio.js', '  announcePaidPayouts();\n', '\n'],
  savelate: ['/affiliates/studio.js', 'pendingSave = { id: S.programId, row: programRowFromForm() };', 'pendingSave = { get id() { return S.programId; }, get row() { return programRowFromForm(); } };'],
  nullzero: ['/affiliates/studio-core.js', "if (minor === null || minor === undefined || minor === '' || !Number.isFinite(Number(minor))) return '—';", 'if (minor === undefined) return \'—\'; minor = Number(minor) || 0;'],
  termshtml: ['/affiliates/public.js', 'return paras.length ? paras.map((p) => `<p>${esc(p).replace(/\\n/g, \'<br>\')}</p>`).join(\'\')', 'return paras.length ? paras.map((p) => `<p>${p}</p>`).join(\'\')'],
  tokenurl: ['/affiliates/public.js', "if (url.searchParams.has('t')) { url.searchParams.delete('t'); history.replaceState(null, '', url.pathname + url.search); }", ''],
  membergate: ['/affiliates/studio.js', 'const MANAGE = canManage === true;', 'const MANAGE = true;'],
  exportlocal: ['/affiliates/studio.js', 'const csv = toCsv(PAYOUT_HEADER, payoutRows(r.payouts || [], affById));', "const csv = toCsv(PAYOUT_HEADER, payoutRows(S.d.payouts.filter((x) => x.status === 'approved'), S.d.affById));"],
  exportctx: ['/affiliates/studio.js', 'download(`payouts-${slug}-${today()}.csv`, csv);', 'download(`payouts-${prog().slug}-${today()}.csv`, csv);'],
  badgenone: ['/affiliates/studio-core.js', "  if (!['possible', 'likely', 'confirmed'].includes(st)) return null;", '  if (false) return null;'],
  feedhtml: ['/affiliates/portal.html', '<div class="af-cal-title">${esc(i.title)}</div>', '<div class="af-cal-title">${i.title}</div>'],
  calpast: ['/affiliates/portal.html', "    .filter((i) => !today || day(i.event_on) >= today)\n", ''],
  logoignored: ['/affiliates/public.js', "if (typeof logo === 'string' && LOGO_RE.test(logo)) {", 'if (false) {'],
  logoanyurl: ['/affiliates/public.js', "if (typeof logo === 'string' && LOGO_RE.test(logo)) {", "if (typeof logo === 'string' && logo) {"],
  adnoimage: ['/affiliates/studio.js', 'if (x.image_path) x.image_url = await publishAdImage(x.image_path);', ''],
  autocodeold: ['/affiliates/studio.js', "const hasAutoCode = () => S.programs.some((x) => Object.prototype.hasOwnProperty.call(x, 'default_discount_percent'));", 'const hasAutoCode = () => true;'],
  todocodes: ['/affiliates/studio.js', '  add(pending, `', '  add(0, `'],
  photonone: ['/affiliates/studio.js', 'prospectPhotoUrl(x.evidence)', 'null'],
  photoaff: ['/affiliates/studio.js', 'd.prospectById[a.from_prospect_id]?.evidence', 'null'],
  photobroken: ['/affiliates/studio.js', "if (t?.classList?.contains('af-avatar-photo')) { ev.target.remove(); return; }", ''],
  photopng: ['/affiliates/portal.html', "c.toDataURL('image/jpeg', 0.85)", "c.toDataURL('image/png')"],
  photostuck: ['/affiliates/portal.html', "try { showPhoto(await call('photo', { token, remove: true }));", "try { await call('photo', { token, remove: true });"],
  affownphoto: ['/affiliates/studio.js', 'affiliatePhotoUrl(a, d.prospectById[a.from_prospect_id]?.evidence)', 'prospectPhotoUrl(d.prospectById[a.from_prospect_id]?.evidence)'],
  sillodraft: ['/affiliates/studio.js', '    : { tpl: outreachTemplate(p), vars: outreachVars(x, p) };', '    : { tpl: outreachTemplate({}), vars: outreachVars(x, p) };'],
  todomoney: ['/affiliates/studio.js', '  add(MONEY && toApprove,', '  add(toApprove,'],
  codestate: ['/affiliates/portal.html', '${codeState(c, t.today)}', '${codeState(c, new Date().toISOString().slice(0, 10))}'],
  resumenomake: ['/affiliates/studio.js', "    return waiting?.length ? `Affiliate active. ${await makeInShopify(waiting.map((r) => r.id))}` : 'Affiliate active.';", "    return 'Affiliate active.';"],
  makeall: ['/affiliates/studio.js', "makeInShopify(id ? [id] : S.d.codes.filter((c) => c.status === 'pending').map((c) => c.id))", 'makeInShopify(id ? [id] : S.d.codes.map((c) => c.id))'],
  pendingactive: ['/affiliates/studio.js', "...(ai ? { status: 'pending', discount_percent: pct } : {})", '...{}'],
  silentswitch: ['/affiliates/portal.html', '  if (!brands.length) {', '  if (false) {'],
  codeblame: ['/affiliates/portal.html', '      : `<span class="af-sub">${feed?.code', '      : `<span class="af-sub">${false'],
  periodtotal: ['/affiliates/studio.js', 'const t = d.periodTotals.filter((r) => r.period_id === x.id);', "const t = [{ currency: 'USD', amount_cents: d.ledger.filter((l) => l.period_id === x.id).reduce((a, l) => a + Number(l.amount_cents), 0) }];"],
  // The PayPal rail (20261113040000).
  connflag: ['/affiliates/studio.js', '  return Boolean(conn && conn.is_active !== false && conn.credentials_set);', '  return Boolean(conn && conn.connected);'],
  // Claims and the order list (20261113070000).
  seedpush: ['/affiliates/portal.html', "${esc(p.title)}${seedBtn({ kind: 'product', id: p.id })}</span>", "${esc(p.title)}</span>"],
  seedstick: ['/affiliates/portal.html', "    document.querySelectorAll('[data-seed]').forEach((x) => { if (seedFor(x.dataset.seed)) x.outerHTML = seedBtn({ kind: 'product', id: x.dataset.seed }); });\n", ''],
  seedqall: ['/affiliates/studio.js', "    const ids = (S.d.seeds || []).filter((x) => x.state === 'requested').map((x) => x.id);", "    const ids = (S.d.seeds || []).map((x) => x.id);"],
  seedloudfail: ['/affiliates/studio.js', "    if (r.error && keys[i] === 'seeds') { d.seeds = null; return; }\n", ''],
  claimany: ['/affiliates/portal.html', '    const item = (FEED?.items || []).find((x) => x.id === id);', '    const item = (FEED?.items || [])[0];'],
  pushalways: ['/affiliates/portal.html', '    const push = i.claimed && (i.push || []).length', '    const push = (i.push || []).length'],
  ordersshut: ['/affiliates/portal.html', "${ORD.open.has(o.order_id) ? ' open' : ''}", ''],
  // The raw Shopify id, shown to the rep as it is stored.
  ordersgid: ['/affiliates/portal.html', '${esc(orderLabel(o))}', '${esc(o.order_number || o.order_id)}'],
  orderpending: ['/affiliates/portal.html', "      : o.payable_from && String(o.payable_from).slice(0, 10) > today ? `pending · refund window ends ${day(o.payable_from)}`\n", ''],
  ordersrestart: ['/affiliates/portal.html', "    const r = await call('orders', { token, limit: ORDERS_PAGE, offset: ORD.rows.length });", "    const r = await call('orders', { token, limit: ORDERS_PAGE, offset: 0 });"],
  nostalereload: ['/affiliates/studio.js', "    if (RELOAD_AFTER_FAILURE.has(b.dataset.act)) {", '    if (false) {'],
  sendwhileopen: ['/affiliates/studio.js', "  const blocked = open && (attemptEnv === 'live' || attemptEnv === connEnv);", '  const blocked = false;'],
  // The page must block on the same states the claim does -- dropping `paid`
  // is how Test send was offered on a payout already paid (first sandbox run).
  paidblocks: ['/affiliates/studio.js', "const BLOCKS_A_SEND = ['unknown', 'sent', 'unclaimed', 'paid'];", "const BLOCKS_A_SEND = ['unknown', 'sent', 'unclaimed'];"],
  // ...and on the same environment rule: a sandbox test must not stand in the
  // way of the real payment (review cycle 2, finding 3).
  envblock: ['/affiliates/studio.js', "  const blocked = open && (attemptEnv === 'live' || attemptEnv === connEnv);", '  const blocked = open;'],
  sandboxlabel: ['/affiliates/studio.js', "    test: connEnv !== 'live',", '    test: false,'],
  // Send all approved must send only what a row would send one at a time.
  sendallskips: ['/affiliates/studio.js', '    .filter((x) => sendState(x).sendable);', '    .filter(() => true);'],
  // One check per page load. Without the flag, every render calls PayPal.
  autocheck: ['/affiliates/studio.js', '  if (ppAutoChecked) return;', '  if (false) return;'],
  // Each check names its payout: the untargeted refresh reads only the oldest
  // 50 open attempts, so a newer one can starve behind them (review cycle 1).
  // Ending an affiliate leaves their code working in Shopify (audit 2026-11-18).
  moneyshown: ['/affiliates/studio.js', 'const SEES_MONEY = MANAGE || MONEY;', 'const SEES_MONEY = true;'],
  endcut: ['/affiliates/studio.js', "    for (const part of chunk(ids, 25)) results", "    for (const part of [ids.slice(0, 25)]) results"],
  endmissingok: ['/affiliates/studio.js', "  for (const id of ids) if (!answered.has(id)) results.push(", "  for (const id of []) if (!answered.has(id)) results.push("],
  exportall: ['/affiliates/studio.js', "!isDm(x) && (!only || only.includes(x.id))).slice(0, 200);", "!isDm(x)).slice(0, 200);"],
  // The only way back to a file for messages already marked exported.
  batchstuck: ['/affiliates/studio.js', "      const waiting = !b.fingerprint && d.drafts.some((x) => x.batch_id === b.id && x.state === 'exported');", '      const waiting = false;'],
  exportstale: ['/affiliates/studio.js', "    const m = done.length ? await A['outreach-export']({ only: done }) : 'Nothing was exported.';", "    for (const x of S.d.drafts) if (email.includes(x.id)) x.state = 'approved';\n    const m = await A['outreach-export']({ only: email });"],
  applystale: ['/affiliates/studio.js', "    if (ctl) ctl.innerHTML = applyLinkCtl({ ...fresh, ...row });", ''],
  setupnext: ['/affiliates/studio.js', "${!x.done && i === next ? x.go : ''}", "${!x.done ? x.go : ''}"],
  stepnoresend: ['/affiliates/studio.js', "${fixEmail}${canInvite ? btn('Resend', 'invite-send', { id: from.id }) : ''}`\n      : invite ?", "${fixEmail}`\n      : invite ?"],
  fixemailaff: ['/affiliates/studio.js', "      if (aff) fixed = (await updateRows('affiliates', { contact_email: row.contact_email, changed_by: me.id }, { id: aff.id })).length > 0;", ''],
  endnoshopify: ['/affiliates/studio.js', "    if (s === 'terminated') {", '    if (false) {'],
  // A retry after a half-done ending must still reach Shopify.
  endretry: ['/affiliates/studio.js', "      const owed = codes.filter((c) => !c.shopify_ended_at\n        && (c.status === 'active' || (c.status === 'retired' && (c.shopify_discount_id || c.source === 'manual'))));", "      const owed = live.filter((c) => c.status === 'active');"],
  untargeted: ['/affiliates/studio.js', "await invoke('affiliate-payouts', { action: 'refresh', payout_id: id });", "await invoke('affiliate-payouts', { action: 'refresh' });"],
  checkfirst: ['/affiliates/studio.js', '    .sort((x, y) => OPEN_RANK[x.state] - OPEN_RANK[y.state])\n', ''],
  checkotherenv: ['/affiliates/studio.js', "    .filter((sn) => (sn.environment === 'live' ? 'live' : 'sandbox') === connEnv)", '    .filter(() => true)'],
  // The worklist is its own query of open attempts, not the newest-200
  // history the rows are drawn from (review cycle 2).
  checkfromcache: ['/affiliates/studio.js', "    const page = must(await q.order('id', { ascending: false }).limit(OPEN_PAGE)) || [];", '    const page = Object.values(S.d.sendByPayout).filter((sn) => sn.state in OPEN_RANK);'],
  // Paged by keyset, not offset: the open set shrinks while it is read, and
  // an offset then skips the row that slid into the gap (review of #1274).
  offsetpage: ['/affiliates/studio.js', "    if (after) q = q.lt('id', after);", '    if (after) q = q.range(rows.length, rows.length + OPEN_PAGE - 1);'],
  sendnoaddress: ['/affiliates/studio.js', "      else if (!st.email) b.push('<span class=\"af-muted\">No PayPal address from them yet</span>');", '      else if (false) b.push(\'\');'],
  // The pinched Home (Blake, 2026-11-13).
  qmsgsent: ['/affiliates/studio.js', "    const ids = S.d.drafts.filter((x) => x.state === 'draft').map((x) => x.id);", '    const ids = S.d.drafts.map((x) => x.id);'],
  qcodesall: ['/affiliates/studio.js', "    const todo = S.d.affiliates.filter((a) => a.status === 'active' && !coded.has(a.id));", "    const todo = S.d.affiliates.filter((a) => a.status === 'active');"],
  qpayanycur: ['/affiliates/studio.js', "    const owed = (S.d.balances || []).filter((x) => x.currency === p.currency && Number(x.unclaimed_cents) > 0);", '    const owed = (S.d.balances || []).filter((x) => Number(x.unclaimed_cents) > 0);'],
  autopaymoney: ['/affiliates/studio.js', "${MONEY ? '' : ' disabled title=", "${true ? '' : ' disabled title="],
  // Queues and content (20261117050000).
  qpickall: ['/affiliates/studio.js', "    const ids = picked('msgs'); if (!ids.length) return 'Tick at least one.';\n    const rows", "    const ids = S.d.drafts.filter((x) => x.state === 'draft').map((x) => x.id);\n    const rows"],
  contentmoney: ['/affiliates/studio.js', '  const canUse = MANAGE && (!bonus || MONEY);', '  const canUse = MANAGE;'],
  dmexport: ['/affiliates/studio.js', "const ready = readyAll.filter((x) => !isDm(x)); const readyDm = readyAll.filter(isDm);", 'const ready = readyAll; const readyDm = [];'],
  nocontacted: ['/affiliates/studio.js', "  if (['new', 'qualified', 'approved'].includes(x.status) && !live.has(x.id) && !contacted.has(x.id)) b.push(btn('Mark contacted'", "  if (false) b.push(btn('Mark contacted'"],
  noinbound: ['/affiliates/studio.js', "  const applied = d.prospects.filter((x) => x.source === 'applied' && ['new', 'qualified'].includes(x.status));", '  const applied = [];'],
  showempty: ['/affiliates/studio.js', "const card = (title, body, meta = '', extraClass = '') => (EMPTY_ONLY.test(body) ? ''", "const card = (title, body, meta = '', extraClass = '') => (false ? ''"],
  moneyplain: ['/affiliates/studio.js', "  moneyTop(),\n  payConnCard(),", "  payConnCard(),"],
  editnomove: ['/affiliates/studio.js', "    if (row.contact_email && row.contact_email !== (x.contact_email || '').toLowerCase()) {", '    if (false) {'],
  tplsetup: ['/affiliates/studio.js', "    ...($('pBonus') ? { content_bonus: val('pBonus') } : {}),", "    ...($('pBonus') ? { content_bonus: val('pBonus') } : {}), outreach_subject: '', outreach_body: '',"],
  autopayearly: ['/affiliates/studio.js', "  const hasAutoPay = Object.prototype.hasOwnProperty.call(p, 'payout_mode');", '  const hasAutoPay = true;'],
};
const MUT = process.env.AFFILIATE_UI_MUTATION || '';
assert.ok(!MUT || MUTATIONS[MUT], `Unknown mutation ${MUT}`);
const stale = (name, rel) => {
  console.error(`mutation ${name}: pattern missing in ${rel} -- the mutation is stale, not caught`);
  process.exit(3);
};
const transform = (rel, source) => {
  // Every plain run re-checks EVERY mutation's pattern against the file it
  // belongs to. A sweep only asks "did the suite fail?", so a pattern that has
  // drifted out of the source fails for the wrong reason and reads exactly
  // like a guard under test -- the guard is then untested for as long as
  // nobody looks. Four of these had drifted at once after one refactor.
  if (!MUT) {
    for (const [name, [file, from]] of Object.entries(MUTATIONS)) {
      if (rel.endsWith(file) && !source.includes(from)) stale(name, rel);
    }
    return source;
  }
  if (!rel.endsWith(MUTATIONS[MUT][0])) return source;
  const [, from, to] = MUTATIONS[MUT];
  // A pattern that no longer matches the source is the dangerous case: the
  // suite then fails for the wrong reason and a sweep that only asks "did it
  // fail?" reads a stale mutation as a guard under test. Exit 3 so the sweep
  // can tell the two apart.
  if (!source.includes(from)) stale(MUT, rel);
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
  affiliate_prospects: [{ id: 'p1', company_entity_id: CO, program_id: PROG, display_name: 'Sam Runs', platform: 'youtube', handle: '@samruns', profile_url: 'https://www.youtube.com/@samruns', contact_email: null, source: 'serp', source_url: 'https://www.youtube.com/@samruns', collected_at: now, evidence: { title: 'Sam Runs', snippet: 'Trail running every week', query: 'trail running youtube', followers: 12400, followers_source_url: 'https://www.youtube.com/@samruns', followers_as_of: '2026-11-09', profile_image_url: 'https://photos.invalid/samruns.png', profile_image_source_url: 'https://www.youtube.com/@samruns', profile_image_as_of: '2026-11-09', creator_profile: { version: 1, engagement: { avg_views: 4000, rate: 0.02, sample: 12, source: 'youtube_api' }, topics: { value: ['Running'] }, brand_mentions: { domains: [{ domain: 'shoe.example', videos: 3 }], sponsored_videos: 2, sample: 12 }, other_profiles: [{ platform: 'instagram', profile_url: 'https://www.instagram.com/samruns' }] } }, confidence: 0.45, confidence_basis: 'recognised youtube profile; niche words in title', status: 'new', customer_match_status: 'likely', customer_match_score: 0.8, customer_match_basis: 'exact name match, and their handle carries the same name', customer_order_count: 2, customer_last_order_at: '2026-07-20T18:00:00Z', customer_lifetime_spend: 321, customer_matched_at: now },
    { id: 'p-nobuy', company_entity_id: CO, program_id: PROG, display_name: 'Never Bought', platform: 'tiktok', handle: '@neverbought', profile_url: 'https://www.tiktok.com/@neverbought', contact_email: null, source: 'serp', collected_at: now, evidence: { profile_image_url: 'https://photos.invalid/neverbought.png', profile_image_source_url: 'https://www.tiktok.com/@neverbought', profile_image_as_of: '2026-11-09' }, status: 'new', customer_match_status: 'none', customer_matched_at: now }],
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
// People is where the page opens now (Blake 2026-11-20), so that is the
// panel that renders first; the program's numbers are one tab along.
const ready = () => { const el = document.getElementById('prospectsBody'); return !!el && el.innerHTML.trim().length > 0; };
// Nothing is folded away (Blake, 2026-11-13): detail and admin views live,
// open, on the Records tab.
// Codes, links and new creators are added from People (2026-11-17: fewer forms).
// A modal left open covers the tabs, as it does for a person: close it first.
const closeDialog = (page) => page.evaluate(() => document.getElementById('afDialog')?.close());
// The program's numbers sit on the Program tab, one along from People, and
// only the open tab renders.
// Outreach is one list at a time now, picked from chips (Blake 2026-11-20).
const commsChip = async (p, k) => { await p.click(`#outreachBody [data-act="comms-tab"][data-k="${k}"]`); await p.waitForFunction((x) => document.querySelector(`#outreachBody [data-act="comms-tab"][data-k="${x}"]`)?.getAttribute('aria-selected') === 'true', k, { timeout: 5000 }); };
const toProgram = async (p) => { await p.click('#tabs [data-tab="overview"]'); await p.waitForFunction(() => !!document.getElementById('overviewBody')?.innerHTML.trim(), null, { timeout: 5000 }); };
// People is two sub-tabs now (Blake 2026-11-20): Affiliates and Discovery.
// Clicking anything in the creators list means picking Discovery first.
const toDiscovery = async (page) => {
  await closeDialog(page);
  await page.click('#tabs [data-tab="people"]');
  await page.click('#peopleSubtabs [data-k="discovery"]');
  await page.waitForSelector('#prospectsBody', { state: 'visible', timeout: 5000 });
};
// One sub-tab shows one list. `hidden` on a flex box does nothing without a
// CSS rule, which is how both lists showed at once (Blake 2026-11-20).
const peopleSubVisible = (page) => page.evaluate(() => ({
  aff: !!document.getElementById('affiliatesBody')?.offsetParent,
  pros: !!document.getElementById('prospectsBody')?.offsetParent,
}));
// A creator row shows two buttons; the rest are behind More, in the pop-up.
const openProspectMore = async (page, id) => {
  await toDiscovery(page);
  if (await page.$(`#prospectsBody [data-act="prospect-more"][data-id="${id}"]`)) {
    await page.click(`#prospectsBody [data-act="prospect-more"][data-id="${id}"]`);
    await page.waitForSelector('#afDialogBody .af-actions', { timeout: 5000 });
  }
};
// Lists are the default now (Blake 2026-11-20), so a card test picks Tiles.
const toTiles = async (page, body = '#prospectsBody') => {
  if (await page.$(`${body} .af-item--catalog`)) return;
  await page.click(`${body} [data-act="view-set"][data-v="tiles"]`);
  await page.waitForSelector(`${body} .af-item--catalog`, { timeout: 5000 });
};
// Back to the Affiliates sub-tab: its list is hidden while Discovery is up.
const toAffiliates = async (page) => {
  await closeDialog(page);
  await page.click('#tabs [data-tab="people"]');
  await page.click('#peopleSubtabs [data-k="affiliates"]');
  await page.waitForSelector('#affiliatesBody', { state: 'visible', timeout: 5000 });
};
const openCodeTool = async (page, k = 'code') => {
  await toAffiliates(page);
  await page.click(`#affiliatesBody [data-act="aff-tool"][data-k="${k}"]`);
  await page.waitForSelector(k === 'code' ? '#afDialogBody #cCode' : '#afDialogBody #lDest', { timeout: 5000 });
};
const openAddCreators = async (page) => {
  await closeDialog(page);
  await page.click('#tabs [data-tab="people"]');
  if (!(await page.$('#afDialogBody #mpName'))) { await toDiscovery(page); await page.click('#prospectsBody [data-act="add-creators"]'); }
  await page.waitForSelector('#afDialogBody #mpName', { timeout: 5000 });
};
const openRecords = async (page) => {
  await closeDialog(page);
  await page.click('#tabs [data-tab="records"]');
  await page.waitForFunction(() => !!document.querySelector('#recordsBody .bcn-card'), null, { timeout: 5000 });
};
// Records shows one list at a time, picked by chip (Blake 2026-11-17).
const recTab = async (page, k) => { await page.click(`#recordsBody [data-act="rec-tab"][data-k="${k}"]`); await page.waitForSelector(`#recordsBody [data-k="${k}"][aria-selected="true"]`, { timeout: 5000 }); };
// The portal shows one tab at a time (Blake 2026-11-17).
const tab = (page, k) => page.click(`#tabs [data-tab="${k}"]`);
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel);

(async () => {
  const suite = await startSuite({ transform });
  const errors = [];
  try {
    // ── staff page, as a manager ──────────────────────────────────────────
    const AD_IMG = `${CO}/${'ab12'.repeat(16)}.jpg`;
    const PHOTO_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await suite.context.route('https://photos.invalid/samruns.png', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PHOTO_PNG }));
    const researchCalls = [];
    await suite.context.route('**/functions/v1/affiliate-research', (route) => {
      const body = JSON.parse(route.request().postData() || '{}'); researchCalls.push(body);
      if (body.action === 'refresh_photos') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checked: 3, stored: 2 }) });
      if (body.action === 'import') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kept: 2, prospects_new: 2, prospects_updated: 0, skipped_minors: 1, skipped_not_profile: 0, suppressed_skipped: 0 }) });
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ run_id: 'r9' }) });
    });
    const page = await suite.open('/v2/affiliates/index.html', tables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true,
      ad_studio_ads: () => [
        { ad_id: 'ad1', ad_name: 'Mud season v2', title: 'Mud season', body: 'Grip that holds.', link_path: '/products/mud-shoe', image_path: `test-company/${'ab12'.repeat(16)}.jpg`, image_shared_by: 1, recent_spend: 50, last_day: '2026-11-08', effective_status: 'ACTIVE' },
        { ad_id: 'ad2', ad_name: 'Catalog', title: 'All releases', body: 'x', image_path: `test-company/${'cd34'.repeat(16)}.jpg`, image_shared_by: 9, recent_spend: 90, last_day: '2026-11-08' },
        { ad_id: 'ad3', ad_name: 'No picture', title: 'Text only', body: 'y', image_path: null, recent_spend: 10, last_day: '2026-11-08' }] } });
    page.on('pageerror', (e) => errors.push(e.message));
    // Pinched page (Blake, 2026-11-13): Home, People, Money, Setup, and
    // Records for everything that used to fold open.
    R.ok('the page has seven tabs', (await page.$$('#tabs [data-tab]')).length === 7);
    R.ok('nothing on the page folds open', !(await page.$('details')));
    R.ok('the page opens on People', await page.evaluate(() => document.querySelector('#tabs .bcn-tab--active')?.dataset.tab === 'people'));
    R.eq(await page.evaluate(() => document.getElementById('tab-overview')?.textContent), 'Program', 'the numbers tab is called Program, and sits second');
    R.ok('People is the first tab', await page.evaluate(() => document.querySelector('#tabs [data-tab]')?.dataset.tab === 'people'));
    await page.click('#tabs [data-tab="overview"]');
    await page.waitForFunction(() => !!document.querySelector('#overviewBody .bcn-card'), null, { timeout: 5000 });
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
    R.has(next, '1 creator to look at', 'the next-step line says what to do now');
    R.has(next, 'not credited', 'uncredited code orders are surfaced');
    R.has(next, 'Needs you', 'everything waiting on a person is one list');
    R.has(next, 'earnings to pay', 'unpaid earnings are on the list for a manager');
    R.has(next, 'Running on its own', 'what runs by itself is shown, not explained');
    R.has(next, 'Commissions update nightly', 'nightly commissions are listed as running');
    R.not(await text(page, '#prospectsBody'), 'Fit is scored', 'no scoring jargon on the main list');
    await openRecords(page);
    const chipsR = await page.evaluate(() => [...document.querySelectorAll('#recordsBody [data-act="rec-tab"]')].map((x) => x.textContent));
    R.ok('Records is chips, one list at a time', chipsR.length >= 3 && chipsR[0] === 'Codes');
    await recTab(page, 'team');
    const ov = await text(page, '#recordsBody');
    R.has(ov, 'Outreach to prospects', 'Records states how each part works');
    R.ok('a live, successful run makes discovery verified', /Discovery\s*verified/.test(ov))
    R.not(ov, 'Stripe Connect', 'an unbuilt feature is not advertised')
    R.not(ov, 'SILO never', 'the overview says how it works, not what SILO does not do')
    R.not(ov, 'Incremental sales', 'the card lists what SILO does, not what it does not')
    R.ok('a code seen on an order makes code tracking verified', /Code tracking\s*verified/.test(ov))
    for (const [tab, body] of [['people', 'prospectsBody'], ['comms', 'outreachBody'], ['people', 'affiliatesBody'], ['share', 'shareBody'], ['payouts', 'payoutsBody']]) {
      await page.click(`#tabs [data-tab="${tab}"]`);
      await page.waitForFunction((b) => !!document.querySelector(`#${b} .bcn-card, #${b} .af-surface`), body, { timeout: 5000 });
    }
    // ── Affiliates: a code the person's own AI creates in Shopify ─────────
    await closeDialog(page);
    await page.click('#tabs [data-tab="people"]');
    R.ok('Affiliates says links wait for a store address', !!(await page.$('#affiliatesBody #storeNeeded')));
    await openRecords(page);
    if (process.env.RECORDS_SHOT) { await page.setViewportSize({ width: 1280, height: 1000 }); await (await page.$('#recordsBody')).screenshot({ path: process.env.RECORDS_SHOT }); }
    R.ok('no fold-outs on Records either', !(await page.$('#recordsBody details')));
    R.ok('Records has no code, link or add-creator forms', !(await page.$('#recordsBody #cCode, #recordsBody #lDest, #recordsBody #mpName, #recordsBody #impFile')));
    R.ok('Setup has no team or status boxes', !(await page.$('#programBody #managersCard')));
    await openCodeTool(page);
    R.has(await text(page, '#afDialogBody'), 'Connect your AI', 'with no AI that can make codes, the code form offers to connect one');
    // An info hover is markup, never text: a label that escaped it would show
    // the tag itself (caught in review 2026-11-20).
    R.not(await text(page, '#afDialogBody'), 'af-info', 'the hover hints render as marks, not as markup');
    R.ok('and the hint is there to hover', !!(await page.$('#afDialogBody .af-info[title]')));
    R.eq(await page.inputValue('#cPct'), '10', 'percent off defaults to 10');
    R.eq(await page.inputValue('#cHow'), 'ai', 'new codes default to SILO making them in Shopify');
    await page.fill('#cCode', 'pat15');
    await page.selectOption('#cHow', 'ai');
    await page.fill('#cPct', '');
    await page.click('#afDialogBody [data-act="code-add"]');
    await page.waitForFunction(() => !document.getElementById('status').hidden, null, { timeout: 5000 });
    R.has(await text(page, '#status'), 'percent off', 'a code for the AI needs the percent off');
    await page.fill('#cPct', '15');
    await page.click('#afDialogBody [data-act="code-add"]');
    await page.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_codes' && q._op === 'insert'), null, { timeout: 5000 });
    const codeRow = await page.evaluate(() => { const r = window.__QUERIES__.filter((q) => q.table === 'affiliate_codes' && q._op === 'insert').pop().rows; return Array.isArray(r) ? r[0] : r; });
    R.eq(codeRow?.status, 'pending', 'a code for the AI waits for Shopify');
    R.eq(codeRow?.discount_percent, 15);
    await closeDialog(page);
    await page.click('#tabs [data-tab="comms"]');
    // Outreach is chips, one list at a time, as Records and Share are
    // (Blake 2026-11-20: the tab scrolled for pages).
    R.ok('Outreach is one list at a time, picked from chips', (await page.$$('#outreachBody [data-act="comms-tab"]')).length >= 3);
    R.ok('exactly one list is shown', (await page.$$('#outreachBody .af-surface, #outreachBody .bcn-card')).length === 1);
    await commsChip(page, 'email');
    const ob = await text(page, '#outreachBody');
    R.has(ob, 'Your own MCP client sends approved messages', 'Messages leads with sending through a connected MCP client');
    R.ok('Connect your AI is the primary action on Messages', !!(await page.$('#outreachBody a.bcn-btn--primary[href="../settings-connect-ai.html"]')));
    R.has(ob, 'while this company is selected', 'with no connection, Messages says to connect for this company');
    await closeDialog(page);
    await toDiscovery(page);
    await toTiles(page);
    const pr = await text(page, '#prospectsBody');
    R.has(pr, 'Trail running every week', 'a prospect shows the search result it came from');
    // The past-customer badge (20261123210000): one pill, and only on a
    // creator the database matched. The numbers are the hover, not the row.
    R.has(pr, 'Past customer', 'a creator who has already bought is badged');
    R.eq((await page.$$('#prospectsBody .bcn-pill[title*="Check before you write to them"]')).length, 1,
      'exactly one badge for the two creators on the list, so a creator who never bought carries none');
    R.has(await page.getAttribute('#prospectsBody .bcn-pill[title*="Check before you write to them"]', 'title'),
      '2 orders', 'the order count is on hover only');
    R.has(await page.getAttribute('#prospectsBody .bcn-pill[title*="Check before you write to them"]', 'title'),
      'last 2026-07-20', 'with the last order day');
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
    await closeDialog(page);
    await toAffiliates(page);
    await toTiles(page, '#affiliatesBody');
    R.ok('an affiliate card shows the photo of the prospect they came from', await photoLoaded('#affiliatesBody .af-catalog-thumb img.af-avatar-photo[src="https://photos.invalid/samruns.png"]'));
    // One list at a time: the sub-tab that is not picked is really gone.
    {
      const onAff = await peopleSubVisible(page);
      R.ok('the Affiliates sub-tab shows affiliates and not the creators list', onAff.aff && !onAff.pros);
      await page.click('#peopleSubtabs [data-k="discovery"]');
      const onDisc = await peopleSubVisible(page);
      R.ok('and Discovery shows creators and not the affiliates list', onDisc.pros && !onDisc.aff);
      await page.click('#peopleSubtabs [data-k="affiliates"]');
    }
    // A card whose whole body is an empty state is not a card: it is a
    // heading over nothing. `card()` drops it, so a program that has never
    // run discovery sees the creators list and no "Recent runs" shell.
    {
      const noruns = { ...tables, affiliate_discovery_runs: [] };
      const nr = await suite.open('/v2/affiliates/index.html', noruns, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true } });
      await openRecords(nr);
      await recTab(nr, 'recruiting');
      const rb = await text(nr, '#recordsBody');
      R.not(rb, 'Recent runs', 'a card with nothing in it is left out, not shown empty');
      R.has(rb, 'Do-not-contact list', 'while a card that has a body of its own stays');
      await nr.close();
    }
    // Tiles or List: the list is a table that keeps the photos, and the choice sticks.
    await toDiscovery(page);
    await page.click('#prospectsBody [data-act="view-set"][data-v="list"]');
    R.ok('List shows creators as a table', !!(await page.$('#prospectsBody table.bcn-table')) && !(await page.$('#prospectsBody .af-item--catalog')));
    R.ok('with their photo in each row', await photoLoaded('#prospectsBody table.bcn-table .af-list-thumb img.af-avatar-photo'));
    R.ok('and the select boxes and actions', !!(await page.$('#prospectsBody table.bcn-table [data-act="prospect-pick"]')) && !!(await page.$('#prospectsBody table.bcn-table [data-act="prospect-status"]')));
    R.ok('the past-customer badge is in the list view too, beside the status', !!(await page.$('#prospectsBody table.bcn-table .bcn-pill[title*="Check before you write to them"]')));
    R.ok('affiliates follow the same choice, photo included', !!(await page.$('#affiliatesBody table.bcn-table .af-list-thumb')) && await photoLoaded('#affiliatesBody table.bcn-table img.af-avatar-photo[src="https://photos.invalid/samruns.png"]'));
    R.eq(await page.evaluate(() => localStorage.getItem('silo.affiliates.view')), 'list', 'the choice is remembered');
    await page.evaluate(() => localStorage.setItem('silo.affiliates.view', 'tiles'));
    await page.reload();
    await page.waitForFunction(() => !!document.querySelector('#tabs [data-tab="records"]'), null, { timeout: 5000 });
    await toDiscovery(page);
    R.ok('a saved Tiles choice is still Tiles after a reload', !!(await page.$('#prospectsBody .af-item--catalog')));
    await page.evaluate(() => localStorage.setItem('silo.affiliates.view', 'list'));
    await page.reload();
    await page.waitForFunction(() => !!document.querySelector('#tabs [data-tab="records"]'), null, { timeout: 5000 });
    if (process.env.LIST_SHOT) { await page.setViewportSize({ width: 1280, height: 1000 }); await (await page.$('#prospectsBody')).screenshot({ path: process.env.LIST_SHOT }); await (await page.$('#affiliatesBody')).screenshot({ path: process.env.LIST_SHOT.replace('.png', '-aff.png') }); }
    await toAffiliates(page);
    await page.click('#affiliatesBody [data-act="view-set"][data-v="tiles"]');
    R.ok('Tiles brings the cards back', !!(await page.$('#prospectsBody .af-item--catalog')) && !(await page.$('#prospectsBody table.bcn-table')));
    await closeDialog(page);
    await page.click('#tabs [data-tab="people"]');
    R.not(pr, '$0.0020', 'discovery cost is not shown to the company');
    R.not(pr, 'GitHub Actions', 'discovery copy names no internal tooling');
    R.not(pr, 'Saved Google searches', 'there are no saved searches to manage: a run searches what was typed');
    R.ok('no saved-search form', !(await page.$('#srcQuery')) && !(await page.$('[data-act="source-add"]')));
    R.ok('there is one search button, not two', !(await page.$('#prospectsBody [data-act="discovery-run"]')) && !!(await page.$('#prospectsBody [data-act="research-run"]')));
    R.ok('a manager can approve a prospect', await page.$('#prospectsBody [data-act="prospect-status"][data-s="approved"]'))
    R.has(await text(page, '#prospectsBody'), '12,400', 'a follower count a page stated is shown');
    R.ok('the follower count links to where it was stated', await page.$('#prospectsBody a[href="https://www.youtube.com/@samruns"]'));
    const card1 = await text(page, '#prospectsBody');
    R.has(card1, '2.0%', 'measured engagement is shown');
    R.has(card1, '4,000 avg views', 'with average views');
    R.has(card1, 'Links: shoe.example', 'and the brands they link');
    R.has(card1, '2 of 12 recent videos sponsored', 'and how many recent videos were sponsored');
    R.ok('other profiles the channel links are links', !!(await page.$('#prospectsBody a[href="https://www.instagram.com/samruns"]')));
    // Find creators with AI: starts a background run and says so; the company is never sent.
    await toDiscovery(page);
    await page.fill('#rsFocus', 'trail running moms');
    await page.click('#prospectsBody [data-act="research-run"]');
    await page.waitForFunction(() => /Research started/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 5000 });
    const rc = researchCalls.filter((c) => c.action === 'research');
    R.ok('research asks for this program with the focus, never a company', rc.length === 1 && rc[0].program_id === PROG && rc[0].focus === 'trail running moms' && !('company_entity_id' in rc[0]));
    // Import a list: the file is parsed in the page and sent as rows.
    await openAddCreators(page);
    await page.setInputFiles('#impFile', { name: 'list.csv', mimeType: 'text/csv', buffer: Buffer.from('name,url,followers,minor\r\n"Ann, Runs",https://www.tiktok.com/@annruns,41.2K,FALSE\r\nKid,https://www.tiktok.com/@kid,10,TRUE\r\n') });
    await page.click('#afDialogBody [data-act="import-run"]');
    await page.waitForFunction(() => /Imported/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 5000 });
    const imp = researchCalls.find((c) => c.action === 'import');
    R.ok('the import sends parsed rows', imp && imp.rows.length === 2 && imp.rows[0].name === 'Ann, Runs' && imp.rows[0].url === 'https://www.tiktok.com/@annruns');
    R.has(await text(page, '#status'), '1 skipped as likely minors', 'the import says what it skipped');
    // Photos refresh on their own: no button, one background call per visit.
    const ph = researchCalls.filter((c) => c.action === 'refresh_photos');
    const stc = researchCalls.filter((c) => c.action === 'refresh_stats');
    R.ok(`YouTube stats refresh without a button, once, for this program only (${stc.length})`, stc.length === 1 && stc[0].program_id === PROG && !('company_entity_id' in stc[0]));
    R.ok('creators who all have photos ask for no photo refresh', ph.length === 0);
    const again = await suite.open('/v2/affiliates/index.html', tables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true } });
    await again.waitForTimeout(1500);
    R.ok('a second visit within 12 hours does not refresh again', researchCalls.filter((c) => c.action === 'refresh_stats').length === 1);
    await again.close();
    R.ok('there is no Refresh photos or Refresh stats button', !(await page.$('[data-act="photos-refresh"], [data-act="stats-refresh"]')));
    await openRecords(page);
    await recTab(page, 'orders');
    const cm = await page.evaluate(() => [...document.querySelectorAll('#recordsBody .bcn-card')].find((c) => c.querySelector('h2')?.textContent === 'Orders')?.textContent || '');
    R.has(cm, 'refunds not measured', 'an unmeasured order says why');
    R.has(cm, '—', 'an unknown base renders as a dash');
    R.not(cm, '$0.00', 'an unknown base is never shown as $0');
    await closeDialog(page);
    await page.click('#tabs [data-tab="payouts"]');
    // Money opens with the flow from the store to the payout (Blake 2026-11-17: visuals, logos).
    const flow = await page.$$eval('#payoutsBody .af-flow .af-flow-lab', (l) => l.map((x) => x.textContent));
    R.eq(flow, ['Sales from codes', 'Commission earned', 'Owed now', 'Paid by hand'], 'Money opens with the flow: sales, earned, owed, paid');
    R.ok('the sales stage carries the Shopify mark', !!(await page.$('#payoutsBody .af-flow-step:first-child use[href$="#icon-shopify"]')));
    R.ok('and the old bar chart is gone', !(await page.$('#payoutsBody .af-ov-chart')));
    if (process.env.MONEY_SHOT) { await page.setViewportSize({ width: 1280, height: 1000 }); await (await page.$('#payoutsBody')).screenshot({ path: process.env.MONEY_SHOT }); }
    R.ok('each affiliate owed shows a paid-of-earned meter', !!(await page.$('#payoutsBody .af-item--pay .af-pay-meter')));
    R.ok('ready-to-pay rows carry the affiliate photo or initials', !!(await page.$('#payoutsBody .af-item--pay .af-list-thumb')));
    // ── Share tab: the brand picks what affiliates see ──────────────────
    R.not(await text(page, '#outreachBody'), 'Pick what to share', 'sharing is not on Outreach');
    await closeDialog(page);
    // The picker searches THIS program's store's own product list (Blake
    // 2026-11-20): a code is made in that store, against the handle that store
    // uses, and the same product is named differently from store to store.
    {
      const twoShops = { ...tables,
        affiliate_programs: [{ ...tables.affiliate_programs[0], shop_domains: ['brand-a.myshopify.com'] }],
        products_master: [
          // The company-wide list calls the hat `trail-hat-classic`, which is
          // brand-a's own handle; the jacket belongs to another store.
          { company_entity_id: CO, product_title: 'Trail Hat Classic', product_type: 'Hat', image_url: 'https://photos.invalid/hat.png', shopify_handle: 'trail-hat' },
          { company_entity_id: CO, product_title: 'Trail Jacket', product_type: 'Coat', image_url: null, shopify_handle: 'trail-jacket' }],
        shopify_product_skus: [
          { company_entity_id: CO, shop_domain: 'brand-a.myshopify.com', product_handle: 'trail-hat-classic', product_title: 'Trail Hat Classic', shopify_status: 'active' },
          { company_entity_id: CO, shop_domain: 'brand-a.myshopify.com', product_handle: 'trail-hat-classic', product_title: 'Trail Hat Classic', shopify_status: 'active' },
          { company_entity_id: CO, shop_domain: 'brand-a.myshopify.com', product_handle: 'trail-cap-draft', product_title: 'Trail Cap', shopify_status: 'draft' },
          { company_entity_id: CO, shop_domain: 'brand-b.myshopify.com', product_handle: 'trail-jacket', product_title: 'Trail Jacket', shopify_status: 'active' }] };
      const st = await suite.open('/v2/affiliates/index.html', twoShops, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true } });
      st.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(st);
      await st.click('#tabs [data-tab="share"]');
      await st.waitForSelector('#shareBody [data-act="share-tab"][data-k="products"]', { timeout: 5000 });
      await st.click('#shareBody [data-act="share-tab"][data-k="products"]');
      await st.fill('#prodQ', 'Trail');
      await st.click('[data-act="prod-search"]');
      await st.waitForFunction(() => /Trail Hat Classic/.test(document.getElementById('shareBody')?.textContent || ''), null, { timeout: 5000 });
      const sb = await text(st, '#shareBody');
      R.has(sb, 'Trail Hat Classic', 'the store’s own name for the product is what is offered');
      R.not(sb, 'Trail Jacket', 'a product this store does not sell is not offered');
      R.not(sb, 'Trail Cap', 'a draft product is not offered: its page is not public');
      // The handle is the thing that differs between stores, so the picture
      // has to come off the title when the handles do not line up.
      R.ok('a result carries its picture even when the company list files it under another handle',
        await st.evaluate(() => [...document.querySelectorAll('#shareBody img')].some((i) => /hat\.png/.test(i.getAttribute('src') || ''))));
      // Nothing by that name here is an answer, not a failed search: it says
      // where the company's other matches are, and why they are not offered.
      await st.fill('#prodQ', 'Jacket');
      await st.click('[data-act="prod-search"]');
      await st.waitForFunction(() => /other stores/.test(document.getElementById('shareBody')?.textContent || ''), null, { timeout: 5000 });
      const only = await text(st, '#shareBody');
      R.not(only, 'Trail Jacket', 'a product only another store sells is not offered');
      R.has(only, 'Nothing by that name in brand-a', 'the store is named, not left as "this store"');
      R.has(only, 'named differently from store to store', 'and the reason is given, since the company does sell it');
      await st.close();
      // A store the catalog sync has not read yet filters nothing, because
      // absence of rows there is not evidence the shop sells nothing.
      const unread = { ...twoShops,
        affiliate_programs: [{ ...tables.affiliate_programs[0], shop_domains: ['brand-c.myshopify.com'] }] };
      const un = await suite.open('/v2/affiliates/index.html', unread, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true } });
      un.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(un);
      await un.click('#tabs [data-tab="share"]');
      await un.waitForSelector('#shareBody [data-act="share-tab"][data-k="products"]', { timeout: 5000 });
      await un.click('#shareBody [data-act="share-tab"][data-k="products"]');
      await un.fill('#prodQ', 'Trail');
      await un.click('[data-act="prod-search"]');
      await un.waitForFunction(() => /Trail Jacket/.test(document.getElementById('shareBody')?.textContent || ''), null, { timeout: 5000 });
      R.not(await text(un, '#shareBody'), 'other stores', 'an unread store filters nothing and claims nothing');
      await un.close();
    }
    await page.click('#tabs [data-tab="share"]');
    await page.waitForFunction(() => /Trail Hat/.test(document.getElementById('shareBody').textContent), null, { timeout: 5000 });
    R.has(await text(page, '#shareBody'), 'What your affiliates see', 'Share opens on what is already shared');
    R.not(await text(page, '#shareBody'), 'Spring Drop', 'one list at a time: launches wait behind their own chip');
    await page.click('#shareBody [data-act="share-tab"][data-k="ads"]');
    await page.waitForFunction(() => /Mud season/.test(document.getElementById('shareBody').textContent), null, { timeout: 5000 });
    const sb = await text(page, '#shareBody');
    R.has(sb, 'Mud season', 'recent ads can be shared');
    R.not(sb, 'All releases', 'a catalog template image is not offered as an ad');
    R.not(sb, 'Text only', 'an ad with no picture is not offered');
    R.ok('each recent ad shows its picture', await page.evaluate((p) => [...document.querySelectorAll('#shareBody img')].some((i) => i.getAttribute('src') === 'https://fixture.local/signed/' + p), AD_IMG));
    R.ok('with several Shopify stores and no store address, Studio asks for the address', !!(await page.$('#shareBody #storeNeeded')));
    R.ok('before 20261117030000 there is no store picker', !(await page.$('#programBody .pStore')));
    await page.click('#shareBody [data-act="share-tab"][data-k="launches"]');
    await page.waitForFunction(() => /Spring Drop/.test(document.getElementById('shareBody').textContent), null, { timeout: 5000 });
    await page.click('#shareBody [data-act="feed-add"][data-kind="launch"]');
    await page.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_feed_items' && q._op === 'insert'), null, { timeout: 5000 });
    const shared = await page.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_feed_items' && q._op === 'insert').pop().rows);
    const row = Array.isArray(shared) ? shared[0] : shared;
    R.eq(row?.kind, 'launch');
    R.eq(row?.product_path, '/collections/spring', 'a launch shares its store page as a path, never another site');
    R.eq(row?.event_on, '2099-03-01');
    R.ok('only the snapshot fields are shared', row && Object.keys(row).sort().join() === 'company_entity_id,event_on,image_url,kind,note,product_path,program_id,source_id,title');
    await page.waitForFunction(() => document.querySelector('#shareBody [data-act="share-tab"][data-k="launches"][aria-selected="true"]'), null, { timeout: 5000 });
    await page.click('#shareBody [data-act="share-tab"][data-k="ads"]');
    await page.waitForFunction(() => document.querySelector('#shareBody [data-act="feed-add"][data-kind="ad"]'), null, { timeout: 5000 });
    await page.click('#shareBody [data-act="feed-add"][data-kind="ad"]');
    await page.waitForFunction(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_feed_items' && q._op === 'insert').length >= 2, null, { timeout: 5000 });
    const adRow = await page.evaluate(() => { const r = window.__QUERIES__.filter((q) => q.table === 'affiliate_feed_items' && q._op === 'insert').pop().rows; return Array.isArray(r) ? r[0] : r; });
    const ups = await page.evaluate(() => window.__UPLOADS__ || []);
    R.ok('sharing an ad publishes exactly its picture to the public feed bucket', ups.some((u) => u.bucket === 'affiliate-feed-images' && u.path === `test-company/${'ab12'.repeat(16)}.jpg`));
    R.eq(adRow?.image_url, `about:blank#test-company/${'ab12'.repeat(16)}.jpg`, 'and the shared ad carries that public picture');
    R.eq(adRow?.note, 'Grip that holds.', 'with its copy, to repost');
    R.eq(adRow?.product_path, '/products/mud-shoe');
    await closeDialog(page);
    await page.click('#tabs [data-tab="program"]');
    // The link is a button to copy and one to open, not a line of text to
    // select by hand.
    R.ok('an open program offers its application link to copy', (await page.evaluate(() => document.querySelector('#programBody [data-act="copy-text"]')?.dataset.t || '')).endsWith('/v2/affiliates/apply.html?c=test-company&p=creators'));
    R.ok('and a button that opens it', !!(await page.$('#programBody a.bcn-btn[href*="/v2/affiliates/apply.html?c=test-company"]')));
    R.ok('before the loop migration, settings has no automatic-code field (saving still works)', !(await page.$('#pAutoPct')));
    R.ok('before 20261111020000, settings has no outreach message box (saving still works)', !(await page.$('#pOutBody')));
    await page.close();

    // ── onboarding invites: added by hand or applied => emailed ─────────
    {
      const inviteTables = { ...tables, affiliate_prospects: [
        ...tables.affiliate_prospects,
        { id: 'p-app', company_entity_id: CO, program_id: PROG, display_name: 'Ana Applies', platform: 'instagram', handle: '@ana', profile_url: 'https://www.instagram.com/ana', contact_email: 'ana@creator.invalid', source: 'applied', collected_at: now, evidence: { pitch: 'I run trails' }, status: 'new' },
        { id: 'p-app2', company_entity_id: CO, program_id: PROG, display_name: 'Bo Bounce', platform: 'instagram', handle: '@bo', profile_url: 'https://www.instagram.com/bo', contact_email: 'bo@creator.invalid', source: 'applied', collected_at: now, evidence: {}, status: 'rejected' },
        { id: 'p-srch', company_entity_id: CO, program_id: PROG, display_name: 'Sky Search', platform: 'tiktok', handle: '@sky', profile_url: 'https://www.tiktok.com/@sky', contact_email: null, source: 'serp', collected_at: now, evidence: {}, status: 'new' },
        { id: 'p-man', company_entity_id: CO, program_id: PROG, display_name: 'Quin Hand', platform: 'tiktok', handle: '@quin', profile_url: 'https://www.tiktok.com/@quin', contact_email: 'quin@creator.invalid', source: 'manual', collected_at: now, evidence: {}, status: 'invited' },
      ] };
      const inv = await suite.open('/v2/affiliates/index.html', inviteTables, { ready, rpc: { can_manage_affiliate_programs: true } });
      inv.on('pageerror', (e) => errors.push(e.message));
      const inviteCalls = []; let mailOk = true;
      await inv.context().route('**/functions/v1/affiliate-invite', (route) => {
        const body = JSON.parse(route.request().postData() || '{}'); inviteCalls.push(body);
        const out = mailOk ? { emailed: true, email: 'sent' } : { emailed: false, email: 'not_sent', reason: 'The mail provider refused it' };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ affiliate_id: 'a-new', signup_url: `https://app.test/v2/affiliates/join.html?t=${body.prospect_id}`, expires_at: '2026-12-01T00:00:00Z', ...out }) });
      });
      await closeDialog(inv);
      await inv.click('#tabs [data-tab="comms"]');
      await commsChip(inv, 'inbound');
      await inv.waitForFunction(() => !!document.querySelector('#outreachBody [data-act="prospect-status"][data-id="p-app"]'), null, { timeout: 5000 });
      await inv.click('#outreachBody [data-act="prospect-status"][data-s="approved"][data-id="p-app"]');
      await inv.waitForFunction(() => /Invite emailed/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
      R.ok('approving an applicant emails their invite', inviteCalls.some((c) => c.action === 'signup_link' && c.prospect_id === 'p-app' && c.email === true && !('company_entity_id' in c)));
      R.has(await text(inv, '#status'), 'Invite emailed to ana@creator.invalid');
      R.ok('approving an applicant drafts no outreach message', !(await inv.evaluate(() => window.__QUERIES__.some((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'insert'))));
      await closeDialog(inv);
      await toDiscovery(inv);
      await inv.waitForSelector('#prospectsBody [data-act="prospect-status"][data-s="approved"][data-id="p1"]', { timeout: 5000 });
      await inv.click('#prospectsBody [data-act="prospect-status"][data-s="approved"][data-id="p1"]');
      await inv.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'insert'), null, { timeout: 5000 }).catch(() => {});
      R.ok('a creator a search found is not emailed on approval', !inviteCalls.some((c) => c.prospect_id === 'p1'));
      await toDiscovery(inv);
      await inv.click('#prospectsBody [data-act="prospect-filter"][data-f="all"]');
      await openProspectMore(inv, 'p-man');
      await inv.waitForFunction(() => !!document.querySelector('[data-act="invite-send"][data-id="p-man"]'), null, { timeout: 5000 }).catch(() => {});
      R.has(await text(inv, '[data-act="invite-send"][data-id="p-man"]'), 'Resend invite', 'an invited person added by hand can be sent the invite again');
      await closeDialog(inv);
      await openProspectMore(inv, 'p1');
      R.ok('a creator a search found keeps the link to send yourself', !(await inv.$('[data-act="invite-send"][data-id="p1"]')));
      await closeDialog(inv);
      // Bulk: pick several, act once.
      await toDiscovery(inv);
      await inv.click('#prospectsBody [data-act="prospect-filter"][data-f="new"]');
      await inv.waitForFunction(() => !!document.querySelector('#prospectsBody [data-act="prospect-select-all"]'), null, { timeout: 5000 });
      await toDiscovery(inv);
      await inv.click('#prospectsBody [data-act="prospect-select-all"]');
      await inv.waitForFunction(() => /selected/.test(document.querySelector('#prospectsBody .af-bulk')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
      const nNew = await inv.$$eval('#prospectsBody [data-act="prospect-pick"]', (els) => els.length);
      R.has(await text(inv, '#prospectsBody .af-bulk'), `${nNew} selected`, 'Select all picks every prospect in the view');
      R.ok('every card is ticked', await inv.$$eval('#prospectsBody [data-act="prospect-pick"]', (els) => els.every((e) => e.checked)));
      await toDiscovery(inv);
      await inv.click('#prospectsBody [data-act="prospect-pick"]');
      R.has(await text(inv, '#prospectsBody .af-bulk'), `${nNew - 1} selected`, 'unticking one leaves the rest');
      const before = await inv.evaluate(() => window.__QUERIES__.length);
      await toDiscovery(inv);
      await inv.click('#prospectsBody [data-act="prospect-bulk"][data-s="rejected"]');
      await inv.waitForFunction(() => /Rejected/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
      const bulk = await inv.evaluate((b) => window.__QUERIES__.slice(b).filter((q) => q.table === 'affiliate_prospects' && q._op === 'update'), before);
      R.ok('one update rejects the selection', bulk.length === 1 && bulk[0].patch.status === 'rejected');
      R.ok('scoped to this company and the picked ids', JSON.stringify(bulk[0].filters).includes('company_entity_id') && JSON.stringify(bulk[0].filters).includes('"in"'));
      // Bulk approve when the mail is refused (HTTP 200, emailed:false): said, with the link.
      mailOk = false;
      await toDiscovery(inv);
      await inv.click('#prospectsBody [data-act="prospect-filter"][data-f="all"]');
      await inv.waitForFunction(() => !!document.querySelector('#prospectsBody [data-act="prospect-pick"][data-id="p-app2"]'), null, { timeout: 5000 });
      await toDiscovery(inv);
      await inv.click('#prospectsBody [data-act="prospect-pick"][data-id="p-app2"]');
      await toDiscovery(inv);
      await inv.click('#prospectsBody [data-act="prospect-bulk"][data-s="approved"]');
      await inv.waitForFunction(() => /Approved/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
      R.has(await text(inv, '#status'), '1 invite(s) not emailed', 'a refused invite in a bulk approval is reported, not counted as sent');
      const unsentBox = await text(inv, '#signupOut');
      R.has(unsentBox, 'Bo Bounce', 'naming who did not get it');
      R.has(unsentBox, 'The mail provider refused it', 'with the reason');
      R.has(unsentBox, 'join.html?t=p-app2', 'and the link to send by hand');
      mailOk = true;
      // Added by hand with an email: approved and invited at once.
      await openAddCreators(inv);
      await inv.fill('#mpName', 'Ned New'); await inv.fill('#mpHandle', '@ned'); await inv.fill('#mpEmail', 'ned@creator.invalid');
      // Typed the way people type (Blake 2026-11-18, source_url CHECK): a bare
      // profile domain and a word for where they were found.
      await inv.fill('#mpUrl', 'instagram.com/ned'); await inv.fill('#mpSource', 'Instagram');
      await inv.click('#afDialogBody [data-act="prospect-add"]');
      await inv.waitForFunction(() => /Added\./.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
      const added = await inv.evaluate(() => { const q = window.__QUERIES__.filter((x) => x.table === 'affiliate_prospects' && x._op === 'insert').pop(); return Array.isArray(q?.rows) ? q.rows[0] : q?.rows; });
      R.eq([added?.status, added?.source, added?.contact_email], ['approved', 'manual', 'ned@creator.invalid'], 'a person added by hand with an email is approved');
      R.eq([added?.profile_url, added?.source_url, added?.evidence?.found_via], ['https://instagram.com/ned', null, 'Instagram'], 'a bare domain gets https:// and a non-address "where found" is kept as a note, so the CHECK cannot refuse the save');
      R.ok('and emailed their invite', inviteCalls.some((c) => c.action === 'signup_link' && c.prospect_id === 'fixture-inserted-id' && c.email === true));
      R.has(await text(inv, '#status'), 'Invite emailed to ned@creator.invalid');
      // Added by hand when the mail is refused: the link shows beside the form.
      mailOk = false;
      await inv.fill('#mpName', 'Nia New'); await inv.fill('#mpHandle', '@nia'); await inv.fill('#mpEmail', 'nia@creator.invalid');
      await inv.click('#afDialogBody [data-act="prospect-add"]');
      await inv.waitForFunction(() => /not emailed/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
      R.ok('the fallback link is visible beside the form', await inv.evaluate(() => { const el = document.querySelector('#afDialogBody #mpOut'); return !!el && el.offsetParent !== null && /join\.html\?t=/.test(el.textContent); }));
      await inv.close();
    }

    // ── the loop: after 20261110180000 ────────────────────────────────────
    const loopTables = { ...tables,
      affiliate_programs: [{ ...tables.affiliate_programs[0], default_discount_percent: 10, outreach_subject: 'Ride with {brand}', outreach_body: 'Yo {name}! Join us: {signup_link}', shop_domains: null }],
      affiliates: [{ ...tables.affiliates[0], photo_url: 'https://photos.invalid/pat-own.png', photo_hidden: false }],
      affiliate_codes: [...tables.affiliate_codes, { id: 'c2', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, code: 'PAT10-2', starts_on: '2026-11-10', ends_on: null, status: 'pending', discount_percent: 10 }],
      affiliate_payouts: [{ id: 'po-d', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, status: 'draft', amount_cents: 500, currency: 'USD', item_count: 1, created_at: now }] };
    const loop = await suite.open('/v2/affiliates/index.html', loopTables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true },
      edge: { 'affiliate-invite': { status: 200, body: { results: [{ code_id: 'c2', code: 'PAT10-2', status: 'needs_scope' }] } } } });
    loop.on('pageerror', (e) => errors.push(e.message));
    await toProgram(loop);
    const todo = await text(loop, '#overviewBody');
    R.has(todo, 'code waiting to be made in Shopify', 'a waiting code is on the list');
    // SILO makes every code itself (Blake 2026-11-17): the To do offers that, no AI prompt.
    R.ok('with SILO making it, no AI prompt', !!(await loop.$('#overviewBody [data-act="code-make"]')) && !(await loop.$('#overviewBody [data-act="copy-codes-prompt"]')));
    // SILO makes it in Shopify itself; a store that has not granted it says how.
    await loop.click('#overviewBody [data-act="code-make"]');
    await loop.waitForFunction(() => (window.__EDGE_CALLS__ || []).some((c) => c.name === 'affiliate-invite'), null, { timeout: 5000 });
    const mk = await loop.evaluate(() => window.__EDGE_CALLS__.filter((c) => c.name === 'affiliate-invite').pop().body);
    R.eq(mk.action, 'create_shopify_codes', 'Make in Shopify asks SILO to make the code');
    R.eq(mk.code_ids, ['c2'], 'only the codes that are waiting');
    await loop.waitForFunction(() => /reconnect Shopify/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 5000 });
    R.ok('a store without the permission is told to reconnect', true);
    R.has(todo, 'payout to approve', 'a payout to approve is on the list for someone who may approve money');
    // Turning an affiliate back on makes their waiting code in Shopify at once.
    {
      const rs = await suite.open('/v2/affiliates/index.html', { ...loopTables, affiliates: [{ ...loopTables.affiliates[0], status: 'paused' }] },
        { ready, rpc: { can_manage_affiliate_programs: true }, edge: { 'affiliate-invite': { status: 200, body: { results: [{ code_id: 'c2', code: 'PAT10-2', status: 'created' }] } } } });
      rs.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(rs);
      await toAffiliates(rs);
      await rs.waitForSelector('#affiliatesBody [data-act="affiliate-status"][data-s="active"]', { timeout: 5000 });
      await rs.click('#affiliatesBody [data-act="affiliate-status"][data-s="active"]');
      await rs.waitForFunction(() => (window.__EDGE_CALLS__ || []).some((c) => c.name === 'affiliate-invite'), null, { timeout: 5000 });
      const call = await rs.evaluate(() => window.__EDGE_CALLS__.find((c) => c.name === 'affiliate-invite').body);
      R.eq(call.code_ids, ['c2'], 'resuming an affiliate makes their waiting code');
      await rs.waitForFunction(() => /live in Shopify/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 5000 });
      R.ok('and says it is live', true);
      await rs.close();
    }
    // Ending an affiliate retires their codes and turns the live one off in Shopify (audit 2026-11-18).
    {
      const endTables = { ...loopTables, affiliate_codes: loopTables.affiliate_codes.map((c) => (c.id === 'c1' ? { ...c, shopify_discount_id: 'gid://shopify/DiscountCodeNode/55' } : c)) };
      const en = await suite.open('/v2/affiliates/index.html', endTables,
        { ready, rpc: { can_manage_affiliate_programs: true }, edge: { 'affiliate-invite': { status: 200, body: { results: [{ code_id: 'c1', code: 'PAT10', status: 'ended' }] } } } });
      en.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(en);
      await toAffiliates(en);
      await en.waitForSelector('#affiliatesBody [data-act="affiliate-status"][data-s="terminated"]', { timeout: 5000 });
      await en.click('#affiliatesBody [data-act="affiliate-status"][data-s="terminated"]');
      await en.click('#affiliatesBody [data-act="affiliate-status"][data-s="terminated"]');
      await en.waitForFunction(() => (window.__EDGE_CALLS__ || []).some((c) => c.name === 'affiliate-invite'), null, { timeout: 5000 });
      const ret = await en.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_codes' && q._op === 'update').pop());
      R.eq(ret?.patch?.status, 'retired', 'ending an affiliate retires their codes');
      R.eq((ret.filters.find((f) => f.op === 'in' && f.col === 'id') || {}).vals?.slice().sort(), ['c1', 'c2'], 'the live one and the waiting one');
      const endCall = await en.evaluate(() => window.__EDGE_CALLS__.filter((c) => c.name === 'affiliate-invite').pop().body);
      R.eq([endCall.action, endCall.code_ids], ['end_shopify_codes', ['c1']], 'and turns the live one off in Shopify');
      await en.waitForFunction(() => /turned off in Shopify/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 5000 });
      R.ok('and says so', true);
      await en.close();
    }
    // A second press after a half-done ending still turns the code off in
    // Shopify: the codes were retired by the first attempt, so "nothing is
    // live" must not be read as "nothing to do" (review of #1357).
    {
      const halfDone = { ...loopTables,
        affiliate_codes: [{ ...loopTables.affiliate_codes.find((c) => c.id === 'c1'), status: 'retired', shopify_discount_id: 'gid://shopify/DiscountCodeNode/55', shopify_ended_at: null }] };
      const rt = await suite.open('/v2/affiliates/index.html', halfDone,
        { ready, rpc: { can_manage_affiliate_programs: true }, edge: { 'affiliate-invite': { status: 200, body: { results: [{ code_id: 'c1', code: 'PAT10', status: 'ended' }] } } } });
      rt.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(rt);
      await toAffiliates(rt);
      await rt.waitForSelector('#affiliatesBody [data-act="affiliate-status"][data-s="terminated"]', { timeout: 5000 });
      await rt.click('#affiliatesBody [data-act="affiliate-status"][data-s="terminated"]');
      await rt.click('#affiliatesBody [data-act="affiliate-status"][data-s="terminated"]');
      await rt.waitForFunction(() => (window.__EDGE_CALLS__ || []).some((c) => c.name === 'affiliate-invite'), null, { timeout: 5000 });
      const again = await rt.evaluate(() => window.__EDGE_CALLS__.filter((c) => c.name === 'affiliate-invite').pop().body);
      R.eq([again.action, again.code_ids], ['end_shopify_codes', ['c1']], 'a retry turns off the code the first attempt retired but never ended');
      await rt.waitForFunction(() => /turned off in Shopify/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 5000 });
      R.ok('and says so rather than reporting a clean ending', true);
      await rt.close();
    }
    // 26 live codes: ended in batches of 25, and a code with no answer is said to be still on (review on #1331).
    {
      const base = loopTables.affiliate_codes.find((c) => c.id === 'c1');
      const many = Array.from({ length: 26 }, (_, i) => ({ ...base, id: `cm${i}`, code: `PAT${i}`, status: 'active', shopify_discount_id: `gid://shopify/DiscountCodeNode/${i}` }));
      const mt = await suite.open('/v2/affiliates/index.html', { ...loopTables, affiliate_codes: many },
        { ready, rpc: { can_manage_affiliate_programs: true }, edge: { 'affiliate-invite': { status: 200, body: { results: [{ code_id: 'cm0', code: 'PAT0', status: 'ended' }] } } } });
      mt.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(mt);
      await toAffiliates(mt);
      await mt.waitForSelector('#affiliatesBody [data-act="affiliate-status"][data-s="terminated"]', { timeout: 5000 });
      await mt.click('#affiliatesBody [data-act="affiliate-status"][data-s="terminated"]');
      await mt.click('#affiliatesBody [data-act="affiliate-status"][data-s="terminated"]');
      await mt.waitForFunction(() => /Still on in Shopify/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 5000 });
      const sizes = await mt.evaluate(() => window.__EDGE_CALLS__.filter((c) => c.name === 'affiliate-invite' && c.body.action === 'end_shopify_codes').map((c) => c.body.code_ids.length));
      R.eq(sizes, [25, 1], 'all 26 are sent, 25 at a time');
      R.ok('codes with no answer are reported as still on, not as off', true);
      await mt.close();
    }
    // One affiliate per company, added to another program with their own rate (Blake 2026-11-17).
    {
      const P2 = '66666666-6666-4666-8666-666666666666';
      const ap = await suite.open('/v2/affiliates/index.html', { ...loopTables, affiliate_programs: [...loopTables.affiliate_programs, { ...loopTables.affiliate_programs[0], id: P2, name: 'Wholesale', slug: 'wholesale' }] },
        { ready, rpc: { can_manage_affiliate_programs: true,
          affiliate_add_to_program: (args) => { window.__addArgs = args; return { affiliate_id: '77777777-7777-4777-8777-777777777777', added: true }; } } });
      ap.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(ap);
      await toAffiliates(ap);
      await ap.waitForSelector('#affiliatesBody [data-act="aff-tool"][data-k="program"]', { timeout: 5000 });
      await ap.click('#affiliatesBody [data-act="aff-tool"][data-k="program"]');
      await ap.waitForSelector('#apProg', { timeout: 5000 });
      R.eq(await ap.evaluate(() => [...document.querySelectorAll('#apProg option')].map((o) => o.textContent)), ['Wholesale'], 'only the other programs are offered');
      await ap.click('[data-seg="apKind"][data-v="percent_of_net"]');
      await ap.fill('#apPct', '15');
      await ap.click('[data-act="aff-add-program"]');
      await ap.waitForFunction(() => /Added to Wholesale/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 5000 });
      const args = await ap.evaluate(() => window.__addArgs);
      R.eq([args.p_program, args.p_commission_kind, args.p_commission_percent, args.p_commission_fixed_cents], [P2, 'percent_of_net', 15, null], 'adds them with their own rate, no second signup');
      await ap.close();
    }
    // One person across programs: the dialog says where they already are, and
    // does not offer to add them there again (20261121230000).
    {
      const P2 = '66666666-6666-4666-8666-666666666666';
      const P3 = '88888888-8888-4888-8888-888888888888';
      const two = await suite.open('/v2/affiliates/index.html',
        { ...loopTables, affiliate_programs: [...loopTables.affiliate_programs,
          { ...loopTables.affiliate_programs[0], id: P2, name: 'Wholesale', slug: 'wholesale' },
          { ...loopTables.affiliate_programs[0], id: P3, name: 'Outlet', slug: 'outlet' }] },
        { ready, rpc: { can_manage_affiliate_programs: true,
          // The fixture crosses into the page as SOURCE, with no closure, so
          // every id in it is written out rather than referenced.
          affiliate_person_programs: () => ([
            { affiliate_id: '22222222-2222-4222-8222-222222222222', program_id: '11111111-1111-4111-8111-111111111111', program_name: 'Creators', status: 'active' },
            { affiliate_id: 'aff-w', program_id: '66666666-6666-4666-8666-666666666666', program_name: 'Wholesale', status: 'active' }]) } });
      two.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(two);
      await toAffiliates(two);
      await two.waitForSelector('#affiliatesBody [data-act="aff-tool"][data-k="program"]', { timeout: 5000 });
      await two.click('#affiliatesBody [data-act="aff-tool"][data-k="program"]');
      await two.waitForFunction(() => /Also in/.test(document.getElementById('afDialogBody')?.textContent || ''), null, { timeout: 5000 });
      const body = await text(two, '#afDialogBody');
      R.has(body, 'Also in Wholesale', 'the dialog says which other programs they are already in');
      R.has(body, 'one payout address', 'and that their PayPal is the same in every one');
      R.eq(await two.evaluate(() => [...document.querySelectorAll('#apProg option')].map((o) => o.textContent)), ['Outlet'],
        'a program they are already in is not offered again');
      await two.close();
    }
    // And where that read fails the dialog is what it was before it existed.
    {
      const P2 = '66666666-6666-4666-8666-666666666666';
      const noRead = await suite.open('/v2/affiliates/index.html',
        { ...loopTables, affiliate_programs: [...loopTables.affiliate_programs,
          { ...loopTables.affiliate_programs[0], id: P2, name: 'Wholesale', slug: 'wholesale' }] },
        { ready, rpc: { can_manage_affiliate_programs: true,
          affiliate_person_programs: () => ({ __error: { message: 'fixture: function does not exist', code: '42883' } }) } });
      noRead.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(noRead);
      await toAffiliates(noRead);
      await noRead.waitForSelector('#affiliatesBody [data-act="aff-tool"][data-k="program"]', { timeout: 5000 });
      await noRead.click('#affiliatesBody [data-act="aff-tool"][data-k="program"]');
      await noRead.waitForSelector('#apProg', { timeout: 5000 });
      R.eq(await noRead.evaluate(() => [...document.querySelectorAll('#apProg option')].map((o) => o.textContent)), ['Wholesale'],
        'with their memberships unreadable every other program is offered, as before');
      R.not(await text(noRead, '#afDialogBody'), 'Also in', 'and nothing is claimed about where they are');
      await noRead.close();
    }
    // Workflow tabs show the list first: the To do strip stays off the page.
    await loop.setViewportSize({ width: 1280, height: 520 });
    await closeDialog(loop);
    await loop.click('#tabs [data-tab="people"]');
    await loop.waitForFunction(() => !!document.querySelector('#afCreatorsList'), null, { timeout: 5000 });
    R.ok('prospects tab does not repeat the Overview To do strip', !(await loop.evaluate(() => {
      const el = document.getElementById('nextStep');
      return el && !el.hidden && el.textContent.trim().length > 0;
    })));
    // ...and the panel it leads with is still shown whole. `.silo-main` is a
    // scrolling flex column, so a tall panel in a short window shrinks to fit
    // and cuts off its own last rows unless its children refuse to shrink.
    // The strip this was first measured on is gone; the rule that saved it
    // still covers every panel, so measure it where it now applies.
    const pinch = await loop.$eval('.af-panel[data-panel="people"]', (el) => el.scrollHeight - el.clientHeight);
    R.ok(`a tall panel is shown whole in a short window (hidden by ${pinch}px)`, pinch <= 1);
    await loop.setViewportSize({ width: 1280, height: 900 });
    // The rep's own photo wins over the one found for them.
    await loop.context().route('https://photos.invalid/pat-own.png', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PHOTO_PNG }));
    await closeDialog(loop);
    await toAffiliates(loop);
    await toTiles(loop, '#affiliatesBody');
    await loop.waitForFunction(() => !!document.querySelector('#affiliatesBody .af-catalog-thumb'), null, { timeout: 5000 });
    R.ok('an affiliate card shows the photo the rep set in the portal', !!(await loop.$('#affiliatesBody img.af-avatar-photo[src="https://photos.invalid/pat-own.png"]')));
    // Approving a creator drafts the program's own message, filled in.
    await closeDialog(loop);
    await loop.click('#tabs [data-tab="people"]');
    await loop.waitForFunction(() => !!document.querySelector('#prospectsBody [data-act="prospect-status"][data-s="approved"]'), null, { timeout: 5000 });
    await toDiscovery(loop);
    await loop.click('#prospectsBody [data-act="prospect-status"][data-s="approved"]');
    await loop.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'insert'), null, { timeout: 5000 }).catch(() => {});
    const draft = await loop.evaluate(() => { const q = window.__QUERIES__.filter((x) => x.table === 'affiliate_outreach_drafts' && x._op === 'insert').pop(); const r = q?.rows; return Array.isArray(r) ? r[0] : r; });
    R.eq([draft?.subject, draft?.body], ['Ride with Brand A', 'Yo Sam Runs! Join us: {signup_link}'], 'a new draft starts from the program\'s own message, filled in');
    await closeDialog(loop);
    await loop.click('#tabs [data-tab="payouts"]');
    await loop.waitForFunction(() => !!document.querySelector('#payoutsBody .bcn-card'), null, { timeout: 5000 });
    R.ok('the Update button is no longer the way commissions happen', !(await loop.$('#payoutsBody [data-act="commissions-run"]')));
    await closeDialog(loop);
    await loop.click('#tabs [data-tab="program"]');
    // Setup is a settings page: a card per subject, chips instead of
    // dropdowns, and it saves as you go -- no Save button on a live program.
    R.ok('settings leads with name, status and what you pay', !!(await loop.$('#programBody div.af-settings-col:first-of-type #pName')) && !!(await loop.$('#programBody div.af-settings-col:first-of-type #pKind')));
    R.ok('status is a row of chips, not a dropdown', (await loop.$$('#programBody [data-seg="pStatus"]')).length === 4 && !(await loop.$('#programBody select#pStatus')));
    R.ok('a live program has no Save button', !(await loop.$('#programBody [data-act="save-program"]')));
    R.ok('the message to creators is prepped on Comms, not Setup', !(await loop.$('#programBody #pOutBody')));
    R.ok('Setup folds nothing open', !(await loop.$('#programBody details, #shareBody details')));
    if (process.env.STUDIO_SHOT) { await loop.setViewportSize({ width: 1280, height: 1200 }); await (await loop.$('#programBody')).screenshot({ path: process.env.STUDIO_SHOT }); }
    R.eq(await loop.inputValue('#pAutoPct'), '10', 'settings shows the % off for new affiliates');
    await loop.fill('#pAutoPct', '');
    await loop.press('#pAutoPct', 'Tab');
    await loop.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_programs' && q._op === 'update'), null, { timeout: 5000 });
    await loop.waitForFunction(() => document.getElementById('setSaved')?.textContent === 'Saved', null, { timeout: 5000 });
    const progRow = await loop.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_programs' && q._op === 'update').pop().patch);
    R.ok('blank saves as off (null), not 0', progRow && 'default_discount_percent' in progRow && progRow.default_discount_percent === null);
    R.ok('a Setup save does not touch the message template', progRow && !('outreach_body' in progRow));
    // Several Shopify stores: the brand ticks which ones count (20261117030000).
    R.eq(await loop.$$eval('#programBody .pStore', (els) => els.map((e) => `${e.textContent}:${e.classList.contains('is-on')}`).join()), 'brand-a:true,brand-a-retail:true', 'every store is ticked while the program covers all of them');
    const beforeStore = await loop.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_programs' && q._op === 'update').length);
    await loop.click('#programBody .pStore[data-store="brand-a-retail.myshopify.com"]');
    await loop.waitForFunction((n) => window.__QUERIES__.filter((q) => q.table === 'affiliate_programs' && q._op === 'update').length > n, beforeStore, { timeout: 5000 });
    const storeRow = await loop.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_programs' && q._op === 'update').pop().patch);
    R.eq(JSON.stringify(storeRow?.shop_domains), '["brand-a.myshopify.com"]', 'unticking a store saves only the stores still ticked');
    // A chip press saves too, with the choice it shows.
    const before = await loop.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_programs' && q._op === 'update').length);
    await loop.click('#programBody [data-seg="pKind"][data-v="fixed_per_order"]');
    R.ok('choosing a fixed amount shows the amount, not the percent', await loop.evaluate(() => document.getElementById('rowPct').hidden && !document.getElementById('rowFixed').hidden));
    await loop.waitForFunction((n) => window.__QUERIES__.filter((q) => q.table === 'affiliate_programs' && q._op === 'update').length > n, before, { timeout: 5000 }).catch(() => {});
    await loop.close();
    const nomoney = await suite.open('/v2/affiliates/index.html', loopTables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: false } });
    await toProgram(nomoney);
    R.not(await text(nomoney, '#overviewBody'), 'payout to approve', 'someone who cannot approve money is not asked to');
    await nomoney.close();

    // ── no logic buttons: the nightly run and automatic emails do it ──────
    const PX = '66666666-6666-4666-8666-666666666666';
    const autoMail = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_payouts: [{ id: PX, company_entity_id: CO, program_id: PROG, affiliate_id: AFF, status: 'exported', amount_cents: 700, currency: 'USD', item_count: 1, created_at: now, approved_at: now }] },
      { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true, affiliate_mark_payout_paid: true },
        edge: { 'affiliate-invite': { status: 200, body: { email: 'sent' } } } });
    autoMail.on('pageerror', (e) => errors.push(e.message));
    R.ok('no Match orders, Calculate, Update now, Tell affiliate, Email codes or outcome buttons anywhere',
      !(await autoMail.$('[data-act="resolve"], [data-act="accrue"], [data-act="update-commissions"], [data-act="payout-notify"], [data-act="notify-codes"], [data-act="draft-outcome"]')));
    await closeDialog(autoMail);
    await autoMail.click('#tabs [data-tab="payouts"]');
    await autoMail.waitForFunction(() => !!document.querySelector('#payoutsBody [data-act="payout-paid"]'), null, { timeout: 5000 });
    await autoMail.fill(`#ref-${PX}`, 'BANK-1');
    await autoMail.fill(`#pev-${PX}`, 'bank statement');
    await autoMail.click('#payoutsBody [data-act="payout-paid"]');
    await autoMail.click('#payoutsBody [data-act="payout-paid"]').catch(() => {});   // the confirm
    await autoMail.waitForFunction(() => (window.__EDGE_CALLS__ || []).some((c) => c.name === 'affiliate-invite'), null, { timeout: 5000 }).catch(() => {});
    const told = await autoMail.evaluate(() => (window.__EDGE_CALLS__ || []).filter((c) => c.name === 'affiliate-invite').map((c) => c.body));
    R.ok('recording a payment emails the affiliate on its own, about that payout', told.length === 1 && told[0].kind === 'payout_status' && told[0].payout_id === '66666666-6666-4666-8666-666666666666' && told[0].affiliate_id === AFF);
    R.has(await text(autoMail, '#status'), 'The affiliate was emailed', 'and says so');
    await autoMail.close();

    // A payout paid some other way (Send all, a PayPal payment that settled
    // later) is announced when the page next loads, once.
    const PY2 = '77777777-7777-4777-8777-777777777777';
    const PA9 = '99999999-9999-4999-8999-999999999999';
    const catchUp = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_notifications: [], affiliate_payouts: [
        { id: PY2, company_entity_id: CO, program_id: PROG, affiliate_id: AFF, status: 'marked_paid', amount_cents: 900, currency: 'USD', item_count: 1, created_at: now, approved_at: now, marked_paid_at: new Date().toISOString(), paid_notice_claimed_at: null, paid_notice_done_at: null },
        { id: PX, company_entity_id: CO, program_id: PROG, affiliate_id: AFF, status: 'marked_paid', amount_cents: 900, currency: 'USD', item_count: 1, created_at: now, approved_at: now, marked_paid_at: '2026-01-01T00:00:00Z', paid_notice_claimed_at: null, paid_notice_done_at: null },
        { id: PA9, company_entity_id: CO, program_id: PROG, affiliate_id: AFF, status: 'marked_paid', amount_cents: 900, currency: 'USD', item_count: 1, created_at: now, approved_at: now, marked_paid_at: new Date().toISOString(), paid_notice_claimed_at: new Date().toISOString(), paid_notice_done_at: new Date().toISOString() },
      ] },
      { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true }, edge: { 'affiliate-invite': { status: 200, body: { email: 'sent' } } } });
    catchUp.on('pageerror', (e) => errors.push(e.message));
    await catchUp.waitForFunction(() => (window.__EDGE_CALLS__ || []).some((c) => c.name === 'affiliate-invite'), null, { timeout: 5000 }).catch(() => {});
    await closeDialog(catchUp);
    await catchUp.click('#tabs [data-tab="payouts"]');
    await catchUp.waitForTimeout(500);
    const caught = await catchUp.evaluate(() => (window.__EDGE_CALLS__ || []).filter((c) => c.name === 'affiliate-invite').map((c) => c.body.payout_id));
    R.eq(caught.join(), '77777777-7777-4777-8777-777777777777', 'a recently paid payout never announced is announced once; an old one, or one already reserved, is not');
    await catchUp.close();

    // A background refresh that lands while someone is typing does not wipe it.
    const PROG3 = '88888888-8888-4888-8888-888888888888';
    const typing = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: [{ ...tables.affiliate_programs[0], id: PROG3 }],
        affiliate_prospects: [{ ...tables.affiliate_prospects[0], program_id: PROG3, evidence: { title: 'Sam Runs' } }] },
      { ready, rpc: { can_manage_affiliate_programs: true } });
    typing.on('pageerror', (e) => errors.push(e.message));
    let releasePhotos; const photosHeld = new Promise((r) => { releasePhotos = r; });
    await typing.route('**/functions/v1/affiliate-research', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.action === 'refresh_photos') { await photosHeld; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checked: 1, stored: 1 }) }); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checked: 0, updated: 0 }) });
    });
    await typing.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith('silo.affiliates.autorefresh.')).forEach((k) => localStorage.removeItem(k)); } catch (_) {} });
    await typing.reload();
    await typing.waitForFunction(() => !!document.querySelector('#tabs [data-tab="records"]'), null, { timeout: 5000 });
    await openAddCreators(typing);
    await typing.fill('#mpName', 'Half typed');
    await typing.click('body');   // focus off the field: only the typed value keeps it
    const loadsBefore = await typing.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_programs').length);
    releasePhotos();
    await typing.waitForTimeout(1200);
    R.eq(await typing.inputValue('#mpName'), 'Half typed', 'what someone typed survives a background refresh');
    R.ok('and the page was not reloaded under them', (await typing.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_programs').length)) === loadsBefore);
    await typing.close();

    // The other order: the form is clean when the photos land, and the person
    // starts typing while the redraw's own reads are still out.
    const typing2 = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: [{ ...tables.affiliate_programs[0], id: PROG3 }],
        affiliate_prospects: [{ ...tables.affiliate_prospects[0], program_id: PROG3, evidence: { title: 'Sam Runs' } }] },
      { ready, rpc: { can_manage_affiliate_programs: true } });
    typing2.on('pageerror', (e) => errors.push(e.message));
    let release2; const held2 = new Promise((r) => { release2 = r; });
    await typing2.route('**/functions/v1/affiliate-research', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.action === 'refresh_photos') { await held2; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checked: 1, stored: 1 }) }); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checked: 0, updated: 0 }) });
    });
    await typing2.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith('silo.affiliates.autorefresh.')).forEach((k) => localStorage.removeItem(k)); } catch (_) {} });
    await typing2.reload();
    await typing2.waitForFunction(() => !!document.querySelector('#tabs [data-tab="records"]'), null, { timeout: 5000 });
    // An inline field, not the dialog: a dialog keeps what is in it across a
    // redraw, so only a field in the page itself can show the recheck working.
    await toDiscovery(typing2);
    // Hold the redraw's reads, let the photos land on a clean form, then type.
    await typing2.evaluate(() => { let open; window.__FIXTURE_TABLE_GATES__ = { affiliate_programs: new Promise((r) => { open = r; }) }; window.__openGate = open; });
    release2();
    await typing2.waitForTimeout(600);
    await typing2.fill('#rsFocus', 'Typed during the reads');
    await typing2.click('body');
    await typing2.evaluate(() => { window.__openGate(); window.__FIXTURE_TABLE_GATES__ = {}; });
    await typing2.waitForTimeout(800);
    R.eq(await typing2.inputValue('#rsFocus'), 'Typed during the reads', 'typing that starts during the redraw\'s reads survives too');
    await typing2.close();

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
    await closeDialog(pay);
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
    await openRecords(pay);
    await recTab(pay, 'money');
    R.has(await text(pay, '#recordsBody'), '$1,234.56', 'a period total comes from the database, not the lines on the page');
    await pay.close();

    // ── "why didn't this order count?" answered on the page (Blake 2026-11-18) ──
    {
      const lkTables = { ...tables,
        affiliate_commission_ledger: [
          { id: 'l1', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, attribution_id: 'a1', kind: 'accrual', amount_cents: 500, currency: 'USD', order_id: '1001', created_at: '2026-11-02T00:00:00Z' },
          { id: 'l2', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, attribution_id: 'a1', kind: 'refund_adjustment', amount_cents: -200, currency: 'USD', order_id: '1001', memo: 'commissionable base fell to 3000 minor units', created_at: '2026-11-09T00:00:00Z' }],
        affiliate_payout_items: [{ company_entity_id: CO, payout_id: 'pz', ledger_entry_id: 'l1', amount_cents: 500 }],
        affiliate_payouts: [{ id: 'pz', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, status: 'approved', amount_cents: 500, currency: 'USD', created_at: now }],
        shopify_orders: [{ company_entity_id: CO, order_number: '#2002', discount_codes: ['SPRING'] }] };
      const lk = await suite.open('/v2/affiliates/index.html', lkTables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true } });
      lk.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(lk);
      await lk.click('#tabs [data-tab="payouts"]');
      await lk.waitForSelector('#olq', { timeout: 5000 });
      await lk.fill('#olq', '#1001');
      await lk.click('[data-act="order-lookup"]');
      await lk.waitForFunction(() => /Eligible for commission/.test(document.getElementById('payoutsBody')?.textContent || ''), null, { timeout: 5000 });
      const card1 = await text(lk, '#payoutsBody');
      R.ok('an order shows its code, why it counted and the eligible amount', card1.includes('PAT10') && card1.includes('Earns: only code on order') && card1.includes('$50.00'));
      R.ok('and every commission line, with where it went', card1.includes('Earned') && card1.includes('in an approved payout') && card1.includes('Taken back (refund or cancellation)') && card1.includes('not in a payout yet'));
      R.has(card1, '$3.00', 'with the net after the refund');
      await lk.fill('#olq', '2002');
      await lk.click('[data-act="order-lookup"]');
      await lk.waitForFunction(() => /not a code in/.test(document.getElementById('payoutsBody')?.textContent || ''), null, { timeout: 5000 });
      R.has(await text(lk, '#payoutsBody'), 'SPRING', 'an order that did not count says which code it used');
      await lk.fill('#olq', '9999');
      await lk.click('[data-act="order-lookup"]');
      await lk.waitForFunction(() => /SILO has no order 9999 yet/.test(document.getElementById('payoutsBody')?.textContent || ''), null, { timeout: 5000 });
      R.ok('an order SILO has not read yet says so', true);
      await lk.close();
    }

    // ── two calendar dates, and the period they are compared against ──────
    // Blake 2026-11-20: "need date filtering where possible by selecting
    // calendar dates". A range older than the 180 days the page loads must
    // bring BOTH the chosen window and the one before it, or every comparison
    // reads as "new" against a December nobody read.
    {
      const old = (id, day, cents) => ({ id, company_entity_id: CO, program_id: PROG, affiliate_id: AFF, order_id: id, order_number: `#${id}`, order_day: day, order_currency: 'USD', codes_on_order: 1, matched_code: 'PAT10', basis: 'single_affiliate_code', gross_subtotal_cents: cents, refunded_subtotal_cents: 0, commissionable_cents: cents });
      const calTables = { ...tables, affiliate_attributions: [
        ...tables.affiliate_attributions,
        old('j1', '2026-01-10', 20000), old('d1', '2025-12-10', 10000)] };
      const cal = await suite.open('/v2/affiliates/index.html', calTables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true } });
      cal.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(cal);
      await toProgram(cal);
      await cal.waitForSelector('#ovhFrom', { timeout: 5000 });
      await cal.fill('#ovhFrom', '2026-01-31');
      await cal.fill('#ovhTo', '2026-01-01');
      await cal.click('[data-act="ov-range"][data-ns="ovh"]');
      await cal.waitForFunction(() => /first date comes first/i.test(document.getElementById('status')?.textContent || ''), null, { timeout: 5000 });
      R.ok('dates in the wrong order are refused, not read as an empty month', true);
      await cal.fill('#ovhFrom', '2026-01-01');
      await cal.fill('#ovhTo', '2026-01-31');
      await cal.click('[data-act="ov-range"][data-ns="ovh"]');
      await cal.waitForFunction(() => /\$2,000|\$200/.test(document.querySelectorAll('.af-ov-metric')[0]?.textContent || ''), null, { timeout: 8000 });
      const salesTile = await cal.evaluate(() => (document.querySelectorAll('.af-ov-metric')[0] || {}).textContent || '');
      R.has(salesTile, '$200', 'the chosen month is read even though it is older than the loaded window');
      R.not(salesTile, 'new', 'and it is compared against the month before it, which is loaded too');
      R.has(salesTile, '%', 'so the comparison is a real change');
      await cal.close();

      // The start can sit inside the loaded history while the period it is
      // compared against does not: June to November needs the December
      // before it, which a 180-day read does not hold.
      const wideTables = { ...tables, affiliate_attributions: [
        ...tables.affiliate_attributions,
        old('w1', '2026-07-01', 30000), old('w2', '2026-01-05', 15000)] };
      const wide = await suite.open('/v2/affiliates/index.html', wideTables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true } });
      wide.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(wide);
      await toProgram(wide);
      await wide.waitForSelector('#ovhFrom', { timeout: 5000 });
      await wide.fill('#ovhFrom', '2026-06-01');
      await wide.fill('#ovhTo', '2026-11-10');
      await wide.click('[data-act="ov-range"][data-ns="ovh"]');
      await wide.waitForFunction(() => /\$3\d\d/.test(document.querySelectorAll('.af-ov-metric')[0]?.textContent || ''), null, { timeout: 8000 });
      const wideTile = await wide.evaluate(() => (document.querySelectorAll('.af-ov-metric')[0] || {}).textContent || '');
      R.not(wideTile, 'new', 'a range starting inside the loaded history still loads the period it is compared against');
      await wide.close();
    }

    // ── autosave belongs to the program it was made on ────────────────────
    // Edit program A's name, then switch to B before the save fires. The edit
    // must land on A, with A's values -- never on B, and never be dropped.
    const two = await suite.open('/v2/affiliates/index.html', payTables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true } });
    two.on('pageerror', (e) => errors.push(e.message));
    await closeDialog(two);
    await two.click('#tabs [data-tab="program"]');
    await two.waitForSelector('#pName', { timeout: 5000 });
    await two.fill('#pName', 'Edited A');
    await two.press('#pName', 'Tab');
    await two.selectOption('#programSel', PROG2);
    await two.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_programs' && q._op === 'update'), null, { timeout: 5000 }).catch(() => {});
    await two.waitForTimeout(500);
    const twoUps = await two.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_programs' && q._op === 'update')
      .map((q) => ({ id: (q.filters.find((f) => f.col === 'id') || {}).val, name: q.patch?.name })));
    R.ok('the edit is saved to the program it was made on', twoUps.some((u) => u.id === PROG && u.name === 'Edited A'));
    R.ok('and nothing is written to the program switched to', !twoUps.some((u) => u.id === PROG2));
    // Starting a new program right after an edit: the edit still lands on the
    // program it was made on, not read from the blank form that replaced it.
    await two.waitForFunction(() => document.getElementById('programSel')?.value === '55555555-5555-4555-8555-555555555555' && !!document.getElementById('pName'), null, { timeout: 5000 });
    await two.evaluate(() => { window.__QUERIES__.length = 0; });
    await two.fill('#pName', 'Edited again');
    await two.press('#pName', 'Tab');
    await two.click('#btnNewProgram');
    await two.waitForTimeout(700);
    const newUps = await two.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_programs' && q._op === 'update')
      .map((q) => ({ id: (q.filters.find((f) => f.col === 'id') || {}).val, name: q.patch?.name })));
    R.ok('an edit made just before New program is saved as it was made', newUps.length === 1 && newUps[0].id === PROG2 && newUps[0].name === 'Edited again');
    await two.close();

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
    await closeDialog(ai);
    await ai.click('#tabs [data-tab="comms"]');
    await commsChip(ai, 'email');
    await ai.waitForFunction(() => !!document.querySelector('#outreachBody .af-surface'), null, { timeout: 5000 });
    const how = await text(ai, '#aiSendHow');
    R.has(how, 'send approved messages', 'Messages explains send via a connected MCP client');
    R.has(how, 'send allowed', 'Messages ties copy to SILO connection permission');
    R.not(how, 'Claude', 'tab copy does not hardcode an app vendor name');
    R.not(how, 'ChatGPT', 'tab copy does not name other connections');
    R.ok('with an app that can send, the button manages connections instead', !!(await ai.$('#outreachBody a.bcn-btn[href="../settings-connect-ai.html"]:not(.bcn-btn--primary)')) && !(await ai.$('#outreachBody a.bcn-btn--primary[href="../settings-connect-ai.html"]')));
    await openCodeTool(ai);
    R.eq(await ai.inputValue('#cHow'), 'ai', 'with an AI connected, new codes still default to SILO making them');
    R.has(await text(ai, '#aiCodesHow'), 'Shopify codes', 'Affiliates explains codes via MCP without naming an app');
    await ai.evaluate(() => { window.__COPIED__ = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__COPIED__ = t; } } }); });
    await ai.click('#aiCodesHow [data-act="copy-codes-prompt"]');
    await ai.waitForFunction(() => window.__COPIED__ !== null, null, { timeout: 5000 });
    R.has(await ai.evaluate(() => window.__COPIED__), 'mark each one created in SILO', 'one click copies the prompt for their AI');
    await ai.close();

    const member = await suite.open('/v2/affiliates/index.html', tables, { ready, rpc: { can_manage_affiliate_programs: false, can_approve_affiliate_commissions: false } });
    member.on('pageerror', (e) => errors.push(e.message));
    await closeDialog(member);
    await member.click('#tabs [data-tab="people"]');
    R.ok('a member is not offered approve/reject', !(await member.$('#prospectsBody [data-act="prospect-status"]')))
    R.ok('a member is not offered AI research or import', !(await member.$('#prospectsBody [data-act="research-run"]')) && !(await member.$('#prospectsBody [data-act="import-run"]')));
    await closeDialog(member);
    await member.click('#tabs [data-tab="payouts"]');
    R.ok('a member is not offered payouts', !(await member.$('#payoutsBody [data-act="payout-build"]')))
    R.ok('a member sees that money is finance-only, not an empty Money tab', !!(await member.$('#payoutsBody #moneyHidden')));
    await closeDialog(member);
    await member.click('#tabs [data-tab="overview"]');
    await toProgram(member);
    R.not(await text(member, '#overviewBody .af-ov-band'), '$', 'and Home shows no unpaid commission figure');
    R.has(await text(member, '#status'), 'You can view Affiliate Studio', 'the page says why the buttons are missing');
    await member.close();

    // ── join page ─────────────────────────────────────────────────────────
    const calls = [];
    const claimed = new Set();
    const contentItems = [{ id: 'c-old', kind: 'link', link_url: 'https://www.instagram.com/p/old/', caption: 'Old reel', state: 'used', bonus_cents: 2500, currency: 'USD' }];
    const uploads = [];
    await suite.context.route('https://storage.invalid/**', (route) => { uploads.push({ method: route.request().method(), type: route.request().headers()['content-type'] }); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
    // Product seeding: what the rep has asked for so far.
    const seedClaims = [{ id: 's-old', feed_item_id: null, title: 'Rain shell', state: 'purchased', percent: 50, multiple: 3, code: null, email: null, currency: 'USD', paid_cents: 2000, goal_cents: 6000, progress_cents: 3000 }];
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
      if (body.action === 'resolve') return reply(200, { purpose: body.token.startsWith('P') || body.token.startsWith('N') ? 'portal' : 'signup', brand: 'Brand A', brand_logo: body.token.startsWith('P') ? 'https://evil.test/pixel.png' : LOGO,
        program: body.token.startsWith('F') ? { ...program, terms_file: { name: 'Brand A partnership.pdf', url: 'https://files.invalid/signed/agreement.pdf' } }
          : body.token.startsWith('B') ? { ...program, terms_file: { name: null, url: null } } : program, affiliate: { display_name: 'Pat', status: 'invited' }, expires_at: now });
      if (body.action === 'accept') return reply(200, { status: 'active', portal_url: 'https://app.test/v2/affiliates/portal.html?t=' + 'P'.repeat(43), confirmation_email: 'sent', codes_live: ['PAT10'] });
      if (body.action === 'statement') return reply(200, { brand: 'Brand A', photo_url: 'https://photos.invalid/samruns.png', photo_own: false, feed: { code: 'PAT10', store_link: 'https://shop.invalid/discount/PAT10?redirect=%2F', items: [
        { id: 'f1', kind: 'launch', title: 'Spring <b>Drop</b>', event_on: '2099-03-01', note: null, image_url: null, link: 'https://shop.invalid/discount/PAT10?redirect=%2Fcollections%2Fspring', claimed: false, push: [] },
        { id: 'f2', kind: 'launch', title: 'Old drop', event_on: '2026-11-01', note: null, image_url: null, link: 'https://shop.invalid/discount/PAT10?redirect=%2Fcollections%2Fold', claimed: false, push: [] },
        { id: 'f3', kind: 'launch', title: 'Holiday cap', event_on: '2026-11-12', note: 'Limited run.', image_url: 'https://cdn.invalid/cap.jpg', link: 'https://shop.invalid/discount/PAT10?redirect=%2Fproducts%2Fcap', claimed: claimed.has('f3'), push: [{ id: 'g1', title: 'Wool cap', image_url: null, link: null }, { id: 'g2', title: 'Knit beanie', image_url: null, link: null }] },
        { id: 'f4', kind: 'product', title: 'Trail Hat', image_url: null, link: 'https://shop.invalid/discount/PAT10?redirect=%2Fproducts%2Ftrail-hat' },
        { kind: 'ad', title: 'Mud season', note: 'Grip that holds.', image_url: 'https://cdn.invalid/mud.jpg', link: 'https://shop.invalid/discount/PAT10?redirect=%2Fproducts%2Fmud-shoe' }] }, statement: { currency: 'USD', totals: { earned_cents: 1250, paid_cents: 0, unclaimed_cents: 1250, orders: 2, sales_cents: 12500, today: '2026-11-09' }, monthly: [{ month: '2026-11', orders: 2, amount_cents: 1250 }], codes: [{ code: 'PAT10', starts_on: '2026-10-01', ends_on: '2026-11-09', status: 'active' }, { code: 'PATNEXT', starts_on: '2026-11-10', ends_on: null, status: 'active' }, { code: 'PATOLD', starts_on: '2026-01-01', ends_on: '2026-02-01', status: 'retired' }],
        links: [{ destination_url: 'https://shop.invalid/collections/caps', link: 'https://shop.invalid/discount/PAT10?redirect=%2Fcollections%2Fcaps', starts_on: '2026-10-01', status: 'active' }], payouts: [], affiliate: { status: 'active', terms_version_accepted: 3, terms_accepted_at: now } } });
      if (body.action === 'payout_email') return reply(200, { payout_email: String(body.email || '').trim().toLowerCase() || null });
      if (body.action === 'seeds') return reply(200, { offer: { enabled: true, percent: 50, multiple: 3, refund_days: 14, goal_days: 90 }, claims: seedClaims });
      if (body.action === 'seed_request') {
        seedClaims.unshift({ id: 's' + seedClaims.length, feed_item_id: body.item_id || null, title: body.item_id === 'f4' ? 'Trail Hat' : (body.title || '?'), state: 'requested', percent: 50, multiple: 3 });
        return reply(200, { requested: true, replayed: false, id: 's' + seedClaims.length });
      }
      if (body.action === 'claim') {
        if (body.claim === false) claimed.delete(body.item_id); else claimed.add(body.item_id);
        return reply(200, { claimed: claimed.has(body.item_id) });
      }
      // One order per page, so Show more is exercised the way a long history
      // reaches the page.
      if (body.action === 'orders') {
        const all = [
          { order_id: 'gid://1002', order_number: '#1002', order_day: '2026-11-08', order_value_cents: 9000, earned_cents: 900, paid_cents: 0, approved_cents: 0, payable_from: '2099-01-01', code: 'PAT10',
            entries: [{ kind: 'accrual', amount_cents: 900, memo: null, rate_kind: 'percent_of_net', rate_value: 10, basis_cents: 9000, created_at: now }] },
          { order_id: 'gid://1001', order_number: null, order_day: '2026-11-02', order_value_cents: 4000, earned_cents: 350, paid_cents: 350, approved_cents: 0, payable_from: '2026-12-02', code: 'PAT10',
            entries: [{ kind: 'accrual', amount_cents: 400, memo: null, rate_kind: 'percent_of_net', rate_value: 10, basis_cents: 4000, created_at: now },
                      { kind: 'refund_adjustment', amount_cents: -50, memo: 'partial refund', rate_kind: null, rate_value: null, basis_cents: null, created_at: now }] },
        ];
        const off = Number(body.offset) || 0;
        return reply(200, { orders: all.slice(off, off + 1), total: all.length, limit: 1, offset: off });
      }
      if (body.action === 'photo') return reply(200, body.remove ? { photo_url: null, own: false } : { photo_url: 'https://photos.invalid/me.jpg?v=2', own: true });
      if (body.action === 'apply') return reply(200, { status: 'received' });
      if (body.action === 'program_info') return reply(200, body.program === 'creators' ? { open: true, brand: 'Brand A', brand_logo: LOGO, program: 'Creators', perks: ['10% of every sale', '10% off code for your audience'] } : { open: false });
      // Content (20261117050000): what the rep shared, and the signed upload.
      if (body.action === 'content') return reply(200, { bonus_cents: 2500, currency: 'USD', items: contentItems });
      if (body.action === 'content_start') {
        if (body.kind === 'link') { contentItems.unshift({ id: 'cl' + contentItems.length, kind: 'link', link_url: body.link_url, caption: body.caption || null, state: 'submitted' }); return reply(200, { id: 'cl', state: 'submitted' }); }
        return reply(200, { id: 'cf1', state: 'uploading', upload_url: 'https://storage.invalid/upload/sign/affiliate-content/cf1/content.mp4?token=t' });
      }
      if (body.action === 'content_finish') { contentItems.unshift({ id: body.id, kind: 'file', file_type: 'video/mp4', caption: null, state: 'submitted' }); return reply(200, { id: body.id, state: 'submitted' }); }
      return reply(400, { error: 'unexpected' });
    });
    const LOGO = `https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/company-logos/${PROG}/logo-1762758000000.png`;
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await suite.context.route('**/company-logos/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    await suite.context.route('https://cdn.invalid/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    await suite.context.route('https://www.paypalobjects.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="88" height="24"/>' }));
    await suite.context.route('https://evil.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    const join = await suite.open('/v2/affiliates/join.html?t=' + 'S'.repeat(43), {}, { ready: () => !!document.getElementById('form') });
    join.on('pageerror', (e) => errors.push(e.message));
    R.ok('the token is removed from the address bar', !(await join.evaluate(() => location.search.includes('t='))))
    R.ok('terms are rendered as text: no element from the brand text', !(await join.evaluate(() => document.querySelector('#terms img'))))
    R.ok('nothing in the terms runs', !(await join.evaluate(() => window.__pwned)))
    R.ok('the affiliate page carries no SILO navigation', !(await join.$('.silo-sidebar, nav.silo-nav, #silo-app')))
    const hero = await text(join, '#hero');
    R.ok('the invitation names the brand and leads with the offer', /Join the .+ partner program/.test(hero) && /\S/.test(await text(join, '#offer')));
    R.has(hero, 'Sign the agreement', 'the three steps say what happens next');
    R.ok('the sign-up page uses the same layout as the apply page', !!(await join.$('.ap-shell .ap-brand #hero')) && !!(await join.$('.ap-card #form')));
    R.ok('a program with no agreement file shows no file row', !(await join.$('#termsDoc')));
    R.eq(await join.evaluate(() => document.querySelector('#hero .ap-mark img.af-logo')?.getAttribute('src')), LOGO, 'the company logo heads the invitation');
    R.eq(await join.evaluate(() => document.querySelector('#hero img.af-logo')?.alt), 'Brand A', 'with the brand name as its text');
    R.ok('the platform terms are linked next to the program terms', !!(await join.$('a[href="/legal/affiliate-terms.html"]')));
    await join.fill('#paypal', 'pat@pay.invalid');
    await join.fill('#signed', 'Pat Trails');
    await join.check('#agree');
    await join.click('#go');
    // innerText, not textContent: the page's own inline script contains the words.
    await join.waitForFunction(() => /You are in/.test(document.body.innerText), null, { timeout: 5000 });
    const doneText = await join.evaluate(() => document.body.innerText);
    const acc = calls.find((c) => c.action === 'accept');
    R.eq(acc?.terms_version, 3, 'acceptance sends the version that was on screen');
    R.eq(acc?.platform_terms_version, 1, 'and the platform terms version');
    R.eq(acc?.signed_name, 'Pat Trails');
    R.eq(acc?.payout_email, 'pat@pay.invalid', 'the PayPal email is asked at signup');
    R.has(doneText.replace(/\s+/g, ' '), 'Your code PAT10 is live', 'a code SILO already made is named, not promised');
    await join.close();
    // The brand's agreement as a PDF (20261119010000): linked to open, and a
    // file that could not be linked blocks the signature.
    const joinF = await suite.open('/v2/affiliates/join.html?t=' + 'F'.repeat(43), {}, { ready: () => !!document.getElementById('form') });
    joinF.on('pageerror', (e) => errors.push(e.message));
    R.eq(await joinF.evaluate(() => document.querySelector('#termsDoc')?.getAttribute('href')), 'https://files.invalid/signed/agreement.pdf', 'the agreement PDF opens from the sign-up page');
    R.has(await text(joinF, '#termsDoc'), 'Brand A partnership.pdf', 'named as the brand uploaded it');
    R.ok('a linked agreement can be signed', await joinF.evaluate(() => !document.getElementById('go').disabled));
    await joinF.close();
    const joinB = await suite.open('/v2/affiliates/join.html?t=' + 'B'.repeat(43), {}, { ready: () => !!document.getElementById('form') });
    joinB.on('pageerror', (e) => errors.push(e.message));
    R.ok('an agreement that did not load cannot be signed', await joinB.evaluate(() => document.getElementById('go').disabled));
    R.has(await text(joinB, '#termsDoc'), 'did not load', 'and says so');
    await joinB.close();

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
    await tab(portal, 'profile');
    await portal.click('#meRemove');
    await portal.waitForFunction(() => (document.getElementById('meCard')?.textContent || '').includes('Add photo'), null, { timeout: 5000 }).catch(() => {});
    R.ok('removing asks the portal to remove it', calls.some((c) => c.action === 'photo' && c.remove === true));
    R.ok('a removed photo leaves the initial', !(await portal.$('#meCard img')) && (await text(portal, '#meCard')).includes('Add photo'));
    await tab(portal, 'home');
    const fb = await text(portal, '#body');
    R.has(fb, 'Share and earn', 'the portal shows what the brand shared');
    R.has(fb, 'Spring <b>Drop</b>', 'shared titles are text, never markup');
    R.ok('no element is built from a shared title', !(await portal.$('#body b')));
    const copies = await portal.$$eval('#hero [data-copy], #body [data-copy]', (b) => b.map((x) => x.dataset.copy));
    R.eq(copies.length, 7, 'a copy button for the store link, each upcoming drop, each shared item, the saved link and the ad\'s caption');
    const cal = await portal.$$eval('#calendar [data-cal-date]', (rows) => rows.map((r) => r.dataset.cal_date || r.getAttribute('data-cal-date')));
    R.eq(cal, ['2026-11-12', '2099-03-01'], 'the calendar lists upcoming drops soonest first, past ones left off (company day)');
    R.ok('a drop within a week is marked', !!(await portal.$('#calendar [data-cal-date="2026-11-12"].is-soon')) && !(await portal.$('#calendar [data-cal-date="2099-03-01"].is-soon')));
    R.ok('drops sit in the calendar, not the tile grid', !(await portal.$('#feed [data-kind="launch"]')));
    // Claiming a drop: a hand up, which the brand sees, and which tells the
    // rep what to push. Nothing about it is paid or exclusive.
    R.ok('each upcoming drop can be claimed', (await portal.$$('#calendar [data-claim]')).length === 2);
    R.ok('nothing says what to push before it is claimed', !(await portal.$('#calendar .af-push')));
    await portal.click('#calendar [data-cal-item="f3"] [data-claim]');
    await portal.waitForFunction(() => !!document.querySelector('#calendar [data-cal-item="f3"] .af-push'), null, { timeout: 5000 });
    const claimCall = calls.filter((c) => c.action === 'claim').pop();
    R.eq([claimCall?.item_id, claimCall?.claim], ['f3', true], 'the claim names the drop and is sent as a claim');
    R.has(await text(portal, '#calendar [data-cal-item="f3"]'), 'Wool cap', 'a claimed drop lists the products to push');
    R.has(await text(portal, '#calendar [data-cal-item="f3"] [data-claim]'), 'Claimed', 'and the button says so');
    R.ok('an unclaimed drop is unchanged', !(await portal.$('#calendar [data-cal-item="f1"] .af-push')));
    await portal.click('#calendar [data-cal-item="f3"] [data-claim]');
    await portal.waitForFunction(() => !document.querySelector('#calendar [data-cal-item="f3"] .af-push'), null, { timeout: 5000 });
    R.eq(calls.filter((c) => c.action === 'claim').pop()?.claim, false, 'pressing it again takes the hand down');
    // The rep's own orders: their side of each one, never the customer's.
    await portal.waitForFunction(() => (document.getElementById('ordersCard')?.textContent || '').includes('#1002'), null, { timeout: 5000 });
    const ords = await text(portal, '#ordersCard');
    R.has(ords, '$9.00', 'an order shows what the rep earned on it');
    R.has(ords, 'pending · refund window ends 2099-01-01', 'and why it is not paid yet: the refund window');
    R.has(ords, 'Pending: the refund window is still open', 'the three states are explained once');
    R.ok('an order opens onto the lines behind it', !!(await portal.$('#ordersCard details.af-ord-row')));
    await tab(portal, 'earnings');
    await portal.click('#ordersCard details.af-ord-row > summary');
    R.has(await text(portal, '#ordersCard details.af-ord-row[open]'), '10% of $90.00', 'the drill-down says how the commission was worked out');
    R.eq((await portal.$$('#ordersCard .af-ord-row')).length, 1, 'a long history pages, rather than arriving at once');
    await portal.click('#ordMore');
    await portal.waitForFunction(() => document.querySelectorAll('#ordersCard .af-ord-row').length === 2, null, { timeout: 5000 });
    const ords2 = await text(portal, '#ordersCard');
    R.has(ords2, 'partial refund', 'a refund on an order is shown as its own line');
    R.has(await text(portal, '#ordersCard [data-order="gid://1001"] summary'), 'paid', 'a paid order says paid');
    R.ok('an order the rep opened stays open when more arrive', !!(await portal.$('#ordersCard .af-ord-row[open]')));
    R.has(ords2, '#1001', 'an order with no shop number is numbered from its id');
    R.ok('and the raw store id is not shown', !(await text(portal, '#ordersCard')).includes('gid://'));
    R.ok('the portal never asks for customer data', !calls.some((c) => c.action === 'orders' && ('customer' in c)));
    // The shot is taken with a drop claimed, which is what the calendar looks like in use.
    await tab(portal, 'home');
    await portal.click('#calendar [data-cal-item="f3"] [data-claim]');
    await portal.waitForFunction(() => !!document.querySelector('#calendar [data-cal-item="f3"] .af-push'), null, { timeout: 5000 });
    if (process.env.PORTAL_SHOT) { await portal.setViewportSize({ width: 1280, height: 900 }); await portal.screenshot({ path: process.env.PORTAL_SHOT, fullPage: true }); await portal.setViewportSize({ width: 390, height: 844 }); await portal.screenshot({ path: process.env.PORTAL_SHOT.replace('.png', '-phone.png'), fullPage: true }); }
    R.ok('an ad\'s caption can be copied to repost', copies.includes('Grip that holds.'));
    R.has(fb, 'Ads to repost', 'shared ads have their own section');
    R.ok('a shared ad shows its picture, with a way to save it', !!(await portal.$('#body .af-media img[src="https://cdn.invalid/mud.jpg"]')) && !!(await portal.$('#body a[href="https://cdn.invalid/mud.jpg"][download]')));
    // A link is a button to copy and one to open, not a line of text.
    R.ok('a link to a store page is the code link', copies.includes('https://shop.invalid/discount/PAT10?redirect=%2Fcollections%2Fcaps'));
    R.ok('and it can be opened', !!(await portal.$('#body a.bcn-btn[href="https://shop.invalid/discount/PAT10?redirect=%2Fcollections%2Fcaps"]')));
    R.ok('no raw address is left for the rep to select by hand', !(await portal.$('#body .af-links .af-copy')));
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

    // ── portal: product seeding ───────────────────────────────────────────
    // A rep asks for a shared product (or a launch's product, or another one)
    // at the seeding price; the brand approves each before a code exists.
    const seedPage = await suite.open('/v2/affiliates/portal.html?t=' + 'P'.repeat(43), {}, { ready: () => !document.getElementById('kpis').hidden });
    seedPage.on('pageerror', (e) => errors.push(e.message));
    R.has(await text(seedPage, '#feed'), 'Get it 50% off', 'a shared product can be asked for at the seeding price');
    R.ok('a launch product can be asked for too', !!(await seedPage.$('#calendar [data-cal-item="f3"] [data-seed="g1"]')));
    R.has(await text(seedPage, '#seedCard'), '$30.00 / $60.00', 'progress is shown against 3x what they paid');
    R.has(await text(seedPage, '#seedCard'), 'sell 3× what you paid', 'the terms are one line');
    await seedPage.click('#feed [data-seed="f4"]');
    await seedPage.waitForFunction(() => !document.querySelector('#feed [data-seed="f4"]'), null, { timeout: 5000 });
    R.eq(calls.filter((c) => c.action === 'seed_request').pop()?.item_id, 'f4', 'the request names the product the rep pressed');
    R.has(await text(seedPage, '#feed'), 'Waiting for the brand', 'the button becomes its state, in place');
    R.has(await text(seedPage, '#seedCard'), 'Trail Hat', 'and it is listed under Your products');
    R.ok('a product cannot be typed in: only what the brand shared is asked for', !(await seedPage.$('#seedCard input, #seedAsk, #seedTitle')));
    // Where the rep gets paid: right under their photo, shown as their
    // PayPal account once set, with the field only while changing it.
    const tabs = await seedPage.$$eval('#tabs [data-tab]', (b) => b.map((x) => x.textContent));
    R.eq(tabs, ['Home', 'Earnings', 'Products', 'Posts', 'Profile', 'Support'], 'the portal is tabs, with Profile and Support');
    R.ok('one tab shows at a time', (await seedPage.$$eval('[data-panel]', (p) => p.filter((x) => !x.hidden).length)) === 1);
    await tab(seedPage, 'profile');
    const prof = await seedPage.evaluate(() => [...document.querySelectorAll('[data-panel="profile"] h2')].map((h) => h.textContent));
    R.eq(prof, ['Where you get paid', 'Your photo'], 'Profile holds where they get paid and their photo');
    await tab(seedPage, 'support');
    R.has(await text(seedPage, '[data-panel="support"]'), 'reply to any email from Brand A', 'Support names the brand');
    R.ok('it carries the PayPal mark', !!(await seedPage.$('#payEmailCard img.af-pay-mark[alt="PayPal"]')));
    await tab(seedPage, 'profile');
    await seedPage.fill('#payEmail', 'Pat@Pay.Invalid');
    await seedPage.press('#payEmail', 'Enter');
    await seedPage.waitForSelector('#payEmailCard .af-pay-email', { timeout: 5000 });
    R.eq(await text(seedPage, '#payEmailCard .af-pay-email'), 'pat@pay.invalid', 'once saved it reads as the connected account');
    R.ok('with no open field', !(await seedPage.$('#payEmail')));
    await seedPage.click('#payEmailEdit');
    R.eq(await seedPage.inputValue('#payEmail'), 'pat@pay.invalid', 'Change opens the field with the address on file');
    await seedPage.close();

    // ── portal: add to home screen (Blake 2026-11-17) ─────────────────────
    const inst = await suite.open('/v2/affiliates/portal.html?t=' + 'P'.repeat(43), {}, { ready: () => !document.getElementById('kpis').hidden });
    inst.on('pageerror', (e) => errors.push(e.message));
    R.ok('a computer is not offered a home screen', !(await inst.$('#afInstall')));
    R.ok('the manifest opens the portal WITH the rep\'s link', await inst.evaluate(() => {
      const h = document.querySelector('link[rel="manifest"]')?.href || '';
      const m = JSON.parse(decodeURIComponent(h.replace(/^data:application\/manifest\+json,/, '')));
      return m.start_url.endsWith('/v2/affiliates/portal.html?t=' + 'P'.repeat(43)) && m.display === 'standalone' && m.name === 'Brand A affiliate';
    }));
    await inst.evaluate(async () => {
      Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' });
      const m = await import('/v2/affiliates/install.js');
      await m.setupInstall({ token: 'P'.repeat(43), brand: 'Brand A', logo: null, mount: document.getElementById('install') });
    });
    R.has(await text(inst, '#install'), 'Get the Brand A app', 'a phone is offered the app, in the brand\'s name');
    R.eq(new URL(inst.url()).searchParams.get('t'), null, 'the link is not in the address bar until asked');
    await inst.click('#afInstallGo');
    R.has(await text(inst, '#afInstallSheet'), 'Add to Home Screen', 'iPhone gets the Safari steps');
    R.eq(new URL(inst.url()).searchParams.get('t'), 'P'.repeat(43), 'and the address Safari saves carries the rep\'s link');
    await inst.click('#afSheetOk');
    await inst.click('#afInstallX');
    R.ok('Not now hides it', !(await inst.$('#afInstall')));
    await inst.close();

    // ── portal: content for the brand ─────────────────────────────────────
    const ctPage = await suite.open('/v2/affiliates/portal.html?t=' + 'P'.repeat(43), {}, { ready: () => !!document.getElementById('contentCard') });
    ctPage.on('pageerror', (e) => errors.push(e.message));
    const cc = await text(ctPage, '#contentCard');
    R.has(cc, 'Picked content earns $25.00', 'the portal says what picked content earns');
    R.has(cc, '+$25.00', 'a picked piece shows its bonus');
    await tab(ctPage, 'content');
    await ctPage.fill('#ctLink', 'https://www.tiktok.com/@pat/video/1');
    await ctPage.fill('#ctCaption', 'Cage drill');
    await ctPage.click('#ctLinkGo');
    await ctPage.waitForFunction(() => /Cage drill/.test(document.getElementById('contentCard')?.textContent || ''), null, { timeout: 5000 });
    const sl = calls.filter((c) => c.action === 'content_start').pop();
    R.eq([sl.kind, sl.link_url, sl.caption], ['link', 'https://www.tiktok.com/@pat/video/1', 'Cage drill'], 'a link is shared with its caption');
    await ctPage.setInputFiles('#ctFile', { name: 'reel.mp4', mimeType: 'video/mp4', buffer: Buffer.from('fake video bytes') });
    await ctPage.waitForFunction(() => /Uploaded/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 5000 });
    const sf = calls.filter((c) => c.action === 'content_start').pop();
    R.eq([sf.kind, sf.file_type, sf.file_bytes], ['file', 'video/mp4', 16], 'the file is announced by type and size, never sent through the function');
    R.eq(uploads.map((u) => [u.method, u.type]), [['PUT', 'video/mp4']], 'the file goes straight to the signed upload address');
    R.eq(calls.filter((c) => c.action === 'content_finish').pop()?.id, 'cf1', 'and the upload is finished only after it landed');
    await ctPage.setInputFiles('#ctFile', { name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('x') });
    R.has(await text(ctPage, '#status'), 'Upload a photo or a video', 'other files are refused before anything is sent');
    await ctPage.close();

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
    await closeDialog(ppOff);
    await ppOff.click('#tabs [data-tab="payouts"]');
    const offText = await text(ppOff, '#payoutsBody');
    R.has(offText, 'Connect PayPal', 'an unconnected program is asked to connect');
    R.ok('with somewhere to get Payouts access', !!(await ppOff.$('#payoutsBody a[href*="payoutsweb/landing"]')));
    R.ok('no Send button before PayPal is connected', !(await ppOff.$('#payoutsBody [data-act="pp-send"]')));
    R.ok('setup offers no Sandbox choice (live only)', !(await ppOff.$('#ppEnv')) && !/sandbox/i.test(offText));
    if (process.env.PP_SHOT) { await ppOff.setViewportSize({ width: 1280, height: 1000 }); await (await ppOff.$('#payoutsBody')).screenshot({ path: process.env.PP_SHOT }); }
    const voidOpener = `#payoutsBody [data-act="payout-void-open"][data-id="${PP}"]`;
    R.ok('void starts as one button, no reason box showing', !(await ppOff.isVisible(`#vr-${PP}`)) && await ppOff.isVisible(voidOpener));
    await ppOff.fill('#ppId', 'typed-before-void');
    await ppOff.click(voidOpener);
    R.ok('pressing Void opens the reason box', await ppOff.isVisible(`#vr-${PP}`));
    await ppOff.click(`#payoutsBody [data-act="payout-void-close"][data-id="${PP}"]`);
    R.ok('Cancel closes it and brings the Void button back', !(await ppOff.isVisible(`#vr-${PP}`)) && await ppOff.isVisible(voidOpener));
    R.ok('opening and cancelling Void keeps what was typed elsewhere on Money', (await ppOff.inputValue('#ppId')) === 'typed-before-void');
    R.has(offText, 'Connect PayPal first', 'and the payout says why it cannot be sent');
    await ppOff.close();

    // Invited, never signed up, then ended (Quintin, Blake 2026-11-18: "there is
    // no resend button"): his own card offers the invite again; a signed-up
    // affiliate's card does not.
    {
      const QA = 'aaaaaaaa-0000-4000-8000-00000000e0d0';
      const endTables = { ...tables,
        affiliate_prospects: [...tables.affiliate_prospects, { id: 'p-end', company_entity_id: CO, program_id: PROG, display_name: 'Quin Ended', platform: 'instagram', handle: '@quinend', contact_email: 'quinend@creator.invalid', source: 'manual', collected_at: now, evidence: { found_via: 'met at a tournament' }, status: 'invited', affiliate_id: QA }],
        affiliates: [...tables.affiliates, { id: QA, company_entity_id: CO, program_id: PROG, display_name: 'Quin Ended', contact_email: 'quinend@creator.invalid', status: 'terminated', terms_accepted_at: null, created_at: now, from_prospect_id: 'p-end' }] };
      const endPage = await suite.open('/v2/affiliates/index.html', endTables, { ready, rpc: { can_manage_affiliate_programs: true } });
      endPage.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(endPage);
      await endPage.click('#tabs [data-tab="people"]');
      R.ok('an ended affiliate is archived out of the current list', !(await text(endPage, '#affiliatesBody')).includes('Quin Ended'));
      R.has(await text(endPage, '#affiliatesBody [data-act="aff-filter"][data-f="ended"]'), '1', 'the Ended chip counts the archived affiliate');
      // The code form is a modal now (Blake 2026-11-20): while it is open it
      // covers the page, and closing it drops what was half typed rather than
      // leaving a stale form behind a list the person has since changed.
      await toAffiliates(endPage);
      await endPage.click('#affiliatesBody [data-act="aff-tool"][data-k="code"]');
      await endPage.fill('#cCode', 'DRAFT25'); await endPage.fill('#cPct', '25');
      R.ok('the code form opens over the page, not at the top of the list', await endPage.evaluate(() => document.getElementById('afDialog')?.open === true));
      await endPage.click('#afDialogBody [data-act="dialog-close"]');
      await endPage.waitForFunction(() => document.getElementById('afDialog')?.open !== true, null, { timeout: 5000 });
      await toAffiliates(endPage);
      await endPage.click('#affiliatesBody [data-act="aff-filter"][data-f="ended"]');
      R.has(await text(endPage, '#affiliatesBody'), 'Quin Ended', 'Ended shows the archived affiliate');
      R.ok('closing the form drops what was half typed', !(await endPage.$('#cCode')));
      R.ok('an ended, never-signed-up affiliate can be invited again from their card', !!(await endPage.$('#affiliatesBody [data-act="invite-send"][data-id="p-end"]')));
      await toAffiliates(endPage);
      await endPage.click('#affiliatesBody [data-act="aff-filter"][data-f="current"]');
      R.ok('a signed-up affiliate gets no invite button', !(await endPage.$('#affiliatesBody [data-act="invite-send"][data-id="p1"]')));
      await toDiscovery(endPage);
      await endPage.click('#prospectsBody [data-f="approved"]').catch(() => {});
      await toTiles(endPage);
      R.has(await text(endPage, '#prospectsBody'), 'found via met at a tournament', 'a saved "where found" note is shown on the creator card');
      await endPage.close();
    }

    // A new program sees the steps to its first invite on Home, and only the
    // next one carries a button (Blake 2026-11-18).
    {
      const fresh = await suite.open('/v2/affiliates/index.html', { ...tables, affiliates: [], affiliate_prospects: [], affiliate_codes: [] }, { ready, rpc: { can_manage_affiliate_programs: true } });
      fresh.on('pageerror', (e) => errors.push(e.message));
      await toProgram(fresh);
      await fresh.waitForSelector('#firstInvite', { timeout: 5000 });
      const fi = await text(fresh, '#firstInvite');
      R.has(fi, 'Get to your first invite', 'Home shows the setup checklist before anyone is invited');
      R.has(fi, 'Connect your Shopify store', 'starting with the store');
      const nextStep = await fresh.evaluate(() => [...document.querySelectorAll('#firstInvite [data-setup-step]')].filter((r) => r.querySelector('.bcn-btn')).map((r) => r.textContent));
      R.eq(nextStep.length, 1, 'only the next step has a button');
      R.ok('and it is the first step not done', /Add your first creator/.test(nextStep[0] || '') || /website/.test(nextStep[0] || ''));
      await fresh.close();
    }
    {
      const has = await suite.open('/v2/affiliates/index.html', tables, { ready, rpc: { can_manage_affiliate_programs: true } });
      await toProgram(has);
      await has.waitForSelector('#overviewBody .af-ov-metrics', { timeout: 5000 });
      R.ok('the checklist is gone once someone was invited', !(await has.$('#firstInvite')));
      await has.close();
    }

    // One status line per affiliate with the next step on it (Blake
    // 2026-11-18: "invite sent, accepted, code active, or code failed").
    {
      const QS = 'aaaaaaaa-0000-4000-8000-00000000e0d1';
      const stTables = { ...tables,
        affiliate_prospects: [...tables.affiliate_prospects, { id: 'p-stuck', company_entity_id: CO, program_id: PROG, display_name: 'Sam Stuck', platform: 'instagram', handle: '@samstuck', contact_email: 'sam@typo.invalid', source: 'manual', collected_at: now, evidence: {}, status: 'invited', affiliate_id: QS }],
        affiliates: [...tables.affiliates, { id: QS, company_entity_id: CO, program_id: PROG, display_name: 'Sam Stuck', contact_email: 'sam@typo.invalid', status: 'invited', terms_accepted_at: null, created_at: now, from_prospect_id: 'p-stuck' }],
        affiliate_notifications: [{ id: 'n-stuck', company_entity_id: CO, program_id: PROG, affiliate_id: QS, kind: 'signup_invite', to_email: 'sam@typo.invalid', status: 'failed', reason: 'address bounced', created_at: now }],
        affiliate_codes: [...tables.affiliate_codes.filter((c) => c.affiliate_id !== AFF), { id: 'c-wait', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, code: 'PATWAIT', starts_on: '2026-11-10', ends_on: null, status: 'pending', discount_percent: 10 }] };
      const st = await suite.open('/v2/affiliates/index.html', stTables, { ready, rpc: { can_manage_affiliate_programs: true } });
      st.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(st);
      await st.click('#tabs [data-tab="people"]');
      await st.waitForFunction(() => (document.getElementById('affiliatesBody')?.textContent || '').includes('Sam Stuck'), null, { timeout: 5000 });
      const body = await text(st, '#affiliatesBody');
      R.has(body, 'Invite not delivered', 'a bounced invite shows on the affiliate');
      R.has(body, 'address bounced', 'with the reason');
      R.ok('with Resend right there', !!(await st.$('#affiliatesBody .af-step [data-act="invite-send"][data-id="p-stuck"]')));
      R.has(body, 'Code PATWAIT not in Shopify yet', 'a code that was not made shows as failed');
      R.ok('with Retry code for that code', !!(await st.$('#affiliatesBody .af-step [data-act="code-make"][data-id="c-wait"]')));
      R.has(body, 'Signed up', 'a signed-up affiliate says so');
      await toAffiliates(st);
      await st.click('#affiliatesBody .af-step [data-act="prospect-edit"][data-id="p-stuck"]');
      await st.waitForSelector('#epEmail', { timeout: 5000 });
      await st.fill('#epEmail', 'sam@fixed.invalid');
      await st.click('[data-act="prospect-save"]');
      await st.waitForFunction(() => /Resend the invite/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 5000 });
      const upd = await st.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliates' && q._op === 'update').pop());
      R.eq(upd?.patch?.contact_email, 'sam@fixed.invalid', 'Fix email updates the invited affiliate too, so the resend reaches the new address');
      await st.close();
    }

    const connected = [{ company_entity_id: CO, provider: 'paypal', environment: 'sandbox', is_active: true, account_email: 'brand@pay.invalid', payouts_enabled: true, credentials_set: true, last_tested_at: now, last_test_success: true, last_test_error: null, last_send_at: null }];

    const ppNoAddr = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: ppProgram, affiliate_payouts: ppPayout, affiliate_payout_connection_status_v: connected },
      { ready, rpc: ppRpc });
    ppNoAddr.on('pageerror', (e) => errors.push(e.message));
    await closeDialog(ppNoAddr);
    await ppNoAddr.click('#tabs [data-tab="payouts"]');
    const noAddr = await text(ppNoAddr, '#payoutsBody');
    R.has(noAddr, 'brand@pay.invalid', 'a connected rail names the account it pays from');
    R.ok('under the PayPal mark, marked Sandbox', !!(await ppNoAddr.$('#payoutsBody .af-pp-head img[alt="PayPal"]')) && (await text(ppNoAddr, '#payoutsBody .af-pp-head')).includes('Sandbox'));
    R.ok('the flow ends in PayPal', !!(await ppNoAddr.$('#payoutsBody .af-flow-step:last-child img[alt="PayPal"]')));
    R.has(noAddr, 'No PayPal address from them yet', 'an affiliate who has not given an address cannot be paid');
    R.ok('and there is nothing to click', !(await ppNoAddr.$('#payoutsBody [data-act="pp-send"]')));
    await ppNoAddr.close();

    const ppReady = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: ppProgram, affiliate_payouts: ppPayout, affiliate_payout_connection_status_v: connected,
        affiliate_payout_accounts: [{ company_entity_id: CO, affiliate_id: AFF, provider: 'paypal', payout_email: 'pat@pay.invalid' }] },
      { ready, rpc: ppRpc });
    ppReady.on('pageerror', (e) => errors.push(e.message));
    await closeDialog(ppReady);
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
    await closeDialog(ppLive);
    await ppLive.click('#tabs [data-tab="payouts"]');
    const liveText = await text(ppLive, '#payoutsBody');
    R.has(liveText, 'Send with PayPal', 'a live rail sends for real');
    R.ok('and says nothing about sandbox', !/Sandbox: test payments only/.test(liveText));
    await ppLive.close();

    // The bug the first sandbox run turned up: the payout was already paid and
    // the page still offered to send it. The claim refuses a second attempt, so
    // the button could only ever produce an error -- but it reads as "not paid".
    const ppPaid = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: ppProgram, affiliate_payouts: ppPayout, affiliate_payout_connection_status_v: connected,
        affiliate_payout_accounts: [{ company_entity_id: CO, affiliate_id: AFF, provider: 'paypal', payout_email: 'pat@pay.invalid' }],
        affiliate_payout_sends: [{ id: 'send-paid', payout_id: PP, attempt: 1, state: 'paid', provider_status: 'SUCCESS', provider_item_id: 'i1', error_code: null, error_message: null, environment: 'sandbox', created_at: now }] },
      { ready, rpc: ppRpc });
    ppPaid.on('pageerror', (e) => errors.push(e.message));
    await closeDialog(ppPaid);
    await ppPaid.click('#tabs [data-tab="payouts"]');
    const paidText = await text(ppPaid, '#payoutsBody');
    R.ok('a payout already paid is never offered another send',
      !(await ppPaid.$('#payoutsBody [data-act="pp-send"]')));
    R.ok('and it is not swept up by Send all either',
      !(await ppPaid.$('[data-act="pp-send-all"]')));
    R.has(paidText, 'PayPal (sandbox test): paid', 'the row says it is paid');
    await ppPaid.close();

    // Pay day is one button. It must send exactly what the rows would send one
    // at a time -- an affiliate who has given no PayPal address is skipped, not
    // attempted, because the attempt would be refused with their money owed.
    const AFF2 = '77777777-7777-4777-8777-777777777777';
    const PP2 = '88888888-8888-4888-8888-888888888888';
    const ppAll = await suite.open('/v2/affiliates/index.html',
      { ...tables,
        affiliate_programs: ppProgram,
        affiliates: [...tables.affiliates, { ...tables.affiliates[0], id: AFF2, display_name: 'Jo Hills', contact_email: 'jo@creator.invalid', from_prospect_id: null }],
        affiliate_payouts: [...ppPayout, { ...ppPayout[0], id: PP2, affiliate_id: AFF2 }],
        affiliate_payout_connection_status_v: connected,
        affiliate_payout_accounts: [{ company_entity_id: CO, affiliate_id: AFF, provider: 'paypal', payout_email: 'pat@pay.invalid' }],
        affiliate_payout_sends: [] },
      { ready, rpc: ppRpc, edge: { 'affiliate-payouts': { status: 200, body: { state: 'paid' } } } });
    ppAll.on('pageerror', (e) => errors.push(e.message));
    await closeDialog(ppAll);
    await ppAll.click('#tabs [data-tab="payouts"]');
    const allText = await text(ppAll, '#payoutsBody');
    R.has(allText, 'Test send 1 approved payout', 'Send all counts only the payouts it can actually send');
    await ppAll.click('[data-act="pp-send-all"]');
    await ppAll.click('[data-act="pp-send-all"]');   // the confirm
    await ppAll.waitForFunction(() => (window.__EDGE_CALLS__ || []).some((c) => c.body?.action === 'send'), { timeout: 5000 }).catch(() => {});
    const sentAll = await ppAll.evaluate(() => (window.__EDGE_CALLS__ || []).filter((c) => c.body?.action === 'send').map((c) => c.body.payout_id));
    R.eq(sentAll, [PP], 'and sends only those, skipping the affiliate with no address');
    await ppAll.close();

    // The case the whole design is built around: an attempt that never
    // answered. PayPal may already have taken the money, so there is no second
    // Send -- and the check happens by itself rather than behind a button
    // somebody has to know to press.
    const ppFlight = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: ppProgram, affiliate_payouts: ppPayout, affiliate_payout_connection_status_v: connected,
        affiliate_payout_accounts: [{ company_entity_id: CO, affiliate_id: AFF, provider: 'paypal', payout_email: 'pat@pay.invalid' }],
        affiliate_payout_sends: [{ id: 'send-1', payout_id: PP, attempt: 1, state: 'unknown', provider_status: null, provider_item_id: null, error_code: null, error_message: null, environment: 'sandbox', created_at: now }] },
      { ready, rpc: ppRpc, edge: { 'affiliate-payouts': { status: 200, body: { checked: 1, results: [{ state: 'sent' }] } } } });
    ppFlight.on('pageerror', (e) => errors.push(e.message));
    await closeDialog(ppFlight);
    await ppFlight.click('#tabs [data-tab="payouts"]');
    const flight = await text(ppFlight, '#payoutsBody');
    R.ok('an attempt with no answer is never offered another Send', !(await ppFlight.$('#payoutsBody [data-act="pp-send"]')));
    R.has(flight, 'no answer yet', 'and the row says so in words');
    // The check is fired after the tab renders, so wait for it rather than
    // reading the call log on the same tick -- a slower runner had not got
    // there yet, which is what made this red on main.
    await ppFlight.waitForFunction(() => (window.__EDGE_CALLS__ || []).some((c) => c.body?.action === 'refresh'), { timeout: 5000 }).catch(() => {});
    const auto = await ppFlight.evaluate(() => (window.__EDGE_CALLS__ || []).filter((c) => c.body?.action === 'refresh'));
    R.ok('and the open attempt is checked without being asked', auto.length === 1);
    R.ok('that automatic check never asks PayPal to send', auto[0]?.body?.retry !== true);
    R.ok('a finance person gets Retry send for an attempt PayPal never confirmed', !!(await ppFlight.$('#payoutsBody [data-act="pp-retry"]')));
    await ppFlight.click('#payoutsBody [data-act="pp-retry"]');
    await ppFlight.click('#payoutsBody [data-act="pp-retry"]');
    await ppFlight.waitForFunction(() => (window.__EDGE_CALLS__ || []).some((c) => c.body?.retry === true), null, { timeout: 5000 }).catch(() => {});
    const retry = await ppFlight.evaluate(() => (window.__EDGE_CALLS__ || []).filter((c) => c.body?.retry === true).map((c) => c.body));
    R.ok('Retry names that one payout', retry.length === 1 && retry[0].action === 'refresh' && retry[0].payout_id === '' + PP + '');
    await ppFlight.close();

    // ...once, however many times the tab re-renders: each check is a call to
    // PayPal, and a render loop would be a call loop.
    const ppTwice = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: ppProgram, affiliate_payouts: ppPayout, affiliate_payout_connection_status_v: connected,
        affiliate_payout_accounts: [{ company_entity_id: CO, affiliate_id: AFF, provider: 'paypal', payout_email: 'pat@pay.invalid' }],
        affiliate_payout_sends: [{ id: 'send-1', payout_id: PP, attempt: 1, state: 'unknown', provider_status: null, provider_item_id: null, error_code: null, error_message: null, environment: 'sandbox', created_at: now }] },
      { ready, rpc: ppRpc, edge: { 'affiliate-payouts': { status: 200, body: { checked: 1, results: [{ state: 'sent' }] } } } });
    ppTwice.on('pageerror', (e) => errors.push(e.message));
    await closeDialog(ppTwice);
    await ppTwice.click('#tabs [data-tab="payouts"]');
    await closeDialog(ppTwice);
    await ppTwice.click('#tabs [data-tab="overview"]');
    await closeDialog(ppTwice);
    await ppTwice.click('#tabs [data-tab="payouts"]');
    // Give a second check every chance to land before counting it.
    await ppTwice.waitForFunction(() => (window.__EDGE_CALLS__ || []).filter((c) => c.body?.action === 'refresh').length > 1, { timeout: 1500 }).catch(() => {});
    const twice = await ppTwice.evaluate(() => (window.__EDGE_CALLS__ || []).filter((c) => c.body?.action === 'refresh'));
    R.ok('the automatic check does not repeat on every render', twice.length === 1);
    await ppTwice.close();

    // The endpoint's untargeted refresh reads only the OLDEST 50 open attempts
    // across the company, so the page must ask for each payout by id: a newer
    // attempt behind 50 long-unclaimed items is otherwise never checked
    // (review cycle 1). Fifty old unclaimed, one new `unknown`, plus one open
    // SANDBOX attempt that the live account must leave alone.
    const old50 = Array.from({ length: 50 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const NEWEST = 'bbbbbbbb-0000-4000-8000-000000000051';
    const SBX = 'cccccccc-0000-4000-8000-000000000052';
    // An `unknown` whose attempt id sorts BELOW every unclaimed one ('!' is
    // before any digit): the worklist is read in id-descending pages, so
    // without the priority sort it would be checked last, after fifty
    // attempts that block nothing new.
    const OLDUNK = '10000000-0000-4000-8000-000000000053';
    const manyPayouts = [...old50, NEWEST, SBX, OLDUNK].map((id) => ({ ...ppPayout[0], id }));
    const manySends = [
      ...old50.map((id, i) => ({ id: `s-${i}`, payout_id: id, attempt: 1, state: 'unclaimed', provider_status: 'UNCLAIMED', provider_item_id: null, error_code: null, error_message: null, environment: 'live', created_at: '2026-10-01T00:00:00Z' })),
      { id: 's-new', payout_id: NEWEST, attempt: 1, state: 'unknown', provider_status: null, provider_item_id: null, error_code: null, error_message: null, environment: 'live', created_at: now },
      { id: 's-sbx', payout_id: SBX, attempt: 1, state: 'unknown', provider_status: null, provider_item_id: null, error_code: null, error_message: null, environment: 'sandbox', created_at: now },
      { id: 's-!oldunk', payout_id: OLDUNK, attempt: 1, state: 'unknown', provider_status: null, provider_item_id: null, error_code: null, error_message: null, environment: 'live', created_at: '2026-09-15T00:00:00Z' },
    ];
    const ppMany = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: ppProgram, affiliate_payouts: manyPayouts,
        affiliate_payout_connection_status_v: [{ ...connected[0], environment: 'live' }],
        affiliate_payout_accounts: [{ company_entity_id: CO, affiliate_id: AFF, provider: 'paypal', payout_email: 'pat@pay.invalid' }],
        affiliate_payout_sends: manySends },
      { ready, rpc: ppRpc, edge: { 'affiliate-payouts': { status: 200, body: { checked: 1, results: [{ state: 'unclaimed' }] } } } });
    ppMany.on('pageerror', (e) => errors.push(e.message));
    await closeDialog(ppMany);
    await ppMany.click('#tabs [data-tab="payouts"]');
    const refreshes = () => ppMany.evaluate(() => (window.__EDGE_CALLS__ || []).filter((c) => c.body?.action === 'refresh').map((c) => c.body.payout_id || null));
    await ppMany.waitForFunction(() => (window.__EDGE_CALLS__ || []).filter((c) => c.body?.action === 'refresh').length >= 52, null, { timeout: 15000 }).catch(() => {});
    const auto51 = await refreshes();
    R.ok('every automatic check names its payout', auto51.length > 0 && auto51.every(Boolean));
    R.ok('the newest open attempt is checked even behind fifty older ones', auto51.includes(NEWEST));
    R.ok('and the ones with no answer are checked before the unclaimed ones, however old',
      auto51.indexOf(OLDUNK) !== -1 && auto51.indexOf(OLDUNK) < auto51.indexOf(old50[0]));
    R.ok('an attempt on the other account is not checked against this one', !auto51.includes(SBX));
    await ppMany.close();

    // The page's history is the newest 200 attempts of ANY state. An older
    // attempt still open behind 200 paid ones is not in it, so the worklist
    // must come from its own query -- automatic and manual both (cycle 2).
    const OLDOPEN = 'dddddddd-0000-4000-8000-000000000001';
    const paid200 = Array.from({ length: 200 }, (_, i) => `eeeeeeee-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const ppDeep = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: ppProgram,
        affiliate_payouts: [OLDOPEN, ...paid200].map((id) => ({ ...ppPayout[0], id })),
        affiliate_payout_connection_status_v: [{ ...connected[0], environment: 'live' }],
        affiliate_payout_accounts: [{ company_entity_id: CO, affiliate_id: AFF, provider: 'paypal', payout_email: 'pat@pay.invalid' }],
        // Listed last, so the harness's limit(200) leaves it out of the history
        // exactly as the real newest-first query would.
        affiliate_payout_sends: [
          ...paid200.map((id, i) => ({ id: `p-${i}`, company_entity_id: CO, payout_id: id, attempt: 1, state: 'paid', provider_status: 'SUCCESS', provider_item_id: null, error_code: null, error_message: null, environment: 'live', created_at: `2026-11-${String(1 + (i % 12)).padStart(2, '0')}T00:00:${String(i % 60).padStart(2, '0')}Z` })),
          { id: 's-old', company_entity_id: CO, payout_id: OLDOPEN, attempt: 1, state: 'sent', provider_status: 'PENDING', provider_item_id: null, error_code: null, error_message: null, environment: 'live', created_at: '2026-09-01T00:00:00Z' },
        ] },
      { ready, rpc: ppRpc, edge: { 'affiliate-payouts': { status: 200, body: { checked: 1, results: [{ state: 'sent' }] } } } });
    ppDeep.on('pageerror', (e) => errors.push(e.message));
    await closeDialog(ppDeep);
    await ppDeep.click('#tabs [data-tab="payouts"]');
    const deepCalls = () => ppDeep.evaluate((id) => (window.__EDGE_CALLS__ || []).filter((c) => c.body?.action === 'refresh' && c.body.payout_id === id).length, OLDOPEN);
    await ppDeep.waitForFunction((id) => (window.__EDGE_CALLS__ || []).some((c) => c.body?.payout_id === id), OLDOPEN, { timeout: 5000 }).catch(() => {});
    R.ok('an open attempt behind 200 newer paid ones is still checked automatically', (await deepCalls()) === 1);
    await ppDeep.click('#payoutsBody [data-act="pp-refresh"]:not([data-id])');
    await ppDeep.waitForFunction((id) => (window.__EDGE_CALLS__ || []).filter((c) => c.body?.payout_id === id).length > 1, OLDOPEN, { timeout: 5000 }).catch(() => {});
    R.ok('and by Check payment status', (await deepCalls()) === 2);
    await ppDeep.close();

    // Past one page, while the set moves. 1,001 open attempts; between the
    // first and second page reads, one first-page row settles (another tab, or
    // the reconcile straight after a send). An offset would then skip the
    // lowest row; the keyset must still reach it.
    const openIds = Array.from({ length: 1001 }, (_, i) => `99999999-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const LOWEST = openIds[0];          // smallest id: last in id-descending order
    const FLIPS = openIds[500];         // on the first page
    const ppPaged = await suite.open('/v2/affiliates/index.html',
      { ...tables, affiliate_programs: ppProgram, affiliate_payouts: ppPayout,
        affiliate_payout_connection_status_v: [{ ...connected[0], environment: 'live' }],
        affiliate_payout_accounts: [{ company_entity_id: CO, affiliate_id: AFF, provider: 'paypal', payout_email: 'pat@pay.invalid' }],
        affiliate_payout_sends: openIds.map((id) => ({ id, company_entity_id: CO, payout_id: id, attempt: 1, state: 'sent', provider_status: 'PENDING', provider_item_id: null, error_code: null, error_message: null, environment: 'live', created_at: '2026-10-01T00:00:00Z' })) },
      { ready, rpc: ppRpc, edge: { 'affiliate-payouts': { status: 200, body: { checked: 1, results: [{ state: 'sent' }] } } } });
    ppPaged.on('pageerror', (e) => errors.push(e.message));
    await ppPaged.evaluate((flip) => {
      // The second read of the open set is when the row settles.
      let reads = 0;
      const push = window.__QUERIES__.push.bind(window.__QUERIES__);
      window.__QUERIES__.push = (q) => {
        if (q.table === 'affiliate_payout_sends' && /payout_id, state, environment/.test(q.columns || '') && ++reads === 2) {
          window.__FIXTURE_TABLES__.affiliate_payout_sends.find((r) => r.id === flip).state = 'paid';
        }
        return push(q);
      };
    }, FLIPS);
    await closeDialog(ppPaged);
    await ppPaged.click('#tabs [data-tab="payouts"]');
    await ppPaged.waitForFunction((id) => (window.__EDGE_CALLS__ || []).some((c) => c.body?.payout_id === id), LOWEST, { timeout: 20000 }).catch(() => {});
    R.ok('an open attempt past the first page is checked even when the set moves between pages',
      await ppPaged.evaluate((id) => (window.__EDGE_CALLS__ || []).some((c) => c.body?.action === 'refresh' && c.body.payout_id === id), LOWEST));
    await ppPaged.close();

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
    await closeDialog(ppAfterTest);
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
    await closeDialog(ppLiveFlight);
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
    await closeDialog(ppFail);
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
    R.ok('and it was sent to PayPal exactly once',
      (await ppFail.evaluate(() => window.__EDGE_CALLS__.filter((c) => c.body?.action === 'send').length)) === 1);
    await ppFail.close();

    // ── Home: one press per queue row, and what runs on its own ───────────
    // Blake, 2026-11-13: "I shouldn't have to press so many buttons to move
    // along the flow." Each row that can be finished from Home carries the
    // press that finishes it, over every row it names.
    const AFF_Q = '33333333-3333-4333-8333-333333333333';
    const qTables = { ...tables,
      affiliate_programs: [{ ...tables.affiliate_programs[0], default_discount_percent: 15, auto_share_launches: true }],
      affiliates: [...tables.affiliates, { id: AFF_Q, company_entity_id: CO, program_id: PROG, display_name: 'Pat Trails', status: 'active', created_at: now }],
      affiliate_outreach_drafts: [
        { id: 'd1', company_entity_id: CO, program_id: PROG, prospect_id: 'p1', state: 'draft', subject: 'Hi', body: 'x', created_at: now },
        { id: 'd2', company_entity_id: CO, program_id: PROG, prospect_id: 'p1', state: 'draft', subject: 'Hi', body: 'y', created_at: now },
        { id: 'd3', company_entity_id: CO, program_id: PROG, prospect_id: 'p1', state: 'sent', subject: 'Hi', body: 'z', created_at: now }],
      affiliate_balances_v: [...tables.affiliate_balances_v,
        { company_entity_id: CO, program_id: PROG, affiliate_id: AFF_Q, currency: 'USD', earned_cents: 900, refund_adjustment_cents: null, claimed_cents: 0, paid_cents: 0, unclaimed_cents: 900 },
        { company_entity_id: CO, program_id: PROG, affiliate_id: 'other-cur', currency: 'CAD', earned_cents: 900, refund_adjustment_cents: null, claimed_cents: 0, paid_cents: 0, unclaimed_cents: 900 }] };
    const home = await suite.open('/v2/affiliates/index.html', qTables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true } });
    home.on('pageerror', (e) => errors.push(e.message));
    await toProgram(home);
    const hv = await text(home, '#overviewBody');
    R.has(hv, 'Approve all 2', 'two drafts are approved with one press');
    R.has(hv, 'Make 1 code', 'the codeless affiliate gets a code with one press');
    R.has(hv, 'Build 2 payouts', 'every affiliate owed in the program currency gets a payout with one press');
    R.has(hv, 'Share every launch', 'launch sharing is shown as running');
    R.has(hv, 'Code for each new affiliate · 15% off', 'automatic codes are shown with what they give');
    R.not(hv, 'Pay every Friday', 'no auto-pay switch before its columns exist');
    const lastWrite = (table, op) => home.evaluate(([t, o]) => window.__QUERIES__.filter((q) => q.table === t && q._op === o).pop() || null, [table, op]);
    await home.click('#overviewBody [data-act="q-msgs"]');
    await home.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'update'), null, { timeout: 5000 });
    const mq = await lastWrite('affiliate_outreach_drafts', 'update');
    R.eq(mq.patch.state, 'approved', 'the drafts are approved');
    R.eq((mq.filters.find((f) => f.op === 'in' && f.col === 'id') || {}).vals, ['d1', 'd2'], 'only the drafts are approved, never a message already sent');
    R.ok('and only while each is still a draft', mq.filters.some((f) => f.op === 'eq' && f.col === 'state' && f.val === 'draft'));
    await home.click('#overviewBody [data-act="q-codes"]');
    await home.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_codes' && q._op === 'insert'), null, { timeout: 5000 });
    const cq = await lastWrite('affiliate_codes', 'insert');
    const cRows = Array.isArray(cq.rows) ? cq.rows : [cq.rows];
    R.eq(cRows.map((r) => r.affiliate_id), [AFF_Q], 'a code is made only for the affiliate without one');
    R.eq(cRows[0].status, 'pending', 'it waits for the AI to create it in Shopify');
    R.eq(Number(cRows[0].discount_percent), 15, 'at the program\'s own discount');
    R.eq(cRows[0].code, 'PATTRAILS15', 'named from the affiliate');
    await home.click('#overviewBody [data-act="q-payouts"]');
    await home.waitForFunction(() => window.__QUERIES__.filter((q) => q.table === 'rpc:affiliate_build_payout').length >= 2, null, { timeout: 5000 });
    const built = await home.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'rpc:affiliate_build_payout').map((q) => q.args.p_affiliate));
    R.eq(built.sort(), [AFF, AFF_Q].sort(), 'a payout is built for each affiliate owed in the program currency, and no other');
    R.ok('and nothing is approved or sent by that press', !(await home.evaluate(() => window.__QUERIES__.some((q) => q.table === 'rpc:affiliate_approve_payout'))));
    await home.click('#overviewBody [data-act="auto-share"]');
    await home.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_programs' && q._op === 'update'), null, { timeout: 5000 });
    R.eq((await lastWrite('affiliate_programs', 'update')).patch.auto_share_launches, false, 'the launch switch turns sharing off');
    await home.close();

    // Friday auto-pay arrives with the payouts work: shown once its columns
    // exist, and a live switch only for someone who may approve payouts.
    const autoPayTables = { ...qTables, affiliate_programs: [{ ...qTables.affiliate_programs[0], payout_mode: 'approve_each', auto_pay_ceiling_cents: 100000 }] };
    const payMoney = await suite.open('/v2/affiliates/index.html', autoPayTables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true } });
    payMoney.on('pageerror', (e) => errors.push(e.message));
    await toProgram(payMoney);
    R.has(await text(payMoney, '#overviewBody'), 'Pay every Friday · up to $1,000.00', 'auto-pay shows its ceiling in the program currency');
    await payMoney.click('#overviewBody [data-act="auto-pay"]');
    await payMoney.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_programs' && q._op === 'update'), null, { timeout: 5000 });
    R.eq(await payMoney.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_programs' && q._op === 'update').pop().patch.payout_mode), 'auto_friday', 'the switch turns Friday pay on');
    await payMoney.close();
    const payNoMoney = await suite.open('/v2/affiliates/index.html', autoPayTables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: false } });
    payNoMoney.on('pageerror', (e) => errors.push(e.message));
    await toProgram(payNoMoney);
    R.ok('someone who cannot approve payouts cannot turn on auto-pay', await payNoMoney.evaluate(() => document.querySelector('#overviewBody [data-act="auto-pay"]')?.disabled === true));
    await payNoMoney.close();

    // ── Product seeding, the brand's side ─────────────────────────────────
    // Requests are approved from Home in one press; Records → Products lists
    // every product with where it stands; Setup holds the offer.
    const seedTables = { ...qTables,
      affiliate_programs: [{ ...qTables.affiliate_programs[0], seeding_enabled: true, seed_discount_percent: 50, seed_multiple: 3, seed_refund_days: 14, seed_goal_days: 90 }],
      affiliate_seed_claims: [
        { id: 'sc1', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, product_title: 'Snow cap', state: 'requested', requested_at: now },
        { id: 'sc2', company_entity_id: CO, program_id: PROG, affiliate_id: AFF_Q, product_title: 'Rain shell', state: 'requested', requested_at: now },
        { id: 'sc3', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, product_title: 'Trail tee', state: 'purchased', currency: 'USD', seed_paid_cents: 2000, goal_cents: 6000, progress_cents: 4500, requested_at: now }] };
    const seed = await suite.open('/v2/affiliates/index.html', seedTables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true,
      affiliate_seed_decide: (args) => { (window.__seedCalls = window.__seedCalls || []).push(args); return { decided: args.p_claims.length, skipped: 0 }; } } });
    seed.on('pageerror', (e) => errors.push(e.message));
    await toProgram(seed);
    R.has(await text(seed, '#overviewBody'), '2 product requests', 'Home lists product requests');
    await seed.click('#overviewBody [data-act="q-seeds"]');
    await seed.waitForFunction(() => (window.__seedCalls || []).length > 0, null, { timeout: 5000 });
    const dec = await seed.evaluate(() => window.__seedCalls[0]);
    R.eq([dec.p_claims.sort(), dec.p_approve], [['sc1', 'sc2'], true], 'one press approves every waiting request, and nothing already decided');
    R.not(await text(seed, '#affiliatesBody'), 'Snow cap', 'product requests are not on People');
    await seed.click('#overviewBody [data-act="go-tab"][data-t="records"][data-k="products"]');
    await seed.waitForFunction(() => /Snow cap/.test(document.getElementById('recordsBody')?.textContent || ''), null, { timeout: 5000 });
    const pb = await text(seed, '#recordsBody');
    R.has(pb, 'They asked for · 2', 'Records → Products opens from Home, requests first');
    R.has(pb, 'In progress · 1', 'bought products are grouped apart from requests');
    R.has(pb, '$45.00 / $60.00', 'a bought product shows its progress toward 3x what they paid');
    R.has(pb, '50% off · sell 3×', 'the offer is named once');
    await closeDialog(seed);
    await seed.click('#tabs [data-tab="program"]');
    await seed.waitForFunction(() => !!document.getElementById('pSeedPct'), null, { timeout: 5000 });
    await seed.fill('#pSeedPct', '40');
    await seed.press('#pSeedPct', 'Tab');
    await seed.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_programs' && q._op === 'update'), null, { timeout: 5000 });
    const sp = await seed.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_programs' && q._op === 'update').pop().patch);
    R.eq([sp.seeding_enabled, sp.seed_discount_percent, sp.seed_multiple], [true, 40, 3], 'Setup saves the seeding offer');
    // A link name typed with capitals or spaces is tidied, not refused.
    await seed.fill('#pSlug', 'Testing 2');
    await seed.press('#pSlug', 'Tab');
    await seed.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_programs' && q._op === 'update' && q.patch?.slug === 'testing-2'), null, { timeout: 5000 }).catch(() => {});
    R.ok('a link name with capitals saves lowercased', await seed.evaluate(() => window.__QUERIES__.some((q) => q.table === 'affiliate_programs' && q._op === 'update' && q.patch?.slug === 'testing-2')));
    R.eq(await seed.inputValue('#pSlug'), 'testing-2', 'and the field shows what was saved');
    await seed.close();
    // Before the migration there is no claims table: no seeding, and no error.
    const noSeed = await suite.open('/v2/affiliates/index.html', qTables, { ready, broken: ['affiliate_seed_claims'], rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true } });
    noSeed.on('pageerror', (e) => errors.push(e.message));
    await toProgram(noSeed);
    R.not(await text(noSeed, '#overviewBody'), 'product request', 'no seeding rows before the migration');
    R.not(await text(noSeed, '#status'), 'did not load', 'a missing seeding table is not reported as a failure');
    await noSeed.close();

    // ── Content, tick-box queues and Comms (20261117050000) ──────────────
    const ctTables = { ...qTables,
      affiliate_programs: [{ ...qTables.affiliate_programs[0], content_bonus_cents: 2500, outreach_subject: null, outreach_body: null }],
      affiliate_outreach_drafts: [...qTables.affiliate_outreach_drafts,
        { id: 'd4', company_entity_id: CO, program_id: PROG, prospect_id: 'p1', state: 'approved', channel: 'dm', recipient_email: null, recipient_handle: '@samruns', subject: 'Hi', body: 'Hey! Join: {signup_link}', created_at: now }],
      affiliate_content_submissions: [
        { id: 'ct1', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, kind: 'file', storage_path: 'ct1/content.mp4', file_type: 'video/mp4', caption: 'Cage reel', state: 'submitted', submitted_at: now },
        { id: 'ct2', company_entity_id: CO, program_id: PROG, affiliate_id: AFF_Q, kind: 'link', link_url: 'https://www.instagram.com/p/x/', state: 'submitted', submitted_at: now },
        { id: 'ct3', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, kind: 'file', storage_path: 'ct3/content.jpg', file_type: 'image/jpeg', caption: 'Half sent', state: 'uploading', submitted_at: now }],
      affiliate_payouts: [
        { id: 'po1', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, currency: 'USD', amount_cents: 900, status: 'draft', method: 'manual', created_at: now },
        { id: 'po2', company_entity_id: CO, program_id: PROG, affiliate_id: AFF_Q, currency: 'USD', amount_cents: 700, status: 'draft', method: 'manual', created_at: now }] };
    const ctRpc = { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true,
      affiliate_content_decide: (args) => ({ decided: args.p_ids.length, skipped: 0, bonus_cents: args.p_decision === 'use' ? 2500 * args.p_ids.length : 0 }),
      affiliate_approve_payout: () => ({}) };
    const ct = await suite.open('/v2/affiliates/index.html', ctTables, { ready, rpc: ctRpc });
    ct.on('pageerror', (e) => errors.push(e.message));
    await toProgram(ct);
    R.has(await text(ct, '#overviewBody'), '2 posts', 'Home lists content waiting for review');
    await closeDialog(ct);
    await ct.click('#tabs [data-tab="share"]');
    await ct.waitForFunction(() => !!document.querySelector('#shareBody .af-ctile-media'), null, { timeout: 5000 });
    const cb = await text(ct, '#shareBody');
    R.has(cb, 'A post you pay for earns $25.00', 'the bonus is named once');
    R.has(cb, 'New', 'the posts are filtered by what has happened to them');
    // A tile each for the two that landed; the caption is in the opened post.
    R.eq(await ct.$$eval('#shareBody .af-ctile', (n) => n.length), 2,
      'an upload that has not landed is not shown');
    const signed = await ct.evaluate(() => (window.__SIGNED__ || []).flat());
    R.ok('the video is drawn from a signed link to its private file', signed.includes('ct1/content.mp4'));
    // Blake's one real submission is a 29 MB video/quicktime .mov, which Chrome
    // cannot decode. A <video> that never loads keeps its 300x150 default, and
    // a percentage height does NOT resolve against a grid area for a replaced
    // element, so it used to stand 150px tall inside a 54px tile and tear the
    // row open. Nothing in a tile may be taller than the tile.
    R.ok('a post never draws outside its tile, whatever the file turns out to be',
      await ct.evaluate(() => [...document.querySelectorAll('#shareBody .af-ctile-media')].every((box) => {
        const b = box.getBoundingClientRect();
        return [...box.querySelectorAll('img, video')].every((m) => {
          const r = m.getBoundingClientRect();
          return r.height <= b.height + 1 && r.width <= b.width + 1;
        });
      })));
    // And a file the browser cannot play says what it is rather than sitting
    // there as an empty box; the file itself still opens in a new tab.
    await ct.waitForFunction(() => /Video/.test(document.querySelector('#shareBody .af-ctile-media')?.textContent || ''), null, { timeout: 5000 });
    R.ok('a video the browser cannot play is labelled, not left blank, and still opens',
      await ct.evaluate(() => !!document.querySelector('#shareBody .af-ctile-media--none')
        && document.querySelector('#shareBody .af-ctile-media')?.dataset.act === 'content-open'));
    // The assertion above can only measure what is still there, and a file the
    // browser cannot play is replaced before it can be measured -- `every()`
    // over nothing is true (review cycle 1). So measure a post that really
    // loads: a 100x200 photo, which is taller than any tile it can sit in.
    {
      // A real 100x200 PNG, generated: a photo taller than any tile.
      const TALL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAGQAAADICAIAAACRXtOWAAABRUlEQVR4nO3QQQkAMAzAwAqrfyZrFvYLg4MICDdnV49NfvBRsGDByoMFC1YeLFiw8mDBgpUHCxasPFiwYOXBggUrDxYsWHmwYMHKgwULVh4sWLDyYMGClQcLFqw8WLBg5cGCBSsPFixYebBgwcqDBQtWHixYsPJgwYKVBwsWrDxYsGDlwYIFKw8WLFh5sGDByoMFC1YeLFiw8mDBgpUHCxasPFiwYOXBggUrDxYsWHmwYMHKgwULVh4sWLDyYMGClQcLFqw8WLBg5cGCBSsPFixYebBgwcqDBQtWHixYsPJgwYKVBwsWrDxYsGDlwYIFKw8WLFh5sGDByoMFC1YeLFiw8mDBgpUHCxasPFiwYOXBggUrDxYsWHmwYMHKgwULVt4FuC+tsCKZ3gMAAAAASUVORK5CYII=', 'base64');
      await suite.context.route('https://fixture.local/signed/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: TALL }));
      const loadTables = { ...ctTables,
        // A creator photo that is itself 100x200: the post is what the tile is
        // about, so their picture may never be the big image on it
        // (Blake 2026-11-23).
        affiliates: ctTables.affiliates.map((x) => ({ ...x, photo_url: 'https://fixture.local/signed/avatar.png' })),
        affiliate_content_submissions: [
          { id: 'ct1', company_entity_id: CO, program_id: PROG, affiliate_id: AFF,
            kind: 'file', storage_path: 'ct1/shot.png', file_type: 'image/png', caption: 'Wearing it today',
            state: 'submitted', submitted_at: now },
          { id: 'ct2', company_entity_id: CO, program_id: PROG, affiliate_id: AFF,
            kind: 'file', storage_path: 'ct2/shot.png', file_type: 'image/png', caption: 'Second post',
            state: 'submitted', submitted_at: now }] };
      const lp = await suite.open('/v2/affiliates/index.html', loadTables, { ready, rpc: ctRpc });
      lp.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(lp);
      await lp.click('#tabs [data-tab="share"]');
      await lp.waitForSelector('#shareBody [data-act="share-tab"][data-k="content"]', { timeout: 5000 });
      await lp.click('#shareBody [data-act="share-tab"][data-k="content"]');
      await lp.waitForFunction(() => {
        const i = document.querySelector('#shareBody .af-ctile-media img');
        return !!i && i.complete && i.naturalHeight > 0;
      }, null, { timeout: 5000 });
      const fit = await lp.evaluate(() => {
        const media = [...document.querySelectorAll('#shareBody .af-ctile-media img, #shareBody .af-ctile-media video')];
        return { n: media.length, natural: media[0]?.naturalHeight || 0, over: media.filter((m) => {
          const b = m.closest('.af-ctile-media').getBoundingClientRect();
          const r = m.getBoundingClientRect();
          return r.height > b.height + 1 || r.width > b.width + 1;
        }).length };
      });
      R.ok('a post that really loads is bigger than its tile and still fits inside it',
        fit.n > 0 && fit.natural > 100 && fit.over === 0);
      // A hundred posts are reviewed at once, so the tiles sit across the
      // width rather than one per line (Blake 2026-11-23).
      const grid = await lp.evaluate(() => {
        const q = document.querySelector('#shareBody .af-q--grid');
        const rows = [...document.querySelectorAll('#shareBody .af-q--grid .af-q-row')];
        return { display: q && getComputedStyle(q).display, n: rows.length,
          tops: new Set(rows.map((r) => Math.round(r.getBoundingClientRect().top))).size,
          width: rows[0] ? Math.round(rows[0].getBoundingClientRect().width) : 0 };
      });
      R.ok('posts sit side by side across the width, not one per line',
        grid.display === 'grid' && grid.n === 2 && grid.tops === 1 && grid.width > 0 && grid.width < 320);
      // The creator's own picture is a thumbnail beside their name. It used to
      // be the only photo on the page in no wrapper, and drew at full size.
      const pic = await lp.evaluate(() => {
        const ph = document.querySelector('#shareBody .af-ctile-who .af-avatar-photo');
        const media = document.querySelector('#shareBody .af-ctile-media');
        if (!ph || !media) return null;
        const a = ph.getBoundingClientRect(); const m = media.getBoundingClientRect();
        return { wrapped: !!ph.closest('.af-list-thumb'), h: a.height, w: a.width, mh: m.height };
      });
      R.ok('the creator photo is a thumbnail, never the big image on the tile',
        !!pic && pic.wrapped && pic.h <= 24 && pic.w <= 24 && pic.h < pic.mh);
      // Clicking the post opens it, big, with that one post's decisions.
      await lp.click('#shareBody .af-ctile-media');
      await lp.waitForFunction(() => document.getElementById('afDialog')?.open
        && /Wearing it today/.test(document.getElementById('afDialogBody')?.textContent || ''), null, { timeout: 5000 });
      const open = await lp.evaluate(() => {
        const img = document.querySelector('#afDialogBody .af-copen-media img');
        const tile = document.querySelector('#shareBody .af-ctile-media img');
        return { big: img ? img.getBoundingClientRect().height : 0,
          tile: tile ? tile.getBoundingClientRect().height : 0,
          keep: !!document.querySelector('#afDialogBody [data-act="content-decide"][data-k="approve"]') };
      });
      R.ok('the opened post is bigger than its tile and offers that post\'s decisions',
        open.big > open.tile && open.keep);
      await lp.click('#afDialogBody [data-act="content-decide"][data-k="approve"]');
      await lp.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'rpc:affiliate_content_decide'), null, { timeout: 5000 });
      const one = await lp.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'rpc:affiliate_content_decide').pop().args);
      R.eq([one.p_ids, one.p_decision], [['ct1'], 'approve'], 'a decision taken on the opened post is about that post alone');
      await lp.close();
      await suite.context.unroute('https://fixture.local/signed/**');
    }
    R.ok('nothing moves until something is ticked', !(await ct.$('#shareBody [data-act="q-content-use"]')));
    await ct.click('#shareBody [data-act="q-all"][data-q="content"]');
    await ct.click('#shareBody [data-act="q-content-use"]');
    await ct.click('#shareBody [data-act="q-content-use"]');
    await ct.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'rpc:affiliate_content_decide'), null, { timeout: 5000 });
    const cd = await ct.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'rpc:affiliate_content_decide').pop().args);
    R.eq([cd.p_ids.slice().sort(), cd.p_decision], [['ct1', 'ct2'], 'use'], 'Use selected uses exactly the ticked pieces');
    await ct.waitForFunction(() => /\$50\.00 in bonuses/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 5000 });
    R.ok('and says what it added to the next payout', true);
    // Comms: the message queue, ticked one at a time.
    await closeDialog(ct);
    await ct.click('#tabs [data-tab="comms"]');
    await ct.waitForFunction(() => !!document.querySelector('#outreachBody [data-act="q-pick"][data-q="msgs"]'), null, { timeout: 5000 });
    await ct.click('#outreachBody [data-act="q-pick"][data-q="msgs"][data-id="d1"]');
    await ct.click('#outreachBody [data-act="q-msg-ok"]');
    await ct.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'update'), null, { timeout: 5000 });
    const mu = await ct.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'update').pop());
    R.eq((mu.filters.find((f) => f.op === 'in' && f.col === 'id') || {}).vals, ['d1'], 'Approve selected approves only the ticked message');
    R.ok('and only while it is still a draft', mu.filters.some((f) => f.op === 'eq' && f.col === 'state' && f.val === 'draft'));
    // A message somebody sent by hand is marked from the draft itself, in one
    // press: the ordinary case used to need an approval first, and a draft
    // nobody marked sat in this queue for weeks (Blake 2026-11-24).
    await ct.waitForFunction(() => !!document.querySelector('#outreachBody [data-act="draft-sent-now"]'), null, { timeout: 5000 });
    await ct.click('#outreachBody [data-act="draft-sent-now"]');
    await ct.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'update' && q.patch?.state === 'sent'), null, { timeout: 5000 });
    const hand = await ct.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'update' && q.patch?.state === 'sent').pop());
    R.ok('marking a draft sent records the approval and the send together, with evidence',
      !!hand.patch.approved_by && !!hand.patch.approved_at && !!hand.patch.sent_marked_by && !!String(hand.patch.sent_evidence || '').trim());
    R.ok('and only moves a row still in the state it was read in',
      hand.filters.some((f) => f.op === 'eq' && f.col === 'state' && ['draft', 'approved'].includes(f.val)));
    R.not(await text(ct, '#outreachBody'), 'Emails to affiliates', 'with no affiliate emails yet, that chip is not offered');
    R.not(await text(ct, '#outreachBody'), 'Nothing sent yet', 'and no empty box says so');
    await commsChip(ct, 'template');
    await ct.fill('#tplBody', 'Hey {name}: {signup_link}');
    await ct.click('#outreachBody [data-act="tpl-save"]');
    await ct.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_programs' && q._op === 'update'), null, { timeout: 5000 });
    R.eq((await ct.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_programs' && q._op === 'update').pop().patch)).outreach_body, 'Hey {name}: {signup_link}', 'the template is saved from Comms');
    // Typing survives a chip swap: both forms live in this body, and the
    // editor and the template are rebuilt from the saved row (review 2026-11-20).
    await ct.fill('#tplBody', 'Typed, not saved: {signup_link}');
    await ct.fill('#tplSubject', 'Typed subject');
    await commsChip(ct, 'approve');
    await commsChip(ct, 'template');
    R.eq(await ct.inputValue('#tplBody'), 'Typed, not saved: {signup_link}', 'an unsaved template survives leaving its chip and coming back');
    R.eq(await ct.inputValue('#tplSubject'), 'Typed subject', 'and so does its subject');
    await ct.click('#outreachBody [data-act="comms-tab"][data-k="template"]');
    R.eq(await ct.inputValue('#tplBody'), 'Typed, not saved: {signup_link}', 'and clicking the chip it is already on changes nothing');
    await ct.click('#outreachBody [data-act="tpl-save"]');
    await ct.waitForFunction(() => /Template saved/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 5000 });
    // A creator with no email: the person sends a DM by hand, SILO sends nothing.
    await commsChip(ct, 'dm');
    const dmBody = await text(ct, '#outreachBody');
    R.has(dmBody, 'Send by DM', 'a creator with no email is listed to message on social');
    R.has(dmBody, 'Join: http', 'with open applications the DM carries the application link');
    R.ok('never a placeholder', !(await ct.evaluate(() => document.querySelector('#outreachBody [data-act="dm-copy"]').closest('article').textContent)).includes('{signup_link}'));
    await ct.click('#outreachBody [data-act="dm-sent"][data-id="d4"]');
    await ct.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'update' && q.patch?.state === 'sent'), null, { timeout: 5000 });
    const dmu = await ct.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'update' && q.patch?.state === 'sent').pop());
    R.ok('Mark sent records the DM as where it was sent', /^Sent by DM on /.test(dmu.patch.sent_evidence) && dmu.filters.some((f) => f.col === 'id' && f.val === 'd4'));
    R.ok('and only while it was still approved', dmu.filters.some((f) => f.col === 'state' && f.val === 'approved'));
    // Money: drafts wait in a queue; Approve selected approves the ticked ones.
    await closeDialog(ct);
    await ct.click('#tabs [data-tab="payouts"]');
    await ct.waitForFunction(() => !!document.querySelector('#payoutsBody [data-act="q-all"][data-q="payouts"]'), null, { timeout: 5000 });
    await ct.click('#payoutsBody [data-act="q-pick"][data-q="payouts"][data-id="po2"]');
    await ct.click('#payoutsBody [data-act="q-payout-ok"]');
    await ct.click('#payoutsBody [data-act="q-payout-ok"]');
    await ct.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'rpc:affiliate_approve_payout'), null, { timeout: 5000 });
    R.eq(await ct.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'rpc:affiliate_approve_payout').map((q) => q.args.p_payout)), ['po2'], 'only the ticked payout is approved');
    await ct.close();
    // A manager who cannot approve payouts may approve content, never pay its bonus.
    const ctNoMoney = await suite.open('/v2/affiliates/index.html', ctTables, { ready, rpc: { ...ctRpc, can_approve_affiliate_commissions: false } });
    ctNoMoney.on('pageerror', (e) => errors.push(e.message));
    await closeDialog(ctNoMoney);
    await ctNoMoney.click('#tabs [data-tab="share"]');
    await ctNoMoney.waitForFunction(() => !!document.querySelector('#shareBody [data-act="q-all"][data-q="content"]'), null, { timeout: 5000 });
    await ctNoMoney.click('#shareBody [data-act="q-all"][data-q="content"]');
    R.ok('without payout approval there is no Use (with bonus) button', !(await ctNoMoney.$('#shareBody [data-act="q-content-use"]')) && !!(await ctNoMoney.$('#shareBody [data-act="q-content-ok"]')));
    await ctNoMoney.close();
    // An export the browser claimed but never delivered -- the tab closed
    // between the claim and the download -- is finished from Records. Without
    // it the messages sit marked exported with nobody holding the file, and
    // the queue cannot reach them again (review of #1357).
    const stuckTables = { ...ctTables,
      affiliate_outreach_batches: [{ id: 'b9', company_entity_id: CO, program_id: PROG, channel: 'email', row_count: 0, fingerprint: null, exported_at: now, created_at: now }],
      affiliate_outreach_drafts: [{ id: 'd9', company_entity_id: CO, program_id: PROG, prospect_id: 'p1', state: 'exported', channel: 'email', recipient_email: 'stuck@creator.invalid', subject: 'Hi', body: 'Join: {signup_link}', batch_id: 'b9', exported_at: now, created_at: now }] };
    const st = await suite.open('/v2/affiliates/index.html', stuckTables, { ready, rpc: ctRpc,
      edge: { 'affiliate-invite': { status: 200, body: { signup_url: 'https://get-silo.invalid/join?t=again', expires_at: now } } } });
    st.on('pageerror', (e) => errors.push(e.message));
    await st.evaluate(() => { if (!crypto.subtle) Object.defineProperty(crypto, 'subtle', { configurable: true, value: { digest: async () => new Uint8Array(32).buffer } }); });
    await st.evaluate(() => { window.__files = []; window.__names = []; const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__names.push(this.download); return click.call(this); }; const orig = URL.createObjectURL; URL.createObjectURL = (b) => { b.text().then((t) => window.__files.push(t)); return orig.call(URL, b); }; });
    await openRecords(st);
    await recTab(st, 'messages');
    R.has(await text(st, '#recordsBody'), 'Not downloaded', 'a claimed batch that was never delivered says so');
    await st.click('#recordsBody [data-act="batch-finish"][data-id="b9"]');
    await st.waitForFunction(() => (window.__names || []).some((n) => /^outreach-.*\.csv$/.test(n)), null, { timeout: 5000 });
    const back = await st.evaluate(() => window.__files.join('\n'));
    R.has(back, 'stuck@creator.invalid', 'and its messages come back in a file');
    R.has(back, 'https://get-silo.invalid/join?t=again', 'with a working personal link');
    const stamped = await st.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_outreach_batches' && q._op === 'update').pop());
    R.eq([stamped?.patch?.row_count, !!stamped?.patch?.fingerprint], [1, true], 'the batch is stamped with what the file holds, so it stops offering the download');
    await st.close();
    // A post the server will not act on is not offered the action. The server
    // (affiliate_content_decide) skips 'use' and 'decline' on a declined post
    // and anything at all on a paid one, and allows only 'approve' to bring a
    // declined post back; the dialog used to offer the opposite of all three.
    const ctStates = { ...ctTables,
      affiliate_content_submissions: [
        { id: 'cn1', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, kind: 'link', link_url: 'https://www.instagram.com/p/no/', caption: 'Turned down', state: 'declined', submitted_at: now },
        { id: 'cp1', company_entity_id: CO, program_id: PROG, affiliate_id: AFF, kind: 'link', link_url: 'https://www.instagram.com/p/paid/', caption: 'Already paid', state: 'used', bonus_cents: 2500, currency: 'USD', submitted_at: now }] };
    const ctSt = await suite.open('/v2/affiliates/index.html', ctStates, { ready, rpc: ctRpc });
    ctSt.on('pageerror', (e) => errors.push(e.message));
    await closeDialog(ctSt);
    await ctSt.click('#tabs [data-tab="share"]');
    // With nothing new waiting, Share opens on what is shared; the posts are
    // under "From affiliates".
    await ctSt.waitForFunction(() => !!document.querySelector('#shareBody [data-act="share-tab"][data-k="content"]'), null, { timeout: 5000 });
    await ctSt.click('#shareBody [data-act="share-tab"][data-k="content"]');
    await ctSt.waitForFunction(() => !!document.querySelector('#shareBody .af-ctile-media'), null, { timeout: 5000 });
    const chip = async (k) => { await ctSt.click(`#shareBody [data-act="content-filter"][data-f="${k}"]`); await ctSt.waitForFunction((f) => document.querySelector(`#shareBody [data-act="content-filter"][data-f="${f}"]`)?.classList.contains('af-filter-chip--on'), k, { timeout: 5000 }); };
    await chip('no');
    // The bulk actions appear once something is ticked.
    await ctSt.click('#shareBody [data-act="q-all"][data-q="content"]');
    await ctSt.waitForFunction(() => !!document.querySelector('#shareBody [data-act="q-content-ok"], #shareBody [data-act="q-content-use"], #shareBody [data-act="q-content-no"]'), null, { timeout: 5000 });
    const noActs = await ctSt.evaluate(() => ['q-content-use', 'q-content-ok', 'q-content-no'].filter((a) => !!document.querySelector(`#shareBody [data-act="${a}"]`)));
    R.eq(noActs, ['q-content-ok'], 'on a list of turned-down posts the only bulk action is the one the server allows');
    await ctSt.click('#shareBody [data-act="q-all"][data-q="content"]');
    await ctSt.click('#shareBody .af-ctile-media');
    await ctSt.waitForFunction(() => document.getElementById('afDialog')?.open && /Turned down/.test(document.getElementById('afDialogBody')?.textContent || ''), null, { timeout: 5000 });
    const declinedActs = await ctSt.evaluate(() => ['approve', 'use', 'decline'].filter((k) => !!document.querySelector(`#afDialogBody [data-act="content-decide"][data-k="${k}"]`)));
    R.eq(declinedActs, ['approve'], 'a turned-down post is offered only Keep after all');
    await closeDialog(ctSt);
    await chip('paid');
    await ctSt.click('#shareBody .af-ctile-media');
    await ctSt.waitForFunction(() => document.getElementById('afDialog')?.open && /Already paid/.test(document.getElementById('afDialogBody')?.textContent || ''), null, { timeout: 5000 });
    const paidActs = await ctSt.evaluate(() => ['approve', 'use', 'decline'].filter((k) => !!document.querySelector(`#afDialogBody [data-act="content-decide"][data-k="${k}"]`)));
    R.eq(paidActs, [], 'and a paid post is final: no decision is offered on it');
    await ctSt.close();

    // ── All programs: one lens over everyone the company manages ──────────
    // The same person (same email) in two programs is one card with a row per
    // program; Home sums both programs; other tabs ask which program.
    const PROGB = '66666666-6666-4666-8666-666666666666';
    const AFFB = '77777777-7777-4777-8777-777777777777';
    const allTables = { ...tables,
      affiliate_programs: [...tables.affiliate_programs, { ...tables.affiliate_programs[0], id: PROGB, name: 'Wholesale', slug: 'wholesale', commission_percent: 15 }],
      affiliates: [...tables.affiliates, { ...tables.affiliates[0], id: AFFB, program_id: PROGB, contact_email: 'PAT@creator.invalid', from_prospect_id: null }],
      affiliate_codes: [...tables.affiliate_codes, { id: 'cB', company_entity_id: CO, program_id: PROGB, affiliate_id: AFFB, code: 'PAT15', starts_on: '2026-10-01', ends_on: null, status: 'active' }],
      affiliate_performance_v: [...tables.affiliate_performance_v, { ...tables.affiliate_performance_v[0], program_id: PROGB, affiliate_id: AFFB, attributed_orders: 2, gross_subtotal_cents: 10000 }],
      affiliate_balances_v: [...tables.affiliate_balances_v, { ...tables.affiliate_balances_v[0], program_id: PROGB, affiliate_id: AFFB, earned_cents: 1500, unclaimed_cents: 1500 }] };
    const all = await suite.open('/v2/affiliates/index.html', allTables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true } });
    all.on('pageerror', (e) => errors.push(e.message));
    R.ok('with two programs the picker offers All programs', await all.evaluate(() => [...document.querySelectorAll('#programSel option')].some((o) => o.value === '*' && /All programs/.test(o.textContent))));
    await all.selectOption('#programSel', '*');
    await toProgram(all);
    await all.waitForFunction(() => /By program/.test(document.getElementById('overviewBody')?.textContent || ''), null, { timeout: 5000 });
    const allHome = await text(all, '#overviewBody');
    R.has(allHome, 'Wholesale', 'Home lists every program');
    R.has(allHome, '$150.00', 'and sums sales across programs');
    R.has(allHome, '$20.00', 'and sums what is owed across programs');
    await closeDialog(all);
    await all.click('#tabs [data-tab="people"]');
    await all.waitForFunction(() => !!document.querySelector('#affiliatesBody .af-allprog'), null, { timeout: 5000 });
    await toTiles(all, '#affiliatesBody');
    R.eq(await all.evaluate(() => document.querySelectorAll('#affiliatesBody .af-item--catalog').length), 1, 'one person in two programs is one card');
    const allPpl = await text(all, '#affiliatesBody');
    R.ok('with a row for each program and its code', allPpl.includes('PAT10') && allPpl.includes('PAT15') && allPpl.includes('Creators') && allPpl.includes('Wholesale'));
    await closeDialog(all);
    await all.click('#tabs [data-tab="payouts"]');
    await all.waitForFunction(() => !!document.querySelector('#payoutsBody [data-act="pick-program"]'), null, { timeout: 5000 });
    R.ok('a tab that works one program at a time asks which', /Pick a program/.test(await text(all, '#payoutsBody')));
    R.ok('and writes nothing while it asks', !(await all.$('#payoutsBody [data-act^="q-"], #payoutsBody [data-act="payout-export"]')));
    await all.click(`#payoutsBody [data-act="pick-program"][data-id="${PROGB}"]`);
    await all.waitForFunction((id) => document.getElementById('programSel').value === id, PROGB, { timeout: 5000 });
    await all.waitForFunction(() => !/Pick a program/.test(document.getElementById('payoutsBody')?.textContent || ''), null, { timeout: 5000 });
    R.ok('Open switches to that program on the same tab', await all.evaluate(() => !document.querySelector('section[data-panel="payouts"]').hidden));
    await all.close();
    // One program only: no All programs option.
    const one = await suite.open('/v2/affiliates/index.html', tables, { ready, rpc: { can_manage_affiliate_programs: true } });
    R.ok('with one program there is no All programs option', !(await one.evaluate(() => [...document.querySelectorAll('#programSel option')].some((o) => o.value === '*'))));
    await one.close();

    // ── Share: compact, list view, ten most recent ─────────────────────────
    const feed12 = Array.from({ length: 12 }, (_, i) => ({ id: 'fx' + i, company_entity_id: CO, program_id: PROG, kind: 'product', source_id: 'p' + i, title: 'Shared ' + i, image_url: null, product_path: '/products/p' + i, shared_at: new Date(Date.now() - i * 60000).toISOString() }));
    const shp = await suite.open('/v2/affiliates/index.html', { ...tables, affiliate_feed_items: feed12 }, { ready, rpc: { can_manage_affiliate_programs: true } });
    shp.on('pageerror', (e) => errors.push(e.message));
    await closeDialog(shp);
    await shp.click('#tabs [data-tab="share"]');
    await shp.waitForFunction(() => /Shared 0/.test(document.getElementById('shareBody')?.textContent || ''), null, { timeout: 5000 });
    R.eq(await shp.evaluate(() => document.querySelectorAll('#shareBody .af-srow').length), 10, 'Share shows the ten most recent by default');
    R.ok('the newest first, the oldest held back', (await text(shp, '#shareBody')).includes('Shared 0') && !(await text(shp, '#shareBody')).includes('Shared 11'));
    await shp.click('#shareBody [data-act="share-all"]');
    await shp.waitForFunction(() => document.querySelectorAll('#shareBody .af-srow').length === 12, null, { timeout: 5000 });
    R.ok('Show all shows the rest, and the button goes', !(await shp.$('#shareBody [data-act="share-all"]')));
    R.ok('no big picture cards: every item is a row with a small square', await shp.evaluate(() => [...document.querySelectorAll('#shareBody .af-srow-img')].every((i) => i.getBoundingClientRect().width <= 48)));
    await shp.close();
    // A person fills in what search did not find; a waiting DM becomes an email.
    const edit = await suite.open('/v2/affiliates/index.html', ctTables, { ready, rpc: ctRpc });
    edit.on('pageerror', (e) => errors.push(e.message));
    await closeDialog(edit);
    await openProspectMore(edit, 'p1');
    await edit.click('[data-act="prospect-edit"][data-id="p1"]');
    await edit.waitForSelector('#epEmail', { timeout: 5000 });
    await edit.fill('#epEmail', 'Sam@Runs.Example');
    await edit.click('#afDialogBody [data-act="prospect-save"]');
    await edit.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'update'), null, { timeout: 5000 });
    const pe = await edit.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_prospects' && q._op === 'update').pop());
    R.ok('Edit saves the email a person typed, marked as entered by a person', pe?.patch?.contact_email === 'sam@runs.example' && pe.patch.contact_source_url === null);
    const mv = await edit.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'update').pop());
    R.ok('the waiting message moves from DM to email', mv.patch.channel === 'email' && mv.patch.recipient_email === 'sam@runs.example');
    R.ok('only messages not yet sent', mv.filters.some((f) => f.op === 'in' && f.col === 'state' && JSON.stringify(f.vals) === JSON.stringify(['draft', 'approved'])));
    await edit.close();
    // A rep marks a creator contacted by hand (reached outside SILO).
    // Approve and export from the queue in one press (Blake 2026-11-19).
    {
      const exTables = { ...ctTables, affiliate_outreach_drafts: [...ctTables.affiliate_outreach_drafts.map((x) => (x.id === 'd1' ? { ...x, channel: 'email', recipient_email: 'sam@creator.invalid' } : x.id === 'd2' ? { ...x, channel: 'email', recipient_email: 'gone@creator.invalid' } : x)),
        { id: 'd5', company_entity_id: CO, program_id: PROG, prospect_id: 'p1', state: 'approved', channel: 'email', recipient_email: 'other@creator.invalid', subject: 'Hi', body: 'b', created_at: now }] };
      const ex = await suite.open('/v2/affiliates/index.html', exTables, { ready, rpc: ctRpc,
        edge: { 'affiliate-invite': { status: 200, body: { signup_url: 'https://get-silo.invalid/join?t=abc', expires_at: now } } } });
      ex.on('pageerror', (e) => errors.push(e.message));
      // The test page is plain http, where the browser offers no SubtleCrypto.
      await ex.evaluate(() => { if (!crypto.subtle) Object.defineProperty(crypto, 'subtle', { configurable: true, value: { digest: async () => new Uint8Array(32).buffer } }); });
      await ex.evaluate(() => { window.__files = []; window.__names = []; const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__names.push(this.download); return click.call(this); }; const orig = URL.createObjectURL; URL.createObjectURL = (b) => { b.text().then((t) => window.__files.push(t)); return orig.call(URL, b); }; });
      await closeDialog(ex);
      await ex.click('#tabs [data-tab="comms"]');
      await ex.waitForSelector('#outreachBody [data-act="q-pick"][data-q="msgs"][data-id="d1"]', { timeout: 5000 });
      await ex.click('#outreachBody [data-act="q-pick"][data-q="msgs"][data-id="d1"]');
      await ex.click('#outreachBody [data-act="q-pick"][data-q="msgs"][data-id="d2"]');
      // d2 was deleted by someone else meanwhile: every update of the drafts
      // answers with the rows it really changed, as PostgREST does, and d2 is
      // in none of them.
      await ex.evaluate(() => {
        window.__FIXTURE_UPDATE_RETURNS__ = (table, patch, filters) => {
          if (table !== 'affiliate_outreach_drafts') return undefined;
          const f = filters.filter((x) => x.col === 'id');
          const ids = f.flatMap((x) => (x.op === 'in' ? x.vals : [x.val]));
          return ids.filter((id) => id !== 'd2').map((id) => ({ id }));
        };
      });
      await ex.click('#outreachBody [data-act="q-msg-export"]');
      await ex.click('#outreachBody [data-act="q-msg-export"]');
      await ex.waitForFunction(() => (window.__names || []).some((n) => /^outreach-.*\.csv$/.test(n)), null, { timeout: 5000 }).catch(async () => { throw new Error('no CSV: ' + (await ex.evaluate(() => document.getElementById('status')?.textContent))); });
      const file = await ex.evaluate(() => window.__files.join('\n'));
      R.has(file, 'sam@creator.invalid', 'the CSV carries the ticked message\'s email');
      R.has(file, 'https://get-silo.invalid/join?t=abc', 'and its personal sign-up link');
      R.not(file, 'other@creator.invalid', 'and not a message nobody ticked');
      R.not(file, 'gone@creator.invalid', 'nor a ticked one that was no longer a draft');
      R.has(await text(ex, '#status'), 'no longer drafts', 'and it says one was left out');
      const ups = await ex.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'update').map((q) => [q.patch.state, (q.filters.find((f) => f.op === 'in' && f.col === 'id') || {}).vals]));
      R.eq(ups, [['approved', ['d1', 'd2']], ['exported', ['d1']]], 'the ticked messages are approved, and only the one really approved is exported');
      await commsChip(ex, 'email');
      R.ok('the Send by email list offers the CSV by name', /Export \d+ as CSV|Nothing approved/.test(await text(ex, '#outreachBody')));
      await ex.close();
    }
    // ── Access: a grant may name one program, a share may name creators ──
    // (20261121210000.) Both are additive, so the page has to read right in
    // BOTH database states: before the migration and after it.
    {
      const PSIDE = '66666666-6666-4666-8666-666666666666';
      const scoped = { ...tables,
        affiliate_programs: [tables.affiliate_programs[0], { ...tables.affiliate_programs[0], id: PSIDE, name: 'Wholesale', slug: 'wholesale' }],
        profiles: [tables.profiles[0], { id: 'u2', name: 'Robin Reps', email: 'robin@brand.invalid', role: 'member', is_active: true }],
        affiliate_program_managers: [
          { id: 'g1', company_entity_id: CO, user_id: 'u1', program_id: null, created_at: now },
          { id: 'g2', company_entity_id: CO, user_id: 'u2', program_id: PROG, created_at: now },
        ],
        entity_memberships: [{ entity_id: CO, user_id: 'u1' }, { entity_id: CO, user_id: 'u2' }] };
      const sc = await suite.open('/v2/affiliates/index.html', scoped, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true } });
      sc.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(sc);
      await openRecords(sc);
      await recTab(sc, 'team');
      const team = await text(sc, '#recordsBody');
      R.has(team, 'All programs', 'a grant that names no program says so');
      R.has(team, 'Creators only', 'and one that names a program names it');
      R.ok('the grant form asks which program', !!(await sc.$('#recordsBody #mgrProgram')));
      // The form is read by id, so a second copy of it in a hidden panel
      // would have the page send whatever that one holds.
      R.eq(await sc.evaluate(() => [document.querySelectorAll('#mgrUser').length, document.querySelectorAll('#mgrProgram').length]), [1, 1],
        'and the form exists once on the page');
      await sc.selectOption('#recordsBody #mgrUser', 'u2');
      await sc.selectOption('#recordsBody #mgrProgram', PSIDE);
      await sc.click('#recordsBody [data-act="add-manager"]');
      await sc.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_program_managers' && q._op === 'insert'), null, { timeout: 5000 });
      const gr = await sc.evaluate(() => { const r = window.__QUERIES__.filter((q) => q.table === 'affiliate_program_managers' && q._op === 'insert').pop().rows; return Array.isArray(r) ? r[0] : r; });
      R.eq([gr?.user_id, gr?.program_id], ['u2', PSIDE], 'and grants exactly the program picked');
      await sc.close();
    }
    // Before the migration there is no program_id column, and the page must
    // still list who can run Studio rather than showing nothing.
    {
      const old = { ...tables,
        affiliate_program_managers: [{ id: 'g1', company_entity_id: CO, user_id: 'u1', created_at: now }] };
      const og = await suite.open('/v2/affiliates/index.html', old, { ready, rpc: { can_manage_affiliate_programs: true },
        missingColumns: { affiliate_program_managers: ['program_id'] } });
      og.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(og);
      await openRecords(og);
      await recTab(og, 'team');
      const oldTeam = await text(og, '#recordsBody');
      R.has(oldTeam, 'Dana Ops', 'the grant list still renders with the column missing');
      R.has(oldTeam, 'All programs', 'and every grant reads as what it is: all of them');
      R.ok('with no program picker, so nothing is sent that the database would refuse', !(await og.$('#mgrProgram')));
      await og.selectOption('#recordsBody #mgrUser', 'u1');
      await og.click('#recordsBody [data-act="add-manager"]');
      await og.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_program_managers' && q._op === 'insert'), null, { timeout: 5000 });
      const og1 = await og.evaluate(() => { const r = window.__QUERIES__.filter((q) => q.table === 'affiliate_program_managers' && q._op === 'insert').pop().rows; return Array.isArray(r) ? r[0] : r; });
      R.ok('the insert names no program at all', !('program_id' in (og1 || {})));
      await og.close();
    }
    // A share is for everyone in the program until somebody is named.
    {
      const shared = { ...tables,
        affiliates: [tables.affiliates[0],
          { id: 'aff2', company_entity_id: CO, program_id: PROG, display_name: 'Robin Rides', contact_email: 'robin@creator.invalid', status: 'active', terms_version_accepted: 2, terms_accepted_at: now, created_at: now },
          { id: 'aff3', company_entity_id: CO, program_id: PROG, display_name: 'Gone', contact_email: 'gone@creator.invalid', status: 'ended', terms_version_accepted: 2, terms_accepted_at: now, created_at: now }],
        affiliate_feed_audience: [] };
      const sh = await suite.open('/v2/affiliates/index.html', shared, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true,
          affiliate_feed_set_audience: (a) => ({ named: (a.p_affiliates || []).length }) } });
      sh.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(sh);
      await sh.click('#tabs [data-tab="share"]');
      await sh.waitForSelector('#shareBody [data-act="share-tab"][data-k="shared"]', { timeout: 5000 });
      await sh.click('#shareBody [data-act="share-tab"][data-k="shared"]');
      await sh.waitForFunction(() => /Trail Hat/.test(document.getElementById('shareBody')?.textContent || ''), null, { timeout: 5000 });
      R.has(await text(sh, '#shareBody'), 'Everyone', 'a share nobody is named on is for everyone');
      await sh.click('#shareBody [data-act="feed-who"][data-id="f1"]');
      await sh.waitForSelector('#afDialogBody .af-who', { timeout: 5000 });
      const ticked = await sh.evaluate(() => [...document.querySelectorAll('#afDialogBody .af-who')].filter((x) => x.checked).length);
      R.eq(ticked, 0, 'the dialog opens on what the share means now: nobody named, so nothing ticked');
      const offered = await sh.evaluate(() => [...document.querySelectorAll('#afDialogBody .af-who')].map((x) => x.value));
      R.eq(offered, [AFF, 'aff2'], 'and offers the creators still in the program, not the ones who left');
      await sh.check(`#afDialogBody .af-who[value="${AFF}"]`);
      await sh.click('#afDialogBody [data-act="feed-who-save"]');
      await sh.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'rpc:affiliate_feed_set_audience'), null, { timeout: 5000 });
      const setArgs = await sh.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'rpc:affiliate_feed_set_audience').pop().args);
      R.eq([setArgs.p_item, setArgs.p_affiliates], ['f1', [AFF]], 'saving names the whole audience of that share in one call');
      R.eq(setArgs.p_scope, [AFF, 'aff2'], 'and says which creators it offered, so a save replaces only within them');
      // Which is only honest if the list really is the whole program, so the
      // read is paged and the dialog says so when it is not.
      R.ok('the creator list is read in pages',
        await sh.evaluate(() => window.__QUERIES__.some((q) => q.table === 'affiliates' && q._op === 'select' && Array.isArray(q.range))));
      R.not(await text(sh, '#afDialogBody'), 'Not every creator', 'and with the whole program read it does not warn about a partial list');
      // Two steps would leave the share open to the whole program in between,
      // and open for good if the second never landed.
      R.ok('and never empties the table on its own',
        !(await sh.evaluate(() => window.__QUERIES__.some((q) => q.table === 'affiliate_feed_audience' && (q._op === 'delete' || q._op === 'insert')))));
      await sh.close();
    }
    // A share with somebody named says how many of the program see it, and
    // ticking nobody gives it back to everyone.
    {
      const named = { ...tables,
        affiliates: [tables.affiliates[0],
          { id: 'aff2', company_entity_id: CO, program_id: PROG, display_name: 'Robin Rides', contact_email: 'robin@creator.invalid', status: 'active', terms_version_accepted: 2, terms_accepted_at: now, created_at: now }],
        affiliate_feed_audience: [{ id: 'x1', company_entity_id: CO, feed_item_id: 'f1', affiliate_id: AFF }] };
      const nm = await suite.open('/v2/affiliates/index.html', named, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true,
          affiliate_feed_set_audience: (a) => ({ named: (a.p_affiliates || []).length }) } });
      nm.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(nm);
      await nm.click('#tabs [data-tab="share"]');
      await nm.waitForSelector('#shareBody [data-act="share-tab"][data-k="shared"]', { timeout: 5000 });
      await nm.click('#shareBody [data-act="share-tab"][data-k="shared"]');
      await nm.waitForFunction(() => /Trail Hat/.test(document.getElementById('shareBody')?.textContent || ''), null, { timeout: 5000 });
      const shBody = await text(nm, '#shareBody');
      R.has(shBody, '1 of 2', 'a share with somebody named says how many of the program see it');
      R.not(shBody, 'Everyone', 'and does not also claim everyone');
      await nm.click('#shareBody [data-act="feed-who"][data-id="f1"]');
      await nm.waitForSelector('#afDialogBody .af-who', { timeout: 5000 });
      R.eq(await nm.evaluate(() => [...document.querySelectorAll('#afDialogBody .af-who')].filter((x) => x.checked).map((x) => x.value)), [AFF],
        'the dialog opens with the creators already named ticked');
      await nm.uncheck(`#afDialogBody .af-who[value="${AFF}"]`);
      await nm.click('#afDialogBody [data-act="feed-who-save"]');
      await nm.waitForFunction(() => /everyone in this program/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 5000 });
      const emptied = await nm.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'rpc:affiliate_feed_set_audience').pop().args);
      R.eq(emptied.p_affiliates, [], 'ticking nobody hands the share back to everyone, named as such');
      await nm.close();
    }
    // A named recipient the dialog cannot show -- here one who has left the
    // program -- is not dropped by a save of the boxes it did show.
    {
      const outside = { ...tables,
        affiliates: [tables.affiliates[0],
          { id: 'aff2', company_entity_id: CO, program_id: PROG, display_name: 'Robin Rides', contact_email: 'robin@creator.invalid', status: 'active', terms_version_accepted: 2, terms_accepted_at: now, created_at: now },
          { id: 'aff3', company_entity_id: CO, program_id: PROG, display_name: 'Gone', contact_email: 'gone@creator.invalid', status: 'ended', terms_version_accepted: 2, terms_accepted_at: now, created_at: now }],
        affiliate_feed_audience: [{ id: 'x1', company_entity_id: CO, feed_item_id: 'f1', affiliate_id: 'aff3' }] };
      const ou = await suite.open('/v2/affiliates/index.html', outside, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true,
          affiliate_feed_set_audience: (a) => ({ named: (a.p_affiliates || []).length }) } });
      ou.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(ou);
      await ou.click('#tabs [data-tab="share"]');
      await ou.waitForSelector('#shareBody [data-act="share-tab"][data-k="shared"]', { timeout: 5000 });
      await ou.click('#shareBody [data-act="share-tab"][data-k="shared"]');
      await ou.waitForFunction(() => /Trail Hat/.test(document.getElementById('shareBody')?.textContent || ''), null, { timeout: 5000 });
      await ou.click('#shareBody [data-act="feed-who"][data-id="f1"]');
      await ou.waitForSelector('#afDialogBody .af-who', { timeout: 5000 });
      R.eq(await ou.evaluate(() => [...document.querySelectorAll('#afDialogBody .af-who')].map((x) => x.value)), [AFF, 'aff2'],
        'the creator who left the program is not among those offered');
      await ou.check(`#afDialogBody .af-who[value="${AFF}"]`);
      await ou.click('#afDialogBody [data-act="feed-who-save"]');
      await ou.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'rpc:affiliate_feed_set_audience'), null, { timeout: 5000 });
      const ouArgs = await ou.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'rpc:affiliate_feed_set_audience').pop().args);
      R.ok('so the save cannot reach their row: the scope it sends holds only what it showed',
        Array.isArray(ouArgs.p_scope) && !ouArgs.p_scope.includes('aff3'));
      R.eq(ouArgs.p_affiliates, [AFF], 'and it names only the box that was ticked');
      await ou.close();
    }
    // The audience table before the migration: unreadable, and the page says
    // everyone rather than falling over or hiding the shares.
    {
      const noAud = await suite.open('/v2/affiliates/index.html', tables, { ready, rpc: { can_manage_affiliate_programs: true, can_approve_affiliate_commissions: true },
        broken: ['affiliate_feed_audience'] });
      noAud.on('pageerror', (e) => errors.push(e.message));
      await closeDialog(noAud);
      await noAud.click('#tabs [data-tab="share"]');
      await noAud.waitForSelector('#shareBody [data-act="share-tab"][data-k="shared"]', { timeout: 5000 });
      await noAud.click('#shareBody [data-act="share-tab"][data-k="shared"]');
      await noAud.waitForFunction(() => /Trail Hat/.test(document.getElementById('shareBody')?.textContent || ''), null, { timeout: 5000 });
      const nb = await text(noAud, '#shareBody');
      R.has(nb, 'Trail Hat', 'with the audience table unreadable the shares still render');
      R.has(nb, 'Everyone', 'and read as what every share meant before it existed');
      // And it is not reported as a loading failure: the migration is simply
      // not applied yet, which is a known state, not a fault to alarm anyone.
      const banner = await noAud.evaluate(() => { const el = document.getElementById('status'); return el && !el.hidden ? el.textContent : ''; });
      R.ok('and the page does not cry about data that did not load', !/audience/i.test(banner));
      // Saving replaces the whole audience, so an audience we could not read
      // must not be offered for change: that would hand a narrowed share to
      // the whole program (review of #1350).
      R.ok('and does not offer to change an audience it never read', !(await noAud.$('#shareBody [data-act="feed-who"]')));
      R.ok('while Stop sharing, which needs no audience, stays', !!(await noAud.$('#shareBody [data-act="feed-remove"]')));
      await noAud.close();
    }
    // Setup always shows the application link row (Blake 2026-11-19).
    {
      const inv = await suite.open('/v2/affiliates/index.html', { ...tables, affiliate_programs: [{ ...tables.affiliate_programs[0], intake_mode: 'invite_only' }] }, { ready, rpc: { can_manage_affiliate_programs: true } });
      await closeDialog(inv);
      await inv.click('#tabs [data-tab="program"]');
      await inv.waitForSelector('#rowApply', { timeout: 5000 });
      R.has(await text(inv, '#rowApply'), 'Choose Open applications', 'an invite-only program says how to get the link instead of hiding it');
      await inv.click('[data-seg="pIntake"][data-v="open"]');
      await inv.waitForSelector('#rowApply [data-act="copy-text"]', { timeout: 5000 });
      R.ok('choosing Open applications shows the link at once', true);
      await inv.close();
    }
    const mcp = await suite.open('/v2/affiliates/index.html', { ...ctTables, affiliate_outreach_drafts: [] }, { ready, rpc: ctRpc });
    mcp.on('pageerror', (e) => errors.push(e.message));
    await closeDialog(mcp);
    await mcp.click('#tabs [data-tab="people"]');
    await openProspectMore(mcp, 'p1');
    await mcp.waitForFunction(() => !!document.querySelector('[data-act="prospect-contacted"][data-id="p1"]'), null, { timeout: 5000 });
    await mcp.click('[data-act="prospect-contacted"][data-id="p1"]');
    await mcp.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'insert'), null, { timeout: 5000 });
    // The pop-up redraws on what it NOW offers, not on the creator's status:
    // Mark contacted and Draft message change a draft, not the creator, and a
    // pop-up that did not move left the pressed button there to press again.
    // The fake database does not keep inserts, so the row is put in the
    // fixture by hand and the page re-read, which is the same redraw.
    await mcp.evaluate(() => {
      window.__FIXTURE_TABLES__.affiliate_outreach_drafts.push({ id: 'd-hand', company_entity_id: window.__FIXTURE_TABLES__.affiliate_prospects[0].company_entity_id, program_id: window.__FIXTURE_TABLES__.affiliate_prospects[0].program_id, prospect_id: 'p1', channel: 'email', state: 'sent', created_at: new Date().toISOString() });
    });
    await mcp.click('[data-act="prospect-more"][data-id="p1"]').catch(() => {});
    await mcp.click('#afDialogBody [data-act="prospect-contacted"][data-id="p1"]').catch(() => {});
    const gone = await mcp.waitForFunction(() => !document.querySelector('#afDialogBody [data-act="prospect-contacted"][data-id="p1"]'), null, { timeout: 5000 }).then(() => true, () => false);
    R.ok('a creator already marked contacted loses that button in the pop-up, without closing it', gone);
    const mrow = await mcp.evaluate(() => { const r = window.__QUERIES__.filter((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'insert').pop().rows; return Array.isArray(r) ? r[0] : r; });
    R.ok('Mark contacted records a sent message with who marked it', mrow?.state === 'sent' && !!mrow.sent_marked_by && mrow.sent_evidence === 'Contacted by hand' && mrow.prospect_id === 'p1');
    await mcp.close();
    // Inbound: someone who found the brand and applied waits on Outreach, not in People.
    const inb = await suite.open('/v2/affiliates/index.html', { ...ctTables, affiliate_prospects: [...ctTables.affiliate_prospects,
      { id: 'pa1', company_entity_id: CO, program_id: PROG, display_name: 'Ava Applies', platform: 'instagram', handle: '@avaapplies', profile_url: 'https://www.instagram.com/avaapplies', contact_email: 'ava@creator.invalid', source: 'applied', status: 'new', collected_at: now, evidence: { note: 'Love the hats' } }] }, { ready, rpc: ctRpc });
    inb.on('pageerror', (e) => errors.push(e.message));
    R.has(await text(inb, '#tabs'), 'Outreach', 'Comms is now called Outreach');
    await closeDialog(inb);
    await inb.click('#tabs [data-tab="comms"]');
    await commsChip(inb, 'inbound');
    await inb.waitForFunction(() => /Ava Applies/.test(document.getElementById('outreachBody').textContent), null, { timeout: 5000 });
    R.has(await text(inb, '#outreachBody'), 'Inbound', 'applications have their own Inbound list');
    R.ok('an application can be approved from Inbound', !!(await inb.$('#outreachBody [data-act="prospect-status"][data-id="pa1"][data-s="approved"]')));
    await closeDialog(inb);
    await inb.click('#tabs [data-tab="people"]');
    R.not(await text(inb, '#prospectsBody'), 'Ava Applies', 'and is not mixed into People to review');
    await inb.close();

    // ── apply page ────────────────────────────────────────────────────────
    const apply = await suite.open('/v2/affiliates/apply.html?c=' + PROG + '&p=creators', {}, { ready: () => !!document.getElementById('form') });
    await apply.fill('#name', 'Lee'); await apply.fill('#email', 'lee@creator.invalid'); await apply.fill('#handle', '@lee');
    R.has(await text(apply, '#hero'), 'Become a Brand A partner', 'the apply page names the brand');
    R.has(await text(apply, '#hero'), '10% of every sale', 'and shows the offer');
    await apply.click('#go');
    await apply.waitForFunction(() => /application is in/.test(document.body.textContent), null, { timeout: 5000 });
    const ap = calls.find((c) => c.action === 'apply');
    R.eq(ap?.company_id, PROG, 'the application carries the company from the link');
    R.eq(ap?.website, '', 'the honeypot is sent empty by a person');
    await apply.close();
    // The same public link signs an affiliate in (Blake 2026-11-17: "apply/login page").
    const both = await suite.open('/v2/affiliates/apply.html?c=' + PROG + '&p=creators', {}, { ready: () => !!document.getElementById('form') });
    await both.click('#seg [data-k="signin"]');
    await both.waitForSelector('#signin', { timeout: 5000 });
    await both.fill('#siEmail', 'lee@creator.invalid'); await both.click('#siGo');
    await both.waitForFunction(() => /sign-in link is on its way/.test(document.getElementById('status').textContent), null, { timeout: 5000 });
    R.eq(calls.filter((c) => c.action === 'signin').pop()?.email, 'lee@creator.invalid', 'the apply page signs an affiliate in');
    await both.close();
    const closed = await suite.open('/v2/affiliates/apply.html?c=' + PROG + '&p=closed', {}, { ready: () => !!document.getElementById('signin') });
    R.ok('a closed program shows sign-in only, no apply form', !(await closed.$('#form')) && !(await closed.$('#seg button')));
    await closed.close();


    // ── People > Your Customers (20261124030000) ───────────────────────────
    // The repeat buyers to recruit from, and one press into the outreach
    // queue. Proved here because the whole feature is the integrated path:
    // the read is lazy, the ticks exclude who cannot be written to, and the
    // press has to produce a prospect AND a draft the existing queue accepts.
    {
      const CUSTS = [
        { customer_key: 'loyal@buyer.invalid', company_entity_id: CO, name_lc: 'lou loyal', email_lc: 'loyal@buyer.invalid', order_count: 9, lifetime_spend: '1811.40', first_order_at: '2025-02-02T00:00:00Z', last_order_at: '2026-11-01T00:00:00Z', email_consent_state: 'subscribed', sms_consent_state: null, consent_checked_at: '2026-11-24T00:00:00Z' },
        { customer_key: 'quiet@buyer.invalid', company_entity_id: CO, name_lc: 'quin quiet', email_lc: 'quiet@buyer.invalid', order_count: 4, lifetime_spend: '402.00', first_order_at: '2025-03-03T00:00:00Z', last_order_at: '2026-10-01T00:00:00Z', email_consent_state: null, sms_consent_state: null, consent_checked_at: null },
        { customer_key: 'nope@buyer.invalid', company_entity_id: CO, name_lc: 'nat nope', email_lc: 'nope@buyer.invalid', order_count: 6, lifetime_spend: '600.00', first_order_at: '2025-04-04T00:00:00Z', last_order_at: '2026-09-01T00:00:00Z', email_consent_state: 'unsubscribed', sms_consent_state: null, consent_checked_at: '2026-11-24T00:00:00Z' },
        { customer_key: 'cid:5551', company_entity_id: CO, name_lc: 'pos walkin', email_lc: null, order_count: 3, lifetime_spend: '90.00', first_order_at: '2025-05-05T00:00:00Z', last_order_at: '2026-08-01T00:00:00Z', email_consent_state: null, sms_consent_state: null, consent_checked_at: null },
      ];
      const custTables = {
        ...tables,
        company_customer_profiles: CUSTS,
        // Somebody who asked not to be contacted, and a whole domain.
        affiliate_suppressions: [{ id: 's-c1', company_entity_id: CO, kind: 'email', value_normalized: 'nope@buyer.invalid', reason: 'opted_out', created_at: now }],
        affiliate_programs: [{ ...tables.affiliate_programs[0], customer_outreach_subject: null, customer_outreach_body: null }],
      };
      const cu = await suite.open('/v2/affiliates/index.html', custTables, { ready, rpc: { can_manage_affiliate_programs: true } });
      cu.on('pageerror', (e) => errors.push(`customers: ${e.message}`));

      // LAZY: nothing is read until the sub-tab is opened. People must not get
      // slower for everybody who never looks at this list.
      // Find (the landing view) reads the scan tables, the full list reads
      // profiles: none of them before the sub-tab is opened.
      const readsBefore = await cu.evaluate(() => window.__QUERIES__.filter((q) => ['company_customer_profiles', 'affiliate_customer_scans', 'affiliate_customer_social'].includes(q.table)).length);
      R.eq(readsBefore, 0, 'Your Customers reads nothing until it is opened');

      await cu.click('#peopleSubtabs [data-k="customers"]');
      // Hunt is the landing view; these checks are about the full list.
      await cu.click('#customersBody [data-act="cust-view"][data-k="all"]');
      await cu.waitForFunction(() => {
        const el = document.getElementById('customersBody');
        return !!el && !el.hidden && /Lou Loyal/.test(el.textContent || '');
      }, null, { timeout: 5000 });
      const body = await text(cu, '#customersBody');
      R.has(body, 'Lou Loyal', 'the list renders, with the stored lowercase name cased back');
      R.has(body, '1,811', 'lifetime spend is shown');
      R.has(body, 'not checked yet', 'an unmeasured consent says so');
      // Checked on that customer's OWN row: "unsubscribed" appears elsewhere
      // on the page for somebody who really did unsubscribe.
      const quietRow = await cu.evaluate(() => [...document.querySelectorAll('#customersBody tbody tr')]
        .map((tr) => tr.textContent || '').find((t) => /Quin Quiet/.test(t)) || '');
      R.has(quietRow, 'not checked yet', 'the unmeasured row says it has not been checked');
      R.ok('and is never shown as unsubscribed', !/unsubscribed/i.test(quietRow));

      // The default read: ranked by orders, and no consent predicate at all --
      // consent is a filter, never a gate (Blake 2026-11-24).
      const firstRead = await cu.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'company_customer_profiles' && !q.head)[0]);
      R.eq((firstRead?.orders || []).map((o) => o.col),
        ['order_count', 'lifetime_spend', 'last_order_at', 'customer_key'],
        'ranked by orders, then spend, then recency, and tie-broken on a unique column so a row cannot appear on two pages');
      R.eq(firstRead?.orders?.[0]?.opts?.ascending, false, 'most orders first');
      R.eq((firstRead?.filters || []).filter((f) => f.col === 'email_consent_state').length, 0,
        'the default applies no consent filter: opt-in narrows the list, it does not gate it');
      R.ok('and the window is on the last order',
        (firstRead?.filters || []).some((f) => f.col === 'last_order_at' && f.op === 'gte'));

      // Filtering TO "not checked yet" is an IS NULL, not a comparison with
      // the word -- no row holds it, so the list would read as "nobody".
      await cu.selectOption('#custConsent', 'unmeasured');
      await cu.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'company_customer_profiles'
        && (q.filters || []).some((f) => f.col === 'email_consent_state' && f.op === 'is')), null, { timeout: 5000 });
      R.ok('"not checked yet" reads as IS NULL', true);
      await cu.selectOption('#custConsent', 'any');
      await cu.waitForFunction(() => /Lou Loyal/.test(document.getElementById('customersBody')?.textContent || ''), null, { timeout: 5000 });

      // Who can be ticked: not the customer with no email (nothing to write
      // to) and not the one who asked not to be contacted.
      const picks = await cu.evaluate(() => [...document.querySelectorAll('#customersBody [data-act="cust-pick"]')].map((el) => el.dataset.k));
      R.ok('a customer with no email cannot be ticked', !picks.includes('cid:5551'));
      R.ok('nor can somebody on the do-not-contact list', !picks.includes('nope@buyer.invalid'));
      R.ok('the rest can', picks.includes('loyal@buyer.invalid') && picks.includes('quiet@buyer.invalid'));
      R.has(body, 'on your do-not-contact list', 'and the row says why rather than silently losing its tick box');

      // One press: a prospect and a draft, into the queue that already exists.
      await cu.click('#customersBody [data-act="cust-pick"][data-k="loyal@buyer.invalid"]');
      await cu.waitForSelector('#customersBody [data-act="cust-add"]', { timeout: 5000 });
      await cu.click('#customersBody [data-act="cust-add"]');
      await cu.waitForFunction(() => /draft/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
      const pros = await cu.evaluate(() => { const q = window.__QUERIES__.filter((x) => x.table === 'affiliate_prospects' && x._op === 'insert').pop(); return Array.isArray(q?.rows) ? q.rows[0] : q?.rows; });
      R.eq([pros?.source, pros?.status, pros?.platform], ['customer', 'approved', 'other'],
        'a picked customer becomes an ordinary prospect, recorded as coming from your customers');
      R.eq(pros?.contact_email, 'loyal@buyer.invalid', 'identified by email, which is what the relaxed constraint allows');
      R.eq([pros?.handle, pros?.profile_url], [null, null], 'and claims no channel it has not found');
      R.eq(pros?.evidence?.order_count, 9, 'carrying the order facts for whoever reads the row');
      const draft = await cu.evaluate(() => { const q = window.__QUERIES__.filter((x) => x.table === 'affiliate_outreach_drafts' && x._op === 'insert').pop(); return Array.isArray(q?.rows) ? q.rows[0] : q?.rows; });
      R.eq([draft?.channel, draft?.recipient_email, draft?.state], ['email', 'loyal@buyer.invalid', undefined],
        'the draft is an ordinary email draft, left in the queue to be approved');
      // {signup_link} is still a token here, exactly as it is for a creator:
      // the personal link is minted at send time, not written into the draft.
      R.has(String(draft?.body || ''), '{signup_link}', 'the message keeps the signup token for the send to fill');
      R.ok('the message is filled in, not left as tokens', !/\{name\}|\{brand\}|\{commission\}|\{orders_line\}/.test(String(draft?.body || '')));
      R.has(String(draft?.body || ''), 'Lou', 'addressed to them by name');
      R.has(String(draft?.body || ''), '9 times', 'and leans on them already being a customer');
      R.ok('the creator pitch is not reused on a customer', !/through a search|found your/i.test(String(draft?.body || '')));
      await cu.close();
    }

    // ── Your Customers: the four ways Add to outreach can go wrong ────────
    // All four come from the same fact: there are TWO writes per customer and
    // a browser has no transaction, so every one of these is about what the
    // page does when the database, another tab, or the clock interferes.
    {
      const CUST1 = [{ customer_key: 'loyal@buyer.invalid', company_entity_id: CO, name_lc: 'lou loyal', email_lc: 'loyal@buyer.invalid', order_count: 9, lifetime_spend: '1811.40', first_order_at: '2025-02-02T00:00:00Z', last_order_at: '2026-11-01T00:00:00Z', email_consent_state: 'subscribed', sms_consent_state: null, consent_checked_at: '2026-11-24T00:00:00Z' },
        { customer_key: 'quiet@buyer.invalid', company_entity_id: CO, name_lc: 'quin quiet', email_lc: 'quiet@buyer.invalid', order_count: 4, lifetime_spend: '402.00', first_order_at: '2025-03-03T00:00:00Z', last_order_at: '2026-10-01T00:00:00Z', email_consent_state: null, sms_consent_state: null, consent_checked_at: null }];
      const base = { ...tables, company_customer_profiles: CUST1, affiliate_suppressions: [],
        affiliate_programs: [{ ...tables.affiliate_programs[0], customer_outreach_subject: null, customer_outreach_body: null }] };
      const openCust = async (fx) => {
        const pg = await suite.open('/v2/affiliates/index.html', fx, { ready, rpc: { can_manage_affiliate_programs: true } });
        pg.on('pageerror', (e) => errors.push(`customer-writes: ${e.message}`));
        return pg;
      };
      const showList = async (pg) => {
        await pg.click('#peopleSubtabs [data-k="customers"]');
        // Hunt is the landing view; these checks are about the full list.
        await pg.click('#customersBody [data-act="cust-view"][data-k="all"]');
        await pg.waitForFunction(() => /Lou Loyal/.test(document.getElementById('customersBody')?.textContent || ''), null, { timeout: 5000 });
      };
      const press = async (pg, key) => {
        await pg.click(`#customersBody [data-act="cust-pick"][data-k="${key}"]`);
        await pg.waitForSelector('#customersBody [data-act="cust-add"]', { timeout: 5000 });
        await pg.click('#customersBody [data-act="cust-add"]');
        await pg.waitForFunction(() => /draft|added|could not/i.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
        return text(pg, '#status');
      };
      const inserts = (pg, table) => pg.evaluate((t) => window.__QUERIES__.filter((x) => x.table === t && x._op === 'insert')
        .map((x) => (Array.isArray(x.rows) ? x.rows[0] : x.rows)), table);

      // 1 ── The same customer added twice, from two tabs. This tab loaded
      // before the other one wrote, so its own list cannot know -- the
      // database's identity index is what refuses the second prospect, and
      // the press has to ADOPT that row rather than report a failure, or one
      // person ends up with two prospects and two signup links.
      {
        const pg = await openCust(base);
        await showList(pg);
        await pg.evaluate(([co, prg]) => {
          window.__FIXTURE_TABLES__.affiliate_prospects.push({ id: 'p-other-tab', company_entity_id: co, program_id: prg, display_name: 'Lou Loyal', platform: 'other', handle: null, profile_url: null, contact_email: 'loyal@buyer.invalid', source: 'customer', status: 'approved', collected_at: new Date().toISOString(), evidence: { order_count: 9 } });
          window.__FAIL_WRITES__ = [{ table: 'affiliate_prospects', code: '23505', times: 1 }];
        }, [CO, PROG]);
        const st = await press(pg, 'loyal@buyer.invalid');
        const tried = await inserts(pg, 'affiliate_prospects');
        R.eq(tried.length, 1, 'the duplicate prospect is attempted once, not retried into existence');
        const dr = await inserts(pg, 'affiliate_outreach_drafts');
        R.eq(dr.length, 1, 'and the customer still gets exactly one message');
        R.eq(dr[0]?.prospect_id, 'p-other-tab', 'written against the prospect that already existed, not a second one');
        R.ok('the press does not report a failure for a duplicate it resolved', !/could not be added/.test(st));
        await pg.close();
      }

      // 2 ── The prospect lands and the message does not. The pair is not
      // atomic from a browser, so a retry has to FINISH it: reporting
      // "already in the program" would leave an approved customer prospect
      // that nobody will ever be messaged from.
      {
        const pg = await openCust(base);
        await showList(pg);
        await pg.evaluate(() => { window.__FAIL_WRITES__ = [{ table: 'affiliate_outreach_drafts', code: 'XX000', times: 1 }]; });
        const first = await press(pg, 'loyal@buyer.invalid');
        R.has(first, 'could not be added', 'a draft that fails is reported, not counted as created');
        const madeP = (await inserts(pg, 'affiliate_prospects'))[0];
        R.eq(madeP?.contact_email, 'loyal@buyer.invalid', 'the prospect was written before the failure');

        await pg.close();

        // The retry, from the state that press left behind: the customer is
        // an approved prospect and has no message. This is a fresh page
        // because that is how it is really met -- the operator comes back.
        const half = { ...base, affiliate_prospects: [...tables.affiliate_prospects,
          { id: 'p-half-done', company_entity_id: CO, program_id: PROG, display_name: 'Lou Loyal', platform: 'other', handle: null, profile_url: null, contact_email: 'loyal@buyer.invalid', source: 'customer', status: 'approved', collected_at: now, evidence: { order_count: 9 } }],
          affiliate_outreach_drafts: [] };
        const pg2 = await openCust(half);
        await showList(pg2);
        const second = await press(pg2, 'loyal@buyer.invalid');
        R.has(second, 'finished from an earlier attempt', 'the retry says it completed the interrupted one');
        const dr = await inserts(pg2, 'affiliate_outreach_drafts');
        R.eq(dr.length, 1, 'the retry writes the missing message');
        R.eq(dr[0]?.prospect_id, 'p-half-done', 'against the prospect that was already there');
        R.eq((await inserts(pg2, 'affiliate_prospects')).length, 0,
          'and makes no second prospect for the same person');
        await pg2.close();
      }

      // 3 ── A filter changed while the read was in flight, and the OLD read
      // lands last. Dropping the change leaves the old rows under the new
      // filter, so a customer outside the chosen segment stays tickable; and
      // letting the late read land puts them back after the right rows were
      // shown. The first read is held on its own so it resolves AFTER the
      // second, which is the order a slow network really produces.
      {
        const pg = await openCust(base);
        await pg.evaluate(() => {
          window.__releaseFirst = null;
          let held = false;
          window.__HOLD_READ__ = (q) => {
            if (held || q.table !== 'company_customer_profiles' || q.head) return null;
            held = true;
            return new Promise((r) => { window.__releaseFirst = r; });
          };
        });
        await pg.click('#peopleSubtabs [data-k="customers"]');
        // Hunt is the landing view; these checks are about the full list.
        await pg.click('#customersBody [data-act="cust-view"][data-k="all"]');
        await pg.waitForFunction(() => typeof window.__releaseFirst === 'function', null, { timeout: 5000 });
        await pg.selectOption('#custConsent', 'subscribed');
        // The newer read lands first and draws the subscribed list.
        await pg.waitForFunction(() => /Lou Loyal/.test(document.getElementById('customersBody')?.textContent || ''), null, { timeout: 5000 });
        // Now the older, unfiltered read lands.
        await pg.evaluate(() => window.__releaseFirst());
        await pg.waitForTimeout(300);
        // Any redraw reads what is held, so force one: the old rows, if they
        // were kept, would reappear here.
        await pg.click('#peopleSubtabs [data-k="customers"]');
        await pg.waitForTimeout(100);
        const shown = await text(pg, '#customersBody');
        R.ok('the late, unfiltered read does not replace the subscribed list', !/Quin Quiet/.test(shown));
        const picks = await pg.evaluate(() => [...document.querySelectorAll('#customersBody [data-act="cust-pick"]')].map((el) => el.dataset.k));
        R.eq(picks, ['loyal@buyer.invalid'], 'and nobody outside the chosen segment is tickable');
        await pg.close();
      }

      // 4 ── A mixed queue redrafted from the creator template. Source
      // decides the template, so editing the creator pitch and pressing
      // Redraft cannot overwrite a customer's message with "we found your
      // channel through a search".
      {
        const mixed = { ...base,
          // The Template chip is offered only once the creator template's
          // columns exist, so the program row carries them.
          affiliate_programs: [{ ...base.affiliate_programs[0], outreach_subject: null, outreach_body: null }],
          affiliate_prospects: [
            tables.affiliate_prospects[0],
            { id: 'p-cust', company_entity_id: CO, program_id: PROG, display_name: 'Lou Loyal', platform: 'other', handle: null, profile_url: null, contact_email: 'loyal@buyer.invalid', source: 'customer', status: 'approved', collected_at: now, evidence: { order_count: 9, found_via: 'your own customers' } },
          ],
          affiliate_outreach_drafts: [
            { id: 'd-creator', company_entity_id: CO, program_id: PROG, prospect_id: 'p1', state: 'draft', channel: 'dm', recipient_handle: '@samruns', subject: 'Hi', body: 'old creator text', created_at: now },
            { id: 'd-cust', company_entity_id: CO, program_id: PROG, prospect_id: 'p-cust', state: 'draft', channel: 'email', recipient_email: 'loyal@buyer.invalid', subject: 'Hi', body: 'old customer text', created_at: now },
          ] };
        const pg = await openCust(mixed);
        await tab(pg, 'comms');
        await pg.waitForFunction(() => !!document.getElementById('outreachBody')?.innerHTML.trim(), null, { timeout: 5000 });
        await commsChip(pg, 'template');
        await pg.click('[data-act="tpl-redraft"]');
        await pg.click('[data-act="tpl-redraft"]');   // the confirm
        await pg.waitForFunction(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'update').length >= 2, null, { timeout: 5000 });
        const ups = await pg.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'update')
          .map((q) => ({ id: (q.filters || []).find((f) => f.col === 'id')?.val, body: String(q.patch?.body || '') })));
        const cust = ups.find((u) => u.id === 'd-cust');
        const creator = ups.find((u) => u.id === 'd-creator');
        R.ok('a customer in the queue is redrafted from the CUSTOMER template', !!cust && /9 times/.test(cust.body));
        R.ok('and is never told their channel was found in a search', !!cust && !/through a search|found your/i.test(cust.body));
        R.ok('while the creator in the same queue still gets the creator pitch', !!creator && /through a search|found your/i.test(creator.body));
        await pg.close();
      }
    }

    // ── Your Customers: Find their social accounts (20261124170000) ───────
    // One press scans the slice on screen; progress is live counts and never
    // a cost; a press while one runs is impossible from the page; results
    // land in a Social column; and Add to outreach carries what was found
    // as evidence without claiming the prospect's identity column.
    {
      const SC = [
        { customer_key: 'loyal@buyer.invalid', company_entity_id: CO, name_lc: 'lou loyal', email_lc: 'loyal@buyer.invalid', order_count: 9, lifetime_spend: '1811.40', first_order_at: '2025-02-02T00:00:00Z', last_order_at: '2026-11-01T00:00:00Z', email_consent_state: 'subscribed', sms_consent_state: null, consent_checked_at: '2026-11-24T00:00:00Z' },
        { customer_key: 'quiet@buyer.invalid', company_entity_id: CO, name_lc: 'quin quiet', email_lc: 'quiet@buyer.invalid', order_count: 4, lifetime_spend: '402.00', first_order_at: '2025-03-03T00:00:00Z', last_order_at: '2026-10-01T00:00:00Z', email_consent_state: null, sms_consent_state: null, consent_checked_at: null },
        { customer_key: 'check@buyer.invalid', company_entity_id: CO, name_lc: 'cy check', email_lc: 'check@buyer.invalid', order_count: 3, lifetime_spend: '190.00', first_order_at: '2025-04-04T00:00:00Z', last_order_at: '2026-09-01T00:00:00Z', email_consent_state: null, sms_consent_state: null, consent_checked_at: null },
        { customer_key: 'under@buyer.invalid', company_entity_id: CO, name_lc: 'una under', email_lc: 'under@buyer.invalid', order_count: 3, lifetime_spend: '210.00', first_order_at: '2025-04-04T00:00:00Z', last_order_at: '2026-09-01T00:00:00Z', email_consent_state: null, sms_consent_state: null, consent_checked_at: null },
      ];
      const SOCIAL = [{ id: 'cs2', company_entity_id: CO, program_id: null, customer_key: 'under@buyer.invalid', status: 'below', match_basis: 'name_only', match_score: 40, platform: 'instagram', handle: '@una', profile_url: 'https://www.instagram.com/una', followers: 312, followers_approx: false, followers_quote: '312 Followers', source_url: 'https://www.instagram.com/una', checked_at: now },
        { id: 'cs1', company_entity_id: CO, program_id: PROG, customer_key: 'loyal@buyer.invalid', scan_id: 'scan1', display_name: 'Lou Loyal', status: 'found', match_basis: 'city', match_score: 82, platform: 'instagram', handle: '@lou', profile_url: 'https://www.instagram.com/lou', followers: 1204, followers_approx: false, followers_quote: '1,204 Followers', source_url: 'https://www.instagram.com/lou', checked_at: now },
        // Over the bar, tied by the name alone: Check, never Likely.
        { id: 'cs3', company_entity_id: CO, program_id: null, customer_key: 'check@buyer.invalid', scan_id: 'scan1', display_name: 'Cy Check', status: 'found', match_basis: 'name_only', match_score: 30, platform: 'instagram', handle: '@cycheck', profile_url: 'https://www.instagram.com/cycheck', followers: 90000, followers_approx: false, followers_quote: '90K Followers', source_url: 'https://www.instagram.com/cycheck', checked_at: now }];
      const scanRow = (o) => ({ id: 'scan1', company_entity_id: CO, program_id: PROG, status: 'running', requested: 500, checked: 240, found: 6, below: 0, no_count: 0, ambiguous: 0, not_found: 0, failed: 0, min_followers: 750, error_message: null, started_at: now, heartbeat_at: now, finished_at: null, ...o });
      const fx = (scan) => ({ ...tables, company_customer_profiles: SC, affiliate_suppressions: [],
        affiliate_customer_scans: [scanRow(scan)], affiliate_customer_social: SOCIAL,
        affiliate_programs: [{ ...tables.affiliate_programs[0], customer_outreach_subject: null, customer_outreach_body: null }] });
      const openScan = async (scan) => {
        const pg = await suite.open('/v2/affiliates/index.html', fx(scan), { ready, rpc: { can_manage_affiliate_programs: true } });
        pg.on('pageerror', (e) => errors.push(`customer-scan: ${e.message}`));
        const calls = [];
        await pg.route('**/functions/v1/affiliate-research', (route) => {
          calls.push(JSON.parse(route.request().postData() || '{}'));
          return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ scan_id: 'scan2' }) });
        });
        await pg.click('#peopleSubtabs [data-k="customers"]');
        // Hunt is the landing view; these checks are about the full list.
        await pg.click('#customersBody [data-act="cust-view"][data-k="all"]');
        await pg.waitForFunction(() => /Lou Loyal/.test(document.getElementById('customersBody')?.textContent || '')
          && !!document.getElementById('custScanLine'), null, { timeout: 5000 });
        return { pg, calls };
      };

      // The tab counts agree with the list (Blake 2026-11-24: "check says 76
      // then shows 67"): a find whose customer was erased since is left out
      // of its count too, even past the first 1,000 stored answers.
      {
        const filler = Array.from({ length: 1000 }, (_, i) => ({ id: `cf${String(i).padStart(4, '0')}`, company_entity_id: CO, program_id: null, customer_key: `f${i}@buyer.invalid`, status: 'found', match_basis: 'name_only', match_score: 30, platform: 'instagram', handle: `@f${i}`, profile_url: `https://www.instagram.com/f${i}`, followers: 900, checked_at: now }));
        const gone = { id: 'cz9999', company_entity_id: CO, program_id: null, customer_key: 'gone@buyer.invalid', status: 'found', match_basis: 'name_only', match_score: 30, platform: 'instagram', handle: '@gone', profile_url: 'https://www.instagram.com/gone', followers: 5000, checked_at: now };
        const goneProfile = { ...SC[2], customer_key: 'gone@buyer.invalid', email_lc: 'gone@buyer.invalid', name_lc: 'gus gone', email_consent_state: 'redacted' };
        const pg = await suite.open('/v2/affiliates/index.html', { ...fx({ status: 'done', finished_at: now }), company_customer_profiles: [...SC, goneProfile], affiliate_customer_social: [...SOCIAL, ...filler, gone] }, { ready, rpc: { can_manage_affiliate_programs: true } });
        pg.on('pageerror', (e) => errors.push(`customer-hunt-counts: ${e.message}`));
        await pg.click('#peopleSubtabs [data-k="customers"]');
        await pg.waitForFunction(() => !!document.querySelector('#customersBody [data-act="cust-hunt-tier"][data-k="check"]'), null, { timeout: 5000 }).catch(() => {});
        R.has(await text(pg, '#customersBody [data-act="cust-hunt-tier"][data-k="check"]'), '1,001', 'Check counts what its list can show: an erased customer past the first page is left out');
        await pg.close();
      }

      // Hunt, the landing view (Blake 2026-11-24): a live module while it
      // runs, then only the people it brought back, never the whole list.
      {
        const pg = await suite.open('/v2/affiliates/index.html', fx({ filters: { want: 25 } }), { ready, rpc: { can_manage_affiliate_programs: true } });
        pg.on('pageerror', (e) => errors.push(`customer-hunt: ${e.message}`));
        await pg.click('#peopleSubtabs [data-k="customers"]');
        await pg.waitForFunction(() => !!document.getElementById('custHuntLive') && /Lou Loyal/.test(document.getElementById('customersBody')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
        R.ok('Hunt is what opens', await pg.evaluate(() => document.querySelector('#customersBody [data-act="cust-view"][data-k="hunt"]')?.classList.contains('bcn-tab--active') === true));
        const live = await text(pg, '#custHuntLive');
        R.has(live, 'Found 6 of 25 · 240 checked', 'a running hunt counts finds against what was asked for');
        R.has(live, 'Just checked: Lou Loyal', 'and the last people it checked, so it visibly moves');
        R.eq(await pg.evaluate(() => document.querySelector('#custHuntLive .af-hunt-meter i')?.style.width), '24%', 'with a bar that fills as finds come back');
        R.ok('never a cost', !/\$|cost|spend|budget|credit/i.test(live));
        R.ok('and no second press while it runs', await pg.evaluate(() => document.querySelector('#customersBody [data-act="cust-scan"]')?.disabled === true));
        const shown = await text(pg, '#customersBody table');
        R.ok('only the Likely finds over the bar come back, never the whole customer list', /Lou Loyal/.test(shown) && !/Quin Quiet/.test(shown) && !/Una Under/.test(shown));
        R.ok('a name-only find over the bar is not with the Likely ones', !/Cy Check/.test(shown));
        R.has(shown, 'Likely 82', 'each find shows its match score');
        // The list's own read (not the hidden-count read, which also names
        // the erased state) carries the consent filter.
        const pq = await pg.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'company_customer_profiles' && /email_consent_state\.not\.in/.test(JSON.stringify(q.filters || []))).pop());
        R.ok('only a find who has since been erased drops out', /redacted/.test(JSON.stringify(pq?.filters || null)) && !/unsubscribed/.test(JSON.stringify(pq?.filters || null)));
        await pg.click('#customersBody [data-act="cust-hunt-tier"][data-k="more"]');
        await pg.waitForFunction(() => /Una Under/.test(document.getElementById('customersBody')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
        const more = await text(pg, '#customersBody table');
        R.ok('"Under the bar" holds the smaller accounts', /Una Under/.test(more) && !/Lou Loyal/.test(more));
        await pg.click('#customersBody [data-act="cust-hunt-tier"][data-k="check"]');
        await pg.waitForFunction(() => /Cy Check/.test(document.getElementById('customersBody')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
        const chk = await text(pg, '#customersBody table');
        R.ok('"Check" holds the finds over the bar the score is not sure of', /Cy Check/.test(chk) && !/Lou Loyal/.test(chk) && !/Una Under/.test(chk));
        R.has(chk, 'Check 30', 'with their score');
        await pg.close();
      }

      // A scan already running: its progress, no second press, and it keeps
      // refreshing on its own.
      {
        const { pg } = await openScan({});
        R.has(await text(pg, '#custScanLine'), 'Scanning… 240 of 500 checked · 6 found', 'a running scan shows live counts');
        R.ok('the scan bar never shows a cost', !/\$|cost|spend|budget|credit/i.test(await text(pg, '.af-cust-scan')));
        const reads0 = await pg.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_customer_scans').length);
        await pg.waitForFunction((n) => window.__QUERIES__.filter((q) => q.table === 'affiliate_customer_scans').length > n, reads0, { timeout: 7000 }).catch(() => {});
        R.ok('progress refreshes by itself while the scan runs', await pg.evaluate((n) => window.__QUERIES__.filter((q) => q.table === 'affiliate_customer_scans').length > n, reads0));
        const lou = await pg.evaluate(() => [...document.querySelectorAll('#customersBody tbody tr')].map((tr) => tr.innerHTML).find((h) => /Lou Loyal/.test(h)) || '');
        R.has(lou, '@lou · 1.2K', 'a found account shows its handle and stated followers');
        R.has(lou, 'href="https://www.instagram.com/lou"', 'linked to the profile');
        R.has(lou, 'Likely 82', 'a find with a Likely score says so, with the score');
        const cy = await pg.evaluate(() => [...document.querySelectorAll('#customersBody tbody tr')].map((tr) => tr.innerHTML).find((h) => /Cy Check/.test(h)) || '');
        R.has(cy, 'Check 30', 'a find tied to them by name alone says Check, to be looked at');
        R.ok('and is not shown as likely', !/Likely/.test(cy));
        R.has(lou, 'data-act="cust-social-reject"', 'a manager can mark it "Not them"');
        const quin = await pg.evaluate(() => [...document.querySelectorAll('#customersBody tbody tr')].map((tr) => tr.textContent || '').find((t) => /Quin Quiet/.test(t)) || '');
        R.ok('a customer not yet scanned shows a dash, not "none found"', /—/.test(quin) && !/None found/.test(quin));
        await pg.close();
      }

      // A finished scan: press again and the function gets the slice on screen.
      {
        const { pg, calls } = await openScan({ status: 'done', checked: 500, found: 12, finished_at: now });
        R.has(await text(pg, '#custScanLine'), 'Last scan: 500 of 500 checked · 12 found.', 'a finished scan says what it found');
        R.ok('the full list has no second Hunt button', await pg.evaluate(() => !document.querySelector('#customersBody [data-act="cust-scan"]')));
        await pg.click('#customersBody [data-act="cust-view"][data-k="hunt"]');
        await pg.waitForSelector('#custScanTerms', { timeout: 5000 }).catch(() => {});
        await pg.fill('#custScanTerms', 'MLB, baseball').catch(() => {});
        await pg.click('#customersBody [data-act="cust-scan"]');
        await pg.waitForFunction(() => /Searching/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
        const call = calls.find((c) => c.action === 'customer_scan');
        R.eq(call?.terms, 'MLB, baseball', 'the Niche words box rides on the press, to be saved as the company\'s words');
        R.ok('the press calls the scan', !!call);
        R.eq([call?.finds, call?.filters?.minOrders, call?.filters?.consent, call?.filters?.sort], [25, 3, 'any', 'orders'], 'with the finds wanted and the slice the person is looking at');
        R.ok('never a company id from the page', !('company_entity_id' in (call || {})));
        R.ok('and no program: the scan is the company\'s, the program is chosen at Add to outreach', !!call && !('program_id' in call));
        const progFilter = (t) => window.__QUERIES__.filter((q) => q.table === t).some((q) => (q.filters || []).some((f) => f.col === 'program_id'));
        R.ok('the scan progress is read for the company, not one program', await pg.evaluate(progFilter, 'affiliate_customer_scans') === false
          && await pg.evaluate((t) => window.__QUERIES__.some((q) => q.table === t), 'affiliate_customer_scans'));
        R.ok('and so are the finds', await pg.evaluate(progFilter, 'affiliate_customer_social') === false
          && await pg.evaluate((t) => window.__QUERIES__.some((q) => q.table === t), 'affiliate_customer_social'));
        await pg.waitForFunction(() => !!document.getElementById('custHuntLive'), null, { timeout: 5000 }).catch(() => {});
        R.has(await text(pg, '#custHuntLive'), 'Searching your customers', 'and the live module shows at once');

        // Unsubscribed is a view like any other: they are found too.
        await pg.selectOption('#custConsent', 'unsubscribed');
        await pg.waitForFunction(() => !!document.getElementById('custScanLine'), null, { timeout: 5000 }).catch(() => {});
        R.ok('an unsubscribed view is never told nobody can be looked up', !/never looked up/.test(await text(pg, '#customersBody')));
        await pg.selectOption('#custConsent', 'any');
        await pg.waitForFunction(() => /Lou Loyal/.test(document.getElementById('customersBody')?.textContent || ''), null, { timeout: 5000 });
        await pg.click('#customersBody [data-act="cust-view"][data-k="all"]');
        await pg.waitForFunction(() => !!document.getElementById('custSocial'), null, { timeout: 5000 });

        // Found accounts only: a filter on the list, by this program's finds.
        const inBefore = await pg.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'company_customer_profiles' && (q.filters || []).some((f) => f.op === 'in')).length);
        await pg.selectOption('#custSocial', 'found');
        await pg.waitForFunction((n) => window.__QUERIES__.filter((q) => q.table === 'company_customer_profiles' && (q.filters || []).some((f) => f.op === 'in' && f.col === 'customer_key')).length > n, inBefore, { timeout: 5000 }).catch(() => {});
        const inq = await pg.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'company_customer_profiles' && (q.filters || []).some((f) => f.op === 'in')).pop());
        R.ok('"Found accounts only" narrows the list to who was found', (inq?.filters || []).some((f) => f.op === 'in' && (f.vals || []).includes('loyal@buyer.invalid') && !(f.vals || []).includes('quiet@buyer.invalid')));
        R.ok('including an account under the bar, as the list shows it', (inq?.filters || []).some((f) => f.op === 'in' && (f.vals || []).includes('under@buyer.invalid')));
        await pg.selectOption('#custSocial', 'any');
        await pg.waitForFunction(() => /Quin Quiet/.test(document.getElementById('customersBody')?.textContent || ''), null, { timeout: 5000 });

        // "Not them" goes through the database's own gate, by row id.
        await pg.click('#customersBody [data-act="cust-social-reject"]');
        await pg.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'rpc:affiliate_customer_social_reject'), null, { timeout: 5000 }).catch(() => {});
        const rej = await pg.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'rpc:affiliate_customer_social_reject').pop());
        R.eq(rej?.args, { p_id: 'cs1' }, '"Not them" marks that one find, by id');

        // Add to outreach carries the find as evidence, not as the identity.
        await pg.click('#customersBody [data-act="cust-pick"][data-k="loyal@buyer.invalid"]');
        await pg.click('#customersBody [data-act="cust-add"]');
        await pg.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_prospects' && q._op === 'insert'), null, { timeout: 5000 }).catch(() => {});
        const pros = await pg.evaluate(() => { const q = window.__QUERIES__.filter((x) => x.table === 'affiliate_prospects' && x._op === 'insert').pop(); return Array.isArray(q?.rows) ? q.rows[0] : q?.rows; });
        R.eq(pros?.evidence?.social?.profile_url, 'https://www.instagram.com/lou', 'the found profile travels with the prospect');
        R.eq(pros?.evidence?.social?.followers, 1204, 'with the count the result stated');
        R.eq(pros?.profile_url, null, 'but not as its identity, which a Discovery prospect of the same profile would refuse');
        await pg.close();
      }

      // Show every prospect; the tag decides the path (Blake 2026-11-24):
      // an unsubscribed customer is listed, tagged, and reached by DM only.
      {
        const unsub = { ...SC[0], customer_key: 'opt@buyer.invalid', email_lc: 'opt@buyer.invalid', name_lc: 'ola optout', email_consent_state: 'unsubscribed' };
        const unsubFind = { ...SOCIAL[1], id: 'cs9', customer_key: 'opt@buyer.invalid', display_name: 'Ola Optout', handle: '@ola', profile_url: 'https://www.instagram.com/ola', source_url: 'https://www.instagram.com/ola', match_score: 90 };
        const pg = await suite.open('/v2/affiliates/index.html', { ...fx({ status: 'done', finished_at: now }), company_customer_profiles: [...SC, unsub], affiliate_customer_social: [...SOCIAL, unsubFind] }, { ready, rpc: { can_manage_affiliate_programs: true } });
        pg.on('pageerror', (e) => errors.push(`customer-unsub: ${e.message}`));
        await pg.click('#peopleSubtabs [data-k="customers"]');
        await pg.waitForFunction(() => /Ola Optout/.test(document.getElementById('customersBody')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
        const shown = await text(pg, '#customersBody table');
        R.ok('an unsubscribed customer who was found is listed', /Ola Optout/.test(shown));
        R.ok('tagged unsubscribed, DM only', /unsubscribed\s*DM only/i.test(shown));
        await pg.click('#customersBody [data-act="cust-pick"][data-k="opt@buyer.invalid"]').catch(() => {});
        await pg.click('#customersBody [data-act="cust-add"]').catch(() => {});
        await pg.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'insert'), null, { timeout: 5000 }).catch(() => {});
        const dr = await pg.evaluate(() => { const q = window.__QUERIES__.filter((x) => x.table === 'affiliate_outreach_drafts' && x._op === 'insert').pop(); return Array.isArray(q?.rows) ? q.rows[0] : q?.rows; });
        R.eq(dr?.channel, 'dm', 'their message is a DM to send by hand');
        R.eq(dr?.recipient_email ?? null, null, 'and never an email');
        R.eq(dr?.recipient_handle, 'https://www.instagram.com/ola', 'to the account Find matched');
        // Consent is re-read at the press: somebody a sync turned
        // unsubscribed after the list loaded still gets a DM, never email.
        // Let the reload after the first Add land first, so the list holds
        // the OLD consent when it flips.
        await pg.waitForFunction(() => /Approve them on Outreach/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
        await pg.waitForTimeout(800);
        // A NEW row object: the fake may hand the page the same objects, and
        // editing one in place would change the page's snapshot too.
        await pg.evaluate(() => { const t = window.__FIXTURE_TABLES__.company_customer_profiles; const i = t.findIndex((r) => r.customer_key === 'loyal@buyer.invalid'); t[i] = { ...t[i], email_consent_state: 'unsubscribed' }; });
        const before = await pg.evaluate(() => window.__QUERIES__.filter((x) => x.table === 'affiliate_outreach_drafts' && x._op === 'insert').length);
        await pg.waitForSelector('#customersBody [data-act="cust-pick"][data-k="loyal@buyer.invalid"]', { timeout: 5000 }).catch(() => {});
        await pg.click('#customersBody [data-act="cust-pick"][data-k="loyal@buyer.invalid"]').catch(() => {});
        await pg.click('#customersBody [data-act="cust-add"]').catch(() => {});
        await pg.waitForFunction((n) => window.__QUERIES__.filter((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'insert').length > n, before, { timeout: 5000 }).catch(() => {});
        const dr2 = await pg.evaluate(() => { const q = window.__QUERIES__.filter((x) => x.table === 'affiliate_outreach_drafts' && x._op === 'insert').pop(); return Array.isArray(q?.rows) ? q.rows[0] : q?.rows; });
        R.ok('unsubscribed since the list loaded: a DM, never an email', dr2?.channel === 'dm' && !dr2?.recipient_email && dr2?.recipient_handle === 'https://www.instagram.com/lou');
        await pg.close();
      }
    }

    // People sit above programs (Blake 2026-11-24: "people is above
    // programs"). Discovery lists everybody found, in any program, once each,
    // with a line per program; the picker is hidden; a button works in the
    // program of its own row; Add pushes somebody into another program.
    {
      const PROGB = '66666666-6666-4666-8666-666666666666';
      const other = (id, o) => ({ ...tables.affiliate_prospects[0], id, program_id: PROGB, customer_match_status: 'unknown', customer_match_score: null, customer_match_basis: null, ...o });
      const pool = {
        ...tables,
        affiliate_programs: [...tables.affiliate_programs, { ...tables.affiliate_programs[0], id: PROGB, name: 'Beta', slug: 'beta', niche: 'beta niche',
          outreach_subject: 'Beta pitch for {name}', outreach_body: 'Beta body {signup_link}' }],
        affiliate_prospects: [...tables.affiliate_prospects,
          other('pb1', { display_name: 'Pat Pool', handle: '@patpool', profile_url: 'https://www.youtube.com/@patpool', status: 'signed_up', source_id: 'sB', reviewed_by: 'someone', affiliate_id: 'affB' }),
          // The same person as this program's own Sam Runs: one card, two lines.
          other('pb2', { display_name: 'Sam Runs again' }),
          // Do not contact: listed, never offered to another program.
          other('pb3', { display_name: 'Dee Nope', handle: '@nope', profile_url: 'https://www.youtube.com/@nope', status: 'suppressed' }),
          // Found for Beta and waiting for review.
          // On the do-not-contact list by address only; their row says new.
          other('pb5', { display_name: 'Sue Listed', handle: '@suelisted', profile_url: 'https://www.youtube.com/@suelisted', contact_email: 'sue@listed.invalid', status: 'new' }),
          other('pb4', { display_name: 'Nia New', handle: '@nianew', profile_url: 'https://www.youtube.com/@nianew', contact_email: 'nia@creator.invalid', status: 'new', source: 'ai_research' })],
        // The same affiliate in Beta too: one person, two memberships.
        affiliates: [...tables.affiliates, { ...tables.affiliates[0], id: 'affB2', program_id: PROGB }],
        affiliate_suppressions: [...(tables.affiliate_suppressions || []), { id: 'sup-sue', company_entity_id: CO, kind: 'email', value_normalized: 'sue@listed.invalid', reason: 'opted_out', created_at: now }],
        affiliate_outreach_drafts: [{ id: 'dB', company_entity_id: CO, program_id: PROG, prospect_id: 'p1', channel: 'email', recipient_email: 'sam@only.invalid', subject: 'First program only draft', body: 'x', state: 'draft', created_at: now }],
      };
      const pg = await suite.open('/v2/affiliates/index.html', pool, { ready, rpc: { can_manage_affiliate_programs: true } });
      pg.on('pageerror', (e) => errors.push(`people-pool: ${e.message}`));
      await toDiscovery(pg);
      R.ok('the program picker is hidden on People', await pg.evaluate(() => document.getElementById('programSel')?.hidden === true));
      await pg.click('#prospectsBody [data-act="prospect-filter"][data-f="all"]');
      await pg.waitForFunction(() => /Pat Pool/.test(document.getElementById('prospectsBody')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
      const shown = await text(pg, '#prospectsBody');
      R.ok('Discovery lists creators found for another program', /Pat Pool/.test(shown) && /Nia New/.test(shown));
      const samCards = await pg.$$eval('#prospectsBody .af-item--catalog', (els) => els.filter((e) => /Sam Runs/.test(e.querySelector('.af-catalog-name')?.textContent || '')));
      R.eq(samCards.length, 1, 'somebody in two programs is one card');
      const samCard = await pg.$$eval('#prospectsBody .af-item--catalog', (els) => (els.find((e) => /Sam Runs/.test(e.querySelector('.af-catalog-name')?.textContent || ''))?.textContent || ''));
      R.ok('with a line for each program they are in', samCard.includes(tables.affiliate_programs[0].name) && samCard.includes('Beta'));
      R.ok('do not contact is listed but never offered to another program', /Dee Nope/.test(shown) && !(await pg.$('#prospectsBody [data-act="prospect-assign"][data-id="pb3"]')));
      R.ok('somebody on the list by address alone is not offered to another program', /Sue Listed/.test(shown) && !(await pg.$('#prospectsBody [data-act="prospect-assign"][data-id="pb5"]')));
      R.ok('People reads the do-not-contact list in pages', await pg.evaluate(() => window.__QUERIES__.some((q) => q.table === 'affiliate_suppressions' && q.range)));
      if (process.env.PEOPLE_SHOT) { await pg.setViewportSize({ width: 1280, height: 1100 }); await (await pg.$('#prospectsBody')).screenshot({ path: process.env.PEOPLE_SHOT }); }
      // Affiliates: one card per person, a block for each program.
      await pg.click('#peopleSubtabs [data-k="affiliates"]');
      await pg.waitForSelector('#affiliatesBody .af-item--catalog', { timeout: 5000 }).catch(() => {});
      const affName = tables.affiliates[0].display_name;
      const affCards = await pg.$$eval('#affiliatesBody .af-item--catalog', (els, n) => els.filter((e) => (e.querySelector('.af-catalog-name')?.textContent || '').trim() === n).map((e) => e.textContent), affName);
      R.ok('an affiliate in two programs is one card with both programs', affCards.length === 1 && affCards[0].includes('Beta') && affCards[0].includes(tables.affiliate_programs[0].name));
      if (process.env.PEOPLE_SHOT) await (await pg.$('#affiliatesBody')).screenshot({ path: process.env.PEOPLE_SHOT.replace('.png', '-aff.png') });
      await pg.click('#peopleSubtabs [data-k="discovery"]');
      // Shortlisting a Beta creator in bulk files their message under Beta,
      // in Beta's own words, whatever program the page last used.
      await pg.click('#prospectsBody [data-act="prospect-filter"][data-f="new"]');
      await pg.waitForSelector('#prospectsBody [data-act="prospect-pick"][data-id="pb4"]', { timeout: 5000 }).catch(() => {});
      // Two people from two programs, the other program's ticked last.
      await pg.click('#prospectsBody [data-act="prospect-pick"][data-id="pb4"]').catch(() => {});
      await pg.click('#prospectsBody [data-act="prospect-pick"][data-id="p-nobuy"]').catch(() => {});
      await pg.click('#prospectsBody [data-act="prospect-bulk"][data-s="approved"]').catch(() => {});
      await pg.waitForFunction(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_outreach_drafts' && q._op === 'insert').length >= 2, null, { timeout: 5000 }).catch(() => {});
      const drs = await pg.evaluate(() => window.__QUERIES__.filter((x) => x.table === 'affiliate_outreach_drafts' && x._op === 'insert').map((q) => (Array.isArray(q?.rows) ? q.rows[0] : q?.rows)));
      const dr = drs.find((x) => x?.prospect_id === 'pb4');
      const drA = drs.find((x) => x?.prospect_id === 'p-nobuy');
      R.eq(dr?.program_id, PROGB, 'a Beta creator\'s message is filed under Beta');
      R.ok('and written from Beta\'s own message', /^Beta pitch for Nia New/.test(dr?.subject || ''));
      R.eq(drA?.program_id, PROG, 'and the other program\'s creator under theirs, in the same press');
      // Find creators has no program picker: one list (Blake 2026-11-24).
      await pg.waitForSelector('#prospectsBody [data-act="research-run"]', { timeout: 5000 }).catch(() => {});
      R.ok('Find creators shows no program picker', !(await pg.$('#prospectsBody [aria-label="Find for"]')) && !(await pg.$('#prospectsBody [data-act="find-pg"]')));
      const nBefore = researchCalls.filter((c) => c.action === 'research').length;
      await pg.click('#prospectsBody [data-act="research-run"]').catch(() => {});
      await pg.waitForFunction(() => /Research started/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
      const rcB = researchCalls.filter((c) => c.action === 'research').slice(nBefore);
      R.ok('Find creators still runs', rcB.length === 1 && [PROG, PROGB].includes(rcB[0].program_id));
      // Add to: their own row in the other program, shortlisted, without that
      // program's decisions or search.
      await pg.click('#prospectsBody [data-act="prospect-filter"][data-f="all"]');
      await pg.waitForSelector('#prospectsBody [data-act="prospect-assign"][data-id="pb1"]', { timeout: 5000 }).catch(() => {});
      const nIns = await pg.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'affiliate_prospects' && q._op === 'insert').length);
      await pg.click('#prospectsBody [data-act="prospect-assign"][data-id="pb1"]').catch(() => {});
      await pg.waitForFunction((n) => window.__QUERIES__.filter((q) => q.table === 'affiliate_prospects' && q._op === 'insert').length > n, nIns, { timeout: 5000 }).catch(() => {});
      const ins = await pg.evaluate(() => { const q = window.__QUERIES__.filter((x) => x.table === 'affiliate_prospects' && x._op === 'insert').pop(); return Array.isArray(q?.rows) ? q.rows[0] : q?.rows; });
      R.ok('Add makes their own row in that program, shortlisted', ins?.program_id === PROG && ins?.status === 'approved' && ins?.profile_url === 'https://www.youtube.com/@patpool');
      R.ok('without the other program\'s decisions or search', ins && !('affiliate_id' in ins) && !('source_id' in ins) && ins.reviewed_by !== 'someone');
      // Off People, the picker is back and the tab is one program again.
      await pg.click('#tabs [data-tab="comms"]').catch(() => {});
      await pg.waitForFunction(() => document.getElementById('programSel')?.hidden === false, null, { timeout: 5000 }).catch(() => {});
      R.ok('the picker is back on a program tab', await pg.evaluate(() => document.getElementById('programSel')?.hidden === false));
      // People read every page of prospects, not one capped read.
      R.ok('People reads the prospects in pages', await pg.evaluate(() => window.__QUERIES__.some((q) => q.table === 'affiliate_prospects' && q.range && !q.filters.some((f) => f.col === 'program_id'))));
      // Two tab changes in a row: the slow company-wide People read must not
      // land after the Outreach read and put Beta's draft on this program's tab.
      await pg.evaluate(() => {
        window.__RELEASE_PEOPLE__ = null;
        const held = new Promise((r) => { window.__RELEASE_PEOPLE__ = r; });
        window.__HOLD_READ__ = (q) => (q.table === 'affiliate_outreach_drafts' && !q.filters.some((f) => f.col === 'program_id') ? held : null);
      });
      await pg.click('#tabs [data-tab="people"]').catch(() => {});
      await pg.waitForTimeout(200);
      await pg.click('#tabs [data-tab="comms"]').catch(() => {});
      await pg.waitForTimeout(800);
      await pg.evaluate(() => { window.__HOLD_READ__ = null; window.__RELEASE_PEOPLE__(); });
      await pg.waitForTimeout(1500);
      await pg.click('#tabs [data-tab="comms"]').catch(() => {});
      // The last button pressed on People was in Beta, so Outreach is Beta's.
      R.eq(await pg.evaluate(() => document.getElementById('programSel')?.value), PROGB, 'Outreach opens on the program last worked in');
      R.ok('a slower People read never lands on a program tab', !/First program only draft|sam@only/.test(await text(pg, '#outreachBody')));
      await pg.close();
      // A do-not-contact list that could not be read in full offers nobody
      // to another program.
      const nosup = await suite.open('/v2/affiliates/index.html', pool, { ready, rpc: { can_manage_affiliate_programs: true }, broken: ['affiliate_suppressions'] });
      await toDiscovery(nosup);
      await nosup.click('#prospectsBody [data-act="prospect-filter"][data-f="all"]').catch(() => {});
      await nosup.waitForFunction(() => /Pat Pool/.test(document.getElementById('prospectsBody')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
      R.ok('an unread do-not-contact list offers nobody to another program', !(await nosup.$('#prospectsBody [data-act="prospect-assign"]')));
      await nosup.close();
    }

    R.eq(errors, [], 'no page errors on any affiliate page');
    R.ok('the whole flow ran to the end', true);
  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
