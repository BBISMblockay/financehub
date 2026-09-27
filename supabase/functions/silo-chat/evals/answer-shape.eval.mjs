/* Ask SILO answer shape and current-evidence -- MODEL EVALUATION, not a test.
 *
 * READ evals/README.md FIRST. This makes real, paid Anthropic API calls and
 * needs ANTHROPIC_API_KEY. It is not run by CI (only its --dry-run is).
 *
 * Added with the 2026-09-27 prompt split (prompt-lib.mjs). The deterministic
 * suites prove which rules reach which assembled prompt; they cannot show that
 * a shorter prompt still produces answers that lead with the point, keep their
 * qualifiers on "simplify that", and read coverage from evidence rather than
 * from memory. These cases replay those steps against the REAL assembled
 * prompt (same buildSystemPrompt + selectGuidance the handler calls) with a
 * scripted transcript, and grade the answer with deterministic checks.
 *
 *   node answer-shape.eval.mjs [--runs N] [--case KEY] [--json] [--dry-run]
 */
import { renderQueryResult, buildCatalogIndex } from '../evidence-scope.mjs';
import { CATALOG_FIXTURE } from '../evidence-fixtures.mjs';
import { buildSystemPrompt, selectGuidance } from '../prompt-lib.mjs';

const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-5';
const KEY = process.env.ANTHROPIC_API_KEY || '';
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};
const RUNS = Number(flag('runs', 3));
const ONLY = flag('case', null);
const AS_JSON = argv.includes('--json');
const DRY = argv.includes('--dry-run');

const INDEX = buildCatalogIndex(CATALOG_FIXTURE);
const NOW = new Date('2026-09-27T12:00:00Z');
const GENERIC_OFFER = /(let me know if|would you like me to|i can also|happy to (help|dig|pull)|feel free to ask)/i;
const firstSentence = (a) => (a.trim().split(/(?<=[.!?])\s|\n/)[0] || '').toLowerCase();
const words = (a) => a.split(/\s+/).filter(Boolean).length;

function sqlRound(id, sql, rows) {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'run_sql', input: { query: sql } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: renderQueryResult(sql, rows, INDEX, { resultId: id }) }] },
  ];
}

const PRIOR_SEO_ANSWER = 'Hats is the collection page to fix first: it drew 1,840 landing sessions in the 6 weeks of '
  + 'landing-page data we hold (since 28 July) with a 0.4% completed-checkout rate, and there is no recorded '
  + 'traffic to a hoodies hub page in those 6 weeks -- which may mean no such page exists or that it never '
  + 'reached the top pages recorded each day. Search Console returned 212 clicks for the hats page over the '
  + 'same window, with 41% of site clicks carrying no returned query.';

