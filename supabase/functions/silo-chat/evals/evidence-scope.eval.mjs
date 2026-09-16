/* Ask SILO evidence-to-claim consistency -- MODEL EVALUATION, not a test.
 *
 * READ evals/README.md FIRST. This makes real, paid Anthropic API calls and
 * needs ANTHROPIC_API_KEY. It is not run by CI and must never be added to it.
 *
 * It replays the two answers traced on 2026-09-16 at the step that went wrong:
 * the model is given the REAL system prompt built from index.ts and a SCRIPTED
 * transcript whose tool results are rendered by the REAL renderQueryResult over
 * frozen fixtures, and then writes the answer. Repeatable because nothing is
 * queried; narrow because nothing is queried.
 *
 *   node evidence-scope.eval.mjs [--runs N] [--case KEY] [--baseline] [--json]
 *
 * --baseline runs a control arm with the evidence envelope and the scope rules
 * removed, which is the only thing here that supports a before/after claim.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderQueryResult, buildCatalogIndex } from '../evidence-scope.mjs';
import {
  CATALOG_FIXTURE, COMBINED_SPEND_SQL, COMBINED_SPEND_ROWS, PER_PLATFORM_SQL,
  PER_PLATFORM_ROWS, WEEKLY_BUCKET_SQL, WEEKLY_BUCKET_ROWS, DAILY_STRADDLE_ROWS,
  CREATIVE_MATCH_SQL, CREATIVE_MATCH_BY_CAMPAIGN_ROWS,
} from '../evidence-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'index.ts'), 'utf8');
const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-5';
const KEY = process.env.ANTHROPIC_API_KEY || '';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};
const RUNS = Number(flag('runs', 3));
const ONLY = flag('case', null);
const BASELINE = argv.includes('--baseline');
const AS_JSON = argv.includes('--json');
// Builds every prompt and transcript and prints their shape WITHOUT calling the
// API. No key, no cost. It is what proves the index.ts scrapers above still
// find what they expect -- a moved prompt constant would otherwise surface as a
// crash halfway through a paid run.
const DRY = argv.includes('--dry-run');

/** Same scraper the prompt suite uses -- index.ts is Deno and cannot be
 *  imported here, but its prompts are plain template literals. */
function constant(name) {
  const start = SRC.indexOf(`const ${name} = \``);
  if (start === -1) throw new Error(`prompt constant ${name} not found`);
  const from = SRC.indexOf('`', start) + 1;
  let i = from;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '\\') { i++; continue; }
    if (SRC[i] === '`') break;
  }
  return SRC.slice(from, i);
}

const BEFORE = constant('BASE_PROMPT_BEFORE_SCHEMA');
const AFTER = constant('BASE_PROMPT_AFTER_SCHEMA');
const SCOPE_SECTION_HEAD = 'EVERY FIGURE KEEPS THE POPULATION IT CAME FROM.';
const EVIDENCE_HEAD = 'EVIDENCE DISCIPLINE --';

/** The control arm: the prompt exactly as it was before this change, i.e. the
 *  scope section excised. Cut by its own headings rather than by a stored copy
 *  so it cannot drift out of date the moment the section is edited. */
function withoutScopeRules(after) {
  const a = after.indexOf(SCOPE_SECTION_HEAD);
  const b = after.indexOf(EVIDENCE_HEAD);
  if (a === -1 || b === -1 || b < a) throw new Error('could not locate the scope section to remove');
  return after.slice(0, a) + after.slice(b);
}

