/* What SILO teaches a bot about itself, in one file.
 *
 * WHY THIS EXISTS
 *
 * Over MCP there is no SILO interface. A person's own bot sees two generic
 * tools and a list of report titles, and from that alone it has to decide
 * which report answers "how are sales doing", what "cover" means, and whether
 * it may add Meta's credited revenue to net sales. Today it decides those
 * things by guessing, and the guesses are wrong in ways that read as
 * confident: platform claims summed into revenue, a blank day treated as a
 * zero, Daily Sales used to answer a question about trend.
 *
 * Each report's `description` already carries its own caveats -- they are the
 * Ask SILO catalog's, written for exactly this reason. What is missing is
 * everything ABOVE one report: the vocabulary the descriptions are written
 * in, the rules that hold across all of them, and which one to reach for.
 * That is what this file holds.
 *
 * WHERE IT IS DELIVERED
 *
 * Three places, because a client shows each of them at a different moment:
 *
 *   - the server's `instructions`, at connect time. Compact on purpose: many
 *     clients paste this into a system prompt, where it costs tokens on every
 *     turn. Rules only -- the ones that change an answer rather than describe
 *     one.
 *   - the two tool descriptions, which a model reads when it is choosing a
 *     tool.
 *   - a tool of its own, how_to_use_silo, which returns the glossary, the
 *     routing table and the per-report notes. A tool, and NOT extra fields on
 *     the `list_reports` result, because that result is already about 63k
 *     characters for 24 reports: a client that caps a tool result would start
 *     truncating the catalog, and a bot with a truncated catalog is worse off
 *     than one with no training at all. As its own call the training costs
 *     nothing until it is asked for, and it cannot crowd out the thing it is
 *     advice about. It reads no data, so it needs no token, scope or
 *     database call -- it is the only tool here that never reaches PostgREST.
 *
 * WHY NOT IN THE DATABASE
 *
 * The per-report notes could be columns on the catalog. They are not, because
 * they are advice about SILO's OWN reports for OUR MCP clients, not report
 * metadata: a note says "prefer Sales vs Last Year over this one", which is
 * true of the MCP surface and says nothing to the report builder or to Ask
 * SILO. Keeping them here also means correcting a note is a function deploy
 * rather than a production migration. REPORT_NOTES is keyed by report id,
 * which is stable, and carries each report's title as well -- not because
 * anything reads it, but so that a report that is retired or retitled turns
 * up as drift (scripts/tests/mcp-guide.test.mjs checks every id and title
 * against the migrations that define the reports).
 *
 * This file adds no authority and reads nothing. It is text.
 */

export const GUIDE_VERSION = '2026-10-30';

/* ── The rules, for the system prompt ───────────────────────────────────────
 *
 * Every line here is one a bot gets WRONG without being told, and getting it
 * wrong changes the number it reports. Nothing descriptive belongs here.
 */
const RULES = [
  'HOW TO ANSWER WITH SILO.',
  'Call how_to_use_silo once before your first answer: it holds SILO\'s glossary, which report answers which',
  'question, what each report is for, and where each page lives in the app.',
  'A report is the unit of truth: SILO\'s own reports are tied out against their sources, so prefer',
  'answering from one report rather than combining several.',
  'Blank is not zero. A blank measure means that source had no rows for that day, which is usually a sync',
  'that has not landed. Never fill a blank with 0, average over it, or call it a decline.',
  'Credited is not earned. "Claimed", "credited" and "attributed" revenue is what an ad platform or Redo',
  'says it caused. Two platforms can claim the same order, so these figures overlap each other and overlap',
  'net sales. Never add them together, never add them to net sales, and never call them incremental.',
  'Net sales is the sales number. Use it for "how much did we sell"; ad-platform revenue answers a',
  'different question.',
  'Dates are the company\'s own calendar days in its own timezone, and default windows end at the last',
  'COMPLETE day, so today is normally absent on purpose. Ask for today only if the person did.',
  'Recent days keep moving: attribution and Redo revenue land for weeks after the order, so the newest',
  'days in any marketing report are still rising and are not a trend yet.',
  'Say where a number came from. Name the report and its window, and pass the report\'s own caveats on',
  'rather than smoothing them away -- its description says what it does and does not count.',
  'If no report fits, say so. Do not assemble an answer from reports that measure different things.',
  'This connection reads reports. It cannot see the screen, open a page or change anything, so point the',
  'person at the page (how_to_use_silo has the paths) rather than describing what you did there.',
].join(' ');

