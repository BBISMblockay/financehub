// The projections planning sheet: which historical day stands behind each
// planned day, which cells a fill may write, and what a model is allowed to
// propose into the sheet.
//
// These are the two places a wrong answer is invisible: a fill that lines
// Saturday up with Friday reads as a plausible plan, and a draft row for a
// day outside the period saves without complaint. So both are pinned here,
// along with the server-side clamp in the edge function.
//
// Run: node scripts/tests/projections-planning.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildUserMessage, clampRows, indexActuals as idxActuals, readToolUse,
  trailingWeekdayAverage, validateRequest, MAX_VALUE,
} from '../../supabase/functions/projection-draft/draft-lib.mjs';

await import('../../v2/projections-v2-logic.js');   // sets globalThis.SiloProjPlan
const L = globalThis.SiloProjPlan;

/* ---------- dates ---------- */

test('a month range covers every day, including a leap February', () => {
  assert.deepEqual(L.monthRange('2026-12'), { from: '2026-12-01', to: '2026-12-31' });
  assert.equal(L.datesBetween('2026-12-01', '2026-12-31').length, 31);
  assert.equal(L.datesBetween('2028-02-01', '2028-02-29').length, 29);
  assert.deepEqual(L.datesBetween('2026-12-05', '2026-12-01'), []);
  assert.equal(L.monthRange('nonsense'), null);
});

test('weekday alignment goes back 364 days, so the weekday is kept', () => {
  // 5 Dec 2026 is a Saturday.
  assert.equal(L.dayOfWeek('2026-12-05'), 6);
  const basis = L.basisDate('2026-12-05', 1, 'weekday');
  assert.equal(basis, '2025-12-06');
  assert.equal(L.dayOfWeek(basis), 6, 'a Saturday must be compared with a Saturday');
  assert.equal(L.basisDate('2026-12-05', 2, 'weekday'), '2024-12-07');
  assert.equal(L.dayOfWeek(L.basisDate('2026-12-05', 2, 'weekday')), 6);
});

test('calendar alignment keeps the date, and 29 Feb does not roll into March', () => {
  assert.equal(L.basisDate('2026-12-05', 1, 'date'), '2025-12-05');
  assert.equal(L.basisDate('2028-02-29', 1, 'date'), '2027-02-28');
});

/* ---------- the fill ---------- */

const dates = L.datesBetween('2026-12-01', '2026-12-07');
function historyFor(locId, perDay) {
  const rows = [];
  for (const d of dates) {
    for (const years of [1, 2, 3]) {
      rows.push({ location_id: locId, day_date: L.basisDate(d, years, 'weekday'), net: perDay * (1 - (years - 1) * 0.1) });
    }
  }
  return L.indexActuals(rows);
}

test('last year plus growth writes every empty day and leaves planned days alone', () => {
  const actuals = historyFor(7, 1000);
  const existing = new Map([[L.actualKey(7, '2026-12-03'), 4242]]);
  const r = L.buildFill({ dates, locationIds: [7], actuals, existing, basis: 'ly', growthPct: 10 });
  assert.equal(r.writes.length, 6);
  assert.equal(r.skippedFilled, 1);
  assert.equal(r.noHistory, 0);
  assert.ok(r.writes.every((w) => w.value === 1100), 'every day is last year + 10%');
  assert.equal(r.total, 6600);
  assert.ok(!r.writes.some((w) => w.date === '2026-12-03'), 'an already planned day is not touched');
});

test('"every day" overwrites, and records what it is overwriting for undo', () => {
  const actuals = historyFor(7, 1000);
  const existing = new Map([[L.actualKey(7, '2026-12-03'), 4242]]);
  const r = L.buildFill({ dates, locationIds: [7], actuals, existing, basis: 'ly', growthPct: 0, scope: 'all' });
  assert.equal(r.writes.length, 7);
  const over = r.writes.find((w) => w.date === '2026-12-03');
  assert.equal(over.was, 4242, 'the previous value is carried so undo can restore it');
});

test('a day with no history behind it is skipped, never written as zero', () => {
  const actuals = new Map();   // nothing ever sold
  const r = L.buildFill({ dates, locationIds: [7], actuals, existing: new Map(), basis: 'ly', growthPct: 25 });
  assert.equal(r.writes.length, 0);
  assert.equal(r.noHistory, 7);
  assert.equal(r.total, 0);
});

