// supabase/functions/silo-chat/query-shape-lib.mjs
//
// Two statement shapes that are correct, that the model writes all the time,
// and that ROW-LEVEL SECURITY turns into full-history scans. Both are rewritten
// to a value-identical shape before the statement runs.
//
// Found on 2026-09-28 tracing Loomis's executive-summary request: four of its
// eighteen statements died at the 8s timeout and the answer shipped without
// its channel split or its bottom sellers. Every one was a shape problem, not a
// size problem -- measured as `authenticated` under his own RLS:
//
//   90 days of sales_by_day by product, `current_date - interval '90 days'`
//       8,170 ms  ->  388 ms  with `current_date - 90`
//   180 days by channel, `location_tag = any(silo_channel_location_tags('x'))`
//       > 60,000 ms  ->  278 ms  with the call hoisted
//   90 days of ONLINE sales, the documented filter form, no other change
//       28,943 ms  (every online question past ~25 days was timing out)
//
// A longer statement timeout would have rescued none of the channel queries
// and would have spent the request's wall-clock budget waiting on the rest.
//
// WHY THESE SHAPES ARE SLOW
//
// 1. `date - interval` is a TIMESTAMP. Comparing a date column with it uses the
//    cross-type operator date >= timestamp, which is not LEAKPROOF, and Postgres
//    may not evaluate a non-leakproof user predicate ahead of an RLS policy. So
//    the bound cannot enter the index condition: the scan reads the company's
//    entire history and filters afterwards. `date - integer` is a date, the
//    comparison is date >= date (leakproof), and the bound goes into the index.
//
// 2. silo_channel_location_tags() is a STABLE SQL function with a FROM clause,
//    so it is not inlined and Postgres does not cache it: it re-runs once per
//    row, and every run calls active_company_id() and reads `locations`. As a
//    scalar sub-select it becomes an InitPlan, evaluated once per statement.
//    The `::text[]` is required, not decoration: `= any((select f()))` parses as
//    ANY over a SUBQUERY and fails with "operator does not exist: text = text[]"
//    -- which the same traced request hit when the model tried this by hand.
//
// WHY A REWRITE AND NOT MORE GUIDANCE
//
// The prompt already told the model to tighten a timed-out query, and it did,
// three times, each time keeping the shape that made it slow. This file's
// neighbours record the same lesson (index.ts on annotateColumnError: "guidance
// demonstrably is not the lever"). Both rewrites are value-identical by
// construction, and the rewritten text is what is stored and re-run by Saved
// reports and dashboards, so they get the fast shape too.
//
// What is deliberately NOT rewritten: `now() - interval ...` (a moment, not a
// day -- converting it would move the boundary), hours/minutes/seconds (same),
// a channel-tags call whose argument is not a string literal (a correlated call
// cannot be hoisted), and anything inside a string literal or comment.

/** Units that are a whole number of days, so `current_date - N` is exact. */
const DAY_UNITS = { day: 1, days: 1, week: 7, weeks: 7 };
/** Calendar units: the day count varies, so the interval is kept and the
 *  result cast back to date. Still exact -- date ± month interval is midnight. */
const CALENDAR_UNITS = new Set(['month', 'months', 'mon', 'mons', 'year', 'years']);

/**
 * Split SQL into code and non-code spans, so a rewrite never touches the inside
 * of a string literal, a quoted identifier or a comment. Dollar quoting is not
 * handled because chat_run_readonly_query's own checks make it unreachable in
 * practice; an unmatched opener simply leaves the rest of the text untouched.
 */
function segments(sql) {
  const out = [];
  let i = 0;
  let code = '';
  const flush = () => { if (code) { out.push({ code: true, text: code }); code = ''; } };
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    let end = -1;
    if (c === "'") {
      // '' is an escaped quote inside a literal.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") break;
        j++;
      }
      end = j < sql.length ? j + 1 : sql.length;
    } else if (c === '"') {
      const j = sql.indexOf('"', i + 1);
      end = j === -1 ? sql.length : j + 1;
    } else if (two === '--') {
      const j = sql.indexOf('\n', i);
      end = j === -1 ? sql.length : j;
    } else if (two === '/*') {
      const j = sql.indexOf('*/', i + 2);
      end = j === -1 ? sql.length : j + 2;
    }
    if (end === -1) { code += c; i++; continue; }
    flush();
    out.push({ code: false, text: sql.slice(i, end) });
    i = end;
  }
  flush();
  return out;
}

// A literal interval is `interval 'N unit'` or `'N unit'::interval`. Only one
// quantity and one unit: '1 month 3 days' is left alone rather than half-parsed.
// The literal sits in a NON-code segment, so these patterns run over a
// placeholder-joined string (see rewriteCode) in which each literal is `\u0000k\u0000`.
const LIT = '\\u0000(\\d+)\\u0000';

/**
 * Rewrite the two slow shapes. Returns `{ sql, rewrites }` where `rewrites`
 * names each change (for the diagnostics log). Unchanged input returns the
 * same string and an empty list.
 */
