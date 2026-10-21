/* The pure half of the filter bar: how declarations become controls.
 *
 * The DOM half is covered by the browser suite; what is testable here is the
 * decision that produces it -- which declarations pair into one range
 * control, and which stay on their own. Getting that wrong shows up as a
 * lone "end date" nobody can set, or two unrelated dates welded together. */
'use strict';
const { loadV3 } = require('../lib/load');
const { createReporter } = require('../lib/assert');

const g = loadV3(['report-params.js', 'field-semantics.js', 'metrics.js', 'chart-adapter.js', 'filter-bar.js']);
const FB = g.SiloFilterBar;
const R = createReporter('filter-bar');
const { test, eq, truthy } = R;

const d = (key, type, extra) => Object.assign({ key, type, label: key.replace(/_/g, ' '), default: '' }, extra || {});

// ── Range pairing ─────────────────────────────────────────────────────
console.log('\n── range pairing ──');

test('start_date + end_date become ONE range control', () => {
  const groups = FB.groupDeclarations([d('start_date', 'date'), d('end_date', 'date')]);
  eq(groups.length, 1);
  eq(groups[0].kind, 'range');
  eq([groups[0].from.key, groups[0].to.key], ['start_date', 'end_date']);
});
test('from/to pair on a shared prefix', () => {
  const groups = FB.groupDeclarations([d('sales_from', 'date'), d('sales_to', 'date')]);
  eq(groups[0].kind, 'range');
});
// A lone end date is half a window nobody can set. It stays its own
// control rather than being paired with an unrelated date.
test('a lone end_date stays a single control', () => {
  const groups = FB.groupDeclarations([d('end_date', 'date')]);
  eq(groups[0].kind, 'single');
});
test('two dates with DIFFERENT prefixes are not a range', () => {
  const groups = FB.groupDeclarations([d('sales_start', 'date'), d('po_end', 'date')]);
  eq(groups.map((x) => x.kind), ['single', 'single']);
});
test('a date and a non-date never pair', () => {
  const groups = FB.groupDeclarations([d('report_start', 'date'), d('report_end', 'text')]);
  eq(groups.map((x) => x.kind), ['single', 'single']);
});
test('a conflicted declaration is never folded into a range', () => {
  const groups = FB.groupDeclarations([
    d('x_start', 'date', { conflict: 'declared as both date and text' }), d('x_end', 'date')]);
  eq(groups.map((x) => x.kind), ['single', 'single']);
});
test('non-date declarations keep their own controls and their order', () => {
  const groups = FB.groupDeclarations([d('grain', 'enum', { options: ['day'] }), d('store', 'text')]);
  eq(groups.map((x) => x.key), ['grain', 'store']);
});
test('a range keeps its position in declaration order', () => {
  const groups = FB.groupDeclarations([
    d('grain', 'enum', { options: ['day'] }), d('w_start', 'date'), d('w_end', 'date'), d('store', 'text')]);
  eq(groups.map((x) => x.kind), ['single', 'range', 'single']);
});

// ── Range presets ─────────────────────────────────────────────────────
console.log('\n── presets ──');

// "Last 7 days" meaning 6 days plus today is the single most common
// off-by-one in a hand-built dashboard, so every preset is stated as an
// inclusive pair and the pairing is asserted rather than assumed.
test('every range preset is inclusive of both ends', () => {
  const P = g.SiloReportParams;
  for (const preset of FB.RANGE_PRESETS) {
    const from = P.resolveDateExpr(preset.from);
    const to = P.resolveDateExpr(preset.to);
    truthy(from && to, `${preset.id} must resolve both ends`);
    truthy(from <= to, `${preset.id}: ${from} must not be after ${to}`);
  }
});
test('last 7 days is 7 days counting today, not 8', () => {
  const M = g.SiloMetrics;
  const P = g.SiloReportParams;
  const p = FB.RANGE_PRESETS.find((x) => x.id === 'last_7');
  eq(M.inclusiveDays(P.resolveDateExpr(p.from), P.resolveDateExpr(p.to)), 7);
});
test('last 28 days is 28', () => {
  const M = g.SiloMetrics;
  const P = g.SiloReportParams;
  const p = FB.RANGE_PRESETS.find((x) => x.id === 'last_28');
  eq(M.inclusiveDays(P.resolveDateExpr(p.from), P.resolveDateExpr(p.to)), 28);
});
test('a stored pair is recognised as its preset, so the control reopens on it', () =>
  eq(FB.matchRangePreset('today-27d', 'today'), 'last_28'));
test('an arbitrary pair is not a preset -- it is a custom range', () =>
  eq(FB.matchRangePreset('2026-01-01', '2026-03-04'), ''));
// Storing the resolved date would freeze a rolling window on its save date.
test('every preset stores a TOKEN, never a resolved date', () => {
  for (const p of FB.RANGE_PRESETS) {
    truthy(!/^\d{4}-\d{2}-\d{2}$/.test(p.from), `${p.id} from`);
    truthy(!/^\d{4}-\d{2}-\d{2}$/.test(p.to), `${p.id} to`);
  }
});
test('every single-date preset stores a token too', () => {
  for (const p of FB.DATE_PRESETS) truthy(!/^\d{4}-\d{2}-\d{2}$/.test(p.value), p.value);
});
test('...and every one of them resolves to a real date today', () => {
  const P = g.SiloReportParams;
  for (const p of FB.DATE_PRESETS) truthy(P.resolveDateExpr(p.value), p.value);
});