test('the three-year average pools only the years that have history', () => {
  const rows = [
    { location_id: 9, day_date: L.basisDate('2026-12-01', 1, 'weekday'), net: 900 },
    { location_id: 9, day_date: L.basisDate('2026-12-01', 3, 'weekday'), net: 300 },
  ];
  const r = L.buildFill({
    dates: ['2026-12-01'], locationIds: [9], actuals: L.indexActuals(rows),
    existing: new Map(), basis: 'avg3', growthPct: 0,
  });
  assert.equal(r.writes[0].value, 600, 'two years present: (900 + 300) / 2, not / 3');
});

test('the trailing basis averages the same weekday before the period', () => {
  // Four Tuesdays before 1 Dec 2026 (a Tuesday), at 100, 200, 300, 400.
  const rows = [100, 200, 300, 400].map((net, i) => ({
    location_id: 3, day_date: L.addDays('2026-12-01', -7 * (i + 1)), net,
  }));
  const r = L.buildFill({
    dates: ['2026-12-01'], locationIds: [3], actuals: L.indexActuals(rows),
    existing: new Map(), basis: 'trailing8', growthPct: 0, periodFrom: '2026-12-01',
  });
  assert.equal(r.writes[0].value, 250);
});

test('a fill across locations writes each location independently', () => {
  const actuals = new Map([...historyFor(1, 500), ...historyFor(2, 1500)]);
  const r = L.buildFill({ dates, locationIds: [1, 2], actuals, existing: new Map(), basis: 'ly' });
  assert.equal(r.writes.length, 14);
  assert.equal(r.writes.filter((w) => w.location_id === 1).every((w) => w.value === 500), true);
  assert.equal(r.writes.filter((w) => w.location_id === 2).every((w) => w.value === 1500), true);
});

test('a negative growth cannot drive a plan below zero', () => {
  const actuals = historyFor(7, 100);
  const r = L.buildFill({ dates, locationIds: [7], actuals, existing: new Map(), basis: 'ly', growthPct: -400 });
  assert.ok(r.writes.every((w) => w.value === 0));
});

/* ---------- what a draft may become ---------- */

test('the page drops draft rows it is not allowed to save', () => {
  const existing = new Map([[L.actualKey(7, '2026-12-02'), 500]]);
  const v = L.validateDraftRows([
    { projection_date: '2026-12-01', location_id: 7, projected_sales: 1200, note: 'Tuesday drop' },
    { projection_date: '2027-01-04', location_id: 7, projected_sales: 1200 },   // outside the period
    { projection_date: '2026-12-04', location_id: 99, projected_sales: 1200 },  // another company's location
    { projection_date: '2026-12-05', location_id: 7, projected_sales: -5 },     // negative
    { projection_date: '2026-12-06', location_id: 7, projected_sales: 9e12 },   // typo, not a plan
    { projection_date: '2026-12-01', location_id: 7, projected_sales: 1 },      // duplicate day
    { projection_date: '2026-12-02', location_id: 7, projected_sales: 800 },    // already planned
  ], { dates, locationIds: [7], existing });
  assert.equal(v.accepted.length, 1);
  assert.equal(v.accepted[0].value, 1200);
  assert.equal(v.total, 1200);
  assert.deepEqual(v.rejected.map((r) => r.reason), [
    'outside the period', 'not one of the locations being planned', 'not a positive number',
    'implausibly large', 'duplicate day', 'day already has a plan',
  ]);
});

/* ---------- the edge function's own guards ---------- */

