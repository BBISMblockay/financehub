// Marketing suite chart chrome: one visual language, no stretched SVGs.
// Run: node --test scripts/tests/marketing-charts.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

test('SiloMarketingCharts emits modern SVG framing', () => {
  const window = {};
  vm.runInContext(read('v2/marketing-charts.js'), vm.createContext({ window }));
  const M = window.SiloMarketingCharts;
  assert.ok(M?.nextId && M.svgOpen && M.areaClosed && M.gradientDefs);
  const id1 = M.nextId('t');
  const id2 = M.nextId('t');
  assert.notEqual(id1, id2);
  assert.match(M.svgOpen({ w: 400, h: 120, aria: 'test' }), /preserveAspectRatio="xMidYMid meet"/);
  assert.match(M.gradientDefs('g1', 'var(--bcn-accent)'), /linearGradient/);
  assert.match(M.areaClosed('M10,10 L20,5', 20, 10, 100), /Z$/);
});

test('chart pages load shared marketing-charts assets', () => {
  for (const file of ['v2/marketing-overview.html', 'v2/marketing-explorer.html', 'v2/seo-overview.html']) {
    const html = read(file);
    assert.match(html, /href="marketing-charts\.css"/, `${file} loads chart styles`);
    assert.match(html, /src="marketing-charts\.js"/, `${file} loads chart helpers`);
  }
});