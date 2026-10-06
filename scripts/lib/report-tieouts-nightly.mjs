/* Nightly tie-outs: every company's SILO-report reconciliations, run as that
 * company, classified so a STALE check can never read as a clean one.
 *
 * WHY. Every `system` saved report has at least one row in
 * silo_report_tieouts -- a second, independent route to its number -- and
 * verify_v2_schema.sql fails if one is missing. But nothing RAN them: the
 * drift check proves a tie-out exists, not that it passes, so "SILO fact"
 * rested on someone remembering to call run_report_tieouts().
 *
 * WHY AS EACH COMPANY. run_report_tieouts() is SECURITY INVOKER and every
 * check reads through active_company_id(), so as the service role it sees
 * no company at all and every check returns NO DATA -- a run that cannot
 * fail. Each company's checks are therefore run as one of its own active
 * admins: `set local role authenticated` plus the JWT claims auth.uid()
 * reads, inside a transaction that is ROLLED BACK. Nothing is written; RLS
 * decides what the checks see, exactly as it does for that person.
 *
 * WHY THE RECLASSIFICATION. Most checks pin a fingerprint of the report's
 * SQL (md5(queries_run || parameters)) and blank their own left side when
 * the report has changed since the check was written. run_report_tieouts()
 * calls a blank side NO DATA, so on 2026-10-06 seven checks on Inventory
 * Summary and Creative Performance -- both edited 2026-09-25 -- had been
 * testing nothing for eleven days while reading exactly like an empty
 * company. Here the pin is compared to the live report (CATALOG_SQL) and a
 * mismatch is STALE, and a blank side against real data on the other is a
 * MISMATCH, never NO DATA.
 *
 * Pure apart from `query`, which is injected (the Management API in
 * production, a fake in the tests).
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verdicts that turn the run red. NO DATA does not: a company with no
 * source rows yet (a new tenant before its first sync) is not a defect. */
export const FAILING = new Set(['MISMATCH', 'STALE', 'ERROR']);

/** One row per enabled tie-out, with whether its pinned fingerprint still
 * matches the report it pins. A pinned report that no longer exists is
 * stale too (md5 of a missing row is NULL, which is distinct). */
export const CATALOG_SQL = `with pins as (
  select s.title, o.name, o.tolerance, m[1] as pinned_hash, m[2]::uuid as pinned_report
    from public.silo_report_tieouts o
    join public.silo_chat_saved_reports s on s.id = o.report_id
    left join lateral regexp_matches(o.check_sql,
      'md5\\(queries_run::text \\|\\| parameters::text\\)\\s*=\\s*''([0-9a-f]{32})''\\s*from\\s+(?:public\\.)?silo_chat_saved_reports\\s+where\\s+id\\s*=\\s*''([0-9a-f-]{36})''', 'g') m on true
   where o.enabled
)
select p.title as report_title, p.name as check_name, p.tolerance,
       count(p.pinned_hash)::int as pins,
       coalesce(bool_or(p.pinned_hash is not null
         and p.pinned_hash is distinct from md5(r.queries_run::text || r.parameters::text)), false) as stale
  from pins p
  left join public.silo_chat_saved_reports r on r.id = p.pinned_report
 group by 1, 2, 3
 order by 1, 2`;

/** Every company, with the active admins whose active company it is. A
 * company with no such person comes back with user_id null and is reported
 * as not checked. Owner-admins first: some checks read tables narrower than
 * the company (po_headers is is_admin_user() OR creator), so a member would
 * see less and the check would compare less. */
export const RUNNERS_SQL = `select e.id as company_id, e.title,
       p.id as user_id, m.role as membership_role
  from public.entities e
  left join public.entity_memberships m on m.entity_id = e.id
  left join public.profiles p on p.id = m.user_id
        and p.is_active and p.active_company_id = e.id
 where e.entity_type = 'company'
 order by e.title, e.id`;

const ROLE_RANK = { owner_admin: 0, admin: 1, member: 2, viewer: 3 };

/** Per company, the one person to run its checks as (or null). Deterministic:
 * best membership role, then lowest user id. */
export function pickRunners(rows) {
  const byCompany = new Map();
  for (const r of rows || []) {
    if (!byCompany.has(r.company_id)) byCompany.set(r.company_id, { company_id: r.company_id, title: r.title, user_id: null, rank: Infinity });
    const c = byCompany.get(r.company_id);
    if (!r.user_id || !UUID_RE.test(String(r.user_id))) continue;
    const rank = ROLE_RANK[r.membership_role] ?? 9;
    if (rank < c.rank || (rank === c.rank && String(r.user_id) < String(c.user_id))) {
      c.user_id = String(r.user_id);
      c.rank = rank;
    }
  }
  return [...byCompany.values()].map(({ rank, ...c }) => c);
}

/** The impersonated, rolled-back run. The user id is the only input and is
 * refused unless it is a bare uuid, so nothing else can reach the SQL. */
