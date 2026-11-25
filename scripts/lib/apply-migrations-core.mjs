/* Apply migration files to a Supabase project through the Management API's
 * query endpoint, for .github/workflows/auto-apply-migrations.yml.
 *
 * WHY THIS ENDPOINT. Applying SQL otherwise needs the database password
 * (psql, or the Supabase CLI's `db push`). The Management API needs only the
 * SUPABASE_ACCESS_TOKEN the deploy and drift-check workflows already hold, so
 * no new credential has to exist for a merge to apply its own migration.
 *
 * WHAT THIS DEPENDS ON. A migration must be all-or-nothing: a file that fails
 * half way through is the one outcome nobody can clean up by reading a diff.
 * One request carries the whole file, and Postgres wraps a multi-statement
 * simple query in an IMPLICIT transaction, so the first error rolls the rest
 * back. That is an assumption about somebody else's API, so it is TESTED ON
 * EVERY RUN rather than trusted: `probe` sends a statement that creates a
 * schema followed by one that must fail, and then asks whether the schema
 * survived. If it did, the endpoint is not transactional, the probe's schema
 * is dropped and NOTHING is applied. Fails closed in every direction -- an
 * unexpected success, an unreadable answer or an error on the check all stop
 * the run.
 *
 * A file carrying its own BEGIN / COMMIT manages itself; nothing here wraps a
 * transaction around it, which would mis-nest.
 *
 * Pure apart from what is injected (`runSql`, `readFile`, `log`), so every
 * path is tested without a network: scripts/tests/apply-migrations.test.mjs.
 */

export const PROBE_SCHEMA = '_silo_apply_atomicity_probe';

/** Version and name from a migration filename, the way Supabase keys them. */
export function parseMigrationFile(filePath) {
  const base = String(filePath).split('/').pop() || '';
  if (!base.endsWith('.sql')) return { error: 'not a .sql file' };
  const stem = base.slice(0, -4);
  const underscore = stem.indexOf('_');
  const version = underscore === -1 ? stem : stem.slice(0, underscore);
  const name = underscore === -1 ? '' : stem.slice(underscore + 1);
  if (!/^[0-9]{6,20}$/.test(version)) return { error: 'filename does not start with a version timestamp' };
  // The version and name reach SQL as literals. Keep them to characters that
  // cannot end a string literal rather than trusting an escape.
  if (!/^[A-Za-z0-9_.-]*$/.test(name)) return { error: 'unsupported characters in the filename' };
  return { version, name, base };
}

/** `--` and block comments removed, so a word in a comment is not a finding. */
export function stripSqlComments(sql) {
  return String(sql ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/** Why this file must not be applied by this workflow, or null. */
export function refusalReason(sql) {
  const bare = stripSqlComments(sql);
  if (/(^|[^a-z0-9_])concurrently([^a-z0-9_]|$)/i.test(bare)) {
    return 'uses CONCURRENTLY, which cannot run inside a transaction';
  }
  if (/(^|[^a-z0-9_])vacuum([^a-z0-9_]|$)/i.test(bare)) {
    return 'uses VACUUM, which cannot run inside a transaction';
  }
  return null;
}

/** The file plus its schema_migrations row, as one request's worth of SQL. */
export function migrationRequestSql(sql, version, name) {
  const body = String(sql).replace(/\s+$/, '');
  const terminated = body.endsWith(';') ? body : `${body};`;
  return `${terminated}\ninsert into supabase_migrations.schema_migrations (version, name)\nvalues ('${version}', '${name}')\non conflict (version) do nothing;`;
}

function rowsOf(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

/**
 * Is one request one transaction? Returns { ok: true } or { ok: false, reason }.
 * Never throws; a reason is always something the run can print and stop on.
 */
export async function probeAtomicity({ runSql, log = () => {} }) {
  const drop = async () => {
    const r = await runSql(`drop schema if exists ${PROBE_SCHEMA} cascade;`);
    return !r?.error;
  };

  const attempt = await runSql(
    `create schema ${PROBE_SCHEMA};\nselect 1 / 0;`,
  );
  if (!attempt?.error) {
    await drop();
    return { ok: false, reason: 'the atomicity probe did not fail when it had to divide by zero; the query endpoint did not behave as expected' };
  }

  const check = await runSql(
    `select 1 as present from information_schema.schemata where schema_name = '${PROBE_SCHEMA}';`,
  );
  if (check?.error) {
    await drop();
    return { ok: false, reason: `could not read back the atomicity probe: ${check.error}` };
  }
  if (rowsOf(check).length > 0) {
    const cleaned = await drop();
    return {
      ok: false,
      reason: `the Management API query endpoint is NOT transactional: a statement after a failure was kept. Nothing was applied${cleaned ? '' : `, and schema ${PROBE_SCHEMA} could not be dropped -- drop it by hand`}.`,
    };
  }
  log('atomicity probe: one request is one transaction');
  return { ok: true };
}

/**
 * Apply the given migration files, in the order given.
 * @returns {Promise<{ results: {file,status,detail?}[], failed: boolean }>}
 *   status is 'applied' | 'skipped' | 'refused' | 'failed' | 'not-attempted'.
 */
export async function applyMigrations({ files, readFile, runSql, log = () => {} }) {
  const results = [];
  const list = Array.isArray(files) ? files.slice() : [];
  if (list.length === 0) return { results, failed: false };

  const probe = await probeAtomicity({ runSql, log });
  if (!probe.ok) {
    for (const file of list) results.push({ file, status: 'not-attempted' });
    return { results, failed: true, abort: probe.reason };
  }

  let stop = false;
  for (const file of list) {
    if (stop) { results.push({ file, status: 'not-attempted' }); continue; }

    const parsed = parseMigrationFile(file);
    if (parsed.error) {
      results.push({ file, status: 'failed', detail: parsed.error });
      stop = true;
      continue;
    }

    const recorded = await runSql(
      `select 1 as applied from supabase_migrations.schema_migrations where version = '${parsed.version}';`,
    );
    if (recorded?.error) {
      results.push({ file, status: 'failed', detail: `could not read schema_migrations: ${recorded.error}` });
      stop = true;
      continue;
    }
    if (rowsOf(recorded).length > 0) {
      log(`skip    ${parsed.base} (version ${parsed.version} already recorded)`);
      results.push({ file, status: 'skipped' });
      continue;
    }

    let sql;
    try { sql = await readFile(file); }
    catch (err) {
      results.push({ file, status: 'failed', detail: `could not read the file: ${err?.message || err}` });
      stop = true;
      continue;
    }

    const refusal = refusalReason(sql);
    if (refusal) {
      log(`refuse  ${parsed.base} -- ${refusal}`);
      results.push({ file, status: 'refused', detail: refusal });
      stop = true;
      continue;
    }

    log(`apply   ${parsed.base}`);
    const applied = await runSql(migrationRequestSql(sql, parsed.version, parsed.name));
    if (applied?.error) {
      results.push({ file, status: 'failed', detail: applied.error });
      stop = true;
      continue;
    }
    results.push({ file, status: 'applied' });
  }

  return { results, failed: results.some((r) => r.status === 'failed' || r.status === 'refused') };
}
