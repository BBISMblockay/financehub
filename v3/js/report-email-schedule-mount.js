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
    try {
      if (!await S().isWorkspaceAdmin(sb, userId, companyId)) {
        onStatus?.('Scheduled email is available to workspace admins.', 'info', 5000);
        return;
      }
      members = await S().listMembers(sb, companyId);
      mount = hostEl || document.getElementById('reportEmailHost');
      if (!mount) {
        onStatus?.('Could not open the schedule panel on this page.', 'neg', 6000);
        return;
      }
    } catch (e) {
      onStatus?.(e?.message || 'Could not open the schedule panel', 'neg', 6000);
      return;
    }
    mount.hidden = false;
    mount.innerHTML = UI().renderPanel({ ...context, members });
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
          id: context.scheduleId || undefined,
          company_entity_id: companyId,
          created_by: userId,
          name: context.title,
          target_kind: 'report',
          report_id: context.reportId,
          query_indices: UI().readQueryIndices(root),
          parameter_state: context.parameter_state || {},
          cadence_preset: root.querySelector('.res-cadence')?.value || 'weekdays_0700',
          timezone: context.timezone || 'America/Los_Angeles',
          subject_template: root.querySelector('.res-subject')?.value || S().defaultSubject(context.title),
          recipients: UI().readRecipients(root),
          allow_member_subscribe: !!root.querySelector('#resSubscribe')?.checked,
          is_active: !!root.querySelector('#resActive')?.checked,
          is_paused: false,
        };
        await S().saveSchedule(sb, row);
        onStatus?.('Schedule saved.', 'pos', 4000);
        close();
      } catch (e) {
        onStatus?.(e.message || 'Could not save schedule', 'neg', 6000);
      }
    });
    root.querySelector('#resTest')?.addEventListener('click', async () => {
      try {
        const row = {
          id: context.scheduleId || undefined,
          company_entity_id: companyId,
          created_by: userId,
          name: context.title,
          target_kind: 'report',
          report_id: context.reportId,
          query_indices: UI().readQueryIndices(root),
          parameter_state: context.parameter_state || {},
          cadence_preset: root.querySelector('.res-cadence')?.value || 'weekdays_0700',
          timezone: context.timezone || 'America/Los_Angeles',
          subject_template: root.querySelector('.res-subject')?.value || S().defaultSubject(context.title),
          recipients: UI().readRecipients(root),
          allow_member_subscribe: !!root.querySelector('#resSubscribe')?.checked,
          is_active: true,
          is_paused: false,
        };
        const id = await S().saveSchedule(sb, row);
        await S().deliverNow(sb, id, 'test');
        onStatus?.('Test email sent (or queued).', 'pos', 5000);
      } catch (e) {
        onStatus?.(e.message || 'Test failed', 'neg', 6000);
      }
    });
  }

  async function mountLibraryTab(sb, userId, companyId, bodyEl, onStatus) {
    if (!await S().isWorkspaceAdmin(sb, userId, companyId)) {
      bodyEl.innerHTML = '<div class="lib-empty">Scheduled email is available to workspace admins.</div>';
      return;
    }
    bodyEl.innerHTML = '<div class="lib-empty">Loading schedules…</div>';
    try {
      const rows = await S().listSchedules(sb);
      bodyEl.innerHTML = UI().renderManageTable(rows)
        + '<p class="res-note" style="margin-top:10px"><button type="button" class="bcn-btn bcn-btn--ghost bcn-btn--sm" id="resPauseAll">Pause all</button></p>';
      bodyEl.querySelector('#resPauseAll')?.addEventListener('click', async () => {
        try {
          const n = await S().pauseAll(sb);
          onStatus?.(`Paused ${n} schedule(s).`, 'pos', 4000);
          mountLibraryTab(sb, userId, companyId, bodyEl, onStatus);
        } catch (e) { onStatus?.(e.message, 'neg', 5000); }
      });
      bodyEl.querySelectorAll('[data-run]').forEach((btn) => btn.addEventListener('click', async () => {
        try {
          await S().deliverNow(sb, btn.getAttribute('data-run'), 'manual');
          onStatus?.('Run started.', 'pos', 4000);
        } catch (e) { onStatus?.(e.message, 'neg', 6000); }
      }));
      bodyEl.querySelectorAll('[data-dup]').forEach((btn) => btn.addEventListener('click', async () => {
        try {
          await S().duplicateSchedule(sb, btn.getAttribute('data-dup'));
          onStatus?.('Schedule duplicated.', 'pos', 3000);
          mountLibraryTab(sb, userId, companyId, bodyEl, onStatus);
        } catch (e) { onStatus?.(e.message, 'neg', 6000); }
      }));
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
