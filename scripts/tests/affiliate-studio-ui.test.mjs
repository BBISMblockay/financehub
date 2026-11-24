// The DOM-free logic behind the Affiliate Studio pages (v2/affiliates/studio-core.js):
// money in minor units, the program form, CSV exports and their fingerprints,
// and the "how each part works" labels.
//
// Mutations (CI runs each and requires a failure):
//   AFFILIATE_CORE_MUTATION=formula   spreadsheet formula cells are not neutralised
//   AFFILIATE_CORE_MUTATION=zerodec   zero-decimal currencies are treated as two-decimal
//   AFFILIATE_CORE_MUTATION=rounding  extra decimals are rounded instead of refused
//   AFFILIATE_CORE_MUTATION=href      any URL scheme becomes a link
//   AFFILIATE_CORE_MUTATION=retiredlive a cancelled code counts as set up
//   AFFILIATE_CORE_MUTATION=runstatus a real Find creators run (recorded 'ok') leaves Discovery unconfigured
//   AFFILIATE_CORE_MUTATION=unhide    a photo the rep removed comes back as the one found for them
//   AFFILIATE_CORE_MUTATION=nolinkok  an outreach message without {signup_link} is accepted
//   AFFILIATE_CORE_MUTATION=pindefault SILO's own message is saved as the program's, freezing it
//   AFFILIATE_CORE_MUTATION=imgshrink  a card asks the CDN for a SMALLER image than it already had
//   AFFILIATE_CORE_MUTATION=imganyhost a width parameter is forced onto any host's address
//   AFFILIATE_CORE_MUTATION=codeclash  a suggested code repeats one already taken
//   AFFILIATE_CORE_MUTATION=badgeall   a prospect with no match still gets a past-customer badge
//   AFFILIATE_CORE_MUTATION=consentgate  an unmeasured consent state is treated as a state comparison
//   AFFILIATE_CORE_MUTATION=consentblank a blank consent state reads as not subscribed
//   AFFILIATE_CORE_MUTATION=windowend    the last-order window ends ON the chosen day, dropping that day
//   AFFILIATE_CORE_MUTATION=minfree      the minimum-orders box is trusted as typed
//   AFFILIATE_CORE_MUTATION=supdomain    a suppressed domain stops covering its subdomains
//   AFFILIATE_CORE_MUTATION=supcase      a do-not-contact address is matched with case
//   AFFILIATE_CORE_MUTATION=custnolink   a customer message without {signup_link} is accepted
//   AFFILIATE_CORE_MUTATION=custpin      SILO's own customer message is saved as the program's
//   AFFILIATE_CORE_MUTATION=socialzero   a social row with no stated count shows 0 followers
//   AFFILIATE_CORE_MUTATION=socialhref   a social profile_url of any scheme becomes a link
//   AFFILIATE_CORE_MUTATION=basispromote a find with no recorded basis is shown as likely
//   AFFILIATE_CORE_MUTATION=deadlock     a run that died partway still reads as running, locking Find
//   AFFILIATE_CORE_MUTATION=termsreaderr  a failed read of the company's words becomes an empty box (and a press clears them)
//   AFFILIATE_CORE_MUTATION=unsubmail    an unsubscribed customer is given the email path
//   AFFILIATE_CORE_MUTATION=poolsupp     somebody do-not-contact in one program is offered to the others
//   AFFILIATE_CORE_MUTATION=noemaildm    a customer with no email can be given a DM path
//   AFFILIATE_CORE_MUTATION=dmsupp       a do-not-contact handle can still be DMed
//   AFFILIATE_CORE_MUTATION=counthidden  the Find tab counts include customers the list hides
//   AFFILIATE_CORE_MUTATION=socialident  a found profile is written to the prospect's own profile_url
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MUT = process.env.AFFILIATE_CORE_MUTATION || '';
const MUTS = {
  formula: ["if (/^[=+\\-@\\t\\r]/.test(s)) s = `'${s}`;", ''],
  zerodec: ["export const minorUnits = (currency) => (ZERO_DECIMAL.has(String(currency || '').toUpperCase()) ? 1 : 100);", 'export const minorUnits = () => 100;'],
  href: ["return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : null;", 'return x.toString();'],
  retiredlive: ["(codes || []).filter((c) => c?.status === 'active').length", "(codes || []).filter((c) => c?.status !== 'pending').length"],
  runstatus: ["(r.status === 'ok' || r.status === 'success')", "r.status === 'success'"],
  unhide: ["  if (affiliate?.photo_hidden === true) return null;\n", ''],
  nolinkok: ["    if (row.outreach_body && !row.outreach_body.includes('{signup_link}')) errors.push(", "    if (false) errors.push("],
  imgshrink: ["  if (!Number.isFinite(w) || w <= 0 || w >= px) return url;", '  if (!Number.isFinite(w) || w <= 0) return url;'],
  imganyhost: ["  if (!WIDTH_PARAM_HOSTS.has(u.hostname)) return url;", ''],
  badgeall: ["  if (!['possible', 'likely', 'confirmed'].includes(st)) return null;", '  if (false) return null;'],
  codeclash: ["  if (!used.has(base)) return base;", '  return base;'],
  pindefault: ["row.outreach_body = body === '' || body === DEFAULT_OUTREACH.body ? null : body;", "row.outreach_body = body === '' ? null : body;"],
  rounding: ["const re = units === 1 ? /^-?\\d+$/ : /^-?\\d+(\\.\\d{1,2})?$/;", 'const re = /^-?\\d+(\\.\\d+)?$/;'],
  consentgate: ["    consentIsNull: consent === 'unmeasured',\n    consentState: consent === 'any' || consent === 'unmeasured' ? null : consent,",
    "    consentIsNull: false,\n    consentState: consent === 'any' ? null : consent,"],
  consentblank: ["    return { label: 'not checked yet', tone: '', measured: false };", "    return { label: 'not subscribed', tone: '', measured: true };"],
  windowend: ['toExclusive: to ? dayShift(to, -1) : null,', 'toExclusive: to || null,'],
  minfree: ["  const minOrders = Number.isFinite(minRaw)\n    ? Math.max(1, Math.min(CUSTOMER_MIN_ORDERS_MAX, Math.trunc(minRaw)))\n    : 1;", '  const minOrders = minRaw;'],
  supdomain: ['if (d && (domain === d || domain.endsWith(`.${d}`))) return true;', 'if (d && domain === d) return true;'],
  supcase: ["  const e = String(email || '').trim().toLowerCase();", "  const e = String(email || '').trim();"],
  custnolink: ["  if (row.customer_outreach_body && !row.customer_outreach_body.includes('{signup_link}')) errors.push('Keep {signup_link} in the customer message: it is how they join.');", '  if (false) errors.push();'],
  socialzero: ["  const count = row.followers === null || row.followers === undefined ? '' : `${compactCount(row.followers)}${row.followers_approx ? '+' : ''}`;", "  const count = `${compactCount(row.followers || 0) || '0'}`;"],
  socialhref: ["  const url = /^https?:\\/\\//i.test(String(row.profile_url || '')) ? row.profile_url : null;", '  const url = row.profile_url || null;'],
  basispromote: ["  const basis = SOCIAL_BASIS[row.match_basis] || SOCIAL_BASIS.name_only;", '  const basis = SOCIAL_BASIS[row.match_basis] || SOCIAL_BASIS.city;'],
  scorepromote: ['  return s !== null && s >= LIKELY_SCORE ? \'likely\' : \'name\';', "  return s !== null || row?.match_basis === 'city' ? 'likely' : 'name';"],
  deadlock: ['  if (!beat || nowMs - beat < SCAN_STALE_MS) return scan;', '  return scan;'],
  termsreaderr: ["  if (!res || res.error || !res.data) return null;", "  if (!res) return null;"],
  unsubmail: ["  if (email && !NO_EMAIL_CONSENT.includes(c.email_consent_state)) return", "  if (email) return"],
  poolsupp: ["    if (x.status === 'suppressed') { blocked.add(k); continue; }", ''],
  noemaildm: ["  if (!email) return null;\n", ''],
  dmsupp: ["  if (h && (suppressions || []).some((s) => s?.kind === 'handle' && bareHandle(s.value_normalized) === h)) return null;", ""],
  counthidden: ["    if (t && out[t] != null) out[t] = Math.max(0, out[t] - 1);", "    if (false) out[t] = 0;"],
  socialident: ["    profile_url: null,\n    collected_at: collectedAt,", "    profile_url: social?.profile_url || null,\n    collected_at: collectedAt,"],
  custpin: ["    customer_outreach_body: text === '' || text === DEFAULT_CUSTOMER_OUTREACH.body ? null : text,", "    customer_outreach_body: text === '' ? null : text,"],
};
if (MUT && !MUTS[MUT]) throw new Error(`unknown mutation ${MUT}`);
let src = await readFile(new URL('../../v2/affiliates/studio-core.js', import.meta.url), 'utf8');
if (MUT) { assert.ok(src.includes(MUTS[MUT][0]), `mutation ${MUT}: pattern not found`); src = src.split(MUTS[MUT][0]).join(MUTS[MUT][1]); }
const dir = await mkdtemp(join(tmpdir(), 'affcore-'));
await writeFile(join(dir, 'studio-core.mjs'), src);
const C = await import(pathToFileURL(join(dir, 'studio-core.mjs')).href);

