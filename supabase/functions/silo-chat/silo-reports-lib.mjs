// SILO reports as Ask SILO's first source of truth.
//
// A SILO report is a `source = 'system'` row in silo_chat_saved_reports with
// company_entity_id NULL: one global definition every company runs against
// its own data (the SQL executes through chat_run_readonly_query under the
// caller's RLS). Each one has independent tie-out checks in
// silo_report_tieouts, run nightly for every company. That makes its figure
// the one SILO stands behind, so when a question is one of those figures the
// model should run the report rather than write its own SQL and risk a second,
// slightly different number for the same measure.
//
// Pure functions only: the handler fetches the rows and runs the SQL.

/** At most this many queries per report call. The largest SILO report has 4;
 *  a bigger one is refused rather than run partially. */
export const MAX_REPORT_QUERIES = 6;

/** Rows of one report result handed to the model. A SKU- or ad-level report
 *  can return a full 1000-row page; shipping all of it on every call would
 *  spend a large share of a question's budget on rows the answer never reads.
 *  The report's own ORDER BY decides which rows lead, so the first rows are
 *  the ones it ranks highest. */
export const MAX_REPORT_ROWS_TO_MODEL = 100;

/** One rendered result -> what the model is given. Parses the rendered JSON
 *  ({ evidence_scope, rows } or a bare array), caps the rows, and says so in
 *  the result itself so a shown subset is never read as the whole report. */
export function shapeReportResult(resultId, rendered) {
  let body;
  try { body = JSON.parse(rendered); } catch { return { result_id: resultId, text: String(rendered) }; }
  if (Array.isArray(body)) body = { rows: body };
  if (!body || typeof body !== 'object') return { result_id: resultId, text: String(rendered) };
  const out = { result_id: resultId, ...body };
  if (Array.isArray(out.rows) && out.rows.length > MAX_REPORT_ROWS_TO_MODEL) {
    out.rows_note = `Showing the first ${MAX_REPORT_ROWS_TO_MODEL} of ${out.rows.length} rows, in the report's own order. `
      + 'Totals and counts over the whole report cannot be read from these rows alone; use run_sql against the same source for those, and say the figure is yours.';
    out.rows = out.rows.slice(0, MAX_REPORT_ROWS_TO_MODEL);
  }
  return out;
}

/** Rows straight from silo_chat_saved_reports -> the shape the prompt and the
 *  tool use. Anything malformed is dropped rather than offered. */
export function normalizeReports(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.id !== 'string' || !r.title) continue;
    const queries = Array.isArray(r.queries_run)
      ? r.queries_run.filter((q) => typeof q === 'string' && q.trim())
      : [];
    if (!queries.length || queries.length > MAX_REPORT_QUERIES) continue;
    out.push({
      id: r.id,
      title: String(r.title),
      description: r.description ? String(r.description) : '',
      parameters: Array.isArray(r.parameters) ? r.parameters : [],
      queries,
    });
  }
  return out;
}

const firstSentence = (text) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : t).slice(0, 220);
};

function describeParam(p) {
  if (!p || !p.key) return '';
  const bits = [String(p.type || 'text')];
  if (Array.isArray(p.options) && p.options.length) {
    bits.push(`one of ${p.options.map((o) => (typeof o === 'object' ? o.value : o)).join('/')}`);
  }
  if (p.default !== undefined && p.default !== null && p.default !== '') bits.push(`default ${p.default}`);
  return `${p.key} (${bits.join(', ')})`;
}

/** The per-request prompt block: how to use SILO reports, then the list.
 *  Empty when there are none (a fresh database, or a read that failed), so
 *  the model is never told about a tool it has nothing to call with. */
export function buildReportsSection(reports) {
  const list = Array.isArray(reports) ? reports : [];
  if (!list.length) return '';
  const lines = list.map((r) => {
    const params = r.parameters.map(describeParam).filter(Boolean);
    return `- ${r.id} — ${r.title}: ${firstSentence(r.description) || 'no description'}`
      + ` Parameters: ${params.length ? params.join('; ') : 'none'}.`
      + (r.queries.length > 1 ? ` Returns ${r.queries.length} result sets.` : '');
  });
  return [
    'SILO reports -- answer from these FIRST. Each is SILO\'s own definition of a figure: the same query the Reports page and dashboards run, with an independent second calculation that reconciles it. When a question asks for a figure one of them produces (same measure, at a grain and window its parameters can express), call run_silo_report before writing any SQL of your own, and name it in the answer ("per the SILO Daily Sales report"). Use run_sql only for what no report covers, or to break a report\'s figure down further. If your own SQL gives a different number for the same measure, lead with the SILO report\'s figure and say plainly that the other is a different calculation and how it differs -- never present two numbers for one measure without saying which is SILO\'s. Do not adjust, re-total or re-derive a report\'s figures. Pass only the parameters a report declares; dates are YYYY-MM-DD or today, today-Nd, month_start, month_end, year_start, year_end, resolved in the company\'s business timezone; leave a parameter out to use its default.',
    ...lines,
  ].join('\n');
}

/** Find a report by its id, or by its exact title (case-insensitive), so a
 *  model that quotes the title instead of the id still lands on it. */
export function resolveReport(reports, ref) {
  const key = String(ref || '').trim();
  if (!key) return null;
  const list = Array.isArray(reports) ? reports : [];
  return list.find((r) => r.id === key)
    || list.find((r) => r.title.toLowerCase() === key.toLowerCase())
    || null;
}

/** Turn a report and the model's parameter values into runnable SQL.
 *  Returns { queries, parameters_used } or { error }. A key the report does
 *  not declare is refused, not ignored: silently dropping "location: online"
 *  would return company-wide figures under a label that says online. */
export function prepareReportRun(report, values, params) {
  const decls = params.normalizeDeclarations(report.parameters);
  const supplied = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  const declared = new Set(decls.map((d) => d.key));
  const unknown = Object.keys(supplied).filter((k) => !declared.has(k));
  if (unknown.length) {
    return {
      error: `"${report.title}" has no parameter ${unknown.map((k) => `"${k}"`).join(', ')}. `
        + (declared.size ? `Its parameters are: ${[...declared].join(', ')}.` : 'It takes no parameters.')
        + ' If the question needs a cut this report cannot express, use run_sql and say the figure is not the SILO report\'s.',
    };
  }
  const clean = {};
  for (const [k, v] of Object.entries(supplied)) {
    if (v !== null && v !== undefined) clean[k] = typeof v === 'number' ? String(v) : v;
  }
  const queries = [];
  for (const sql of report.queries) {
    const res = params.substitute(sql, decls, clean);
    if (res.error) return { error: `"${report.title}": ${res.error}` };
    queries.push(res.sql);
  }
  const parametersUsed = {};
  for (const d of decls) {
    const v = params.effectiveValue(d, clean);
    if (v !== undefined && v !== '') parametersUsed[d.key] = v;
  }
  return { queries, parameters_used: parametersUsed };
}
