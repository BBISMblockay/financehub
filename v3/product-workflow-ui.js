(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const M = window.SiloProductWorkflow;
  const cfg = window.__SILO_CONFIG__ || {};
  let db, company, canWrite = false, current = null, dirty = false, busy = false;
  let queue = [], factories = [], sourceRows = [], hasMore = false;
  const fields = [
    ['title', 'Brief title', 'text'], ['product_type', 'Product type', 'text'],
    ['design_intent', 'Product intent', 'textarea'], ['audience', 'Audience', 'textarea'],
    ['marketing_angle', 'Marketing angle', 'textarea'], ['product_callouts', 'Product callouts', 'textarea'],
    ['special_callouts', 'Constraints / special callouts', 'textarea'], ['draft_copy', 'Suggested copy · unapproved', 'textarea'],
    ['copy_dos', 'Copy dos', 'textarea'], ['copy_donts', 'Copy don’ts', 'textarea'],
    ['creative_dos', 'Creative direction / dos', 'textarea'], ['creative_donts', 'Creative don’ts', 'textarea'],
    ['factory_id', 'Factory for draft PO', 'select'], ['launch_date', 'Planned launch date', 'date'],
    ['decision_note', 'Decision note · explain overrides and evidence gaps', 'textarea'],
  ];
  const message = (text, tone = 'info') => { $('status').textContent = text; $('status').className = 'bcn-status bcn-status--' + tone; };
  function node(tag, text, className) {
    const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n;
  }
  function button(text, action) { const n = node('button', text, 'bcn-btn bcn-btn--ghost'); n.type = 'button'; n.onclick = () => run(action); return n; }
  async function run(action) {
    if (busy) return;
    busy = true;
    const controls = [...document.querySelectorAll('button,input,select,textarea')].map(n => [n, n.disabled]);
    controls.forEach(([n]) => { n.disabled = true; });
    try { await action(); } catch (e) {
      const msg = e?.message || String(e);
      message(/product_workflow.*(schema cache|does not exist)|Could not find.*product_workflow/i.test(msg)
        ? 'This preview needs the product workflow migration. No draft or operational record was written.' : msg, 'neg');
    } finally { busy = false; controls.forEach(([n, was]) => { if (n.isConnected) n.disabled = was; }); applyAccess(); }
  }
  function leave() { return !dirty || window.confirm('Discard the unsaved changes to this brief?'); }
  function applyAccess() {
    $('brief-fields').disabled = !canWrite || current?.status !== 'draft';
    ['save','review','dismiss','reopen','create-po','create-launch','sync-pipeline'].forEach(id => { $(id).disabled = !canWrite; });
    if (current?.source_kind === 'restock') drawRestock();
  }
  async function rpc(name, args) {
    const { data, error } = await db.rpc(name, args);
    if (error) throw error;
    return data;
  }
  function sourceLabel(b) { return ({ concept: 'Product concept', product: 'Catalog product', restock: '90-day restock', idea: 'Manual idea' })[b.source_kind]; }
  function renderQueue() {
    $('queue').replaceChildren();
    const filter = $('queue-filter').value;
    const visible = queue.filter(b => filter === 'all' || b.status === filter);
    $('queue-count').textContent = queue.length + ' loaded';
    visible.forEach(b => {
      const n = button('', async () => { if (leave()) await openBrief(b.id); });
      n.append(node('strong', b.content.title), node('small', `${sourceLabel(b)} · ${b.status}${b.po_header_id ? ' · PO created' : ''}${b.launch_id ? ' · launch created' : ''}`));
      n.setAttribute('aria-current', String(current?.id === b.id)); $('queue').append(n);
    });
    if (!visible.length) $('queue').append(node('p', 'No briefs in this view.', 'pw-muted'));
    $('load-more').hidden = !hasMore;
  }
  async function loadQueue(more = false) {
    const offset = more ? queue.length : 0;
    const { data, error } = await db.from('product_workflow_briefs').select('*').eq('company_entity_id', company.id)
      .order('updated_at', { ascending: false }).order('id').range(offset, offset + 99);
    if (error) throw error;
    queue = more ? [...queue, ...data.filter(b => !queue.some(q => q.id === b.id))] : data;
    hasMore = data.length === 100; renderQueue();
  }
  function remember(row) {
    current = row; dirty = false;
    queue = [row, ...queue.filter(b => b.id !== row.id)];
    history.replaceState(null, '', '?brief=' + encodeURIComponent(row.id));
    render(); renderQueue();
  }
  async function openBrief(id) {
    const { data, error } = await db.from('product_workflow_briefs').select('*').eq('company_entity_id', company.id).eq('id', id).single();
    if (error) throw error;
    remember(data); message('Loaded saved brief. Source values are a snapshot from its first save.');
  }
  async function searchSources() {
    const kind = $('source-kind').value;
    if (kind === 'idea') { if (leave()) start(kind, {}); return; }
    const term = $('source-term').value.trim();
    if (!term) { message('Enter part of a title or SKU to find a source.'); return; }
    const table = kind === 'concept' ? 'product_concepts' : 'products_master';
    // Escape PostgREST LIKE wildcards; search each field without raw or() syntax.
    const pattern = '%' + term.replace(/[\\%_]/g, '\\$&') + '%';
    let query = db.from(table).select('*').eq('company_entity_id', company.id).order('updated_at', { ascending: false }).limit(30);
    if (kind === 'concept') query = query.neq('status', 'archived').ilike('title', pattern);
    else query = query.ilike('product_title', pattern);
    let { data, error } = await query;
    if (error) throw error;
    if (kind !== 'concept' && !data.length) {
      ({ data, error } = await db.from(table).select('*').eq('company_entity_id', company.id).ilike('sku', pattern).order('sku').limit(30));
      if (error) throw error;
    }
    sourceRows = data; $('source-results').replaceChildren();
    sourceRows.forEach(row => {
      const n = button('', () => { if (leave()) start(kind, row); });
      n.append(node('strong', row.title || row.product_title || row.sku), node('small', kind === 'concept' ? `${row.status} · ${row.parent_concept_id ? 'child product · ' : ''}${row.phase || 'concept'}` : `${row.sku} · ${row.variant_title || 'variant'}`));
      $('source-results').append(n);
    });
    $('source-results').append(node('p', data.length === 30 ? 'First 30 matches. Refine your search.' : `${data.length} matches.`, 'pw-muted'));
  }
  function start(kind, row) {
    current = { id: crypto.randomUUID(), version: 0, status: 'draft', source_kind: kind, source_id: row.id || null,
      source_snapshot: row, content: M.preset(kind, row) };
    dirty = true; history.replaceState(null, '', location.pathname); render(); renderQueue();
    message('Preset filled. Review the brief, quantities and evidence before saving.');
    $('editor-heading').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  function field(key, label, type, value, parent) {
    const wrap = node('div'); if (key === 'decision_note') wrap.className = 'pw-wide';
    const l = node('label', label, 'bcn-label'); l.htmlFor = 'f-' + key;
    const input = node(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input', undefined, 'bcn-field');
    input.id = 'f-' + key;
    if (type === 'select') {
      input.append(new Option('Choose factory', ''));
      factories.forEach(f => input.append(new Option(f.factory_name, f.id)));
      if (value && !factories.some(f => f.id === value)) input.append(new Option('Factory unavailable — choose another', value));
    } else if (type !== 'textarea') input.type = type;
    input.value = value ?? '';
    if (key === 'title') input.maxLength = 240;
    if (type === 'number') { input.min = '0'; input.step = '1'; }
    wrap.append(l, input); parent.append(wrap); return input;
  }
  function render() {
    $('editor').hidden = !current; $('empty').hidden = !!current;
    if (!current) return;
    const c = current.content;
    $('editor-heading').textContent = c.title || 'New product brief';
    $('brief-status').textContent = `${current.status}${current.version ? ' · v' + current.version : ' · unsaved'}`;
    const source = current.source_snapshot || {};
    $('provenance').textContent = `${sourceLabel(current)}${source.title || source.product_title ? ' · ' + (source.title || source.product_title) : ''}${current.reviewed_at ? ' · Reviewed ' + new Date(current.reviewed_at).toLocaleString() : ''}`;
    $('source-snapshot').replaceChildren();
    [['Original intent',source.concept_summary || source.notes],['Reasoning',source.reasoning],['Evidence strength',source.evidence_strength],['Audience rationale',source.audience_rationale],['Supply notes',source.supply_notes]]
      .filter(([,value])=>value).forEach(([label,value])=>$('source-snapshot').append(node('strong',label),node('p',value)));
    const evidence = Array.isArray(source.historical_evidence) ? source.historical_evidence : [];
    const risks = Array.isArray(source.risks) ? source.risks : [];
    const unknowns = Array.isArray(source.unknowns) ? source.unknowns : [];
    const list=node('ul');
    evidence.forEach(e=>list.append(node('li',[e.label || e.metric || 'Evidence',e.value,e.source].filter(v=>v!==undefined && v!==null && v!=='').join(' · '))));
    risks.forEach(r=>list.append(node('li',[r.category || 'Risk',r.detail].filter(Boolean).join(': '))));
    unknowns.forEach(u=>list.append(node('li',['Unknown',u.field?.replace(/_/g,' '),u.why].filter(Boolean).join(' · '))));
    if(list.childNodes.length) $('source-snapshot').append(list);
    $('source-snapshot').append(node('p',current.version ? 'Captured when this brief was first saved. Later source edits do not replace these assumptions.' : 'These source values will be captured when you first save.', 'pw-muted'));
    $('text-fields').replaceChildren();
    fields.forEach(([key, label, type]) => field(key, label, type, c[key], $('text-fields')));
    $('lines').replaceChildren();
    (c.lines || []).forEach(line => renderLine(line));
    $('add-size').hidden = ['product','restock'].includes(current.source_kind);
    $('restock-section').hidden = current.source_kind !== 'restock';
    if (current.source_kind === 'restock') {
      $('restock-inputs').replaceChildren();
      [['lead_days','Lead time · days'],['cover_days','Desired cover after arrival · days'],['safety_units','Safety stock · units']]
        .forEach(([key,label]) => { const input = field(key, label, 'number', c.restock?.[key], $('restock-inputs')); input.oninput = drawRestock; });
      drawRestock();
    }
    $('draft-actions').hidden = current.status !== 'draft';
    $('reviewed-actions').hidden = current.status === 'draft';
    $('reopen').hidden = !!(current.po_header_id || current.launch_id);
    $('create-po').hidden = current.status !== 'reviewed' || !!current.po_header_id || !!current.launch_id;
    $('create-launch').hidden = current.status !== 'reviewed' || !!current.launch_id;
    $('launch-handoff').hidden = current.status !== 'reviewed' || !!current.launch_id;
    $('handoff-date').value = c.launch_date || '';
    $('outputs').replaceChildren();
    if (current.po_header_id) outputLink('Open draft / current PO in PO Builder', '../v2/po-builder.html?po_id=' + encodeURIComponent(current.po_header_id));
    if (current.launch_id) outputLink('Open launch and its Brief tab', '../v2/launch-calendar.html?launch=' + encodeURIComponent(current.launch_id));
    $('sync-pipeline').hidden = !current.po_header_id || !['concept','idea'].includes(current.source_kind);
    applyAccess();
  }
  function outputLink(label, href) { const a = node('a', label, 'bcn-btn bcn-btn--ghost'); a.href = href; $('outputs').append(a); }
  function renderLine(line) {
    const tr = node('tr');
    ['size','qty','unit_cost','retail_price'].forEach((key, index) => {
      const td = node('td'), input = node('input', undefined, 'bcn-field');
      input.dataset.key = key; input.type = index ? 'number' : 'text'; input.value = line[key] ?? '';
      input.setAttribute('aria-label', `${key.replace(/_/g,' ')} for line ${$('lines').children.length + 1}`);
      if (index) { input.min = '0'; input.step = index === 1 ? '1' : '0.0001'; }
      if (!index && ['product','restock'].includes(current.source_kind)) input.readOnly = true;
      td.append(input); tr.append(td);
    });
    $('lines').append(tr);
  }
  function collect() {
    const c = structuredClone(current.content);
    fields.forEach(([key]) => { c[key] = $('f-' + key).value.trim(); });
    c.lines = [...$('lines').children].map(tr => Object.fromEntries([...tr.querySelectorAll('input')].map(input =>
      [input.dataset.key, input.dataset.key === 'size' ? input.value.trim() : input.value === '' ? null : Number(input.value)])))
      .filter(line => line.qty !== null && line.qty !== 0);
    if (current.source_kind === 'restock') {
      c.restock = { ...c.restock };
      ['lead_days','cover_days','safety_units'].forEach(key => { c.restock[key] = $('f-' + key).value; });
    }
    return c;
  }
  function drawRestock() {
    if (!current || current.source_kind !== 'restock') return;
    const r = collect().restock, b = r.basis, result = M.restock(r);
    $('restock-basis').replaceChildren();
    if (b) {
      const dl = node('dl');
      [['Sales window',`${b.window_start} → ${b.window_end}`],['Recorded units · 90 days',b.units_90d],['On hand',b.on_hand],
        ['Stock as of',b.stock_as_of],['Incoming by ' + b.incoming_cutoff,b.incoming_units],['Units / day',result.velocity?.toFixed(2)],
        ['On-hand cover · days',result.cover?.toFixed(1)],['Suggested units',result.qty]].forEach(([label,value]) => { dl.append(node('dt',label),node('dd',value ?? 'Unknown')); });
      $('restock-basis').append(dl, node('p','Incoming excludes draft, cancelled, received/closed, overdue, undated and partially received orders. Later arrivals are outside this horizon.','pw-muted'));
    }
    result.warnings.forEach(w => $('restock-basis').append(node('p',w,'bcn-status bcn-status--info')));
    $('use-suggestion').disabled = !canWrite || result.qty === null;
  }
  async function refreshBasis() {
    const c = collect(), r = c.restock;
    const lead = Number(r.lead_days), cover = Number(r.cover_days);
    if (r.lead_days === '' || r.cover_days === '' || !Number.isInteger(lead) || !Number.isInteger(cover) || lead < 0 || cover < 0 || lead + cover > 730) throw new Error('Enter lead time and cover (whole days, total at most 730).');
    r.basis = await rpc('product_workflow_restock_basis', { p_company: company.id, p_product: current.source_id, p_horizon: lead + cover });
    current.content = c; dirty = true; render(); message('Basis refreshed. Review the evidence and choose the purchase quantity.');
  }
  async function save(status) {
    if (!canWrite || !current) return;
    const c = status === 'draft' && current.status !== 'draft' ? current.content : collect();
    M.validate(c, current.source_kind, status === 'reviewed');
    const row = await rpc('save_product_workflow_brief', { p_company: company.id, p_id: current.id, p_version: current.version,
      p_kind: current.source_kind, p_source_id: current.source_id, p_content: c, p_status: status });
    remember(row); message(status === 'reviewed' ? 'Brief reviewed. Choose a handoff below; the PO will remain Draft.' : status === 'draft' ? 'Draft saved.' : 'Brief dismissed.', 'pos');
  }
  async function syncPipeline() {
    const { data: po, error } = await db.from('po_headers').select('*').eq('company_entity_id',company.id).eq('id',current.po_header_id).single();
    if (error) throw new Error('PO exists; Pipeline sync could not read it: ' + error.message);
    const result = await window.SiloPoPipeline.sync(db, { po, companyId: company.id, create: !!po.is_new_product_po });
    if (result.errors.length) throw new Error('PO exists. Pipeline sync needs retry: ' + result.errors.map(e => e.message).join('; '));
    message(result.otherPo.length ? 'PO exists. A product already belongs to another PO in Pipeline; that link was preserved.' : 'PO exists and Pipeline is in sync.', 'pos');
  }
  async function handoff(target) {
    const date = $('handoff-date').value;
    if (target === 'launch' && !date) throw new Error('Choose a planned launch date.');
    const row = await rpc('handoff_product_workflow_brief', { p_company: company.id, p_id: current.id, p_version: current.version, p_target: target, p_launch_date: target === 'launch' ? date : null });
    remember(row); message(target === 'po' ? 'Draft PO created. Open PO Builder to continue purchasing.' : 'Planned launch created with the reviewed brief.', 'pos');
    if (target === 'po' && ['concept','idea'].includes(row.source_kind)) await syncPipeline();
  }
  async function boot() {
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) throw new Error('Missing Supabase config.');
    db = window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);
    const { data, error } = await db.auth.getSession(); if (error) throw error;
    if (!data.session) { location.href='/pages/login.html'; return; }
    company = await cfg.ensureActiveCompany(db);
    if (!company?.id) throw new Error('Choose an active company before opening the preview.');
    const { data: profile } = await db.from('profiles').select('email,role').eq('id',data.session.user.id).single();
    window.SiloChrome?.mount({ appEl:'#silo-app', active:'', user:{email:profile?.email || data.session.user.email,role:profile?.role}, crumbs:['V3 preview','Product workflow'],supabaseClient:db });
    canWrite = !!(await rpc('po_builder_can_write',{}));
    // Complete supplier list: no invisible factory past a response cap.
    for (let offset=0;;offset+=500) {
      const { data: rows, error: factoryError } = await db.from('factories').select('id,factory_name').eq('company_entity_id',company.id).order('factory_name').order('id').range(offset,offset+499);
      if (factoryError) throw factoryError;
      factories.push(...rows); if(rows.length<500) break;
    }
    await loadQueue();
    const id = new URLSearchParams(location.search).get('brief'); if (id) await openBrief(id);
    message(canWrite ? 'Choose a source or reopen a saved brief.' : 'Read-only access. Purchasing permission is required to save, review or hand off.');
    applyAccess();
  }
  $('source-search').onsubmit = e => { e.preventDefault(); run(searchSources); };
  $('source-kind').onchange = () => { $('source-results').replaceChildren(); $('source-term').placeholder = $('source-kind').value === 'concept' ? 'Concept title' : 'Product title or exact SKU'; };
  $('queue-filter').onchange = renderQueue;
  $('load-more').onclick = () => run(() => loadQueue(true));
  $('reload').onclick = () => run(async () => { if (!leave()) return; await loadQueue(); if (current?.version) await openBrief(current.id); });
  $('brief-form').onsubmit = e => { e.preventDefault(); run(() => save('draft')); };
  $('brief-form').oninput = () => { dirty = true; };
  $('review').onclick = () => run(() => save('reviewed'));
  $('dismiss').onclick = () => run(() => save('dismissed'));
  $('reopen').onclick = () => run(() => save('draft'));
  $('create-po').onclick = () => run(() => handoff('po'));
  $('create-launch').onclick = () => run(() => handoff('launch'));
  $('sync-pipeline').onclick = () => run(syncPipeline);
  $('refresh-basis').onclick = () => run(refreshBasis);
  $('use-suggestion').onclick = () => {
    const c=collect(), result=M.restock(c.restock);
    if(result.qty===null) return;
    if (!c.lines.length) c.lines=[{size:current.source_snapshot.variant_title || '',unit_cost:current.source_snapshot.unit_cost ?? null,retail_price:current.source_snapshot.msrp ?? null}];
    c.lines[0].qty=result.qty; current.content=c; dirty=true; render();
  };
  $('add-size').onclick = () => { renderLine({}); dirty=true; };
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  run(boot);
})();