const INDEX = buildCatalogIndex(CATALOG_FIXTURE);
const schemaSection = `\n\nDatabase map (auto-generated from the live schema -- names below are EXACT):\n\n${
  CATALOG_FIXTURE.map((r) =>
    `### ${r.relname} (${r.relkind})\nColumns: ${r.columns.map((c) => `${c.name} (${c.type})`).join(', ')}\n${r.description || ''}`
  ).join('\n\n')
}`;

function systemPrompt({ scopeRules }) {
  const today = 'Today\'s date is Wednesday, September 16, 2026 (2026-09-16, UTC).';
  return `${BEFORE}${schemaSection}\n\n${scopeRules ? AFTER : withoutScopeRules(AFTER)}\n\n${today}`;
}

/** A scripted tool round. `enveloped` chooses between the new result shape and
 *  the bare array the two traced requests actually received. */
function round(sql, rows, resultId, enveloped) {
  return {
    assistant: [{ type: 'tool_use', id: `tu-${resultId}`, name: 'run_sql', input: { query: sql } }],
    user: [{
      type: 'tool_result',
      tool_use_id: `tu-${resultId}`,
      content: enveloped ? renderQueryResult(sql, rows, INDEX, { resultId }) : JSON.stringify(rows),
    }],
  };
}

const CASES = [
  {
    key: 'combined-spend',
    why: 'A week of spend pooled across every platform was published as Meta spend.',
    question: 'For the week of Aug 24-30, how much did we spend on Meta ads and what did that return?',
    rounds: (e) => [round(COMBINED_SPEND_SQL, COMBINED_SPEND_ROWS, 'R1', e)],
    grade: (a) => {
      const t = a.toLowerCase();
      const metaSpendClaim = /(meta[^.]{0,60}(spend|spent)[^.]{0,80}118,?9|118,?94[56][^.]{0,80}meta[^.]{0,40}(spend|spent))/s;
      return [
        ['the combined figure is not called Meta spend', !metaSpendClaim.test(t)],
        ['the figure is named as combined / all platforms', /(all|every|combined|across).{0,30}(platform|channel)|combined (spend|total)/.test(t)],
        ['the answer does not silently invent a Meta-only split it was never given',
          !/114,?33/.test(t)],
      ];
    },
  },
  {
    key: 'roas-pairing',
    why: 'A combined denominator was divided by one platform\'s attributed value.',
    question: 'What was our Meta return on ad spend for Aug 24-30?',
    rounds: (e) => [
      round(COMBINED_SPEND_SQL, COMBINED_SPEND_ROWS, 'R1', e),
      round(PER_PLATFORM_SQL, PER_PLATFORM_ROWS, 'R2', e),
    ],
    grade: (a) => {
      const t = a.toLowerCase();
      return [
        ['Meta ROAS is drawn from the per-platform result, not the combined one',
          /114,?33/.test(t) || /1\.01/.test(t)],
        ['the combined spend figure is not used as the Meta denominator',
          !/118,?94[56][^.]{0,120}(roas|return|1\.01)/s.test(t)],
        ['the two sources are distinguished rather than blended',
          /(combined|all platforms|google)/.test(t)],
      ];
    },
  },
  {
    key: 'bucket-straddles-launch',
    why: 'Spend on Aug 31 was described as post-launch because the week bucket started there.',
    question:
      'The Sonic collab launched on September 1. Did the Subscribers campaign do better after launch than before it?',
    rounds: (e) => [round(WEEKLY_BUCKET_SQL, WEEKLY_BUCKET_ROWS, 'R1', e)],
    grade: (a) => {
      const t = a.toLowerCase();
      return [
        ['the Aug 31 bucket edge is surfaced', /(aug(ust)? 31|08-31|31 aug)/.test(t)],
        ['the bucket is not simply called post-launch',
          !/(after launch|post-?launch)[^.]{0,80}17,?500/s.test(t) && !/17,?500[^.]{0,80}(after launch|post-?launch)/s.test(t)],
        ['the straddle is named as a limitation, or the day grain is asked for',
          /(straddle|spans|crosses|includes the day before|day-level|daily|day grain|cannot tell|can'?t tell)/.test(t)],
      ];
    },
  },
  {
    key: 'two-campaigns-one-population',
    why: 'Ads matched by current creative text spanned two campaigns and were described as one.',
    question:
      'Looking at the Sonic ads over Sep 1-7, did that campaign move away from lead generation?',
    rounds: (e) => [
      round(CREATIVE_MATCH_SQL, [{ day_date: '2026-09-01', spend: 25488.06, leads: 650, conv_val: 183513.0 }], 'R1', e),
      round(
        `select m.campaign_name, sum(m.spend) spend, sum(m.leads) leads
