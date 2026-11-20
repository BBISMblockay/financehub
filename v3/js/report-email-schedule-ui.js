/* ============================================================================
   DOM for scheduled report email: the schedule panel, the Schedules view, and
   one schedule's delivery history.
   --------------------------------------------------------------------------
   The panel used to be a form over the storage shape -- one "How often"
   dropdown whose four options each baked in an hour, a period picker, forty
   recipient checkboxes, and nothing that said what would arrive or when. This
   version asks the same questions a calendar invite does, in that order, and
   shows the answer back as one sentence a person can check:

     How often  ·  At  ·  Time zone  ·  Reporting period  ·  Who  ·  Subject

   Delivery time and reporting period are deliberately two controls that never
   share a line: "every Monday at 7:00 AM" is when the mail leaves, "last week"
   is what it covers, and one dropdown could not say both.

   Wording that must not drift lives in report-schedule-plan.js (the sentence,
   the first send, what arrives, a failure in plain language, and why "Sent" is
   never "Delivered"). This file only places it.
   ========================================================================== */
(function (global) {
  'use strict';

  const S = () => global.SiloReportEmailSchedule;
  const PL = () => global.SiloReportSchedulePlan;
  const esc = (s) => global.SiloChart?.esc(String(s ?? '')) ?? String(s ?? '');

  /* ── The two halves of a cadence ──────────────────────────────────────── */

  function frequencyOptions(selected) {
    return PL().FREQUENCIES
      .map((f) => `<option value="${esc(f.id)}"${f.id === selected ? ' selected' : ''}>${esc(f.label)}</option>`)
      .join('');
  }

  function timeOptions(selected) {
    return PL().DELIVERY_TIMES
      .map((t) => `<option value="${esc(t.id)}"${t.id === selected ? ' selected' : ''}>${esc(t.label)}</option>`)
      .join('');
  }

  /**
   * The time-zone control, or the one zone stated in words.
   *
   * `supported_business_timezones` is the list of zones SILO honours end to
   * end, and it ships with exactly one row. A select with one option is a fake
   * control, and a select listing every IANA zone would be a lie -- the day
   * boundary every report is anchored to would still be the workspace's. So:
   * one supported zone, state it and say why; more than one, offer them. No
   * zone name is written here, which is also the project rule -- a company fact
   * belongs in data.
   */
  function timezoneField(ctx) {
    const zones = Array.isArray(ctx.timezoneZones) ? ctx.timezoneZones : [];
    const name = ctx.timezone || '';
    const words = PL().zoneWords(name, ctx.timezoneLabel);
    if (zones.length > 1) {
      const opts = zones.map((z) => `<option value="${esc(z.tz_name)}"${z.tz_name === name ? ' selected' : ''}>${esc(z.label || z.tz_name)}</option>`).join('');
      return `<div class="res-field"><span class="res-label">Time zone</span>
        <select class="bcn-field res-timezone">${opts}</select></div>`;
    }
    return `<div class="res-field"><span class="res-label">Time zone</span>
      <p class="res-fixed">${esc(words || name || 'Your workspace’s time zone')}</p>
      <p class="res-note">Every SILO report is anchored to your workspace’s reporting time zone,
        so a schedule sends on that clock.</p>
      <input type="hidden" class="res-timezone" value="${esc(name)}" /></div>`;
  }

  /* ── The reporting period ─────────────────────────────────────────────── */

  /** The period control, or '' when this report has no date window to set.
   *  A report with no dates gets no control rather than a disabled one that
   *  implies a setting it does not have. */
  function periodField(ctx) {
    if (!ctx.dateKeys) return '';
    const editing = !!ctx.scheduleId;
    const hasPageState = !!ctx.pageParameterState;
    const selected = ctx.period_id || (editing ? S().KEEP_WINDOW : S().USE_PAGE_FILTERS);
    const opts = S().periodOptions({ editing, hasPageState })
      .map((p) => `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.label)}</option>`)
      .join('');
    const frozen = S().isSentinel(selected)
      && /fixed/.test(S().periodSummary(ctx.parameter_state, ctx.dateKeys));
    return `<div class="res-field"><span class="res-label">Dates the report covers</span>
      <select class="bcn-field res-period">${opts}</select>
      <p class="res-note">Separate from the delivery time above. A named period is worked out again on
        the morning it sends, so &ldquo;Last week&rdquo; always means the week that just ended.</p>
      ${frozen ? `<p class="res-note res-note--box">This schedule currently sends
        ${esc(S().periodSummary(ctx.parameter_state, ctx.dateKeys))} on every send. Pick a named
        period above if it should move with the calendar.</p>` : ''}</div>`;
  }

  /** The period in words for the summary sentence: the label of the option
   *  that is selected, and nothing invented when the window is not a named
   *  period. */
  function periodWords(ctx) {
    const editing = !!ctx.scheduleId;
    const id = ctx.period_id || (editing ? S().KEEP_WINDOW : S().USE_PAGE_FILTERS);
    if (!ctx.dateKeys) return '';
    if (S().isSentinel(id)) {
      const stored = S().periodSummary(ctx.parameter_state, ctx.dateKeys);
      return /fixed|Report default/.test(stored) ? '' : stored;
    }
    return S().periodOptions({ editing, hasPageState: !!ctx.pageParameterState })
      .find((p) => p.id === id)?.label || '';
  }

  /* ── The summary: what this schedule will actually do ─────────────────── */

  /**
   * One sentence, plus the first send, plus what arrives. Re-rendered in place
   * on every control change, so the sentence is never stale -- a preview that
   * describes the settings someone had a moment ago is worse than none.
   *
   * The first send is computed with the SAME function the runner uses to set
   * next_run_at (computeNextRunAt, pinned against the runner's copy by
   * scripts/tests/report-email-deliver.test.mjs), so the date shown is the date
   * stored, not a second guess at it.
   */
  function summaryHtml(ctx) {
    const parts = S().cadenceParts(ctx.cadence_preset);
    const line = PL().sentence({
      frequency: parts.frequency,
      time: parts.time,
      timezone: ctx.timezone,
      timezoneLabel: ctx.timezoneLabel,
      periodLabel: periodWords(ctx),
      reportTitle: ctx.title,
    });
    const nextRun = S().computeNextRunAt(ctx.cadence_preset, ctx.timezone);
    const first = PL().firstSendSentence(nextRun, {
      timezone: ctx.timezone, timezoneLabel: ctx.timezoneLabel,
    });
    return `<p class="res-sentence">${esc(line)}</p>
      <p class="res-note">${esc(first)}</p>
      <p class="res-note">${esc(PL().CONTENTS_LINE)}</p>`;
  }

  /* ── Recipients ───────────────────────────────────────────────────────── */

  /**
   * Who it goes to.
   *
   * The first version listed every workspace member as a checkbox, which put
   * the outside-addresses box and Send test below forty controls and gave no
   * answer to "so who gets this". Here the people list is one scrollable box
   * with a filter over it, and a live line above says who is currently
   * selected -- the same wording the Schedules view shows, from the same
   * function, so the panel and the table can never describe one schedule two
   * ways.
   *
   * Only people who can already read the workspace are offerable: `members` is
   * entity_memberships joined to active profiles. Outside addresses are a
   * separate, named decision, because an address with no SILO account gets the
   * export and nothing else.
   */
  function recipientsField(ctx) {
    const r = ctx.recipients || S().defaultRecipients();
    const outside = r.filter((x) => x.kind === 'email' && x.value).map((x) => x.value).join(', ');
    const adminBox = r.some((x) => x.kind === 'workspace_admins') ? 'checked' : '';
    const deptChecks = S().DEPARTMENTS.map((d) => {
      const on = r.some((x) => x.kind === 'department' && x.value === d);
      return `<label class="res-check"><input type="checkbox" data-dept="${esc(d)}"${on ? ' checked' : ''}/> ${esc(d)} department</label>`;
    }).join('');
    const people = (ctx.members || []).map((m) => {
      const on = r.some((x) => x.kind === 'profile' && x.id === m.id);
      const label = m.name || m.email;
      return `<label class="res-check" data-person="${esc(String(label).toLowerCase())} ${esc(String(m.email || '').toLowerCase())}">
        <input type="checkbox" data-profile="${esc(m.id)}"${on ? ' checked' : ''}/> ${esc(label)}</label>`;
    }).join('');
    return `<div class="res-field"><span class="res-label">Who gets it</span>
      <p class="res-goes" id="resGoesTo"></p>
      <label class="res-check"><input type="checkbox" id="resAdmins" ${adminBox}/> Everyone who administers this workspace</label>
      ${deptChecks}
      ${people ? `<input type="search" class="bcn-field res-peoplefilter" id="resPeopleFilter"
          placeholder="Find a teammate" aria-label="Find a teammate" autocomplete="off" />
        <div class="res-people">${people}</div>` : ''}
      <label class="res-label res-label--inline" for="resExternal">Also send outside the workspace</label>
      <textarea class="bcn-field res-external" id="resExternal" rows="2"
        placeholder="accountant@firm.com">${esc(outside)}</textarea>
      <p class="res-note">These people have no SILO account, so they get the export by email and
        nothing else.</p></div>`;
  }

  /* ── The panel ────────────────────────────────────────────────────────── */

  function renderPanel(ctx) {
    const editing = !!ctx.scheduleId;
    const parts = S().cadenceParts(ctx.cadence_preset);
    const q = ctx.queries || [];
    const qPick = q.length > 1 ? `<div class="res-field"><span class="res-label">Parts to attach</span>${q.map((qi) => {
      const on = !ctx.query_indices?.length || ctx.query_indices.includes(qi.index);
      return `<label class="res-check"><input type="checkbox" data-query="${qi.index}"${on ? ' checked' : ''}/> ${esc(qi.title || ('Part ' + (qi.index + 1)))}</label>`;
    }).join('')}</div>` : '';

    return `<div class="res-panel" id="reportEmailPanel">
      <div class="res-head"><h2>${editing ? 'Edit this schedule' : 'Email this report on a schedule'}</h2>
        ${editing ? '<p>Saving replaces this schedule rather than adding a second one.</p>' : ''}</div>
      <div class="res-body">
        <div class="res-summary" id="resSummary">${summaryHtml(ctx)}</div>
        <div class="res-row">
          <div class="res-field"><span class="res-label">How often</span>
            <select class="bcn-field res-frequency">${frequencyOptions(parts.frequency)}</select></div>
          <div class="res-field"><span class="res-label">At</span>
            <select class="bcn-field res-time">${timeOptions(parts.time)}</select></div>
        </div>
        ${timezoneField(ctx)}
        ${periodField(ctx)}
        ${recipientsField(ctx)}
        ${qPick}
        <div class="res-field"><span class="res-label">Subject</span>
          <input class="bcn-field res-subject" value="${esc(ctx.subject_template || S().defaultSubject(ctx.title))}" /></div>
        <label class="res-check"><input type="checkbox" id="resSubscribe" ${ctx.allow_member_subscribe ? 'checked' : ''}/> Let teammates subscribe themselves</label>
        <label class="res-check"><input type="checkbox" id="resActive" ${ctx.is_active !== false ? 'checked' : ''}/> Schedule is on</label>
        <p class="res-note">${editing
          ? 'These are this schedule’s own settings, not this page’s.'
          : (ctx.dateKeys
            ? 'Every filter except the dates above comes from what is applied on this page.'
            : 'Uses the filter values applied on this page.')} The export is not capped at 1,000 rows.</p>
      </div>
      <div class="res-foot">
        <button type="button" class="bcn-btn bcn-btn--primary" id="resSave">${editing ? 'Save changes' : 'Schedule it'}</button>
        <button type="button" class="bcn-btn bcn-btn--ghost" id="resTest">Send me a test</button>
        <button type="button" class="bcn-btn bcn-btn--ghost" id="resClose">Cancel</button>
      </div>
    </div>`;
  }

  /** The cadence the two controls currently name. */
  function readCadencePreset(root) {
    return PL().presetFor(
      root.querySelector('.res-frequency')?.value,
      root.querySelector('.res-time')?.value,
    );
  }

  function readTimezone(root, fallback) {
    return root.querySelector('.res-timezone')?.value || fallback || '';
  }

  /**
   * Re-render the summary and the "goes to" line from the controls as they
   * stand. Only those two nodes are replaced: rebuilding the panel's innerHTML
   * would drop typed input, which is the same mistake filter-bar.js records
   * having made.
   */
  function refreshPanel(root, ctx) {
    const live = {
      ...ctx,
      cadence_preset: readCadencePreset(root),
      timezone: readTimezone(root, ctx.timezone),
      period_id: root.querySelector('.res-period')?.value || ctx.period_id,
    };
    if (live.timezone !== ctx.timezone) {
      const hit = (ctx.timezoneZones || []).find((z) => z.tz_name === live.timezone);
      live.timezoneLabel = hit?.label || '';
    }
    const summary = root.querySelector('#resSummary');
    if (summary) summary.innerHTML = summaryHtml(live);
    const goes = root.querySelector('#resGoesTo');
    if (goes) {
      let text;
      try { text = S().recipientSummary(readRecipients(root), ctx.members); }
      catch (e) { text = e.message; }
      goes.textContent = text;
    }
    return live;
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
   *  opened without the report's query metadata (the Schedules view's Edit)
   *  has no boxes to read, and a caller that treated that as "none picked"
   *  would overwrite a stored subset with null, which the delivery side reads
   *  as "every declared part". */
  function readQueryIndices(root) {
    const boxes = [...root.querySelectorAll('[data-query]')];
    if (!boxes.length) return undefined;
    const picked = boxes.filter((b) => b.checked).map((b) => Number(b.getAttribute('data-query')));
    return picked.length ? picked : null;
  }

  /* ── The Schedules view ───────────────────────────────────────────────── */

  const DATE = { month: 'short', day: 'numeric' };
  const DATETIME = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const when = (iso, opts) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, opts);
  };

  /** The last send as a word plus when, never "Delivered". */
  function lastRunCell(row) {
    if (!row.last_run_at) return '<span class="res-dim">Not sent yet</span>';
    const label = PL().statusLabel({ last_run_at: row.last_run_at, status: row.last_run_status });
    const tone = PL().statusTone({ last_run_at: row.last_run_at, status: row.last_run_status });
    return `${esc(when(row.last_run_at, DATETIME))}
      <span class="res-tag${tone ? ' res-tag--' + tone : ''}" title="${esc(PL().SENT_MEANING)}">${esc(label)}</span>`;
  }

  function stateCell(row) {
    if (row.is_paused) {
      return PL().pauseReason(row) === 'failure'
        ? '<span class="res-tag res-tag--neg">Paused after a failure</span>'
        : '<span class="res-tag">Paused</span>';
    }
    if (!row.is_active) return '<span class="res-tag">Off</span>';
    return '<span class="res-tag res-tag--pos">On</span>';
  }

  /** A failed send explained, with the next step, inline under the row. Always
   *  shown when there is an error -- a failure behind a disclosure control is a
   *  failure nobody reads. */
  function failureRow(row, columns) {
    const why = PL().explainFailure(row.last_error, { paused: !!row.is_paused });
    if (!why) return '';
    return `<tr class="res-failrow"><td colspan="${columns}">
      <strong>${esc(why.headline)}</strong> ${esc(why.next)}
      <div class="res-dim">${esc(why.state)}</div>
      <div class="res-dim res-errtext">${esc(why.detail)}</div></td></tr>`;
  }

  const COLUMNS = ['Report', 'Sends', 'Dates covered', 'Who gets it', 'Owner', 'Next send', 'Last send', 'Status', ''];

  /** `members` names the people a schedule sends to; without it the summary
      still renders, just without their names. */
  function renderManageTable(rows, members) {
    if (!rows.length) {
      return `<div class="lib-empty"><strong>Nothing is scheduled yet</strong>
        Open a report, then <em>Schedule</em> in its header.</div>`;
    }
    const tr = rows.map((s2) => {
      const period = S().periodSummaryFromState(s2.parameter_state);
      const paused = !!s2.is_paused;
      return `<tr data-row="${esc(s2.id)}">
      <td><strong>${esc(s2.target_title || s2.name || 'Untitled')}</strong>
        <div class="res-dim">${esc(s2.target_kind === 'dashboard' ? 'Dashboard' : 'Report')} · ${esc(PL().CONTENTS_SHORT)}</div></td>
      <td>${esc(S().cadenceLabel(s2.cadence_preset))}
        <div class="res-dim">${esc(PL().zoneWords(s2.timezone, ''))}</div></td>
      <td>${period === 'Fixed dates'
        ? `<span class="res-tag res-tag--neg">${esc(period)}</span>`
        : esc(period)}</td>
      <td>${esc(S().recipientSummary(s2.recipients, members))}${s2.subscriber_count
        ? ` <span class="res-dim">+ ${esc(s2.subscriber_count)} subscribed</span>` : ''}</td>
      <td>${esc(s2.created_by_name || s2.created_by_email || '—')}</td>
      <td>${paused ? '<span class="res-dim">Paused</span>' : esc(when(s2.next_run_at, DATE))}</td>
      <td>${lastRunCell(s2)}</td>
      <td>${stateCell(s2)}</td>
      <td class="res-actions">
        <button type="button" class="bcn-btn bcn-btn--sm" data-edit="${esc(s2.id)}">Edit</button>
        <button type="button" class="bcn-btn bcn-btn--sm" data-${paused ? 'resume' : 'pause'}="${esc(s2.id)}">${paused ? 'Resume' : 'Pause'}</button>
        <button type="button" class="bcn-btn bcn-btn--sm" data-history="${esc(s2.id)}">History</button>
        <button type="button" class="bcn-btn bcn-btn--sm" data-run="${esc(s2.id)}">Send now</button>
        <button type="button" class="bcn-btn bcn-btn--sm" data-dup="${esc(s2.id)}">Duplicate</button>
        <button type="button" class="bcn-btn bcn-btn--sm bcn-btn--danger" data-del="${esc(s2.id)}">Delete</button>
      </td></tr>${failureRow(s2, COLUMNS.length)}
      <tr class="res-historyrow" data-history-for="${esc(s2.id)}" hidden><td colspan="${COLUMNS.length}"></td></tr>`;
    }).join('');
    // Beacon's th is right-aligned by default and needs bcn-th-left for a
    // text column; table-layout is fixed, so the widths have to be stated.
    return `<div class="bcn-card"><div class="bcn-card-body" style="padding:0">
      <table class="bcn-table res-table"><thead><tr>${
        COLUMNS.map((c) => `<th class="bcn-th-left">${c ? esc(c) : '<span class="res-sr">Actions</span>'}</th>`).join('')
      }</tr></thead><tbody>${tr}</tbody></table></div></div>`;
  }

  /* ── One schedule's delivery history ─────────────────────────────────── */

  const TRIGGER_WORDS = { schedule: 'On schedule', manual: 'Sent now by a person', test: 'Test send' };

  /**
   * Every recorded run, newest first.
   *
   * `trigger_kind` is shown as prominently as the status on purpose. A run log
   * full of `test` rows and no `schedule` row means the unattended path has
   * never once worked, which is exactly what went unnoticed for five days in
   * October (docs/ops/two-step-login.md) because every green row was somebody
   * clicking the button.
   */
  function renderRunHistory(runs) {
    if (!runs.length) {
      return `<div class="res-history"><p class="res-dim">No sends recorded yet. A schedule records
        every attempt here, including the ones that failed.</p></div>`;
    }
    const hasScheduled = runs.some((r) => r.trigger_kind === 'schedule' && r.status === 'succeeded');
    const rows = runs.map((r) => {
      const label = PL().statusLabel(r);
      const tone = PL().statusTone(r);
      const why = r.status === 'failed' ? PL().explainFailure(r.error_message, {}) : null;
      return `<tr>
        <td>${esc(when(r.started_at, DATETIME))}</td>
        <td>${esc(TRIGGER_WORDS[r.trigger_kind] || r.trigger_kind || '—')}</td>
        <td class="bcn-num">${r.total_rows == null ? '—' : esc(Number(r.total_rows).toLocaleString())}</td>
        <td class="bcn-num">${r.recipient_count == null ? '—' : esc(r.recipient_count)}</td>
        <td>${r.delivery_mode === 'storage_link' ? 'Download link' : r.delivery_mode === 'attachment' ? 'CSV attached' : esc(r.delivery_mode || '—')}</td>
        <td><span class="res-tag${tone ? ' res-tag--' + tone : ''}">${esc(label)}</span>
          ${why ? `<div class="res-dim">${esc(why.headline)} ${esc(why.next)}</div>` : ''}</td>
      </tr>`;
    }).join('');
    return `<div class="res-history">
      ${hasScheduled ? '' : `<p class="res-note res-note--box">No send has yet gone out on the
        schedule itself &mdash; every row below was started by a person. Until one does, this
        schedule is not proven to run unattended.</p>`}
      <table class="bcn-table res-runtable"><thead><tr>
        <th class="bcn-th-left">Started</th><th class="bcn-th-left">What started it</th>
        <th class="bcn-th-left">Rows</th><th class="bcn-th-left">Recipients</th>
        <th class="bcn-th-left">Arrived as</th><th class="bcn-th-left">Result</th>
      </tr></thead><tbody>${rows}</tbody></table>
      <p class="res-note">${esc(PL().SENT_MEANING)}</p></div>`;
  }

  global.SiloReportEmailScheduleUI = {
    renderPanel, readRecipients, readQueryIndices, readPeriodId, renderManageTable,
    readCadencePreset, readTimezone, refreshPanel, renderRunHistory,
    summaryHtml, periodWords, frequencyOptions, timeOptions,
    recipientSummary: (r, m) => S().recipientSummary(r, m),
  };
}(typeof window !== 'undefined' ? window : globalThis));
