/* projection-draft — prompt construction and answer validation.
 *
 * Kept out of index.ts so the two things that decide whether a draft is safe
 * can be tested by node (scripts/tests/projection-draft-lib.test.mjs):
 *   1. the model only ever sees this company's own aggregated history, and
 *   2. nothing it answers with reaches the sheet unless it names a day in the
 *      requested period and a location the caller can already read.
 *
 * The function itself never writes. It returns a proposal; the person accepts
 * it in the page, and the page's own upsert (under RLS) is the write.
 */

export const MAX_DAYS = 400;
export const MAX_LOCATIONS = 40;
export const MAX_ROWS = 4000;
export const MAX_INSTRUCTION = 2000;
/** A single day's projection above this is refused as a typo, not a plan. */
export const MAX_VALUE = 50000000;

const DAY_MS = 86400000;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function isISO(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
export function parseISO(s) {
  if (!isISO(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return isNaN(+d) ? null : d;
}
export function iso(d) { return d.toISOString().slice(0, 10); }
export function addDays(s, n) {
  const d = parseISO(s);
  return d ? iso(new Date(+d + n * DAY_MS)) : '';
}
export function datesBetween(from, to) {
  const a = parseISO(from), b = parseISO(to);
  if (!a || !b || +a > +b) return [];
  const out = [];
  for (let t = +a; t <= +b; t += DAY_MS) out.push(iso(new Date(t)));
  return out;
}
export function weekdayOf(s) {
  const d = parseISO(s);
  return d ? WD[d.getUTCDay()] : '';
}

export const key = (locationId, date) => `${locationId}|${date}`;

/** Rows from the report engine -> { 'locId|date': net sales }. */
export function indexActuals(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const id = r.location_id;
    const d = String(r.day_date || '').slice(0, 10);
    const n = Number(r.net);
    if (id == null || !isISO(d) || !Number.isFinite(n)) continue;
    m.set(key(id, d), (m.get(key(id, d)) || 0) + n);
  }
  return m;
}

/** Average of the last `count` same-weekday actuals strictly before `before`. */
export function trailingWeekdayAverage(actuals, locationId, date, before, count = 8) {
  const target = parseISO(date);
  if (!target) return null;
  let cursor = addDays(before, -1);
  while (cursor && parseISO(cursor).getUTCDay() !== target.getUTCDay()) cursor = addDays(cursor, -1);
  const vals = [];
  for (let i = 0; i < count && cursor; i++) {
    const v = actuals.get(key(locationId, cursor));
    if (Number.isFinite(v)) vals.push(v);
    cursor = addDays(cursor, -7);
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

export const SYSTEM_PROMPT = [
  'You draft daily revenue projections for one company inside SILO, an operations platform.',
  '',
  'You are given, for each location and each day of the period: the same weekday one and two',
  'years earlier (ly1, ly2 — 364 and 728 days back, so weekdays line up), the average of the',
  'eight same weekdays before the period (t8), any launch events on that day, and whether a',
  'plan already exists.',
  '',
  'Rules:',
  '- Ground every number in the history given. Do not invent a level the history does not support.',
  '- Keep the weekly shape: a Saturday should look like a Saturday.',
  '- Apply the person\'s instruction literally. "Hold flat" means last year\'s level, not growth.',
  '- A day with no history behind it: leave it out rather than guessing.',
  '- Only propose days you were asked to fill, for the locations given.',
  '- Answer only by calling propose_projections. Keep each note under 12 words, and say in the',
  '  rationale what you grew, by how much, and off which base.',
].join('\n');

export const TOOL = {
  name: 'propose_projections',
  description: 'Return the proposed daily revenue projections and one short rationale.',
  input_schema: {
    type: 'object',
    properties: {
      rationale: { type: 'string', description: 'One or two sentences: what was grown, by how much, off which base.' },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            location_id: { type: 'number', description: 'The location id exactly as given.' },
            projection_date: { type: 'string', description: 'YYYY-MM-DD, inside the period.' },
            projected_sales: { type: 'number', description: 'Net sales for that day, in dollars.' },
            note: { type: 'string', description: 'Optional, under 12 words.' },
          },
          required: ['location_id', 'projection_date', 'projected_sales'],
        },
      },
    },
    required: ['rationale', 'rows'],
  },
};

/** The company's own aggregated history, as compact lines the model reads. */
export function buildUserMessage(ctx) {
  const {
    from, to, dates, locations, actuals, launches = new Map(),
    existing = new Map(), onlyEmptyDays = true, instruction = '',
  } = ctx;
  const lines = [];
  lines.push(`Period: ${from} to ${to} (${dates.length} days).`);
  lines.push(onlyEmptyDays
    ? 'Fill only the days marked plan=none. Leave every day that already has a plan untouched.'
    : 'You may propose every day in the period, replacing any existing plan.');
  lines.push('');
  lines.push('Locations:');
  for (const l of locations) lines.push(`  ${l.id} = ${l.location_name || l.location_code || 'Location'}${l.store_type ? ` (${l.store_type})` : ''}`);
  lines.push('');
  lines.push('History and current plan, one line per location-day. Dollars, rounded.');
  lines.push('loc date weekday ly1 ly2 t8 plan launches');
  let skipped = 0;
  for (const l of locations) {
    for (const d of dates) {
      const plan = existing.get(key(l.id, d));
      if (onlyEmptyDays && plan != null) { skipped++; continue; }
      const ly1 = actuals.get(key(l.id, addDays(d, -364)));
      const ly2 = actuals.get(key(l.id, addDays(d, -728)));
      const t8 = trailingWeekdayAverage(actuals, l.id, d, from);
      const ev = (launches.get(d) || []).join('; ');
      const num = (v) => (Number.isFinite(v) ? String(Math.round(v)) : 'none');
      lines.push(`${l.id} ${d} ${weekdayOf(d)} ${num(ly1)} ${num(ly2)} ${num(t8)} ${plan == null ? 'none' : Math.round(plan)}${ev ? ' ' + ev : ''}`);
    }
  }
  if (skipped) lines.push(`(${skipped} location-days already have a plan and are not listed.)`);
  lines.push('');
  lines.push(`What the person asked for: ${String(instruction).slice(0, MAX_INSTRUCTION)}`);
  return lines.join('\n');
}

/** Pull the tool call out of an Anthropic message. */
export function readToolUse(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  for (const b of blocks) {
    if (b?.type === 'tool_use' && b?.name === TOOL.name && b.input && typeof b.input === 'object') {
      return { rationale: String(b.input.rationale || ''), rows: Array.isArray(b.input.rows) ? b.input.rows : [] };
    }
  }
  const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(' ').trim();
  return { rationale: text.slice(0, 400), rows: [] };
}

/**
 * Keep only rows the caller could have written by hand anyway. The page
 * validates again before showing them; both layers exist because this one is
 * what stops a prompt-injected or confused answer reaching a save at all.
 */
export function clampRows(rows, opts) {
  const { dates = [], locationIds = [], existing = new Map(), onlyEmptyDays = true } = opts || {};
  const okDate = new Set(dates);
  const okLoc = new Set(locationIds.map(String));
  const seen = new Set();
  const out = [], dropped = [];
  for (const r of rows || []) {
    const date = String(r?.projection_date || '').slice(0, 10);
    const locationId = r?.location_id;
    const value = Number(r?.projected_sales);
    const reason = !okDate.has(date) ? 'date outside the period'
      : !okLoc.has(String(locationId)) ? 'location not in the request'
      : !Number.isFinite(value) || value < 0 ? 'not a positive number'
      : value > MAX_VALUE ? 'implausibly large'
      : seen.has(key(locationId, date)) ? 'duplicate day'
      : (onlyEmptyDays && existing.get(key(locationId, date)) != null) ? 'day already planned'
      : out.length >= MAX_ROWS ? 'over the row limit'
      : null;
    if (reason) { dropped.push({ date, location_id: locationId, reason }); continue; }
    seen.add(key(locationId, date));
    out.push({
      location_id: locationId,
      projection_date: date,
      projected_sales: Math.round(value * 100) / 100,
      note: r?.note == null ? '' : String(r.note).slice(0, 200),
    });
  }
  return { rows: out, dropped };
}

/** What the request is allowed to ask for. Refusals are the caller's fault. */
export function validateRequest(body, visibleLocationIds) {
  const from = String(body?.from || '').slice(0, 10);
  const to = String(body?.to || '').slice(0, 10);
  if (!isISO(from) || !isISO(to)) return { error: 'from and to must be YYYY-MM-DD dates' };
  const dates = datesBetween(from, to);
  if (!dates.length) return { error: 'from must not be after to' };
  if (dates.length > MAX_DAYS) return { error: `a period of at most ${MAX_DAYS} days, please` };
  const asked = Array.isArray(body?.location_ids) ? body.location_ids : [];
  if (!asked.length) return { error: 'location_ids is required' };
  const visible = new Set((visibleLocationIds || []).map(String));
  const locationIds = [...new Set(asked.map((v) => v))].filter((v) => visible.has(String(v)));
  if (!locationIds.length) return { error: 'none of those locations are readable in the active company' };
  if (locationIds.length > MAX_LOCATIONS) return { error: `at most ${MAX_LOCATIONS} locations per draft` };
  const instruction = String(body?.instruction || '').trim();
  if (!instruction) return { error: 'instruction is required' };
  return {
    from, to, dates, locationIds,
    instruction: instruction.slice(0, MAX_INSTRUCTION),
    onlyEmptyDays: body?.only_empty_days !== false,
  };
}

/* ---------------------------------------------------------------------------
 * action: 'scenario' — the assumptions behind a scenario, for
 * /v2/planning-scenarios-v2.html.
 *
 * The page sends the monthly facts it already computed and shows (last year,
 * the projection, the current plan, mix and price). They are aggregates of
 * data the caller can already read, and the answer is written into the same
 * boxes the person types into, so nothing here is a new way to reach data or
 * to change anything. The function still bounds the size and the shape.
 * ------------------------------------------------------------------------- */

export const MAX_SCENARIO_MONTHS = 48;

export const SCENARIO_SYSTEM = [
  'You set the assumptions behind a merchandise planning scenario in SILO.',
  '',
  'You are given one line per month: last year\'s revenue for the scope, the revenue projection if',
  'there is one, and the plan, product mix % and average selling price the page is using now.',
  '',
  'Rules:',
  '- Ground every number in the months given. Keep the seasonal shape of last year.',
  '- growth_pct is the single lift applied on top of the monthly plan. Use it for "grow 25%".',
  '- Only return a month\'s plan_revenue, mix_pct or price when the request actually changes it;',
  '  leave the rest out and the page keeps its own figure.',
  '- mix_pct is a percentage between 0 and 100. price is in dollars.',
  '- Say in the rationale what you changed, by how much, and off which base.',
  '- Answer only by calling set_scenario.',
].join('\n');

export const SCENARIO_TOOL = {
  name: 'set_scenario',
  description: 'Set the growth tested and, where the request changes them, the monthly assumptions.',
  input_schema: {
    type: 'object',
    properties: {
      rationale: { type: 'string', description: 'One or two sentences: what changed, by how much, off which base.' },
      growth_pct: { type: 'number', description: 'The lift on top of the plan, as a percentage. 25 means +25%.' },
      months: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            month: { type: 'string', description: 'YYYY-MM, one of the months given.' },
            plan_revenue: { type: 'number' },
            mix_pct: { type: 'number', description: '0 to 100.' },
            price: { type: 'number', description: 'Dollars.' },
          },
          required: ['month'],
        },
      },
    },
    required: ['rationale', 'growth_pct'],
  },
};

