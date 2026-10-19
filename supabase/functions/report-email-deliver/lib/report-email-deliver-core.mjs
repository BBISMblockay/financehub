// Core delivery logic for scheduled report CSV email. Used by the edge
// function (verbatim copy under supabase/functions/report-email-deliver/lib/)
// and by node tests.

import { SiloReportParams } from './report-params-lib.mjs';

// chat_run_readonly_query caps every page at 1,000 rows and takes no page-size
// argument. Delivery pages with p_offset instead of widening the shared engine
// -- see the header of 20261013180000_report_email_schedules.sql for why the
// p_limit overload was removed.
export const EXPORT_PAGE_SIZE = 1000;
// A hard ceiling on one export. Without it a report that happens to return
// millions of rows is accumulated in the edge function's memory until the
// worker is killed, which surfaces as a bare "failed" run with no error.
export const MAX_EXPORT_ROWS = 200000;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const STORAGE_BUCKET = 'report-email-exports';

const PROBE = /information_schema|pg_catalog/i;

export function defaultQueryIndex(queriesRun) {
  const qs = queriesRun || [];
  for (let i = qs.length - 1; i >= 0; i -= 1) {
    if (!PROBE.test(String(qs[i] || ''))) return i;
  }
  return 0;
}

export function queryIndicesForSchedule(schedule, report) {
  if (schedule.target_kind === 'dashboard') return null;
  const stored = schedule.query_indices;
  if (Array.isArray(stored) && stored.length) return stored.map(Number).filter((n) => Number.isFinite(n));
  const meta = report?.columns_metadata?._queries;
  if (Array.isArray(meta) && meta.length) {
    return meta.map((q) => Number(q.index)).filter((n) => Number.isFinite(n));
  }
  return [defaultQueryIndex(report?.queries_run || [])];
}

export function resolveSql(report, queryIndex, parameterState) {
  const queries = report.queries_run || [];
  const raw = queries[queryIndex];
  if (!raw) throw new Error(`Report has no query at index ${queryIndex}`);
  const params = report.parameters || [];
  const values = parameterState || {};
  const sub = SiloReportParams.substitute(raw, params, values);
  if (sub.error) throw new Error(sub.error);
  return sub.sql;
}

export function rowsToCsv(rows) {
  if (!rows?.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [cols.map(esc).join(',')];
  for (const row of rows) lines.push(cols.map((c) => esc(row[c])).join(','));
  return lines.join('\n');
}

export async function fetchAllRows(supabase, sql, maxRows = MAX_EXPORT_ROWS) {
  const all = [];
  for (let offset = 0; ; offset += EXPORT_PAGE_SIZE) {
    // Only `query` and `p_offset`: the two arguments the live
    // chat_run_readonly_query(text, integer) takes. Adding a third would mean
    // replacing the shared report engine -- see the migration header.
    const { data, error } = await supabase.rpc('chat_run_readonly_query', {
      query: sql,
      p_offset: offset,
    });
    if (error) throw new Error(error.message || String(error));
    const page = Array.isArray(data) ? data : (data ? JSON.parse(JSON.stringify(data)) : []);
    if (!page.length) break;
    all.push(...page);
    if (all.length > maxRows) {
      throw new Error(`Export exceeds ${maxRows.toLocaleString()} rows; narrow the report or its filters`);
    }
    if (page.length < EXPORT_PAGE_SIZE) break;
  }
  return all;
}

export function sanitizeFilename(name) {
  return String(name || 'report').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'report';
}

// ── Cadence math ─────────────────────────────────────────────────────────
// A cadence is a WALL-CLOCK time in the company's zone ("every weekday at
// 7:00 AM"), and next_run_at is a timestamptz, so the conversion has to go
// through the zone's offset on that date. The first version of this file built
// the instant with `Date.UTC(y, mo - 1, d, hour, 0)` from zone-local y/m/d --
// which labels 7:00 Los Angeles as 07:00 UTC, i.e. midnight Pacific. Every
// schedule would have been delivered seven or eight hours early, on the
// 00:15 PT cron slot, and nothing would have errored.
//
// `v3/js/report-email-schedule.js` carries the same math for the browser's
// "next run" preview; scripts/tests/report-email-deliver.test.mjs runs both
// over the same fixtures and fails if they ever disagree.

function zoneParts(instant, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  }).formatToParts(instant);
  const num = (t) => Number(parts.find((p) => p.type === t)?.value);
  return {
    y: num('year'), mo: num('month'), d: num('day'),
    // Some ICU builds render midnight as hour 24 under hour12:false.
    h: num('hour') % 24, mi: num('minute'), s: num('second'),
    wd: parts.find((p) => p.type === 'weekday')?.value,
  };
}