let n = 0;
const t = async (name, fn) => { try { await fn(); console.log(`ok ${++n} - ${name}`); } catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); } };

await t('money: NULL is a dash, zero is zero, zero-decimal currencies are not divided by 100', () => {
  assert.equal(C.formatMoney(null, 'USD'), '—');
  assert.equal(C.formatMoney(undefined), '—');
  assert.equal(C.formatMoney(0, 'USD'), '$0.00');
  assert.equal(C.formatMoney(-1250, 'USD'), '-$12.50');
  assert.equal(C.formatMoney(500, 'JPY'), '¥500');
});

await t('an affiliate\'s photo: removed is none, their own beats the one found, https only', () => {
  const found = { profile_image_url: 'https://cdn.example/found.jpg' };
  assert.equal(C.affiliatePhotoUrl({}, found), 'https://cdn.example/found.jpg', 'never touched: the photo found for them');
  assert.equal(C.affiliatePhotoUrl({ photo_url: 'https://cdn.example/own.jpg' }, found), 'https://cdn.example/own.jpg');
  assert.equal(C.affiliatePhotoUrl({ photo_url: 'https://cdn.example/own.jpg', photo_hidden: true }, found), null, 'removed stays removed');
  assert.equal(C.affiliatePhotoUrl({ photo_hidden: true }, found), null);
  assert.equal(C.affiliatePhotoUrl({ photo_url: 'javascript:alert(1)' }, null), null);
  assert.equal(C.affiliatePhotoUrl(null, null), null);
});

await t('outreach message: SILO\'s own is stored blank, a custom one must keep {signup_link}', () => {
  const base = { name: 'Creators', slug: 'creators', commission_kind: 'percent_of_net', commission_percent: '10', currency: 'USD' };
  const same = C.validateProgram({ ...base, outreach_subject: C.DEFAULT_OUTREACH.subject, outreach_body: C.DEFAULT_OUTREACH.body.replace(/\n/g, '\r\n') });
  assert.deepEqual([same.row.outreach_subject, same.row.outreach_body, same.errors], [null, null, []], 'unchanged: blank, so it follows SILO\'s wording');
  const own = C.validateProgram({ ...base, outreach_subject: ' Hey {name} ', outreach_body: 'Come join {brand}: {signup_link}' });
  assert.deepEqual([own.row.outreach_subject, own.row.outreach_body, own.errors], ['Hey {name}', 'Come join {brand}: {signup_link}', []]);
  assert.match(C.validateProgram({ ...base, outreach_body: 'No link here' }).errors.join(' '), /\{signup_link\}/);
  assert.ok(!('outreach_body' in C.validateProgram(base).row), 'a form without the box (before the migration) sends no column');
  assert.deepEqual(C.outreachTemplate({}), C.DEFAULT_OUTREACH);
  assert.deepEqual(C.outreachTemplate({ outreach_subject: 'Hey', outreach_body: 'Join: {signup_link}' }), { subject: 'Hey', body: 'Join: {signup_link}' });
  assert.equal(C.outreachTemplate({ outreach_body: 'no link' }).body, C.DEFAULT_OUTREACH.body, 'a message that lost the link is never used');
});

await t('money input: refuses more decimals than the currency has', () => {
  assert.equal(C.parseMajorToMinor('12.5', 'USD'), 1250);
  assert.equal(C.parseMajorToMinor('-3', 'USD'), -300);
  assert.equal(C.parseMajorToMinor('1,000.01', 'USD'), 100001);
  assert.equal(C.parseMajorToMinor('', 'USD'), null);
  assert.ok(Number.isNaN(C.parseMajorToMinor('12.345', 'USD')));
  assert.equal(C.parseMajorToMinor('500', 'JPY'), 500);
  assert.ok(Number.isNaN(C.parseMajorToMinor('5.5', 'JPY')));
});

