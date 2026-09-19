/* Local-only visual fixture server. No real credentials or remote writes.
 * node v2/tests/lib/payments-preview.cjs
 * /v2/billing.html?scenario=active or /v2/invoicing.html?scenario=empty
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, fakeSupabaseScript, CONFIG_STUB } = require('./harness');
const { tables } = require('./payments-fixtures');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/fixture-sdk.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fakeSupabaseScript()); return; }
  if (url.pathname === '/pages/config.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(CONFIG_STUB); return; }
  const file = path.resolve(REPO_ROOT, '.' + url.pathname);
  // Only assets under v2; never serve repo configs, credentials or arbitrary files.
  if (!file.startsWith(path.join(REPO_ROOT, 'v2') + path.sep) || !mime[path.extname(file)] || !fs.existsSync(file)) {
    res.writeHead(404); res.end(); return;
  }
  let source = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.html')) {
    const scenario = url.searchParams.get('scenario') || 'active';
    const broken = scenario === 'error' ? ['stripe_invoices_v', 'billing_subscriptions_v'] : [];
    source = source.replace('<head>', '<head><script>window.__FIXTURE_TABLES__=' + JSON.stringify(tables(scenario))
      + ';window.__FIXTURE_BROKEN__=' + JSON.stringify(broken) + ';</script>')
      .replace(/https:\/\/cdn.jsdelivr.net\/npm\/@supabase\/supabase-js@2/g, '/fixture-sdk.js');
  }
  res.setHeader('Content-Type', mime[path.extname(file)]);
  res.end(source);
}).listen(8765, '0.0.0.0', () => console.log('Synthetic preview: http://localhost:8765/v2/billing.html'));
