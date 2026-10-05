#!/usr/bin/env node
/* Build onboarding PDF + HTML from the same data as Integrations setup drawers.
 *
 *   node scripts/build-integration-onboarding-pdf.mjs
 *
 * Writes docs/ops/integration-setup-guides.html always. PDF needs Playwright:
 *   cd tests && npm install && npx playwright install chromium
 *
 * Re-run after changing v2/integration-guides.js and commit both artifacts. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs', 'ops');
const HTML_PATH = join(OUT_DIR, 'integration-setup-guides.html');
const PDF_PATH = join(OUT_DIR, 'integration-setup-guides.pdf');

function loadGuides() {
  const src = readFileSync(join(ROOT, 'v2/integration-guides.js'), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  const G = sandbox.window.SiloIntegrationGuides;
  if (!G) throw new Error('SiloIntegrationGuides missing from integration-guides.js');
  return G;
}

async function loadPlaywright() {
  const paths = [
    join(ROOT, 'tests/node_modules/playwright/index.mjs'),
    join(ROOT, 'v2/tests/node_modules/playwright/index.mjs'),
    'playwright',
  ];
  for (const p of paths) {
    try {
      return await import(p);
    } catch {
      /* try next */
    }
  }
  return null;
}

async function main() {
  const G = loadGuides();
  const generatedOn = new Date().toISOString().slice(0, 10);
  const html = G.renderOnboardingDocument({}, { generatedOn });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(HTML_PATH, html, 'utf8');
  console.log('Wrote', HTML_PATH);

  const pw = await loadPlaywright();
  if (!pw?.chromium) {
    console.warn('Playwright not found — HTML only. Install: cd tests && npm install && npx playwright install chromium');
    return;
  }

  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({
      path: PDF_PATH,
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
    });
    console.log('Wrote', PDF_PATH);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
