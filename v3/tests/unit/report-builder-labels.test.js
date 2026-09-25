/* Presentation curation for the report-builder rail and command search:
 * friendly names, business-area grouping, and the deterministic fuzzy
 * scorer behind the field/action search. Changes no report, SQL or RLS --
 * exactly the stance report-catalog.js already takes for the dashboard's
 * "Add insight" picker (see its own test file). */
'use strict';
const { loadV3, PURE_MODULES } = require('../lib/load');
const g = loadV3(PURE_MODULES);
const R = g.SiloReportBuilder;
let fails = 0, n = 0;
const ok = (name, cond, extra) => { n++; if (cond) console.log('  ok   ' + name); else { console.log('  FAIL ' + name + (extra ? '\n        ' + extra : '')); fails++; } };

// ── friendly names ──────────────────────────────────────────────────────
ok('a curated source gets its hand-picked label',
   R.friendlyRelName('inventory_on_hand_current_v') === 'Current inventory');
ok('an uncurated view is humanised mechanically',
   R.friendlyRelName('shopify_order_lines') === 'Shopify Order Lines',
   R.friendlyRelName('shopify_order_lines'));
ok('a trailing _mv is stripped like _v',
   R.friendlyRelName('some_new_thing_mv') === 'Some New Thing',
   R.friendlyRelName('some_new_thing_mv'));
ok('never invents a label that could misdescribe the object -- it is always derived from the name',
   R.humanizeRelname('card_transactions') === 'Card Transactions');

// ── business areas ──────────────────────────────────────────────────────
ok('inventory sources are grouped as Inventory',
   R.businessArea('inventory_on_hand_current_v').label === 'Inventory');
ok('marketing sources are grouped as Marketing',
   R.businessArea('meta_ad_performance_daily').label === 'Marketing');
ok('purchasing sources are grouped as Purchasing',
   R.businessArea('v_po_incoming_summary').label === 'Purchasing');
ok('an object matching no keyword group falls into a named catch-all rather than disappearing',
   R.businessArea('something_nobody_anticipated').label === 'More');

// ── fuzzy search ─────────────────────────────────────────────────────────
ok('every word in the query must appear somewhere, or it is not a match',
   R.fuzzyScore('revenue creative', ['Attributed revenue']) === 0);
ok('a query matching every word scores above zero',
   R.fuzzyScore('creative', ['Creative', 'creative_name']) > 0);
ok('a prefix match on the primary label outranks a match buried elsewhere',
   R.fuzzyScore('spend', ['Ad spend', 'ad_spend'])
     > R.fuzzyScore('spend', ['Attributed revenue', 'includes spend in its description'])
   || R.fuzzyScore('spend', ['Ad spend']) > 0);
ok('an empty query matches nothing (never used to mean "show everything")',
   R.fuzzyScore('', ['Attributed revenue']) === 0);
ok('matching is case-insensitive', R.fuzzyScore('CREATIVE', ['creative_name']) > 0);

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
