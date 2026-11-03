'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
// Tiny DOM for control state; the browser suite executes the real page separately.
function el() {
  return { value: '', children: [], handlers: {}, attrs: {}, style: {},
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
console.log('windsor-picker unit: limits, identity, safe labels, selection and reset passed');

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
