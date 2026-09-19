'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadV2, V2 } = require('../lib/load');
const { fakeSupabaseScript, CONFIG_STUB } = require('../lib/harness');
const { tables, plan, invoice } = require('../lib/payments-fixtures');
const mutation = process.env.PAYMENTS_UI_MUTATION;
const mutations = {
  'current-plan-duplicated': ["const available = _plans.filter((p) => planAction(_sub, p.plan_key).kind !== 'current');", 'const available = _plans;'],
  'paid-can-send': ["if (r.status === 'draft') {", "if (r.status === 'draft' || r.status === 'paid') {"],
  'read-failure-is-empty': ['if (_invoiceLoadError) {', 'if (false) {'],
};
let mutationApplied = false;
function mutate(source) {
  const rule = mutations[mutation];
  if (rule && source.includes(rule[0])) { mutationApplied = true; return source.replace(rule[0], rule[1]); }
  return source;
}
const ui = loadV2(['payments-ui.js']).SiloPaymentsUI;
let passed = 0;
const check = async (name, fn) => { await fn(); console.log('PASS ' + name); passed++; };
const settle = async () => { for (let n = 0; n < 5; n++) await new Promise((resolve) => setTimeout(resolve, 0)); };

// Execute the real inline page and boot/event wiring. The DOM stores rendered
// markup; native focus, CSS and dialog behavior belong to the browser suite.
async function page(name, scenario = 'active', extra = {}) {
  const source = fs.readFileSync(path.join(V2, name + '.html'), 'utf8');
  const nodes = new Map();
  function scan(html) {
    for (const match of html.matchAll(/\bid="([^"]+)"/g)) if (!nodes.has(match[1])) nodes.set(match[1], element());
  }
  function element() {
    let markup = '';
    return { textContent: '', hidden: false, open: false, value: '', dataset: {}, listeners: {},
      get innerHTML() { return markup; }, set innerHTML(value) { markup = value; scan(value); },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      showModal() { this.open = true; }, close() { this.open = false; },
      querySelectorAll() { return []; },
    };
  }
  scan(source);
  const requests = [];
  const data = tables(scenario);
  Object.assign(data, extra.tables);
  const context = {
    console, Intl, URLSearchParams, setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
    __FIXTURE_TABLES__: data, __FIXTURE_BROKEN__: extra.broken || [],
    document: { getElementById: (id) => nodes.get(id) || null, querySelectorAll: () => [], querySelector: () => element() },
    location: { pathname: '/v2/' + name + '.html', search: '' }, history: { replaceState() {} },
    confirm: () => false,
    SiloInvoiceRequest: { pending: () => null },
    fetch: async (url, options) => {
      requests.push({ url, payload: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ status: 'paid', url: 'https://example.test/portal' }) };
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(CONFIG_STUB + fakeSupabaseScript(), context);
  vm.runInContext(fs.readFileSync(path.join(V2, 'payments-ui.js'), 'utf8'), context);
  const inline = mutate([...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n'));
  vm.runInContext(inline, context, { filename: name + '.html' });
  await settle();
  return { nodes, requests, context, source, data };
}

(async () => {
  await check('search and status compose; matching is literal, case-insensitive and null-safe', () => {
    const rows = [invoice, { ...invoice, id: 'second', status: 'paid', number: null, customer_display_name: 'Other' }];
    assert.equal(ui.filterInvoices(rows, 'paid', 'other').length, 1);
    assert.equal(ui.filterInvoices(rows, 'open', 'other').length, 0);
    assert.equal(ui.filterInvoices(rows, '', ' BUYER@EXAMPLE.TEST ').length, 2);
    assert.equal(ui.filterInvoices(rows, '', '.*').length, 0);
    assert.equal(ui.filterInvoices(rows, '', 'in_demo').length, 2);
  });
  await check('icons are decorative and unknown icon names cannot inject markup', () => {
    assert.match(ui.icon('refresh'), /aria-hidden="true"/);
    assert.doesNotMatch(ui.icon('<script>'), /<script>/);
  });
  await check('active billing has one current plan, with renewal and portal preserved', async () => {
    const p = await page('billing');
    assert.match(p.nodes.get('current').innerHTML, /Growth/);
    assert.match(p.nodes.get('current').innerHTML, /500\.00/);
    assert.match(p.nodes.get('current').innerHTML, /Renews/);
    assert.equal(p.nodes.get('planCard').hidden, true);
    assert.equal(p.nodes.get('btnPortal').hidden, false);
    await p.nodes.get('btnPortal').listeners.click();
    assert.equal(p.requests[0].payload.action, 'portal');
  });
  await check('live alternative plan still goes to portal, never a second checkout', async () => {
    const p = await page('billing', 'active', { tables: { billing_plans: [plan, { ...plan, plan_key: 'scale', title: 'Scale' }] } });
    assert.equal(p.nodes.get('planCard').hidden, false);
    assert.match(p.nodes.get('plans').innerHTML, /data-portal/);
    assert.doesNotMatch(p.nodes.get('plans').innerHTML, /data-plan=/);
  });
  await check('cancellation, scheduled ending and collection issue remain distinct', async () => {
    const canceled = await page('billing', 'canceled');
    assert.match(canceled.nodes.get('current').innerHTML, /Period ended/);
    assert.match(canceled.nodes.get('plans').innerHTML, /data-plan="growth"/);
    const ending = await page('billing', 'ending');
    assert.match(ending.nodes.get('current').innerHTML, />Ends</);
    assert.doesNotMatch(ending.nodes.get('current').innerHTML, />Renews</);
    const late = await page('billing', 'past-due');
    assert.match(late.nodes.get('current').innerHTML, /Payment needs attention/);
    assert.equal(late.nodes.get('planCard').hidden, true);
  });
  await check('empty and unconfigured billing are distinguished without a fake active plan', async () => {
    const empty = await page('billing', 'empty');
    assert.match(empty.nodes.get('current').innerHTML, /Choose a plan/);
    assert.equal(empty.nodes.get('btnPortal').hidden, true);
    const none = await page('billing', 'no-plans');
    assert.match(none.nodes.get('current').innerHTML, /Plans are not configured/);
    assert.doesNotMatch(none.nodes.get('current').innerHTML, /Choose a plan/);
  });
  await check('invoice filters run through the real input listeners and disclose capped scope', async () => {
    const p = await page('invoicing');
    p.nodes.get('invoiceSearch').value = 'cedar';
    p.nodes.get('invoiceSearch').listeners.input();
    assert.match(p.nodes.get('tblInvoices').innerHTML, /Cedar Athletics/);
    assert.doesNotMatch(p.nodes.get('tblInvoices').innerHTML, /North Coast/);
    p.nodes.get('statusFilter').value = 'paid';
    p.nodes.get('statusFilter').listeners.change();
    assert.match(p.nodes.get('tblInvoices').innerHTML, /No invoices match/);
    p.nodes.get('invoiceSearch').value = '';
    p.nodes.get('invoiceOverview').listeners.click({ target: { closest: () => ({ dataset: { invoiceFilter: 'open' } }) } });
    assert.match(p.nodes.get('tblInvoices').innerHTML, /North Coast/);
    assert.doesNotMatch(p.nodes.get('tblInvoices').innerHTML, /Fieldhouse/);
    assert.match(p.nodes.get('invoiceScope').textContent, /up to 500/);
  });
  await check('details preserve state-specific actions and draft unknown amounts', async () => {
    const p = await page('invoicing');
    const open = (id) => p.nodes.get('tblInvoices').listeners.click({ target: { closest: () => ({ dataset: { detail: id } }) } });
    open('draft-demo');
    assert.equal(p.nodes.get('dlgInvoiceDetail').open, true);
    assert.match(p.nodes.get('invoiceDetail').innerHTML, /data-act="finalize"/);
    assert.match(p.nodes.get('invoiceDetail').innerHTML, /Outstanding<\/dt><dd class="bcn-mono">—/);
    open('paid-demo');
    assert.doesNotMatch(p.nodes.get('invoiceDetail').innerHTML, /data-act="(?:send|finalize|void|uncollectible)"/);
    assert.match(p.nodes.get('invoiceDetail').innerHTML, /data-act="sync"/);
    open('late-demo');
    assert.match(p.nodes.get('invoiceDetail').innerHTML, /overdue/);
    assert.match(p.nodes.get('invoiceDetail').innerHTML, /data-act="void"/);
    p.nodes.get('invoiceDetail').listeners.click({ target: { closest: () => ({ dataset: { act: 'void', id: 'late-demo' } }) } });
    await settle();
    assert.equal(p.requests.length, 0, 'canceling confirmation cannot call Stripe');
    p.nodes.get('invoiceDetail').listeners.click({ target: { closest: () => ({ dataset: { act: 'sync', id: 'paid-demo' } }) } });
    await settle();
    assert.equal(p.requests[0].payload.action, 'sync');
    assert.equal(p.requests[0].payload.invoice_id, 'paid-demo');
  });
  await check('customer names and invoice numbers are escaped in table and drawer', async () => {
    const p = await page('invoicing', 'active', { tables: { stripe_invoices_v: [{ ...invoice, number: '<img src=x>', customer_display_name: '<script>bad</script>' }] } });
    assert.doesNotMatch(p.nodes.get('tblInvoices').innerHTML, /<script>|<img src=x>/);
    p.nodes.get('tblInvoices').listeners.click({ target: { closest: () => ({ dataset: { detail: invoice.id } }) } });
    assert.doesNotMatch(p.nodes.get('invoiceDetail').innerHTML, /<script>/);
  });
  await check('read failures are errors, not zero counts or an unsubscribed company', async () => {
    const p = await page('invoicing', 'active', { broken: ['stripe_invoices_v'] });
    assert.equal(p.nodes.get('invoiceOverview').hidden, true);
    assert.match(p.nodes.get('tblInvoices').innerHTML, /Unable to load/);
    const b = await page('billing', 'active', { broken: ['billing_subscriptions_v'] });
    assert.match(b.nodes.get('status').textContent, /Subscription unavailable/);
    assert.doesNotMatch(b.nodes.get('current').innerHTML, /No subscription/);
  });
  await check('invoicing is an accounting destination, billing is not', () => {
    const nav = loadV2(['nav-config.js']).SiloNav;
    assert(nav.ACCOUNTING_PAGES.some(([id]) => id === 'finance/invoicing'));
    assert(!nav.ACCOUNTING_PAGES.some(([id]) => id === 'finance/billing'));
  });
  if (mutation) assert(mutationApplied, 'Mutation must actually change the executing source');
  console.log(`${passed} payments presentation checks passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
