/* Drafting an SEO task from a recommendation -- ONE definition, shared by
 * /v2/seo-keywords.html (Recommendations tab) and /v2/seo-studio.html.
 *
 * Nothing here approves or publishes anything: it writes an seo_tasks row
 * with approval_status 'draft' under the company's one "SEO Recommendations"
 * project, which it creates the first time. seo_tasks' own RLS decides who may
 * insert (any member of the active company, never 'approved' unless the caller
 * can approve), so this module carries no permission logic of its own.
 *
 * The project is found-or-created: seo_projects_recommendations_singleton (a
 * partial unique index) makes a second concurrent create fail, and the loser
 * re-reads and adopts the winner's row rather than minting a second project.
 */
(function () {
  'use strict';

  var PROJECT_NAME = 'SEO Recommendations';
  var cachedProjectId = null;

  function scoped(q, co) { return co && co.id ? q.eq('company_entity_id', co.id) : q; }

  async function findProject(sb, co) {
    var res = await scoped(sb.from('seo_projects').select('id').eq('name', PROJECT_NAME), co).order('created_at').limit(1);
    if (res.error) throw res.error;
    return res.data && res.data.length ? res.data[0].id : null;
  }

  async function findOrCreateProject(sb, co, evidenceNote) {
    if (cachedProjectId) return cachedProjectId;
    var existing = await findProject(sb, co);
    if (existing) { cachedProjectId = existing; return existing; }
    var created = await sb.from('seo_projects').insert(window.__SILO_CONFIG__.withCompany({
      name: PROJECT_NAME, status: 'active',
      evidence_note: evidenceNote || 'Auto-created the first time an SEO task was drafted from a recommendation (SERP observations + Search Console + competitor captures).',
    })).select('id');
    if (created.error || !created.data || !created.data.length) {
      var retry = await findProject(sb, co);
      if (retry) { cachedProjectId = retry; return retry; }
      throw created.error || new Error('Could not create the SEO Recommendations project.');
    }
    cachedProjectId = created.data[0].id;
    return cachedProjectId;
  }

  /** fields: { title, target_type, target_url, target_handle, rationale }.
   * Returns nothing; throws the PostgREST error on refusal. */
  async function createDraft(sb, co, fields, evidenceNote) {
    var f = fields || {};
    if (!String(f.title || '').trim()) throw new Error('Title cannot be blank.');
    var projectId = await findOrCreateProject(sb, co, evidenceNote);
    var payload = window.__SILO_CONFIG__.withCompany({
      project_id: projectId,
      title: String(f.title).trim(),
      target_type: f.target_type || null,
      target_url: (f.target_url && String(f.target_url).trim()) || null,
      target_handle: (f.target_handle && String(f.target_handle).trim()) || null,
      rationale: (f.rationale && String(f.rationale).trim()) || null,
      approval_status: 'draft',
    });
    var res = await sb.from('seo_tasks').insert(payload);
    if (res.error) throw res.error;
  }

  window.SiloSeoTaskDraft = { PROJECT_NAME: PROJECT_NAME, findOrCreateProject: findOrCreateProject, createDraft: createDraft };
})();
