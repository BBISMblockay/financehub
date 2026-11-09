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
 */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const assert = require('node:assert/strict');
const R = createReporter('integrations-klaviyo-card');

const MUTATIONS = {
  'no-found': ['if (found) renderKlaviyoConnection(data, found);', ''],
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
  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
