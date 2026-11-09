/* The Klaviyo card on the real Integrations page says what the sync found.
 *
 * Why this suite exists: a connected account with no sends yet (a new
 * account, or a Klaviyo test account during app review) shows nothing
 * anywhere else, and a card that just says "synced" reads as a sync that did
 * nothing. The card counts what the sync stored -- campaigns, flow messages,
 * lists and segments -- and says so.
 *
 * Mutations (each must fail at least one assertion):
 *   KLAVIYO_CARD_MUTATION=no-found     the card stops saying what was synced
 *   KLAVIYO_CARD_MUTATION=hard-count   a failed audience count hides the whole line
 *   KLAVIYO_CARD_MUTATION=redraw       the counts redraw the whole row, losing what the admin typed
 */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const assert = require('node:assert/strict');
const R = createReporter('integrations-klaviyo-card');

const MUTATIONS = {
  'no-found': ['if (found && slot && load === _klaviyoLoad) {', 'if (false) {'],
  'redraw': ["        const slot = document.querySelector('[data-klaviyo-found]');", "        renderKlaviyoConnection(data);\n        const slot = document.querySelector('[data-klaviyo-found]');"],
  'hard-count': ["count('klaviyo_audiences').catch(() => null),", "count('klaviyo_audiences'),"],
};
const MUT = process.env.KLAVIYO_CARD_MUTATION || '';
assert.ok(!MUT || MUTATIONS[MUT], `Unknown mutation ${MUT}`);
const transform = (rel, source) => {
  if (!MUT || !rel.endsWith('/integrations.html')) return source;
  const [from, to] = MUTATIONS[MUT];
  assert.ok(source.includes(from), `mutation ${MUT}: pattern missing`);
  return source.split(from).join(to);
};

(async () => {
  const suite = await startSuite({ transform });
  try {
    const co = 'test-company';
    const tables = {
      klaviyo_connections: [{
        id: 'kc1', company_entity_id: co, display_name: 'Klaviyo', auth_mode: 'oauth', is_active: true, sync_enabled: true,
        klaviyo_account_id: 'ACC1', klaviyo_account_name: 'Test account', account_timezone: 'America/Los_Angeles',
        conversion_metric_id: 'MET1', conversion_metric_name: 'Placed Order', last_tested_at: new Date().toISOString(),
        last_test_success: true, last_synced_at: new Date().toISOString(),
      }],
      // Two campaigns and no flows, as a fresh test account has.
      klaviyo_messages: [
        { company_entity_id: co, kind: 'campaign', klaviyo_id: 'c1' },
        { company_entity_id: co, kind: 'campaign', klaviyo_id: 'c2' },
        { company_entity_id: 'other-company', kind: 'campaign', klaviyo_id: 'x9' },
      ],
      klaviyo_audiences: [
        { company_entity_id: co, kind: 'list', klaviyo_id: 'L1' },
        { company_entity_id: co, kind: 'segment', klaviyo_id: 'S1' },
      ],
    };
    const found = () => document.querySelector('[data-klaviyo-found]')?.textContent || '';
    const ready = () => !!document.querySelector('#klaviyo-connections-list button');

    const page = await suite.open('/v2/integrations.html', tables, { ready, rpc: { is_admin_user: true } });
    await page.waitForFunction(() => !!document.querySelector('[data-klaviyo-found]'), null, { timeout: 8000 }).catch(() => {});
    const line = await page.evaluate(found);
    R.has(line, '2 campaigns', 'the card says what the sync stored');
    R.has(line, '0 flow messages', 'zero is said, not hidden: it is a real count');
    R.has(line, '2 lists & segments');
    await page.close();

    // klaviyo_audiences unreadable (migration not applied, or any error):
    // the rest of the line still shows.
    const bare = await suite.open('/v2/integrations.html', tables, { ready, rpc: { is_admin_user: true }, broken: ['klaviyo_audiences'] });
    await bare.waitForFunction(() => !!document.querySelector('[data-klaviyo-found]'), null, { timeout: 8000 }).catch(() => {});
    const bareLine = await bare.evaluate(found);
    R.has(bareLine, '2 campaigns', 'one failed count must not hide the others');
    R.not(bareLine, 'lists');
    await bare.close();

    // The counts arrive while an admin is already typing a replacement key.
    // They go into their own line; the row, and what was typed, survive.
    const keyed = { ...tables, klaviyo_connections: [{ ...tables.klaviyo_connections[0], auth_mode: 'api_key' }] };
    const slow = await suite.open('/v2/integrations.html', keyed, { ready, rpc: { is_admin_user: true }, gateTables: ['klaviyo_messages'] });
    const keyInput = slow.locator('#klaviyo-connections-list input[type="password"]');
    await keyInput.fill('pk_typed_not_saved_yet');
    await slow.evaluate(() => { document.querySelector('#klaviyo-connections-list tr').dataset.probe = 'kept'; });
    R.eq(await slow.evaluate(found), '', 'the counts are still in flight');
    await slow.evaluate(() => window.__RELEASE_TABLE__('klaviyo_messages'));
    await slow.waitForFunction(() => !!document.querySelector('[data-klaviyo-found]')?.textContent, null, { timeout: 8000 }).catch(() => {});
    R.has(await slow.evaluate(found), '2 campaigns');
    R.eq(await slow.evaluate(() => document.querySelector('#klaviyo-connections-list tr')?.dataset.probe || null), 'kept',
      'the counts must not redraw the row');
    R.eq(await keyInput.inputValue(), 'pk_typed_not_saved_yet', 'a key being typed must survive the counts arriving');
    await slow.close();
  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