export function instructionsWithTraining(base) {
  return [String(base || '').trim(), RULES].filter(Boolean).join('\n\n');
}

/* ── The vocabulary the report descriptions are written in ──────────────────
 *
 * Terms a bot cannot work out from a title. Deliberately not a data
 * dictionary: a column whose label explains itself is not here.
 */
export const GLOSSARY = {
  'net sales': 'Merchandise after discounts and refunds, excluding tax and shipping, from SILO\'s canonical '
    + 'sales source (Shopify, de-duplicated). This is SILO\'s sales number. "Gross" or "merch revenue" in a '
    + 'report means refunds have NOT been taken off, which that report will say.',
  'company-calendar day': 'A day in the company\'s own timezone, not UTC. Every report\'s dates and every '
    + 'daily row mean this. The timezone comes back with each result.',
  'completed day': 'A company-calendar day that has finished. Default windows end at yesterday (or two days '
    + 'back for SEO, which is as current as Google\'s data gets), so a partial today never distorts a total.',
  'claimed / credited / attributed revenue': 'Revenue an ad platform or Redo assigns to itself. Several '
    + 'platforms can claim one order, so these overlap one another and overlap net sales. Not incremental, '
    + 'never summed, never added to net sales.',
  'claimed ROAS': 'A platform\'s own credited revenue divided by its spend, as the platform reports it. '
    + 'SILO does not verify it.',
  'MER': 'Marketing efficiency ratio: canonical online net sales divided by total paid ad spend for the same '
    + 'day. Measured by SILO from both sources, so unlike ROAS it does not depend on a platform\'s claim.',
  channel: 'Online, retail or wholesale, resolved through the company\'s own configured store mapping. An '
    + 'unconfigured channel returns no rows, which means not set up, never zero sales.',
  location: 'A single store or warehouse. Several locations can make up one channel.',
  'product type': 'The merchandising category stock and demand are planned at (e.g. a style family), one level '
    + 'above a product and well above a SKU. Buying decisions are made here.',
  SKU: 'A single variant: one product in one size or colourway.',
  'on hand / on order': 'On hand is stock in a location now. On order is units on open purchase orders, not '
    + 'yet arrived. They are always reported separately, so incoming stock can never hide a current shortage.',
  'weeks of cover': 'How many weeks the stock would last at a measured sales rate. "On-hand cover" counts '
    + 'stock in hand only; "cover incl. incoming" adds units on order. Blank cover means demand could not be '
    + 'measured, not that cover is infinite or zero.',
  momentum: 'The last 3 months\' sales rate against the last 12 months\', as a percentage. Above 100 is '
    + 'accelerating, below 100 is slowing.',
  'purchase order (PO)': 'An order placed on a factory. Open means not yet received, closed or cancelled. '
    + 'Arrival uses a logged shipment ETA where there is one and the PO\'s planned date otherwise.',
  launch: 'A dated product release on the Launch Calendar, with its own tasks and marketing initiatives.',
  initiative: 'A piece of marketing work attached to a launch.',
  'On Deck': 'SILO\'s drafting surface for proposed purchase orders. A draft is not a PO until a person '
    + 'accepts it.',
  Redo: 'The company\'s email, SMS and returns platform. Redo\'s own attribution is what "credited by Redo" '
    + 'means.',
  'journal entry': 'An accounting entry in SILO. It is drafted, approved, then posted to QuickBooks; those '
    + 'are three separate states and the close report counts each.',
  verified: '`verified: true` is one of SILO\'s own built-in reports, tied out against its sources every '
    + 'night. `verified: false` is a report someone in the company saved, which SILO has not checked at all. '
    + 'Prefer a verified report when one answers the question; when nothing built-in fits, search the saved '
    + 'ones (list_reports with kind "company") and say plainly that the number is not SILO-verified.',
};

