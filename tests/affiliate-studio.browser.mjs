// Real Affiliate Studio page and DOM against an in-memory Supabase stand-in
// (PR #1408). No network: every SDK call is answered by the fixture below.
//
// What this proves, on the real studio.js:
//   - a closed program sits last in the picker and the default is an open one
//   - Discovery has To review / Shortlisted / Archive / All; signed-up people
//     are not in Discovery; a person with an open row shows only that row
//   - Your customers has Likely / Check / Under the bar / Shortlisted /
//     Archive, the score reads "Likely 90%" with a reason on hover
//   - Do not contact archives ONLY the finds whose do-not-contact entry
//     landed: a refused insert leaves that find on the working list
//   - Setup links to Billing for the automatic searches
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const OUT = fileURLToPath(new URL('./screenshots/', import.meta.url));
await mkdir(OUT, { recursive: true });
const CO = 'co-1';
const OPEN = 'prog-open'; const CLOSED = 'prog-closed';
const now = '2026-11-20T00:00:00Z';
const prospects = [];
const mk = (id, program_id, status, name, extra = {}) => prospects.push({ id, company_entity_id: CO, program_id, status, display_name: name, handle: '@' + id, platform: 'instagram', profile_url: `https://instagram.com/${id}`, contact_email: `${id}@ex.test`, source: 'serp', collected_at: now, created_at: now, evidence: { followers: { count: 12000 } }, ...extra });
mk('p1', OPEN, 'new', 'New One');
mk('p2', OPEN, 'approved', 'Short Listed');
mk('p3', OPEN, 'rejected', 'Not Fit');
mk('p4', OPEN, 'signed_up', 'Signed Up');
mk('p5', CLOSED, 'new', 'Only In Test');
mk('p6', CLOSED, 'new', 'Both Programs'); mk('p6b', OPEN, 'approved', 'Both Programs', { handle: '@p6', profile_url: 'https://instagram.com/p6', contact_email: 'p6@ex.test' });
const social = [
  { id: 's1', company_entity_id: CO, customer_key: 'c1', status: 'found', match_basis: 'city', match_score: 90, platform: 'instagram', handle: '@cust1', profile_url: 'https://instagram.com/cust1', followers: 5000, followers_quote: '5,000', review: null, checked_at: now },
  { id: 's2', company_entity_id: CO, customer_key: 'c2', status: 'found', match_basis: 'name_only', match_score: 40, platform: 'instagram', handle: '@cust2', profile_url: 'https://instagram.com/cust2', followers: 9000, followers_quote: '9,000', review: null, checked_at: now },
  { id: 's3', company_entity_id: CO, customer_key: 'c3', status: 'found', match_basis: 'city', match_score: 80, platform: 'instagram', handle: '@cust3', profile_url: 'https://instagram.com/cust3', followers: 1000, followers_quote: '1,000', review: 'not_fit', checked_at: now },
  { id: 's4', company_entity_id: CO, customer_key: 'c4', status: 'found', match_basis: 'city', match_score: 85, platform: 'instagram', handle: '@cust4', profile_url: 'https://instagram.com/cust4', followers: 2000, followers_quote: '2,000', review: 'shortlisted', checked_at: now },
];
const profiles = ['c1', 'c2', 'c3', 'c4'].map((k, i) => ({ company_entity_id: CO, customer_key: k, name_lc: `customer ${k}`, email_lc: `${k}@buy.test`, order_count: 5 - i, lifetime_spend: 300 - i * 20, last_order_at: now, first_order_at: now, email_consent_state: 'subscribed' }));
const DATA = {
  affiliate_programs: [
    { id: CLOSED, company_entity_id: CO, name: 'Test Program', status: 'closed', currency: 'USD', created_at: '2026-11-01T00:00:00Z' },
    { id: OPEN, company_entity_id: CO, name: 'Starting Lineup', status: 'active', currency: 'USD', created_at: '2026-11-05T00:00:00Z', niche: 'baseball' },
  ],
  affiliate_prospects: prospects,
  affiliate_customer_social: social,
  company_customer_profiles: profiles,
  affiliate_customer_scans: [{ id: 'scan1', company_entity_id: CO, status: 'done', requested: 10, checked: 10, found: 4, min_followers: 750, filters: {}, started_at: now, finished_at: now }],
  profiles: [{ id: 'u1', role: 'owner' }],
};

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
const errors = [];
await ctx.addInitScript((DATA) => {
  const st = globalThis.__fx = { data: DATA, rpcs: [], writes: [] };
  const parseOr = (expr) => expr.split(',').map((p) => { const [c, op, ...v] = p.split('.'); return { c, op, v: v.join('.') }; });
  const test = (r, { c, op, v }) => {
    if (op === 'eq') return String(r[c]) === v;
    if (op === 'is') return v === 'null' ? r[c] == null : String(r[c]) === v;
    if (op === 'lt') return r[c] != null && r[c] < Number(v);
    if (op === 'in') return v.replace(/[()]/g, '').split(',').includes(String(r[c]));
    return true;
  };
  const make = (table) => {
    const f = []; let opts = {}; let lim = null; let mode = 'select'; let payload = null; let head = false;
    const b = {
      select(_c, o = {}) { opts = o; head = !!o.head; return b; },
      eq(c, v) { f.push((r) => r[c] === v); return b; },
      neq(c, v) { f.push((r) => r[c] !== v); return b; },
      in(c, vs) { f.push((r) => vs.includes(r[c])); return b; },
      is(c, v) { f.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      not(c, op, v) { if (op === 'is') f.push((r) => r[c] != null); else if (op === 'in') { const vs = String(v).replace(/[()]/g, '').split(','); f.push((r) => !vs.includes(String(r[c]))); } return b; },
      gte(c, v) { f.push((r) => r[c] == null || r[c] >= v); return b; },
      gt(c, v) { f.push((r) => r[c] > v); return b; },
      lt(c, v) { f.push((r) => r[c] < v); return b; },
      lte(c, v) { f.push((r) => r[c] <= v); return b; },
      ilike() { return b; }, like() { return b; }, contains() { return b; }, filter() { return b; }, match() { return b; },
      or(expr) { const ps = parseOr(expr); f.push((r) => ps.some((p) => test(r, p))); return b; },
      order() { return b; }, limit(n) { lim = n; return b; }, range(a, z) { lim = z - a + 1; return b; },
      insert(p) { mode = 'insert'; payload = p; return b; }, update(p) { mode = 'update'; payload = p; return b; },
      upsert(p) { mode = 'insert'; payload = p; return b; }, delete() { mode = 'delete'; return b; },
      single() { return b.then((r) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] || null : r.data })); },
      maybeSingle() { return b.single(); },
      then(res, rej) {
        const rows = (st.data[table] || []).filter((r) => f.every((fn) => fn(r)));
        let out;
        if (mode !== 'select') { st.writes.push({ table, mode, payload }); if (table === 'affiliate_suppressions' && String(payload?.value_normalized || '').includes('c2')) return Promise.resolve({ data: null, error: { code: '42501', message: 'refused' } }).then(res, rej); out = { data: Array.isArray(payload) ? payload : [{ id: 'new-' + st.writes.length, ...(payload || {}) }], error: null }; }
        else out = { data: head ? null : (lim ? rows.slice(0, lim) : rows), count: rows.length, error: null };
        return Promise.resolve(out).then(res, rej);
      },
    };
    return b;
  };
  globalThis.__fixtureCreateClient = () => ({
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1', email: 'owner@ex.test' }, access_token: 't' } } }), getUser: async () => ({ data: { user: { id: 'u1' } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from: make,
    rpc: async (name, args) => {
      st.rpcs.push({ name, args });
      if (name === 'can_manage_affiliate_programs' || name === 'can_approve_affiliate_commissions') return { data: true, error: null };
      if (name === 'affiliate_customer_social_review') {
        let n = 0;
        for (const r of st.data.affiliate_customer_social) if (args.p_keys.includes(r.customer_key)) {
          if (args.p_review === null) { if (r.review === 'not_fit') { r.review = null; n++; } } else if (r.review !== args.p_review && r.review !== 'suppressed') { r.review = args.p_review; n++; }
        }
        return { data: n, error: null };
      }
      return { data: null, error: null };
    },
    functions: { invoke: async () => ({ data: {}, error: null }) },
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: '' } }), createSignedUrl: async () => ({ data: null }) }) },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
  });
}, DATA);
await ctx.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType: 'text/javascript', body: 'window.supabase = {createClient: globalThis.__fixtureCreateClient};' });
  if (url.hostname.includes('fonts.') ) return route.fulfill({ contentType: 'text/css', body: '' });
  if (url.hostname !== 'get-silo.com') return route.fulfill({ status: 204 });
  if (url.pathname === '/pages/config.js') return route.fulfill({ contentType: 'text/javascript', body: `window.__SILO_CONFIG__={SUPABASE_URL:"https://fx.invalid",SUPABASE_ANON_KEY:"x",ensureActiveCompany:async()=>({id:"${CO}",name:"Fixture Co"})};` });
  if (['/v2/silo-chrome.js', '/v2/v2-shell.js', '/v2/avatar.js'].includes(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: 'window.SiloChrome={mount(){}};' });
  const rel = url.pathname.slice(1);
  try {
    const body = await readFile(path.join(root, rel));
    const ct = rel.endsWith('.css') ? 'text/css' : rel.endsWith('.js') ? 'text/javascript' : rel.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    return route.fulfill({ contentType: ct, body });
  } catch { return route.fulfill({ status: 404 }); }
});
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('https://get-silo.com/v2/affiliates/index.html');
await page.waitForTimeout(1500);
const out = {};
// Discovery
await page.evaluate(() => document.querySelector('[data-act="people-sub"][data-k="discovery"]')?.click());
await page.waitForTimeout(600);
out.picker = await page.$eval('#programSel', (s) => [...s.querySelectorAll('option')].map((o) => (o.parentElement.tagName === 'OPTGROUP' ? 'closed:' : '') + o.textContent + (o.selected ? '*' : '')));
out.segs = await page.$$eval('[data-act="prospect-filter"]', (b) => b.map((x) => x.textContent.trim()));
out.discText = (await page.textContent('#prospectsBody')).replace(/\s+/g, ' ').slice(0, 1500);
await page.screenshot({ path: OUT + 'affiliates-discovery.png', fullPage: false });
await page.evaluate(() => document.querySelector('[data-act="prospect-filter"][data-f="archive"]')?.click());
await page.waitForTimeout(300);
out.archiveText = (await page.textContent('#prospectsBody')).replace(/\s+/g, ' ').slice(0, 600);
// Customers
await page.evaluate(() => document.querySelector('[data-act="people-sub"][data-k="customers"]')?.click());
await page.waitForTimeout(1200);
out.tiers = await page.$$eval('[data-act="cust-hunt-tier"]', (b) => b.map((x) => x.textContent.trim()));
out.pills = await page.$$eval('.af-score-pill', (b) => b.map((x) => `${x.textContent} | ${x.title}`));
await page.evaluate(() => document.querySelector('[data-act="cust-select-all"]')?.click());
await page.waitForTimeout(300);
out.bulk = await page.$$eval('#customersBody .af-bulk button', (b) => b.map((x) => x.textContent.trim()));
await page.screenshot({ path: OUT + 'affiliates-customers.png', fullPage: false });
// Do not contact on c1 (lands) and c2 (refused)
await page.evaluate(() => document.querySelector('[data-act="cust-hunt-tier"][data-k="check"]')?.click());
await page.waitForTimeout(900);
await page.evaluate(() => document.querySelector('[data-act="cust-select-all"]')?.click());
await page.waitForTimeout(200);
await page.evaluate(() => { const b = document.querySelector('#customersBody .af-bulk [data-act="cust-dnc"]'); b.click(); b.click(); });
await page.waitForTimeout(1200);
out.dncRpc = await page.evaluate(() => globalThis.__fx.rpcs.filter((r) => r.name === 'affiliate_customer_social_review'));
out.status = await page.textContent('#status');
await page.evaluate(() => document.querySelector('[data-act="cust-hunt-tier"][data-k="top"]')?.click());
await page.waitForTimeout(900);
await page.evaluate(() => document.querySelector('[data-act="cust-select-all"]')?.click());
await page.waitForTimeout(200);
await page.evaluate(() => { const b = document.querySelector('#customersBody .af-bulk [data-act="cust-dnc"]'); b.click(); b.click(); });
await page.waitForTimeout(1200);
out.dncRpc2 = await page.evaluate(() => globalThis.__fx.rpcs.filter((r) => r.name === 'affiliate_customer_social_review'));
out.status2 = await page.textContent('#status');
// Setup
await page.evaluate(() => document.querySelector('#tab-program')?.click());
await page.waitForTimeout(800);
out.setupAuto = await page.$eval('#programBody', (e) => { const a = e.querySelector('a[href*="billing"]'); return a ? a.getAttribute('href') + ' | ' + a.closest('.bcn-card').textContent.replace(/\s+/g, ' ').slice(0, 200) : 'none'; });
await page.screenshot({ path: OUT + 'affiliates-setup.png', fullPage: false });
out.errors = errors;
await browser.close();
assert.deepEqual(out.errors, [], 'no page errors');
assert.deepEqual(out.picker, ['All programs', 'Starting Lineup · active*', 'closed:Test Program · closed'], 'closed program last, open one picked');
assert.deepEqual(out.segs, ['To review 2', 'Shortlisted 2', 'Archive 1', 'All 5'], 'signed up is not in Discovery; the person with an open row counts once');
assert.match(out.archiveText, /Not Fit/); assert.doesNotMatch(out.archiveText, /New One/);
assert.deepEqual(out.tiers, ['Likely · 750+ 1', 'Check · 750+ 1', 'Under the bar', 'Shortlisted 1', 'Archive 1']);
assert.equal(out.pills.length, 1);
assert.match(out.pills[0], /^Likely 90% \| 90% sure .*city.*70% and up is Likely/);
assert.deepEqual(out.bulk, ['Shortlist', 'Not a fit', 'Not them', 'Do not contact', 'Clear']);
assert.deepEqual(out.dncRpc, [], 'a refused do-not-contact insert archives nothing');
assert.match(out.status, /^0 added .* 1 could not be added\./);
assert.deepEqual(out.dncRpc2.map((r) => [r.args.p_keys, r.args.p_review]), [[['c1'], 'suppressed']], 'only the find that was listed is archived');
assert.match(out.setupAuto, /^\.\.\/billing\.html#studioCard \| Automatic searches/);
console.log('affiliate-studio.browser: all checks passed');
