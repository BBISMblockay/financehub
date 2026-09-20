// Workspace Settings navigation: one settings area, no duplicate destinations,
// and a platform link that cannot appear for a customer.
//
// What is worth asserting here, and why:
//
//  1. Integrations and Billing are TABS of the settings area and are served by
//     the pages that already existed. If a future edit points either tab at a
//     new route, that is a second implementation of a page the brief says must
//     not be rebuilt -- so the tab hrefs are pinned to those two files.
//  2. The sidebar shows ONE settings row. A row per tab beside a tab strip is
//     two navigations for one place, which is what this work removed.
//  3. 'Silo Admin' is invisible without a resolved platform_admins grant --
//     including when the profile role has not resolved yet, which is the state
//     every deep link starts in and the one `roles` fails OPEN on. A company
//     owner is not a platform admin, so an 'owner' role must not reveal it.
//
// Run: node --test scripts/tests/workspace-settings.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const navSource = await read('v2/nav-config.js');
const stripSource = await read('v2/workspace-settings.js');

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {};
    this.innerHTML = ''; this.textContent = '';
  }
  append(...v) { this.children.push(...v); }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
}

function mountStrip(active) {
  const document = { createElement: (tag) => new Element(tag) };
  const window = {};
  vm.runInNewContext(navSource, { window });
  vm.runInNewContext(stripSource, { window, document });
  let mounted;
  const main = { querySelector: () => mounted, firstElementChild: { after: (n) => { mounted = n; } } };
  window.SiloWorkspaceSettings.mount(main, active);
  return { window, main, nav: mounted, links: mounted ? mounted.children[1].children : [] };
}

const nav = (() => { const w = {}; new Function('window', navSource)(w); return w.SiloNav; })();

test('the five settings tabs are one click apart and the current one is identified', () => {
  const ids = nav.WORKSPACE_SETTINGS_PAGES.map(([id]) => id);
  assert.deepEqual(ids, [
    'settings/company', 'settings/team', 'settings/integrations',
    'settings/billing', 'settings/notifications',
  ]);
  for (const active of ids) {
    const m = mountStrip(active);
    assert.equal(m.links.length, 5);
    assert.equal(m.links.filter((l) => l.attributes['aria-current'] === 'page').length, 1);
    assert.ok(m.links.every((l) => l.href.startsWith('/v2/')));
  }
});

test('Integrations and Billing tabs reuse the existing pages, not new routes', () => {
  const byId = new Map(nav.WORKSPACE_SETTINGS_PAGES.map(([id, , path]) => [id, path]));
  assert.equal(byId.get('settings/integrations'), 'integrations.html');
  assert.equal(byId.get('settings/billing'), 'billing.html');
});

test('the strip is inert on a page that is not a settings tab, and never mounts twice', () => {
  const m = mountStrip('finance/card-coding');
  assert.equal(m.nav, undefined);
  const s = mountStrip('settings/team');
  const first = s.nav;
  s.window.SiloWorkspaceSettings.mount(s.main, 'settings/team');
  assert.equal(s.main.querySelector(), first);
});

test('the sidebar carries ONE settings destination, not one row per tab', () => {
  const sections = nav.navSectionsForProfile('grandfathered', 'finance', 'admin', new Set());
  const settings = sections.find((s) => s.section === 'Settings');
  assert.ok(settings, 'a Settings section exists');
  assert.deepEqual(settings.items.map((i) => i.id), ['settings/workspace']);
  assert.equal(settings.items[0].href, '/v2/settings-company.html');
  // No other section may smuggle a second route to a tab page.
  const hrefs = sections.flatMap((s) => s.items.map((i) => i.href));
  for (const dup of ['/v2/integrations.html', '/v2/billing.html']) {
    assert.equal(hrefs.filter((h) => h === dup).length, 0, `${dup} is reached through the tab strip`);
  }
});

test('Silo Admin needs the platform grant — a role, or an unresolved one, is not enough', () => {
  const ids = (role, grants) => nav.navSectionsForProfile('standard', 'exec', role, grants)
    .flatMap((s) => s.items.map((i) => i.id));

  // The state every deep link starts in: department and role unresolved.
  assert.ok(!ids(null, null).includes('platform/admin'));
  assert.ok(!ids(null, new Set()).includes('platform/admin'));
  // A company owner is not a platform admin.
  assert.ok(!ids('owner', new Set()).includes('platform/admin'));
  assert.ok(!ids('admin', new Set()).includes('platform/admin'));
  // Only the resolved grant reveals it.
  assert.ok(ids('user', new Set(['platform/admin'])).includes('platform/admin'));
  // ...and it must survive the standard-profile section filter, which DROPS
  // any section missing from STANDARD_SECTION_ORDER.
  const sections = nav.navSectionsForProfile('standard', 'exec', 'user', new Set(['platform/admin']));
  assert.ok(sections.some((s) => s.section === 'Platform'));
});

// Every tab page must actually MOUNT the strip, and announce itself with the
// id the strip looks for. A page that forgets one of these renders inside the
// settings area with no way back out of it -- which is what "one coherent
// settings experience" fails to be.
test('every tab page loads the strip and declares its own tab', async () => {
  const files = {
    'settings/company': 'v2/settings-company.html',
    'settings/team': 'v2/settings-team.html',
    'settings/integrations': 'v2/integrations.html',
    'settings/billing': 'v2/billing.html',
    'settings/notifications': 'v2/settings-notifications.html',
  };
  for (const [id, file] of Object.entries(files)) {
    const html = await read(file);
    assert.match(html, /workspace-settings\.css/, `${file} loads the strip stylesheet`);
    assert.match(html, /workspace-settings\.js/, `${file} loads the strip`);
    assert.match(html, /silo-main[^"]*workspace-settings/, `${file} marks its main as a settings workspace`);
    assert.ok(html.includes(`'${id}'`), `${file} mounts SiloChrome with active: ${id}`);
    // nav-config must load before the strip reads SiloNav from it.
    assert.ok(html.indexOf('nav-config.js') < html.indexOf('workspace-settings.js'),
      `${file} loads nav-config.js before workspace-settings.js`);
  }
});

test('the platform row is unlocked by platform_admins and nothing else', () => {
  const item = nav.NAV_ITEMS.find((i) => i.id === 'platform/admin');
  assert.equal(item.grantTable, 'platform_admins');
  assert.equal(item.requiresGrant, true);
  assert.equal(item.href, '/v2/platform-admin.html');
});
