// supabase/functions/silo-chat/evidence-scope.mjs
//
// WHAT A QUERY RESULT IS SCOPED TO, attached to the result itself.
//
// The failure this exists for, from two traced answers on 2026-09-16
// (silo_chat_audit_log c0b642ca… and 7c90b2cd…). Both ran correct SQL. Both
// published a figure under a label the SQL never supported:
//
//   * A week's ad spend was summed from marketing_daily_totals_v -- a view
//     with NO platform column, so every figure in it is already pooled across
//     Meta + Google + TikTok. $118,945.91 came back. The answer called it
//     "Meta ad spend" and paired it with Meta-only attributed value
//     ($115,638.28) and a Meta-only ROAS of 1.01. The per-platform split
//     ($114,334.99 Meta / $4,610.92 Google) was sitting in the VERY NEXT tool
//     result. Nothing about either result said which one was which.
//   * Ads were selected by `meta_ad_creatives.body ilike '%sonic%'` with no
//     campaign predicate at all, then the Sep 1-7 total was described as one
//     campaign moving off lead generation. That population was $25,488.06 in
//     "Purchase Campaigns" and $0.00 in "Subscribers" -- two campaigns, not
//     one.
//
// Neither is a SQL bug and neither is fixed by more arithmetic. By the time
// the answer is written the model is looking at fifteen anonymous JSON arrays
// and has to REMEMBER, unaided, that result 8 was all-platform and result 9
// was per-platform. So the scope stops being something to remember: it is
// computed here from the statement plus the schema catalog, and travels back
// glued to the rows.
//
// WHAT THIS IS AND IS NOT:
//   * It is derived from the STATEMENT TEXT and from column lists that
//     silo_chat_schema_catalog auto-generates from pg_catalog. Both of those
//     are facts. It is NOT a verification of the returned VALUES, it does not
//     execute anything, and it cannot see semantics.
//   * It is deliberately biased toward reporting a WIDER scope than reality.
//     A dimension mentioned but not clearly filtered is reported as pooled.
//     Over-reporting pooling makes an answer over-qualify; under-reporting it
//     reproduces the exact bug above.
//   * Every envelope carries that caveat in `derivation`, so nothing here can
//     be read back as a mechanical check of the numbers. It is metadata about
//     the QUERY, presented as such.
//
// Kept out of index.ts so it can be executed by a test, same reason as
// seo-lib.mjs. index.ts holds the wiring; this holds the rules.

/** Column names that SCOPE a metric: knowing the value changes what the
 *  number means. Fixed list on purpose -- it is matched against the catalog's
 *  own auto-generated column lists, so a relation only ever reports the ones
 *  it really has, and a schema change cannot make this claim something false.
 *  Ordered roughly by how often mislabelling one has produced a wrong answer.
 */
export const SCOPE_COLUMNS = [
  'platform',
  'campaign_name',
  'campaign_id',
  'adset_name',
  'ad_id',
  'ad_name',
  'objective',
  'source_name',
  'channel',
  'location_name',
  'location_tag',
  'shop_domain',
  'product_type',
  'search_type',
];

/** Date/time columns are handled separately from the list above: a window is
 *  not a category, and "which days" needs its own reporting (a bucket that
 *  crosses a launch is the second failure this module exists for). */
const DATE_TYPE_RE = /^(date|timestamp|timestamptz|timestamp with time zone|timestamp without time zone)$/i;

/** Schemas whose relations are plumbing, not business evidence. A discovery
 *  query against information_schema needs no scope envelope and would only
 *  spend tokens. */
const NON_EVIDENCE_PREFIX = /^(information_schema|pg_catalog|pg_)/i;

/** The per-page row cap in chat_run_readonly_query (20260904320000 raised it
 *  from 500). run_sql does NOT pass p_offset, so a result at exactly the cap
 *  is a first page presented as a whole answer -- worth saying out loud. */
export const QUERY_ROW_CAP = 1000;

const MAX_RELATIONS_REPORTED = 8;
const MAX_VALUES_REPORTED = 6;
const MAX_DATE_LITERALS_REPORTED = 14;