await t('program form: valid input becomes a row the CHECKs accept; invalid input says why', () => {
  const ok = { name: 'Creator Program', commission_percent: '12.5', currency: 'usd', platforms: ['youtube'], payout_minimum: '25', terms_markdown: 'x', status: 'active' };
  const { row, errors } = C.validateProgram(ok);
  assert.deepEqual(errors, []);
  assert.equal(row.slug, 'creator-program');
  assert.equal(row.currency, 'USD');
  assert.equal(row.commission_percent, 12.5);
  assert.equal(row.payout_minimum_cents, 2500);
  assert.equal(row.attribution_window_days, 0, 'no silent grace by default');
  // The payout rail (20261113050000). A form that does not carry the field
  // must not send one: that is what stops an older caller silently resetting a
  // program that pays through PayPal back to paying by hand.
  assert.equal('payout_method' in row, false, 'a form without the field sends no method');
  assert.equal(C.validateProgram({ ...ok, payout_method: 'paypal_payouts' }).row.payout_method, 'paypal_payouts');
  assert.equal(C.validateProgram({ ...ok, payout_method: 'manual' }).row.payout_method, 'manual');
  assert.equal(C.validateProgram({ ...ok, payout_method: 'stripe_connect_express' }).row.payout_method, 'manual',
    'a rail that is not built is not a choice the form can make');
  const bad = C.validateProgram({ name: '', commission_percent: '120', currency: 'dollars', attribution_window_days: '400', status: 'active' });
  assert.ok(bad.errors.length >= 4, bad.errors.join(' | '));
  assert.ok(bad.errors.some((e) => /terms/.test(e)), 'an active program needs terms');
  const fixed = C.validateProgram({ name: 'F', slug: 'fixed-one', commission_kind: 'fixed_per_order', commission_fixed: '5', currency: 'USD' });
  assert.equal(fixed.row.commission_fixed_cents, 500);
  assert.equal(fixed.row.commission_percent, null);
  // The automatic first code's % off: only sent when the form carries it.
  assert.ok(!('default_discount_percent' in fixed.row), 'a form without the field leaves the column alone');
  assert.equal(C.validateProgram({ name: 'F', slug: 'fixed-one', commission_percent: '5', default_discount_percent: '' }).row.default_discount_percent, null, 'blank turns it off');
  // Which stores count (20261117030000).
  const st = (on) => C.validateProgram({ name: 'F', slug: 'fixed-one', commission_percent: '5',
    shop_domains: [{ d: 'a.myshopify.com', on: on[0] }, { d: 'B.myshopify.com', on: on[1] }] });
  assert.equal(st([true, true]).row.shop_domains, null, 'every store ticked is stored as all stores');
  assert.deepEqual(st([false, true]).row.shop_domains, ['b.myshopify.com'], 'only the ticked store, lowercased');
  assert.ok(st([false, false]).errors.includes('Pick at least one store.'), 'no store is refused');
  assert.ok(!('shop_domains' in fixed.row), 'a form without the store picker leaves the column alone');
  // The content bonus (20261117050000): blank is none, only sent when carried.
  const cb = (v) => C.validateProgram({ name: 'F', slug: 'fixed-one', commission_percent: '5', content_bonus: v });
  assert.equal(cb('25').row.content_bonus_cents, 2500);
  assert.equal(cb('').row.content_bonus_cents, null, 'blank is no bonus');
  assert.equal(cb('0').row.content_bonus_cents, null, 'zero is no bonus');
  assert.ok(cb('-5').errors.some((e) => /Content bonus/.test(e)), 'a negative bonus is refused');
  assert.ok(!('content_bonus_cents' in fixed.row), 'a form without the field leaves the column alone');
  // A person's edit of a creator (2026-11-17).
  const pe = C.prospectEditRow({ name: '', handle: '@sam', url: '', email: ' Sam@Runs.Example ' }, { contact_email: null, platform: 'youtube' });
  assert.deepEqual([pe.display_name, pe.platform, pe.contact_email, pe.contact_source_url], ['@sam', 'youtube', 'sam@runs.example', null]);
  assert.ok(!('contact_source_url' in C.prospectEditRow({ handle: '@s', email: 'a@b.co' }, { contact_email: 'A@b.co' })), 'an unchanged email keeps where it was stated');
  assert.throws(() => C.prospectEditRow({ handle: '', url: '' }), /handle or a profile URL/);
  assert.throws(() => C.prospectEditRow({ handle: '@s', email: 'nope' }), /not valid/);
  assert.throws(() => C.prospectEditRow({ url: 'javascript:alert(1)' }), /web address/);
  // The form takes addresses the way people type them (Blake 2026-11-18,
  // affiliate_prospects_source_url_check): a bare domain gets https://.
  assert.equal(C.asWebUrl('instagram.com/sam'), 'https://instagram.com/sam');
  assert.equal(C.asWebUrl(' www.sam.co '), 'https://www.sam.co');
  assert.equal(C.asWebUrl('https://x.com/sam'), 'https://x.com/sam');
  assert.equal(C.asWebUrl(''), null);
  assert.equal(C.asWebUrl('Instagram'), undefined, 'a word is not an address');
  assert.equal(C.asWebUrl('met at a show'), undefined);
  assert.equal(C.asWebUrl('javascript:alert(1)'), undefined, 'no other scheme gets through');
  for (const ok of ['instagram.com/sam', 'www.sam.co', 'https://x.com/sam']) assert.match(C.asWebUrl(ok), /^\s*https?:\/\/\S+\s*$/i, 'every result passes the database CHECK');
  assert.equal(C.prospectEditRow({ url: 'tiktok.com/@sam' }).profile_url, 'https://tiktok.com/@sam');
  // The outreach template, saved from Comms: the same rules Setup used.
  assert.deepEqual(C.templateRow('', '').row, { outreach_subject: null, outreach_body: null }, 'blank keeps SILO wording');
  assert.ok(C.templateRow('Hi', 'no link here').errors.some((e) => /signup_link/.test(e)), 'the signup link must stay');
  assert.equal(C.templateRow('Hi', 'Join: {signup_link}').row.outreach_body, 'Join: {signup_link}');
  assert.equal(C.validateProgram({ name: 'F', slug: 'fixed-one', commission_percent: '5', default_discount_percent: '15' }).row.default_discount_percent, 15);
  for (const bad of ['0', '101', '7.5', 'x']) {
    assert.ok(C.validateProgram({ name: 'F', slug: 'fixed-one', commission_percent: '5', default_discount_percent: bad }).errors.some((e) => /% off/.test(e)), bad);
  }
});