export function validateScenarioRequest(body) {
  const instruction = String(body?.instruction || '').trim();
  if (!instruction) return { error: 'instruction is required' };
  const months = Array.isArray(body?.months) ? body.months : [];
  if (!months.length) return { error: 'months is required' };
  if (months.length > MAX_SCENARIO_MONTHS) return { error: `at most ${MAX_SCENARIO_MONTHS} months per scenario` };
  const clean = [];
  for (const m of months) {
    const month = String(m?.month || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return { error: `month must be YYYY-MM, got ${month || 'nothing'}` };
    const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0);
    clean.push({
      month,
      last_year: n(m.last_year), projection: n(m.projection),
      plan: n(m.plan), mix_pct: n(m.mix_pct), price: n(m.price),
    });
  }
  return {
    instruction: instruction.slice(0, MAX_INSTRUCTION),
    months: clean,
    productType: String(body?.product_type || '__ALL__').slice(0, 120),
    channel: String(body?.channel || '__ALL__').slice(0, 40),
    planMode: body?.plan_mode === 'historical' ? 'historical' : 'revenue_plan',
  };
}

export function buildScenarioMessage(req) {
  const lines = [];
  lines.push(`Mode: ${req.planMode === 'historical' ? 'historical lift' : 'revenue plan (plan x mix / price)'}.`);
  lines.push(`Scope: product type ${req.productType === '__ALL__' ? 'all' : req.productType}, channel ${req.channel === '__ALL__' ? 'all' : req.channel}.`);
  lines.push('');
  lines.push('month last_year projection current_plan mix_pct price');
  for (const m of req.months) {
    lines.push(`${m.month} ${Math.round(m.last_year)} ${m.projection ? Math.round(m.projection) : 'none'} ${Math.round(m.plan)} ${m.mix_pct} ${m.price}`);
  }
  lines.push('');
  lines.push(`What the person asked for: ${req.instruction}`);
  return lines.join('\n');
}

