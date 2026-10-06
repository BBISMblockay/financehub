// Real platform-admin page and DOM; all SDK calls use local in-memory fixtures.
// No Supabase network calls, real queue records, invites or accounts are touched.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const screenshots = fileURLToPath(new URL('./screenshots/', import.meta.url));
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
const failures = [];
const checks = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const malicious = '<img src=x onerror="globalThis.fixtureXSS=true">';
const row = (id, extra = {}) => ({ id, name: 'Pat Example', company_name: 'Example Company', email: 'pat@example.test',
  created_at: '2026-10-01T00:00:00Z', status: 'pending', ...extra });

async function fixture({ authorized = true, rows = [row('fixture-1')], signedIn = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(options => {
    const state = globalThis.__queueFixture = { ...options, queries: [], rpcs: [], saveMode: 'success', reads: 0, blockSave: false };
    globalThis.__fixtureCreateClient = () => ({
      auth: { getSession: async () => ({ data: { session: state.signedIn ? { user: { id: 'fixture-admin' } } : null } }) },
      rpc: async name => {
        state.rpcs.push(name);
        if (!['is_platform_admin', 'platform_list_companies', 'list_platform_invites'].includes(name)) throw new Error('Unexpected RPC: ' + name);
        return { data: name === 'is_platform_admin' ? state.authorized : [], error: null };
      },
      from(table) {
        if (!['profiles', 'onboarding_interest_queue'].includes(table)) throw new Error('Unexpected table: ' + table);
        const query = { table, filters: [], orders: [] };
        const builder = {
          select(columns) { query.columns = columns; return builder; },
          eq(column, value) { query.filters.push([column, value]); return builder; },
          order(column, options) { query.orders.push([column, options]); return builder; },
          update(values) { query.update = values; return builder; },
          async range(start, end) {
            query.range = [start, end]; state.queries.push(query); state.reads++;
            const filtered = state.rows.filter(row => query.filters.every(([key, value]) => row[key] === value));
            return { data: filtered.slice(start, end + 1), error: null };
          },
          async maybeSingle() {
            state.queries.push(query);
            if (table === 'profiles') return { data: { email: 'admin@example.test', role: 'owner' }, error: null };
            if (state.blockSave) await new Promise(resolve => { state.releaseSave = resolve; });
            if (state.saveMode === 'error') return { data: null, error: { message: 'private service error' } };
            if (state.saveMode === 'conflict') return { data: null, error: null };
            const row = state.rows.find(row => query.filters.every(([key, value]) => row[key] === value));
            if (!row) return { data: null, error: null };
            Object.assign(row, query.update); return { data: { id: row.id }, error: null };
          },
        };
        return builder;
      },
    });
  }, { authorized, rows, signedIn });
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() !== 'GET') { failures.push('Unexpected network write: ' + request.method()); return route.abort(); }
    if (url.hostname === 'cdn.jsdelivr.net' && url.pathname === '/npm/@supabase/supabase-js@2') {
      return route.fulfill({ contentType: 'text/javascript', body: 'window.supabase = {createClient: globalThis.__fixtureCreateClient};' });
    }
    if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
    if (url.hostname !== 'get-silo.com') { failures.push('Unexpected host: ' + url.hostname); return route.abort(); }
    if (url.pathname === '/pages/config.js') return route.fulfill({ contentType: 'text/javascript', body:
      'window.__SILO_CONFIG__={SUPABASE_URL:"https://fixture.invalid",SUPABASE_ANON_KEY:"inert",ensureActiveCompany:async()=>{}};' });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (url.pathname === '/pages/login.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>Fixture login</h1>' });
    // Page shell dependencies are outside this queue test. Stub them instead of
    // letting a chrome script make unrelated profile/database requests.
    if (['/v2/v2-shell.js', '/v2/nav-config.js', '/v2/avatar.js', '/v2/silo-chrome.js'].includes(url.pathname)) {
      return route.fulfill({ contentType: 'text/javascript', body: 'window.SiloChrome = {mount(){}};' });
    }
    const allowed = ['v2/platform-admin.html', 'v2/beacon.css', 'v2/silo-brand.css', 'v2/workspace-settings.css', 'v2/platform-admin.css', 'v2/beacon-mirrors-unified.css', 'v2/v2-mobile.css'];
    const relative = url.pathname.slice(1);
    if (!allowed.includes(relative)) { failures.push('Unexpected file: ' + relative); return route.abort(); }
    return route.fulfill({ contentType: relative.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(path.join(root, relative)) });
  });
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('https://get-silo.com/v2/platform-admin.html');
  return { page, context };
}

