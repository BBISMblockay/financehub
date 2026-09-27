(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const M = window.SiloProductWorkflow;
  const cfg = window.__SILO_CONFIG__ || {};
  let db, company, canWrite = false, current = null, dirty = false, busy = false;
  let activePanel = 'overview';
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
    ['save','review','dismiss','reopen','create-po','create-launch','sync-pipeline','another-brief'].forEach(id => { $(id).disabled = !canWrite; });
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
      appendSourceRow(n, b.source_kind, b.source_snapshot || {}, b.content.title, `${sourceLabel(b)} · ${b.status}${b.po_header_id ? ' · PO created' : ''}${b.launch_id ? ' · launch created' : ''}`);
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
  async function searchSources(browse = false) {
    const kind = $('source-kind').value;
    if (kind === 'idea') { if (leave()) start(kind, {}); return; }
    const term = $('source-term').value.trim();
    if (!term && !(browse && kind === 'concept')) { message('Enter part of a title or SKU to find a source.'); return; }
    let data;
    if (kind === 'concept') {
      const pattern = '%' + term.replace(/[\\%_]/g, '\\$&') + '%';
      const result = await db.from('product_concepts').select('*').eq('company_entity_id',company.id).neq('status','archived')
        .ilike('title',pattern).order('updated_at',{ascending:false}).limit(30);
      if (result.error) throw result.error;
      data = result.data;
    } else data = await rpc('product_workflow_catalog_search',{p_company:company.id,p_term:term});
    sourceRows = data; $('source-results').replaceChildren();
    sourceRows.forEach(row => {
      const n = button('', async () => { if (leave()) await openSource(kind, row); });
      appendSourceRow(n, kind, row, row.title || row.product_title || row.sku, kind === 'concept' ? `${row.status} · ${row.parent_concept_id ? 'child product · ' : ''}${row.phase === 'full_brief' ? 'full brief' : 'core draft'}` : `${row.variant_count} mapped SKU${row.variant_count === 1 ? '' : 's'} · ${row.catalog_group?.shop_domain || 'Unmapped single SKU'}`);
      $('source-results').append(n);
    });
    $('source-results').append(node('p', data.length === 30 ? 'First 30 matches. Refine your search.' : `${data.length} matches.`, 'pw-muted'));
  }
  async function openSource(kind, row) {
    if (kind === 'concept') {
      const {data: children,error} = await db.from('product_concepts').select('*').eq('company_entity_id',company.id).eq('parent_concept_id',row.id).neq('status','archived').order('title').limit(100);
      if (error) throw error;
      if (children.length) {
        $('source-results').replaceChildren(node('p', 'Choose a product in “' + row.title + '”. Each product gets its own size/color spread.', 'pw-muted'));
        children.forEach(child => { const n=button('',async()=>{if(leave()) await openSource('concept',child);}); appendSourceRow(n,'concept',child,child.title,'Child product'); $('source-results').append(n); });
        message(children.length===100 ? 'First 100 child products shown. Search by product title for more.' : 'Collection opened. Choose a child product to create its brief.');
        return;
      }
    } else if (kind !== 'idea') {
      if (!row.id) throw new Error('This product has no mapped catalog SKUs. Resolve the mapping before buying.');
      row=await rpc('product_workflow_catalog_source',{p_company:company.id,p_product:row.id,p_group:row.catalog_group || null});
    }
    // Search the entire saved set, not just the queue's first page.
    let query=db.from('product_workflow_briefs').select('*')
      .eq('company_entity_id',company.id).eq('source_kind',kind).eq('source_id',row.id).neq('status','dismissed');
    if (row.variants) {
      query=query.eq('content->>catalog_scope','product');
      query=row.catalog_group ? query.eq('content->catalog_group',JSON.stringify(row.catalog_group)) : query.eq('content->catalog_group','null');
    }
    const {data,error}=await query.order('updated_at',{ascending:false}).limit(1);
    if (error) throw error;
    activePanel = kind === 'restock' ? 'buy' : 'overview';
    const existing = data[0];
    const completedBuy = kind !== 'concept' && (existing?.po_header_id || existing?.launch_id);
    if (existing && !completedBuy) { remember(existing); message('Continued the saved brief for this source.'); }
    else start(kind, row);
  }
  function start(kind, row) {
    activePanel = kind === 'restock' ? 'buy' : 'overview';
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
    document.querySelector('.pw-content').classList.toggle('pw-has-brief', !!current);
    document.querySelector('.pw-content').classList.remove('pw-browsing');
    $('browse-toggle').setAttribute('aria-expanded','false');
    $('editor').hidden = !current; $('empty').hidden = !!current; $('decision-rail').hidden = !current;
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
    ['text-fields','creative-fields','buy-fields','launch-fields'].forEach(id => $(id).replaceChildren());
    const creativeKeys = ['marketing_angle','product_callouts','special_callouts','draft_copy','copy_dos','copy_donts','creative_dos','creative_donts'];
    fields.forEach(([key, label, type]) => {
      const parent = creativeKeys.includes(key) ? 'creative-fields' : ['factory_id','decision_note'].includes(key) ? 'buy-fields' : key === 'launch_date' ? 'launch-fields' : 'text-fields';
      field(key, label, type, c[key], $(parent));
    });
    $('lines').replaceChildren();
    (c.lines || []).forEach(line => renderLine(line));
    $('add-size').hidden = ['product','restock'].includes(current.source_kind);
    $('restock-section').hidden = current.source_kind !== 'restock';
    if (current.source_kind === 'restock') {
      $('restock-inputs').replaceChildren();
      [['lead_days','Lead time · days'],['cover_days','Desired cover after arrival · days'],['safety_units',c.catalog_scope === 'product' ? 'Safety stock · units per SKU' : 'Safety stock · units']]
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
    renderStudio();
    showPanel(activePanel);
    applyAccess();
  }
  function outputLink(label, href) { const a = node('a', label, 'bcn-btn bcn-btn--ghost'); a.href = href; $('outputs').append(a); }
  function renderLine(line) {
    const tr = node('tr');
    if (line.product_master_id) { tr.dataset.productId=line.product_master_id; tr.dataset.sku=line.sku || ''; }
    ['size','qty','unit_cost','retail_price'].forEach((key, index) => {
      const td = node('td'), input = node('input', undefined, 'bcn-field');
      input.dataset.key = key; input.type = index ? 'number' : 'text'; input.value = line[key] ?? '';
      input.setAttribute('aria-label', `${key.replace(/_/g,' ')} for line ${$('lines').children.length + 1}`);
      if (index) { input.min = '0'; input.step = index === 1 ? '1' : '0.0001'; }
      if (!index && ['product','restock'].includes(current.source_kind)) input.readOnly = true;
      td.append(input); if (!index && line.sku) td.append(node('small',line.sku,'pw-muted')); tr.append(td);
    });
    $('lines').append(tr);
  }
  function collect() {
    const c = structuredClone(current.content);
    fields.forEach(([key]) => { c[key] = $('f-' + key).value.trim(); });
    c.lines = [...$('lines').children].map(tr => ({
      ...(tr.dataset.productId ? {product_master_id:tr.dataset.productId,sku:tr.dataset.sku} : {}),
      ...Object.fromEntries([...tr.querySelectorAll('input')].map(input => [input.dataset.key,input.dataset.key==='size' ? input.value.trim() : input.value==='' ? null : Number(input.value)]))
    })).filter(line => c.catalog_scope==='product' || (line.qty!==null && line.qty!==0));
    if (current.source_kind === 'restock') {
      c.restock = { ...c.restock };
      ['lead_days','cover_days','safety_units'].forEach(key => { c.restock[key] = $('f-' + key).value; });
    }
    return c;
  }
  function drawRestock() {
    if (!current || current.source_kind !== 'restock') return;
    const content=collect();
    if(content.catalog_scope==='product') { drawSpread(content); return; }
    const r = content.restock, b = r.basis, result = M.restock(r);
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
  function drawSpread(content) {
    const results=M.spreadRestock(content), host=$('restock-basis'); host.replaceChildren();
    host.append(node('p','Company-wide demand and stock · 90 calendar days through the last complete company day. Incoming includes eligible open POs within lead time + cover. Safety units apply to each SKU.','pw-muted'));
    const wrap=node('div',undefined,'bcn-matrix-scroll'); wrap.tabIndex=0; wrap.setAttribute('role','region'); wrap.setAttribute('aria-label','Restock evidence by SKU');
    const table=node('table',undefined,'bcn-table'), head=node('thead'), hr=node('tr');
    ['SKU / variant','Sold · 90d','On hand','Incoming','Cover · days','Suggest'].forEach(t=>hr.append(node('th',t))); head.append(hr); table.append(head);
    const body=node('tbody');
    results.forEach(result=>{
      const b=content.restock.bases?.find(x=>x.product_id===result.line.product_master_id), tr=node('tr');
      [result.line.sku+' · '+result.line.size,b?.units_90d,b?.on_hand,b?.incoming_units,result.cover?.toFixed(1),result.qty].forEach(value=>tr.append(node('td',value ?? 'Unknown'))); body.append(tr);
      if(result.warnings.length) { const row=node('tr'),td=node('td',result.line.sku+': '+result.warnings.join(' '),'pw-muted');td.colSpan=6;row.append(td);body.append(row); }
    });
    table.append(body);wrap.append(table);host.append(wrap);
    const bases=content.restock.bases || [], first=bases[0];
    if(first) host.append(node('p',`Sales ${first.window_start} → ${first.window_end} · incoming through ${first.incoming_cutoff}. Overdue, undated and partially received POs are excluded; review warnings before buying.`,'pw-muted'));
    $('use-suggestion').disabled=!canWrite || current.status!=='draft' || !results.some(r=>r.qty!==null);
  }
  async function refreshBasis() {
    const c = collect(), r = c.restock;
    const lead = Number(r.lead_days), cover = Number(r.cover_days);
    if (r.lead_days === '' || r.cover_days === '' || !Number.isInteger(lead) || !Number.isInteger(cover) || lead < 0 || cover < 0 || lead + cover > 730) throw new Error('Enter lead time and cover (whole days, total at most 730).');
    if(c.catalog_scope==='product') r.bases=await rpc('product_workflow_product_basis',{p_company:company.id,p_product:current.source_id,p_group:c.catalog_group,p_horizon:lead+cover});
    else r.basis=await rpc('product_workflow_restock_basis',{p_company:company.id,p_product:current.source_id,p_horizon:lead+cover});
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
    window.SiloChrome?.mount({ appEl:'#silo-app', active:'', user:{email:profile?.email || data.session.user.email,role:profile?.role}, crumbs:['V3 preview','Product Studio'],supabaseClient:db });
    canWrite = !!(await rpc('po_builder_can_write',{}));
    // Complete supplier list: no invisible factory past a response cap.
    for (let offset=0;;offset+=500) {
      const { data: rows, error: factoryError } = await db.from('factories').select('id,factory_name').eq('company_entity_id',company.id).order('factory_name').order('id').range(offset,offset+499);
      if (factoryError) throw factoryError;
      factories.push(...rows); if(rows.length<500) break;
    }
    await loadQueue();
    const params = new URLSearchParams(location.search);
    const id = params.get('brief'), concept = params.get('concept');
    if (id) await openBrief(id);
    else if (concept) {
      const { data: row, error: sourceError } = await db.from('product_concepts').select('*').eq('company_entity_id', company.id).eq('id', concept).single();
      if (sourceError) throw sourceError;
      if (!row || row.status === 'archived') throw new Error('This concept is unavailable in the active company.');
      await openSource('concept', row);
    }
    if (!concept) await searchSources(true);
    message(canWrite ? 'Choose a source or reopen a saved brief.' : 'Read-only access. Purchasing permission is required to save, review or hand off.');
    applyAccess();
  }
  function showPanel(name, focus = false) {
    activePanel = name;
    document.querySelectorAll('[data-panel]').forEach(tab => {
      const selected = tab.dataset.panel === name;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      $('panel-' + tab.dataset.panel).hidden = !selected;
      if (selected && focus) tab.focus();
    });
  }
  function sourceImages(kind, source) {
    const urls = kind === 'concept' ? source.reference_image_urls : [source.image_url];
    return [...new Set((Array.isArray(urls) ? urls : []).filter(url => {
      try { return typeof url === 'string' && new URL(url).protocol === 'https:'; } catch { return false; }
    }))];
  }
  function appendSourceRow(target, kind, source, title, subtitle) {
    const row = node('span', undefined, 'pw-source-row');
    const url = sourceImages(kind, source)[0];
    if (url) {
      const img = node('img', undefined, 'pw-thumb'); img.src = url; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      img.onerror = () => img.remove(); row.append(img);
    }
    const text = node('span'); text.append(node('strong', title), node('small', subtitle)); row.append(text); target.append(row);
  }
  function renderStudio() {
    const source = current.source_snapshot || {};
    $('overview-edit').open = !current.content.design_intent;
    const art = $('artwork'); art.replaceChildren();
    const urls = sourceImages(current.source_kind, source);
    if (urls.length) {
      const figure = node('figure'), img = node('img', undefined, 'pw-hero');
      img.src = urls[0]; img.alt = current.content.title || 'Product reference'; img.referrerPolicy = 'no-referrer';
      const caption = node('figcaption', current.source_kind === 'concept' ? 'Concept reference · from the source brief' : 'Catalog product photo');
      img.onerror = () => { img.hidden = true; caption.textContent = 'Reference image could not load. Open the source to review artwork.'; };
      figure.append(img, caption); art.append(figure);
      const links = node('div', undefined, 'pw-artwork-links');
      urls.forEach((url, index) => {
        const a = node('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.setAttribute('aria-label', 'Open reference image ' + (index + 1));
        const thumb = node('img'); thumb.src = url; thumb.alt = 'Reference ' + (index + 1); thumb.loading = 'lazy'; thumb.referrerPolicy = 'no-referrer';
        thumb.onerror = () => { a.textContent = 'Open reference ' + (index + 1); }; a.append(thumb); links.append(a);
      });
      art.append(links);
    } else {
      const empty = node('div', undefined, 'pw-art-empty');
      empty.append(node('span','CREATIVE DIRECTION','pw-eyebrow'), node('strong','A product starts with an idea.'),
        node('p', current.source_kind === 'concept' ? 'No reference artwork in this source snapshot. Add images to the concept to develop the visual direction.' : 'No product photo available. Capture the intent and creative direction in this brief.'));
      art.append(empty);
    }
    if (current.source_kind === 'concept' && current.source_id) {
      const a = node('a','Open source concept in Ask SILO →','pw-muted');
      a.href = '../v2/silo-chat.html?concept=' + encodeURIComponent(current.source_id); art.append(a);
      if (current.version) art.append(node('p','Artwork uses the saved source snapshot; later concept changes do not replace it.','pw-muted'));
    }
    const stages = [['Concept', current.source_kind === 'concept'], ['Brief', !!current.version], ['Review', current.status === 'reviewed'], ['Draft PO', !!current.po_header_id], ['Launch', !!current.launch_id]];
    $('workflow-stages').replaceChildren();
    const currentStage = current.launch_id ? 4 : current.po_header_id ? 3 : current.status === 'reviewed' ? 2 : 1;
    stages.forEach(([label, done], index) => { const li = node('li', label); li.dataset.done = String(done); if (index === currentStage) li.setAttribute('aria-current','step'); $('workflow-stages').append(li); });
    const summary = $('evidence-summary'); summary.replaceChildren();
    if(current.content.catalog_scope==='product') {
      summary.append(node('p',`${source.variants.length} mapped SKUs · ${source.catalog_group?.shop_domain || 'Unmapped single SKU'}`));
      const observed=source.variants.map(v=>v.mapping_last_seen_at).filter(Boolean).sort()[0];
      summary.append(node('p',source.catalog_group ? `Mapping last observed ${observed ? new Date(observed).toLocaleDateString() : 'at an unknown time'}. Confirm the spread against the catalog; deleted variants may remain in the mapping.` : 'No store product mapping exists for this SKU. No other variants have been inferred.','pw-muted'));
    }
    if (source.evidence_strength) summary.append(node('span', source.evidence_strength + ' evidence', 'bcn-pill'));
    const evidence = Array.isArray(source.historical_evidence) ? source.historical_evidence : [];
    evidence.slice(0, 3).forEach(e => { const p = node('p'); p.append(node('strong', e.label || e.metric || 'Prior evidence'), node('span', e.value == null ? '' : ' · ' + e.value)); summary.append(p); });
    if (!evidence.length) summary.append(node('p', current.source_kind === 'restock' ? 'Use the buy plan to review recorded demand, on-hand stock and incoming POs.' : 'Review the original reasoning and assumptions below. No verified performance metric has been added here.'));
    summary.append(node('p','Source evidence is context, not a forecast.','pw-muted'));
    updateSummary();
  }
  function updateSummary() {
    if (!current) return;
    const c = collect(), lines = c.lines || [];
    $('brief-story').replaceChildren(node('h3','The idea'),node('p',c.design_intent || 'Describe the product and what makes it worth making.'),node('span',c.audience ? 'For ' + c.audience : 'Audience not set','pw-muted'));
    const units = lines.reduce((sum, l) => sum + (Number.isFinite(l.qty) ? l.qty : 0), 0);
    $('brief-summary').replaceChildren();
    [['PROPOSED BUY',[...$('lines').querySelectorAll('[data-key=qty]')].some(input => input.value !== '') ? units.toLocaleString() + ' units' : 'Not set'],['TARGET LAUNCH',c.launch_date || 'Not set']].forEach(([label,value]) => {
      const d = node('div'); d.append(node('span',label,'pw-eyebrow'),node('strong',value)); $('brief-summary').append(d);
    });
    $('save-state').textContent = dirty ? 'Unsaved changes' : 'Draft saved';
    const checks = [];
    if (!c.design_intent) checks.push('Add the product intent');
    if (!c.factory_id) checks.push('Choose a factory in Buy plan');
    if (!lines.some(l=>Number(l.qty)>0)) checks.push('No purchase units proposed — review the buy decision');
    if (!lines.length || lines.some(l => l.unit_cost == null || l.retail_price == null)) checks.push('Confirm unit cost and retail price');
    if (current.source_kind === 'restock') checks.push(...(c.catalog_scope==='product' ? [...new Set(M.spreadRestock(c).flatMap(r=>r.warnings))] : M.restock(c.restock).warnings));
    else checks.push('Check stock and incoming POs before buying');
    if (!c.launch_date) checks.push('Choose a target launch date');
    $('review-checklist').replaceChildren(...checks.map(text => node('li',text)));
    $('next-step').textContent = current.status === 'dismissed' ? 'This brief is dismissed. Reopen it to continue.' : current.status === 'reviewed' ? 'Brief reviewed. Continue with the PO or planned launch below the brief.' : 'Complete the buy plan and review the source evidence, then save as reviewed.';
    $('next-action').textContent = current.status === 'dismissed' ? 'View reopen action' : current.status === 'reviewed' ? 'View handoffs' : 'Open buy plan';
  }
  document.querySelectorAll('[data-panel]').forEach(tab => {
    tab.onclick = () => showPanel(tab.dataset.panel);
    tab.onkeydown = event => {
      const tabs = [...document.querySelectorAll('[data-panel]')];
      let index = tabs.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else return;
      event.preventDefault(); showPanel(tabs[index].dataset.panel, true);
    };
  });
  $('browse-toggle').onclick = () => {
    const expanded = document.querySelector('.pw-content').classList.toggle('pw-browsing');
    $('browse-toggle').setAttribute('aria-expanded',String(expanded));
  };
  $('another-brief').onclick = () => run(async () => {
    if (!canWrite || !current || !leave()) return;
    const kind = current.source_kind;
    if (kind === 'idea') { start(kind, {}); return; }
    if (kind==='product' || kind==='restock') {
      const row=await rpc('product_workflow_catalog_source',{p_company:company.id,p_product:current.source_id,p_group:current.content.catalog_group || null});
      start(kind,row); return;
    }
    const table = 'product_concepts';
    const { data: row, error } = await db.from(table).select('*').eq('company_entity_id',company.id).eq('id',current.source_id).single();
    if (error) throw error;
    if (!row || (kind === 'concept' && row.status === 'archived')) throw new Error('This source is unavailable in the active company.');
    start(kind, row);
  });
  $('next-action').onclick = () => {
    if (current?.status !== 'draft') $('reviewed-actions').scrollIntoView({block:'center',behavior:'smooth'});
    else showPanel('buy',true);
  };
  $('source-search').onsubmit = e => { e.preventDefault(); run(searchSources); };
  $('source-kind').onchange = () => { $('source-results').replaceChildren(); $('source-term').placeholder = $('source-kind').value === 'concept' ? 'Concept title' : 'Product title or exact SKU'; };
  $('queue-filter').onchange = renderQueue;
  $('load-more').onclick = () => run(() => loadQueue(true));
  $('reload').onclick = () => run(async () => { if (!leave()) return; await loadQueue(); if (current?.version) await openBrief(current.id); });
  $('brief-form').onsubmit = e => { e.preventDefault(); run(() => save('draft')); };
  $('brief-form').addEventListener('invalid', e => {
    const panel = e.target.closest('[role="tabpanel"]');
    if (panel) showPanel(panel.id.replace('panel-', ''));
    if (e.target.closest('#overview-edit')) $('overview-edit').open = true;
  }, true);
  $('brief-form').oninput = () => { dirty = true; updateSummary(); };
  $('review').onclick = () => run(() => save('reviewed'));
  $('dismiss').onclick = () => run(() => save('dismissed'));
  $('reopen').onclick = () => run(() => save('draft'));
  $('create-po').onclick = () => run(() => handoff('po'));
  $('create-launch').onclick = () => run(() => handoff('launch'));
  $('sync-pipeline').onclick = () => run(syncPipeline);
  $('refresh-basis').onclick = () => run(refreshBasis);
  $('use-suggestion').onclick = () => {
    const c=collect();
    if(c.catalog_scope==='product') {
      M.spreadRestock(c).forEach(result=>{if(result.qty!==null) result.line.qty=result.qty;});
      current.content=c; dirty=true; render(); message('Known SKU suggestions applied. Unknown demand still needs a manual quantity and decision note.'); return;
    }
    const result=M.restock(c.restock);
    if(result.qty===null) return;
    if (!c.lines.length) c.lines=[{size:current.source_snapshot.variant_title || '',unit_cost:current.source_snapshot.unit_cost ?? null,retail_price:current.source_snapshot.msrp ?? null}];
    c.lines[0].qty=result.qty; current.content=c; dirty=true; render();
  };
  $('add-size').onclick = () => { renderLine({}); dirty=true; };
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  run(boot);
})();
