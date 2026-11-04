import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
let source = await readFile(new URL('../../v2/nav-config.js', import.meta.url), 'utf8');
if (process.env.MODULE_MUTATION === 'filter') source = source.replace('&& moduleVisible(item, company)', '');
if (process.env.MODULE_MUTATION === 'late') source = source.replace("if (generation !== moduleLoad || global.__SILO_CONFIG__?.getActiveCompany?.()?.id !== company.id) return null;", '');
function setup() {
  let company = { id: 'a', entity_key: 'baseballism' };
  const window = { __SILO_CONFIG__: { getActiveCompany: () => company } };
  vm.runInNewContext(source, { window });
  const nav = window.SiloNav;
  const db = (rows, error = null) => ({ from: table => {
    assert.equal(table, 'workspace_module_visibility');
    return { select: () => ({ eq: async (col, id) => {
      assert.equal(col, 'company_entity_id'); assert.equal(id, company.id);
      return { data: rows, error };
    } }) };
  } });
  const ids = (dept = 'exec', role = 'owner', grants = new Set()) =>
    nav.navSectionsForCompany(company, dept, role, grants).flatMap(s => s.items.map(i => i.id));
  return { nav, db, ids, co: () => company, switch: co => { company = co; } };
}
test('every toggle only removes its own links; all-on restores exact existing permissions', async () => {
  for (const profile of ['baseballism', 'standard']) for (const role of ['owner','admin','member','viewer']) for (const dept of ['exec','marketing','logistics']) {
    const s = setup(); s.switch({ id: 'a', entity_key: profile });
    const before = s.ids(dept, role);
    for (const module of s.nav.MODULES) {
      await s.nav.loadModuleVisibility(s.db([{ company_entity_id: 'a', module_id: module.id, visible: false }]), s.co());
      const expected = before.filter(id => !module.sections.includes(s.nav.NAV_ITEMS.find(i => i.id === id).section));
      assert.deepEqual(s.ids(dept, role), expected);
      await s.nav.loadModuleVisibility(s.db([{ company_entity_id: 'a', module_id: module.id, visible: true }]), s.co());
      assert.deepEqual(s.ids(dept, role), before);
    }
  }
});
test('all off preserves core/company gates and explicit grants never override module-off', async () => {
  const s = setup();
  await s.nav.loadModuleVisibility(s.db(s.nav.MODULES.map(m => ({company_entity_id:'a',module_id:m.id,visible:false}))),s.co());
  const ids = s.ids('exec','owner',new Set(['reports/seo','platform/admin']));
  assert.ok(ids.includes('settings/workspace')); assert.ok(ids.includes('reports/dashboards'));
  assert.ok(ids.includes('platform/admin')); assert.ok(!ids.includes('reports/seo'));
  assert.ok(!ids.includes('reports/silo-attribution'));
});
test('missing, malformed, wrong-company and failed settings fail open', async () => {
  const s = setup(), baseline = s.ids();
  for (const result of [[], null, [{company_entity_id:'b',module_id:'finance',visible:false}], [{company_entity_id:'a',module_id:'finance',visible:'false'}]]) {
    await s.nav.loadModuleVisibility(s.db([{company_entity_id:'a',module_id:'finance',visible:false}]), s.co());
    await s.nav.loadModuleVisibility(s.db(result),s.co()); assert.deepEqual(s.ids(),baseline);
  }
  await s.nav.loadModuleVisibility(s.db([], {message:'offline'}),s.co()); assert.deepEqual(s.ids(),baseline);
});
test('late old-company response cannot affect new company, including same module ids', async () => {
  const s = setup(); let resolve;
  const old = s.nav.loadModuleVisibility({from:()=>({select:()=>({eq:()=>new Promise(r=>{resolve=r;})})})},s.co());
  s.switch({id:'b',entity_key:'standard'});
  const baseline = s.ids();
  await s.nav.loadModuleVisibility(s.db([]),s.co());
  resolve({data:[{company_entity_id:'a',module_id:'finance',visible:false}]});
  assert.equal(await old,null); assert.deepEqual(s.ids(),baseline);
});
test('post-save refresh does not reuse a read started before the write', async () => {
  const s=setup(); let resolve;
  const old=s.nav.loadModuleVisibility({from:()=>({select:()=>({eq:()=>new Promise(r=>{resolve=r;})})})},s.co());
  const fresh=s.nav.loadModuleVisibility(s.db([{company_entity_id:'a',module_id:'finance',visible:false}]),s.co(),true);
  resolve({data:[]}); await old;
  assert.equal((await fresh).finance,false);
  assert.ok(!s.ids().includes('finance/accounting'));
});
