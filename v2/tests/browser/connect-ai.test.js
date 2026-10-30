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
    profiles: [{ id: 'test-user', email: 'test@baseballism.com', role: 'admin' }],
  }, {
    rpc: {
      silo_api_list_reports: `function () {
        return {
          reports: [
            { title: 'Daily sales' },
            { title: 'Open work' },
            { title: 'Launches next 30 days' },
          ],
          company_reports: { count: 2 },
        };
      }`,
    },
    ready: () => !!document.querySelector('.ca-row[data-client="claude"]'),
  });

  await page.waitForFunction(() => document.getElementById('mcpUrl').value.startsWith('https://'));
  const url = await page.inputValue('#mcpUrl');
  r.test('shows the address the server advertises, not the derived default',
    () => r.eq(url, 'https://api.get-silo.com/functions/v1/mcp'));

  r.ok('one row per app, each with its own mark',
    (await page.locator('.ca-row .ca-row-mark svg').count()) === 7);
  r.ok('no tabs to click through', (await page.locator('.ca-app, .ca-pane').count()) === 0);

  /* The rows are drawn before the address resolves, so the resolved value has
     to be painted back into them. */
  const rowCopy = await page.getAttribute('.ca-row[data-client="claude"] [data-copy]', 'data-copy');
  r.test('a row\'s copy button is repainted with the resolved address',
    () => r.eq(rowCopy, 'https://api.get-silo.com/functions/v1/mcp'));

  const cmd = await page.getAttribute('.ca-row[data-client="claude-code"] [data-copy]', 'data-copy');
  r.test('Claude Code command carries the resolved address',
    () => r.eq(cmd, 'claude mcp add --transport http silo --scope user https://api.get-silo.com/functions/v1/mcp'));
  const href = await page.getAttribute('.ca-row[data-client="cursor"] a.bcn-btn', 'href');
  const cfgParam = decodeURIComponent(String(href).split('config=')[1] || '');
  const decoded = JSON.parse(Buffer.from(cfgParam, 'base64').toString('utf8'));
  r.ok('Cursor deeplink uses the documented scheme',
    String(href).startsWith('cursor://anysphere.cursor-deeplink/mcp/install?name=silo&config='));
  r.test('Cursor deeplink config is base64 JSON naming the server',
    () => r.eq(decoded.url, 'https://api.get-silo.com/functions/v1/mcp'));

  /* The command lives only in a data attribute now, so a refused clipboard
     must put it on screen -- otherwise "select the text and copy it" points at
     nothing. Review cycle 1 on #1075. */
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
  });
  await page.click('.ca-row[data-client="claude-code"] [data-copy]');
  const fallback = await page.inputValue('.ca-row[data-client="claude-code"] .ca-fallback');
  r.test('a refused copy shows the command to copy by hand',
    () => r.eq(fallback, 'claude mcp add --transport http silo --scope user https://api.get-silo.com/functions/v1/mcp'));
  const warned = await page.textContent('#status');
  r.ok('and says so', /copy by hand/.test(warned));

  const grokHref = await page.getAttribute('.ca-row[data-client="grok"] a.bcn-btn', 'href');
  r.test('Grok points at its own connectors page, not a made-up install link',
    () => r.eq(grokHref, 'https://grok.com/connectors'));
  const grokSteps = await page.textContent('.ca-row[data-client="grok"]');
  r.ok('and says why the API path is not the one offered',
    /does not issue/.test(grokSteps));

  const vs = await page.getAttribute('.ca-row[data-client="vscode"] a.bcn-btn', 'href');
  const vsCfg = JSON.parse(decodeURIComponent(String(vs).split('config=')[1] || ''));
  r.test('VS Code link declares an http server', () => r.eq(vsCfg.type, 'http'));
  r.test('VS Code link carries the resolved address',
    () => r.eq(vsCfg.url, 'https://api.get-silo.com/functions/v1/mcp'));

  const summary = await page.textContent('#reportsSummary');
  r.ok('report count comes from silo_api_list_reports, not a constant',
    /^3 SILO reports/.test(summary.trim()) && /2 saved company reports/.test(summary));
  const scopeSub = await page.textContent('#scopeSub');
  r.ok('access subtitle reflects catalog plus data scope', /3 SILO reports/.test(scopeSub) && /read-only data/.test(scopeSub));
  const scopes = await page.locator('#scopeList li').count();
  r.ok('lists both SILO scopes an approved app gets', scopes === 2);
  const heroNote = await page.textContent('#heroMfaNote');
  r.ok('hero tells you to turn on two-step login in My profile before connecting',
    /My profile/.test(heroNote) && /before you connect/i.test(heroNote));
  const heroTitle = await page.getAttribute('#heroMfaNote', 'title');
  r.ok('hero tooltip points at profile two-step login setup', /Two-step login/i.test(heroTitle || ''));

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