/** Keep only months that were offered, and values that are plausible. */
export function clampScenarioAnswer(answer, months) {
  const known = new Set(months.map((m) => m.month));
  const growth = Number(answer?.growth_pct);
  const out = [];
  for (const row of Array.isArray(answer?.months) ? answer.months : []) {
    const month = String(row?.month || '').slice(0, 7);
    if (!known.has(month)) continue;
    const entry = { month };
    const plan = Number(row?.plan_revenue);
    const mix = Number(row?.mix_pct);
    const price = Number(row?.price);
    if (Number.isFinite(plan) && plan > 0 && plan <= MAX_VALUE) entry.plan_revenue = Math.round(plan);
    if (Number.isFinite(mix) && mix > 0 && mix <= 100) entry.mix_pct = Math.round(mix * 100) / 100;
    if (Number.isFinite(price) && price > 0 && price <= 100000) entry.price = Math.round(price * 100) / 100;
    if (Object.keys(entry).length > 1) out.push(entry);
  }
  return {
    growth_pct: Number.isFinite(growth) ? Math.max(-100, Math.min(500, Math.round(growth * 10) / 10)) : 0,
    months: out,
    rationale: String(answer?.rationale || '').slice(0, 1200),
  };
}

/** Read a set_scenario call out of an Anthropic message. */
export function readScenarioToolUse(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  for (const b of blocks) {
    if (b?.type === 'tool_use' && b?.name === SCENARIO_TOOL.name && b.input && typeof b.input === 'object') return b.input;
  }
  const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(' ').trim();
  return { rationale: text.slice(0, 400), months: [] };
}