/** Replace every single-quoted literal with a placeholder so structural
 *  matching cannot be fooled by the CONTENTS of a string, and so the literals
 *  can still be recovered by index afterwards. Also strips -- and block
 *  comments. Returns lowercased text plus the literal table. */
export function denoise(sql) {
  const literals = [];
  let out = '';
  let i = 0;
  const src = String(sql || '');
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'") {
      let j = i + 1;
      let val = '';
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") { val += "'"; j += 2; continue; }
        if (src[j] === "'") break;
        val += src[j];
        j++;
      }
      out += `'@${literals.length}'`;
      literals.push(val);
      i = j + 1;
      continue;
    }
    if (ch === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out.toLowerCase(), literals };
}

/** Names bound by a WITH clause. They are query-local, not relations, and
 *  reporting one as a table would invite a claim about a table that does not
 *  exist. */
export function cteNames(denoisedText) {
  const names = new Set();
  const re = /(?:^|[\s,(])with\s+(?:recursive\s+)?([a-z_][a-z0-9_]*)\s+as\s*(?:materialized\s+|not\s+materialized\s+)?\(/g;
  let m;
  while ((m = re.exec(denoisedText))) names.add(m[1]);
  // Subsequent `, name as (` bindings in the same WITH list.
  const chain = /,\s*([a-z_][a-z0-9_]*)\s+as\s*(?:materialized\s+|not\s+materialized\s+)?\(\s*(?:select|with)\b/g;
  while ((m = chain.exec(denoisedText))) names.add(m[1]);
  return names;
}

/** Relations the statement actually reads, in first-appearance order. */
export function relationsInStatement(sql) {
  const { text } = denoise(sql);
  const ctes = cteNames(text);
  const found = [];
  const seen = new Set();
  const re = /\b(?:from|join)\s+((?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*)/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1];
    const bare = raw.includes('.') ? raw.split('.').pop() : raw;
    const schema = raw.includes('.') ? raw.split('.')[0] : null;
    if (ctes.has(bare) && !schema) continue;
    if (NON_EVIDENCE_PREFIX.test(schema || bare)) continue;
    if (seen.has(bare)) continue;
    seen.add(bare);
    found.push(bare);
  }
  return found;
}

/** Every ISO date written into the statement, sorted and deduped. These are
 *  the window edges AND, when a CASE buckets a range, the bucket boundaries
 *  -- which is what makes "the week of Aug 31" legible as a period that
 *  straddles a Sep 1 launch instead of a number labelled "the following
 *  week". */
export function dateLiteralsIn(sql) {
  const { literals } = denoise(sql);
  const dates = new Set();
  for (const lit of literals) {
    const t = String(lit).trim();
    if (/^\d{4}-\d{2}-\d{2}(?:[ t].*)?$/.test(t)) dates.add(t.slice(0, 10));
  }
  return [...dates].sort();
}

/** Does the statement mention this exact identifier? Word-bounded so
 *  `platform` does not match inside `platform_conversion_value`. */
function mentions(text, col) {
  return new RegExp(`(?<![a-z0-9_])${col}(?![a-z0-9_])`).test(text);
}

/** How a column is restricted, and by what.
 *
 *  Returns one of four kinds:
 *    'included'  -- `= 'x'` / `in ('x','y')`. `values` is what the result IS.
 *    'excluded'  -- `<> 'x'` / `!= 'x'` / `not in ('x')`. `values` is what the
 *                   result is NOT. Reporting these as `included` was the cycle-1
 *                   finding: a correct non-Meta total came back carrying
 *                   `narrowed_to: platform = ['meta_ads']`, which is this module
 *                   making exactly the mislabelling it exists to prevent.
 *    'restricted'-- a predicate exists whose effect cannot be written as a value
 *                   list (a range, LIKE, IS NULL). Narrower than pooled, but the
 *                   population is not one value either, so it says neither.
 *    null        -- no predicate found; the caller treats it as pooled.
 *
 *  Two things deliberately do NOT count as a restriction, both found by the
 *  fixture tests rather than by reading:
 *   - `a.ad_id = b.ad_id` is a JOIN KEY. The right-hand side must be a literal
 *     or a number, or the column is still pooled.
 *   - a predicate's value list stops at that predicate. An unbounded scan
 *     forward attributed `campaign_name = 'Subscribers'` to the `platform`
 *     filter sitting two tokens earlier.
 */
function columnRestriction(text, literals, col) {
  const included = [];
  const excluded = [];
  let restricted = false;
  const refs = (seg) => {
    const out = [];
    for (const r of seg.match(/'@(\d+)'/g) || []) {
      const v = literals[Number(r.slice(2, -1))];
      if (v != null) out.push(v);
    }
    return out;
  };
  const add = (into, seg) => {
    for (const v of refs(seg)) if (!into.includes(v)) into.push(v);
  };

  // IN / NOT IN. The `not` is captured, not swallowed, which is the fix.
  const inList = new RegExp(`(?<![a-z0-9_])${col}\\s+(not\\s+)?in\\s*\\(([^()]*)\\)`, 'g');
  let m;
  while ((m = inList.exec(text))) add(m[1] ? excluded : included, m[2]);

  // = vs <> / != . Same fix: the operator decides which list the value joins.
  const equality = new RegExp(
    `(?<![a-z0-9_])${col}\\s*(=|<>|!=)\\s*('@\\d+'|-?\\d+(?:\\.\\d+)?)`, 'g',
  );
  while ((m = equality.exec(text))) add(m[1] === '=' ? included : excluded, m[2]);

  // Anything else that narrows but cannot be stated as values. `not like` is
  // matched here rather than left to fall through as pooled, and `is not null`
  // lands here rather than being reported as a narrowing to some value.
  const ranged = new RegExp(
    `(?<![a-z0-9_])${col}\\s*(?:(?:not\\s+)?(?:<=|>=|<|>|~~|between\\b|like\\b|ilike\\b)|is\\s+(?:not\\s+)?null)`,
  );
  if (ranged.test(text)) restricted = true;

  if (included.length) {
    return {
      kind: 'included',
      values: included.slice(0, MAX_VALUES_REPORTED),
      ...(excluded.length ? { excluded: excluded.slice(0, MAX_VALUES_REPORTED) } : {}),
    };
  }
  if (excluded.length) return { kind: 'excluded', values: excluded.slice(0, MAX_VALUES_REPORTED) };
  if (restricted) return { kind: 'restricted', values: [] };
  return { kind: null, values: [] };
}

function groupedOn(text, col) {
  const gb = /group\s+by\s+([\s\S]*?)(?:\border\s+by\b|\blimit\b|\bhaving\b|\bwindow\b|$)/g;
  let m;
  while ((m = gb.exec(text))) {
    if (mentions(m[1], col)) return true;
  }
  return false;
}

/** Build the lookup this module needs out of the rows index.ts already
 *  fetches from silo_chat_schema_catalog. No extra round trip. */
export function buildCatalogIndex(rows) {
  const map = new Map();
  for (const r of rows || []) {
    if (!r || typeof r.relname !== 'string') continue;
    map.set(r.relname, {
      relkind: r.relkind || null,
      columns: Array.isArray(r.columns) ? r.columns : [],
    });
  }
  return map;
}

/** What the statement's date predicates actually bound, which is a different
 *  question from which dates it happens to mention.
 *
 *  The cycle-1 finding was that those two were conflated in both directions:
 *  `day_date >= current_date - 30` has no ISO literal, so it was reported as
 *  "not restricted -- covers every date", and `day_date >= '2026-09-01'` has
 *  one, so it was reported as a window from 1 September TO 1 September. The
 *  first is a month of data described as all history; the second is an
 *  open-ended range described as a single day. Both are the envelope asserting
 *  a period the statement never set.
 *
 *  So bounds are read from the OPERATORS, and a window is only ever published
 *  when both ends are actually bounded. The right-hand side must be a literal,
 *  a number, or a date function -- `a.day_date = b.day_date` is a join, not a
 *  window, and would otherwise report a fully bounded period on a query with no
 *  date filter at all.
 */
export function dateBounds(text, dateColumns) {
  // DISJOINT PERIODS ARE NOT ONE WINDOW. A year-on-year query --
  // `day_date between '2025-09-01' and '2025-09-07' or day_date between
  // '2026-09-01' and '2026-09-07'` -- reads two seven-day periods, and
  // reporting min..max of its literals called that a 372-day window. Cycle-2
  // finding, and the third instance of the same root error: the envelope
  // asserting a period the statement never set.
  //
  // Detection is a heuristic, deliberately so, and it fails CLOSED. The text is
  // split on OR and a branch counts only if it carries a predicate on a date
  // column, so an unrelated disjunction -- `(platform = 'a' or platform = 'b')
  // and day_date between x and y` -- leaves ONE date branch and still publishes
  // its window. Two or more date branches means no window is published at all;
  // under-reporting a period is recoverable, asserting a wrong one is not.
  const datePredicate = (seg) => dateColumns.some((col) =>
    new RegExp(`(?<![a-z0-9_])${col}\\s*(?:>=|<=|<>|!=|=|>|<)`).test(seg)
    || new RegExp(`(?<![a-z0-9_])${col}\\s+(?:not\\s+)?(?:between|in)\\b`).test(seg));
  const dateBranches = text.split(/\bor\b/).filter(datePredicate).length;

  return { ...readBounds(text, dateColumns), disjoint: dateBranches > 1, dateBranches };
}

/** The bound directions a statement's date predicates establish, ignoring how
 *  they are combined. dateBounds() adds the combining question on top. */
function readBounds(text, dateColumns) {
  const RHS = "('@\\d+'|-?\\d+(?:\\.\\d+)?|current_date|current_timestamp|localtimestamp|now\\s*\\(|date\\s*'|interval\\s)";
  let any = false;
  let lower = false;
  let upper = false;
  for (const col of dateColumns) {
    // A NEGATED range or set restricts without BOUNDING: `not between 'a' and
    // 'b'` reaches both edges of the data with a hole in the middle, so
    // treating it as a window would publish the excluded range as the period.
    const between = new RegExp(`(?<![a-z0-9_])${col}\\s+(not\\s+)?between\\b`).exec(text);
    if (between) { any = true; if (!between[1]) { lower = true; upper = true; } }
    const inSet = new RegExp(`(?<![a-z0-9_])${col}\\s+(not\\s+)?in\\s*\\(\\s*'@`).exec(text);
    if (inSet) { any = true; if (!inSet[1]) { lower = true; upper = true; } }
    const ops = new RegExp(`(?<![a-z0-9_])${col}\\s*(>=|<=|<>|!=|=|>|<)\\s*${RHS}`, 'g');
    let m;
    while ((m = ops.exec(text))) {
      any = true;
      const op = m[1];
      if (op === '=') { lower = true; upper = true; }
      else if (op === '>=' || op === '>') lower = true;
      else if (op === '<=' || op === '<') upper = true;
      // <> / != narrow without bounding either end.
    }
  }
  return { any, lower, upper };
}

/** Each `col between 'a' and 'b'` written into the statement, in order, deduped.
 *  Only BETWEEN: it is the one form whose two edges are unambiguously a pair.
 *  Used to name the separate periods of a disjoint query, and only when every
 *  OR-branch is one of these -- otherwise a branch would be missing from the
 *  list and a short list reads as the whole answer. */
export function betweenRanges(text, literals, dateColumns) {
  const out = [];
  const seen = new Set();
  for (const col of dateColumns) {
    const re = new RegExp(
      `(?<![a-z0-9_])${col}\\s+between\\s+'@(\\d+)'\\s+and\\s+'@(\\d+)'`, 'g',
    );
    let m;
    while ((m = re.exec(text))) {
      const from = literals[Number(m[1])];
      const to = literals[Number(m[2])];
      if (from == null || to == null) continue;
      const key = `${from}|${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from, to });
    }
  }
  return out;
}

/**
 * The scope envelope for one executed statement.
 *
 * @param sql            the statement as run
 * @param catalogIndex   Map from buildCatalogIndex()
 * @param meta           { resultId, rowCount }
 */
export function describeEvidenceScope(sql, catalogIndex, meta = {}) {
  const { text, literals } = denoise(sql);
  const rels = relationsInStatement(sql);
  const aggregates = /\b(?:sum|avg|count|min|max|round)\s*\(/.test(text) || /\bgroup\s+by\b/.test(text);
  const known = [];
  const unmapped = [];
  for (const name of rels.slice(0, MAX_RELATIONS_REPORTED)) {
    (catalogIndex && catalogIndex.get(name) ? known : unmapped).push(name);
  }

  const pooled = [];
  const narrowed = [];
  const excluded = [];
  const restrictedOnly = [];
  const brokenOut = [];
  const absent = [];
  const dateColumns = new Set();

  for (const name of known) {
    const entry = catalogIndex.get(name);
    const colNames = new Set((entry.columns || []).map((c) => String(c && c.name || '').toLowerCase()));
    for (const c of entry.columns || []) {
      if (c && DATE_TYPE_RE.test(String(c.type || ''))) dateColumns.add(String(c.name).toLowerCase());
    }
    for (const col of SCOPE_COLUMNS) {
      if (!colNames.has(col)) continue;
      // A filter is checked BEFORE a GROUP BY, because a column can be both
      // and the filter is the stronger fact: `platform='meta_ads' ... group by
      // campaign_name` restricts the population, while the grouping only says
      // how the restricted population was split. Reporting the grouping alone
      // loses the restriction, which is how a one-campaign result reads as
      // every campaign.
      const r = columnRestriction(text, literals, col);
      if (r.kind === 'included') {
        narrowed.push({ relation: name, column: col, values: r.values, ...(r.excluded ? { also_excluding: r.excluded } : {}) });
        continue;
      }
      if (r.kind === 'excluded') {
        excluded.push({ relation: name, column: col, values: r.values });
        continue;
      }
      if (r.kind === 'restricted') {
        restrictedOnly.push({ relation: name, column: col });
        continue;
      }
      if (groupedOn(text, col)) brokenOut.push({ relation: name, column: col });
      else pooled.push({ relation: name, column: col });
    }
    // THE CASE A READER CANNOT NOTICE: a relation that carries none of these
    // columns at all. marketing_daily_totals_v has no platform, campaign, ad
    // or channel column -- every figure in it is already summed across all of
    // them, and there is no column missing from the query to give that away.
    // Only reported where the statement AGGREGATES, because that is when a
    // pooled figure becomes a number someone will label.
    if (aggregates && !SCOPE_COLUMNS.some((col) => colNames.has(col))) {
      absent.push({
        relation: name,
        carries_none_of: SCOPE_COLUMNS.filter((col) => anyRelationHasAnywhere(catalogIndex, col)).slice(0, 6),
      });
    }
  }

  const dates = dateLiteralsIn(sql);
  const bounds = dateBounds(text, [...dateColumns]);

  const rowCount = Number.isFinite(meta.rowCount) ? meta.rowCount : null;
  const atCap = rowCount === QUERY_ROW_CAP;

  return {
    ...(meta.resultId ? { result_id: meta.resultId } : {}),
    relations: known,
    ...(unmapped.length ? { relations_not_in_schema_map: unmapped } : {}),
    ...(rowCount != null ? { row_count: rowCount } : {}),
    ...(atCap
      ? { page_cap_reached: `exactly ${QUERY_ROW_CAP} rows came back, which is the per-page cap -- this is the FIRST PAGE, not necessarily the whole result. Re-query with a narrower scope or an aggregate before ranking, counting or calling anything absent.` }
      : {}),
    ...(narrowed.length ? { narrowed_to: narrowed } : {}),
    // EXCLUSION IS NOT INCLUSION. `platform <> 'meta_ads'` means the result is
    // everything BUT Meta; folding that value into narrowed_to told the reader
    // the opposite of what the statement asked for.
    ...(excluded.length ? { excludes: excluded } : {}),
    ...(restrictedOnly.length
      ? {
          restricted_no_readable_values: restrictedOnly,
          restricted_no_readable_values_means:
            'a predicate narrows this column (a range, a LIKE, a null test) but its effect cannot be written as a value list. The result is neither one value nor all of them -- say so, or read the statement.',
        }
      : {}),
    ...(brokenOut.length ? { broken_out_per_value: brokenOut } : {}),
    ...(pooled.length ? { pooled_across: pooled } : {}),
    ...(absent.length
      ? {
          totals_only: absent,
          totals_only_means:
            'that relation has no such column AT ALL, so every figure aggregated from it is already a total across every value of them. It cannot be attributed to one platform, campaign, channel or location, however the question was phrased. To split it, query a relation that carries the column.',
        }
      : {}),
    date_scope: dateScope(bounds, dates, betweenRanges(text, literals, [...dateColumns]), meta.knownDates),
    derivation:
      'Read off the statement text and the auto-generated column lists in the schema map. It describes the QUERY, not the values: it does not verify a number and it cannot see meaning. Where it could not tell whether a dimension was narrowed it reports it as POOLED, so pooled is the safe reading. Two things it cannot resolve, so check the statement yourself before leaning on them: a predicate is matched against the whole statement, so when two relations here carry the same column a filter on one is reported for both, and a filter inside a subquery or CTE is reported even if that branch does not reach the rows returned.',
  };
}

/** The date half of the envelope. Publishes a window ONLY when the operators
 *  bound both ends AND dates were written into the statement; every other case
 *  says what is and is not known instead of asserting a period. "No predicate
 *  found" is deliberately not phrased as "covers every date": this reads the
 *  statement textually and a date filter it could not parse would otherwise be
 *  reported as no filter at all. */
/** Where each date in a statement CAME FROM.
 *
 *  The 2026-09-16 Sonic request asked whether prelaunch advertising was worth
 *  it. Its first query answered the launch date from the planning record and
 *  showed `preview_start_date` NULL on every Sonic row -- the record does not
 *  say when prelaunch began. The next sales query then ran
 *  `between '2026-08-01' and '2026-09-15'`, and every "before the launch"
 *  figure in the answer rests on an 1 August boundary that came from nowhere.
 *  The envelope reported it as a clean window, because as far as the STATEMENT
 *  went it was one.
 *
 *  A date is not more or less true for having been chosen, so this classifies
 *  rather than warns: from_results (it appeared in something already queried),
 *  from_question (the person supplied it), or unsourced. Only the last gets a
 *  sentence, and the sentence asks for the assumption to be stated -- not for
 *  the query to be different.
 */
function boundaryProvenance(dates, known) {
  if (!dates.length) return null;
  const fromResults = [];
  const fromQuestion = [];
  const unsourced = [];
  for (const d of dates) {
    if (known && known.results && known.results.has(d)) fromResults.push(d);
    else if (known && known.question && known.question.has(d)) fromQuestion.push(d);
    else unsourced.push(d);
  }
  return {
    ...(fromResults.length ? { from_results: fromResults } : {}),
    ...(fromQuestion.length ? { from_question: fromQuestion } : {}),
    ...(unsourced.length ? { unsourced } : {}),
    ...(unsourced.length
      ? {
          note: `${unsourced.join(', ')} ${unsourced.length === 1 ? 'appears' : 'appear'} in no earlier result and not in the question -- ${unsourced.length === 1 ? 'that boundary is one' : 'those boundaries are ones'} you chose. A before/after or period comparison resting on them is an ASSUMPTION, not a measurement: say so in the answer, or derive the boundary from a value you actually queried.`,
        }
      : {}),
  };
}

function dateScope(bounds, dates, ranges, known) {
  const literals = dates.slice(0, MAX_DATE_LITERALS_REPORTED);
  const provenance = boundaryProvenance(literals, known);
  const withProvenance = (obj) => (provenance ? { ...obj, boundary_provenance: provenance } : obj);
  if (!bounds.any) {
    return withProvenance({
      restriction:
        'no date predicate was readable in this statement, so this may cover the whole history the relation holds. That is what was PARSED, not a guarantee -- check the statement before naming a period.',
      ...(literals.length ? { dates_mentioned: literals } : {}),
    });
  }
  // SEVERAL PERIODS, NOT ONE. min..max of the literals spans the GAP between
  // them, which on a year-on-year comparison is the whole year nobody asked
  // about. `periods` is published only when every date branch is a BETWEEN and
  // so every period is actually named -- a partial list of periods would read
  // as the complete one, which is the failure this file is about.
  if (bounds.disjoint) {
    const named = ranges.length === bounds.dateBranches ? ranges : null;
    return withProvenance({
      literals_in_statement: literals,
      ...(named ? { periods: named } : {}),
      restriction: `the date predicates sit in ${bounds.dateBranches} separate OR-ed branches, so this covers SEVERAL SEPARATE PERIODS, not one continuous range -- a year-on-year comparison is the usual shape. ${
        named
          ? 'The periods are listed above; describe them individually.'
          : 'Not every branch could be read as a from/to pair, so the periods are NOT all listed here -- read the statement.'
      } The span from the earliest date to the latest is NOT the window: the time between the periods is not in this result at all.`,
    });
  }
  if (bounds.lower && bounds.upper && dates.length) {
    return withProvenance({
      literals_in_statement: literals,
      window: { from: dates[0], to: dates[dates.length - 1] },
      ...(dates.length > 2
        ? { note: 'more than two dates appear, so this result is BUCKETED -- every figure belongs to the bucket its edges define, and a bucket spanning an event (a launch, a price change, a campaign start) is on both sides of it. Name the bucket edges, never "before"/"after".' }
        : {}),
    });
  }
  // Both-false is reachable: `day_date <> '2026-09-01'` narrows without
  // bounding either end.
  const missing = !bounds.lower && !bounds.upper ? 'neither end is bounded'
    : !bounds.lower ? 'no start'
    : !bounds.upper ? 'no end'
    : 'no readable dates';
  return withProvenance({
    ...(literals.length ? { literals_in_statement: literals } : {}),
    restriction: `this IS restricted on a date, but the period is not fully readable here: ${missing}. ${
      !dates.length
        ? 'The bound is relative or computed (something like current_date - N) rather than written as a date.'
        : (bounds.lower || bounds.upper)
        ? 'One end is open, so the result runs to the edge of the data on that side.'
        : 'The predicate excludes rather than bounds, so the result reaches both edges of the data.'
    } Do not state a period from this -- read the statement, or re-query with explicit dates.`,
  });
}

/** True when SOME relation in the schema map carries this column. Keeps the
 *  `carries_none_of` list to dimensions that exist somewhere in this
 *  database, rather than naming columns nothing has. */
function anyRelationHasAnywhere(catalogIndex, col) {
  if (!catalogIndex) return false;
  for (const entry of catalogIndex.values()) {
    if ((entry.columns || []).some((c) => String(c && c.name || '').toLowerCase() === col)) return true;
  }
  return false;
}

/**
 * What run_sql hands back to the model: scope FIRST, then the rows.
 *
 * Order is deliberate. The envelope is read on the way in, before the
 * numbers; the previous shape (a bare array) meant the only thing in context
 * was numbers.
 *
 * A statement over information_schema/pg_catalog gets no envelope -- there is
 * no business scope to describe and the tokens are better spent elsewhere.
 */
export function renderQueryResult(sql, rows, catalogIndex, meta = {}) {
  const rowCount = Array.isArray(rows) ? rows.length : (rows == null ? 0 : 1);
  const rels = relationsInStatement(sql);
  if (!rels.length) return JSON.stringify(rows);
  const scope = describeEvidenceScope(sql, catalogIndex, { ...meta, rowCount });
  return JSON.stringify({ evidence_scope: scope, rows });
}

// ── THE ANSWER, CHECKED AGAINST THE ENVELOPES IT WAS WRITTEN FROM ───────────
//
// Everything above describes a QUERY. This is the one thing here that looks at
// what was written, and it exists because describing the query turned out not
// to be enough.
//
// Measured, 2026-09-16 (silo_chat_audit_log b44e03ab…): the sales result's
// envelope said `pooled_across: location_tag`, no statement in the whole
// request restricted sales channel, and the answer published "14 Sonic
// products, online sales_by_day". The control fired, correctly, and the
// sentence was written anyway. A prompt rule for exactly this already exists
// ("A FIGURE MAY ONLY WEAR A LABEL ITS RESULT SUPPORTS") and did not hold.
//
// WHAT THIS IS NOT. It is a word search over prose. It cannot read meaning, it
// will flag "online" in a sentence that had every right to it, and it will miss
// a channel claim phrased without any of these words. So it ANNOTATES and never
// rewrites, never blocks, and never edits a figure: a false positive costs one
// visible line that a reader can dismiss, where a false rewrite would corrupt a
// correct answer. Nothing downstream may treat a clean result as verification.

/** Dimensions whose value a sentence can assert in ordinary business words.
 *  Deliberately short. `campaign_name` is absent: "the campaign" is the phrase
 *  that would catch the 2026-09-16 two-campaigns-as-one failure, and it is far
 *  too common in legitimate prose to flag without crying wolf. That gap is a
 *  stated limitation, not an oversight. */
export const CLAIM_DIMENSIONS = [
  {
    columns: ['location_tag', 'location_name'],
    label: 'sales channel',
    terms: ['online', 'retail', 'wholesale', 'in-store', 'in store', 'pos', 'dtc', 'd2c', 'e-commerce', 'ecommerce', 'brick and mortar'],
  },
  {
    columns: ['platform'],
    label: 'ad platform',
    terms: ['meta', 'facebook', 'instagram', 'google', 'tiktok'],
  },
];

/**
 * Scope dimensions this request POOLED and never once distinguished.
 *
 * Narrowed anywhere, or broken out per value anywhere, both count as
 * distinguishing it: a request that grouped by platform has earned the right to
 * name one. Only `pooled_across` feeds the pooled set -- NOT
 * `totals_only.carries_none_of`, and that distinction is load-bearing.
 * meta_ad_performance_daily has no platform column at all, so it appears there;
 * every row in it is Meta's, and saying "Meta" about it is simply correct.
 */
export function unresolvedDimensions(scopes) {
  const pooled = new Set();
  const distinguished = new Set();
  for (const s of scopes || []) {
    if (!s) continue;
    for (const p of s.pooled_across || []) pooled.add(p.column);
    for (const n of s.narrowed_to || []) distinguished.add(n.column);
    for (const b of s.broken_out_per_value || []) distinguished.add(b.column);
    for (const e of s.excludes || []) distinguished.add(e.column);
  }
  return new Set([...pooled].filter((c) => !distinguished.has(c)));
}

/** Terms the answer asserts for a dimension nothing in the request resolved. */
export function auditAnswerClaims(answerText, scopes) {
  const text = String(answerText || '');
  if (!text.trim()) return [];
  const unresolved = unresolvedDimensions(scopes);
  const flags = [];
  for (const dim of CLAIM_DIMENSIONS) {
    if (!dim.columns.some((c) => unresolved.has(c))) continue;
    const found = dim.terms.filter((t) => {
      // Word-bounded on both sides so `pos` does not match "position" and
      // `meta` does not match "metadata" -- a lookaround rather than \b
      // because several terms contain a space or a hyphen.
      const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, 'i').test(text);
    });
    if (found.length) flags.push({ label: dim.label, columns: dim.columns.filter((c) => unresolved.has(c)), terms: found });
  }
  return flags;
}

/** The line appended to an answer that asserts an unresolved dimension. Kept
 *  here so its wording is testable, and written in business words because the
 *  reader is the person who asked the question, not an engineer. */
export function formatClaimNote(flags) {
  if (!flags || !flags.length) return '';
  const parts = flags.map((f) => {
    const words = f.terms.map((t) => `"${t}"`).join(', ');
    return `it uses ${words}, but nothing that was queried restricted ${f.label} -- every figure above covers all of its values together`;
  });
  return `\n\n---\n**Scope check (automatic):** ${parts.join('; ')}. `
    + 'Read that wording as unverified: the figures are real, the label on them was not established by anything that ran. '
    + 'This is a word check over the text above, so it can be wrong in both directions.';
}
