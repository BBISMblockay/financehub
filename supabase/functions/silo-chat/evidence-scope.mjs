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

/** Literal values a column was restricted to, recovered through the
 *  placeholders.
 *
 *  Two things this deliberately does NOT count as narrowing, both found by
 *  the fixture tests rather than by reading:
 *   - `a.ad_id = b.ad_id` is a JOIN KEY, not a filter. The right-hand side
 *     must be a literal or a number, or the column is still pooled.
 *   - a predicate's value list stops at that predicate. An unbounded scan
 *     forward attributed `campaign_name = 'Subscribers'` to the `platform`
 *     filter sitting two tokens earlier, which is exactly the class of
 *     mislabelling this module exists to stop -- in the module itself.
 */
function narrowedValues(text, literals, col) {
  const values = [];
  let narrowed = false;
  const pushRefs = (seg) => {
    for (const r of seg.match(/'@(\d+)'/g) || []) {
      const v = literals[Number(r.slice(2, -1))];
      if (v != null && !values.includes(v)) values.push(v);
    }
  };
  const inList = new RegExp(`(?<![a-z0-9_])${col}\\s+(?:not\\s+)?in\\s*\\(([^()]*)\\)`, 'g');
  let m;
  while ((m = inList.exec(text))) { narrowed = true; pushRefs(m[1]); }
  const equality = new RegExp(`(?<![a-z0-9_])${col}\\s*(?:=|<>|!=)\\s*('@\\d+'|-?\\d+(?:\\.\\d+)?)`, 'g');
  while ((m = equality.exec(text))) { narrowed = true; pushRefs(m[1]); }
  if (!narrowed) {
    const ranged = new RegExp(`(?<![a-z0-9_])${col}\\s*(?:<=|>=|<|>|~~|between\\b|like\\b|ilike\\b|is\\s+(?:not\\s+)?null)`);
    if (ranged.test(text)) narrowed = true;
  }
  return { kind: narrowed ? 'narrowed' : null, values: values.slice(0, MAX_VALUES_REPORTED) };
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
      const { kind, values } = narrowedValues(text, literals, col);
      if (kind === 'narrowed') {
        narrowed.push({ relation: name, column: col, ...(values.length ? { values } : {}) });
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
  const dateNarrowed = [...dateColumns].some((c) => mentions(text, c)) && dates.length > 0;

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
    ...(brokenOut.length ? { broken_out_per_value: brokenOut } : {}),
    ...(pooled.length ? { pooled_across: pooled } : {}),
    ...(absent.length
      ? {
          totals_only: absent,
          totals_only_means:
            'that relation has no such column AT ALL, so every figure aggregated from it is already a total across every value of them. It cannot be attributed to one platform, campaign, channel or location, however the question was phrased. To split it, query a relation that carries the column.',
        }
      : {}),
    date_scope: dateNarrowed
      ? {
          literals_in_statement: dates.slice(0, MAX_DATE_LITERALS_REPORTED),
          window: { from: dates[0], to: dates[dates.length - 1] },
          ...(dates.length > 2
            ? { note: 'more than two dates appear, so this result is BUCKETED -- every figure belongs to the bucket its edges define, and a bucket spanning an event (a launch, a price change, a campaign start) is on both sides of it. Name the bucket edges, never "before"/"after".' }
            : {}),
        }
      : { window: 'not restricted -- this result covers every date present in the relation(s) above' },
    derivation:
      'Read off the statement text and the auto-generated column lists in the schema map. It describes the QUERY, not the values: it does not verify a number and it cannot see meaning. Where it could not tell whether a dimension was narrowed it reports it as POOLED, so pooled is the safe reading. Two things it cannot resolve, so check the statement yourself before leaning on them: a predicate is matched against the whole statement, so when two relations here carry the same column a filter on one is reported for both, and a filter inside a subquery or CTE is reported even if that branch does not reach the rows returned.',
  };
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
