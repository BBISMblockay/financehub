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
  codeclash: ["  if (!used.has(base)) return base;", '  return base;'],
  pindefault: ["row.outreach_body = body === '' || body === DEFAULT_OUTREACH.body ? null : body;", "row.outreach_body = body === '' ? null : body;"],
  rounding: ["const re = units === 1 ? /^-?\\d+$/ : /^-?\\d+(\\.\\d{1,2})?$/;", 'const re = /^-?\\d+(\\.\\d+)?$/;'],
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
  assert.equal(C.suggestCode('Pat Trails', 10, ['pattrails10']), 'PATTRAILS102', 'taken is judged without case, as Shopify does');
  assert.equal(C.suggestCode('Pat Trails', 10, ['PATTRAILS10', 'PATTRAILS102']), 'PATTRAILS103');
  assert.equal(C.suggestCode('', 15), 'AFF15', 'no usable name still gives a code');
  assert.equal(C.suggestCode('José-María 🎉', 12.4), 'JOSMARA12', 'only letters and digits Shopify accepts');
  assert.ok(C.suggestCode('A'.repeat(40), 100).length <= 20);
});

console.log(`\naffiliate-studio-ui: ${n} passed`);
