/* Workspace module catalog — menu discovery preferences. Database RLS is the write boundary. */
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

  const MODULE_COPY = {
    marketing: {
      desc: 'Campaign analytics, ad creative, SEO, and marketing performance reports.',
      sections: ['Marketing'],
      icon: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M3 5h2v14H3zm4 0h2l7 12V5h2v14h-2l-7-12v12H7z"/></svg>',
    },
    finance: {
      desc: 'Accounting, customers, payment requests, and finance operations.',
      sections: ['Accounting', 'Requests'],
      icon: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 4h16v16H4zm2 2v12h12V6zm1.5 2h9v2h-9zm0 4h9v2h-9zm0 4h6v2h-6z"/></svg>',
    },
    purchasing_inventory: {
      desc: 'Purchase orders, factories, inventory, products, and Product Studio.',
      sections: ['Purchasing', 'Inventory', 'Product & inventory'],
      icon: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 8h16l-1.5 10H5.5zm2.2-4h11.6L19 6H5z"/></svg>',
    },
    planning: {
      desc: 'Calendars, revenue projections, scenarios, launches, and task management.',
      sections: ['Planning'],
      icon: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M7 2h2v2h6V2h2v2h3v18H4V4h3zm13 8H6v10h14zm0-4H6v2h14z"/></svg>',
    },
    team: {
      desc: 'Performance reviews, compensation requests, and people workflows.',
      sections: ['Team'],
      icon: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6m8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6M2 19a4 4 0 0 1 4-4h1.1a5 5 0 0 0-.1 1v3zm14.9 0v-3a5 5 0 0 0-.1-1H18a4 4 0 0 1 4 4z"/></svg>',
    },
  };

  let company, canEdit = false, available = false, busy = false;
  const controls = [];
  const cards = new Map();

  const lock = () => controls.forEach(input => { input.disabled = busy || !available || !canEdit; });

  function paintSummary(visibility) {
    const total = nav.MODULES.length;
    const enabled = nav.MODULES.filter(m => visibility[m.id] !== false).length;
    $('module-kpi-total').textContent = String(total);
    $('module-kpi-enabled').textContent = String(enabled);
    $('module-kpi-band').hidden = false;
    for (const module of nav.MODULES) {
      const on = visibility[module.id] !== false;
      const card = cards.get(module.id);
      if (!card) continue;
      card.classList.toggle('is-off', !on);
      const pill = card.querySelector('[data-module-state]');
      if (pill) {
        pill.textContent = on ? 'Enabled' : 'Hidden';
        pill.className = `bcn-pill ${on ? 'bcn-pill--pos' : ''}`.trim();
      }
      const label = card.querySelector('.sm-toggle-label');
      if (label) label.textContent = on ? 'On' : 'Off';
    }
  }

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
    $('module-company').textContent = `${co.title || 'Workspace'} · Module catalog`;
    const membership = check(await db.from('entity_memberships').select('role')
      .eq('entity_id', co.id).eq('user_id', user.id).maybeSingle());
    if (!membership) throw new Error('Workspace membership required.');
    canEdit = ['owner_admin', 'admin'].includes(membership.role);
    const visibility = await nav.loadModuleVisibility(db, co, true);
    if (!visibility) throw new Error('Module settings could not be loaded. Existing menu visibility is preserved. Reload settings to try again.');
    await current();
    controls.forEach(input => { input.checked = visibility[input.value] !== false; });
    paintSummary(visibility);
    $('module-permission').textContent = canEdit
      ? 'Workspace owners and administrators can enable or disable modules here.'
      : 'Only workspace owners and administrators can change module settings.';
    available = true; lock();
  }

  for (const module of nav.MODULES) {
    const copy = MODULE_COPY[module.id] || { desc: '', sections: module.sections, icon: '' };
    const article = document.createElement('article');
    article.className = 'sm-module';
    article.dataset.moduleId = module.id;

    const mark = document.createElement('div');
    mark.className = 'sm-module-mark';
    mark.innerHTML = copy.icon || '';

    const body = document.createElement('div');
    body.className = 'sm-module-body';
    const head = document.createElement('div');
    head.className = 'sm-module-head';
    const title = document.createElement('h3');
    title.className = 'sm-module-title';
    title.textContent = module.label;
    const pill = document.createElement('span');
    pill.className = 'bcn-pill bcn-pill--pos';
    pill.dataset.moduleState = '';
    pill.textContent = 'Enabled';
    head.append(title, pill);

    const desc = document.createElement('p');
    desc.className = 'sm-module-desc';
    desc.textContent = copy.desc;

    const sections = document.createElement('div');
    sections.className = 'sm-module-sections';
    for (const name of (copy.sections || module.sections)) {
      const tag = document.createElement('span');
      tag.className = 'sm-section-tag';
      tag.textContent = name;
      sections.append(tag);
    }
    body.append(head, desc, sections);

    const toggle = document.createElement('label');
    toggle.className = 'sm-module-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = module.id;
    input.disabled = true;
    input.setAttribute('role', 'switch');
    const switchEl = document.createElement('span');
    switchEl.className = 'sm-switch';
    switchEl.setAttribute('aria-hidden', 'true');
    const toggleLabel = document.createElement('span');
    toggleLabel.className = 'sm-toggle-label';
    toggleLabel.textContent = 'On';
    toggle.append(input, switchEl, toggleLabel);

    article.append(mark, body, toggle);
    $('module-controls').append(article);
    cards.set(module.id, article);
    controls.push(input);

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
        status(`${module.label} saved.`, 'pos');
      } catch (error) {
        available = false;
        status(`${error.message} Reload settings to confirm the saved state before retrying.`, 'neg');
      } finally { busy = false; lock(); }
    });
  }

  $('module-reload').addEventListener('click', async () => {
    if (busy) return;
    busy = true; lock();
    try {
      await load();
      window.dispatchEvent(new Event('silo:modules:changed'));
      status('Module settings loaded.');
    } catch (error) { status(error.message, 'neg'); }
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