try {
  const guest = await fixture({ signedIn: false });
  await guest.page.waitForURL('**/pages/login.html?next=*');
  assert.equal(new URL(guest.page.url()).searchParams.get('next'), '/v2/platform-admin.html');
  await guest.context.close(); pass('signed-out admin link preserves the login return path');

  const denied = await fixture({ authorized: false });
  await denied.page.locator('#gate').waitFor({ state: 'visible' });
  assert.equal(await denied.page.locator('#admin').isVisible(), false);
  assert.equal(await denied.page.locator('#btnReload').isVisible(), false);
  assert.equal(await denied.page.evaluate(() => __queueFixture.queries.filter(query => query.table === 'onboarding_interest_queue').length), 0);
  await denied.context.close(); pass('non-platform owner sees the gate and never requests prospect information');

  const admin = await fixture({ rows: [row('fixture-1', { name: malicious, company_name: malicious }),
    ...Array.from({ length: 26 }, (_, i) => row('fixture-' + (i + 2)))] });
  await admin.page.locator('[data-interest-save="fixture-1"]').waitFor();
  assert.equal(await admin.page.locator('#tblInterest [data-interest-row]').count(), 25);
  assert.equal(await admin.page.locator('#tblInterest img').count(), 0);
  // #899 renders the queue as rows of "name · company", not a table.
  assert.equal(await admin.page.locator('#tblInterest [data-interest-row]').first().locator('.plat-inbox-title').textContent(), malicious + ' · ' + malicious);
  assert.equal(await admin.page.evaluate(() => globalThis.fixtureXSS), undefined);
  await admin.page.locator('#interestNext').click();
  await admin.page.waitForFunction(() => document.getElementById('interestPage').textContent === 'Page 2');
  assert.equal(await admin.page.locator('#tblInterest [data-interest-row]').count(), 2);
  assert.equal(await admin.page.locator('#interestNext').isDisabled(), true);
  await admin.page.locator('#interestFilter').selectOption('all');
  await admin.page.waitForFunction(() => document.getElementById('interestPage').textContent === 'Page 1');
  pass('platform queue escapes prospect input, pages in bounded batches and resets pagination on filtering');

  const select = admin.page.locator('[data-interest-status="fixture-1"]');
  const save = admin.page.locator('[data-interest-save="fixture-1"]');
  for (const mode of ['error', 'conflict']) {
    await admin.page.evaluate(mode => { __queueFixture.saveMode = mode; }, mode);
    await select.selectOption('closed'); await save.click();
    await admin.page.waitForFunction(() => !document.querySelector('[data-interest-save="fixture-1"]').disabled);
    assert.equal(await select.inputValue(), 'closed');
    const status = await admin.page.locator('#status').textContent();
    assert.doesNotMatch(status, /private|saved/i);
    assert.match(status, mode === 'error' ? /selection is kept/ : /Reload before trying again/);
  }
  pass('save failures and concurrent status conflicts preserve selection and never show success');

  await admin.page.evaluate(() => { __queueFixture.saveMode = 'success'; __queueFixture.blockSave = true; });
  await select.selectOption('contacted'); await save.click();
  assert.equal(await select.isDisabled(), true); assert.equal(await save.isDisabled(), true);
  assert.equal(await admin.page.locator('#interestFilter').isDisabled(), true);
  await save.dispatchEvent('click');
  assert.equal(await admin.page.evaluate(() => __queueFixture.queries.filter(query => query.update).length), 3);
  await admin.page.evaluate(() => { __queueFixture.blockSave = false; __queueFixture.releaseSave(); });
  await admin.page.waitForFunction(() => document.getElementById('status').textContent === 'Interest status saved.');
  await admin.page.waitForFunction(() => !document.querySelector('[data-interest-status="fixture-1"]').disabled);
  assert.equal(await select.inputValue(), 'contacted');
  const update = await admin.page.evaluate(() => __queueFixture.queries.filter(query => query.update).at(-1));
  assert.deepEqual(update.update, { status: 'contacted' });
  assert.deepEqual(update.filters, [['id', 'fixture-1'], ['status', 'pending']]);
  pass('duplicate save is blocked and the successful write changes only status with optimistic concurrency');

  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await admin.page.setViewportSize({ width, height });
    await admin.page.screenshot({ path: path.join(screenshots, `platform-interest-${name}.png`), fullPage: true });
  }
  assert.deepEqual(await admin.page.evaluate(() => __queueFixture.rpcs.filter(name => /create|revoke|send/.test(name))), []);
  await admin.context.close(); pass('queue updates never create accounts, send messages or issue/revoke invitations');
  assert.deepEqual(failures, [], 'unapproved requests or page errors');
  console.log(`All ${checks.length} platform-interest browser checks passed.`);
} finally { await browser.close(); }
