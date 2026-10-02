/* Execute the actual inline mapper/render/save functions with a small DOM and
 * database fixture. No dependencies, network, or service credentials. Browser
 * suite exercises the same paths against the complete unmodified page. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ID = '11111111-2222-4333-8444-555555555555';
const CODE = 'shopify_online_' + ID.replace(/-/g, '');
const CO = 'test-company';
let source = fs.readFileSync(path.resolve(__dirname, '../../integrations.html'), 'utf8');
// Mutations are opt-in test-only changes, never written to the application.
const mutants = {
  scope: [".eq('company_entity_id', company.id).eq('id', connectionId)", ".eq('id', connectionId)"],
  rename: ['.update({ location_name: name, updated_by:', ".update({ location_name: name, location_code: 'changed', updated_by:"],
  duplicate: [' || _salesDefaultSaves.has(connectionId)) return;', ') return;'],
  dismissed: ['if (!locationMapperIsCurrent(connectionId, panel, load)) return;', '/* removed dismissed-load guard */'],
  preview: ['normalizedShopifyLocationName(cache.companyTitle)', "'Company'"],
  returned_row: [`if (!data || data.id !== connectionId || data.company_entity_id !== company.id || data.default_location_code !== defaultCode) {
            throw new Error('The default location was not confirmed saved. Check your permissions and refresh before retrying.');
          }
          cache.defaultLocationCode = data.default_location_code;`, 'cache.defaultLocationCode = defaultCode;'],
};
if (process.env.SHOPIFY_UI_MUTATION) {
  const mutation = mutants[process.env.SHOPIFY_UI_MUTATION];
  assert.ok(mutation && source.includes(mutation[0]), 'mutation target must exist');
  source = source.replace(...mutation);
}
const functions = [
  'escHtml', 'shopifyOnlineLocationCode', 'normalizedShopifyLocationName', 'shopifySalesDefaultHtml', 'onSalesDefaultChange',
  'locationMapperIsCurrent', 'salesDefaultStatus', 'saveShopifySalesDefault', 'renderLocationMapper',
  'loadSiloLocations', 'loadLocationMapperData', 'loadConnectionMappings', 'refreshLocationMapper', 'toggleLocationMapper',
];
const extracted = functions.map(name => {
  const found = source.match(new RegExp('^    (?:async )?function ' + name + '\\([\\s\\S]*?^    }', 'm'));
  assert.ok(found, 'function exists: ' + name);
  return found[0];
}).join('\n');
const decode = value => String(value || '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
let checks = 0;
const eq = (actual, expected, label) => { assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, label); checks += 1; };
const ok = (value, label) => { assert.ok(value, label); checks += 1; };