from meta_ad_performance_daily m
join (select ad_id from meta_ad_creatives where body ilike '%sonic%') s on s.ad_id = m.ad_id
where m.day_date between '2026-09-01' and '2026-09-07'
group by 1`,
        CREATIVE_MATCH_BY_CAMPAIGN_ROWS, 'R2', e,
      ),
    ],
    grade: (a) => {
      const t = a.toLowerCase();
      return [
        ['both campaigns are named', /purchase campaigns/.test(t) && /subscribers/.test(t)],
        ['the spend is attributed to Purchase Campaigns, not to "the campaign"',
          /purchase campaigns[^.]{0,120}25,?488|25,?488[^.]{0,120}purchase campaigns/s.test(t)],
        ['Subscribers is reported at zero spend rather than folded in',
          /subscribers[^.]{0,80}(\$?0|zero|no spend)/s.test(t)],
        ['current creative text is not treated as historical campaign membership',
          /(current|today|now|as it stands|selected by)/.test(t)],
      ];
    },
  },
  {
    key: 'no-cut-on-purchase-roas',
    why: 'Cutting subscriber-acquisition spend was recommended on immediate purchase ROAS alone.',
    question:
      'Pre-launch the Subscribers campaign spent $52,978 and Meta claimed only $5,961 back. Should we cut subscriber acquisition spend?',
    rounds: (e) => [
      round(WEEKLY_BUCKET_SQL, WEEKLY_BUCKET_ROWS, 'R1', e),
      round(
        `select day_date, sum(spend) spend, sum(conversion_value) value
from marketing_kpis_daily
where platform='meta_ads' and campaign_name='Subscribers' and day_date between '2026-08-31' and '2026-09-02'
group by 1 order by 1`,
        DAILY_STRADDLE_ROWS, 'R2', e,
      ),
    ],
    grade: (a) => {
      const t = a.toLowerCase();
      const recommendsCut = /(yes[^.]{0,40}cut|should cut|recommend cutting|cut (the )?(subscriber|lead)[^.]{0,30}spend|reduce (subscriber|lead)[^.]{0,30}spend)/.test(t);
      return [
        ['no cut is recommended on purchase return alone', !recommendsCut],
        ['the missing subscriber-to-order linkage is named',
          /(no (way|link|key|join)|cannot (trace|link|match|connect)|can'?t (trace|link|match|connect)|not (traceable|linked)|unknown)/.test(t)],
        ['a lead-gen campaign is not judged on purchase ROAS',
          /(lead|acquisition|list-?building|demand|awareness)/.test(t)],
      ];
    },
  },
  {
    key: 'missing-linkage-is-unknown',
    why: 'An absent join was reasoned from as a weak signal instead of stated as unknown.',
    question: 'Did the subscribers we acquired before launch go on to buy?',
    rounds: (e) => [
      round(
        `select count(*) as matched
from marketing_kpis_daily m
where m.platform='meta_ads' and m.campaign_name='Subscribers' and m.leads > 0`,
        [{ matched: 5 }], 'R1', e,
      ),
      round(
        `select column_name from information_schema.columns
where table_name in ('marketing_kpis_daily','shopify_orders') and column_name ilike '%email%'`,
        [], 'R2', e,
      ),
    ],
    grade: (a) => {
      const t = a.toLowerCase();
      return [
        ['the answer says it cannot be established',
          /(cannot|can'?t|no way to|not possible|unknown|isn'?t something.{0,40}support)/.test(t)],
        ['no causal claim is made either way',
          !/(the subscribers (did|drove)|they went on to buy|these subscribers bought)/.test(t)],
        ['what would be needed is named',
          /(shared key|identifier|email|customer id|match|linkage|hashed)/.test(t)],
      ];
    },
  },
  {
    key: 'deadline-partial',
    why: 'The budget-exhausted instruction used to demand an answer "instead of refusing".',
    question:
      'Compare the last four weeks of spend and return, then give me three actions for next week with support.',
    rounds: (e) => [round(COMBINED_SPEND_SQL, COMBINED_SPEND_ROWS, 'R1', e)],
    // Appended verbatim from index.ts so the eval cannot test a paraphrase of
    // the instruction the function actually sends.
    finalNudge: () => {
      const marker = 'You are out of ${hitWallClock';
      const at = SRC.indexOf(marker);
      if (at === -1) throw new Error('the budget-exhausted instruction moved; update this eval');
      const from = SRC.indexOf('`', at - 2) + 1;
      let i = from;
      for (; i < SRC.length; i++) {
        if (SRC[i] === '\\') { i++; continue; }
        if (SRC[i] === '`') break;
      }
      return SRC.slice(from, i).replace('${hitWallClock ? \'TIME\' : \'tool budget\'}', 'TIME');
    },
    grade: (a) => {
      const t = a.toLowerCase();
      return [
        ['the supported findings are given rather than refused', a.trim().length > 120],
        ['unfinished checks are named explicitly',
          /(unchecked|not (yet )?(run|checked|verified)|still (unchecked|open)|did not (run|get to)|couldn'?t (run|check))/.test(t)],
        ['three actions are not manufactured from one result',
          !/3\.\s/.test(a) || /(unchecked|not verified|would need)/.test(t)],
        ['the combined figure keeps its scope even under compression',
          !/meta[^.]{0,60}118,?94/s.test(t)],
      ];
    },
  },
];

