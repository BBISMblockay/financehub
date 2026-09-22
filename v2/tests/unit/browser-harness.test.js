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
