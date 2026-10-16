/* Ask SILO empty state: categorized example prompts (filter, copy, send). */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('ask-silo-prompt-index');

(async () => {
  const suite = await startSuite({ viewport: { width: 1280, height: 900 }, secureContext: true });
  const sent = [];
  await suite.context.route('**/functions/v1/silo-chat', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    sent.push(body);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ answer: 'Stub answer for prompt index test.' }),
    });
  });

  const page = await suite.open('/v2/silo-chat.html', {}, {
    ready: () => !!document.getElementById('emptyState'),
  });

  const rowCount = await page.locator('.ac-prompt-row').count();
  r.ok('renders example prompt rows', rowCount === 27);

  await page.screenshot({ path: '/opt/cursor/artifacts/ask-silo-prompt-index-empty.png', fullPage: false });

  await page.click('.ac-prompt-cat[data-cat="marketing"]');
  const marketingVisible = await page.locator('.ac-prompt-row:not([hidden])').count();
  r.ok('marketing filter shows five prompts', marketingVisible === 5);
  await page.screenshot({ path: '/opt/cursor/artifacts/ask-silo-prompt-index-marketing.png', fullPage: false });

  await page.click('.ac-prompt-cat[data-cat="all"]');
  r.ok('all filter restores full list', (await page.locator('.ac-prompt-row:not([hidden])').count()) === 27);

  const sampleQ = 'Which SKUs get returned the most, and why?';
  await page.locator('.ac-prompt-row[data-cat="returns"] .ac-prompt-copy').first().click();
  const copied = await page.inputValue('#input');
  r.test('copy fills composer', () => r.eq(copied, sampleQ));
  await page.click('#btnSend');
  await page.waitForTimeout(400);
  r.test('ordinary copy then send keeps workflow null',
    () => r.eq(sent[sent.length - 1]?.workflow ?? null, null));

  await page.click('#btnNewChat');
  await page.waitForFunction(() => document.getElementById('emptyState'));

  const conceptQ = 'I want to generate a new product concept.';
  await page.click('.ac-prompt-cat[data-cat="creative"]');
  await page.locator('.ac-prompt-copy[data-workflow="product_concept"]').click();
  r.ok('copy selects product concept mode', !(await page.locator('#workflowBar[hidden]').count()));
  await page.fill('#input', conceptQ + ' Focus on a summer cap.');
  await page.click('#btnSend');
  await page.waitForTimeout(400);
  r.test('concept copy then send includes product_concept workflow',
    () => r.eq(sent[sent.length - 1]?.workflow, 'product_concept'));

  await page.click('#btnNewChat');
  await page.waitForFunction(() => document.getElementById('emptyState'));
  r.ok('new chat restores prompt index', (await page.locator('.ac-prompt-row').count()) === 27);

  await page.locator('.ac-suggestion').first().click();
  await page.waitForTimeout(400);
  r.ok('clicking a prompt removes empty state', !(await page.locator('#emptyState').count()));
  r.test('clicking a prompt sends that question',
    () => r.eq(sent[sent.length - 1]?.history?.slice(-1)[0]?.content,
      'What were our top 5 selling products by revenue in the last 30 days?'));

  await suite.close();
  r.summary();
  if (r.failed) process.exit(1);
})();