// Milliseconds the zone is ahead of UTC at this instant.
function zoneOffsetMs(ms, tz) {
  const p = zoneParts(new Date(ms), tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - ms;
}

// The instant at which the zone's clock reads y-mo-d hour:minute. Two passes:
// the first offset is read at the wrong instant whenever a DST change sits
// between the guess and the answer, and the second settles it.
export function zonedTimeToInstant(y, mo, d, hour, minute, tz) {
  const wall = Date.UTC(y, mo - 1, d, hour, minute, 0);
  let ms = wall;
  for (let i = 0; i < 3; i += 1) {
    const next = wall - zoneOffsetMs(ms, tz);
    if (next === ms) break;
    ms = next;
  }
  return new Date(ms);
}

// Calendar arithmetic only -- no zone involved, so it cannot drift on a DST day
// the way adding 86400000 to an instant does.
function addCalendarDays(y, mo, d, n) {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function computeNextRunAt(preset, timezone, fromDate = new Date()) {
  const tz = timezone || 'America/Los_Angeles';
  const hour = String(preset || '').includes('0600') ? 6 : 7;
  const today = zoneParts(fromDate instanceof Date ? fromDate : new Date(fromDate), tz);

  if (preset === 'month_first_0700') {
    const mo = today.mo === 12 ? 1 : today.mo + 1;
    const y = today.mo === 12 ? today.y + 1 : today.y;
    return zonedTimeToInstant(y, mo, 1, hour, 0, tz).toISOString();
  }

  // Strictly tomorrow or later: a schedule saved at 09:00 must not fire for a
  // 07:00 slot that has already passed today.
  for (let n = 1; n <= 370; n += 1) {
    const cal = addCalendarDays(today.y, today.mo, today.d, n);
    const instant = zonedTimeToInstant(cal.y, cal.mo, cal.d, hour, 0, tz);
    const wd = zoneParts(instant, tz).wd;
    if (preset === 'weekdays_0700' && (wd === 'Sat' || wd === 'Sun')) continue;
    if (preset === 'monday_0700' && wd !== 'Mon') continue;
    return instant.toISOString();
  }
  // Unreachable for every preset above; a new preset lands here rather than
  // returning undefined and writing a null next_run_at.
  const cal = addCalendarDays(today.y, today.mo, today.d, 1);
  return zonedTimeToInstant(cal.y, cal.mo, cal.d, hour, 0, tz).toISOString();
}

// Whether a delivery failure is the SCHEDULE's fault or the world's. Only the
// schedule's own faults pause it: pausing on a Resend 429, a network blip or a
// not-yet-deployed function turns one bad minute into a feature that silently
// stopped, and nobody is told it paused.
const TRANSIENT = [
  /\bresend (429|5\d\d)\b/i,
  /\b(429|50[0-4]|408)\b/,
  /timeout|timed out|etimedout|econnreset|enotfound|socket hang up|fetch failed|network/i,
  /canceling statement due to statement timeout/i,
  /not configured|not set|unauthoriz|invalid session|jwt/i,
  /storage upload/i,
  // Two-step login refusing the scheduled run's own token is SILO's fault, not
  // the schedule's: it is what paused the only live schedule on 2026-10-15
  // (the minted token carried no `aal` claim, so the pre-request hook read it
  // as aal1). A schedule must not be silently switched off by an enforcement
  // change it has no part in -- it retries, and last_error says why.
  /mfa_required|authenticator app|two-step/i,
];

export function isTransientDeliveryError(message) {
  const m = String(message || '');
  return TRANSIENT.some((re) => re.test(m));
}

export function renderSubject(template, ctx) {
  const base = template || '{{title}} · {{company}} · {{date}}';
  return base
    .replace(/\{\{title\}\}/g, ctx.title || 'Report')
    .replace(/\{\{company\}\}/g, ctx.company || 'SILO')
    .replace(/\{\{date\}\}/g, ctx.date || new Date().toISOString().slice(0, 10));
}

export function cadenceLabel(preset) {
  const map = {
    weekdays_0700: 'Weekdays 7:00',
    daily_0600: 'Daily 6:00',
    monday_0700: 'Monday 7:00',
    month_first_0700: '1st of month 7:00',
  };
  return map[preset] || preset;
}

// ── Claiming a due row ───────────────────────────────────────────────────
// next_run_at is the lease. Advancing it with a compare-and-swap on its
// current value is what stops two overlapping runs -- a workflow_dispatch
// during a scheduled run, or the same slot retried -- from both selecting the
// same due row and delivering the export twice. Whoever wins the swap owns the
// slot, which is why the edge function must NOT write next_run_at: a second
// writer there would hand the row back to the next run and send again.
export async function claimSchedule(db, row, now = new Date()) {
  const next = computeNextRunAt(row.cadence_preset, row.timezone, now);
  const { data, error } = await db.from('report_email_schedules')
    .update({ next_run_at: next, updated_at: now.toISOString() })
    .eq('id', row.id)
    .eq('next_run_at', row.next_run_at)
    .select('id');
  if (error) throw new Error(error.message);
  // An RLS- or race-refused UPDATE succeeds with ZERO rows, it does not error
  // (supabase/CLAUDE.md). Zero rows means another run claimed this slot.
  return Array.isArray(data) && data.length === 1;
}
