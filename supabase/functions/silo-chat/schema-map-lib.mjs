// The database map Ask SILO is shown: which relations get a full card, and
// what the rest look like.
//
// Extracted from index.ts on 2026-10-29 for the same reason as budget-lib.mjs
// and evidence-scope.mjs -- it is a pure function whose OUTPUT TEXT is the
// thing that decides whether the model guesses a column name, and the only
// test it had read index.ts as a string (`has(SRC, ...)` in prompt.test.mjs).
// A source-text assertion cannot tell "the column list is rendered" from "the
// column list is rendered for the wrong set of relations", which is precisely
// the class of mistake this file has already shipped once.
//
// WHY THE INDEX LINE CARRIES COLUMN NAMES (measured 2026-10-29).
//
// 282 of 2,752 logged statements failed with "column ... does not exist", and
// 172 of 529 answered questions -- a THIRD of them -- contained at least one.
// The reflex reading is that the curated descriptions are thin, and 215 of 322
// relations do carry no keywords at all. But the logs say otherwise.
//
// `launch_calendar` was guessed 17 times (lc.launch_title, lc.name,
// lc.description). Its catalog description, written in
// 20260821210000_silo_chat_schema_catalog.sql, opens:
//
//   "Marketing launch pipeline. The name column is title (not launch_name or
//    name); date columns are launch_date and preview_start_date -- ..."
//
// The answer was already written down, in the exact words needed, and the
// model never saw it: in all 17 of those requests `launch_calendar` was an
// index line rather than a full card (0 had the card; 1 fetched it mid-flight
// with describe_relations). And the index line was built from
// `description.split('. ')[0]` -- "Marketing launch pipeline." -- which drops
// the sentence that exists to prevent this.
//
// So this was never a content gap. The renderer was throwing the guidance away
// one sentence after it started. Adding more descriptions would have been
// written into the same hole.
//
// The fix is to put the column NAMES on every index line, which cures the
// failure directly rather than by advice: a model that can see `title` does
// not reach for `launch_title`. Measured cost on the live catalog: the index
// grows from ~21,000 to ~99,000 characters, about +19.5k tokens on a system
// prompt that was ~25k. That is a real price and it is paid on every question.
// It is worth it because the thing it replaces is also expensive -- a guessed
// column costs a whole extra round, at a full prompt read plus ~5s of latency,
// on a third of all questions -- and because the prompt is cached, so the
// growth is charged at cache-read rates after the first call of a request.
//
// Types are deliberately NOT included: names are what the failures are about,
// and types would roughly double the added bytes again. describe_relations
// remains the only way to get types, curated meaning and measured date
// coverage, and the preamble below is worded to keep that true -- the risk of
// handing over names is that the model stops asking for the rest, so the index
// says what a name list does and does not settle.

/** Full column cards for at most this many relations, chosen by how well they
 *  match the question's own words. */
export const SCHEMA_DETAIL_LIMIT = 8;

/** Topped up when keyword matching finds fewer than the limit -- a generic
 *  business question ("how are we doing?") still deserves detail on the
 *  workhorse tables. */
export const SCHEMA_CORE_RELS = [
  'sales_by_day_verification_v',
  'inventory_workboard_v',
  'products_master',
  'shopify_orders_v',
];

/** Longest first-sentence summary kept on an index line. */
export const MAX_INDEX_SUMMARY_CHARS = 140;

const columnNames = (r) =>
  (r.columns || []).map((c) => String((c && c.name) || '')).filter(Boolean);

/**
 * Rank the catalog against the question and render the map.
 *
 * @param {string} question
 * @param {Array<{relname: string, relkind: string, columns?: {name: string, type: string}[],
 *                description?: string|null, keywords?: string[]|null}>} rows
 * @returns {{ text: string, detailRelations: string[] }}
 */
export function buildSchemaSection(question, rows) {
  if (!rows || !rows.length) {
    // Catalog unavailable (fetch failed / table empty) -- degrade to
    // discovery guidance rather than breaking chat.
    return {
      text: '\n\nSchema map unavailable for this request -- discover table and column names via information_schema before querying; never guess a column name.',
      detailRelations: [],
    };
  }
  const q = String(question || '').toLowerCase();
  const tokens = [...new Set(q.match(/[a-z0-9_]{4,}/g) || [])];
  const scored = rows.map((r) => {
    const name = r.relname.toLowerCase();
    const desc = (r.description || '').toLowerCase();
    const kws = (r.keywords || []).map((k) => k.toLowerCase());
    let score = 0;
    for (const t of tokens) {
      if (name.includes(t)) score += 5;
      if (kws.some((k) => k.includes(t) || t.includes(k))) score += 3;
      else if (desc.includes(t)) score += 1;
    }
    if (q.includes(name)) score += 10;
    return { r, score };
  });
  const detail = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SCHEMA_DETAIL_LIMIT)
    .map((s) => s.r);
  for (const core of SCHEMA_CORE_RELS) {
    if (detail.length >= SCHEMA_DETAIL_LIMIT) break;
    const row = rows.find((r) => r.relname === core);
    if (row && !detail.includes(row)) detail.push(row);
  }
  const detailNames = new Set(detail.map((r) => r.relname));

  const card = (r) =>
    `### ${r.relname} (${r.relkind})\nColumns: ${(r.columns || []).map((c) => `${c.name} (${c.type})`).join(', ')}${
      r.description ? `\n${r.description}` : ''
    }`;

  // The index line. Column names first, because they are what the 282 measured
  // failures were about; the curated first sentence follows when there is one.
  // A relation whose catalog row has no columns at all still renders -- it
  // exists and the model should know it does -- but it says so, rather than
  // implying an empty table.
  const indexLine = (r) => {
    const firstSentence = ((r.description || '').split('. ')[0] || '').trim();
    const short = firstSentence.length > MAX_INDEX_SUMMARY_CHARS
      ? `${firstSentence.slice(0, MAX_INDEX_SUMMARY_CHARS - 3)}...`
      : firstSentence;
    const cols = columnNames(r);
    return `- ${r.relname} (${r.relkind})${short ? ` -- ${short}` : ''}\n    columns: ${
      cols.length ? cols.join(', ') : '(none recorded)'
    }`;
  };

  return {
    text: `\n\nDatabase map (auto-generated from the live schema -- the table/view names and column names below are EXACT; trust them over memory, and never guess a column that isn't listed):

Most relevant to this question, with full columns:

${detail.map(card).join('\n\n')}

Everything else available, each with its EXACT column names. Use these names verbatim -- if a name you expected is not in the list, it does not exist, and the right move is to read the list rather than try a variant. What a name list does NOT give you is the column's type, its curated business meaning, or how far back it actually goes, and those are what decide whether a figure means what it looks like. So before you draw a conclusion from one of these, or join it to something else, call describe_relations for its full card:
${rows.filter((r) => !detailNames.has(r.relname)).map(indexLine).join('\n')}`,
    detailRelations: detail.map((r) => r.relname),
  };
}
