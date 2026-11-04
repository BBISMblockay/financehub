/* Workspace menu preferences. Database RLS is the write boundary. */
(async function () {
  'use strict';
  const cfg = window.__SILO_CONFIG__ || {}, nav = window.SiloNav;
  const $ = id => document.getElementById(id);
  const status = (text, kind = 'info') => {
    $('status').textContent = text;
    $('status').className = `bcn-status bcn-status--${kind}`;
    $('status').hidden = false;
  };
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) { status('Missing Supabase config', 'neg'); return; }
  const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  const check = result => { if (result.error) throw new Error(result.error.message); return result.data; };
  let company, canEdit = false, available = false, busy = false;
  const controls = [];
  const lock = () => controls.forEach(input => { input.disabled = busy || !available || !canEdit; });
  // ensureActiveCompany can fall back to cache on network errors. The fresh
  // profile read below must succeed as well before this page offers a write.
  async function current() {
    const co = await cfg.ensureActiveCompany(db);
    const user = check(await db.auth.getUser())?.user;
    if (!user || !co?.id || co._staleReconcile) throw new Error('Workspace unavailable. Reload settings to try again.');
    const profile = check(await db.from('profiles').select('active_company_id').eq('id', user.id).single());
    if (profile?.active_company_id !== co.id || (company && co.id !== company.id)) {
      throw new Error('Workspace changed. Reload this page before changing modules.');
    }
    return { co, user };
  }
  async function load() {
    available = false; canEdit = false; lock();
    const { co, user } = await current();
    company = co;
    $('module-company').textContent = `${co.title || 'Workspace'} · Menu visibility`;
    const membership = check(await db.from('entity_memberships').select('role')
      .eq('entity_id', co.id).eq('user_id', user.id).maybeSingle());
    if (!membership) throw new Error('Workspace membership required.');
    canEdit = ['owner_admin', 'admin'].includes(membership.role);
    const visibility = await nav.loadModuleVisibility(db, co, true);
    if (!visibility) throw new Error('Module settings could not be loaded. Existing menu visibility is preserved. Reload settings to try again.');
    await current();
    controls.forEach(input => { input.checked = visibility[input.value] !== false; });
    $('module-permission').textContent = canEdit
      ? 'Workspace owners and administrators can change these switches.'
      : 'Only workspace owners and administrators can change these switches.';
    available = true; lock();
  }
  for (const module of nav.MODULES) {
    const label = document.createElement('label'); label.className = 'ws-field';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = module.id;
    input.disabled = true; input.setAttribute('role', 'switch');
    const title = document.createElement('span'); title.className = 'ws-label'; title.textContent = module.label;
    label.append(title, input); $('module-controls').append(label); controls.push(input);
    input.addEventListener('change', async () => {
      if (busy || !available || !canEdit) return;
      busy = true; lock();
      try {
        await current();
        const row = check(await db.from('workspace_module_visibility').upsert({
          company_entity_id: company.id, module_id: module.id, visible: input.checked,
        }, { onConflict: 'company_entity_id,module_id' }).select('company_entity_id,module_id,visible').single());
        if (row?.company_entity_id !== company.id || row?.module_id !== module.id || row?.visible !== input.checked) {
          throw new Error('Save was not confirmed.');
        }
        await load();
        window.dispatchEvent(new Event('silo:modules:changed'));
        status(`${module.label} menu visibility saved.`, 'pos');
      } catch (error) {
        available = false;
        status(`${error.message} Reload settings to confirm the saved state before retrying.`, 'neg');
      } finally { busy = false; lock(); }
    });
  }
  $('module-reload').addEventListener('click', async () => {
    if (busy) return;
    busy = true; lock();
    try { await load(); window.dispatchEvent(new Event('silo:modules:changed')); status('Module settings loaded.'); }
    catch (error) { status(error.message, 'neg'); }
    finally { busy = false; lock(); }
  });
  try {
    const session = check(await db.auth.getSession())?.session;
    if (!session) { window.location.href = '/pages/login.html?next=' + encodeURIComponent(location.pathname); return; }
    const { co, user } = await current(); company = co;
    window.SiloChrome.mount({ appEl: '#silo-app', active: 'settings/modules',
      user: { email: user.email || '' }, crumbs: ['Settings', 'Silo Modules'], supabaseClient: db });
    await load();
  } catch (error) { status(error.message, 'neg'); }
})();