/* ── Which report answers which question ───────────────────────────────────
 *
 * Written as the questions people actually ask, because that is what the
 * model is matching against. One report per answer wherever the data allows
 * it: the commonest failure is a bot stitching two reports together when one
 * already holds the answer.
 */
export const HOW_TO_CHOOSE = [
  { ask: 'How are sales doing? Are we up or down?', use: 'Sales vs Last Year',
    why: 'The only report that compares like with like. Daily Sales is a series, not a verdict.' },
  { ask: 'Sales day by day, or over a specific window', use: 'Daily Sales' },
  { ask: 'Online vs retail vs wholesale', use: 'Sales by Channel',
    why: 'Gross merchandise, refunds not netted. Do not read its revenue as net sales.' },
  { ask: 'Which store or warehouse', use: 'Sales by Location', why: 'Net sales, unlike Sales by Channel.' },
  { ask: 'What is selling', use: 'Top Products' },
  { ask: 'Are ads working? Is marketing paying for itself?', use: 'Marketing Efficiency',
    why: 'MER is measured by SILO from both sides. Reach for it before any platform\'s own ROAS.' },
  { ask: 'What is each platform spending and claiming', use: 'Ads by Platform' },
  { ask: 'Do the platforms\' claims add up against real sales?', use: 'Attribution vs Sales',
    why: 'The one report that frames claims against net sales correctly. Use its wording.' },
  { ask: 'Which ad or campaign is working', use: 'Creative Performance',
    why: 'Meta is per ad; Google Ads is campaign-level only, so its rows are not creatives.' },
  { ask: 'How is email and SMS doing', use: 'Email & SMS Performance',
    why: 'Per campaign. Use Email & SMS Revenue Trend for the daily shape.' },
  { ask: 'How is organic search doing', use: 'SEO Performance',
    why: 'Ends two days back by design. Site, page and query totals are three different grains and are never '
      + 'added together.' },
  { ask: 'What are we about to run out of?', use: 'Low Stock',
    why: 'Already filtered to the shortage. Stock Cover is the full picture, Inventory Summary the detail.' },
  { ask: 'What stock do we have', use: 'Inventory Summary',
    why: 'Total, by product type, and by SKU in one call (query_index 0, 1, 2).' },
  { ask: 'What are we sitting on? What is not selling?', use: 'Overstock',
    why: 'Stock Without Sales is the narrower cut: stock with no sales at all.' },
  { ask: 'When is stock arriving', use: 'Monthly Arrivals', why: 'Open Purchase Orders for PO by PO.' },
  { ask: 'What is late from the factories', use: 'Overdue Purchase Orders' },
  { ask: 'Which factory are we waiting on', use: 'PO Units by Factory' },
  { ask: 'What is on my plate? What is overdue?', use: 'Open work',
    why: 'Tasks, initiatives, payment requests and On Deck drafts in one list, with is_mine.' },
  { ask: 'What is launching soon', use: 'Launches next 30 days' },
  { ask: 'Are the books current? What is holding the close?', use: 'Accounting close status' },
];

/* ── Per-report advice, keyed by the report's stable id ─────────────────────
 *
 * Only where there is something to say that the report's own description does
 * not: what the report is FOR, and which report to prefer instead. Kept to a
 * sentence or two each, because this rides on every list_reports call.
 */