async function callModel(system, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2048, system, messages }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).map((b) => b.text || '').join('').trim();
}

async function runCase(c, { enveloped, scopeRules }) {
  const messages = [{ role: 'user', content: c.question }];
  for (const r of c.rounds(enveloped)) {
    messages.push({ role: 'assistant', content: r.assistant });
    messages.push({ role: 'user', content: r.user });
  }
  messages.push({
    role: 'user',
    content: c.finalNudge
      ? c.finalNudge()
      : 'Answer the question now from the results above. Do not run anything else.',
  });
  const answer = await callModel(systemPrompt({ scopeRules }), messages);
  const checks = c.grade(answer);
  return { answer, checks, passed: checks.every(([, ok]) => ok) };
}

if (!KEY && !DRY) {
  console.error('ANTHROPIC_API_KEY is not set. This evaluation makes real, paid API calls -- see evals/README.md.');
  console.error('Use --dry-run to build every prompt and transcript without calling anything.');
  process.exit(2);
}

const selected = ONLY ? CASES.filter((c) => c.key === ONLY) : CASES;
if (!selected.length) {
  console.error(`no case named ${ONLY}. Known: ${CASES.map((c) => c.key).join(', ')}`);
  process.exit(2);
}

const arms = BASELINE
  ? [{ name: 'with-controls', enveloped: true, scopeRules: true },
     { name: 'baseline', enveloped: false, scopeRules: false }]
  : [{ name: 'with-controls', enveloped: true, scopeRules: true }];

if (DRY) {
  for (const arm of [{ name: 'with-controls', enveloped: true, scopeRules: true },
                     { name: 'baseline', enveloped: false, scopeRules: false }]) {
    const sys = systemPrompt(arm);
    console.log(`${arm.name}: system prompt ${sys.length} chars, scope section ${sys.includes(SCOPE_SECTION_HEAD) ? 'present' : 'absent'}`);
    for (const c of selected) {
      const rounds = c.rounds(arm.enveloped);
      const enveloped = rounds.some((r) => r.user[0].content.includes('evidence_scope'));
      const nudge = c.finalNudge ? `${c.finalNudge().length} chars scraped` : 'default';
      console.log(`  ${c.key}: ${rounds.length} tool round(s), envelope ${enveloped ? 'on' : 'off'}, final instruction ${nudge}`);
    }
  }
  console.log('\ndry run only -- nothing was sent and nothing was charged.');
  process.exit(0);
}

const report = { model: MODEL, runs: RUNS, at: new Date().toISOString(), arms: {} };
for (const arm of arms) {
  report.arms[arm.name] = {};
  console.error(`\n=== ${arm.name} ===`);
  for (const c of selected) {
    const results = [];
    for (let i = 0; i < RUNS; i++) results.push(await runCase(c, arm));
    const passes = results.filter((r) => r.passed).length;
    report.arms[arm.name][c.key] = {
      passed: passes,
      of: RUNS,
      why: c.why,
      failed_checks: [...new Set(results.flatMap((r) => r.checks.filter(([, ok]) => !ok).map(([label]) => label)))],
      answers: results.map((r) => r.answer),
    };
    console.error(`  ${passes}/${RUNS}  ${c.key}`);
    for (const label of report.arms[arm.name][c.key].failed_checks) console.error(`         missed: ${label}`);
  }
}

if (AS_JSON) console.log(JSON.stringify(report, null, 2));
console.error(
  '\nThis is a model evaluation, not a test. Report the model id, the run count and the date with any'
  + '\nnumber taken from it, and read the answers before trusting the score.',
);
