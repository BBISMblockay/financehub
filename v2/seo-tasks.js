/* SEO Tasks: the decisions behind /v2/seo-tasks.html, kept apart from the page
 * so node can test them (v2/tests/unit/seo-tasks.test.js).
 *
 * A task moves draft -> proposed -> approved, or is rejected, and is PUBLISHED
 * only when someone records that the change went live (an seo_task_publications
 * row). Approval never publishes: the database refuses a publication for a task
 * that is not approved (check_seo_publication_admissible) and refuses one dated
 * in the future. These rules decide only which buttons a person is OFFERED; the
 * boundary is seo_tasks' RLS (the creator or can_approve_seo_tasks() may edit;
 * only an approver may set 'approved') and the publication triggers.
 *
 * Once a task has a publication its content is frozen here: the before/after
 * measurement describes the change that went live, so editing or reopening it
 * afterwards would measure one text against another. A new change is a new
 * task. */
(function () {
  'use strict';

  var STAGES = ['draft', 'proposed', 'approved', 'published', 'rejected'];
  var STAGE_LABEL = {
    draft: 'Draft',
    proposed: 'Waiting for approval',
    approved: 'Approved — not published yet',
    published: 'Published',
    rejected: 'Rejected',
  };
  // The fields a task proposes for the live page. They are what a future
  // "push to Shopify" would write, so they are edited here, not in free text.
  var PROPOSAL_FIELDS = ['proposed_title', 'proposed_meta_description', 'proposed_body'];
  var EDITABLE_FIELDS = ['title', 'target_url', 'rationale'].concat(PROPOSAL_FIELDS);

  function str(v) { return v == null ? '' : String(v); }

  function publicationsFor(task, pubs) {
    return (Array.isArray(pubs) ? pubs : []).filter(function (p) { return p && task && p.task_id === task.id; })
      .sort(function (a, b) { return str(a.published_at) < str(b.published_at) ? -1 : 1; });
  }

  /** Where a task stands. A publication outranks every status: once it went
   * live, that is the fact a reader needs first. */
  function stage(task, pubs) {
    if (!task) return null;
    if (publicationsFor(task, pubs).length) return 'published';
    return STAGES.indexOf(task.approval_status) >= 0 ? task.approval_status : 'draft';
  }

  /** The buttons offered for one task. who = { userId, canApprove }. */
  function actions(task, pubs, who) {
    var s = stage(task, pubs);
    var w = who || {};
    var mine = !!(task && w.userId && task.created_by === w.userId);
    var owner = mine || !!w.canApprove;
    var out = [];
    if (!s) return out;
    if (s === 'published') return out;
    if (owner && (s === 'draft' || s === 'proposed' || s === 'rejected')) out.push('edit');
    if (owner && s === 'draft') out.push('submit');
    if (owner && s === 'proposed' && !w.canApprove) out.push('withdraw');
    if (w.canApprove && (s === 'draft' || s === 'proposed')) out.push('approve');
    if (w.canApprove && (s === 'draft' || s === 'proposed' || s === 'approved')) out.push('reject');
    if (w.canApprove && s === 'approved') out.push('unapprove');
    if (owner && s === 'rejected') out.push('reopen');
    // Recording a publication is open to any member (the person who made the
    // change in Shopify may not be an approver); the database still refuses
    // it unless the task is approved.
    if (s === 'approved') out.push('publish');
    if (owner && (s === 'draft' || s === 'rejected')) out.push('delete');
    return out;
  }

  /** The seo_tasks update an action makes, or an error. revision_note captions
   * the revision record_seo_task_revision() writes for the change. */
  function patchFor(action, opts) {
    var o = opts || {};
    var now = o.now || new Date().toISOString();
    switch (action) {
      case 'submit': return { ok: true, patch: { approval_status: 'proposed', revision_note: 'Submitted for approval' } };
      case 'withdraw': return { ok: true, patch: { approval_status: 'draft', revision_note: 'Withdrawn from approval' } };
      case 'approve':
        if (!o.userId) return { ok: false, error: 'Not signed in.' };
        return { ok: true, patch: { approval_status: 'approved', approved_by: o.userId, approved_at: now, rejection_reason: null, revision_note: 'Approved' } };
      case 'unapprove':
        return { ok: true, patch: { approval_status: 'proposed', approved_by: null, approved_at: null, revision_note: 'Approval withdrawn' } };
      case 'reject': {
        var reason = str(o.reason).trim();
        if (!reason) return { ok: false, error: 'Say why it is rejected — the person who drafted it reads this.' };
        return { ok: true, patch: { approval_status: 'rejected', approved_by: null, approved_at: null, rejection_reason: reason, revision_note: 'Rejected' } };
      }
      case 'reopen': return { ok: true, patch: { approval_status: 'draft', revision_note: 'Reopened' } };
      case 'edit': {
        var f = o.fields || {};
        var patch = {};
        EDITABLE_FIELDS.forEach(function (k) {
          if (!(k in f)) return;
          var v = str(f[k]).trim();
          patch[k] = v || null;
        });
        if ('title' in patch && !patch.title) return { ok: false, error: 'Title cannot be blank.' };
        if (patch.target_url && !/^https?:\/\/\S+$/i.test(patch.target_url)) return { ok: false, error: 'Target URL must start with http:// or https://.' };
        patch.revision_note = 'Edited';
        return { ok: true, patch: patch };
      }
      default: return { ok: false, error: 'Unknown action.' };
    }
  }

  /** A publication date from the page's datetime-local input: required and
   * not in the future (the database refuses a scheduled publication). */
  function publishedAt(localValue, nowMs) {
    var v = str(localValue).trim();
    if (!v) return { ok: false, error: 'Enter when the change went live.' };
    var d = new Date(v);
    if (isNaN(d.getTime())) return { ok: false, error: 'That date could not be read.' };
    var now = nowMs == null ? Date.now() : nowMs;
    if (d.getTime() > now + 60000) return { ok: false, error: 'A publication is recorded after the change is live, never scheduled — the date is in the future.' };
    return { ok: true, iso: d.toISOString() };
  }

  /** The follow-up measurement dates a publication starts. */
  function followUps(publishedIso) {
    var t = Date.parse(publishedIso || '');
    if (isNaN(t)) return [];
    return [30, 90].map(function (n) { return { days: n, on: new Date(t + n * 86400000).toISOString().slice(0, 10) }; });
  }

  /** The Studio page for a task's URL, or null when it has none. */
  function studioHref(targetUrl, studio) {
    if (!targetUrl || !studio || typeof studio.pageKey !== 'function') return null;
    var key = studio.pageKey(targetUrl);
    return key ? '/v2/seo-studio.html?page=' + encodeURIComponent('page:' + key) : null;
  }

  /** Counts per stage for the filter chips. */
  function counts(tasks, pubs) {
    var c = { all: 0, draft: 0, proposed: 0, approved: 0, published: 0, rejected: 0 };
    (Array.isArray(tasks) ? tasks : []).forEach(function (t) {
      var s = stage(t, pubs);
      if (!s) return;
      c.all += 1; c[s] += 1;
    });
    return c;
  }

  /** Needs-a-decision first, then approved-awaiting-publication, then drafts,
   * then the settled ones; newest first within each. */
  var ORDER = { proposed: 0, approved: 1, draft: 2, published: 3, rejected: 4 };
  function sort(tasks, pubs) {
    return (Array.isArray(tasks) ? tasks : []).slice().sort(function (a, b) {
      var d = ORDER[stage(a, pubs)] - ORDER[stage(b, pubs)];
      if (d) return d;
      return str(b.created_at) < str(a.created_at) ? -1 : str(b.created_at) > str(a.created_at) ? 1 : 0;
    });
  }

  var API = {
    STAGES: STAGES, STAGE_LABEL: STAGE_LABEL, PROPOSAL_FIELDS: PROPOSAL_FIELDS, EDITABLE_FIELDS: EDITABLE_FIELDS,
    publicationsFor: publicationsFor, stage: stage, actions: actions, patchFor: patchFor,
    publishedAt: publishedAt, followUps: followUps, studioHref: studioHref, counts: counts, sort: sort,
  };
  if (typeof window !== 'undefined') window.SiloSeoTasks = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