export const REPORT_NOTES = {
  // Sales
  'c3000000-0000-4000-a000-000000000001': {
    title: 'Sales vs Last Year',
    when_to_use:
      'Start here for "how are sales doing". It is the only report that compares a period with the same dates '
      + 'last year, so it is the one that can say up or down.',
  },
  '5110de50-0000-4000-a000-000000000001': {
    title: 'Daily Sales',
    when_to_use:
      'The daily series of net sales, units and orders. Use it for a window or a shape, not for a verdict on '
      + 'performance -- Sales vs Last Year does that.',
  },
  'c3000000-0000-4000-a000-000000000003': {
    title: 'Sales by Channel',
    when_to_use:
      'The online / retail / wholesale split. Its revenue and units are GROSS: refunds are not netted, so its '
      + 'total will not match net sales anywhere else. Say so if you quote it.',
  },
  '5110de50-0000-4000-a000-000000000003': {
    title: 'Sales by Location',
    when_to_use:
      'Net sales per store or warehouse. Use it when the question names a place; use Sales by Channel when it '
      + 'names a channel.',
  },
  '5110de50-0000-4000-a000-000000000002': {
    title: 'Top Products',
    when_to_use:
      'What sold, by product title. Its order count is summed product lines, not distinct orders, so never '
      + 'total it against Daily Sales orders.',
  },

  // Marketing
  'c3000000-0000-4000-a000-000000000006': {
    title: 'Marketing Efficiency',
    when_to_use:
      'The first marketing report to reach for. MER is measured by SILO from net sales and spend, so it does '
      + 'not depend on any platform\'s claim.',
  },
  'c3000000-0000-4000-a000-000000000004': {
    title: 'Ads by Platform',
    when_to_use:
      'Spend and each platform\'s own claims, side by side. The claims overlap each other, so the column total '
      + 'is not revenue and must not be added up as sales.',
  },
  'c3000000-0000-4000-a000-000000000005': {
    title: 'Attribution vs Sales',
    when_to_use:
      'Use this whenever someone asks whether the platforms\' numbers are real. It already frames claims '
      + 'against net sales correctly, including why the shares do not sum -- follow its wording rather than '
      + 'computing your own ratio.',
  },
  'c3000000-0000-4000-a000-00000000000a': {
    title: 'Creative Performance',
    when_to_use:
      'Ad- and campaign-level detail, with four result sets (platform, campaign, ad, daily). Meta reports per '
      + 'ad; Google Ads is campaign-level only, so Google rows are campaigns and are not comparable as '
      + 'creatives.',
  },
  'c3000000-0000-4000-a000-000000000008': {
    title: 'Email & SMS Performance',
    when_to_use:
      'Per Redo campaign and automation. Revenue is Redo\'s own credit and overlaps other channels; it is '
      + 'never added to ad claims or to net sales.',
  },
  'c3000000-0000-4000-a000-000000000009': {
    title: 'Email & SMS Revenue Trend',
    when_to_use:
      'The daily shape of the same Redo credit. The latest days are still filling in for weeks, so do not read '
      + 'the tail as a decline.',
  },
  'c3000000-0000-4000-a000-00000000000b': {
    title: 'SEO Performance',
    when_to_use:
      'Google Search Console, four result sets: site total, daily trend, pages, queries. The three grains are '
      + 'counted differently and are never added together, and query rows cover only part of clicks because '
      + 'Google withholds the rest.',
  },

  // Inventory
  'c1000000-0000-4000-a000-000000000006': {
    title: 'Low Stock',
    when_to_use:
      'The shortage list, already filtered. Reach for it before Stock Cover when the question is what to '
      + 'reorder.',
  },
  'c1000000-0000-4000-a000-000000000005': {
    title: 'Stock Cover',
    when_to_use:
      'Every product type with its cover, including the ones Low Stock filters out. Blank cover is unknown '
      + 'demand, not plenty.',
  },
  'c1000000-0000-4000-a000-000000000001': {
    title: 'Inventory Summary',
    when_to_use:
      'The whole stock picture in three result sets: total (0), by product type (1), by product and SKU (2). '
      + 'Read the total\'s blank-cover reasons before quoting a company-wide number.',
  },
  'c1000000-0000-4000-a000-000000000007': {
    title: 'Overstock',
    when_to_use:
      'Where cash is sitting in stock. Its Declining option is the version of the question people usually '
      + 'mean.',
  },
  'c1000000-0000-4000-a000-000000000008': {
    title: 'Stock Without Sales',
    when_to_use:
      'The narrow cut: stock with no sales in the source\'s rolling 30-day window. It is not a write-off '
      + 'recommendation and does not measure stock age.',
  },

  // Purchasing
  '5110de50-0000-4000-a000-000000000004': {
    title: 'Open Purchase Orders',
    when_to_use:
      'PO by PO, soonest arrival first. Monthly Arrivals is the same units rolled up by month.',
  },
  'c1000000-0000-4000-a000-000000000003': {
    title: 'Monthly Arrivals',
    when_to_use:
      'What is coming and when, by month. The quickest answer to "when does stock land".',
  },
  'c1000000-0000-4000-a000-000000000002': {
    title: 'Overdue Purchase Orders',
    when_to_use:
      'What has slipped, measured against a logged shipment ETA where there is one. Check arrival_state before '
      + 'telling anyone a PO is late.',
  },
  'c1000000-0000-4000-a000-000000000004': {
    title: 'PO Units by Factory',
    when_to_use:
      'Exposure by factory. Useful for "who are we waiting on", not for a single PO.',
  },

  // Operations and accounting
  'c7000000-0000-4000-a000-000000000001': {
    title: 'Open work',
    when_to_use:
      'Everything open across tasks, launch initiatives, payment requests and On Deck drafts, with is_mine for '
      + 'the connected person. This is the report behind "what is on my plate". It shows only what that person '
      + 'is allowed to see, so it is not a company-wide count.',
  },
  'c7000000-0000-4000-a000-000000000002': {
    title: 'Launches next 30 days',
    when_to_use:
      'What is launching, and whether it is ready. Open, overdue and blocked counts come with each row, so '
      + 'there is no need to go hunting in Open work.',
  },
  'c7000000-0000-4000-a000-000000000003': {
    title: 'Accounting close status',
    when_to_use:
      'What is holding the books: uncategorised bank and card rows, and journal entries awaiting approval or '
      + 'posting. Drafted, approved and posted are three states -- do not collapse them.',
  },
};

