import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../v2/seo-overview.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x => x[1]).find(x => x.includes('function renderStrip'));
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', hidden: false, disabled: false, classList: { toggle() {} }, addEventListener() {} });
  return elements.get(id);
};
let rpc = () => { throw Error('Unexpected RPC'); };
const context = vm.createContext({
  window: { __SILO_CONFIG__: { SUPABASE_URL: 'https://test.invalid', SUPABASE_ANON_KEY: 'fixture' }, supabase: { createClient: () => ({ rpc: (...args) => rpc(...args) }) } },
  document: { getElementById: element, querySelector: element, querySelectorAll: () => [] },
  setTimeout: () => 0, console,
});
vm.runInContext(script.replace('  boot();', ''), context);
const run = code => vm.runInContext(code, context);
const fixture = {
  freshness: { site_url: 'https://test.invalid/', property_count: 1, min_day: '2026-08-01', max_day: '2026-09-08', lag_days: 2 },
  window: { start: '2026-09-06', end: '2026-09-08', days_requested: 3, days_present: 2, prior_start: '2026-09-03', prior_end: '2026-09-05' },
  current: { days_present: 2, clicks: 100, impressions: 1000, ctr: .1, position: 4, unattributed_query_click_share: .43, query_5000_row_days: 1 },
  prior: null,
  series: [{ day: '2026-09-06', clicks: 40, impressions: 400, ctr: .1, position: 4, query_5000_rows: true }, { day: '2026-09-08', clicks: 60, impressions: 600, ctr: null, position: null }],
};
context.fixture = fixture;
run('renderStrip(fixture); renderKpis(fixture); renderChart(fixture); renderQueries([], fixture);');
assert.equal(element('kCov').textContent, '57.0%');
assert.match(element('strip').innerHTML, /not proof of a cap/);
assert.match(element('strip').innerHTML, /1 of 3 requested days have no ingested row/);
assert.match(element('kClicksD').textContent, /no prior-period data/);
assert.doesNotMatch(element('queriesFoot').innerHTML, /hit that cap|beyond its/);
assert.doesNotMatch(element('chartWrap').innerHTML, /NaN|Infinity/);
// The absent middle day must break the line rather than compress time.
assert.doesNotMatch(element('chartWrap').innerHTML, / d="[^"]*L/);
run("CHART_MODE = 'quality'; renderChart(fixture)");
assert.doesNotMatch(element('chartWrap').innerHTML, /NaN|Infinity/);
run('renderStrip({ freshness: { property_count: 2 } }); renderKpis(null);');
assert.match(element('strip').innerHTML, /Multiple Search Console properties/);
assert.equal(element('kClicks').textContent, '—');
run('renderStrip({freshness: {}, current: {}})');
assert.match(element('strip').innerHTML, /No Search Console data ingested/);
context.partial = structuredClone(fixture);
context.partial.current.unattributed_query_click_share = null;
context.partial.current.unmeasured_days = 1;
context.partial.current.truncated_days = 1;
run('renderStrip(partial); renderKpis(partial)');
assert.equal(element('kCov').textContent, '—');
assert.match(element('strip').innerHTML, /unmeasured query coverage/);
assert.match(element('strip').innerHTML, /locally truncated/);
// Error refresh clears numbers from the previous successful response.
rpc = async () => ({ error: { message: 'fixture error' } });
await run('runLoad()');
assert.equal(element('kClicks').textContent, '—');
assert.match(element('strip').innerHTML, /Could not load/);
// An old request resolving last cannot replace the newer chosen window.
let resolveOld;
let first = true;
const calls = [];
rpc = async (name, args) => {
  calls.push({name, args});
  if (name === 'search_console_overview') {
    if (first) { first = false; return new Promise(resolve => { resolveOld = resolve; }); }
    return { data: fixture };
  }
  return { data: [] };
};
const oldLoad = run('WINDOW_DAYS = 90; runLoad()');
await run('WINDOW_DAYS = 3; runLoad()');
resolveOld({ data: { ...fixture, current: { clicks: 999999 } } });
await oldLoad;
assert.equal(element('kClicks').textContent, '100');
assert.equal(calls.filter(x => x.name !== 'search_console_overview').length, 2);
assert.ok(calls.filter(x => x.name !== 'search_console_overview').every(x => x.args.p_end === '2026-09-08' && x.args.p_days === 3));
console.log('SEO overview rendering, missing data, ambiguity, errors and request ordering passed');
