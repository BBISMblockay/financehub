/* Connected apps: the per-connection writing switch.
 *
 * work:write is the one permission that lets an application change something,
 * so the card has to say which connections have it and let the person switch
 * it off without disconnecting the application (scopes are frozen on the grant
 * row, deliberately, so pausing is a column of its own).
 *
 * Asserted against the real page:
 *   1. a read-only connection says nothing about writing -- no switch to
 *      wonder about, nothing implying it could write
 *   2. a connection WITH work:write says what it can and cannot do, and offers
 *      "Pause writing"
 *   3. a paused one says so, still reads, and offers "Allow writing"
 *   4. the switch calls silo_api_set_writes_paused for THAT grant
 *   5. the granted-permission list names writing
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('connect-ai-writes');

const HERE = 'test-company';
const stamp = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();

(async () => {
  const suite = await startSuite({ viewport: { width: 1280, height: 1100 }, secureContext: true });
  try {
    const page = await suite.open('/v2/settings-connect-ai.html', {
      profiles: [{ id: 'test-user', email: 'test@baseballism.com', role: 'admin' }],
      entities: [{ id: HERE, title: 'Baseballism' }],
      silo_api_grants: [
        { id: 'g-read', client_id: 'chatgpt', user_id: 'test-user', company_entity_id: HERE,
          scopes: ['reports:read', 'data:read'], consented_at: stamp(60), expires_at: null,
          revoked_at: null, last_used_at: stamp(5), writes_paused_at: null },
        { id: 'g-write', client_id: 'claude', user_id: 'test-user', company_entity_id: HERE,
          scopes: ['reports:read', 'data:read', 'work:write'], consented_at: stamp(60), expires_at: null,
          revoked_at: null, last_used_at: stamp(2), writes_paused_at: null },
        { id: 'g-paused', client_id: 'grok', user_id: 'test-user', company_entity_id: HERE,
          scopes: ['data:read', 'work:write'], consented_at: stamp(60), expires_at: null,
          revoked_at: null, last_used_at: stamp(9), writes_paused_at: stamp(30) },
      ],
      silo_api_call_log: [],
    }, {
      rpc: {
        silo_api_list_reports: `function () { return { reports: [], company_reports: { count: 0 } }; }`,
        silo_api_set_writes_paused: `function (args) {
          window.__PAUSE_CALLS__ = (window.__PAUSE_CALLS__ || []).concat([args]);
          return true;
        }`,
      },
      ready: () => !!document.querySelector('.cn-app[data-grant="g-write"] [data-writes]'),
    });

    const text = async (sel) => (await page.textContent(sel) || '').replace(/\s+/g, ' ').trim();
    const card = (id) => '.cn-app[data-grant="' + id + '"]';

    // ── 1: a read-only connection ───────────────────────────────────────
    r.test('a read-only connection is not offered a writing switch', async () => {});
    r.eq(await page.locator(card('g-read') + ' [data-writes]').count(), 0, 'no switch');
    r.ok('and says nothing about opening tasks',
      !/open tasks/i.test(await text(card('g-read'))));

    // ── 2: one that can write ───────────────────────────────────────────
    const w = await text(card('g-write'));
    r.test('a connection with work:write says what it can and cannot do', async () => {});
    r.ok('it says it can open tasks here', /can open tasks in this company/i.test(w));
    r.ok('and that it cannot change what exists', /cannot change anything that exists/i.test(w));
    r.has(await text(card('g-write') + ' [data-writes]'), 'Pause writing', 'and offers to switch it off');

    // ── 3: a paused one ─────────────────────────────────────────────────
    const p = await text(card('g-paused'));
    r.test('a paused connection says so, and still reads', async () => {});
    r.ok('it says writing is paused', /writing paused/i.test(p));
    r.ok('and that reading is unaffected', /still read/i.test(p));
    r.has(await text(card('g-paused') + ' [data-writes]'), 'Allow writing', 'and offers to switch it back on');

    // ── 4: the switch ───────────────────────────────────────────────────
    await page.click(card('g-write') + ' [data-writes]');
    await page.waitForFunction(() => (window.__PAUSE_CALLS__ || []).length > 0, { timeout: 10000 });
    const sent = await page.evaluate(() => window.__PAUSE_CALLS__);
    r.test('the switch pauses that connection and no other', async () => {});
    r.eq(sent, [{ p_grant_id: 'g-write', p_paused: true }], 'the grant it was clicked on, switched off');

    // ── 5: the page's list of what a connection can be given ────────────
    const scopes = await text('#scopeList');
    r.test('writing is listed as something a connection can be granted', async () => {});
    r.ok('and named as the optional one', /Open tasks/.test(scopes) && /tick it/.test(scopes));
  } catch (err) {
    r.ok('suite ran without throwing', false, err && err.stack);
  } finally {
    await suite.close();
  }
  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})();