function fixture() {
  const nodes = new Map();
  let company = { id: CO, title: 'Bat Nutz' };
  let loadGate = null;
  let ensureGate = null;
  let writeGate = null;
  let mode = null;
  const calls = [];
  const loc = (id, code, name, companyId = CO) => ({ id, company_entity_id: companyId, location_code: code, location_name: name, shopify_location_id: null, store_type: 'retail' });
  const tables = {
    locations: [loc(10, 'retail', 'Retail'), loc(20, 'foreign', 'Other company', 'other-company')],
    shopify_connections: [{ id: ID, company_entity_id: CO, shop_domain: 'batnutz.myshopify.com', default_location_code: null, location_id: null }],
    shopify_location_mappings: [],
  };
  const panel = {
    hidden: false, children: [], _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(value) {
      this._html = value;
      for (const child of this.children) if (child.id) nodes.delete(child.id);
      this.children = [];
      const tags = [...value.matchAll(/<(select|input|div|p|button)\b([^>]*?)>/g)];
      for (const match of tags) {
        const [, tag, attrs] = match;
        const inside = tag === 'select' ? value.slice(match.index + match[0].length).split('</select>')[0] : '';
        const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
        const child = { id, hidden: /\bhidden\b/.test(attrs), disabled: false, className: '', textContent: '', style: {}, attrs };
        if (tag === 'select') {
          const options = [...(inside || '').matchAll(/<option value="([^"]*)"([^>]*)>/g)];
          child.value = decode(options.find(o => /\bselected\b/.test(o[2]))?.[1] ?? options[0]?.[1] ?? '');
        } else child.value = decode(/\bvalue="([^"]*)"/.exec(attrs)?.[1] || '');
        this.children.push(child);
        if (id) nodes.set(id, child);
      }
    },
    querySelectorAll() { return this.children.filter(n => /data-sales-default-control|data-loc-refresh/.test(n.attrs)); },
    hasAttribute(name) { return name === 'hidden' && this.hidden; },
    setAttribute(name) { if (name === 'hidden') this.hidden = true; },
    removeAttribute(name) { if (name === 'hidden') this.hidden = false; },
    closest() { return { scrollIntoView() {} }; },
  };
  nodes.set('loc-panel-' + ID, panel);
  function from(table) {
    const q = { table, filters: [], op: 'select', columns: null };
    const api = {
      select(columns) { q.columns = columns; return api; },
      order() { return api; },
      eq(column, value) { q.filters.push([column, value]); return api; },
      is(column, value) { q.filters.push([column, value]); return api; },
      update(patch) { q.op = 'update'; q.patch = patch; return api; },
      async result(single) {
        calls.push(q);
        let rows = (tables[table] || []).filter(row => q.filters.every(([column, value]) => row[column] === value));
        if (q.op === 'update') {
          const responseMode = mode;
          if (writeGate) await writeGate.promise;
          if (responseMode === 'error') return { data: null, error: { message: 'Permission denied' } };
          if (responseMode === 'zero') return { data: null, error: null };
          rows.forEach(row => Object.assign(row, q.patch));
          if (responseMode === 'wrong-company') rows = rows.map(row => ({ ...row, company_entity_id: 'other-company' }));
        }
        return { data: single ? rows[0] || null : rows, error: null };
      },
      single() { return api.result(true); },
      maybeSingle() { return api.result(true); },
      then(resolve, reject) { return api.result(false).then(resolve, reject); },
    };
    return api;
  }
  const context = vm.createContext({
    console, document: { getElementById: id => nodes.get(id) || null },
    window: { __SILO_CONFIG__: { ensureActiveCompany: async () => { const value = company; if (ensureGate) await ensureGate.promise; return value; } } },
    db: { from },
    syncRun: async () => { if (loadGate) await loadGate.promise; return { locations: [] }; },
    renderChannelScope() {}, onLocationMapModeChange() {},
    mappingForShopifyId() {},
  });
  vm.runInContext('const _locMapperCache = new Map(); const _locMapperLoads = new Map(); const _salesDefaultSaves = new Set(); const _session = {user:{id:"test-user"}};\n' + extracted, context);
  return {
    context, panel, tables, calls, node: part => nodes.get('sales-default-' + part + '-' + ID),
    load: () => context.refreshLocationMapper(ID),
    save: action => context.saveShopifySalesDefault(ID, action),
    toggle: () => context.toggleLocationMapper(ID),
    writes: () => calls.filter(c => c.op === 'update'),
    setCompany: value => { company = value; },
    setMode: value => { mode = value; },
    setWriteGate: value => { writeGate = value; },
    setLoadGate: value => { loadGate = value; },
    setEnsureGate: value => { ensureGate = value; },
    addAuto: () => { tables.locations.push(loc(30, CODE, 'Bat Nutz Online')); tables.locations.at(-1).store_type = 'online'; tables.shopify_connections[0].default_location_code = CODE; },
  };
}