/* ── Where things are in SILO ───────────────────────────────────────────────
 *
 * A bot is asked "where do I do X in SILO" at least as often as it is asked
 * for a number, and over MCP it has nothing to answer with -- it cannot see
 * the app. This is the sidebar, written out: the page, what it is for, and
 * its path.
 *
 * It is NOT an access list. Which pages a person sees depends on their role,
 * their department, grants and which workspace they are in, and the real
 * boundary is RLS rather than the menu, so each entry is a pointer and never a
 * promise. Paths are relative on purpose: every customer reaches SILO at their
 * own address.
 *
 * Tenant-neutral by construction -- it is one codebase's own menu, not
 * Baseballism's. Pages SILO staff use, and pages deliberately kept out of the
 * menu, are left out. scripts/tests/mcp-guide.test.mjs checks every path
 * against the repository and every page and section against v2/nav-config.js,
 * so a renamed or retired page shows up as a failing test rather than as a
 * bot sending someone to a dead link.
 */
export const WHERE_IN_SILO = {
  note: 'SILO\'s own pages. Join a path to the address the person uses for SILO. What someone can open '
    + 'depends on their role, department, grants and workspace, so offer the page rather than promising '
    + 'access, and never state what another person is allowed to see.',
  pages: [
    { section: 'Start', page: 'Home', path: '/v2/finance.html', what: 'The workspace home page and the way into every area.' },
    { section: 'Start', page: 'Setup', path: '/v2/setup-checklist.html', what: 'A new workspace\'s setup checklist: what is connected and what is still missing.' },
    { section: 'Start', page: 'My Profile', path: '/v2/profile.html', what: 'Your own details.' },
    { section: 'Start', page: 'Help', path: '/v2/help.html', what: 'SILO\'s help and training pages.' },

    { section: 'Ask SILO', page: 'Ask SILO', path: '/v2/silo-chat.html', what: 'Ask a question in plain language; SILO writes and runs a read-only query and can save the answer as a report.' },

    { section: 'Insights', page: 'On Deck', path: '/v2/on-deck.html', what: 'Purchase orders SILO has drafted, waiting for a person to review, accept or dismiss.' },
    { section: 'Reports', page: 'Reports', path: '/v3/dashboards.html', what: 'The report library and dashboards -- SILO\'s own reports and the ones people here have saved.' },
    { section: 'Reports', page: 'Report builder', path: '/v3/report-builder.html', what: 'Build and save a report, and set its parameters.' },

    { section: 'Accounting', page: 'Accounting', path: '/v2/transactions.html', what: 'Bank and card transactions: coding them, and the journal entries that follow.' },
    { section: 'Accounting', page: 'Customers', path: '/v2/customers.html', what: 'Customers and the invoices raised to them.' },

    { section: 'Requests', page: 'Payment Request', path: '/v2/purchase_request2.html', what: 'Raise a request to pay someone or to be reimbursed.' },
    { section: 'Requests', page: 'Request Manager', path: '/v2/request_manager.html', what: 'Review, approve and follow payment requests. A single request opens at ?request=<id>.' },
    { section: 'Requests', page: 'Mailroom', path: '/v2/mailroom.html', what: 'Post and documents that have arrived, and mail intake.' },

    { section: 'Planning', page: 'Org Calendar', path: '/v2/calendar.html', what: 'The company-wide calendar.' },
    { section: 'Planning', page: 'Revenue Projection', path: '/v2/projections.html', what: 'Revenue projections.' },
    { section: 'Planning', page: 'Planning scenarios', path: '/v2/planning-scenarios.html', what: 'Planning scenarios, side by side.' },
    { section: 'Planning', page: 'Launch calendar', path: '/v2/launch-calendar.html', what: 'The Launch Workbench: each dated launch with its tasks and marketing initiatives.' },
    { section: 'Planning', page: 'Task Manager', path: '/v2/tasks.html', what: 'Tasks: raising them, assigning them and following them.' },
    { section: 'Planning', page: 'TikTok Live Schedule', path: '/v2/live-schedule.html', what: 'The TikTok live schedule.' },

    { section: 'Team', page: 'Performance Reviews', path: '/v2/reviews.html', what: 'Performance reviews.' },
    { section: 'Team', page: 'My Reviews', path: '/v2/my-review.html', what: 'Your own reviews.' },
    { section: 'Team', page: 'Compensation', path: '/v2/comp-requests.html', what: 'Compensation requests.' },

    { section: 'Purchasing', page: 'PO Builder', path: '/v2/po-builder.html', what: 'Build a purchase order.' },
    { section: 'Purchasing', page: 'PO Landed Cost', path: '/v2/po-costing.html', what: 'A purchase order\'s landed cost.' },
    { section: 'Purchasing', page: 'PO Report', path: '/v2/po-report.html', what: 'Incoming purchase orders, their arrivals and their shipment bookings.' },
    { section: 'Purchasing', page: 'Factories', path: '/v2/factories.html', what: 'The factories purchase orders are placed with.' },

    { section: 'Inventory', page: 'Inventory Manager', path: '/v2/inventory.html', what: 'Stock by product and location, with filters.' },
    { section: 'Inventory', page: 'Products', path: '/v2/products.html', what: 'The product catalogue.' },
    { section: 'Product & inventory', page: 'Product Studio', path: '/v3/product-workflow.html', what: 'Where a product concept is confirmed and marked Ready for PO, which is the way a concept becomes a draft purchase order.' },

    { section: 'Marketing', page: 'Performance', path: '/v2/marketing-overview.html', what: 'Marketing Performance: spend, platform claims and sales together.' },
    { section: 'Marketing', page: 'Explorer', path: '/v2/marketing-explorer.html', what: 'Marketing Explorer: the same data, to dig through.' },
    { section: 'Marketing', page: 'Marketing Report', path: '/v2/wow-report.html', what: 'The Marketing Report: day, week, month-to-date and year-to-date.' },
    { section: 'Marketing', page: 'Silo Attribution', path: '/v2/silo-attribution.html', what: 'SILO\'s own attribution, next to what the platforms claim.' },
    { section: 'Marketing', page: 'Ad Studio', path: '/v2/ad-studio.html', what: 'Past ads as the bar a new one has to beat, and the idea bank where ideas are drafted and moved from idea to live.' },
    { section: 'Marketing', page: 'SEO', path: '/v2/seo-studio.html', what: 'SEO Studio: search performance and keywords.' },

    { section: 'Sales', page: 'Sales Performance Overview', path: '/v2/bi-sales-overview.html', what: 'Compare sales performance across locations and periods.' },
    { section: 'Sales', page: 'Daily Sales Trend', path: '/v2/bi-daily-trend.html', what: 'Daily sales with prior-year comparisons and a seven-day average.' },
    { section: 'Sales', page: 'Top Sellers', path: '/v2/bi-top-sellers.html', what: 'Products ranked by sales alongside stock, velocity and days of cover.' },
    { section: 'Sales', page: 'Product Type Performance', path: '/v2/bi-product-types.html', what: 'Product categories by month, then their products.' },
    { section: 'Sales', page: 'Product Search', path: '/v2/bi-product-search.html', what: 'Sales by product name or SKU, with store and month breakdowns.' },
    { section: 'Sales', page: 'Sales Report', path: '/v2/sales-verification.html', what: 'Sales records, and exceptions such as blank SKUs or negative net sales.' },

    { section: 'Settings', page: 'Workspace settings', path: '/v2/settings-company.html', what: 'The workspace: people, connections, billing, and Connect AI -- the address and setup steps for pointing your own assistant at SILO.' },
  ],
};

