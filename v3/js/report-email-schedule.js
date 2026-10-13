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

  async function isWorkspaceAdmin(sb, userId, companyId) {
    if (!userId || !companyId) return false;
    const { data: profile } = await sb.from('profiles').select('role').eq('id', userId).maybeSingle();
    const pr = String(profile?.role || '').toLowerCase();
    if (['owner', 'executive'].includes(pr)) return true;
    const { data: mem } = await sb.from('entity_memberships')
      .select('role').eq('user_id', userId).eq('entity_id', companyId).maybeSingle();
    return !!mem && ['owner_admin', 'admin'].includes(mem.role);
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

  function computeNextRunAt(preset, timezone, fromDate) {
    const tz = timezone || 'America/Los_Angeles';
    const from = fromDate || new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    }).formatToParts(from);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const y = Number(get('year'));
    const mo = Number(get('month'));
    const d = Number(get('day'));
    const hour = String(preset || '').includes('0600') ? 6 : 7;
    const base = new Date(Date.UTC(y, mo - 1, d, hour, 0));
    const bump = (n) => new Date(base.getTime() + n * 86400000);
    const wd = (dt) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(dt);
    if (preset === 'monday_0700') {
      for (let n = 1; n < 8; n += 1) if (wd(bump(n)) === 'Mon') return bump(n).toISOString();
    }
    if (preset === 'month_first_0700') {
      const nmo = mo === 12 ? 1 : mo + 1;
      const ny = mo === 12 ? y + 1 : y;
      return new Date(Date.UTC(ny, nmo - 1, 1, hour, 0)).toISOString();
    }
    let next = bump(1);
    if (preset === 'weekdays_0700') while (wd(next) === 'Sat' || wd(next) === 'Sun') next = new Date(next.getTime() + 86400000);
    return next.toISOString();
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
  };
}(typeof window !== 'undefined' ? window : globalThis));
