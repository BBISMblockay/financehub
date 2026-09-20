import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('login presents SILO rather than Baseballism-specific instructions', async () => {
  const html = await read('pages/login.html');
  assert.doesNotMatch(html, /Baseballism operations|you@baseballism\.com|© Baseballism/);
  assert.match(html, /Finish company setup/);
  assert.match(html, /Create your owner account/);
});

test('customer-facing settings do not link to implementation docs or expose secret names', async () => {
  const integrations = await read('v2/integrations.html');
  const notifications = await read('v2/settings-notifications.html');
  assert.doesNotMatch(integrations, /docs\/ops\/stripe\.md/);
  assert.doesNotMatch(notifications, /SILO_MAIL_FROM|edge-function secret|comp-request-notify|sample-notify/);
});

test('Baseballism vendor seeds are applied only to the Baseballism company', async () => {
  const html = await read('v2/purchase_request.html');
  assert.match(html, /const BASEBALLISM_VENDORS = \[/);
  assert.match(html, /_co\?\.entity_key === 'baseballism' \? BASEBALLISM_VENDORS : \[\]/);
  assert.doesNotMatch(html, /\[\.\.\.priorVendors, \.\.\.VENDORS\]/);
});

test('shared chrome displays friendly workspace roles without storage jargon', async () => {
  const source = await read('v2/silo-chrome.js');
  assert.match(source, /owner_admin: 'Owner'/);
  assert.match(source, /from\('entity_memberships'\)/);
  assert.doesNotMatch(source, /RLS ·|· RLS/);
});

test('standard home hides Baseballism team workflows and links Customers', async () => {
  const html = await read('v2/finance.html');
  assert.match(html, /href="\/v2\/customers\.html">Customers<\/a>/);
  assert.match(html, /data-nav-profile="grandfathered">\s*<div class="fin-card-head"><h2>Team<\/h2>/);
});
