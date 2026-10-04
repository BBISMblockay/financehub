/* Who may see the Integrations settings page.
 *
 * The page used to admit only a profile role of exactly 'owner' or 'admin', so
 * every executive (six active on 2026-10-04, Jon Loomis among them) was refused
 * a page whose data RLS already let them read, while the sidebar offered them
 * the link. The page now asks the database is_admin_user() -- the same check
 * every table on it is gated by -- and falls back to the same role hierarchy
 * only when that call fails. This suite runs the page's own decision function
 * and pins the call. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');
const { REPO_ROOT } = require('../lib/load');

const r = createReporter('integrations-access');
const html = fs.readFileSync(path.join(REPO_ROOT, 'v2', 'integrations.html'), 'utf8');

const match = html.match(/function integrationsAccessAllowed\([^)]*\)\s*\{[\s\S]*?\n    \}/);
r.test('the page defines its access decision as one function', () => r.truthy(match, 'integrationsAccessAllowed not found'));
const allowed = match ? vm.runInNewContext(`(${match[0]})`) : () => { throw new Error('missing'); };
const rpcError = { message: 'network' };

r.test('an executive the database calls admin is allowed', () => r.eq(allowed(true, null, 'executive'), true));
r.test('a membership admin with a plain profile role is allowed', () => r.eq(allowed(true, null, 'user'), true));
r.test('the database answer wins over a profile role that looks senior', () => r.eq(allowed(false, null, 'owner'), false));
r.test('a non-admin is refused', () => r.eq(allowed(false, null, 'user'), false));
r.test('a missing answer is a refusal, not an admission', () => r.eq(allowed(null, null, 'executive'), false));
r.test('when the check cannot be asked, executive still passes', () => r.eq(allowed(null, rpcError, 'executive'), true));
r.test('when the check cannot be asked, a plain user is refused', () => r.eq(allowed(null, rpcError, 'user'), false));

r.test('the page asks is_admin_user() before drawing anything', () => {
  r.has(html, "db.rpc('is_admin_user')");
  r.has(html, 'integrationsAccessAllowed(isAdmin, adminError, profile?.role)');
});
r.test('the old owner/admin-only check is gone', () => {
  r.not(html, "profile?.role !== 'owner' && profile?.role !== 'admin'");
});

const out = r.summary();
process.exit(out.fail ? 1 : 0);
