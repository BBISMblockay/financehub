/* DOM for scheduled CSV email (panel + library tab). */
(function (global) {
  'use strict';

  const S = () => global.SiloReportEmailSchedule;
  const esc = (s) => global.SiloChart?.esc(String(s ?? '')) ?? String(s ?? '');

  function cadenceOptions(selected) {
    return S().CADENCE.map((c) => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
  }

  /** The period control, or '' when this report has no date window to set.
   *  A report with no dates gets no control rather than a disabled one that
   *  implies a setting it does not have. */
  function periodField(ctx) {
    if (!ctx.dateKeys) return '';
    const editing = !!ctx.scheduleId;
    const hasPageState = !!ctx.pageParameterState;
    const selected = ctx.period_id
      || (editing ? S().KEEP_WINDOW : S().USE_PAGE_FILTERS);
    const opts = S().periodOptions({ editing, hasPageState })
      .map((p) => `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.label)}</option>`)
      .join('');
    const frozen = S().isSentinel(selected)
      && /fixed/.test(S().periodSummary(ctx.parameter_state, ctx.dateKeys));
    return `<div class="res-field"><span class="res-label">Period to send</span>
      <select class="bcn-field res-period">${opts}</select>
      <p class="res-note">A named period is worked out again on the morning it sends, so
        “Last month” always means the month that just ended. ${editing
          ? 'Keeping the window this schedule already sends leaves it exactly as it is, '
            + 'including specific dates.'
          : '“Use the filter values on this page” keeps whatever is applied right now, '
            + 'which stays fixed if those are specific dates.'}</p>
      ${frozen ? `<p class="res-note res-note--box">This schedule currently sends
        ${esc(S().periodSummary(ctx.parameter_state, ctx.dateKeys))} on every send. Pick a named
        period above if it should move with the calendar.</p>` : ''}</div>`;
  }

  function renderPanel(ctx) {
    const r = ctx.recipients || S().defaultRecipients();
    const outside = r.filter((x) => x.kind === 'email' && x.value).map((x) => x.value).join(', ');
    const editing = !!ctx.scheduleId;
    const adminBox = r.some((x) => x.kind === 'workspace_admins') ? 'checked' : '';
    const deptChecks = S().DEPARTMENTS.map((d) => {
      const on = r.some((x) => x.kind === 'department' && x.value === d);
      return `<label class="res-check"><input type="checkbox" data-dept="${esc(d)}"${on ? ' checked' : ''}/> ${esc(d)} department</label>`;
    }).join('');
    const people = (ctx.members || []).map((m) => {
      const on = r.some((x) => x.kind === 'profile' && x.id === m.id);
      return `<label class="res-check"><input type="checkbox" data-profile="${esc(m.id)}"${on ? ' checked' : ''}/> ${esc(m.name || m.email)}</label>`;
    }).join('');
    const q = ctx.queries || [];
    const qPick = q.length > 1 ? `<div class="res-field"><span class="res-label">Queries to attach</span>${q.map((qi, i) => {
      const on = !ctx.query_indices?.length || ctx.query_indices.includes(qi.index);
      return `<label class="res-check"><input type="checkbox" data-query="${qi.index}"${on ? ' checked' : ''}/> ${esc(qi.title || ('Query ' + (qi.index + 1)))}</label>`;
    }).join('')}</div>` : '';

    return `<div class="res-panel" id="reportEmailPanel">
      <div class="res-head"><h2>${editing ? 'Edit scheduled email' : 'Email CSV on schedule'}</h2>
        <p>${editing
          ? 'Editing the schedule that already exists for this report. Saving replaces it rather than adding a second one.'
          : 'Full export as attachments (or download links when very large). Admins only.'}</p></div>
      <div class="res-body">
        <div class="res-field"><span class="res-label">How often</span>
          <select class="bcn-field res-cadence">${cadenceOptions(ctx.cadence_preset || 'weekdays_0700')}</select>
          <p class="res-note">Company time · ${esc(ctx.timezone || 'America/Los_Angeles')}</p></div>
        ${periodField(ctx)}
        <div class="res-field"><span class="res-label">Send to</span>
          <label class="res-check"><input type="checkbox" id="resAdmins" ${adminBox}/> All workspace admins</label>
          ${deptChecks}
          <div class="res-people">${people}</div>
        </div>
        <div class="res-field"><span class="res-label">Also send outside the workspace</span>
          <textarea class="bcn-field res-external" id="resExternal" rows="2"
            placeholder="accountant@firm.com, buyer@store.com">${esc(outside)}</textarea>
          <p class="res-note">One or more addresses, separated by commas or new lines. These
            people have no SILO account, so they get the same export by email and nothing else.</p></div>
        ${qPick}
        <div class="res-field"><span class="res-label">Subject</span>
          <input class="bcn-field res-subject" value="${esc(ctx.subject_template || S().defaultSubject(ctx.title))}" /></div>
        <label class="res-check"><input type="checkbox" id="resSubscribe" ${ctx.allow_member_subscribe ? 'checked' : ''}/> Allow members to subscribe themselves</label>
        <label class="res-check"><input type="checkbox" id="resActive" ${ctx.is_active !== false ? 'checked' : ''}/> Schedule is on</label>
        <p class="res-note res-note--box">${editing
          ? 'These are this schedule\u2019s own settings, not this page\u2019s.'
          : (ctx.dateKeys
            ? 'Everything except the period above comes from the filter values applied on this page.'
            : 'Uses the filter values applied on this page.')} Large exports are not capped at 1,000 rows.</p>
      </div>
      <div class="res-foot">
        <button type="button" class="bcn-btn bcn-btn--primary" id="resSave">Save</button>
        <button type="button" class="bcn-btn bcn-btn--ghost" id="resTest">Send test now</button>
        <button type="button" class="bcn-btn bcn-btn--ghost" id="resClose">Close</button>
      </div>
    </div>`;
  }

  /** Throws on a malformed address, so a typo is caught where it can still
   *  be corrected rather than silently dropped by the resolver at send time. */
  function readRecipients(root) {
    const out = [];
    if (root.querySelector('#resAdmins')?.checked) out.push({ kind: 'workspace_admins' });
    root.querySelectorAll('[data-dept]').forEach((el) => {
      if (el.checked) out.push({ kind: 'department', value: el.getAttribute('data-dept') });
    });
    root.querySelectorAll('[data-profile]').forEach((el) => {
      if (el.checked) out.push({ kind: 'profile', id: el.getAttribute('data-profile') });
    });
    const { emails, invalid } = S().parseEmailList(root.querySelector('#resExternal')?.value);
    if (invalid.length) {
      throw new Error(`Not an email address: ${invalid.slice(0, 3).join(', ')}`);
    }
    for (const email of emails) out.push({ kind: 'email', value: email });
    if (!out.length) out.push({ kind: 'workspace_admins' });
    return out;
  }

  /** The chosen period id, or undefined when the panel rendered no period
   *  control -- which is not the same as choosing "page filters". A report
   *  with no date window must leave parameter_state exactly as it was. */
  function readPeriodId(root) {
    const sel = root.querySelector('.res-period');
    return sel ? sel.value : undefined;
  }

  /** The parts the user picked, or `undefined` when the panel rendered NO
   *  query controls at all -- which is not the same as picking none. A panel
   *  opened without the report's query metadata (the schedules table's Edit)
   *  has no boxes to read, and a caller that treated that as "none picked"
   *  would overwrite a stored subset with null, which the delivery side reads
   *  as "every declared part". */
  function readQueryIndices(root) {
    const boxes = [...root.querySelectorAll('[data-query]')];
    if (!boxes.length) return undefined;
    const picked = boxes.filter((b) => b.checked).map((b) => Number(b.getAttribute('data-query')));
    return picked.length ? picked : null;
  }

  const DATE = { month: 'numeric', day: 'numeric' };
  const DATETIME = { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const when = (iso, opts) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, opts);
  };

  /** The run status as a word, not a raw enum. A schedule that has never run
      says so rather than showing an empty cell next to a date that is also
      empty, which reads as broken. */
  function lastRunCell(row) {
    if (!row.last_run_at) return '<span class="res-dim">Not sent yet</span>';
    const status = String(row.last_run_status || '');
    const tone = status === 'failed' ? 'neg' : status === 'succeeded' ? 'pos' : '';
    const label = status === 'succeeded' ? 'Sent' : status === 'failed' ? 'Failed' : status || 'Sent';
    return `${esc(when(row.last_run_at, DATETIME))} <span class="res-tag${tone ? ' res-tag--' + tone : ''}">${esc(label)}</span>`;
  }

  function stateCell(row) {
    if (row.is_paused) return '<span class="res-tag">Paused</span>';
    if (!row.is_active) return '<span class="res-tag">Off</span>';
    return '<span class="res-tag res-tag--pos">On</span>';
  }

  /** `members` names the people a schedule sends to; without it the summary
      still renders, just without their names. */
  function renderManageTable(rows, members) {
    if (!rows.length) {
      return `<div class="lib-empty"><strong>No scheduled email yet</strong>
        Open any saved report, then <em>Email CSV on schedule</em> in the preview header.</div>`;
    }
    const tr = rows.map((s2) => `<tr>
      <td><strong>${esc(s2.target_title || s2.name || 'Untitled')}</strong>
        <div class="res-dim">${esc(s2.target_kind === 'dashboard' ? 'Dashboard' : 'Report')}</div></td>
      <td>${esc(S().cadenceLabel(s2.cadence_preset))}</td>
      <td>${(() => {
        const label = S().periodSummaryFromState(s2.parameter_state);
        return label === 'Fixed dates'
          ? `<span class="res-tag res-tag--neg">${esc(label)}</span>`
          : esc(label);
      })()}</td>
      <td>${esc(S().recipientSummary(s2.recipients, members))}${s2.subscriber_count
        ? ` <span class="res-dim">+ ${esc(s2.subscriber_count)} subscribed</span>` : ''}</td>
      <td>${lastRunCell(s2)}</td>
      <td>${esc(when(s2.next_run_at, DATE))}</td>
      <td>${stateCell(s2)}</td>
      <td class="res-actions">
        <button type="button" class="bcn-btn bcn-btn--sm" data-edit="${esc(s2.id)}">Edit</button>
        <button type="button" class="bcn-btn bcn-btn--sm" data-run="${esc(s2.id)}">Send now</button>
        <button type="button" class="bcn-btn bcn-btn--sm" data-dup="${esc(s2.id)}">Duplicate</button>
        <button type="button" class="bcn-btn bcn-btn--sm bcn-btn--danger" data-del="${esc(s2.id)}">Delete</button>
      </td></tr>`).join('');
    // Beacon's th is right-aligned by default and needs bcn-th-left for a
    // text column; table-layout is fixed, so the widths have to be stated.
    return `<div class="bcn-card"><div class="bcn-card-body" style="padding:0">
      <table class="bcn-table res-table"><thead><tr>
      <th class="bcn-th-left">Report</th>
      <th class="bcn-th-left">How often</th>
      <th class="bcn-th-left">Period</th>
      <th class="bcn-th-left">Goes to</th>
      <th class="bcn-th-left">Last sent</th>
      <th class="bcn-th-left">Next</th>
      <th class="bcn-th-left">Status</th>
      <th class="bcn-th-left"><span class="res-sr">Actions</span></th>
    </tr></thead><tbody>${tr}</tbody></table></div></div>`;
  }

  global.SiloReportEmailScheduleUI = {
    renderPanel, readRecipients, readQueryIndices, readPeriodId, renderManageTable,
    recipientSummary: (r, m) => S().recipientSummary(r, m),
  };
}(typeof window !== 'undefined' ? window : globalThis));