(async () => {
  // The pre-sync preview must match the RPC's normalization and fallback
  // order, including malformed legacy labels and wholly empty metadata.
  const namingCases = [
    ['  Bat\t Nutz\n ', 'Ignored shop', 'ignored.example', 'Bat Nutz Online'],
    ['', '  Saved\t Shop\n ', 'ignored.example', 'Saved Shop Online'],
    [' \t\n ', '  Saved\t Shop\n ', 'ignored.example', 'Saved Shop Online'],
    [null, '', '  batnutz.myshopify.com \t', 'batnutz.myshopify.com Online'],
    ['', ' \n\t ', ' \tbatnutz.myshopify.com\n', 'batnutz.myshopify.com Online'],
    ['', '', '', 'Shopify Online'],
    [' \t\n', '\n\t ', ' \t\n', 'Shopify Online'],
    [null, null, null, 'Shopify Online'],
  ];
  for (const [title, shopName, shopDomain, expected] of namingCases) {
    const naming = fixture();
    naming.setCompany({ id: CO, title });
    Object.assign(naming.tables.shopify_connections[0], { shop_name: shopName, shop_domain: shopDomain });
    await naming.load();
    ok(naming.panel.innerHTML.includes('Automatic: ' + expected + '</option>'), 'preview fallback: ' + expected);
    eq(naming.writes(), [], 'preview normalization never writes');
  }
  for (const [storedName, expected] of [['  Custom\t Web\n Name ', 'Custom Web Name'], ['', CODE], [' \t\n', CODE], [null, CODE]]) {
    const naming = fixture();
    naming.addAuto();
    naming.tables.locations.at(-1).location_name = storedName;
    await naming.load();
    eq(naming.node('name').value, expected, 'existing online label normalizes or falls back to its code');
    eq(naming.tables.locations.at(-1).location_name, storedName, 'display fallback does not rename the stored location');
    eq(naming.writes(), [], 'existing label normalization never writes');
  }

  const f = fixture();
  await f.load();
  ok(f.panel.innerHTML.includes('Bat Nutz Online</strong> will be created on the next sales sync'), 'correct pre-sync preview');
  eq(f.writes(), [], 'loading does not save');
  eq(f.node('select').value, '__automatic__');
  ok(!f.node('name'), 'absent location has no label editor');
  ok(!f.panel.innerHTML.includes('Other company'), 'foreign tenant choice is excluded');
  f.node('select').value = '10';
  f.context.onSalesDefaultChange(ID);
  eq(f.writes(), [], 'changing dropdown does not save');
  await f.save('default');
  eq(f.writes().at(-1).patch, { default_location_code: 'retail' });
  eq(f.writes().at(-1).filters, [['company_entity_id', CO], ['id', ID]], 'connection save is tenant scoped');
  eq(f.node('select').value, '10');
  ok(f.node('status').textContent.startsWith('Default sales location saved'), 'confirmed success');
  await f.load();
  eq(f.node('select').value, '10', 'explicit default survives reload');
  ok(!f.node('name'), 'cannot rename a real selected location');

  f.addAuto();
  await f.load();
  eq(f.node('name').value, 'Bat Nutz Online');
  f.node('name').value = '  Web <Store>  ';
  await f.save('name');
  eq(f.writes().at(-1).patch, { location_name: 'Web <Store>', updated_by: 'test-user' });
  eq(f.writes().at(-1).filters, [['company_entity_id', CO], ['id', 30], ['location_code', CODE], ['shopify_location_id', null]], 'label update verifies generated identity');
  const auto = f.tables.locations.at(-1);
  eq([auto.id, auto.location_code, auto.store_type, auto.shopify_location_id], [30, CODE, 'online', null]);
  ok(f.panel.innerHTML.includes('Web &lt;Store&gt;'), 'label escaped on re-render');
  eq(f.node('name').value, 'Web <Store>');
  const beforeBlank = f.writes().length;
  f.node('name').value = '  ';
  await f.save('name');
  eq(f.writes().length, beforeBlank);
  ok(f.node('status').textContent.includes('Enter a display name'), 'empty name has persistent inline error');
  f.node('name').value = 'Denied';
  for (const mode of ['zero', 'error', 'wrong-company']) {
    f.setMode(mode);
    await f.save('name');
    ok(f.node('status').textContent.startsWith('Save failed:'), mode + ' is not success');
    ok(!f.node('status').hidden, mode + ' error remains visible');
  }
  f.setMode('zero');
  f.node('select').value = '10';
  await f.save('default');
  ok(f.node('status').textContent.startsWith('Save failed:'), 'zero-row connection update not success');
  f.setMode(null);
  const gate = deferred();
  f.setWriteGate(gate);
  const beforeDouble = f.writes().length;
  const first = f.save('default');
  const second = f.save('default');
  await tick();
  eq(f.writes().length, beforeDouble + 1, 'repeated clicks make one write');
  ok(f.node('select').disabled, 'form is disabled while writing');
  await f.toggle();
  gate.resolve();
  await Promise.all([first, second]);
  ok(f.panel.hidden, 'pending save does not reopen dismissed panel');
  ok(!f.node('status').textContent.startsWith('Default sales location saved'), 'pending save does not render stale success');
  f.setWriteGate(null);
  await f.toggle();
  eq(f.node('select').value, '10', 'reopening reads saved data');

  const loadGate = deferred();
  f.setLoadGate(loadGate);
  const pendingLoad = f.load();
  await tick();
  await f.toggle();
  loadGate.resolve();
  await pendingLoad;
  ok(f.panel.hidden, 'pending refresh stays dismissed');
  ok(f.panel.innerHTML.includes('Loading Shopify locations'), 'dismissed load never repaints');
  f.setLoadGate(null);
  await f.toggle();

  // Close/reopen during a save may read the old value. Controls stay disabled
  // until the completed write has been reconciled by a fresh read.
  const reopenGate = deferred();
  f.setWriteGate(reopenGate);
  f.node('select').value = '__automatic__';
  const savingAcrossReopen = f.save('default');
  await tick();
  await f.toggle();
  await f.toggle();
  ok(f.node('select').disabled, 'reopened form stays locked during an in-flight write');
  reopenGate.resolve();
  await savingAcrossReopen;
  f.setWriteGate(null);
  eq(f.node('select').value, '__automatic__', 'reopened panel reconciles the committed value');
  ok(!f.node('select').disabled, 'reconciled form is usable again');

  const latest = fixture();
  const oldLoad = deferred();
  latest.setLoadGate(oldLoad);
  const slowRefresh = latest.load();
  await tick();
  latest.setLoadGate(null);
  latest.setCompany({ id: CO, title: 'Latest title' });
  await latest.load();
  oldLoad.resolve();
  await slowRefresh;
  ok(latest.panel.innerHTML.includes('Latest title Online'), 'older refresh cannot overwrite newer render');

  const missing = fixture();
  missing.tables.shopify_connections[0].default_location_code = 'unavailable';
  await missing.load();
  eq(missing.node('select').value, '__missing__', 'unavailable explicit defaults are not silently changed');
  await missing.save('default');
  eq(missing.writes(), [], 'unavailable selection cannot be saved as a nonexistent location');

  Object.assign(f.tables.shopify_connections[0], { default_location_code: null, location_id: 10 });
  await f.load();
  eq(f.node('select').value, '10', 'legacy location pointer resolves to existing selection');
  ok(!f.panel.innerHTML.includes('value="__automatic__"'), 'legacy pointer does not offer clearing via Automatic');
  ok(!f.panel.innerHTML.includes('will be created on the next sales sync'), 'legacy pointer gets no fake preview');
  await f.save('default');
  eq(f.writes().at(-1).patch, { default_location_code: 'retail' }, 'legacy pointer remains intact');
  eq(f.tables.shopify_connections[0].location_id, 10);
  f.setCompany({ id: 'other-company', title: 'Other' });
  const beforeCompany = f.writes().length;
  await f.save('default');
  eq(f.writes().length, beforeCompany, 'company change blocks write');
  ok(f.node('status').textContent.includes('active company changed'), 'company switch is actionable error');

  // Dismissing while company validation is pending must prevent the write.
  f.setCompany({ id: CO, title: 'Bat Nutz' });
  const ensureGate = deferred();
  f.setEnsureGate(ensureGate);
  const pendingEnsure = f.save('default');
  await f.toggle();
  ensureGate.resolve();
  await pendingEnsure;
  eq(f.writes().length, beforeCompany, 'dismissal before write starts cancels save');
  console.log(`  shopify-sales-default: ${checks} assertions passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
