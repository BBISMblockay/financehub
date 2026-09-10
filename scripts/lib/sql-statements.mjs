/* Split a .sql file into statements, and read a verification result.
 *
 * Exists for scripts/verify-schema-remote.mjs, which runs
 * supabase/verify_v2_schema.sql against PRODUCTION on a schedule. The
 * Management API's query endpoint takes one statement at a time (a
 * multi-statement string returns only the last result set), so the file has
 * to be split -- and a naive split on ';' is wrong the first time a status
 * message or a comment contains one, which several already do.
 *
 * Pure: no I/O, no network. Tested by scripts/tests/verify-schema-remote.test.mjs.
 */

const SECTION_RE = /^--\s*(\d+\.\s.*|──.*)$/;

/**
 * @param {string} sql
 * @returns {{ text: string, section: string | null, line: number }[]}
 *   One entry per statement, comments stripped from the statement text.
 *   `section` is the most recent numbered / boxed comment header seen
 *   before the statement, so a failure can be reported by the same name a
 *   person reading the file would use. `line` is 1-based, where the
 *   statement's first token starts.
 */
export function splitSqlStatements(sql) {
  const src = String(sql ?? '');
  const out = [];
  let section = null;
  let buf = '';
  let bufStartLine = 0;
  let line = 1;
  let i = 0;

  const flush = () => {
    const text = buf.trim();
    if (text) out.push({ text, section, line: bufStartLine });
    buf = '';
    bufStartLine = 0;
  };

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    // -- line comment: dropped from the statement, but read for a header.
    if (ch === '-' && next === '-') {
      const end = src.indexOf('\n', i);
      const comment = src.slice(i, end === -1 ? src.length : end);
      const m = SECTION_RE.exec(comment.trim());
      if (m && !buf.trim()) section = m[1].trim();
      i = end === -1 ? src.length : end;
      continue;
    }
    // /* block comment */
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const skipped = src.slice(i, end === -1 ? src.length : end + 2);
      line += (skipped.match(/\n/g) || []).length;
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    // 'string'. A doubled quote ('') needs no special case here: it reads as
    // two adjacent literals, and the text between them is still quoted, so
    // no ';' inside can ever be seen as a boundary. (A special case was
    // written, mutation-tested, and found unobservable -- removed.)
    if (ch === "'") {
      const j = src.indexOf("'", i + 1);
      const lit = src.slice(i, j === -1 ? src.length : j + 1);
      if (!buf.trim()) bufStartLine = line;
      buf += lit;
      line += (lit.match(/\n/g) || []).length;
      i = j === -1 ? src.length : j + 1;
      continue;
    }
    // "identifier"
    if (ch === '"') {
      const j = src.indexOf('"', i + 1);
      const lit = src.slice(i, j === -1 ? src.length : j + 1);
      if (!buf.trim()) bufStartLine = line;
      buf += lit;
      i = j === -1 ? src.length : j + 1;
      continue;
    }
    // $tag$ dollar quote $tag$
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
      if (m) {
        const tag = m[0];
        const j = src.indexOf(tag, i + tag.length);
        const lit = src.slice(i, j === -1 ? src.length : j + tag.length);
        if (!buf.trim()) bufStartLine = line;
        buf += lit;
        line += (lit.match(/\n/g) || []).length;
        i = j === -1 ? src.length : j + tag.length;
        continue;
      }
    }
    if (ch === ';') { flush(); i++; continue; }
    if (ch === '\n') line++;
    if (!buf.trim() && !/\s/.test(ch)) bufStartLine = line;
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** Only these may be sent. The verify script is read-only by construction;
 * this makes it read-only by check as well, so a stray statement added to
 * the file later cannot be executed against production by the scheduler. */
export function isReadOnlyStatement(text) {
  return /^(select|with)\b/i.test(String(text ?? '').trim());
}

/** The words verify_v2_schema.sql uses to say something is wrong, matched at
 * the START of a string cell and case-sensitive -- that is the file's own
 * convention ('ok' vs 'MISSING — ...'), and a lowercase data value such as a
 * priority column must not trip it.
 *
 * Two rules, because the vocabulary is not closed. The first run of the
 * reader against the real file found 'BROKEN —' (19 uses) missing from a
 * list written from memory. So besides the known words, ANY word of three or
 * more capitals followed by the file's ' — ' message separator counts: a new
 * status word is flagged the day it is written, not the day someone updates
 * this list. Data literals that merely start with capitals ('BASE TABLE',
 * 'AMZN Mktp US*2A4XY9') carry no ' — ' and are not matched -- the test
 * against the real file asserts both halves. */
const BAD_WORDS = /^(MISSING|CRITICAL|BROKEN|UNEXPECTED|STALE|WEAK|STILL|SLOW|OVERBROAD|DRIFT|WARN|WARNING|FAIL|FAILED|ERROR)\b/;
const BAD_SHAPE = /^[A-Z]{3,}[A-Z ]* — /;
const isBad = (v) => BAD_WORDS.test(v) || BAD_SHAPE.test(v);

/**
 * @param {unknown} rows  the JSON result of one statement
 * @returns {{ column: string, value: string, row: number }[]} every failing cell
 */
export function findFailures(rows) {
  const found = [];
  if (!Array.isArray(rows)) return found;
  rows.forEach((row, r) => {
    if (!row || typeof row !== 'object') return;
    for (const [column, value] of Object.entries(row)) {
      if (typeof value === 'string' && isBad(value)) found.push({ column, value, row: r });
    }
  });
  return found;
}