export function rewriteSlowShapes(sql) {
  const input = String(sql ?? '');
  const parts = segments(input);
  // Join code with placeholders for the non-code spans, rewrite, then restore.
  // This lets a pattern span `interval '90 days'` (code + literal) while
  // guaranteeing no rewrite ever lands INSIDE a literal or comment.
  const literals = [];
  let joined = '';
  for (const p of parts) {
    if (p.code) joined += p.text;
    else { joined += `\u0000${literals.length}\u0000`; literals.push(p.text); }
  }
  const lit = (k) => literals[Number(k)];
  const litBody = (k) => {
    const t = lit(k);
    return t && t[0] === "'" ? t.slice(1, -1).replace(/''/g, "'") : null;
  };
  const rewrites = [];

  // --- 1. <date> ± interval --------------------------------------------------
  // The base must be an expression of type DATE, or the rewrite changes the
  // value: current_date, and silo_business_today()/_yesterday(), which return
  // date and are what the prompt tells the model to anchor business days on.
  // Missing those two was the gap found on the first live re-run (2026-09-28
  // 15:32): `silo_business_today() - INTERVAL '13 months'` timed out twice.
  const BASE = '(current_date|(?:public\\s*\\.\\s*)?silo_business_(?:today|yesterday)\\s*\\(\\s*\\))';
  const intervalForms = [
    // current_date - interval '90 days'
    new RegExp(`\\b${BASE}\\s*([-+])\\s*interval\\s*${LIT}`, 'gi'),
    // current_date - '90 days'::interval
    new RegExp(`\\b${BASE}\\s*([-+])\\s*${LIT}\\s*::\\s*interval\\b`, 'gi'),
  ];
  for (const re of intervalForms) {
    joined = joined.replace(re, (whole, base, op, k) => {
      const body = litBody(k);
      const m = body && /^\s*(\d+)\s+([a-z]+)\s*$/i.exec(body);
      if (!m) return whole;
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      if (DAY_UNITS[unit]) {
        rewrites.push('date_interval');
        return `(${base} ${op} ${n * DAY_UNITS[unit]})`;
      }
      if (CALENDAR_UNITS.has(unit)) {
        rewrites.push('date_interval');
        const rhs = whole.slice(whole.indexOf(op) + 1).trim();
        return `(${base} ${op} ${rhs})::date`;
      }
      return whole;
    });
  }

  // --- 2. hoist silo_channel_location_tags('<literal>') -----------------------
  // Skip a call that is already the sole content of a scalar sub-select.
  const tagsCall = new RegExp(`((?:\\bpublic\\s*\\.\\s*)?\\bsilo_channel_location_tags\\s*\\(\\s*${LIT}\\s*\\))`, 'gi');
  joined = joined.replace(tagsCall, (whole, call, k, offset, str) => {
    if (!lit(k) || lit(k)[0] !== "'") return whole;
    const before = str.slice(0, offset);
    if (/\(\s*select\s+$/i.test(before)) return whole;
    rewrites.push('channel_tags_hoist');
    return `(select ${call})::text[]`;
  });

  if (!rewrites.length) return { sql: input, rewrites };
  const out = joined.replace(/\u0000(\d+)\u0000/g, (_, k) => lit(k));
  return { sql: out, rewrites: [...new Set(rewrites)] };
}

// A relation that is slow whatever the statement looks like, because it
// aggregates ALL history before any filter applies -- so a timed-out query on
// it retried with a narrower date filter times out again. Seen on the same
// live re-run: `sales_monthly_location_rollup_v` timed out twice in a row,
// the second time with `month_start >= '2026-07-01'`. No rewrite can fix a
// view's shape, so the timeout itself names the pre-computed alternative.
// Measured 2026-09-28 as authenticated: the alternative below answers 13
// months by location in 2.2 s, and its Jul-Aug net by location matched the
// slow view exactly.
const SLOW_RELATION_HINTS = {
  sales_monthly_location_rollup_v:
    'sales_monthly_location_rollup_v adds up every day of sales history before any filter applies, so a date filter does not make it faster -- do not retry it. '
    + 'For COMPLETED months use sales_monthly_product_type_rollup_v instead (same month_start, location, units, net, gross, total_sales columns): '
    + 'SUM(net) ... GROUP BY month_start, location. Do not sum its unique_skus across product types. '
    + 'It is pre-computed as of the last completed sync, so it can lag sales_by_day: for the CURRENT month or any period ending today, '
    + 'query sales_by_day directly with a day_date range instead (e.g. day_date >= date_trunc(\'month\', current_date)::date).',
  sales_sku_location_rollup_v:
    'sales_sku_location_rollup_v adds up every day of sales history per SKU and location before any filter applies -- do not retry it unfiltered. '
    + 'Filter it by sku, or use sales_velocity_by_sku_location_v for recent movement -- pre-computed as of the last completed sync, '
    + 'so for today\'s or this week\'s movement query sales_by_day with a day_date range instead.',
};

/** Hint for a statement timeout, naming the pre-computed path when the
 *  statement read a relation that cannot be made fast by filtering. Returns
 *  null when there is nothing specific to say. */
export function timeoutHint(message, relations = []) {
  if (!/statement timeout/i.test(String(message || ''))) return null;
  const hints = [...new Set(relations)].map((r) => SLOW_RELATION_HINTS[r]).filter(Boolean);
  return hints.length ? hints.join(' ') : null;
}