/* ── The tools ─────────────────────────────────────────────────────────────*/

export const GUIDE_TOOL_NAME = 'how_to_use_silo';

/* The third tool. Its description has to earn the call, because a model that
   does not call it answers from guesses -- so it says what it prevents, not
   what it contains. */
export const GUIDE_TOOL = {
  name: GUIDE_TOOL_NAME,
  title: 'How to use SILO',
  description: 'Read this before answering a question with SILO data, once per conversation. Returns SILO\'s '
    + 'glossary (what net sales, cover, momentum, product type, a company-calendar day and "credited" revenue '
    + 'mean here), a table matching the questions people ask to the report that answers each one, and a note '
    + 'per report saying what it is for and which report to prefer instead. It also maps SILO\'s own pages -- '
    + 'what each one is for and its path -- so a question about where something lives in the app, or what a '
    + 'page does, can be answered. Without it the usual mistakes are adding up revenue several ad platforms '
    + 'each claim, reading a blank day as a zero, picking a report that measures something adjacent to the '
    + 'question, and inventing a page. Takes no arguments, reads no data.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
};

const TOOL_NOTES = {
  list_reports: 'Each report\'s description carries its own caveats: read them, and read '
    + GUIDE_TOOL_NAME + ' for which report to choose.',
  run_report: 'Prefer one report\'s own answer over combining reports. A blank measure means that source '
    + 'had no rows for that day, never zero, and revenue a platform or Redo "claims", "credits" or '
    + '"attributes" overlaps other sources and net sales, so it is never summed.',
};

/**
 * The tool list a client is shown: the server's own tools, each with the
 * guidance a model needs while it is choosing one, and the guide beside them.
 */
export function toolsWithGuide(tools) {
  const described = (Array.isArray(tools) ? tools : []).map((t) => {
    const note = TOOL_NOTES[t && t.name];
    return note ? { ...t, description: t.description + ' ' + note } : t;
  });
  return [...described, GUIDE_TOOL];
}

/** What how_to_use_silo answers. Static: no token, no scope, no data. */
export function buildGuide() {
  return {
    version: GUIDE_VERSION,
    how_to_choose: HOW_TO_CHOOSE,
    glossary: GLOSSARY,
    reports: Object.entries(REPORT_NOTES).map(([id, r]) => ({ id, ...r })),
    where_in_silo: WHERE_IN_SILO,
  };
}
