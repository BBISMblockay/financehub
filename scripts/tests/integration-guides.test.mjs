/* Integration setup guides (v2/integration-guides.js).
 *
 * Proven:
 *   1. The Shopify own-app guide lists PUBLIC_SCOPES plus read_all_orders -- shopify-connect-dev-app
 *      refuses a token missing one, so a guide that drifts walks a store owner
 *      into a refusal.
 *   2. Every guide renders, has numbered steps, and links only to https.
 *   3. A live ctx value (Redo's webhook URL) becomes a copy chip and never
 *      reaches the HTML unescaped; without ctx there is no chip at all.
 *   4. Integrations loads the module and its CSS, and every data-guide on the
 *      page names a guide that exists.
 *
 * Run: node scripts/tests/integration-guides.test.mjs
 * Mutations: GUIDES_MUTATION=scope-drift (a Shopify scope dropped),
 * no-pages-show-list and no-all-orders must each fail. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PUBLIC_SCOPES } from '../lib/shopify-auth-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const mutation = process.env.GUIDES_MUTATION || '';
assert.ok(['', 'scope-drift', 'no-pages-show-list', 'no-all-orders'].includes(mutation), `Unknown mutation ${mutation}`);

let src = read('v2/integration-guides.js');
if (mutation === 'scope-drift') src = src.replace("    'read_publications',\n", '');
if (mutation === 'no-all-orders') src = src.replace(".concat(['read_all_orders'])", '');
if (mutation === 'no-pages-show-list') src = src.replace("['pages_show_list', ", '[');
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const G = sandbox.window.SiloIntegrationGuides;
assert.ok(G, 'window.SiloIntegrationGuides defined');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };

t('Shopify scopes equal PUBLIC_SCOPES', () => {
  assert.deepEqual([...G.SHOPIFY_SCOPES].sort(), [...PUBLIC_SCOPES].sort());
  for (const s of PUBLIC_SCOPES) assert.ok(G.SHOPIFY_OWN_APP_SCOPES.includes(s), `own-app route includes ${s}`);
});

t('Meta organic scopes include pages_show_list (Test lists Pages via /me/accounts)', () => {
  for (const s of ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_manage_insights']) {
    assert.ok(G.META_ORGANIC_SCOPES.includes(s), `organic scope ${s}`);
  }
  const extra = G.resolve('meta_ads', {}).extra.steps[0];
  assert.ok(extra.scopes.includes('pages_show_list'), 'the guide step shows it');
});

t('every guide renders with steps and https-only links', () => {
  for (const key of G.keys()) {
    const g = G.resolve(key, {});
    assert.ok(g.title && g.summary && g.steps.length >= 3, `${key} has content`);
    const html = G.render(key, {});
    assert.ok(html.includes('class="ig-steps"'), `${key} renders steps`);
    for (const m of html.matchAll(/href="([^"]+)"/g)) assert.match(m[1], /^https:\/\//, `${key} link ${m[1]}`);
    const all = g.steps.concat(g.extra ? g.extra.steps : []);
    for (const s of all) if (s.link) assert.match(s.link.href, /^https:\/\//);
  }
  assert.equal(G.render('nope', {}), '');
  assert.equal(G.resolve('nope'), null);
});

t('the own-app route asks for read_all_orders (full history backfill)', () => {
  assert.deepEqual([...G.SHOPIFY_OWN_APP_SCOPES].sort(), [...PUBLIC_SCOPES, 'read_all_orders'].sort());
  const step = G.resolve('shopify_dev_app', {}).steps.find((s) => s.copy);
  assert.ok(step.scopes.includes('read_all_orders'), 'listed in the step');
  assert.ok(step.copy[0].value.split(',').includes('read_all_orders'), 'in Copy all scopes');
  const page = read('v2/integrations.html');
  assert.match(page, /historyDays > 60 && granted\.length && !granted\.includes\('read_all_orders'\)/, 'import warns first');
});

t('ctx values are copy chips, escaped, and absent without ctx', () => {
  const evil = 'https://x.supabase.co/functions/v1/redo-webhook/"><img src=x onerror=alert(1)>';
  const html = G.render('redo', { redoWebhookUrl: evil });
  assert.ok(!html.includes('<img'), 'no raw markup from ctx');
  assert.ok(Object.values(G.copyValues('redo', { redoWebhookUrl: evil })).includes(evil));
  assert.deepEqual(Object.keys(G.copyValues('redo', {})), []);
  assert.ok(!G.render('redo', {}).includes('data-copy'));
});

t('Integrations loads the guides and every opener names a real guide', () => {
  const page = read('v2/integrations.html');
  assert.ok(page.includes('<script src="integration-guides.js"></script>'));
  assert.ok(page.includes('href="integration-guides.css"'));
  const keys = [...page.matchAll(/data-guide="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 5, 'openers present');
  for (const k of keys) assert.ok(G.GUIDES[k], `guide ${k} exists`);
  for (const k of ['shopify_dev_app', 'shopify_token', 'meta_ads', 'redo']) assert.ok(keys.includes(k), `${k} reachable`);
});

console.log(`\n${passed} passed`);
