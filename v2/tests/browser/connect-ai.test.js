/* Connect AI (Workspace settings): the server address, the per-client setup
   panes and the live report count. */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('connect-ai');

(async () => {
  const suite = await startSuite({ viewport: { width: 1280, height: 1000 }, secureContext: true });

  /* The page asks the MCP server what it calls itself. Answered here with a
     custom domain, which is the case the derived default gets WRONG -- so
     every address and command on the page should carry this, not the
     localhost default. */
  await suite.context.route('**/functions/v1/mcp/.well-known/oauth-protected-resource', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ resource: 'https://api.get-silo.com/functions/v1/mcp' }),
  }));

  const page = await suite.open('/v2/settings-connect-ai.html', {
    silo_chat_saved_reports_v: [
      { title: 'Daily sales', source: 'system', archived_at: null },
      { title: 'Open work', source: 'system', archived_at: null },
      { title: 'Launches next 30 days', source: 'system', archived_at: null },
    ],
    profiles: [{ id: 'test-user', email: 'test@baseballism.com', role: 'admin' }],
  }, {
    ready: () => !!document.querySelector('.ca-pane[data-client="claude"]'),
  });

  await page.waitForFunction(() => document.getElementById('mcpUrl').value.startsWith('https://'));
  const url = await page.inputValue('#mcpUrl');
  r.test('shows the address the server advertises, not the derived default',
    () => r.eq(url, 'https://api.get-silo.com/functions/v1/mcp'));

  r.ok('each app is a card with its own mark, not a table row',
    (await page.locator('.ca-app svg, .ca-app .app-mark-letter').count()) === 7);

  r.ok('starts on the Claude pane',
    !(await page.locator('.ca-pane[data-client="claude"][hidden]').count()));

  /* The panes are drawn before the address resolves, so the resolved value has
     to be painted back into them. Read WITHOUT clicking a tab first -- a click
     redraws them and would hide the bug. */
  const paneCopy = await page.getAttribute('.ca-pane[data-client="claude"] [data-copy]', 'data-copy');
  r.test('the pane\'s copy button is repainted with the resolved address',
    () => r.eq(paneCopy, 'https://api.get-silo.com/functions/v1/mcp'));

  await page.click('.ca-app[data-client="claude-code"]');
  const cmd = await page.inputValue('.ca-pane[data-client="claude-code"] input');
  r.test('Claude Code command carries the resolved address',
    () => r.eq(cmd, 'claude mcp add --transport http silo --scope user https://api.get-silo.com/functions/v1/mcp'));
  r.ok('switching tabs hides the previous pane',
    (await page.locator('.ca-pane[data-client="claude"][hidden]').count()) === 1);

  await page.click('.ca-app[data-client="cursor"]');
  const href = await page.getAttribute('.ca-pane[data-client="cursor"] a.bcn-btn', 'href');
  const cfgParam = decodeURIComponent(String(href).split('config=')[1] || '');
  const decoded = JSON.parse(Buffer.from(cfgParam, 'base64').toString('utf8'));
  r.ok('Cursor deeplink uses the documented scheme',
    String(href).startsWith('cursor://anysphere.cursor-deeplink/mcp/install?name=silo&config='));
  r.test('Cursor deeplink config is base64 JSON naming the server',
    () => r.eq(decoded.url, 'https://api.get-silo.com/functions/v1/mcp'));

  await page.click('.ca-app[data-client="grok"]');
  const grokHref = await page.getAttribute('.ca-pane[data-client="grok"] a.bcn-btn', 'href');
  r.test('Grok points at its own connectors page, not a made-up install link',
    () => r.eq(grokHref, 'https://grok.com/connectors'));
  // The <ol> in the steps closes the <p> the browser put it in, so read the pane.
  const grokSteps = await page.textContent('.ca-pane[data-client="grok"]');
  r.ok('and says why the API path is not the one offered',
    /does not issue one/.test(grokSteps));

  await page.click('.ca-app[data-client="vscode"]');
  const vs = await page.getAttribute('.ca-pane[data-client="vscode"] a.bcn-btn', 'href');
  const vsCfg = JSON.parse(decodeURIComponent(String(vs).split('config=')[1] || ''));
  r.test('VS Code link declares an http server', () => r.eq(vsCfg.type, 'http'));
  r.test('VS Code link carries the resolved address',
    () => r.eq(vsCfg.url, 'https://api.get-silo.com/functions/v1/mcp'));

  const summary = await page.textContent('#reportsSummary');
  r.ok('report count comes from the catalog, not a constant', /^3 reports/.test(summary.trim()));

  await page.click('.ca-app[data-client="claude"]');
  // Reviewing this page is largely looking at it, so leave a shot behind --
  // but a shot that cannot be written (a CI runner has no /opt/cursor) must
  // not be the thing that fails the suite.
  const shot = process.env.CONNECT_AI_SHOT || '/opt/cursor/artifacts/connect-ai.png';
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
