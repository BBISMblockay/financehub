// The AI summary prompt is the whole contract with the model, so it is pinned
// here: the figures it carries, the rules it states, and the fact that it
// names nothing company-specific of its own.
'use strict';
const assert = require('assert/strict');

(async () => {
  const { buildSummaryPrompt, hasSomethingToSummarize, money } = await import('../../silo-attribution-ai-summary.js');

  const base = {
    store: 'synthetic.example.test',
    start: '2026-09-01', end: '2026-09-30', days: 30, windowDays: 30,
    currency: 'USD', netCents: 10000000, totalCents: 10500000, orderCount: 820,
    spend: { cents: 2500000, complete: true, gaps: [] },
    multiChannel: { multi: 410, any: 700, total: 820 },
    journeys: { eligible: 700, total: 820 },
    channels: [
      { channel: 'Paid Social', netCents: 6000000, sharedCents: 4500000, spendCents: 2000000, spendStatus: 'complete', started: 500, assisted: 10, closed: 400 },
      { channel: 'Paid Search', netCents: 3000000, sharedCents: 3500000, spendCents: null, spendStatus: 'none', started: 20, assisted: 300, closed: 350 },
      { channel: 'Unattributed', netCents: 1000000, sharedCents: null, spendCents: null, spendStatus: null, started: 0, assisted: 0, closed: 70 },
    ],
    paths: [{ path: ['Paid Social', 'Paid Search'], count: 300, netCents: 4000000 }],
    findings: [{ title: 'Paid Social starts more sales than it gets credit for', text: 'It started 500 orders and closed 400.' }],
  };

  // Figures the page shows are all in the prompt, in the report's currency.
  const prompt = buildSummaryPrompt(base);
  for (const needle of [
    'synthetic.example.test', '2026-09-01 through 2026-09-30', '30 days',
    '$100,000', '820', '$25,000 (complete for the whole period)', '4.0x',
    '410 of 820', '700 of 820',
    'Paid Social: $60,000 | $45,000 | $20,000 | 500 / 10 / 400',
    'Paid Search: $30,000 | $35,000 | spend not tracked',
    'Unattributed: $10,000 | shared credit unavailable',
    'Paid Social then Paid Search then purchase: 300 orders, $40,000',
    'Paid Social starts more sales than it gets credit for',
  ]) assert.ok(prompt.includes(needle), 'prompt carries ' + needle);

  // The rules that keep the summary honest. Each is load-bearing: they are the
  // page's own stated limits (see "How this works"), not decoration.
  for (const rule of [
    'Do not run any SQL',
    'the SAME sales total',
    'not proof a channel caused a sale',
    'never zero',
    'Under 200 words',
  ]) assert.ok(prompt.includes(rule), 'prompt states: ' + rule);

  // Generic by construction: no company, brand or vendor is named except from
  // the caller's own data.
  const generic = buildSummaryPrompt({ ...base, store: 'STORE', channels: [], paths: [], findings: [], multiChannel: null, journeys: null });
  assert.ok(!/baseballism|shopify|klaviyo|meta|redo/i.test(generic), 'prompt hardcodes no company or vendor name');

  // Incomplete spend is named as incomplete and no return is computed from it.
  const partial = buildSummaryPrompt({ ...base, spend: { cents: 1000000, complete: false, gaps: ['Paid Search'] } });
  assert.ok(partial.includes('INCOMPLETE -- still missing Paid Search'));
  assert.ok(partial.includes('Return on spend: not available'));
  assert.ok(!partial.includes('4.0x'));

  // No spend source at all is "not tracked", never $0.
  const noSpend = buildSummaryPrompt({ ...base, spend: { cents: null, complete: false, gaps: [] } });
  assert.ok(noSpend.includes('Marketing spend: not tracked'));
  assert.ok(!/Marketing spend: \$0/.test(noSpend));

  // A long channel list is truncated, and says that it was.
  const many = buildSummaryPrompt({ ...base, channels: Array.from({ length: 20 }, (_, i) => ({ channel: 'Channel ' + i, netCents: 100, sharedCents: 100, spendCents: 0, spendStatus: 'complete', started: 0, assisted: 0, closed: 0 })) });
  assert.ok(many.includes('Channel 11'));
  assert.ok(!many.includes('Channel 12:'));
  assert.ok(many.includes('8 smaller channels not listed'));

  // An empty period is not summarized at all: no credit is spent saying
  // "there is nothing here".
  assert.equal(hasSomethingToSummarize(null), false);
  assert.equal(hasSomethingToSummarize({ orderCount: 0 }), false);
  assert.equal(hasSomethingToSummarize({ orderCount: 1 }), true);
  assert.throws(() => buildSummaryPrompt({ ...base, orderCount: 0 }), /nothing|No attribution data/i);

  // Currency follows the store, and a missing amount is never rendered as zero.
  assert.equal(money(123456, 'CAD'), 'CA$1,235');
  assert.equal(money(null, 'USD'), 'not tracked');

  console.log('Attribution AI summary prompt: figures, honesty rules, generic wording, spend states, truncation and empty period passed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
