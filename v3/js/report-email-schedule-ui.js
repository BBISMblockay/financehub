/* DOM for scheduled CSV email (panel + library tab). */
(function (global) {
  'use strict';

  const S = () => global.SiloReportEmailSchedule;
  const esc = (s) => global.SiloChart?.esc(String(s ?? '')) ?? String(s ?? '');

  function cadenceOptions(selected) {
    return S().CADENCE.map((c) => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
  }

  function renderPanel(ctx) {
    const r = ctx.recipients || S().defaultRecipients();
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
      <div class="res-head"><h2>Email CSV on schedule</h2><p>Full export as attachments (or download links when very large). Admins only.</p></div>
      <div class="res-body">
        <div class="res-field"><span class="res-label">How often</span>
          <select class="bcn-field res-cadence">${cadenceOptions(ctx.cadence_preset || 'weekdays_0700')}</select>
          <p class="res-note">Company time · ${esc(ctx.timezone || 'America/Los_Angeles')}</p></div>
        <div class="res-field"><span class="res-label">Send to</span>
          <label class="res-check"><input type="checkbox" id="resAdmins" ${adminBox}/> All workspace admins</label>
          ${deptChecks}
          <div class="res-people">${people}</div>
        </div>
        ${qPick}
        <div class="res-field"><span class="res-label">Subject</span>
          <input class="bcn-field res-subject" value="${esc(ctx.subject_template || S().defaultSubject(ctx.title))}" /></div>
        <label class="res-check"><input type="checkbox" id="resSubscribe" ${ctx.allow_member_subscribe ? 'checked' : ''}/> Allow members to subscribe themselves</label>
        <label class="res-check"><input type="checkbox" id="resActive" ${ctx.is_active !== false ? 'checked' : ''}/> Schedule is on</label>
        <p class="res-note res-note--box">Uses the filter values applied on this page. Large exports are not capped at 1,000 rows.</p>
      </div>
      <div class="res-foot">
        <button type="button" class="bcn-btn bcn-btn--primary" id="resSave">Save</button>
        <button type="button" class="bcn-btn bcn-btn--ghost" id="resTest">Send test now</button>
        <button type="button" class="bcn-btn bcn-btn--ghost" id="resClose">Close</button>
      </div>
    </div>`;
  }

  function readRecipients(root) {
    const out = [];
    if (root.querySelector('#resAdmins')?.checked) out.push({ kind: 'workspace_admins' });
    root.querySelectorAll('[data-dept]').forEach((el) => {
      if (el.checked) out.push({ kind: 'department', value: el.getAttribute('data-dept') });
    });
    root.querySelectorAll('[data-profile]').forEach((el) => {
      if (el.checked) out.push({ kind: 'profile', id: el.getAttribute('data-profile') });
    });
    if (!out.length) out.push({ kind: 'workspace_admins' });
    return out;
  }

  function readQueryIndices(root) {
    const boxes = [...root.querySelectorAll('[data-query]')];
    if (!boxes.length) return null;
    const picked = boxes.filter((b) => b.checked).map((b) => Number(b.getAttribute('data-query')));
    return picked.length ? picked : null;
  }

  function renderManageTable(rows) {
    if (!rows.length) return '<div class="lib-empty"><strong>No scheduled email yet</strong>Create one from any report preview or the report builder.</div>';
    const tr = rows.map((s) => `<tr>
      <td><strong>${esc(s.target_title || s.name || 'Untitled')}</strong><br><span class="res-note">${esc(s.target_kind)}</span></td>
      <td class="bcn-mono">${esc(s.cadence_preset || '')}</td>
      <td>${esc(s.subscriber_count ? `${s.subscriber_count} subs` : JSON.stringify(s.recipients || []).slice(0, 40))}</td>
      <td class="bcn-mono">${s.last_run_at ? esc(new Date(s.last_run_at).toLocaleString()) : '—'} · ${esc(s.last_run_status || '')}</td>
      <td class="bcn-mono">${s.next_run_at ? esc(new Date(s.next_run_at).toLocaleDateString()) : '—'}</td>
      <td>${s.is_paused ? 'Paused' : (s.is_active ? 'On' : 'Off')}</td>
      <td class="res-actions">
        <button type="button" class="bcn-btn bcn-btn--ghost bcn-btn--sm" data-edit="${esc(s.id)}">Edit</button>
        <button type="button" class="bcn-btn bcn-btn--ghost bcn-btn--sm" data-run="${esc(s.id)}">Run now</button>
        <button type="button" class="bcn-btn bcn-btn--ghost bcn-btn--sm" data-dup="${esc(s.id)}">Duplicate</button>
      </td></tr>`).join('');
    return `<div class="bcn-card"><div class="bcn-card-body" style="padding:0"><table class="bcn-table"><thead><tr>
      <th>Target</th><th>Cadence</th><th>Recipients</th><th>Last sent</th><th>Next</th><th>Status</th><th></th>
    </tr></thead><tbody>${tr}</tbody></table></div></div>`;
  }

  global.SiloReportEmailScheduleUI = {
    renderPanel, readRecipients, readQueryIndices, renderManageTable,
  };
}(typeof window !== 'undefined' ? window : globalThis));
