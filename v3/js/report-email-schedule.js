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

  // ── The period a schedule sends ────────────────────────────────────
  // A schedule stores parameter_state, which the delivery side substitutes
  // at SEND time. So what it stores decides whether a recurring export
  // rolls forward or repeats one frozen window:
  //
  //   { date_from: 'prior_month_start', date_to: 'prior_month_end' }
  //      -> every send is the month that just ended
  //   { date_from: '2026-09-01', date_to: '2026-09-30' }
  //      -> every send is September 2026, forever
  //
  // Before this the panel silently stored whatever the filter bar happened
  // to show, so a specific date picked once to look at something became the
  // window every future email reported. The picker makes the choice
  // explicit and defaults to naming a period rather than freezing a date.

  // Two sentinels, because "no named period" means two different things.
  //
  //   USE_PAGE_FILTERS -- take the date values the page's filter bar is
  //     showing right now. The only sensible default for a NEW schedule,
  //     whose state IS the page's.
  //   KEEP_WINDOW -- leave the stored window exactly as it is. The default
  //     when the panel opens on a schedule that already exists, because
  //     the thing being edited is that schedule, not this page. Reopening
  //     a "Last month" schedule from a report whose filters happen to show
  //     a fortnight used to show (and then save) the fortnight.
  //
  // A schedule's window therefore only moves to the page's dates when
  // someone picks that option by name.
  const USE_PAGE_FILTERS = '__page__';
  const KEEP_WINDOW = '__keep__';

  /** True for the two ids that are not a named period. */
  function isSentinel(id) { return id === USE_PAGE_FILTERS || id === KEEP_WINDOW; }

  /** The report's two date-range keys, or null if it has no date window.
   *  Company-calendar dates are included: the picker stores tokens and
   *  never prints a resolved date, so the viewer's calendar is not in play. */
  function dateRangeKeys(parameters) {
    const P = global.SiloReportParams;
    const FB = global.SiloFilterBar;
    if (!P || !FB) return null;
    const decls = P.normalizeDeclarations(parameters);
    const group = FB.groupDeclarations(decls, { includeCompanyCalendar: true })
      .find((g) => g.kind === 'range');
    return group ? { from: group.from.key, to: group.to.key } : null;
  }

  /** The periods a schedule may be set to, in the order they are offered.
   *  Taken from the filter bar's own range presets so a period means the
   *  same thing in an email as it does on screen. */
  //  `opts.editing` is a schedule that already exists, and
  //  `opts.hasPageState` a page with filter values to offer. Edit from the
  //  schedules table has neither a page nor its filters, so it is not
  //  offered an option it cannot honour.
  function periodOptions(opts) {
    const FB = global.SiloFilterBar;
    const editing = !!(opts && opts.editing);
    const hasPage = !!(opts && opts.hasPageState);
    const head = editing
      ? [{ id: KEEP_WINDOW, label: 'Keep the window this schedule already sends' }]
      : [{ id: USE_PAGE_FILTERS, label: 'Use the filter values on this page' }];
    const presets = (FB?.RANGE_PRESETS || [])
      .map((p) => ({ id: p.id, label: p.label, from: p.from, to: p.to }));
    const tail = (editing && hasPage)
      ? [{ id: USE_PAGE_FILTERS, label: 'Use the filter values on this page instead' }]
      : [];
    return head.concat(presets, tail);
  }

  /** Which period a stored parameter_state represents, or USE_PAGE_FILTERS
   *  when it matches none -- including when it holds specific dates, which
   *  is the frozen case and is shown to the user as such. */
  function periodIdFor(parameterState, keys, opts) {
    const FB = global.SiloFilterBar;
    // An existing schedule falls back to keeping its own window; a new one
    // to the page's filters, which are already what its state holds.
    const fallback = (opts && opts.editing) ? KEEP_WINDOW : USE_PAGE_FILTERS;
    if (!keys || !FB) return fallback;
    const state = parameterState || {};
    return FB.matchRangePreset(state[keys.from], state[keys.to]) || fallback;
  }

  /** parameter_state with the chosen period's TOKENS written in. Returns the
   *  state unchanged for USE_PAGE_FILTERS, for an unknown id, and for a
   *  report with no date window -- a picker that cannot find the keys must
   *  leave the stored state alone rather than invent parameters. */
  function applyPeriod(parameterState, keys, periodId, pageState) {
    const state = { ...(parameterState || {}) };
    if (!keys || !periodId || periodId === KEEP_WINDOW) return state;
    if (periodId === USE_PAGE_FILTERS) {
      // Only the two date keys are taken from the page. Everything else the
      // schedule stores (a location, a channel) belongs to the schedule.
      // With no page state -- Edit from the schedules table -- this is the
      // same no-op it has always been.
      if (!pageState) return state;
      state[keys.from] = pageState[keys.from];
      state[keys.to] = pageState[keys.to];
      return state;
    }
    const preset = (global.SiloFilterBar?.RANGE_PRESETS || []).find((p) => p.id === periodId);
    if (!preset) return state;
    state[keys.from] = preset.from;
    state[keys.to] = preset.to;
    return state;
  }

  /** The period in words for the schedules table. Says plainly when a
   *  schedule is pinned to fixed dates, because that is the thing someone
   *  scanning the table needs to notice. */
  function periodSummary(parameterState, keys) {
    if (!keys) return 'Report default';
    const state = parameterState || {};
    const from = state[keys.from];
    const to = state[keys.to];
    if (!from && !to) return 'Report default';
    const id = periodIdFor(state, keys);
    if (!isSentinel(id)) {
      return periodOptions().find((p) => p.id === id)?.label || id;
    }
    const fixed = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    if (fixed(from) && fixed(to)) return `${from} → ${to} (fixed)`;
    return `${from || '—'} → ${to || '—'}`;
  }

  /** The period for one row of the schedules table, which has the stored
   *  parameter_state but NOT the report's declarations -- so this reads the
   *  values alone and never needs a second read per row. It says "Fixed
   *  dates" loudly, because that is the row someone scanning the table has
   *  to notice: every send repeats one window. */
  function periodSummaryFromState(parameterState) {
    const state = parameterState || {};
    const values = Object.values(state).map((v) => String(v == null ? '' : v));
    if (!values.length) return 'Report default';
    const isoDates = values.filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v));
    if (isoDates.length) return 'Fixed dates';
    for (const p of (global.SiloFilterBar?.RANGE_PRESETS || [])) {
      if (values.includes(p.from) && values.includes(p.to)) return p.label;
    }
    const tokens = values.filter((v) => global.SiloReportParams?.resolveDateExpr(v));
    return tokens.length ? 'Rolling' : 'Report default';
  }

  function defaultSubject(title) {
    return `${title || 'Report'} · {{company}} · {{date}}`;
  }

  function defaultRecipients() {
    return [{ kind: 'workspace_admins' }];
  }

  function cadenceLabel(id) {
    return CADENCE.find((c) => c.id === id)?.label || id || '';
  }

  // Addresses outside the workspace. Deliberately permissive about what an
  // address may contain and strict about what separates two of them, because
  // the cost of refusing a real address is a feature that does not work and
  // the cost of accepting a malformed one is a bounced send. The same shape
  // is checked again in resolve_report_email_recipients(), which skips an
  // entry it cannot parse.
  const EMAIL_RE = /^[^@\s,;]+@[^@\s,;]+\.[a-z]{2,}$/i;

  /** Split a free-text box into { emails, invalid }. Commas, semicolons,
   *  whitespace and newlines all separate; case and duplicates collapse. */
  function parseEmailList(text) {
    const seen = new Set();
    const emails = [];
    const invalid = [];
    for (const raw of String(text || '').split(/[\s,;]+/)) {
      const one = raw.trim();
      if (!one) continue;
      if (!EMAIL_RE.test(one)) { invalid.push(one); continue; }
      const low = one.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      emails.push(low);
    }
    return { emails, invalid };
  }

  /** The recipient list in words, for the manage table. `members` is
   *  listMembers() output and is only used to name a profile. */
  function recipientSummary(recipients, members) {
    const r = Array.isArray(recipients) ? recipients : [];
    if (!r.length) return 'No one';
    const byId = new Map((members || []).map((m) => [m.id, m]));
    const parts = [];
    const people = [];
    const outside = [];
    for (const one of r) {
      if (one?.kind === 'workspace_admins') parts.push('All workspace admins');
      else if (one?.kind === 'department' && one.value) parts.push(`${one.value} department`);
      else if (one?.kind === 'profile' && one.id) {
        const m = byId.get(one.id);
        people.push(m?.name || m?.email || 'one person');
      } else if (one?.kind === 'email' && one.value) outside.push(one.value);
    }
    if (people.length) parts.push(people.join(', '));
    if (outside.length) parts.push(outside.join(', '));
    return parts.join(' · ') || 'No one';
  }

  async function listSchedules(sb) {
    const { data, error } = await sb.from('report_email_schedules_v').select('*')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // The panel opens on a report, not on a schedule, so without this every
  // Save inserted ANOTHER row: two saves, or a save then a test, left two
  // identical schedules both firing on the same morning. Opening on the
  // existing one makes the panel an editor the second time round.
  async function findScheduleForTarget(sb, target) {
    const col = target?.dashboardId ? 'dashboard_id' : 'report_id';
    const id = target?.dashboardId || target?.reportId;
    if (!id) return null;
    const { data, error } = await sb.from('report_email_schedules_v').select('*')
      .eq(col, id).order('updated_at', { ascending: false }).limit(1);
    if (error) throw error;
    return (data || [])[0] || null;
  }

  async function deleteSchedule(sb, id) {
    const { data, error } = await sb.from('report_email_schedules').delete().eq('id', id).select('id');
    if (error) throw error;
    // An RLS-refused delete removes nothing and does NOT error.
    if (!Array.isArray(data) || !data.length) {
      throw new Error('Schedule was not deleted -- you may not have permission.');
    }
    return true;
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

  // Two reads, never a PostgREST embed. entity_memberships.user_id references
  // auth.users(id), not public.profiles, so there is no foreign key between
  // the two tables and `select('user_id, profiles:profiles(...)')` is a hard
  // 400 PGRST200 ("Could not find a relationship ... in the schema cache")
  // for every caller -- which is what made the panel's only data read throw
  // and the button do nothing. v2/settings-team.html lists the same people
  // the same way, and for the same reason.
  async function listMembers(sb, companyId) {
    if (!companyId) return [];
    const { data: memberships, error } = await sb.from('entity_memberships')
      .select('user_id, role').eq('entity_id', companyId);
    if (error) throw error;
    const ids = (memberships || []).map((m) => m.user_id).filter(Boolean);
    if (!ids.length) return [];
    const { data: profiles, error: profErr } = await sb.from('profiles')
      .select('id, name, email, department, is_active').in('id', ids);
    if (profErr) throw profErr;
    const byId = new Map((profiles || []).map((p) => [p.id, p]));
    return (memberships || []).map((m) => {
      const p = byId.get(m.user_id) || {};
      return {
        id: m.user_id,
        role: m.role,
        name: p.name,
        email: p.email,
        department: p.department,
        active: p.is_active !== false,
      };
    }).filter((m) => m.active && m.email);
  }

  global.SiloReportEmailSchedule = {
    CADENCE, DEPARTMENTS, isWorkspaceAdmin, defaultSubject, defaultRecipients,
    listSchedules, saveSchedule, deliverNow, duplicateSchedule, pauseAll, listMembers,
    computeNextRunAt, cadenceLabel, parseEmailList, recipientSummary,
    USE_PAGE_FILTERS, KEEP_WINDOW, isSentinel,
    dateRangeKeys, periodOptions, periodIdFor, applyPeriod, periodSummary,
    periodSummaryFromState,
    findScheduleForTarget, deleteSchedule,
  };
}(typeof window !== 'undefined' ? window : globalThis));
