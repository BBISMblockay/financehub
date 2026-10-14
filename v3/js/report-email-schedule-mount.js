/* Wire scheduled CSV email on dashboard preview, report builder, library tab. */
(function (global) {
  'use strict';

  const S = () => global.SiloReportEmailSchedule;
  const UI = () => global.SiloReportEmailScheduleUI;

  // Everything up to the rendered panel reports its own failure. The first
  // version returned silently on both guards and let listMembers' rejection
  // escape the click handler, so a broken read left the button looking dead:
  // no panel, no message, nothing in the status bar. A click now always
  // produces either a panel or a reason.
  async function openReportPanel(opts) {
    const { sb, userId, companyId, hostEl, onStatus, context } = opts;
    let members;
    let mount;
    let existing = null;
    try {
      if (!await S().isWorkspaceAdmin(sb, userId, companyId)) {
        onStatus?.('Scheduled email is available to workspace admins.', 'info', 5000);
        return;
      }
      members = await S().listMembers(sb, companyId);
      // Open on the schedule this report already has, so Save edits it
      // instead of adding a second one that fires the same morning.
      if (!context.scheduleId) {
        const found = await S().findScheduleForTarget(sb, context);
        if (found) existing = found;
      }
      mount = hostEl || document.getElementById('reportEmailHost');
      if (!mount) {
        onStatus?.('Could not open the schedule panel on this page.', 'neg', 6000);
        return;
      }
    } catch (e) {
      onStatus?.(e?.message || 'Could not open the schedule panel', 'neg', 6000);
      return;
    }
    // The stored schedule wins over the page's defaults for everything the
    // panel edits; the page still supplies what belongs to THIS view (the
    // filter values applied right now, the report's queries, its title).
    const ctx = existing ? {
      ...context,
      scheduleId: existing.id,
      recipients: existing.recipients,
      cadence_preset: existing.cadence_preset,
      subject_template: existing.subject_template,
      query_indices: existing.query_indices,
      allow_member_subscribe: existing.allow_member_subscribe,
      is_active: existing.is_active,
      timezone: existing.timezone || context.timezone,
    } : context;
    mount.hidden = false;
    mount.innerHTML = UI().renderPanel({ ...ctx, members });
    const root = mount.querySelector('.res-panel');
    const close = () => { mount.hidden = true; mount.innerHTML = ''; };
    if (!root) {
      close();
      onStatus?.('Could not render the schedule panel.', 'neg', 6000);
      return;
    }
    root.querySelector('#resClose')?.addEventListener('click', close);
    root.querySelector('#resSave')?.addEventListener('click', async () => {
      try {
        const row = {
          id: ctx.scheduleId || undefined,
          company_entity_id: companyId,
          created_by: userId,
          name: ctx.title,
          target_kind: 'report',
          report_id: ctx.reportId,
          query_indices: UI().readQueryIndices(root),
          parameter_state: ctx.parameter_state || {},
          cadence_preset: root.querySelector('.res-cadence')?.value || 'weekdays_0700',
          timezone: ctx.timezone || 'America/Los_Angeles',
          subject_template: root.querySelector('.res-subject')?.value || S().defaultSubject(ctx.title),
          recipients: UI().readRecipients(root),
          allow_member_subscribe: !!root.querySelector('#resSubscribe')?.checked,
          is_active: !!root.querySelector('#resActive')?.checked,
          is_paused: false,
        };
        ctx.scheduleId = await S().saveSchedule(sb, row);
        onStatus?.('Schedule saved.', 'pos', 4000);
        close();
        opts.onSaved?.();
      } catch (e) {
        onStatus?.(e.message || 'Could not save schedule', 'neg', 6000);
      }
    });
    root.querySelector('#resTest')?.addEventListener('click', async () => {
      try {
        const row = {
          id: ctx.scheduleId || undefined,
          company_entity_id: companyId,
          created_by: userId,
          name: ctx.title,
          target_kind: 'report',
          report_id: ctx.reportId,
          query_indices: UI().readQueryIndices(root),
          parameter_state: ctx.parameter_state || {},
          cadence_preset: root.querySelector('.res-cadence')?.value || 'weekdays_0700',
          timezone: ctx.timezone || 'America/Los_Angeles',
          subject_template: root.querySelector('.res-subject')?.value || S().defaultSubject(ctx.title),
          recipients: UI().readRecipients(root),
          allow_member_subscribe: !!root.querySelector('#resSubscribe')?.checked,
          is_active: true,
          is_paused: false,
        };
        // Keep the id, or the Save that usually follows a test would insert
        // a second schedule beside the one the test just created.
        ctx.scheduleId = await S().saveSchedule(sb, row);
        await S().deliverNow(sb, ctx.scheduleId, 'test');
        onStatus?.('Test email sent (or queued).', 'pos', 5000);
      } catch (e) {
        onStatus?.(e.message || 'Test failed', 'neg', 6000);
      }
    });
  }

  /** The Scheduled email tab of the Reports library. `query` filters by
      report title and by who a schedule goes to. */
  async function mountLibraryTab(sb, userId, companyId, bodyEl, onStatus, query) {
    if (!await S().isWorkspaceAdmin(sb, userId, companyId)) {
      bodyEl.innerHTML = '<div class="lib-empty">Scheduled email is available to workspace admins.</div>';
      return;
    }
    const again = () => mountLibraryTab(sb, userId, companyId, bodyEl, onStatus, query);
    bodyEl.innerHTML = '<div class="lib-empty">Loading schedules…</div>';
    try {
      const [rows, members] = await Promise.all([
        S().listSchedules(sb),
        S().listMembers(sb, companyId).catch(() => []),
      ]);
      const q = String(query || '').trim().toLowerCase();
      const visible = !q ? rows : rows.filter((r) => [
        r.target_title, r.name, S().cadenceLabel(r.cadence_preset),
        S().recipientSummary(r.recipients, members),
      ].some((v) => String(v || '').toLowerCase().includes(q)));
      if (rows.length && !visible.length) {
        bodyEl.innerHTML = `<div class="lib-empty"><strong>No schedules match “${
          (global.SiloChart?.esc || String)(query)}”.</strong>Search looks at the report, the cadence and who it goes to.</div>`;
        return;
      }
      bodyEl.innerHTML = UI().renderManageTable(visible, members)
        + (rows.length ? '<div class="res-tablefoot"><button type="button" class="bcn-btn" id="resPauseAll">Pause all schedules</button></div>' : '');
      bodyEl.querySelector('#resPauseAll')?.addEventListener('click', async () => {
        try {
          const n = await S().pauseAll(sb);
          onStatus?.(`Paused ${n} schedule(s).`, 'pos', 4000);
          again();
        } catch (e) { onStatus?.(e.message, 'neg', 5000); }
      });
      const on = (attr, run) => bodyEl.querySelectorAll(`[data-${attr}]`).forEach((btn) => {
        btn.addEventListener('click', () => run(btn.getAttribute(`data-${attr}`), btn));
      });
      on('run', async (id, btn) => {
        btn.disabled = true;
        onStatus?.('Sending…', 'info', 3000);
        try {
          await S().deliverNow(sb, id, 'manual');
          onStatus?.('Sent.', 'pos', 4000);
          again();
        } catch (e) { onStatus?.(e.message, 'neg', 6000); btn.disabled = false; }
      });
      on('dup', async (id) => {
        try {
          await S().duplicateSchedule(sb, id);
          onStatus?.('Schedule duplicated.', 'pos', 3000);
          again();
        } catch (e) { onStatus?.(e.message, 'neg', 6000); }
      });
      // Edit reuses the same panel the report preview opens, mounted into
      // the tab. Before this it was a button with no handler at all.
      on('edit', async (id) => {
        const row = rows.find((r) => r.id === id);
        if (!row) return;
        // The panel writes target_kind 'report'. Saving a dashboard schedule
        // through it would fail the target CHECK rather than quietly convert
        // it, but say so here instead of opening a form that cannot save.
        if (row.target_kind === 'dashboard') {
          onStatus?.('A dashboard schedule is edited from that dashboard.', 'info', 5000);
          return;
        }
        let host = bodyEl.querySelector('#schedEditHost');
        if (!host) {
          host = document.createElement('div');
          host.id = 'schedEditHost';
          host.className = 'v3-report-email-host';
          bodyEl.prepend(host);
        }
        await openReportPanel({
          sb, userId, companyId, hostEl: host, onStatus, onSaved: again,
          context: {
            scheduleId: row.id,
            reportId: row.report_id,
            title: row.target_title || row.name,
            recipients: row.recipients,
            cadence_preset: row.cadence_preset,
            subject_template: row.subject_template,
            query_indices: row.query_indices,
            parameter_state: row.parameter_state,
            allow_member_subscribe: row.allow_member_subscribe,
            is_active: row.is_active,
            timezone: row.timezone,
          },
        });
        host.scrollIntoView({ block: 'nearest' });
      });
      on('del', async (id) => {
        const row = rows.find((r) => r.id === id);
        const name = row?.target_title || row?.name || 'this schedule';
        if (!global.confirm(`Delete the scheduled email for ${name}? It stops sending immediately.`)) return;
        try {
          await S().deleteSchedule(sb, id);
          onStatus?.('Schedule deleted.', 'pos', 4000);
          again();
        } catch (e) { onStatus?.(e.message, 'neg', 6000); }
      });
    } catch (e) {
      if (String(e.message || e).includes('42P01')) {
        bodyEl.innerHTML = '<div class="lib-empty">Scheduled email is not enabled on this database yet.</div>';
        return;
      }
      bodyEl.innerHTML = `<div class="lib-empty">${e.message || 'Could not load schedules'}</div>`;
    }
  }

  global.SiloReportEmailScheduleMount = { openReportPanel, mountLibraryTab };
}(typeof window !== 'undefined' ? window : globalThis));
