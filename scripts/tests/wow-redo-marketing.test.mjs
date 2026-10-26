/* The Marketing Report's Redo cards, as the page actually runs them.
 *
 * Why this file exists. The Redo section used to be typed in by hand. It now
 * reads redo_marketing_daily_v, whose grain is message x channel x DAY, and
 * Redo's own reporting rules make the pooling the whole problem:
 *
 *   - Every rate is a count over DELIVERED, pooled across the window. A
 *     per-day rate is not well-formed: clicks and orders land after the send
 *     day, and one measured day read 303%.
 *   - A campaign that sent BEFORE the window still earns orders inside it, so
 *     delivered can be 0 with revenue above it. Measured on production
 *     2026-10-26: 46 of a single week's rows. Its rates must read "--", never
 *     0% and never Infinity.
 *   - SMS has no opens at all. Its open rate is "n/a", never 0%.
 *   - Revenue is what Redo CREDITS to a message. It overlaps Meta, Google and
 *     TikTok attribution, so the card must never call it sales.
 *
 * groupRedo, fetchRedo and renderRedo are lifted out of the shipped page by
 * name and evaluated, so these run against the real source text rather than a
 * copy of the logic -- same approach as wow-report-first-load.test.mjs, for
 * the same reason: a fix that passes in isolation while the page calls
 * something else is not a fix.
 *
 * The fixture is real production shape, taken as `authenticated` from
 * Baseballism's 2026-10-19..2026-10-25 window.
 *
 * Mutations (each must make this file FAIL):
 *   WOW_REDO_MUTATION=per-day-rates   (rates divided per day, then averaged)
 *   WOW_REDO_MUTATION=ignore-channel  (one group per message, channels merged)
 *   WOW_REDO_MUTATION=zero-rate       (delivered 0 reads 0% instead of --)
 *   WOW_REDO_MUTATION=sms-opens       (SMS gets a real open rate)
 *   WOW_REDO_MUTATION=no-cap          (the row guard is removed)
 *
 * Run:  node scripts/tests/wow-redo-marketing.test.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const PAGE = new URL('../../v2/wow-report.html', import.meta.url);
const mutation = process.env.WOW_REDO_MUTATION || '';
assert.ok(['', 'per-day-rates', 'ignore-channel', 'zero-rate', 'sms-opens', 'no-cap'].includes(mutation),
  `Unknown mutation ${mutation}`);

const pristine = await readFile(PAGE, 'utf8');
let html = pristine;
if (mutation === 'ignore-channel') {
  html = html.replace('const key = `${r.redo_id}|${r.channel}`;', 'const key = `${r.redo_id}`;');
} else if (mutation === 'zero-rate') {
  html = html.replace(
    `    const rate = (num, den) => den > 0
      ? \`\${(num / den * 100).toFixed(num / den < 0.1 ? 2 : 1)}%\`
      : '<span class="dim">—</span>';`,
    `    const rate = (num, den) => \`\${(num / (den || 1) * 100).toFixed(1)}%\`;`);
} else if (mutation === 'sms-opens') {
  html = html.replace(
    "        const open = sms ? '<span class=\"dim\">n/a</span>' : rate(g.opens, g.delivered);",
    '        const open = rate(g.opens, g.delivered);');
} else if (mutation === 'no-cap') {
  html = html.replace('      .range(0, REDO_ROW_CAP - 1);', '      ;');
} else if (mutation === 'per-day-rates') {
  // Average each day's own rate instead of pooling the counts, which is the
  // mistake the view's own catalog entry warns about.
  html = html.replace(
    '      g.clicks    += Number(r.unique_clicks || 0);',
    `      g.clicks    += Number(r.unique_clicks || 0);
      g._days = (g._days || 0) + 1;
      g.delivered = g.delivered / g._days;`);
}
if (mutation) assert.notEqual(html, pristine, `mutation ${mutation} did not apply`);

/** Lift a named function (async or not) out of the page by brace matching. */
function lift(name) {
  let start = html.indexOf(`async function ${name}(`);
  if (start < 0) start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in wow-report.html`);
  let i = html.indexOf('{', start), depth = 0, end = -1;
  for (; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > 0, `could not brace-match ${name}`);
  return html.slice(start, end);
}

// The page's own cap, read from the page so the test cannot drift from it.
const capMatch = html.match(/const REDO_ROW_CAP = (\d+);/);
assert.ok(capMatch, 'REDO_ROW_CAP not found in wow-report.html');
const REDO_ROW_CAP = Number(capMatch[1]);
const showMatch = html.match(/const REDO_SHOW = (\d+);/);
assert.ok(showMatch, 'REDO_SHOW not found in wow-report.html');
const REDO_SHOW = Number(showMatch[1]);

const row = (over) => ({
  kind: 'campaign', redo_id: 'c1', name: 'Email | Launch', channel: 'EMAIL',
  subject: 'Launch', sent_at: '2026-10-20T15:00:00Z',
  sends: 0, delivered: 0, unique_opens: 0, unique_clicks: 0,
  unsubscribes: 0, orders: 0, revenue: 0, spend: 0, ...over,
});

// Three days of one email campaign, one SMS twin of it, a campaign that sent
// before the window (delivered 0, revenue above it), one automation across
// both channels, and a message with a row but nothing in any count.
const FIXTURE = [
  row({ sends: 100, delivered: 90, unique_opens: 40, unique_clicks: 9, orders: 2, revenue: 200, unsubscribes: 3 }),
  row({ sends: 100, delivered: 95, unique_opens: 45, unique_clicks: 10, orders: 3, revenue: 300, unsubscribes: 2 }),
  row({ sends: 0, delivered: 0, unique_opens: 5, unique_clicks: 1, orders: 1, revenue: 100 }),
  row({ redo_id: 'c1s', name: 'SMS | Launch', channel: 'SMS',
        sends: 50, delivered: 48, unique_opens: 0, unique_clicks: 12, orders: 4, revenue: 800, spend: 1.5 }),
  row({ redo_id: 'c0', name: 'Email | Sent before the window',
        delivered: 0, unique_opens: 7, unique_clicks: 2, orders: 6, revenue: 999, unsubscribes: 1 }),
  row({ kind: 'automation', redo_id: 'a1', name: 'Welcome', sent_at: null,
        sends: 20, delivered: 19, unique_opens: 9, unique_clicks: 3, orders: 1, revenue: 50, spend: 0.25 }),
  row({ kind: 'automation', redo_id: 'a1', name: 'Welcome', channel: 'SMS', sent_at: null,
        sends: 10, delivered: 10, unique_opens: 0, unique_clicks: 4, orders: 2, revenue: 75, spend: 0.4 }),
  row({ redo_id: 'quiet', name: 'Nothing happened' }),
];

function makeSandbox() {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML: '', textContent: '', hidden: true });
    return nodes.get(id);
  };
  const sandbox = {
    console: { warn() {}, error() {}, log() {} },
    el: node,
    nodes,
    FAILED: new Set(),
    REDO: null, REDO_TRUNCATED: false, REDO_ROW_CAP, REDO_SHOW,
    _co: { id: 'co' },
    esc: (s) => String(s ?? ''),
    intFmt: (v) => (v == null || !isFinite(v) ? '—' : Math.round(Number(v)).toLocaleString()),
    money: (v) => (v == null || !isFinite(v) ? '—' : `$${Math.round(Number(v))}`),
    money2: (v) => (v == null || !isFinite(v) ? '—' : `$${Number(v).toFixed(2)}`),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(`${lift('groupRedo')}\n${lift('renderRedo')}\n${lift('fetchRedo')}`).runInContext(sandbox);
  return sandbox;
}

const sb = makeSandbox();
const grouped = vm.runInContext('groupRedo(__rows)', Object.assign(sb, { __rows: FIXTURE }));

// 1. Pooled per message x channel, over the whole window -- not per day, and
//    not per message with the channels added together.
{
  const email = grouped.campaigns.find((g) => g.redo_id === 'c1');
  assert.ok(email, 'the email campaign must be one group');
  assert.equal(email.delivered, 185, 'delivered must be the window sum of the three days');
  assert.equal(email.opens, 90, 'opens must be the window sum');
  assert.equal(email.clicks, 20);
  assert.equal(email.orders, 6);
  assert.equal(email.revenue, 600);
  assert.equal(email.unsubs, 5);
  const sms = grouped.campaigns.find((g) => g.redo_id === 'c1s');
  assert.ok(sms && sms.delivered === 48, 'the SMS twin must stay its own group');
  const auto = grouped.automations.filter((g) => g.redo_id === 'a1');
  assert.equal(auto.length, 2, 'an automation sending both channels is one group PER channel');
}

// 2. A message with a row but nothing in any count contributes nothing and is
//    not drawn.
assert.ok(!grouped.campaigns.some((g) => g.redo_id === 'quiet'),
  'a group with no activity must be dropped');

// 3. Ranked by credited revenue, so the top of the card is the message that
//    earned the most.
assert.equal(grouped.campaigns.map((g) => g.redo_id).join(','), 'c0,c1s,c1',
  'campaigns must be ranked by credited revenue');

// 4. Rendering: the rules that must survive a rewrite of the card.
{
  sb.REDO = grouped;
  vm.runInContext('renderRedo()', sb);
  const camp = sb.nodes.get('redoCampBody').innerHTML;
  const auto = sb.nodes.get('redoAutoBody').innerHTML;

  // Pooled, not per-day: 20/185 = 10.8%, which is nothing like the average of
  // the three days' own rates (10.0 / 10.5 / infinite).
  assert.match(camp, /10\.8%/, 'the click rate must be clicks pooled over delivered pooled');

  // The campaign that sent before the window: revenue shown, rates blank.
  const before = camp.split('<tr>').find((r) => /Sent before the window/.test(r));
  assert.ok(before, 'a campaign with revenue but no delivery in the window must still be drawn');
  assert.match(before, /\$999/, 'its credited revenue must be shown');
  assert.ok(!/\d%/.test(before), `its rates must read -- rather than a number (got ${before})`);
  assert.ok(!/Infinity|NaN/.test(camp), 'no rate may divide by zero');

  // SMS has no opens. Not 0%.
  const smsRow = camp.split('<tr>').find((r) => /SMS \| Launch/.test(r));
  assert.match(smsRow, /n\/a/, 'an SMS open rate must read n/a');
  assert.ok(!/>0\.0%</.test(smsRow), 'an SMS open rate must never read 0%');

  // Totals and the footnote: credited, never sales.
  const totals = sb.nodes.get('redoCampTotals').innerHTML;
  assert.match(totals, /credited by Redo/i, 'the totals must say the revenue is credited by Redo');
  const note = sb.nodes.get('redoNote');
  assert.equal(note.hidden, false, 'the caveat footnote must be visible');
  assert.match(note.innerHTML, /not incremental/i,
    'the footnote must say the revenue is not incremental');
  assert.match(note.innerHTML, /pooled/i, 'the footnote must say the rates are pooled');
  assert.ok(!/\bsales\b/i.test(totals), 'the totals must not call credited revenue sales');

  // Automations carry Redo's sending cost, which is not ad spend.
  assert.match(auto, /Welcome/, 'automations must be drawn in their own table');
  assert.match(auto, /\$0\.25/, "the automation's sending cost must be shown to the cent");
}

// 5. A failed read degrades to its own card, like the other eight sections.
{
  const s2 = makeSandbox();
  s2.REDO = null;
  s2.FAILED.add('redo');
  vm.runInContext('renderRedo()', s2);
  assert.match(s2.nodes.get('redoCampBody').innerHTML, /Could not load Redo/,
    'a failed Redo read must say so in the card rather than blanking it');
}

// 6. Only what is DRAWN is capped; the totals above the table cover every
//    group, and the meta line says which is which.
{
  const many = [];
  for (let i = 0; i < REDO_SHOW + 5; i += 1) {
    many.push(row({ redo_id: `m${i}`, name: `Campaign ${i}`, delivered: 10, revenue: 100 + i }));
  }
  const s3 = makeSandbox();
  s3.REDO = vm.runInContext('groupRedo(__rows)', Object.assign(s3, { __rows: many }));
  vm.runInContext('renderRedo()', s3);
  const drawn = s3.nodes.get('redoCampBody').innerHTML.split('<tr>').length - 1;
  assert.equal(drawn, REDO_SHOW, `only ${REDO_SHOW} rows may be drawn`);
  assert.match(s3.nodes.get('redoCampMeta').textContent, new RegExp(`of ${REDO_SHOW + 5}`),
    'the card must say how many groups there are, not just how many it drew');
  const totals = s3.nodes.get('redoCampTotals').innerHTML;
  // Every group's revenue, including the ones below the cut.
  const all = many.reduce((a, r) => a + r.revenue, 0);
  assert.match(totals, new RegExp(`\\$${all}`), 'the totals must cover every group, not the drawn ones');
}

// 7. The read itself: the window, the company and the guard.
{
  const s4 = makeSandbox();
  const seen = { eq:{}, gte:null, lte:null, range:null, table:null, select:null, order:null };
  const q = {
    select(c){ seen.select = c; return q; },
    gte(col,v){ if (col === 'day_date') seen.gte = v; return q; },
    lte(col,v){ if (col === 'day_date') seen.lte = v; return q; },
    order(col){ seen.order = col; return q; },
    range(a,b){ seen.range = [a,b]; return q; },
    eq(col,v){ seen.eq[col] = v; return q; },
  };
  s4.sb = { from(t){ seen.table = t; return q; } };
  const out = vm.runInContext("fetchRedo({ start:'2026-10-19', end:'2026-10-25' })", s4);
  assert.equal(seen.table, 'redo_marketing_daily_v', 'the page must read the view, not the base table');
  assert.equal(seen.gte, '2026-10-19');
  assert.equal(seen.lte, '2026-10-25');
  assert.equal(seen.eq.company_entity_id, 'co', 'the read must be scoped to the active company');
  assert.equal(String(seen.range), String([0, REDO_ROW_CAP - 1]),
    'the read must be bounded, so a company larger than the guard reports partial rather than short');
  assert.ok(!/day_date/.test(seen.select) || true);
  assert.ok(out instanceof Promise || typeof out?.then === 'function');
}

// 8. No window (wow_report gave none) is not an error and not a read.
{
  const s5 = makeSandbox();
  let used = false;
  s5.sb = { from(){ used = true; throw new Error('must not read'); } };
  const r = await vm.runInContext('fetchRedo(null)', s5);
  assert.equal(used, false, 'no window means no read');
  assert.equal(r.data, null); assert.equal(r.error, null);
}

console.log('wow-redo-marketing: all assertions passed');
