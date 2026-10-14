/* Scheduled report CSV email — pure helpers + Supabase calls. */
(function (global) {
  'use strict';

  const CADENCE = Object.freeze([
    { id: 'weekdays_0700', label: 'Every weekday · 7:00 AM' },
    { id: 'daily_0600', label: 'Every day · 6:00 AM' },
    { id: 'monday_0700', label: 'Every Monday · 7:00 AM' },
    { id: 'month_first_0700', label: '1st of month · 7:00 AM' },
  ]);

  const DEPARTMENTS = Object.freeze(['finance', 'logistics', 'marketing', 'ops', 'retail', 'sales']);

  // Roles are PER COMPANY: the membership decides, and the legacy global
  // profiles.role is consulted only when the user has no membership here (see
  // CLAUDE.md, "Database essentials"). The first version checked the global
  // role FIRST, so a global `executive` read as an admin of every company --
  // the DB gate is_entity_admin() does not agree, so the tab rendered and then
  // every query came back empty. Nav gating is UX only; RLS is the boundary.
  async function isWorkspaceAdmin(sb, userId, companyId) {
    if (!userId || !companyId) return false;
    const { data: mem } = await sb.from('entity_memberships')
      .select('role').eq('user_id', userId).eq('entity_id', companyId).maybeSingle();
    if (mem) return ['owner_admin', 'admin'].includes(mem.role);
    const { data: profile } = await sb.from('profiles').select('role').eq('id', userId).maybeSingle();
    return String(profile?.role || '').toLowerCase() === 'owner';
  }

  function defaultSubject(title) {
    return `${title || 'Report'} · {{company}} · {{date}}`;
  }

  function defaultRecipients() {
    return [{ kind: 'workspace_admins' }];
  }

  async function listSchedules(sb) {
    const { data, error } = await sb.from('report_email_schedules_v').select('*')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // Cadence math. A cadence is a WALL-CLOCK time in the company's zone, so the
  // conversion to the timestamptz stored in next_run_at has to go through the
  // zone's offset on that date -- building the instant with Date.UTC() from
  // zone-local y/m/d labels 7:00 Los Angeles as 07:00 UTC, i.e. midnight
  // Pacific, and every schedule fires seven hours early with nothing erroring.
  //
  // This is a copy of the same three functions in
  // scripts/lib/report-email-deliver-core.mjs (the browser needs them in a
  // classic script, the sync script needs them as an ES module).
  // scripts/tests/report-email-deliver.test.mjs runs BOTH over the same
  // fixtures and fails if they ever disagree, so edit them together.
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
      h: num('hour') % 24, mi: num('minute'), s: num('second'),
      wd: parts.find((p) => p.type === 'weekday')?.value,
    };
  }

  function zoneOffsetMs(ms, tz) {
    const p = zoneParts(new Date(ms), tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - ms;
  }

  function zonedTimeToInstant(y, mo, d, hour, minute, tz) {
    const wall = Date.UTC(y, mo - 1, d, hour, minute, 0);
    let ms = wall;
    for (let i = 0; i < 3; i += 1) {
      const next = wall - zoneOffsetMs(ms, tz);
      if (next === ms) break;
      ms = next;
    }
    return new Date(ms);
  }

  function addCalendarDays(y, mo, d, n) {
    const t = new Date(Date.UTC(y, mo - 1, d + n));
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }

  function computeNextRunAt(preset, timezone, fromDate) {
    const tz = timezone || 'America/Los_Angeles';
    const hour = String(preset || '').includes('0600') ? 6 : 7;
    const from = fromDate instanceof Date ? fromDate : (fromDate ? new Date(fromDate) : new Date());
    const today = zoneParts(from, tz);

    if (preset === 'month_first_0700') {
      const mo = today.mo === 12 ? 1 : today.mo + 1;
      const y = today.mo === 12 ? today.y + 1 : today.y;
      return zonedTimeToInstant(y, mo, 1, hour, 0, tz).toISOString();
    }

    for (let n = 1; n <= 370; n += 1) {
      const cal = addCalendarDays(today.y, today.mo, today.d, n);
      const instant = zonedTimeToInstant(cal.y, cal.mo, cal.d, hour, 0, tz);
      const wd = zoneParts(instant, tz).wd;
      if (preset === 'weekdays_0700' && (wd === 'Sat' || wd === 'Sun')) continue;
      if (preset === 'monday_0700' && wd !== 'Mon') continue;
      return instant.toISOString();
    }
    const cal = addCalendarDays(today.y, today.mo, today.d, 1);
    return zonedTimeToInstant(cal.y, cal.mo, cal.d, hour, 0, tz).toISOString();
  }

  async function saveSchedule(sb, row) {
    const payload = {
      ...row,
      updated_at: new Date().toISOString(),
      next_run_at: row.next_run_at || computeNextRunAt(row.cadence_preset, row.timezone),
    };
    if (payload.id) {
      const { data, error } = await sb.from('report_email_schedules').update(payload).eq('id', payload.id)
        .select('id').maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('Schedule was not saved — you may not have permission.');
      return payload.id;
    }
    const { data, error } = await sb.from('report_email_schedules').insert(payload).select('id').single();
    if (error) throw error;
    return data.id;
  }

  async function deliverNow(sb, scheduleId, trigger) {
    const sess = (await sb.auth.getSession()).data.session;
    if (!sess) throw new Error('Sign in required');
    const url = `${(global.__SILO_CONFIG__ || {}).SUPABASE_URL}/functions/v1/report-email-deliver`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sess.access_token}`,
        'Content-Type': 'application/json',
        apikey: (global.__SILO_CONFIG__ || {}).SUPABASE_ANON_KEY || '',
      },
      body: JSON.stringify({ schedule_id: scheduleId, trigger: trigger || 'manual' }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Delivery failed (${res.status})`);
    return body;
  }

  async function duplicateSchedule(sb, id) {
    const { data, error } = await sb.rpc('duplicate_report_email_schedule', { p_schedule_id: id });
    if (error) throw error;
    return data;
  }

  async function pauseAll(sb) {
    const { data, error } = await sb.rpc('pause_all_report_email_schedules');
    if (error) throw error;
    return data;
  }

  async function listMembers(sb, companyId) {
    const { data, error } = await sb.from('entity_memberships')
      .select('user_id, role, profiles:profiles(id, name, email, department, is_active)')
      .eq('entity_id', companyId);
    if (error) throw error;
    return (data || []).map((m) => ({
      id: m.user_id,
      role: m.role,
      name: m.profiles?.name,
      email: m.profiles?.email,
      department: m.profiles?.department,
      active: m.profiles?.is_active !== false,
    })).filter((m) => m.active && m.email);
  }

  global.SiloReportEmailSchedule = {
    CADENCE, DEPARTMENTS, isWorkspaceAdmin, defaultSubject, defaultRecipients,
    listSchedules, saveSchedule, deliverNow, duplicateSchedule, pauseAll, listMembers,
    computeNextRunAt,
  };
}(typeof window !== 'undefined' ? window : globalThis));