test('company dates keep rolling single controls instead of browser-calendar ranges', () => {
  eq(FB.groupDeclarations([d('date_from','date',{date_basis:'company'}),d('date_to','date',{date_basis:'company'})]).map(x=>x.kind),['single','single']);
});
// ...but the scheduled-email period picker only wants to know WHICH TWO
// KEYS are the window; it stores tokens and prints no resolved date, so
// the reason for the exclusion above does not apply to it.
test('includeCompanyCalendar pairs them for a caller that prints no date', () => {
  const groups = FB.groupDeclarations(
    [d('date_from','date',{date_basis:'company'}),d('date_to','date',{date_basis:'company'})],
    { includeCompanyCalendar: true });
  eq(groups.map((x) => x.kind), ['range']);
  eq([groups[0].from.key, groups[0].to.key], ['date_from', 'date_to']);
});
test('the option does not pair two dates that are not two ends of one window', () => {
  const groups = FB.groupDeclarations(
    [d('as_of','date',{date_basis:'company'}),d('launched','date',{date_basis:'company'})],
    { includeCompanyCalendar: true });
  eq(groups.map((x) => x.kind), ['single', 'single']);
});

// ── a text parameter whose choices come from the database ───────────────
// A SILO report is one global row read by every client and each company has
// its own locations, so the choices cannot be an enum's declared list.
test('a text parameter with an options_source gets the choice control, not a text box', () => {
  const P = g.SiloReportParams;
  const decls = P.normalizeDeclarations([
    { key: 'location', type: 'text', label: 'Location', default: 'all', options_source: 'location' }]);
  eq(decls.length, 1);
  eq(decls[0].options_source, 'location');
  eq(decls[0].type, 'text', 'it stays TEXT: the escaping must not change because a dropdown exists');
});
test('an unknown options_source is dropped, not passed through', () => {
  const P = g.SiloReportParams;
  const [decl] = P.normalizeDeclarations([
    { key: 'x', type: 'text', label: 'X', default: 'all', options_source: 'anything' }]);
  eq(decl.options_source, undefined);
});
test('options_source is ignored on a type that is not text', () => {
  const P = g.SiloReportParams;
  const [decl] = P.normalizeDeclarations([
    { key: 'd', type: 'date', label: 'D', default: 'today', options_source: 'location' }]);
  eq(decl.options_source, undefined);
});
// The whole safety argument: a dropdown is a convenience, and the value
// still goes through text's quoting. If this ever stopped being true the
// picker would be an injection point.
test('a choice value is still escaped as text', () => {
  const P = g.SiloReportParams;
  const [decl] = P.normalizeDeclarations([
    { key: 'location', type: 'text', label: 'Location', default: 'all', options_source: 'location' }]);
  eq(P.toLiteral(decl, "o'hare").literal, "'o''hare'");
  truthy(P.toLiteral(decl, 'x; drop table t').error, 'a semicolon is still refused');
  truthy(P.toLiteral(decl, 'a\u0000b').error, 'a control character is still refused');
});
test("the 'all' sentinel folds the predicate away", () => {
  const P = g.SiloReportParams;
  const decls = [{ key: 'location', type: 'text', label: 'Location', default: 'all', options_source: 'location' }];
  const sql = "select 1 where ({{location}} = 'all' or location_tag = {{location}})";
  eq(P.substitute(sql, decls, {}).sql, "select 1 where ('all' = 'all' or location_tag = 'all')");
  eq(P.substitute(sql, decls, { location: 'st_louis' }).sql,
    "select 1 where ('st_louis' = 'all' or location_tag = 'st_louis')");
});
// The channel slicer (20261021200000) is the same mechanism as location: a
// text parameter whose choices come from a view, because channel names are
// per company. These assert the ALLOWLIST and the escaping, which is what
// would silently turn the dropdown into a plain text box or an injection
// point.
test('channel is an allowed options_source and keeps text escaping', () => {
  const P = g.SiloReportParams;
  const [decl] = P.normalizeDeclarations([
    { key: 'channel', type: 'text', label: 'Channel', default: 'all', options_source: 'channel' }]);
  eq(decl.options_source, 'channel');
  eq(P.toLiteral(decl, "Faire (Wholesale)").literal, "'Faire (Wholesale)'");
  truthy(P.toLiteral(decl, "x'; drop table t --").error, 'a semicolon is still refused');
});
test("the channel predicate folds away on 'all' and filters otherwise", () => {
  const P = g.SiloReportParams;
  const decls = [{ key: 'channel', type: 'text', label: 'Channel', default: 'all', options_source: 'channel' }];
  const sql = "select 1 where ({{channel}} = 'all' or v.resolved_channel_name = {{channel}})";
  eq(P.substitute(sql, decls, {}).sql,
    "select 1 where ('all' = 'all' or v.resolved_channel_name = 'all')");
  eq(P.substitute(sql, decls, { channel: 'Retail (POS)' }).sql,
    "select 1 where ('Retail (POS)' = 'all' or v.resolved_channel_name = 'Retail (POS)')");
});
const r = R.summary();
process.exit(r.fail ? 1 : 0);
