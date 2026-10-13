// Core delivery logic for scheduled report CSV email. Used by the edge
// function (verbatim copy under supabase/functions/report-email-deliver/lib/)
// and by node tests.

import { SiloReportParams } from './report-params-lib.mjs';

export const EXPORT_PAGE_SIZE = 5000;
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

export async function fetchAllRows(supabase, sql, pageSize = EXPORT_PAGE_SIZE) {
  const all = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.rpc('chat_run_readonly_query', {
      query: sql,
      p_offset: offset,
      p_limit: pageSize,
    });
    if (error) throw new Error(error.message || String(error));
    const page = Array.isArray(data) ? data : (data ? JSON.parse(JSON.stringify(data)) : []);
    if (!page.length) break;
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all;
}

export function sanitizeFilename(name) {
  return String(name || 'report').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'report';
}

export function computeNextRunAt(preset, timezone, fromDate = new Date()) {
  const tz = timezone || 'America/Los_Angeles';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(fromDate);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const y = Number(get('year'));
  const mo = Number(get('month'));
  const d = Number(get('day'));
  const wd = get('weekday');
  const hour = preset.includes('0600') ? 6 : 7;
  const minute = 0;

  const candidate = new Date(Date.UTC(y, mo - 1, d, hour, minute));
  const bumpDays = (n) => new Date(candidate.getTime() + n * 86400000);

  if (preset === 'daily_0600' || preset === 'weekdays_0700') {
    let next = bumpDays(1);
    if (preset === 'weekdays_0700') {
      while (['Sat', 'Sun'].includes(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(next))) {
        next = bumpDays(1);
      }
    }
    return next.toISOString();
  }
  if (preset === 'monday_0700') {
    let add = 1;
    while (add < 8) {
      const tryD = bumpDays(add);
      if (new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(tryD) === 'Mon') {
        return tryD.toISOString();
      }
      add += 1;
    }
  }
  if (preset === 'month_first_0700') {
    const nextMo = mo === 12 ? 1 : mo + 1;
    const nextY = mo === 12 ? y + 1 : y;
    return new Date(Date.UTC(nextY, nextMo - 1, 1, hour, minute)).toISOString();
  }
  return bumpDays(1).toISOString();
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
