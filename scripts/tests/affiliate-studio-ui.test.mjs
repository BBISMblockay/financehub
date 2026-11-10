// The DOM-free logic behind the Affiliate Studio pages (v2/affiliates/studio-core.js):
// money in minor units, the program form, CSV exports and their fingerprints,
// and the "how each part works" labels.
//
// Mutations (CI runs each and requires a failure):
//   AFFILIATE_CORE_MUTATION=formula   spreadsheet formula cells are not neutralised
//   AFFILIATE_CORE_MUTATION=zerodec   zero-decimal currencies are treated as two-decimal
//   AFFILIATE_CORE_MUTATION=rounding  extra decimals are rounded instead of refused
//   AFFILIATE_CORE_MUTATION=href      any URL scheme becomes a link
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
  const { row, errors } = C.validateProgram({ name: 'Creator Program', commission_percent: '12.5', currency: 'usd', platforms: ['youtube'], payout_minimum: '25', terms_markdown: 'x', status: 'active' });
  assert.deepEqual(errors, []);
  assert.equal(row.slug, 'creator-program');
  assert.equal(row.currency, 'USD');
  assert.equal(row.commission_percent, 12.5);
  assert.equal(row.payout_minimum_cents, 2500);
  assert.equal(row.attribution_window_days, 0, 'no silent grace by default');
  assert.equal(row.payout_method, 'manual', 'the form cannot choose an unbuilt payout method');
  const bad = C.validateProgram({ name: '', commission_percent: '120', currency: 'dollars', attribution_window_days: '400', status: 'active' });
  assert.ok(bad.errors.length >= 4, bad.errors.join(' | '));
  assert.ok(bad.errors.some((e) => /terms/.test(e)), 'an active program needs terms');
  const fixed = C.validateProgram({ name: 'F', slug: 'fixed-one', commission_kind: 'fixed_per_order', commission_fixed: '5', currency: 'USD' });
  assert.equal(fixed.row.commission_fixed_cents, 500);
  assert.equal(fixed.row.commission_percent, null);
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
  assert.equal(none['Incremental sales'], 'not measured');
  assert.equal(byStage({ discoveryRuns: [{ dry_run: true, status: 'success' }] }).Discovery, 'simulated');
  assert.equal(byStage({ discoveryRuns: [{ dry_run: false, status: 'error' }] }).Discovery, 'unconfigured');
  assert.equal(byStage({ discoveryRuns: [{ dry_run: false, status: 'success' }] }).Discovery, 'verified');
  assert.equal(byStage({ notifications: [{ status: 'sent' }] })['Affiliate emails'], 'verified');
  assert.equal(byStage({ codesSeen: 2 })['Code tracking'], 'verified');
});

await t('a failed search is described without the provider name or codes', () => {
  const m = C.friendlySearchError('SERP provider refused the task: 40101 Internal SE Server Error.');
  assert.ok(m && !/SERP|40101|provider|DataForSEO/i.test(m), m);
  assert.equal(C.friendlySearchError(''), '');
});

console.log(`\naffiliate-studio-ui: ${n} passed`);
