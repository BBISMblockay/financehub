/* Connected apps: what each AI connection actually did.
 *
 * Every claim on these cards is about someone's data being read, so the three
 * that could be wrong are pinned here: a count taken from a shared slice (a
 * busy connection hiding a quiet one), a card for a company this page cannot
 * see the log of claiming "no calls recorded", and a history button that
 * toggles twice after a cancelled removal. All three shipped live in #1124.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('connect-ai-activity');

const HERE = 'test-company';
const AWAY = 'other-company';
const stamp = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();

const calls = [];
for (let i = 0; i < 25; i++) {
  calls.push({
    id: 'c' + i, grant_id: 'g-busy', tool: 'silo_api_query', scope: 'data:read',
    // Older than a day for all but three, so "in the last day" is its own count.
    created_at: stamp(i < 3 ? i + 1 : 60 * 24 * (i + 1)),
    company_entity_id: HERE,
  });
}
calls.push({ id: 'q1', grant_id: 'g-quiet', tool: 'silo_api_describe_tables', scope: 'data:read',
  created_at: stamp(5), company_entity_id: HERE });
calls.push({ id: 'q2', grant_id: 'g-quiet', tool: 'silo_api_list_reports', scope: 'reports:read',
  created_at: stamp(400), company_entity_id: HERE });
// Nothing for g-away: the log's policy returns only the ACTIVE company's rows,
// so a page in this company cannot see that connection's history at all.

(async () => {
  const suite = await startSuite({ viewport: { width: 1280, height: 1100 }, secureContext: true });

  const page = await suite.open('/v2/settings-connect-ai.html', {
    profiles: [{ id: 'test-user', email: 'test@baseballism.com', role: 'admin' }],
    entities: [{ id: HERE, title: 'Baseballism' }, { id: AWAY, title: 'STLHD' }],
    silo_api_grants: [
      { id: 'g-busy', client_id: 'claude', user_id: 'test-user', company_entity_id: HERE,
        scopes: ['data:read'], consented_at: stamp(60 * 24 * 30), expires_at: null,
        revoked_at: null, last_used_at: stamp(1) },
      { id: 'g-quiet', client_id: 'chatgpt', user_id: 'test-user', company_entity_id: HERE,
        scopes: ['data:read'], consented_at: stamp(60 * 24 * 20), expires_at: null,
        revoked_at: null, last_used_at: stamp(5) },
      { id: 'g-away', client_id: 'grok', user_id: 'test-user', company_entity_id: AWAY,
        scopes: ['data:read'], consented_at: stamp(60 * 24 * 10), expires_at: null,
        revoked_at: null, last_used_at: stamp(90) },
    ],
    silo_api_call_log: calls,
  }, {
    rpc: { silo_api_list_reports: `function () { return { reports: [], company_reports: { count: 0 } }; }` },
    ready: () => !!document.querySelector('.cn-app[data-grant="g-busy"] .cn-activity'),
  });

  const text = async (sel) => (await page.textContent(sel) || '').replace(/\s+/g, ' ').trim();

  /* 1. Counts are counted in the database, per connection. 25 rows exist and
     20 are fetched, so a count read off the fetched slice reads 20. */
  const busy = await text('.cn-app[data-grant="g-busy"] .cn-activity');
  r.ok('the busy connection reports every call it made, not the page\'s row cap',
    /\b25 calls recorded\b/.test(busy));
  r.ok('and counts the last day separately', /3 in the last day/.test(busy));

  /* 2. A quiet connection keeps its own history whatever the busy one did. */
  const quiet = await text('.cn-app[data-grant="g-quiet"] .cn-activity');
  r.ok('the quiet connection still shows its own two calls', /\b2 calls recorded\b/.test(quiet));
  r.ok('and its newest call is its own', /read the table list/.test(quiet));

  /* Structural: each card asked about its own grant, rather than one query for
     the page whose row limit is then shared out. */
  const perGrant = await page.evaluate(() => (window.__QUERIES__ || [])
    .filter((q) => q.table === 'silo_api_call_log')
    .map((q) => (q.filters || []).filter((f) => f.col === 'grant_id').map((f) => f.val).join(''))
    .filter(Boolean));
  r.ok('the log is read per connection', perGrant.includes('g-busy') && perGrant.includes('g-quiet'));
  r.ok('and never for a connection in another company', !perGrant.includes('g-away'));

  /* 3. The other company's card must not claim the connection did nothing. */
  const away = await text('.cn-app[data-grant="g-away"] .cn-activity');
  r.ok('a card outside the active company says activity is per company',
    /recorded per company/.test(away) && /STLHD/.test(away));
  r.ok('and never claims there were no calls', !/No calls recorded/.test(away));

  /* 4. Show calls opens once, and still opens after a cancelled removal. */
  await page.click('.cn-app[data-grant="g-busy"] [data-activity]');
  const shown = await page.locator('.cn-app[data-grant="g-busy"] .cn-calls-table tr').count();
  r.test('Show calls lists the 20 most recent', () => r.eq(shown, 20));
  const note = await text('.cn-app[data-grant="g-busy"] .cn-note');
  r.ok('and says it is a window onto more', /20 most recent of 25/.test(note));
  r.ok('and still says refusals are not listed', /refused is not listed/.test(note));

  await page.click('.cn-app[data-grant="g-busy"] [data-activity]');   // hide
  await page.click('.cn-app[data-grant="g-busy"] [data-ask]');        // Remove
  await page.click('.cn-app[data-grant="g-busy"] [data-cancel]');     // Keep
  await page.click('.cn-app[data-grant="g-busy"] [data-activity]');
  const visible = await page.isVisible('.cn-app[data-grant="g-busy"] .cn-calls');
  r.ok('after cancelling a removal, Show calls still opens the history once', visible);

  const shot = process.env.CONNECT_AI_SHOT || '/opt/cursor/artifacts/connect-ai-activity.png';
  try { await page.screenshot({ path: shot, fullPage: true }); }
  catch (_) { console.log('  note: screenshot not written (' + shot + ')'); }

  await suite.close();
  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})().catch((e) => {
  console.log('  FAIL suite crashed\n        ' + (e && e.message ? e.message : String(e)));
  r.summary();
  process.exit(1);
});