const CASES = [
  {
    key: 'ordinary-leads-with-figure',
    why: 'A number question should open with the number and not end with a generic offer.',
    history: [{ role: 'user', content: 'What did we sell last week?' }],
    rounds: () => sqlRound('R1',
      "select sum(net_sales) net_sales, sum(units) units from sales_by_day where day_date between '2026-09-20' and '2026-09-26'",
      [{ net_sales: 184220.55, units: 7431 }]),
    grade: (a) => [
      ['the first sentence carries the figure', /\$?184,?22\d|\$184k|\$184\.2k/i.test(firstSentence(a))],
      ['no generic follow-up offer', !GENERIC_OFFER.test(a)],
      ['short', words(a) <= 90],
      ['no backend vocabulary', !/sales_by_day|run_sql|query/i.test(a)],
    ],
  },
  {
    key: 'decision-restock',
    why: 'A decision question opens with the recommendation, with a reason, the uncertainty and at most one next step.',
    history: [{ role: 'user', content: 'Should we restock the Bubbles and Doubles Hoodie?' }],
    rounds: () => [
      ...sqlRound('R1',
        "select product_title, sum(units) units_90d from sales_by_product_title_daily_v where product_title = 'Bubbles and Doubles Hoodie' and day_date between '2026-06-29' and '2026-09-26' group by 1",
        [{ product_title: 'Bubbles and Doubles Hoodie', units_90d: 1320 }]),
      ...sqlRound('R2',
        "select variant_title, sum(qty_on_hand) on_hand from inventory_workboard_v where product_title = 'Bubbles and Doubles Hoodie' group by 1",
        [{ variant_title: 'S', on_hand: 4 }, { variant_title: 'M', on_hand: 0 }, { variant_title: 'L', on_hand: 2 }, { variant_title: 'XL', on_hand: 61 }]),
    ],
    grade: (a) => [
      ['opens with a recommendation',
        /\b(yes|no|restock|reorder|re-order|buy|hold|wait|don'?t|do not)\b/.test(firstSentence(a))],
      ['names the broken size run (M out, S/L nearly out)', /\bm\b|medium/i.test(a) && /(out of stock|sold out|zero|\b0\b|none)/i.test(a)],
      ['no generic follow-up offer', !GENERIC_OFFER.test(a)],
      ['stays compact by default', words(a) <= 180],
    ],
  },
  {
    key: 'simplify-keeps-window',
    why: '"simplify that" must cut length, never the window a claim rests on.',
    history: [
      { role: 'user', content: 'Which collection pages should we improve for search?' },
      { role: 'assistant', content: PRIOR_SEO_ANSWER },
      { role: 'user', content: 'simplify that' },
    ],
    rounds: () => [],
    grade: (a) => [
      ['shorter than the answer it simplifies', words(a) < words(PRIOR_SEO_ANSWER)],
      ['the window survives', /(6|six) weeks|28 july|since july|data we hold/i.test(a)],
      ['no-traffic is not turned into non-existence', !/(doesn'?t|does not|no longer) exist/i.test(a)],
      ['no-traffic is not turned into zero traffic', !/zero (traffic|visits|sessions)/i.test(a)],
    ],
  },
  {
    key: 'coverage-from-evidence',
    why: 'A launch that predates a source\'s measured coverage is a data limit, stated from the rows -- not a remembered history length.',
    history: [{ role: 'user', content: 'Which Meta ad creatives worked best for our Black Friday 2025 launch?' }],
    rounds: () => sqlRound('R1',
      'select min(day_date) first_day, max(day_date) last_day from meta_ad_performance_daily',
      [{ first_day: '2026-07-08', last_day: '2026-09-25' }]),
    grade: (a) => [
      ['says the ad-level data does not reach that launch',
        /(doesn'?t|does not|don'?t|do not|only) (go|reach|start|cover|begin|have)|starts? (in|on)? ?(8 )?july|begins?/i.test(a)],
      ['names the measured start', /(8 july|july 8|2026-07-08|july 2026)/i.test(a)],
      ['invents no creative results', !/\broas\b[^.]{0,30}\d|\$\d/i.test(a)],
      ['does not recite a remembered history length', !/7 weeks|seven weeks/i.test(a)],
    ],
  },
  {
    key: 'suggestions-compact',
    why: 'The live 30-day review ran ~700 words before recommending, and recommended a reorder it had not checked.',
    history: [{ role: 'user', content: 'Look at past 30 days of business suggest improvements' }],
    rounds: () => [
      ...sqlRound('R1',
        "select case when day_date >= '2026-08-28' then 'last_30' else 'prior_30' end period, sum(total_net_sales) net_sales, sum(total_orders) orders from sales_by_day where location_tag = 'online' and day_date between '2026-07-29' and '2026-09-26' group by 1",
        [{ period: 'last_30', net_sales: 1066995, orders: 46797 }, { period: 'prior_30', net_sales: 1404679, orders: 65639 }]),
      ...sqlRound('R2',
        "select case when day_date >= '2026-08-28' then 'last_30' else 'prior_30' end period, platform, sum(spend) spend, sum(conversion_value) conversion_value from marketing_kpis_daily where day_date between '2026-07-29' and '2026-09-26' group by 1, 2",
        [{ period: 'last_30', platform: 'meta_ads', spend: 312675, conversion_value: 807534 }, { period: 'prior_30', platform: 'meta_ads', spend: 414619, conversion_value: 1077572 },
         { period: 'last_30', platform: 'google_ads', spend: 18099, conversion_value: 44649 }, { period: 'prior_30', platform: 'google_ads', spend: 35554, conversion_value: 208799 }]),
      ...sqlRound('R3',
        "select product_title, sum(total_available_quantity) on_hand, sum(qty_sold_30d) sold_30d from inventory_workboard_v where velocity_matched group by 1 order by sold_30d desc limit 5",
        [{ product_title: 'Sonic The Hedgehog Team Sonic Youth T-Shirt', on_hand: 62, sold_30d: 1292 }, { product_title: 'Sonic The Hedgehog Slugger Youth Hoodie', on_hand: -2, sold_30d: 469 }]),
    ],
    grade: (a) => {
      const actions = a.split('\n').filter((l) => /^\s*(\d+[.)]|[-*])\s+\S/.test(l) && /\b(reorder|restock|pause|scale|cut|test|check|investigate|shift|move|raise|lower|review)\b/i.test(l));
      return [
        ['at most three ranked actions', actions.length >= 1 && actions.length <= 3],
        ['compact', words(a) <= 320],
        ['the unchecked incoming stock becomes "check first", not a buy order', /check first|incoming|on order|open (purchase )?orders?|\bPOs?\b/i.test(a)],
        ['no generic advice', !/optimi[sz]e (your )?(marketing|campaigns)|consider improving/i.test(a)],
        ['no generic follow-up offer', !GENERIC_OFFER.test(a)],
      ];
    },
  },
  {
    key: 'scope-note-in-history',
    why: 'The automatic scope note rides back into history; a follow-up must fix the label, not copy the note.',
    history: [
      { role: 'user', content: 'What did we sell over the last 90 days?' },
      { role: 'assistant', content: 'Online sales were $8,844,752 on 387,018 units from 29 June to 26 September.\n\n---\n**Scope check (automatic):** "online" appears above, but every figure behind this answer covers all sales channel values together -- the figures are real, the label on them was not established by anything that ran. _Word check only; it can be wrong in both directions._' },
      { role: 'user', content: 'simplify that' },
    ],
    rounds: () => [],
    grade: (a) => [
      ['the note is not copied', !/scope check/i.test(a)],
      ['the label is corrected to the real scope', /(all|every) (sales )?(channels|stores|locations)|combined|online (and|plus|\+) retail/i.test(a)],
      ['the figure is not relabelled as online-only', !/online sales (were|totaled|of)/i.test(a)],
    ],
  },
];

function systemFor(history) {
  return buildSystemPrompt({ schemaSection: '', guidance: selectGuidance({ history }), now: NOW });
}

async function callModel(system, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 2048, system, messages,
      // Declared so the scripted tool_use/tool_result blocks resolve; 'none'
      // means the model can only answer.
      tools: [{ name: 'run_sql', description: 'Run one read-only SELECT.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
      tool_choice: { type: 'none' },
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).map((b) => b.text || '').join('').trim();
}

function transcript(c) {
  const msgs = c.history.map((m) => ({ role: m.role, content: m.content }));
  const rounds = c.rounds();
  if (!rounds.length) return msgs;
  return [...msgs, ...rounds, { role: 'user', content: 'Answer the question now from the results above. Do not run anything else.' }];
}

const selected = ONLY ? CASES.filter((c) => c.key === ONLY) : CASES;
if (!selected.length) {
  console.error(`no case named ${ONLY}. Known: ${CASES.map((c) => c.key).join(', ')}`);
  process.exit(2);
}

if (DRY) {
  for (const c of selected) {
    const sys = systemFor(c.history);
    const t = transcript(c);
    console.log(`  ${c.key}: guidance [${selectGuidance({ history: c.history }).join(', ')}], system ${sys.length} chars, ${t.length} message(s)`);
  }
  console.log('\ndry run only -- nothing was sent and nothing was charged.');
  process.exit(0);
}
if (!KEY) {
  console.error('ANTHROPIC_API_KEY is not set. This evaluation makes real, paid API calls -- see evals/README.md.');
  process.exit(2);
}

const report = { model: MODEL, runs: RUNS, at: new Date().toISOString(), cases: {} };
for (const c of selected) {
  const results = [];
  for (let i = 0; i < RUNS; i++) {
    const answer = await callModel(systemFor(c.history), transcript(c));
    const checks = c.grade(answer);
    results.push({ answer, checks, passed: checks.every(([, ok]) => ok) });
  }
  const passes = results.filter((r) => r.passed).length;
  report.cases[c.key] = {
    passes, runs: RUNS,
    failed_checks: [...new Set(results.flatMap((r) => r.checks.filter(([, ok]) => !ok).map(([l]) => l)))],
    answers: results.map((r) => r.answer),
  };
  console.error(`  ${passes}/${RUNS}  ${c.key}`);
  for (const l of report.cases[c.key].failed_checks) console.error(`         missed: ${l}`);
}
if (AS_JSON) console.log(JSON.stringify(report, null, 2));
console.error('\nThis is a model evaluation, not a test. Report the model id, run count and date with any number taken from it.');
