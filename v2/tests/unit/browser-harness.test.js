'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { fakeSupabaseScript } = require('../lib/harness');

// Compile the exact served script: malformed injected methods must fail here,
// not surface later as a page-readiness timeout in every browser consumer.
const script = new vm.Script(fakeSupabaseScript(), { filename: 'fake-supabase.js' });
const sandbox = { window: {} };
script.runInNewContext(sandbox);
const client = sandbox.window.supabase.createClient();
assert.equal(typeof client.auth.getUser, 'function');
assert.equal(typeof client.auth.signOut, 'function');
const subscription = client.auth.onAuthStateChange(() => {});
assert.equal(typeof subscription.data.subscription.unsubscribe, 'function');
subscription.data.subscription.unsubscribe();
console.log('PASS served Supabase fixture parses and provides the auth subscription contract');

(async () => {
  const rows = [
    {id:1, context:'schedules:prepaid:2026-11'},
    {id:2, context:'Schedules:prepaid:2026-11'},
    {id:3, context:'fixed.assets:2026-11'},
    {id:4, context:'fixedXassets:2026-11'},
    {id:5, context:'literal_%'},
    {id:6, context:null}
  ];
  sandbox.window.__FIXTURE_TABLES__ = { entries: rows };
  async function ids(pattern) {
    const {data} = await client.from('entries').select('*').like('context',pattern);
    return Array.from(data, r => r.id);
  }
  assert.deepEqual(await ids('schedules:prepaid:%'), [1], 'LIKE is case-sensitive and supports suffix wildcard');
  assert.deepEqual(await ids('fixed.assets:%'), [3], 'Regex punctuation is literal');
  assert.deepEqual(await ids('fixed_assets:%'), [3,4], 'Underscore matches exactly one character');
  assert.deepEqual(await ids('%2026-11'), [1,2,3,4], 'Prefix wildcard matches');
  assert.deepEqual(await ids('literal\\_\\%'), [5], 'Escaped SQL wildcards are literal');
  assert.deepEqual(await ids('%'), [1,2,3,4,5], 'NULL does not match LIKE');
  assert.deepEqual(await ids('prepaid'), [], 'Patterns are anchored');
  const {data} = await client.from('entries').select('*').like('absent_column','anything');
  assert.equal(data.length, rows.length, 'Absent fixture columns follow existing harness filter semantics');
  console.log('PASS served Supabase fixture applies case-sensitive SQL LIKE filters');
})().catch(error => { console.error(error); process.exitCode = 1; });
