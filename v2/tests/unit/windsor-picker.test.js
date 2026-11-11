'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
// Tiny DOM for control state; the browser suite executes the real page separately.
function el() {
  return { value: '', children: [], handlers: {}, attrs: {}, style: {},
    focus() { this.focused = true; },
    querySelector() { return this.children.find(x => x.attrs?.['aria-pressed'] === 'true'); },
    querySelectorAll() { return this.children.flatMap(x => x.children || []).filter(x => x.type === 'checkbox'); },
    appendChild(x) { this.children.push(x); }, replaceChildren() { this.children = []; },
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, v) { this.handlers[k] = v; } };
}
const window = {};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../windsor-picker.js'), 'utf8'), {
  window, document: { createElement: el, createElementNS: el, createTextNode: (text) => ({ text }) },
});
const search = el(), list = el(), status = el(); let picked;
const picker = window.WindsorPicker.fieldPicker({ search, list, status, onChange: (ids) => { picked = ids; }, max: 3 });
picker.setFields([{ id: 'account_id', name: 'Account ID' }, { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }], ['account_id', 'a', 'b']);
assert.equal(list.children[0].children[0].disabled, true);
assert.equal(list.children[3].children[0].disabled, true, 'selection limit includes identity');
search.value = 'Beta'; search.handlers.input();
const input = list.children[0].children[0]; input.checked = false; input.handlers.change();
assert.equal(picked.join(','), 'account_id,a', 'search preserves selections outside the visible list');
picker.setFields([], []);
assert.equal(picked.length, 0, 'switch/failure clears stale fields');
const integration = window.WindsorPicker.integrationPicker({ search, list, status, onSelect: (x) => { picked = x; } });
search.value = '';
integration.setItems([{ id: 'new_source', name: '<img onerror=alert(1)>' }]);
assert.equal(list.children[0].children[1].text, ' <img onerror=alert(1)>', 'vendor labels are literal text');
list.children[0].handlers.click();
assert.equal(picked.id, 'new_source');
integration.setItems([]); assert.equal(picked, null);

// SILO's own integrations are grouped, never dropped: the same items are still
// offered, and a picker given no group containers behaves exactly as before.
{
  const items = [{ id: 'klaviyo', name: 'Klaviyo' }, { id: 'pinterest', name: 'Pinterest' }, { id: 'facebook', name: 'Meta Ads' }];
  const flatList = el();
  const flat = window.WindsorPicker.integrationPicker({ search: el(), list: flatList, status: el(), onSelect() {} });
  const s2 = el(), l2 = el(), st2 = el(), nl = el(), ng = el(), nc = el();
  let chose;
  const grouped = window.WindsorPicker.integrationPicker({ search: s2, list: l2, status: st2,
    nativeGroup: ng, nativeList: nl, nativeCount: nc, onSelect: (x) => { chose = x; } });
  grouped.setItems(items);
  assert.equal(l2.children.length, 1, 'only sources SILO does not integrate are offered first');
  assert.equal(nl.children.length, 2, 'the rest move into the group, they are not removed');
  assert.equal(nc.textContent, '2');
  assert.equal(ng.hidden, false);
  assert.match(st2.textContent, /^1 integrations/);
  nl.children[0].handlers.click();
  assert.equal(chose.id, 'klaviyo', 'a grouped source can still be connected');
  // Searching only a SILO integration says so rather than reading as empty.
  s2.value = 'klaviyo'; s2.handlers.input();
  assert.equal(l2.children.length, 0);
  assert.equal(nl.children.length, 1);
  assert.match(st2.textContent, /is a SILO integration/);
  s2.value = 'nothingmatches'; s2.handlers.input();
  assert.equal(ng.hidden, true, 'the group disappears when nothing in it matches');
  assert.match(st2.textContent, /No integrations match/);
  // Same items, no group containers: one list, as before.
  flat.setItems(items);
  assert.equal(flatList.children.length, 3, 'without group containers nothing is grouped or hidden');
  assert.equal(window.WindsorPicker.nativeIntegration('GA4'), 'Google Analytics 4', 'ids are matched case-insensitively');
  assert.equal(window.WindsorPicker.nativeIntegration('pinterest'), null);
  assert.equal(window.WindsorPicker.nativeIntegration(undefined), null);
}
console.log('windsor-picker unit: limits, identity, safe labels, selection, reset and SILO-integration grouping passed');

const { previewCatalogProblem, discoveryError, SERVICE_UPDATE } = window.WindsorPicker;
assert.equal(previewCatalogProblem({ numeric_fields: [{ id: 'clicks' }], total_fields: 99 }), SERVICE_UPDATE);
assert.equal(discoveryError('connector_catalog', 400, { error: 'Unknown action' }), SERVICE_UPDATE);
assert.equal(discoveryError('connector_catalog', 403, { error: 'Admin access required' }), null, 'authorization failures stay distinct');
assert.equal(discoveryError('preview', 400, { error: 'Unknown action' }), null);
assert.match(previewCatalogProblem({ fields: [], default_fields: [] }), /did not list an account identity field/);
assert.match(previewCatalogProblem({ fields: [{ id: 'account_id' }], default_fields: [] }), /valid field selection/);
assert.match(previewCatalogProblem({ fields: [{ id: 'account_id' }], default_fields: ['account_id', 'unknown'] }), /valid field selection/);
assert.equal(previewCatalogProblem({ fields: [{ id: 'account_id' }], default_fields: ['account_id'] }), null);
console.log('windsor compatibility: old schema, absent identity, bad defaults and valid recovery distinguished');
