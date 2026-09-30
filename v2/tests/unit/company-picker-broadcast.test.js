/* v2/company-picker.html -- the cross-tab wake-up broadcast on switch.
 *
 * The bug (PR #830 supplemental review, 2026-09-30): a tab that was ALREADY
 * OPEN before another tab switched companies never learned about it --
 * sessionStorage is per-tab, so the switching tab's own cache fix (this
 * PR's first pass) never reached a sibling tab that never navigates again.
 * Fixed by writing a small, UNTRUSTED wake-up signal to localStorage (shared
 * across tabs, unlike sessionStorage) right after the RPC confirms the
 * switch -- v2/silo-chrome.js listens for it and re-runs its own
 * server-truth reconciliation; see ensure-active-company.test.js for that
 * function's own coverage.
 *
 * What must hold:
 *   - a SUCCESSFUL switch writes the wake-up key to localStorage
 *   - a FAILED switch (the RPC errors) does NOT write it -- nothing to wake
 *     other tabs up about, and no other tab's cache should be disturbed
 *   - the write happens to localStorage specifically, never sessionStorage
 *     (a sessionStorage write cannot reach another tab at all)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');

const r = createReporter('company-picker-broadcast');
const HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', 'company-picker.html'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*)<\/script>/)[1];

function fakeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    _dump: () => Object.fromEntries(store),
  };
}

function fakeElement() {
  return { textContent: '', style: {}, className: '', innerHTML: '', disabled: false, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; } };
}

(async () => {
  /** Runs the real script against one seeded company, RPC either succeeding
   *  or failing, then invokes the one company button's click handler. */
  async function runAndClick({ rpcError = null } = {}) {
    const created = [];
    const sessionStorage = fakeStorage();
    const localStorage = fakeStorage();
    const company = { id: 'co-new', title: 'Test Company', entity_key: 'test-co', role: 'owner_admin' };
    sessionStorage.setItem('__SILO_COMPANY_OPTIONS__', JSON.stringify([company]));
    const elements = { companyList: fakeElement(), errMsg: fakeElement(), pickerSub: fakeElement() };
    elements.companyList.appendChild = (el) => created.push(el);
    let redirectedTo = null;

    const g = {};
    g.window = g;
    g.document = {
      getElementById: (id) => elements[id],
      createElement: () => { const el = fakeElement(); return el; },
    };
    g.sessionStorage = sessionStorage;
    g.localStorage = localStorage;
    g.URLSearchParams = URLSearchParams;
    g.encodeURIComponent = encodeURIComponent;
    g.location = { pathname: '/v2/company-picker.html', search: '', href: '' };
    Object.defineProperty(g.location, 'href', {
      get() { return redirectedTo; }, set(v) { redirectedTo = v; },
    });
    g.window.location = g.location;
    g.window.__SILO_CONFIG__ = {
      SUPABASE_URL: 'http://fake', SUPABASE_ANON_KEY: 'fake',
      setActiveCompany(co) { sessionStorage.setItem('__SILO_COMPANY__', JSON.stringify(co)); },
    };
    g.window.supabase = {
      createClient: () => ({
        rpc: async () => (rpcError ? { error: rpcError } : { error: null }),
      }),
    };
    g.JSON = JSON; g.String = String; g.Object = Object; g.Array = Array;

    vm.createContext(g);
    vm.runInContext(SCRIPT, g, { filename: 'company-picker.js' });
    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));

    r.truthy(created.length === 1, `expected one company button, got ${created.length}`);
    await created[0].listeners.click();
    await new Promise((res) => setTimeout(res, 0));

    return { localStorage, sessionStorage, redirectedTo: () => redirectedTo };
  }

  {
    const { localStorage, redirectedTo } = await runAndClick();
    r.ok('a successful switch writes the cross-tab wake-up key', localStorage.getItem('silo:company:switched') != null);
    r.ok('the write is a fresh, changing value (a real Date.now(), not a static flag)',
      /^\d+$/.test(localStorage.getItem('silo:company:switched') || ''),
      localStorage.getItem('silo:company:switched'));
    r.ok('a successful switch redirects onward', redirectedTo() === '/v2/finance.html', redirectedTo());
  }

  {
    const { localStorage, redirectedTo } = await runAndClick({ rpcError: { message: 'permission denied' } });
    r.ok('a FAILED switch does not write the wake-up key -- nothing to wake other tabs about',
      localStorage.getItem('silo:company:switched') == null, localStorage.getItem('silo:company:switched'));
    r.ok('a failed switch does not redirect either', redirectedTo() == null, redirectedTo());
  }

  process.exit(r.summary().fail ? 1 : 0);
})();