test('the request is refused unless it names a readable location and a sane period', () => {
  const visible = [1, 2];
  assert.match(validateRequest({}, visible).error, /YYYY-MM-DD/);
  assert.match(validateRequest({ from: '2026-12-05', to: '2026-12-01' }, visible).error, /not be after/);
  assert.match(validateRequest({ from: '2026-01-01', to: '2027-12-31', location_ids: [1] }, visible).error, /at most/);
  assert.match(validateRequest({ from: '2026-12-01', to: '2026-12-31' }, visible).error, /location_ids/);
  assert.match(
    validateRequest({ from: '2026-12-01', to: '2026-12-31', location_ids: [404], instruction: 'grow' }, visible).error,
    /readable in the active company/,
    'a location the caller cannot read is refused rather than planned',
  );
  assert.match(
    validateRequest({ from: '2026-12-01', to: '2026-12-31', location_ids: [1] }, visible).error,
    /instruction is required/,
  );
  const ok = validateRequest(
    { from: '2026-12-01', to: '2026-12-07', location_ids: [1, 2, 1], instruction: ' grow retail 15% ' },
    visible,
  );
  assert.deepEqual(ok.locationIds, [1, 2], 'duplicates collapse');
  assert.equal(ok.dates.length, 7);
  assert.equal(ok.instruction, 'grow retail 15%');
  assert.equal(ok.onlyEmptyDays, true, 'the safe default is to fill only empty days');
  assert.equal(validateRequest({ ...ok, only_empty_days: false, location_ids: [1], instruction: 'x' }, visible).onlyEmptyDays, false);
});

test('the function clamps the model answer the same way, before the page sees it', () => {
  const existing = new Map([['1|2026-12-02', 500]]);
  const { rows, dropped } = clampRows([
    { projection_date: '2026-12-01', location_id: 1, projected_sales: 1000.456, note: 'x'.repeat(400) },
    { projection_date: '2026-12-02', location_id: 1, projected_sales: 1000 },
    { projection_date: '2026-12-01', location_id: 77, projected_sales: 1000 },
    { projection_date: '2026-12-03', location_id: 1, projected_sales: MAX_VALUE + 1 },
  ], { dates, locationIds: [1], existing, onlyEmptyDays: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projected_sales, 1000.46);
  assert.equal(rows[0].note.length, 200, 'a long note is cut, not passed through');
  assert.deepEqual(dropped.map((d) => d.reason), ['day already planned', 'location not in the request', 'implausibly large']);
});

test('the prompt carries only aggregated history, and hides days already planned', () => {
  const actuals = idxActuals([
    { location_id: 1, day_date: L.basisDate('2026-12-02', 1, 'weekday'), net: 1234.7 },
    { location_id: 1, day_date: L.basisDate('2026-12-02', 2, 'weekday'), net: 1000 },
  ]);
  const msg = buildUserMessage({
    from: '2026-12-01', to: '2026-12-02', dates: ['2026-12-01', '2026-12-02'],
    locations: [{ id: 1, location_name: 'Scottsdale', store_type: 'retail' }],
    actuals, launches: new Map([['2026-12-02', ['Holiday capsule']]]),
    existing: new Map([['1|2026-12-01', 900]]),
    onlyEmptyDays: true, instruction: 'grow 10%',
  });
  assert.match(msg, /1 = Scottsdale \(retail\)/);
  assert.ok(!msg.includes('1 2026-12-01 '), 'a day that already has a plan is not offered for drafting');
  assert.match(msg, /1 2026-12-02 Wed 1235 1000 none none Holiday capsule/);
  assert.match(msg, /already have a plan and are not listed/);
  assert.match(msg, /grow 10%/);
});

test('the trailing average looks only at the same weekday before the period', () => {
  const actuals = idxActuals([
    { location_id: 1, day_date: '2026-11-24', net: 100 },   // Tuesday
    { location_id: 1, day_date: '2026-11-25', net: 9999 },  // Wednesday, must be ignored
    { location_id: 1, day_date: '2026-11-17', net: 300 },   // Tuesday
  ]);
  assert.equal(trailingWeekdayAverage(actuals, 1, '2026-12-01', '2026-12-01'), 200);
  assert.equal(trailingWeekdayAverage(actuals, 1, '2026-12-03', '2026-12-01'), null, 'no history means null, not zero');
});

test('an answer with no tool call yields no rows', () => {
  assert.deepEqual(readToolUse({ content: [{ type: 'text', text: 'I cannot do that' }] }).rows, []);
  assert.equal(readToolUse({ content: [{ type: 'text', text: 'I cannot do that' }] }).rationale, 'I cannot do that');
  const good = readToolUse({
    content: [{ type: 'tool_use', name: 'propose_projections', input: { rationale: 'r', rows: [{ a: 1 }] } }],
  });
  assert.equal(good.rows.length, 1);
  assert.equal(good.rationale, 'r');
});