export function impersonatedRunSql(userId) {
  if (!UUID_RE.test(String(userId))) throw new Error(`refusing to impersonate a non-uuid: ${userId}`);
  const claims = JSON.stringify({ sub: String(userId), role: 'authenticated' });
  return [
    'begin;',
    'set local role authenticated;',
    `select set_config('request.jwt.claims', '${claims}', true);`,
    'select (select public.active_company_id()) as company_id, report_title, check_name, kind, left_value, right_value, verdict from public.run_report_tieouts();',
    'rollback;',
  ].join('\n');
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** The verdict that counts, from the runner's row and the catalog's facts. */
export function classify(row, meta) {
  if (meta && meta.stale) return 'STALE';
  const raw = String(row.verdict || '');
  if (raw.startsWith('ERROR')) return 'ERROR';
  const l = num(row.left_value);
  const r = num(row.right_value);
  if (l === null && r === null) return 'NO DATA';
  const tol = num(meta?.tolerance) ?? 0;
  // One side blank and the other holding a real number is the report (or
  // the source) returning nothing where the other route found something.
  return Math.abs((l ?? 0) - (r ?? 0)) <= tol ? 'OK' : 'MISMATCH';
}

const key = (title, name) => `${title}\u0000${name}`;

/**
 * Run every company. `query(sql)` resolves { rows } or { error }.
 * Returns { companies: [...], failures: n, catalogStale: n }.
 */
export async function runNightly({ query, log = () => {} }) {
  const cat = await query(CATALOG_SQL);
  if (cat.error) throw new Error(`could not read the tie-out catalog: ${cat.error}`);
  const meta = new Map((cat.rows || []).map((m) => [key(m.report_title, m.check_name), m]));

  const run = await query(RUNNERS_SQL);
  if (run.error) throw new Error(`could not list companies: ${run.error}`);
  const runners = pickRunners(run.rows);

  const companies = [];
  let failures = 0;
  for (const c of runners) {
    if (!c.user_id) {
      companies.push({ ...c, status: 'not checked', reason: 'no active member has this as their active company', results: [] });
      log(`- ${c.title}: not checked (no active member has it as their active company)`);
      continue;
    }
    const res = await query(impersonatedRunSql(c.user_id));
    if (res.error) {
      failures++;
      companies.push({ ...c, status: 'error', reason: res.error, results: [] });
      log(`- ${c.title}: could not run: ${res.error}`);
      continue;
    }
    const rows = Array.isArray(res.rows) ? res.rows : [];
    // The impersonation must actually have landed on THIS company; anything
    // else (a profile that moved between listing and running) would grade
    // one company's numbers under another's name.
    const landed = rows.length ? rows[0].company_id : null;
    if (rows.length && landed !== c.company_id) {
      failures++;
      companies.push({ ...c, status: 'error', reason: `ran as company ${landed}, expected ${c.company_id}`, results: [] });
      log(`- ${c.title}: ran under the wrong company (${landed}); not graded`);
      continue;
    }
    const results = rows.map((row) => {
      const m = meta.get(key(row.report_title, row.check_name));
      return { ...row, final: classify(row, m) };
    });
    const bad = results.filter((x) => FAILING.has(x.final));
    failures += bad.length;
    const counts = {};
    for (const x of results) counts[x.final] = (counts[x.final] || 0) + 1;
    companies.push({ ...c, status: bad.length ? 'failing' : 'ok', counts, results });
    log(`- ${c.title}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'no checks'}`);
    for (const x of bad) {
      log(`    ${x.final}  ${x.report_title} :: ${x.check_name}  (left ${x.left_value ?? 'blank'}, right ${x.right_value ?? 'blank'})`);
    }
  }
  const catalogStale = (cat.rows || []).filter((m) => m.stale).length;
  return { companies, failures, catalogStale };
}

/** A GitHub step-summary table. */
export function summaryMarkdown({ companies, failures, catalogStale }) {
  const lines = ['## SILO report tie-outs', ''];
  lines.push(failures ? `**${failures} failing check result(s).**` : '**All checked companies pass.**');
  if (catalogStale) lines.push('', `${catalogStale} check(s) pin a report that has changed since the check was written (STALE): the check needs regenerating against the report's current SQL.`);
  lines.push('', '| Company | Status | OK | NO DATA | MISMATCH | STALE | ERROR |', '|---|---|---|---|---|---|---|');
  for (const c of companies) {
    const n = (k) => (c.counts && c.counts[k]) || 0;
    lines.push(`| ${c.title} | ${c.status}${c.reason ? ` (${c.reason})` : ''} | ${n('OK')} | ${n('NO DATA')} | ${n('MISMATCH')} | ${n('STALE')} | ${n('ERROR')} |`);
  }
  const bad = companies.flatMap((c) => (c.results || []).filter((x) => FAILING.has(x.final)).map((x) => ({ c, x })));
  if (bad.length) {
    lines.push('', '| Company | Verdict | Report | Check | Left | Right |', '|---|---|---|---|---|---|');
    for (const { c, x } of bad) lines.push(`| ${c.title} | ${x.final} | ${x.report_title} | ${x.check_name} | ${x.left_value ?? 'blank'} | ${x.right_value ?? 'blank'} |`);
  }
  return lines.join('\n') + '\n';
}