await t('CSV: a creator name cannot become a spreadsheet formula, and quoting is RFC 4180', () => {
  assert.equal(C.csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(C.csvCell('+1'), "'+1");
  assert.equal(C.csvCell('@name'), "'@name");
  assert.equal(C.csvCell('a,b'), '"a,b"');
  assert.equal(C.csvCell(null), '');
  const csv = C.toCsv(['a', 'b'], [['1', 'line\nbreak']]);
  assert.equal(csv, 'a,b\r\n1,"line\nbreak"\r\n');
});

await t('outreach export: the signup link goes into the message; a missing one says why', () => {
  const rows = C.outreachRows([
    { id: 'd1', recipient_email: 'a@x.invalid', channel: 'email', subject: 'Hi', body: 'Join: {signup_link}' },
    { id: 'd2', recipient_handle: '@b', channel: 'dm', subject: 'Hi', body: 'Join: {signup_link}' },
  ], { d1: { url: 'https://app/join?t=abc', expires_at: '2026-11-24' }, d2: { error: 'No email address' } });
  assert.equal(rows[0][4], 'Join: https://app/join?t=abc');
  assert.equal(rows[0][5], 'https://app/join?t=abc');
  assert.match(rows[1][4], /no signup link/);
  assert.equal(rows[1][7], 'No email address');
});

await t('fingerprint: the SHA-256 of the exact file', async () => {
  assert.equal(await C.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

await t('payout handoff: amounts in major units from minor units, and a line saying SILO did not pay', () => {
  const [r] = C.payoutRows([{ id: 'p', affiliate_id: 'a', amount_cents: 123456, currency: 'USD', item_count: 3 }], { a: { display_name: 'Pat', contact_email: 'p@x.invalid' } });
  assert.equal(r[3], '1234.56');
  assert.equal(r[5], 123456);
  assert.match(r[8], /did not pay/);
  const [j] = C.payoutRows([{ id: 'p', affiliate_id: 'a', amount_cents: 5000, currency: 'JPY' }], {});
  assert.equal(j[3], '5000');
});

await t('links: https only, UTM triple applied', () => {
  assert.equal(C.linkUrl({ destination_url: 'https://shop.test/p?x=1', utm_source: 'affiliate', utm_campaign: 'spring' }), 'https://shop.test/p?x=1&utm_source=affiliate&utm_campaign=spring');
  assert.equal(C.linkUrl({ destination_url: 'http://shop.test' }), null);
  assert.equal(C.linkUrl({ destination_url: 'javascript:alert(1)' }), null);
});

await t('stored URLs become links only when they are http(s)', () => {
  assert.equal(C.safeHref(' https://youtube.com/@x '), 'https://youtube.com/@x');
  assert.equal(C.safeHref('javascript:alert(1)'), null);
  assert.equal(C.safeHref('data:text/html,hi'), null);
  assert.equal(C.safeHref(''), null);
});

await t('labels follow the data and never claim what was not observed', () => {
  const byStage = (f) => Object.fromEntries(C.stageLabels(f).map((x) => [x.stage, x.label]));
  const none = byStage({});
  assert.equal(none.Discovery, 'unconfigured');
  assert.equal(none['Outreach to prospects'], 'manual');
  assert.equal(none.Payouts, 'manual');
  assert.equal(none['Stripe Connect payouts'], undefined, 'an unbuilt feature is not listed');
  assert.equal(none['Incremental sales'], undefined, 'the card lists what SILO does, not what it does not');
  assert.equal(byStage({ discoveryRuns: [{ dry_run: true, status: 'success' }] }).Discovery, 'simulated');
  assert.equal(byStage({ discoveryRuns: [{ dry_run: false, status: 'error' }] }).Discovery, 'unconfigured');
  assert.equal(byStage({ discoveryRuns: [{ dry_run: false, status: 'success' }] }).Discovery, 'verified');
  assert.equal(byStage({ discoveryRuns: [{ dry_run: false, status: 'ok' }] }).Discovery, 'verified', 'runs are recorded ok');
  assert.equal(byStage({ codesTotal: 1 })['Code tracking'], 'waiting', 'a code no order has used yet is waiting, not unconfigured');
  assert.equal(none['Code tracking'], 'unconfigured');
  assert.equal(C.liveCodeCount([{ status: 'retired' }, { status: 'pending' }]), 0, 'a cancelled or not-yet-created code is not set up');
  assert.equal(byStage({ codesTotal: C.liveCodeCount([{ status: 'retired' }]) })['Code tracking'], 'unconfigured');
  assert.equal(C.liveCodeCount([{ status: 'active' }, { status: 'retired' }]), 1);
  assert.equal(byStage({ notifications: [{ status: 'sent' }] })['Affiliate emails'], 'verified');
  assert.equal(byStage({ codesSeen: 2 })['Code tracking'], 'verified');
});

await t('a failed search is described without the provider name or codes', () => {
  const m = C.friendlySearchError('SERP provider refused the task: 40101 Internal SE Server Error.');
  assert.ok(m && !/SERP|40101|provider|DataForSEO/i.test(m), m);
  assert.equal(C.friendlySearchError(''), '');
});

await t('beacon tabs: button tabs reset the UA chrome so they read as page tabs', async () => {
  const css = await readFile(new URL('../../v2/beacon.css', import.meta.url), 'utf8');
  assert.match(css, /\.bcn-tabs button\.bcn-tab\s*\{[\s\S]*?background:\s*none/);
  assert.match(css, /appearance:\s*none/);
});

await t('a CSV list is read with quotes, commas, CRLF and a BOM, and a broken file is refused', () => {
  const rows = C.parseCsv('\uFEFFName,URL,Followers\r\n"Smith, Jo",https://www.tiktok.com/@jo,"993.2K ""TikTok"""\r\n\r\nAl,https://www.youtube.com/@al,12\n');
  assert.deepEqual(rows, [
    { name: 'Smith, Jo', url: 'https://www.tiktok.com/@jo', followers: '993.2K "TikTok"' },
    { name: 'Al', url: 'https://www.youtube.com/@al', followers: '12' },
  ]);
  assert.deepEqual(C.parseCsv(''), []);
  assert.throws(() => C.parseCsv('a\n"open'), /unclosed quote/);
  assert.deepEqual(C.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

await t('runs, sources and followers are named in words; a missing count is not zero', () => {
  assert.equal(C.runKindLabel({ provider: 'anthropic' }), 'AI research');
  assert.equal(C.runKindLabel({ provider: 'import' }), 'list import');
  assert.equal(C.runKindLabel({ provider: 'dataforseo', dry_run: true }), 'dry run');
  assert.equal(C.sourceLabel('ai_research'), 'AI research');
  assert.equal(C.sourceLabel('csv_import'), 'your list');
  assert.equal(C.followersFrom({ followers: null }), null);
  assert.equal(C.followersFrom({}), null);
  assert.deepEqual(C.followersFrom({ followers: 0 }), { count: 0, source_url: null, as_of: null, kind: null });
  assert.equal(C.followersFrom({ followers: 5, followers_source_kind: 'profile' }).kind, 'profile');
  assert.equal(C.prospectPhotoUrl({ profile_image_url: 'https://yt3.example/a.jpg' }), 'https://yt3.example/a.jpg');
  for (const bad of [undefined, null, '', 'http://yt3.example/a.jpg', "https://x.example/a.jpg');background:red", 'javascript:alert(1)', `https://x.example/${'a'.repeat(2000)}`]) {
    assert.equal(C.prospectPhotoUrl({ profile_image_url: bad }), null, `no photo for ${String(bad).slice(0, 40)}`);
  }
  assert.equal(C.prospectPhotoUrl(null), null);
  assert.match(C.friendlySearchError('skipped: 1 likely minors, 0 not found on a page read, 0 not a profile link'), /^Left out: 1 likely minors/);
  assert.match(C.friendlySearchError('AI credit exhausted'), /Out of AI credit/);
  const shown = ['anthropic', 'Claude', 'dataforseo'].some((w) => C.friendlySearchError('model HTTP 529 anthropic').includes(w));
  assert.equal(shown, false, 'no provider names reach the page');
});

await t('an affiliate card asks the image CDN for the size the card uses, and touches nothing else', () => {
  // Shopify serves whatever width the address asks for, so a 100px thumbnail
  // scaled into a 300px card is soft. Ask for the card's size instead.
  assert.equal(C.displayImage('https://cdn.shopify.com/s/files/1/x.jpg?width=100&height=100&v=9'),
    'https://cdn.shopify.com/s/files/1/x.jpg?width=800&v=9');
  // Never downwards, and never a host whose parameters we do not know.
  assert.equal(C.displayImage('https://cdn.shopify.com/s/files/1/x.jpg?width=1600'), 'https://cdn.shopify.com/s/files/1/x.jpg?width=1600');
  assert.equal(C.displayImage('https://images.example.com/x.jpg?width=100'), 'https://images.example.com/x.jpg?width=100');
  assert.equal(C.displayImage('https://cdn.shopify.com/s/files/1/x.jpg'), 'https://cdn.shopify.com/s/files/1/x.jpg');
  for (const bad of [null, undefined, '', 'not a url', 'http://cdn.shopify.com/x.jpg?width=10']) {
    assert.equal(C.displayImage(bad), bad, `left alone: ${String(bad)}`);
  }
});

await t('a one-press code is named from the affiliate and never repeats one already taken', () => {
  assert.equal(C.suggestCode('Pat Trails', 10), 'PATTRAILS10');
  assert.equal(C.suggestCode('@blaketestings', 10), 'BLAKETESTINGS10', 'a handle, without the @');
  assert.equal(C.suggestCode('Pat Trails', 10, ['pattrails10']), 'PATTRAILS10B', 'taken is judged without case, as Shopify does; a letter, no dash');
  assert.equal(C.suggestCode('Pat Trails', 10, ['PATTRAILS10', 'PATTRAILS10B']), 'PATTRAILS10C');
  assert.equal(C.suggestCode('', 15), 'PARTNER15', 'no usable name still gives a code');
  assert.equal(C.suggestCode('José-María 🎉', 12.4), 'JOSMARA12', 'only letters and digits Shopify accepts');
  assert.ok(C.suggestCode('A'.repeat(40), 100).length <= 20);
});

await t('the import template is a file the import reads back: one creator, every column', async () => {
  const { importRowsToCandidates } = await import(pathToFileURL(join(process.cwd(), 'supabase/functions/affiliate-research/lib/affiliate-research-core.mjs')).href);
  const rows = C.parseCsv(C.toCsv(...C.IMPORT_TEMPLATE));
  const r = importRowsToCandidates({ rows, program: { niche_keywords: [] }, collectedAt: '2026-11-17T00:00:00Z' });
  assert.equal(r.stats.kept, 1, 'its example row imports');
  assert.equal(r.stats.followers_kept, 1, 'followers column is read');
  assert.equal(r.stats.emails_kept, 1, 'email column is read');
});

await t('the past-customer badge is one label, with the detail only on hover', () => {
  assert.equal(C.pastCustomerBadge({ customer_match_status: 'none' }), null, 'no match, no badge');
  assert.equal(C.pastCustomerBadge({ customer_match_status: 'not_matchable' }), null, 'a brand name shows nothing');
  assert.equal(C.pastCustomerBadge({}), null);
  const likely = C.pastCustomerBadge({
    customer_match_status: 'likely', customer_order_count: 2,
    customer_last_order_at: '2026-07-20T18:00:00Z', customer_lifetime_spend: '321',
    customer_match_basis: 'exact name match on one customer, name only',
  });
  assert.equal(likely.label, 'Past customer');
  assert.match(likely.title, /2 orders/);
  assert.match(likely.title, /last 2026-07-20/);
  assert.match(likely.title, /\$321/);
  assert.match(likely.title, /Check before you write to them/);
  assert.equal(C.pastCustomerBadge({ customer_match_status: 'possible', customer_order_count: 1 }).label,
    'Possible customer', 'a weaker match says so rather than claiming it');
});

await t('Your Customers: consent narrows the list, it never gates it, and blank is not an opt-out', () => {
  // The default reads EVERY customer: no consent predicate at all. This is
  // Blake's rule (2026-11-24) -- one-to-one recruiting is not a marketing
  // send, so opt-in is a filtering tactic, not a barrier.
  const none = C.customerQuerySpec({});
  assert.equal(none.consent, 'any');
  assert.equal(none.consentIsNull, false, 'any applies no IS NULL');
  assert.equal(none.consentState, null, 'any applies no state comparison');

  // "Not checked yet" is a different question from every other value: it is
  // an IS NULL, never a comparison against the text 'unmeasured' (no row
  // holds that, so the list would come back empty and read as "nobody").
  const un = C.customerQuerySpec({ consent: 'unmeasured' });
  assert.equal(un.consentIsNull, true);
  assert.equal(un.consentState, null, 'unmeasured must not also be compared as a state');

  const sub = C.customerQuerySpec({ consent: 'subscribed' });
  assert.equal(sub.consentIsNull, false);
  assert.equal(sub.consentState, 'subscribed');

  // A value nobody offered falls back to showing everyone, never to a
  // comparison that silently empties the list.
  assert.equal(C.customerQuerySpec({ consent: 'opted_in' }).consent, 'any');

  // And a blank state says it was not measured. Showing it as unsubscribed
  // would invent an opt-out for every customer the sync has not reached.
  const blank = C.customerConsentView(null);
  assert.equal(blank.measured, false);
  assert.match(blank.label, /not checked/);
  assert.equal(C.customerConsentView('').measured, false, 'empty text is also not measured');
  assert.equal(C.customerConsentView('unsubscribed').measured, true);
  assert.equal(C.customerConsentView('unsubscribed').tone, 'neg');
  assert.equal(C.customerConsentView('subscribed').tone, 'pos');
  assert.equal(C.customerConsentView('not_subscribed').label, 'not subscribed', 'read as words, not a column name');
});

await t('Your Customers: the window is on the last order and includes the day you chose', () => {
  // last_order_at is a TIMESTAMP. An end bound of the chosen day itself drops
  // everyone who ordered that day after midnight -- today's buyers, every
  // time somebody looks at today.
  assert.equal(C.customerQuerySpec({ to: '2026-11-23' }).toExclusive, '2026-11-24');
  assert.equal(C.customerQuerySpec({ to: '2026-02-28' }).toExclusive, '2026-03-01', 'month rolls over');
  assert.equal(C.customerQuerySpec({ to: '2026-12-31' }).toExclusive, '2027-01-01', 'year rolls over');
  assert.equal(C.customerQuerySpec({ from: '2025-01-01' }).from, '2025-01-01', 'the start is inclusive as given');
  // No date means no bound, not a bound of "null" that reads as zero rows.
  assert.equal(C.customerQuerySpec({}).from, null);
  assert.equal(C.customerQuerySpec({}).toExclusive, null);
  assert.equal(C.customerQuerySpec({ from: 'last month', to: '11/23/2026' }).from, null, 'anything but an ISO day is no bound');
  assert.equal(C.customerQuerySpec({ from: 'last month', to: '11/23/2026' }).toExclusive, null);
});

await t('Your Customers: ranking is named orderings with full tie-breaks, and the box values are clamped', () => {
  // Every sort ends on customer_key, or two customers with the same order
  // count come back in storage order and one row shows up on two pages.
  for (const [name, chain] of Object.entries(C.CUSTOMER_SORTS)) {
    assert.equal(chain.at(-1)[0], 'customer_key', `${name} breaks its last tie on a unique column`);
  }
  const d = C.customerQuerySpec({});
  assert.equal(d.sort, 'orders', 'most orders first by default');
  assert.deepEqual(d.order.map((o) => o.column), ['order_count', 'lifetime_spend', 'last_order_at', 'customer_key']);
  assert.equal(d.order[0].ascending, false);
  assert.equal(C.customerQuerySpec({ sort: 'spend' }).order[0].column, 'lifetime_spend');
  assert.equal(C.customerQuerySpec({ sort: 'recent' }).order[0].column, 'last_order_at');
  assert.equal(C.customerQuerySpec({ sort: 'oldest' }).order[0].ascending, true, 'longest-standing reads forwards');
  assert.equal(C.customerQuerySpec({ sort: 'whatever' }).sort, 'orders', 'an unknown sort falls back, never passes through to an ORDER BY');

  // The number box is typed by a person, so it is clamped here and not at the
  // call site: 0 or -5 would widen the list past what the label promises.
  assert.equal(C.customerQuerySpec({ minOrders: '3' }).minOrders, 3, 'text from an input is read as a number');
  assert.equal(C.customerQuerySpec({ minOrders: 0 }).minOrders, 1);
  assert.equal(C.customerQuerySpec({ minOrders: -5 }).minOrders, 1);
  assert.equal(C.customerQuerySpec({ minOrders: 999 }).minOrders, C.CUSTOMER_MIN_ORDERS_MAX);
  assert.equal(C.customerQuerySpec({ minOrders: 2.7 }).minOrders, 2, 'no fractional order count');
  assert.equal(C.customerQuerySpec({ minOrders: 'lots' }).minOrders, 1);

  // Paging is zero-based and never asks for a negative range.
  assert.deepEqual(C.customerQuerySpec({ page: 0 }).range, [0, C.CUSTOMER_PAGE_SIZE - 1]);
  assert.deepEqual(C.customerQuerySpec({ page: 2 }).range, [2 * C.CUSTOMER_PAGE_SIZE, 3 * C.CUSTOMER_PAGE_SIZE - 1]);
  assert.deepEqual(C.customerQuerySpec({ page: -3 }).range, [0, C.CUSTOMER_PAGE_SIZE - 1]);
});

await t('Your Customers: do-not-contact is read the way the database reads it', () => {
  // Blake 2026-11-24: "skip do not contacts yes as they don't want contact."
  // The address is normalised exactly as affiliate_normalize_contact does, or
  // a capitalised address walks straight past its own suppression.
  const sup = [
    { kind: 'email', value_normalized: 'pat@x.com' },
    { kind: 'domain', value_normalized: 'https://www.blocked.com/' },
    { kind: 'handle', value_normalized: 'pat' },
  ];
  assert.equal(C.customerSuppressed('pat@x.com', sup), true);
  assert.equal(C.customerSuppressed('  PAT@X.COM ', sup), true, 'case and spaces do not get somebody contacted');
  assert.equal(C.customerSuppressed('sam@x.com', sup), false, 'one suppressed address is not the whole domain');
  assert.equal(C.customerSuppressed('sam@blocked.com', sup), true, 'a suppressed domain covers its addresses');
  assert.equal(C.customerSuppressed('sam@mail.blocked.com', sup), true, 'and its subdomains');
  assert.equal(C.customerSuppressed('sam@notblocked.com', sup), false, 'a domain that merely ends the same way is not it');
  assert.equal(C.customerSuppressed('pat@other.com', sup), false, 'a handle entry cannot match an address');
  assert.equal(C.customerSuppressed('', sup), false);
  assert.equal(C.customerSuppressed(null, sup), false);
  assert.equal(C.customerSuppressed('a@b.com', []), false, 'an empty list suppresses nobody');
  assert.equal(C.customerSuppressed('a@b.com', [{ kind: 'email', value_normalized: '  ' }]), false, 'a blank entry matches nothing');
});

await t('Your Customers: a picked customer becomes an ordinary prospect, identified by email', () => {
  const row = C.customerProspectRow({
    customer: {
      customer_key: 'emily@x.com', name_lc: 'emily durrance', email_lc: ' Emily@X.com ',
      order_count: 2, lifetime_spend: '320.58', first_order_at: '2024-02-01T00:00:00Z',
      last_order_at: '2025-04-22T18:00:00Z', email_consent_state: null,
    },
    collectedAt: '2026-11-24T00:00:00Z',
  });
  assert.equal(row.source, 'customer', 'where they came from is recorded, not disguised as a search hit');
  assert.equal(row.status, 'approved', 'lined up for outreach, which is what approved means here');
  assert.equal(row.platform, 'other', 'they have no channel yet; claiming one would say we looked');
  assert.equal(row.contact_email, 'emily@x.com', 'the email is normalised before it is stored');
  assert.equal(row.display_name, 'Emily Durrance', 'the stored lowercase name is cased back for a person to read');
  assert.equal(row.handle, null);
  assert.equal(row.profile_url, null);
  // The database's identifiable constraint now accepts the email as the third
  // way to be identifiable (20261124030000); without one this row could not
  // be inserted at all, so it must never be blank here.
  assert.ok(row.contact_email, 'a customer row is identified by its email');
  assert.equal(row.evidence.order_count, 2);
  assert.equal(row.evidence.lifetime_spend, 320.58, 'spend is a number, not the text from the row');
  assert.equal(row.evidence.email_consent_state, null, 'an unmeasured consent stays null, it does not become a state');
  assert.match(row.evidence.note, /2 orders/);
  assert.match(row.evidence.note, /last 2025-04-22/);
  assert.equal(row.collected_at, '2026-11-24T00:00:00Z');

  // A customer with nothing measured still produces a usable row.
  const bare = C.customerProspectRow({ customer: { email_lc: 'x@y.com' } });
  assert.equal(bare.display_name, 'x@y.com', 'no name falls back to the address, never to blank');
  assert.equal(bare.evidence.order_count, null, 'unknown is null, not 0');
  assert.equal(bare.evidence.note, 'Your customer.');
  assert.equal(C.customerOrdersLine({ order_count: 1 }), ' once');
  assert.equal(C.customerOrdersLine({ order_count: 9 }), ' 9 times');
  assert.equal(C.customerOrdersLine({}), '', 'an unknown count writes nothing rather than a guess');
  assert.equal(C.customerOrdersLine({ order_count: 0 }), '');
});

await t('Your Customers: the customer template is its own, and still has to be joinable', () => {
  // The creator default opens by saying we found their channel in a search,
  // which read by a four-year customer is worse than no message at all.
  assert.notEqual(C.DEFAULT_CUSTOMER_OUTREACH.body, C.DEFAULT_OUTREACH.body);
  assert.ok(C.DEFAULT_CUSTOMER_OUTREACH.body.includes('{signup_link}'), 'the default is itself usable');
  assert.ok(!C.DEFAULT_CUSTOMER_OUTREACH.body.includes('{source}'), 'a customer was not found by a search');

  assert.equal(C.customerOutreachTemplate(null).subject, C.DEFAULT_CUSTOMER_OUTREACH.subject);
  assert.equal(C.customerOutreachTemplate({ customer_outreach_subject: '  ' }).subject, C.DEFAULT_CUSTOMER_OUTREACH.subject, 'blank is not a template');
  assert.equal(C.customerOutreachTemplate({ customer_outreach_subject: 'Join us' }).subject, 'Join us');
  assert.equal(C.customerOutreachTemplate({ customer_outreach_body: 'no link here' }).body, C.DEFAULT_CUSTOMER_OUTREACH.body,
    'a saved body with no signup link is not used: there would be no way to join');
  // It is a SEPARATE pair of columns: the creator template is untouched.
  const t2 = C.customerOutreachTemplate({ outreach_subject: 'Creator subject', outreach_body: 'x {signup_link}' });
  assert.equal(t2.subject, C.DEFAULT_CUSTOMER_OUTREACH.subject, 'the creator template is not reused for customers');

  const saved = C.customerTemplateRow('Join us', 'Hi {name} {signup_link}');
  assert.deepEqual(saved.errors, []);
  assert.equal(saved.row.customer_outreach_subject, 'Join us');
  assert.equal(saved.row.customer_outreach_body, 'Hi {name} {signup_link}');
  // Saving SILO's own default stores null, so the program keeps following the
  // default instead of pinning a frozen copy of it.
  const asDefault = C.customerTemplateRow(C.DEFAULT_CUSTOMER_OUTREACH.subject, C.DEFAULT_CUSTOMER_OUTREACH.body);
  assert.equal(asDefault.row.customer_outreach_subject, null);
  assert.equal(asDefault.row.customer_outreach_body, null);
  assert.equal(C.customerTemplateRow('', '').row.customer_outreach_body, null);
  const bad = C.customerTemplateRow('Join us', 'Hi {name}, no way to join');
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /signup_link/);
  assert.ok(C.customerTemplateRow('x'.repeat(201), 'a {signup_link}').errors.some((e) => /subject/.test(e)));
  assert.ok(C.customerTemplateRow('x', `${'a'.repeat(5001)} {signup_link}`).errors.some((e) => /5,000/.test(e)));
});

await t('Your Customers social: a blank count stays blank, only http(s) links, never the prospect\'s identity, never a cost', () => {
  assert.equal(C.customerSocialView(undefined).label, '—', 'never scanned');
  const found = C.customerSocialView({ status: 'found', match_basis: 'city', match_score: 80, handle: '@em', profile_url: 'https://www.instagram.com/em', followers: 12345, followers_quote: '12,345 Followers' });
  assert.equal(found.trust, 'likely', 'a Likely score makes it likely');
  assert.equal(found.pill, 'Likely 80', 'the score shows on the find');
  assert.equal(found.why, 'Their city appears on the profile', 'and the basis says why');
  const nameOnly = C.customerSocialView({ status: 'found', match_basis: 'name_only', match_score: 40, handle: '@em', profile_url: 'https://www.instagram.com/em', followers: 12345 });
  assert.equal(nameOnly.trust, 'name'); assert.equal(nameOnly.tone, 'warn', 'a name alone is a match to check, never shown as found');
  assert.equal(nameOnly.pill, 'Check 40');
  assert.equal(C.customerSocialView({ status: 'found', match_score: 69, match_basis: 'city', handle: '@em', profile_url: 'https://x.test/em', followers: 900 }).trust, 'name', 'under 70 is Check, whatever the basis');
  const old = C.customerSocialView({ status: 'found', match_basis: 'city', handle: '@em', profile_url: 'https://www.instagram.com/em', followers: 900 });
  assert.deepEqual([old.trust, old.pill], ['name', 'Check'], 'a row scored before scores existed is Check, as the scan counts it');
  assert.equal(C.customerSocialView({ status: 'found', handle: '@em', profile_url: 'https://www.instagram.com/em', followers: 900 }).trust, 'name', 'no basis recorded is never promoted');
  const odd = C.customerSocialView({ status: 'found', match_basis: 'whatever', handle: '@em', profile_url: 'https://www.instagram.com/em', followers: 900 });
  assert.equal(odd.trust, 'name', 'an unknown basis is never promoted');
  assert.equal(odd.why, 'Only the name matches. Check it is them', 'and reads as a name match');
  assert.equal(C.customerSocialView({ status: 'found', match_basis: 'niche', match_score: 75, handle: '@em', profile_url: 'https://x.test/em', followers: 900 }).why, 'Their profile mentions your niche');
  assert.equal(C.customerSocialView({ status: 'rejected', handle: '@em', profile_url: 'https://www.instagram.com/em' }).label, 'Not them');
  assert.equal(C.customerSocialView({ status: 'rejected', profile_url: 'https://www.instagram.com/em' }).url, null, 'a rejected find links nowhere');
  assert.equal(found.label, '@em · 12K'); assert.equal(found.tone, 'pos'); assert.equal(found.url, 'https://www.instagram.com/em');
  assert.equal(C.customerSocialView({ status: 'found', handle: '@em', profile_url: 'https://x.test/em', followers: 10000, followers_approx: true }).label, '@em · 10K+');
  const nc = C.customerSocialView({ status: 'no_count', handle: '@em', profile_url: 'https://x.test/em', followers: null });
  assert.equal(nc.label, '@em · count not shown');
  assert.ok(!/\b0\b/.test(C.customerSocialView({ status: 'found', handle: '@em', profile_url: 'https://x.test/em', followers: null }).label), 'NULL followers is not zero');
  assert.equal(C.customerSocialView({ status: 'found', handle: '@x', profile_url: 'javascript:alert(1)', followers: 900 }).url, null, 'only http(s) is a link');
  assert.equal(C.customerSocialView({ status: 'ambiguous' }).label, 'Several possible');
  assert.equal(C.customerSocialView({ status: 'none' }).label, 'None found');
  assert.equal(C.customerSocialView({ status: 'pending' }).label, 'Queued');
  assert.equal(C.compactCount(1204), '1.2K'); assert.equal(C.compactCount(840), '840'); assert.equal(C.compactCount(2500000), '2.5M'); assert.equal(C.compactCount(null), '');

  assert.equal(C.customerScanLine({ status: 'running', requested: 500, checked: 240, found: 6 }), 'Scanning… 240 of 500 checked · 6 found');
  assert.match(C.customerScanLine({ status: 'stopped', requested: 500, checked: 300, found: 9 }), /Stopped early, more to check\.$/);
  assert.equal(C.customerScanLine({ status: 'done', requested: 500, checked: 500, found: 12, cost_usd: 1.23 }), 'Last scan: 500 of 500 checked · 12 found.');
  assert.ok(!/\$|cost|spend|budget|credit/i.test(C.customerScanLine({ status: 'done', requested: 1, checked: 1, found: 0, cost_usd: 9 })), 'no cost in the UI');
  // The Hunt: finds against what was asked, and why a finished hunt ended.
  assert.equal(C.huntLine({ status: 'running', requested: 1000, checked: 240, found: 6, filters: { want: 25 } }), 'Found 6 of 25 · 240 checked');
  assert.equal(C.huntProgress({ found: 6, checked: 240, filters: { want: 25 } }).pct, 24, 'the bar is finds over finds wanted');
  assert.match(C.huntLine({ status: 'done', checked: 300, found: 3, filters: { want: 25, end: 'pool' } }), /checked everyone in this slice: 3 found of 25 asked for/);
  assert.match(C.huntLine({ status: 'done', checked: 10000, found: 18, filters: { want: 25, end: 'cap' } }), /the most one search checks: 18 found\. Press Find to keep going\.$/);
  assert.equal(C.huntLine({ status: 'done', checked: 2400, found: 25, filters: { want: 25, end: 'goal' } }), 'Last search: found 25 · 2,400 checked.');
  assert.ok(!/\$|cost|spend|budget|credit/i.test(C.huntLine({ status: 'done', checked: 1, found: 0, cost_usd: 9, filters: { end: 'cap' } })), 'no cost in the UI');
  // A run that died partway (no heartbeat for 3 minutes) never locks Find.
  const t0 = Date.parse('2026-11-24T07:20:00Z');
  assert.equal(C.liveScan({ status: 'running', heartbeat_at: '2026-11-24T07:16:00Z' }, t0).status, 'stopped', 'a dead run reads as stopped');
  assert.equal(C.liveScan({ status: 'running', heartbeat_at: '2026-11-24T07:19:00Z' }, t0).status, 'running', 'a live run stays running');
  assert.equal(C.liveScan({ status: 'running' }, t0).status, 'running', 'the page\'s own just-pressed run has no heartbeat yet');
  assert.equal(C.liveScan({ status: 'done', heartbeat_at: '2026-11-24T07:00:00Z' }, t0).status, 'done');
  assert.equal(C.liveScan(undefined), null);
  assert.equal(C.scanTermsText({ affiliate_customer_scan_terms: ['baseball', 'mlb'] }), 'baseball, mlb', 'the Niche words box shows the company\'s own words');
  assert.equal(C.scanTermsText({}), '');
  assert.equal(C.scanTermsFromRead({ data: { meta: { affiliate_customer_scan_terms: ['mlb'] } }, error: null }), 'mlb');
  assert.equal(C.scanTermsFromRead({ data: { meta: {} }, error: null }), '', 'read fine, no words: an empty box');
  assert.equal(C.scanTermsFromRead({ data: null, error: { message: 'timeout' } }), null, 'a failed read is not an empty box, so a press never clears saved words');
  assert.equal(C.scanTermsFromRead(null), null);
  // The tab counts agree with the list: opted-out customers come off their tab.
  const hid = [{ status: 'found', match_score: 35 }, { status: 'found', match_score: 82 }, { status: 'below' }, { status: 'none' }];
  assert.deepEqual(C.huntCounts({ top: 10, check: 76, more: 5 }, hid), { top: 9, check: 75, more: 4 });
  assert.deepEqual(C.huntCounts({ top: null, check: 2, more: 0 }, [{ status: 'below' }]), { top: null, check: 2, more: 0 }, 'a missing count stays missing, never below zero');
  // Show every prospect; the consent tag decides the path (Blake 2026-11-24).
  const okFind = { status: 'found', platform: 'instagram', handle: '@ola', profile_url: 'https://www.instagram.com/ola' };
  const cu = (state, o = {}) => ({ email_lc: 'ola@buyer.invalid', email_consent_state: state, ...o });
  for (const st of ['subscribed', 'not_subscribed', 'pending', null]) {
    assert.equal(C.customerContactPath(cu(st), okFind)?.channel, 'email', `${st}: email`);
  }
  assert.deepEqual(C.customerContactPath(cu('unsubscribed'), okFind), { channel: 'dm', email: null, handle: 'https://www.instagram.com/ola', platform: 'instagram' }, 'unsubscribed: a DM to the matched account, never email');
  assert.equal(C.customerContactPath(cu('unsubscribed'), null), null, 'unsubscribed with no account: no way to reach');
  assert.equal(C.customerNoPathReason(cu('unsubscribed'), null), 'unsubscribed, no account to message');
  assert.equal(C.customerContactPath(cu('unsubscribed'), { ...okFind, status: 'ambiguous' }), null, 'an unconfirmed result is not an account to DM');
  assert.equal(C.customerContactPath(cu('redacted'), okFind), null, 'erased: never');
  assert.equal(C.customerContactPath(cu('subscribed'), okFind, [{ kind: 'email', value_normalized: 'ola@buyer.invalid' }]), null, 'do-not-contact email: never');
  assert.equal(C.customerContactPath(cu('unsubscribed'), okFind, [{ kind: 'handle', value_normalized: '@OLA' }]), null, 'do-not-contact handle: never DMed');
  assert.equal(C.customerNoPathReason(cu('subscribed', { email_lc: '' }), null), 'no email on file');
  // People at the company level: one person once, own program first.
  const A_ = 'pa'; const B_ = 'pb'; const C_ = 'pc';
  const own = [{ id: 1, program_id: A_, profile_url: 'https://x.com/One ' }];
  const all = [
    { id: 2, program_id: B_, profile_url: 'https://x.com/one' },
    { id: 3, program_id: B_, platform: 'tiktok', handle: '@Two' },
    { id: 4, program_id: C_, platform: 'tiktok', handle: '@two' },
    { id: 5, program_id: B_, contact_email: 'nope@x.com', status: 'suppressed' },
    { id: 6, program_id: C_, contact_email: 'NOPE@x.com', status: 'new' },
  ];
  const ppl = C.companyPeople(own, all, A_);
  assert.deepEqual(ppl.map((x) => x.id), [1, 3], 'own row first; someone already here and someone do-not-contact anywhere are not offered');
  assert.deepEqual(ppl[1].otherPrograms, [B_, C_], 'one row per person, naming every program they are in');
  assert.equal(ppl[1].foreign, true);
  const moved = C.assignedProspectRow({ id: 9, program_id: B_, status: 'signed_up', affiliate_id: 'a', source_id: 's', reviewed_by: 'r', platform: 'youtube', profile_url: 'u', source: 'serp', evidence: { q: 1 } }, A_);
  assert.equal(moved.program_id, A_); assert.equal(moved.status, 'approved');
  for (const k of ['id', 'affiliate_id', 'source_id', 'reviewed_by']) assert.ok(!(k in moved), `${k} stays with the other program`);
  assert.deepEqual(moved.evidence, { q: 1 }, 'the evidence travels');
  assert.equal(C.customerContactPath(cu('unsubscribed', { email_lc: '' }), okFind), null, 'no email, no path: their address is the prospect identity, so two email-less customers would collapse into one');

  const social = { status: 'found', platform: 'instagram', handle: '@em', profile_url: 'https://www.instagram.com/em', followers: 1204, followers_quote: '1,204 Followers', match_score: 45 };
  const row = C.customerProspectRow({ customer: { email_lc: 'em@buyer.invalid', customer_key: 'k' }, social });
  assert.equal(row.profile_url, null, 'the identity column stays empty: a Discovery prospect with the same profile would refuse the row');
  assert.equal(row.handle, null);
  assert.equal(row.evidence.social.profile_url, 'https://www.instagram.com/em');
  assert.equal(row.evidence.social.followers, 1204);
  assert.equal(C.customerProspectRow({ customer: { email_lc: 'a@b.c' }, social: { status: 'ambiguous', candidates: [] } }).evidence.social, undefined, 'only a named profile is evidence');
  assert.equal(C.customerProspectRow({ customer: { email_lc: 'a@b.c' }, social: { status: 'rejected', profile_url: 'https://x.test/a' } }).evidence.social, undefined, 'a find marked "Not them" never travels');
  assert.equal(row.evidence.social.match_basis, 'name_only', 'the evidence says how far to trust it');
  assert.equal(row.evidence.social.match_score, 45, 'and how sure');
  assert.equal(C.customerProspectRow({ customer: { email_lc: 'a@b.c' }, social: { status: 'no_count', profile_url: 'https://x.test/a', followers: null } }).evidence.social.followers, null);
});

console.log(`\naffiliate-studio-ui: ${n} passed`);
