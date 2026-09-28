// silo-chat -- authenticated (verify_jwt on, default): a "wide open, ask
// anything about our data" chat. Claude gets four tools -- run_sql (backed
// by the chat_run_readonly_query(text) RPC from
// 20260813180000_silo_chat_readonly_query.sql), save_note (a plain
// insert into silo_chat_notes, RLS-gated by can_manage_silo_notes() -- see
// 20260813210000_silo_chat_notes.sql and 20260813230000_silo_chat_managers.sql),
// web_search (Anthropic's hosted server tool -- runs entirely on
// Anthropic's own infrastructure, no execution code here, for
// public/external knowledge: competitors, industry benchmarks, this
// brand's own public site), and view_ad_creative_image (fetches a Meta
// ad's thumbnail via its own thumbnail_url and returns it as an image
// block, for visual-design questions the text fields in
// meta_ad_creatives can't answer).
// This function forwards the caller's own JWT to Supabase (never the
// service-role key) so every query/insert/lookup the model runs executes
// AS that user. Postgres RLS is the actual data boundary: a user can never
// see through this chat anything they couldn't already see by
// hand-querying from the browser, regardless of what SQL the model
// writes, and only exec/owner-tier users (or anyone specifically granted
// Ask SILO access via backend.html) can teach it a new note no matter what
// the model is told to do. web_search is the one deliberate exception to
// "SILO data only" -- see the "Internal data vs. public web knowledge"
// paragraph in prompt-lib.mjs's CORE_BEFORE_SCHEMA for how its results are kept
// clearly separate from real SILO numbers. Schema facts are NOT written
// in this file anymore: they come from silo_chat_schema_catalog
// (auto-generated columns + curated descriptions -- see
// 20260821210000_silo_chat_schema_catalog.sql and buildSchemaSection
// below).
//
// Product Concepts (create/update/approve_product_concept, writing to the
// new product_concepts table) is a fifth, in-testing capability gated to
// PRODUCT_CONCEPT_TESTERS below -- only those callers get the extra tools
// and system-prompt block. Like everything else here it runs through
// callerClient, so RLS on product_concepts is still the real boundary.
// Reference-image upload rides on top of it: the client uploads to the
// public product-concept-images bucket itself and sends the resulting
// URL(s) as an `imageUrls` field alongside a history entry's `content`
// (content itself stays plain text everywhere -- see the messages mapping
// inside Deno.serve below). No fetch/base64 tool needed here since
// Anthropic's image blocks accept
// a public URL directly.
// Every concept can produce a full launch brief (Loomis note, 2026-08-21):
// size-spread qty breakdown, channel/retail split, launch day+time,
// marketing spend by platform, weekly revenue projection per channel,
// email/SMS cadence, and draft marketing copy -- see
// PRODUCT_CONCEPT_GUIDANCE (prompt-lib.mjs) and 20260821160000_product_concept_launch_plan_fields.sql.
// PO creation is the 8th item on that list; it's covered separately by
// resulting_po_header_id (20260821140000), not a draft-time field here.
// This is split into two phases, not generated all at once: phase 1 is the
// fast core draft (create_product_concept -- title/angle/qty/factory/
// channels/timing), phase 2 is the launch-plan fields above, only run once
// the user explicitly asks to build it out (via update_product_concept).
// Doing both in one pass was observed live burning the full 20-round tool
// budget and running long enough to risk a client-side timeout -- see
// PRODUCT_CONCEPT_GUIDANCE (prompt-lib.mjs)'s "PHASE 1"/"PHASE 2" split.
// Collections (20260821170000_product_concept_collections.sql): most
// releases are a themed drop of a few products sharing one strategic
// brief, not one product at a time. product_concepts.parent_concept_id is
// a self-referencing FK -- a parent concept (unset) holds the shared
// angle/audience/timing/spend/copy, a child concept (set) holds only what's
// genuinely per-product (title/qty/factory/size). See
// PRODUCT_CONCEPT_GUIDANCE (prompt-lib.mjs)'s "COLLECTIONS" section.
// Evidence-discipline rules (2026-09-08): an SEO answer concluded eight
// Shopify collections "don't exist" because they weren't in a LIMIT 30
// query over shopify_landing_pages_daily -- a table that is ITSELF a
// top-250-per-day slice, holding 42 days of history rather than the 60
// asked for, and which records landing SESSIONS rather than what exists.
// For baseballism.myshopify.com, the only shop with real web traffic,
// all 42 of 42 days hit the cap; the 17 retail/popup shops never do (1-2
// paths a day), which is why the row-level figure (10,553 of 10,763
// truncated) and the day-level one disagree -- a capped day contributes
// 250 rows, a POS day contributes one. The same answer read our
// campaign-grain Google Ads sync as proof Google Ads has no category
// reporting, and recommended top sellers without checking stock. None of
// those are query bugs: each turns "absent from what I fetched" into "not
// real". The four EVIDENCE DISCIPLINE rules in the prompt core (prompt-lib.mjs)
// address them, plus a "Not ingested" confidence state separating OUR
// grain from a PROVIDER's capability. Note the closest existing rule,
// "ABSENCE OF HISTORY IS NOT EVIDENCE AGAINST", lives in
// PRODUCT_CONCEPT_GUIDANCE (prompt-lib.mjs) and so only ever reached concept-mode
// testers -- the generalized version had to go in the BASE prompt to
// reach ordinary questions. The simplification rule is there because the
// caveat surviving the first answer is worth nothing if "simplify that"
// strips it on the second.
// Truncation + nudge-enforcement fix (2026-08-21): a live holiday-collection
// draft shipped a mid-word-truncated answer to the user -- max_tokens was
// 4096 and stop_reason was never checked, so a cut-off (but non-empty)
// answer was treated as finished. Fixed in callAnthropic/the main loop and
// the round-cap forced-answer fallback: both now detect stop_reason ===
// 'max_tokens' and continue instead of returning the fragment, and
// max_tokens is raised to 8192. The same trace also showed the
// PRE_DRAFT_NUDGE_ROUND circuit breaker being answered with prose instead
// of the tool call it demanded -- forceNudgeTool now sets tool_choice to
// force create_product_concept on the very next round instead of asking.
// Structured concept workflow (20260825120000): concepts now carry a real
// brief (objective/economics/forecast/risks/recommendation/next_decision)
// plus per-field evidence classification -- INPUT/DATA/ASSUMPTION/
// RECOMMENDATION with a qualitative strong/moderate/early strength, never
// a fake confidence percentage -- and provenance for "why did SILO
// recommend 1,800 units?". See STRUCTURED_CONCEPT_FIELDS. Refinement is
// now a REVISION of the existing row (a DB trigger snapshots the prior
// state into product_concept_revisions on every update) rather than a
// second stamped concept, which is what used to make a single idea look
// like four unrelated ones. The response gained an additive `concepts`
// field carrying the rows touched this turn so the client can render the
// structured card; a non-concept question omits it entirely and every
// other part of this function's behavior is unchanged.
// Evidence scope (2026-09-16): two traced answers ran correct SQL and
// published the figures under labels the SQL never supported -- a week of ad
// spend pooled across every platform called "Meta spend" and then divided by
// Meta's own attributed value; a weekly bucket starting 31 August called "the
// week after the 1 September launch"; ads selected by today's creative copy,
// spanning two campaigns, described as one campaign changing behaviour. None
// of those is an arithmetic bug and none is fixed by more prompt text alone:
// by the time the answer is written the model is looking at a dozen anonymous
// JSON arrays and has to REMEMBER which one was scoped to what. So it no
// longer has to. evidence-scope.mjs derives, from the statement and the
// catalog's auto-generated column lists, what each result is and is not
// restricted to, and run_sql returns it WITH the rows. Three things ride
// alongside: describe_relations, because the schema detail slice is ranked on
// the opening question's words and frozen for the request (it must be -- it is
// the cached prompt prefix) while an investigation moves; a budget-exhausted
// instruction that asks for supported findings AND named unfinished checks
// instead of "answer anyway"; and silo_chat_audit_log.diagnostics, which
// records query outcomes and context selection -- never result rows -- so the
// next mismatch can be diagnosed from the record instead of by re-running
// statements against data that has since changed. See
// docs/ops/ask-silo-evidence-scope.md.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { encodeBase64 } from 'jsr:@std/encoding/base64';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const MODEL = Deno.env.get('CHAT_MODEL') || 'claude-sonnet-5';

// Product Concepts (Ask SILO's product-generation branch -- see the
// 2026-08-21 planning thread) is still being built and tested. Gating it
// to specific emails keeps the new tools and suggested-question flow
// invisible to the rest of the team while it's exercised. Once it's ready
// for everyone, delete this constant and the two `conceptsEnabled` checks
// below rather than widening the list.
const PRODUCT_CONCEPT_TESTERS = ['blake@baseballism.com'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}


import {
  MAX_PAGE_INSPECTIONS_PER_REQUEST,
  createInspectionBudget,
  looksInspectable,
} from './seo-lib.mjs';
import {
  correctionRoundFits,
  modelCallTimeoutMs,
  MIN_FINAL_CALL_MS,
  QUERY_CEILING_MS,
} from './budget-lib.mjs';
import {
  auditAnswerClaims,
  buildCatalogIndex,
  describeEvidenceScope,
  formatClaimNote,
  relationsInStatement,
  renderQueryResult,
} from './evidence-scope.mjs';
import { buildSystemBlocks, selectGuidance } from './prompt-lib.mjs';
import { rewriteSlowShapes, timeoutHint } from './query-shape-lib.mjs';
import {
  BUSY_STATUSES,
  isSpendLimitResponse,
  parseRetryAfter,
  providerErrorCode,
  pickUsage,
  retryDecision,
  sumUsage,
} from './provider-lib.mjs';

const TOOLS = [
  {
    name: 'run_sql',
    description: 'Execute a single read-only Postgres SELECT or WITH statement against the SILO database. Returns { evidence_scope, rows }: evidence_scope is derived from your statement and the schema map and states what the rows are and are NOT restricted to -- which platform/campaign/channel/location values it is narrowed TO, which it EXCLUDES, which are broken out per value or pooled together, which dimensions the relation has no column for at all, what the date predicates actually bound (a window only when both ends are), and whether the result hit the per-page row cap. Read it before using a figure; it is what stops a number being published under a label the query never supported. Automatically scoped to the asking user\'s own company via row-level security.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A single SELECT or WITH statement, no semicolon.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'describe_relations',
    description: "Get the FULL schema-map card -- every column with its type, the curated business meaning, and the MEASURED date coverage -- for tables or views you are already working with. The map in your system prompt only carries full columns for the handful of relations that matched the question's own wording; everything else is a one-line entry, and an investigation reliably ends up somewhere the opening question never named. Call this the moment you are about to query, join or draw a conclusion from a relation you only have a one-liner for -- especially before any claim about what a relation does or does not contain, or how far back it goes. Ask for the relations you are ACTUALLY using; it is not a browser. Up to 6 names per call, 3 calls per question.",
    input_schema: {
      type: 'object',
      properties: {
        relations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact table/view names as they appear in the database map, up to 6.',
        },
      },
      required: ['relations'],
    },
  },
  {
    name: 'save_note',
    description: 'Record a piece of taught knowledge so future questions account for it. Use category "brand" for foundational brand identity/voice/positioning (e.g. a tagline, target customer, brand personality). Use category "general" (the default -- omit it) for a specific correction/fact about the data (e.g. "Pin of Month is a one-time monthly drop, not a restock signal"). Restricted to users with Ask SILO management access (exec/owner-tier, or anyone specifically granted access) -- the insert is RLS-gated, not something this tool bypasses.',
    input_schema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The fact/correction to remember, written as a standalone sentence future questions can rely on.' },
        category: { type: 'string', enum: ['general', 'brand', 'strategy'], description: 'Defaults to "general" if omitted. Use "brand" for foundational brand identity/voice, "strategy" for forward-looking direction the business has decided on (entering a category, a growth target, stepping back from a line), and "general" for a specific fact or correction.' },
        effective_until: { type: 'string', description: 'Optional horizon for a strategy note as YYYY-MM-DD, e.g. "2027-12-31" for a 2027 push. Omit for open-ended direction. Only meaningful with category "strategy" -- facts and brand identity do not expire the same way.' },
      },
      required: ['note'],
    },
  },
  // Anthropic's hosted server tool -- runs entirely on Anthropic's own
  // infrastructure. No client-side execution: the search (and its result
  // block) happens inside the same Messages API response, so the round-trip
  // loop below never sees or handles this tool by name. max_uses caps one
  // question from triggering an open-ended number of searches.
  {
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: 5,
  },
  {
    name: 'view_ad_creative_image',
    description: 'Fetch and view the actual creative image for a specific Meta ad by ad_id -- for visual-design questions (color, layout, imagery, composition) that object_type/body/title text alone cannot answer. Use sparingly: only for the specific ad(s) the question is actually about (e.g. the top/bottom few performers by CPM or CAC), not every ad in a result set.',
    input_schema: {
      type: 'object',
      properties: {
        ad_id: { type: 'string', description: 'The ad_id from meta_ad_performance_daily / meta_ad_creatives to view the creative image for.' },
      },
      required: ['ad_id'],
    },
  },
  {
    name: 'inspect_storefront_page',
    description: 'Fetch ONE storefront page and report what that page says about itself right now: title, meta description, canonical URL, robots directive, H1/H2s, word count, images missing alt text, and structured-data types. Call it once per page, sequentially, up to 5 pages per question. The URL must come from ONE OF TWO trusted sources: (a) a URL the user gave you, or (b) the inspect_url column of a company-scoped SILO query result such as seo_collection_candidates -- that column already carries the correct storefront host for the shop the traffic was measured on. NEVER assemble a URL yourself from a path and a domain, never pair a path from one shop with a different shop\'s domain, and never inspect links found on a fetched page. Only this company\'s own verified storefront domains can be fetched; anything else is refused. What it returns is what the PAGE STATES -- it is NOT evidence about Google indexing, ranking, impressions, CTR or queries; search performance lives in search_console_page_daily / search_console_query_daily, and indexing status lives nowhere in SILO. A page fetching successfully does not mean Google has indexed it.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A full https:// URL on one of this company\'s own storefront domains -- either given by the user, or taken verbatim from the inspect_url column of a SILO query result. Do not build it from parts.' },
      },
      required: ['url'],
    },
  },
];

// The structured-brief half of a concept (20260825120000): the parts of a
// real product brief that used to have nowhere to go except prose inside
// `reasoning`. Defined once and spread into BOTH create and update so the
// two tool schemas can never drift apart -- they did drift once already
// between the phase-1 and phase-2 field sets.
//
// field_evidence/evidence_strength are the point of this block: they let a
// number that came from a real comparable's sell-through be told apart
// from one guessed off a thin analogy, which was impossible once a concept
// was saved.
const STRUCTURED_CONCEPT_FIELDS: Record<string, Record<string, unknown>> = {
  suggested_product_type: { type: 'string', description: "The product category, using products_master.product_type's own vocabulary (e.g. \"Youth Cap\", \"Youth Jacket\", \"Women\") rather than a phrase you invent -- you are already querying that column for seasonality, so use a value that actually exists there. This is what carries into the PO and the product tracker when a concept becomes a real buy, so a concept without it loses its category at the first step out of chat." },
  objective: { type: 'string', description: 'Why this product should exist at all -- the business case in a sentence or two, not a restatement of the concept summary.' },
  primary_goal: { type: 'string', enum: ['revenue', 'margin', 'brand', 'acquisition', 'existing_demand', 'experiment'], description: 'The single main goal this product serves. Pick the one that actually drives it; omit if genuinely unclear.' },
  secondary_audience: { type: 'string', description: 'A secondary audience, only if there is a real one -- omit rather than padding.' },
  audience_rationale: { type: 'string', description: 'Why this audience/use case, grounded in what you queried (past launch audience_tags, who actually bought comparables).' },
  historical_evidence: {
    type: 'array',
    items: { type: 'object' },
    description: 'The specific historical evidence you actually consulted, one entry per item, e.g. [{"label":"Youth food shorts","metric":"units, first 90 days","value":"2400","source":"sales_by_day","strength":"strong"}]. Only real queried results belong here -- never invent an entry to make the list look fuller, and leave the array out entirely if nothing comparable exists.',
  },
  evidence_strength: { type: 'string', enum: ['strong', 'moderate', 'early'], description: 'Overall qualitative confidence in the concept: "strong" = direct historical SKU/sales evidence; "moderate" = reasonable inference from adjacent data; "early" = mostly thesis, comparables are weak or absent. Never express this as a percentage -- the column rejects one.' },
  buy_rationale: { type: 'string', description: 'Why suggested_qty is that number and not another -- name the comparable and the figure it came from.' },
  supply_notes: { type: 'string', description: 'Production/lead-time considerations for this factory and product type.' },
  supply_constraints: { type: 'string', description: 'Known supply constraints or dependencies (MOQ, lead time vs. launch date, single-source risk).' },
  economics: { type: 'object', description: 'Unit economics where supported by data, e.g. {"unit_cost":12.40,"msrp":48,"gross_margin_pct":74,"inventory_investment":22320,"revenue_expectation":86400}. Omit ANY key you cannot ground -- a missing key means "unavailable" and is the correct output; a guessed cost is not.' },
  forecast: { type: 'object', description: 'Three-scenario forecast with the assumption behind each, e.g. {"conservative":{"units":900,"revenue":43200,"assumptions":"..."},"base":{...},"upside":{...}}. State the assumption that separates the scenarios, not just three numbers.' },
  creative_story: { type: 'string', description: 'The core creative story -- distinct from marketing_angle (the one-line hook) and suggested_marketing_copy (draft copy).' },
  visual_direction: { type: 'string', description: 'Visual/design direction. Reference any attached inspiration images here when they informed it.' },
  brand_fit: { type: 'string', description: 'Why this fits the brand and customer, grounded in taught brand context rather than generic praise.' },
  risks: { type: 'array', items: { type: 'object' }, description: 'Risks and unknowns, e.g. [{"category":"data","detail":"no comparable launch has week-level revenue"}]. Categories worth using: data, comparable, assumption, dependency, timing, licensing, forecast.' },
  unknowns: { type: 'array', items: { type: 'object' }, description: 'Template fields you deliberately left blank and why, e.g. [{"field":"economics.unit_cost","why":"no prior PO for this factory + product type"}]. Fill this in rather than quietly omitting a field -- an explicit unknown is a valid, useful answer; a fabricated value is not.' },
  recommendation: { type: 'string', enum: ['proceed', 'proceed_with_changes', 'refine', 'hold', 'reject'], description: 'Your overall call on the concept.' },
  recommendation_reasoning: { type: 'string', description: 'Concise reasoning for that call -- two or three sentences.' },
  next_decision: { type: 'string', description: 'The next HUMAN decision needed to move this forward, e.g. "Approve opening buy", "Confirm factory", "Wait for the Snack Shack actuals". Always fill this in -- a concept with no identified next decision is not finished.' },
  field_evidence: {
    type: 'object',
    description: 'Per-field evidence classification, keyed by the concept column name, e.g. {"suggested_qty":{"class":"RECOMMENDATION","strength":"moderate","note":"derived from youth cap 90-day sell-through"},"title":{"class":"INPUT"}}. class is one of INPUT (the user told you), DATA (a real queried SILO figure), ASSUMPTION (needed for planning, not directly supported), RECOMMENDATION (your own derived judgment). Classify at least the values a reviewer would question -- suggested_qty, suggested_launch_date, suggested_factory_id, and anything in economics/forecast.',
  },
  provenance: {
    type: 'array',
    items: { type: 'object' },
    description: 'What backed each significant claim, so "why did SILO recommend 1,800 units?" is answerable later, e.g. [{"claim":"suggested_qty","tables":["sales_by_day","launch_calendar"],"date_range":"2025-09-01..2026-08-01","metrics":["units_90d"],"skus":["YTH-CAP-001"],"note":"..."}]. Record the source tables and date ranges you actually queried -- not raw SQL.',
  },
};

// The launch-plan fields that define phase 2. Writing any of them is what
// moves a concept from 'core_draft' to 'full_brief' (20260825140000) --
// phase is inferred from content rather than asserted, so the row can
// never claim a completeness it does not have.
const PHASE_2_FIELDS = [
  'suggested_size_breakdown', 'suggested_channel_split', 'suggested_marketing_spend',
  'suggested_weekly_revenue_projection', 'suggested_email_sms_plan',
  'suggested_marketing_copy', 'economics', 'forecast',
];

// Column names accepted by update_product_concept, kept next to the schema
// so adding a field is a one-place change.
const CONCEPT_UPDATABLE_FIELDS = [
  'title', 'concept_summary', 'marketing_angle', 'audience', 'audience_tags',
  'suggested_qty', 'suggested_factory_id', 'suggested_channels',
  'suggested_retail_dtc_notes', 'suggested_launch_date', 'suggested_launch_notes',
  'suggested_launch_time', 'suggested_size_breakdown', 'suggested_channel_split',
  'suggested_marketing_spend', 'suggested_weekly_revenue_projection',
  'suggested_email_sms_plan', 'suggested_marketing_copy',
  'reasoning', 'notes', 'reference_image_urls', 'parent_concept_id',
  ...Object.keys(STRUCTURED_CONCEPT_FIELDS),
  'revision_note',
];

// Product Concepts write tools -- only appended to the request's tool list
// for PRODUCT_CONCEPT_TESTERS (see above). Deliberately narrow, single-
// purpose inserts/updates against product_concepts, same philosophy as
// save_note: no general-purpose write tool, one tool per real action.
// Reads don't need a dedicated tool -- product_concepts_v is just another
// view run_sql can already query.
const PRODUCT_CONCEPT_TOOLS = [
  {
    name: 'create_product_concept',
    description: 'Create a new draft product concept -- the first artifact in the product-generation flow, before any PO exists. Call this once you and the user have landed on enough of a direction to draft (title + at least a rough angle/qty), not on the very first message. This is the phase 1 (fast core draft) call -- leave suggested_size_breakdown/suggested_channel_split/suggested_marketing_spend/suggested_weekly_revenue_projection/suggested_email_sms_plan/suggested_marketing_copy/suggested_launch_time unset here even if you could guess at them; those are phase 2 fields, filled in later via update_product_concept only after the user asks to build out the full launch-plan brief. After creating it, show the user the draft clearly and ask whether they want the full plan built out next.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Working product title/name.' },
        concept_summary: { type: 'string', description: 'One or two sentence pitch of the idea.' },
        marketing_angle: { type: 'string', description: 'The creative story/angle, in the style of launch_calendar.marketing_angle.' },
        audience: { type: 'string', description: 'Free-text audience description.' },
        audience_tags: { type: 'array', items: { type: 'string' }, description: 'Structured audience segment tags, in the style of launch_calendar.audience_tags.' },
        suggested_qty: { type: 'integer', description: 'Suggested buy quantity, reasoned from comparable past launches -- cite what you compared it to in reasoning.' },
        suggested_factory_id: { type: 'string', description: 'UUID of a row in factories, chosen by looking at which factory has actually produced this product type before (query po_lines joined to po_headers). Omit if no clear precedent exists -- do not guess.' },
        suggested_channels: { type: 'array', items: { type: 'string' }, description: 'Suggested marketing channels, e.g. ["email","instagram","tiktok"].' },
        suggested_retail_dtc_notes: { type: 'string', description: 'Suggested retail vs. DTC/online split and why, grounded in locations.store_type sell-through for comparable products.' },
        suggested_launch_date: { type: 'string', description: 'Suggested launch date (YYYY-MM-DD), reasoned from products_master seasonality (peak_start_month/peak_end_month) for this product type when available.' },
        suggested_launch_notes: { type: 'string', description: 'Short note on why that timing.' },
        suggested_launch_time: { type: 'string', description: 'Suggested day-of-week and time-of-day for the launch (e.g. "Thursday 9:00am PT"), reasoned from when comparable past launches actually went live if that pattern is visible, otherwise a reasonable default with the assumption stated.' },
        suggested_size_breakdown: { type: 'object', description: 'Units by size, e.g. {"S":40,"M":120,"L":100,"XL":40} -- should sum to suggested_qty. Ground it in the historical size curve of a comparable past product (shopify_order_lines or po_lines.variant_title_snapshot), not an even split.' },
        suggested_channel_split: { type: 'object', description: 'Percentage allocation across DTC channels and retail, e.g. {"meta_ads":25,"tiktok_ads":20,"amazon":15,"retail_wholesale":40} -- should sum to ~100. Ground it in shopify_orders_v channel mix and marketing_kpis_daily platform efficiency for comparable past launches.' },
        suggested_marketing_spend: { type: 'object', description: 'Recommended marketing spend in dollars by platform, e.g. {"meta_ads":5000,"tiktok_ads":3000}. Ground it in marketing_kpis_daily spend/CAC/MER for comparable past launches -- should be consistent with suggested_channel_split, not sized independently of it.' },
        suggested_weekly_revenue_projection: { type: 'array', items: { type: 'object' }, description: 'Revenue projected by week per channel for the first several weeks post-launch, e.g. [{"week":1,"channel":"dtc_web","revenue":8000}, ...]. Ground it in a comparable launch\'s actual week-over-week revenue shape where available; if none has week-level granularity, say so and give a clearly-labeled rough estimate instead.' },
        suggested_email_sms_plan: { type: 'array', items: { type: 'object' }, description: 'The email/SMS cadence and strategy around the launch, e.g. [{"channel":"email","timing":"T-7","theme":"teaser"},{"channel":"sms","timing":"T0","theme":"launch alert"}].' },
        suggested_marketing_copy: { type: 'string', description: 'A draft of actual marketing copy for the launch (headline + short body), not just the one-line marketing_angle -- grounded in brand voice/silo_chat_notes.' },
        reasoning: { type: 'string', description: 'The overall rationale, naming the specific comparable launches/data queried and any outside trend/competitor context pulled via web_search -- this is what a reviewer sees to judge the suggestion, and what next cycle’s generation should be able to learn from. Label web-sourced context as external, per the internal-vs-web-data rule.' },
        reference_image_urls: { type: 'array', items: { type: 'string' }, description: 'Public URLs of reference/inspiration images the user attached in this conversation, if any -- pass through exactly what you saw, do not invent URLs.' },
        parent_concept_id: { type: 'string', description: 'For a collection (multiple products sharing one brief, e.g. a licensed collab): the id of the parent concept this product belongs to. Omit entirely for a standalone product or for the parent concept itself -- only set this on a per-product child concept.' },
        ...STRUCTURED_CONCEPT_FIELDS,
      },
      required: ['title'],
    },
  },
  {
    name: 'update_product_concept',
    description: 'Revise an EXISTING concept in place -- always use this rather than creating a second concept when the user refines an idea you already drafted ("make the buy more conservative", "move it to November", "make this retail only"). Every update automatically creates a numbered revision preserving the prior state, so refining costs nothing and loses nothing. Only pass the fields that changed, plus a one-line revision_note describing the change.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The product_concepts.id to update.' },
        revision_note: { type: 'string', description: 'One line describing this change, e.g. "Reduced opening buy based on historical velocity." Saved onto the revision this update creates -- always pass it so the concept has a readable history.' },
        title: { type: 'string' },
        concept_summary: { type: 'string' },
        marketing_angle: { type: 'string' },
        audience: { type: 'string' },
        audience_tags: { type: 'array', items: { type: 'string' } },
        suggested_qty: { type: 'integer' },
        suggested_factory_id: { type: 'string' },
        suggested_channels: { type: 'array', items: { type: 'string' } },
        suggested_retail_dtc_notes: { type: 'string' },
        suggested_launch_date: { type: 'string' },
        suggested_launch_notes: { type: 'string' },
        suggested_launch_time: { type: 'string' },
        suggested_size_breakdown: { type: 'object' },
        suggested_channel_split: { type: 'object' },
        suggested_marketing_spend: { type: 'object' },
        suggested_weekly_revenue_projection: { type: 'array', items: { type: 'object' } },
        suggested_email_sms_plan: { type: 'array', items: { type: 'object' } },
        suggested_marketing_copy: { type: 'string' },
        reasoning: { type: 'string' },
        notes: { type: 'string' },
        reference_image_urls: { type: 'array', items: { type: 'string' } },
        parent_concept_id: { type: 'string' },
        ...STRUCTURED_CONCEPT_FIELDS,
      },
      required: ['id'],
    },
  },
  {
    name: 'approve_product_concept',
    description: 'Mark a draft product concept approved -- the human sign-off gate. Only call this when the user has explicitly confirmed approval (e.g. "approve it", "looks good, approve"), never on your own judgment or because the draft looks complete. Requires purchasing write access (the same access PO Builder requires); if the caller lacks it, tell them plainly rather than retrying.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The product_concepts.id to approve.' },
      },
      required: ['id'],
    },
  },
];

// Live corrections for column-name guesses that have actually recurred in
// production run_sql errors, even after being named in the system prompt --
// e.g. factories.factory_name and po_lines.qty were both listed in
// PRODUCT_CONCEPT_GUIDANCE (prompt-lib.mjs)'s corrected-column-names paragraph and the
// model still tried factories.name and po_lines.quantity_ordered/quantity/
// qty_ordered in a later session. A static prompt line competes with a lot
// of other text over a long tool-heavy conversation; a correction attached
// directly to the error the model just received doesn't need to be
// remembered, only read. Matched case-insensitively against the raw
// Postgres error text -- cheap, and false positives just add a harmless
// extra sentence.
const KNOWN_COLUMN_ERRORS: Array<{ pattern: RegExp; hint: string }> = [
  { pattern: /\bf(?:actor(?:y|ies))?\.name\b/i, hint: "factories' name column is factory_name, not name." },
  { pattern: /\bpl\.(?:quantity_ordered|quantity|qty_ordered)\b/i, hint: "po_lines' quantity column is qty, not quantity_ordered/quantity/qty_ordered." },
  { pattern: /\bproduct_title\b.*sales_by_day|sales_by_day.*\bproduct_title\b/i, hint: "sales_by_day's product name column is product_name, not product_title." },
  { pattern: /\blocation_tag\b/i, hint: "if this join was sales_by_day to locations, the join key is location_name, not location_tag." },
  { pattern: /\btotal_units\b/i, hint: "po_headers has no total_units -- per-line quantities live on po_lines.qty, and rolled-up totals on v_po_header_summary / v_po_incoming_summary." },
];

// WHY THE STATIC LIST ABOVE IS NOT ENOUGH, measured rather than argued.
//
// On 2026-09-16 a Sonic investigation spent its last round on
// `select ad_id, ..., min(date) ... from meta_ad_performance_daily` -- whose
// date column is `day_date`. It failed in 110ms with `column "date" does not
// exist`, and that query was the one that would have isolated Sonic ad spend.
// The answer shipped without it.
//
// The list above had no entry for it, and a list never will: it holds the five
// traps someone happened to write down. But the CORRECT ANSWER WAS ALREADY IN
// MEMORY -- silo_chat_schema_catalog carries every column of every relation,
// auto-generated from pg_catalog, and `catalogIndex` is built from it at the
// top of each request for the evidence envelope. So the fix is to answer the
// error from the catalog instead of from a list of remembered mistakes.
//
// And guidance demonstrably is not the lever here. That same request had
// called describe_relations ON meta_ad_performance_daily and been handed every
// column with its type, the schema map says "never guess a column that isn't
// listed", and a mid-flight investigation checkpoint had already fired. Three
// interventions, all present, all upstream of the mistake. This one is at the
// error itself, which is the one moment the model is certainly reading.
const MAX_HINT_COLUMNS = 24;

/** How close two identifiers are, cheaply. A real edit distance is overkill:
 *  the mistakes seen here are a missing prefix (`date` for `day_date`), a
 *  missing suffix (`spend` for `ad_spend`), or a near-synonym, so containment
 *  either way catches them and costs nothing. */
function nearMatches(wanted: string, columns: string[]): string[] {
  const w = wanted.toLowerCase();
  return columns.filter((c) => {
    const n = c.toLowerCase();
    return n !== w && (n.includes(w) || w.includes(n));
  });
}

/**
 * Turn a failed statement into a correctable one.
 *
 * Takes the SQL and the catalog index so it can name the columns the relations
 * in THIS statement actually have. Falls back to the static hints (which encode
 * real, hard-won traps) and to the bare message when it cannot do better --
 * never worse than before.
 */
function annotateColumnError(
  message: string,
  sql?: string,
  catalogIndex?: Map<string, { relkind: string | null; columns: Array<{ name: string; type: string }> }>,
): string {
  const hints = KNOWN_COLUMN_ERRORS.filter((c) => c.pattern.test(message)).map((c) => c.hint);

  // Postgres names the offending identifier, which is the whole reason this can
  // be mechanical. One pattern covers every shape it actually emits -- bare,
  // qualified, and either of those quoted -- and the qualified capture wins
  // because `column m.date does not exist` is about `date`, not about `m`. A
  // second alternative sat here for the qualified case until the four shapes
  // below were tested against this one and it turned out to be unreachable.
  const named = /column\s+"?([a-z_][a-z0-9_]*)"?(?:"?\.\s*"?([a-z_][a-z0-9_]*)"?)?\s+does not exist/i.exec(message);
  const wanted = named ? (named[2] || named[1]) : null;

  if (wanted && sql && catalogIndex) {
    const parts: string[] = [];
    const near: string[] = [];
    for (const rel of relationsInStatement(sql)) {
      const entry = catalogIndex.get(rel);
      if (!entry) continue;
      const cols = (entry.columns || []).map((c) => String(c && c.name || '')).filter(Boolean);
      if (!cols.length) continue;
      for (const m of nearMatches(wanted, cols)) if (!near.includes(m)) near.push(`${rel}.${m}`);
      const shown = cols.slice(0, MAX_HINT_COLUMNS);
      parts.push(`${rel} has: ${shown.join(', ')}${cols.length > shown.length ? `, …(${cols.length - shown.length} more)` : ''}`);
    }
    if (parts.length) {
      hints.push(
        `There is no column "${wanted}" on the relations this statement reads.`
        + (near.length ? ` Closest by name: ${near.slice(0, 6).join(', ')}.` : '')
        + ` ${parts.join('; ')}.`
        + ' Use one of these exact names and re-run -- do not guess a second time,'
        + ' and do not drop the measure this query was for.',
      );
    }
  }
  if (sql) {
    const slow = timeoutHint(message, relationsInStatement(sql));
    if (slow) hints.push(slow);
  }
  return hints.length ? `${message} Hint: ${hints.join(' ')}` : message;
}

type Note = {
  note: string;
  category: string;
  created_by_name: string | null;
  effective_until?: string | null;
  is_expired?: boolean | null;
};

type CatalogRow = {
  relname: string;
  relkind: string;
  columns: { name: string; type: string }[];
  description: string | null;
  keywords: string[] | null;
};

// Replaces the hand-typed schema cheat sheet that used to sit between the
// two prompt halves (and rotted -- every column-name failure in the
// 2026-08 audit logs traced back to it). Column names/types come from
// silo_chat_schema_catalog, auto-generated from pg_catalog, so they cannot
// drift from the live database; curated business meaning rides along in
// description/keywords. The tables most relevant to this question get full
// column detail; everything else appears as a one-line index so the model
// knows it exists without paying for its columns.
const SCHEMA_DETAIL_LIMIT = 8;
// Topped up when keyword matching finds fewer than the limit -- a generic
// business question ("how are we doing?") still deserves detail on the
// workhorse tables.
const SCHEMA_CORE_RELS = [
  'sales_by_day_verification_v',
  'inventory_workboard_v',
  'products_master',
  'shopify_orders_v',
];

function buildSchemaSection(question: string, rows: CatalogRow[]): { text: string; detailRelations: string[] } {
  if (!rows.length) {
    // Catalog unavailable (fetch failed / table empty) -- degrade to
    // discovery guidance rather than breaking chat.
    return {
      text: '\n\nSchema map unavailable for this request -- discover table and column names via information_schema before querying; never guess a column name.',
      detailRelations: [],
    };
  }
  const q = question.toLowerCase();
  const tokens = [...new Set(q.match(/[a-z0-9_]{4,}/g) || [])];
  const scored = rows.map((r) => {
    const name = r.relname.toLowerCase();
    const desc = (r.description || '').toLowerCase();
    const kws = (r.keywords || []).map((k) => k.toLowerCase());
    let score = 0;
    for (const t of tokens) {
      if (name.includes(t)) score += 5;
      if (kws.some((k) => k.includes(t) || t.includes(k))) score += 3;
      else if (desc.includes(t)) score += 1;
    }
    if (q.includes(name)) score += 10;
    return { r, score };
  });
  const detail = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SCHEMA_DETAIL_LIMIT)
    .map((s) => s.r);
  for (const core of SCHEMA_CORE_RELS) {
    if (detail.length >= SCHEMA_DETAIL_LIMIT) break;
    const row = rows.find((r) => r.relname === core);
    if (row && !detail.includes(row)) detail.push(row);
  }
  const detailNames = new Set(detail.map((r) => r.relname));
  const card = (r: CatalogRow) =>
    `### ${r.relname} (${r.relkind})\nColumns: ${(r.columns || []).map((c) => `${c.name} (${c.type})`).join(', ')}${
      r.description ? `\n${r.description}` : ''
    }`;
  const indexLine = (r: CatalogRow) => {
    const firstSentence = ((r.description || '').split('. ')[0] || '').trim();
    const short = firstSentence.length > 140 ? firstSentence.slice(0, 137) + '...' : firstSentence;
    return `- ${r.relname} (${r.relkind})${short ? ` -- ${short}` : ''}`;
  };
  return {
    // The detail slice is ranked on the OPENING QUESTION's own words, and an
    // investigation does not stay where its first sentence pointed: both
    // traced failures of 2026-09-16 ended up querying relations that had only
    // a one-line entry here. So the index now says, in the map itself, that a
    // one-liner is not the guidance -- and names the tool that fetches the
    // rest. Selection stays question-ranked because the alternative is paying
    // for the whole catalog on every question; what changes is that the model
    // is told the slice is a slice, and can widen it.
    text: `\n\nDatabase map (auto-generated from the live schema -- the table/view names and column names below are EXACT; trust them over memory, and never guess a column that isn't listed):

Most relevant to this question, with full columns:

${detail.map(card).join('\n\n')}

Everything else available: a one-line entry below is a POINTER, not a description -- it carries no columns and none of the caveats that decide whether a figure means what it looks like. Before you query, join or conclude anything from one of these, call describe_relations for its full card:
${rows.filter((r) => !detailNames.has(r.relname)).map(indexLine).join('\n')}`,
    detailRelations: detail.map((r) => r.relname),
  };
}

// The system prompt itself -- core rules, the specialised guidance modules and
// the concept block -- lives in prompt-lib.mjs, along with the deterministic
// selection of which modules a request carries and the assembly that folds in
// the schema slice, today's date and this company's taught notes. Notes are
// folded into the cached system block (fetched once per request) rather than
// looked up via run_sql, so the model always has them in view.

/** Thrown when a model call is cut off by its own deadline. Distinct from a
 *  transport error because the caller's response to it is different: there is
 *  no point retrying, but there IS still time reserved to write an answer. */
class ModelCallDeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`Anthropic call exceeded its ${timeoutMs}ms deadline`);
    this.name = 'ModelCallDeadlineError';
  }
}

/** The model API is rate limiting or overloaded and retries within the budget
 *  did not get through. Distinct because the person is told something
 *  different: nothing is wrong with the question, ask again in a minute. */
class ProviderBusyError extends Error {
  status: number;
  retryAfterMs: number | null;
  constructor(status: number, retryAfterMs: number | null, body: string) {
    super(`Anthropic API ${status} (busy): ${body.slice(0, 300)}`);
    this.name = 'ProviderBusyError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The organisation's model-API spend cap is reached. Waiting will not clear it
 *  -- access resumes only when the cap resets or someone raises it -- so it is
 *  neither retried nor reported as "busy, try again". */
class ProviderSpendLimitError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`Anthropic API ${status} (spend limit): ${body.slice(0, 300)}`);
    this.name = 'ProviderSpendLimitError';
    this.status = status;
  }
}

async function callAnthropic(
  messages: unknown[],
  systemPrompt: string | Array<Record<string, unknown>>,
  tools: unknown[],
  // timeoutMs bounds THIS call against the absolute gateway deadline. Without
  // it the fetch runs unbounded, which is what let a grant admitted on cheap
  // samples overshoot 150s and lose both the answer and the audit row. 0 or
  // undefined leaves the call unbounded, as it was.
  //
  // retryUntil (epoch ms) caps provider retries on a call that has no
  // timeoutMs of its own: a 429/529/5xx is retried only if the wait plus a
  // working margin still lands before it. onRetry reports each retry so the
  // audit row can say the provider pushed back.
  opts: {
    forceAnswer?: boolean; forceTool?: string; timeoutMs?: number;
    retryUntil?: number; onRetry?: (status: number, waitMs: number) => void;
  } = {},
) {
  const deadlineAt = opts.timeoutMs ? Date.now() + opts.timeoutMs : 0;
  const capAt = deadlineAt || opts.retryUntil || 0;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    const remaining = deadlineAt ? deadlineAt - Date.now() : 0;
    if (deadlineAt && remaining <= 0) throw new ModelCallDeadlineError(opts.timeoutMs!);
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        ...(deadlineAt ? { signal: AbortSignal.timeout(remaining) } : {}),
        headers: {
          'content-type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          // Was 4096. A live holiday-collection draft (full launch-plan brief in
          // prose after hitting query errors) got cut off mid-word at the old
          // cap -- stop_reason was "max_tokens" but the code only checked "is
          // there text?", so it shipped the truncated fragment as a finished
          // answer. Raised as a mitigation; the real fix is the stop_reason
          // check below, which now refuses to treat a max_tokens cutoff as done
          // regardless of the cap.
          max_tokens: 8192,
          // Render order is tools -> system -> messages, so the first breakpoint
          // covers the tools too. The handler sends two blocks (buildSystemBlocks
          // in prompt-lib.mjs): the static core, cached for an hour and read by
          // every request from every user, then this request's part (schema
          // slice, date, notes, guidance), whose five-minute entry serves the
          // request's later rounds -- everything in it is fixed before the loop
          // starts. A plain string is still accepted as one cached block.
          system: typeof systemPrompt === 'string'
            ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
            : systemPrompt,
          // forceAnswer: tools stay declared (the transcript contains tool_use /
          // tool_result blocks that must resolve against them) but tool_choice
          // 'none' forbids any further calls, so the model can only answer.
          // forceTool: same idea, but forces the NEXT round to call one specific
          // tool -- used to make the phase-1 draft nudge below an actual
          // enforcement instead of a request the model can (and, live, did)
          // answer past with a prose apology instead.
          tools,
          ...(opts.forceAnswer
            ? { tool_choice: { type: 'none' } }
            : opts.forceTool
            ? { tool_choice: { type: 'tool', name: opts.forceTool } }
            : {}),
          messages,
        }),
      });
    } catch (err) {
      // An aborted fetch surfaces as TimeoutError/AbortError depending on
      // runtime. Named separately so the caller can tell "the deadline closed"
      // apart from "the network failed" -- the first still has reserved time to
      // write an answer with, the second does not.
      const name = (err as { name?: string } | null)?.name;
      if (opts.timeoutMs && (name === 'TimeoutError' || name === 'AbortError')) {
        throw new ModelCallDeadlineError(opts.timeoutMs);
      }
      const d = retryDecision({ status: 0, attempt, capAt });
      if (!d.retry) throw err;
      opts.onRetry?.(0, d.waitMs);
      await new Promise((r) => setTimeout(r, d.waitMs));
      continue;
    }
    if (res.ok) return res.json();
    const bodyText = await res.text();
    // The body is read before the retry decision: a 429 is not always "busy".
    const errorCode = providerErrorCode(bodyText);
    if (isSpendLimitResponse(res.status, bodyText)) throw new ProviderSpendLimitError(res.status, bodyText);
    const d = retryDecision({ status: res.status, retryAfter: res.headers.get('retry-after'), errorCode, attempt, capAt });
    if (d.retry) {
      opts.onRetry?.(res.status, d.waitMs);
      await new Promise((r) => setTimeout(r, d.waitMs));
      continue;
    }
    if (BUSY_STATUSES.has(res.status)) {
      throw new ProviderBusyError(res.status, parseRetryAfter(res.headers.get('retry-after')), bodyText);
    }
    throw new Error(`Anthropic API ${res.status}: ${bodyText}`);
  }
}

// Was 8, then 12. With the trigram indexes (20260820130000/140000) making
// every name-search query fast, the model now runs genuinely thorough
// analyses -- the 2026-08-20 uncrustables restock question executed 18
// clean queries (launch date, daily rates, on-hand, Black Friday YoY) and
// then hit the 12 cap with the finished analysis in hand and no round left
// to write the answer. 20 gives that class of question room; the
// forced-answer fallback below (not this cap) is what actually guarantees
// the user gets an answer either way.
const MAX_TOOL_ROUNDS = 20;

// describe_relations budget. Six relations is a join plus its lookups; three
// calls is enough for an investigation that moves twice. Bounded because the
// alternative to a bound is a model that pages the whole catalog into context
// one call at a time -- which costs the same tokens the per-question slice
// exists to save, and adds a round trip for each of them.
const MAX_DESCRIBE_RELATIONS_PER_CALL = 6;
const MAX_DESCRIBE_CALLS_PER_REQUEST = 3;
// A catalog card can be long (marketing_kpis_daily's is ~1.6KB of genuinely
// load-bearing caveats). Capped rather than dropped: a truncated card says it
// was truncated, where a missing one reads as "nothing to know here".
const MAX_CARD_DESCRIPTION_CHARS = 2400;

// Diagnostics. Enough to tell a future mismatch apart from the outside;
// deliberately NOT enough to reconstitute a result set. See the comment on
// buildDiagnostics below for what is stored and what is refused.
const MAX_LOGGED_QUERIES = 40;
const MAX_LOGGED_SQL_CHARS = 2000;
const MAX_LOGGED_ERROR_CHARS = 400;
const MAX_DIAGNOSTIC_BYTES = 120_000;

// WRITE_COMPANY_NOTE -- how a write is kept inside the company the question was
// asked in, and why it takes two mechanisms rather than one.
//
// RLS scopes everything through profiles.active_company_id: ONE mutable
// per-user field, not a property of this request. A single request makes many
// separate database round trips over a minute or more, so a company switch in
// another tab lands BETWEEN two of them. Checking after the tool loop is far
// too late -- the row is committed long before the answer is assembled.
//
// 1. THE GUARANTEE is that every write sends `company_entity_id` EXPLICITLY,
//    set to the company read at the start of the request. stamp_company_entity_id
//    only fills the column when it is NULL, so an explicit value survives, and
//    each insert policy's `company_entity_id = active_company_id()` then
//    REFUSES the row if the active company has moved. One statement, no window.
//    Updates cannot be refused by a WITH CHECK they still satisfy, so they are
//    ADDRESSED by company instead (`.eq('company_entity_id', ...)`) and a write
//    that matches no row is an error, never a silent no-op.
//
// 2. THE GATE below is a pre-check, not the boundary. It exists so the common
//    case produces a sentence a person can act on ("nothing was saved, reload
//    and ask again") instead of a raw RLS rejection. It reads the company and
//    the write happens in a LATER round trip, so it can always be raced -- as
//    the cycle-2 review of #712 pointed out, create_product_concept even runs a
//    duplicate-title lookup in between, widening that window. Do not mistake it
//    for the thing that makes this safe, and do not remove the explicit stamp
//    on the grounds that the gate is there.
//
// Every tool that writes is named here. Adding one without adding it to this
// set is the one way to lose the gate silently, which is why the set sits
// beside the loop rather than as a condition inside each branch;
// `handler.test.mjs` reads the loop structurally and fails if a branch that
// writes is missing from it.
const WRITE_TOOLS = new Set([
  'save_note',
  'create_product_concept',
  'update_product_concept',
  'approve_product_concept',
]);

// An update that matched nothing. Covers both reachable causes honestly: the
// concept is in another company (the race this guards), or the id is simply
// wrong. Saying "wrong company" alone would misdescribe the second.
const WRONG_COMPANY_ROW =
  'no concept with that id exists in the company this chat is working in -- it may belong to another company, or the id may be wrong. Nothing was changed.';

// Supabase's edge gateway kills a request at 150s and returns a bare 504 --
// the function never finishes, so it never writes an audit row either. That
// is invisible in silo_chat_health_v: the failure looks like nothing
// happened at all. Observed live 2026-08-26 21:09 on a phase-2 "build the
// full brief" request (150,162ms -> 504, no audit row).
//
// The round cap alone does NOT bound this. Rounds are not a proxy for time,
// and they got slower on purpose: 20260826100000 raised the per-query
// statement timeout 10s -> 30s, so a heavy query that used to die at 10s can
// now legitimately spend 30. Three of those plus their Anthropic round-trips
// clears 150s inside the 20-round budget. The old 10s cap was acting as an
// accidental wall-clock governor; raising it removed the governor without
// replacing it.
//
// So: stop STARTING rounds at 95s, leaving ~55s for the forced final answer
// (one Anthropic call, occasionally a second for a max_tokens continuation).
// A deadline stop is not an error -- it takes the same forced-answer path as
// the round cap, so the user gets the analysis gathered so far instead of a
// 504, and the audit row records which limit stopped it.
const WALL_CLOCK_BUDGET_MS = 95_000;
// One checkpoint while tools remain available, not a larger gateway budget.
const INVESTIGATION_CHECKPOINT_MS = 45_000;

// ONE ROUND HELD BACK FOR A CORRECTION, and why it is worth a hard-coded
// exception to the wall-clock guard.
//
// Measured on the 2026-09-16 Sonic request: the statement that would have
// isolated Sonic ad spend ran in the LAST round, failed in 110ms on a guessed
// column name, and the loop had already passed WALL_CLOCK_BUDGET_MS -- so the
// model never got a round in which to use the correction. The answer went out
// saying that exact measure was unchecked. Total database time for the whole
// request was 18.3s of the 138s; the budget was spent on model round-trips,
// not on queries, so the round that was missing was affordable.
//
// Bounded hard, because "just allow more rounds" is the fix this is NOT:
//   * at most ONE per request, whatever happens;
//   * only when the previous round actually hit a correctable error (an
//     unknown column, relation or function -- never a timeout, which would
//     simply time out again, and never a permission error, which is an answer);
//   * only when the time it needs DEMONSTRABLY still fits.
//
// THAT LAST ONE WAS A FIXED 115s CUTOFF AND IT WAS WRONG TWICE OVER, found in
// review and confirmed against the trace it was written for. A correction costs
// a model call, then a query, then the forced final answer's own model call.
// The Sonic request averaged 17.1s per model call (119,656ms of model time
// across 7 calls, against 18,331ms of database time), so 115s + 17.1 + 8 + 17.1
// = 157s -- past the 150s gateway, which returns a bare 504 and writes no audit
// row. And it would not have helped anyway: elapsed at that request's round-6
// boundary was ~121s, already past 115s, so the grant it was built for could
// never have fired.
//
// A constant cannot know any of that, so the reservation is MEASURED from this
// request's own model calls instead. Slow rounds mean there is genuinely no
// room and the correction is refused; cheap rounds mean there is. The honest
// consequence: this fires when a request reached the budget through many quick
// rounds, and not when it crawled there. F1's catalog hint is the half that
// works regardless of budget.
// The arithmetic itself lives in budget-lib.mjs, where it can be tested with
// exact numbers instead of through a clock that drifts by a millisecond or two.
/** Errors where the model has something specific to do differently next round.
 *  A statement timeout matches NOTHING here, and that is the whole exclusion:
 *  re-running the same heavy statement unchanged is what "flake is not a root
 *  cause" means, and against a real 8s ceiling (measured 2026-09-16; the 30s the
 *  RPC declares never governs, because SET LOCAL cannot re-arm the timeout of
 *  the statement already running) it would simply time out again.
 *
 *  A belt-and-braces `!timedOut` check used to sit at the call site as well. It
 *  was removed after mutation testing showed it could not change any outcome --
 *  a dead branch credited as a safeguard is worse than no branch, because the
 *  test covering it passes either way. Widen this pattern and that exclusion is
 *  what you have to re-establish. */
const CORRECTABLE_QUERY_ERROR = /does not exist|no such (?:column|table|function)|could not identify|is ambiguous/i;
// Past this, skip the max_tokens continuation in the forced-answer path and
// ship what we have -- a slightly short answer beats a 504 with nothing.
const FINAL_CONTINUATION_CUTOFF_MS = 125_000;

// DIAGNOSTIC EVIDENCE, bounded.
//
// silo_chat_audit_log already stored the question, the SQL text and the final
// answer. Reconstructing the two mislabelling failures of 2026-09-16 from that
// still meant re-running every statement by hand against live data -- which
// answers what the database says TODAY, not what the model was looking at, and
// historical attribution moves. What was missing was the OUTCOME of each query
// and the CONTEXT it was chosen against.
//
// WHAT IS STORED: per query, the statement (already stored in queries_run, kept
// here so an outcome is not orphaned from its cause), its derived evidence
// scope, the row count, whether it errored and the error text; plus which
// relations got full schema cards up front and which were fetched mid-request.
//
// WHAT IS REFUSED, and why the distinction is the design rather than a setting:
//   * NO RESULT ROWS. Not a sample, not the first row. A returned row is
//     business data -- it is what RLS spent its whole existence scoping -- and
//     copying it into a second table is a second copy to get the policy right
//     on. Counts and shapes diagnose a mislabelling; values are not needed for
//     it.
//   * Errors are capped and are the DATABASE's message about a statement the
//     model wrote. They can echo a literal the model itself supplied; they do
//     not carry rows.
//   * The row lands through the caller's own JWT into a table whose select
//     policy is already `company_entity_id = active_company_id() AND
//     (created_by = auth.uid() OR is_exec_or_owner())`. This adds a column to
//     that row. It does not add a reader, a table, or a path to another
//     tenant's data.
//   * Size is capped HERE, before the insert, because an oversized payload
//     would fail the insert -- and a logging failure must never be the thing
//     that turns a good answer into a bad request. Detail is shed in order
//     (scope objects first, then whole entries) and what was shed is recorded.
function buildDiagnostics(
  queryLog: Array<Record<string, unknown>>,
  contextLog: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!queryLog.length && !Object.keys(contextLog).length) return null;
  const trim = (v: unknown, n: number) => {
    const t = String(v ?? '');
    return t.length > n ? `${t.slice(0, n)}…[truncated]` : t;
  };
  let entries = queryLog.slice(0, MAX_LOGGED_QUERIES).map((q) => ({
    ...q,
    // A coverage probe carries no `sql` key; writing an empty string for it
    // would put a query with no statement in the record.
    ...(q.sql ? { sql: trim(q.sql, MAX_LOGGED_SQL_CHARS) } : {}),
    ...(q.error ? { error: trim(q.error, MAX_LOGGED_ERROR_CHARS) } : {}),
  }));
  const dropped = Math.max(0, queryLog.length - entries.length);
  const build = (list: unknown[], note: string | null) => ({
    schema_version: 1,
    queries: list,
    context: contextLog,
    ...(dropped ? { queries_not_logged: dropped } : {}),
    ...(note ? { reduced: note } : {}),
    contains: 'statements, derived query scope, row counts and error text. No result rows, ever.',
  });
  let payload = build(entries, null);
  if (JSON.stringify(payload).length <= MAX_DIAGNOSTIC_BYTES) return payload;
  // Shed the scope objects first: they are the largest part and the least
  // recoverable-from-nothing part is the outcome, not the derivation.
  entries = entries.map(({ scope: _scope, ...rest }: Record<string, unknown>) => rest);
  payload = build(entries, 'evidence_scope objects dropped to fit the size limit');
  while (JSON.stringify(payload).length > MAX_DIAGNOSTIC_BYTES && entries.length) {
    entries = entries.slice(0, Math.max(1, Math.floor(entries.length / 2)));
    payload = build(entries, 'evidence_scope objects and older entries dropped to fit the size limit');
    if (entries.length === 1) break;
  }
  return JSON.stringify(payload).length <= MAX_DIAGNOSTIC_BYTES
    ? payload
    : { schema_version: 1, queries: [], context: {}, reduced: 'diagnostics exceeded the size limit and were not stored' };
}

// One row per request: the question, the SQL actually run, the answer (or
// error), and how many tool-rounds it took. Prerequisite for closing the
// feedback loop and for a future eval set -- never lets a logging failure
// break the actual chat response, and only fires once a real caller-scoped
// client and a valid history exist (nothing to attribute an early
// auth/validation failure to).
async function logAudit(
  callerClient: ReturnType<typeof createClient>,
  params: {
    requestId?: string | null;
    question: string;
    historySnapshot: unknown;
    answer: string | null;
    queriesRun: string[];
    toolRounds: number;
    status: 'ok' | 'error';
    errorMessage?: string | null;
    diagnostics?: Record<string, unknown> | null;
  },
): Promise<boolean> {
  try {
    // supabase-js does NOT throw on a rejected insert -- an RLS violation, a
    // constraint failure or a dropped column all come back as a RETURNED
    // `error` object with the promise resolved. The previous version only had
    // a try/catch, so every one of those was indistinguishable from success:
    // the answer went out fine, the row was never written, and
    // silo_chat_health_v -- which counts rows in this table -- reported a
    // reliability figure computed over a log with holes in it. Two things
    // depend on the row existing: that scoreboard, and the client's
    // crash-recovery lookup, which can only find an answer that got logged.
    const base: Record<string, unknown> = {
      request_id: params.requestId ?? null,
      question: params.question,
      history_snapshot: params.historySnapshot,
      answer: params.answer,
      queries_run: params.queriesRun,
      tool_rounds: params.toolRounds,
      status: params.status,
      error_message: params.errorMessage ?? null,
      model: MODEL,
    };
    let { error } = await callerClient.from('silo_chat_audit_log').insert({
      ...base,
      diagnostics: params.diagnostics ?? null,
    });
    // The diagnostics column arrives by migration and this function by a
    // manual deploy, in whichever order they happen. A function running ahead
    // of its migration must not lose the whole audit row over a column that is
    // not there yet -- the row is what the crash-recovery path and
    // silo_chat_health_v both read. So: one retry without the new column, and
    // only for the error that actually means "no such column" (PostgREST
    // PGRST204 / Postgres 42703), never as a blanket second attempt that would
    // hide a real rejection.
    const missingColumn = (e: typeof error) => {
      if (!e) return false;
      const code = String((e as { code?: string }).code ?? '');
      const msg = String(e.message || '');
      return code === 'PGRST204' || code === '42703'
        || (/diagnostics/i.test(msg) && /(column|schema cache)/i.test(msg));
    };
    if (missingColumn(error)) {
      console.warn('[silo-chat] audit diagnostics column absent; logging without it', {
        request_id: params.requestId ?? null,
      });
      ({ error } = await callerClient.from('silo_chat_audit_log').insert(base));
    }
    if (error) {
      // The edge-function log is the operational channel available here. It
      // is deliberately NOT surfaced to the user: the answer itself is fine,
      // and a logging failure is not their problem to act on. The response
      // carries audit_logged: false so the client knows not to promise
      // recovery on this one.
      console.error('[silo-chat] AUDIT INSERT REJECTED', {
        request_id: params.requestId ?? null,
        status: params.status,
        message: error.message,
        details: (error as { details?: string }).details ?? null,
        code: (error as { code?: string }).code ?? null,
      });
      return false;
    }
    return true;
  } catch (err) {
    console.error('[silo-chat] AUDIT INSERT THREW', err);
    return false;
  }
}

// Every url the hosted web_search tool actually surfaced this request --
// collected from BOTH places Anthropic puts them: the `citations` array
// hanging off a text block, and the result items inside a
// web_search_tool_result block. The answer-assembly path maps content blocks
// to `b.text` and discards everything else, so before this the user was told
// a claim came "from the web" with no way to see WHICH web -- an unverifiable
// external claim presented in the same breath as queried numbers, which is
// the one thing the prompt's internal-vs-public rule exists to prevent.
// Deduped by url, first title wins, order preserved.
function collectSources(
  blocks: unknown[],
  into: Map<string, { url: string; title: string | null }>,
) {
  for (const raw of blocks || []) {
    const b = raw as { type?: string; citations?: unknown[]; content?: unknown[] };
    for (const list of [b?.citations, b?.type === 'web_search_tool_result' ? b?.content : null]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const c = item as { url?: unknown; title?: unknown };
        const url = typeof c?.url === 'string' ? c.url : null;
        if (!url || into.has(url)) continue;
        into.set(url, { url, title: typeof c?.title === 'string' ? c.title : null });
      }
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);

  // Measured from handler entry, not from the loop -- auth, the notes fetch
  // and the schema slice all spend against the same 150s gateway budget.
  const startedAt = Date.now();
  const elapsedMs = () => Date.now() - startedAt;

  let callerClient: ReturnType<typeof createClient> | null = null;
  let question = '';
  // Hoisted: the outer catch logs an audit row too, and a failed request that
  // cannot be tied back to the request the browser started is a failed request
  // the browser cannot tell apart from someone else's.
  let requestId: string | null = null;
  let history: { role: string; content: string; imageUrls?: string[]; conceptId?: string }[] = [];
  let queriesRun: string[] = [];
  // What the request had done when a provider refusal ended it: rounds used and
  // the diagnostics (per-call usage, retries, query outcomes) gathered so far.
  // Set once the loop's state exists, read by the outer catch -- without it a
  // request that spent three rounds and then hit a 429 was audited as zero
  // rounds with no usage, undercounting exactly the requests the capacity
  // queries exist to diagnose (review of #806, cycle 1).
  let auditSoFar: (() => { toolRounds: number; diagnostics: Record<string, unknown> | null }) | null = null;
  // Crawl guard. "One URL per call" is the tool's signature; this is what stops
  // a turn becoming a crawl by calling it repeatedly. Enforced here rather than
  // asked for in the prompt, because a limit a model is merely told about is
  // not a limit. Raise deliberately, alongside the rate-limit and robots
  // questions crawling actually needs.
  // Budget object rather than a bare counter: it also refuses a repeat of a
  // page already fetched this request, and it is unit-tested (seo-lib.mjs).
  const inspectionBudget = createInspectionBudget(MAX_PAGE_INSPECTIONS_PER_REQUEST);

  try {
    if (!ANTHROPIC_API_KEY) {
      return reply({ error: 'ANTHROPIC_API_KEY is not configured for this project yet.' }, 503);
    }

    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!jwt) return reply({ error: 'Not authenticated' }, 401);

    // Caller-scoped client -- every RPC call below runs AS this user, so
    // RLS (not this function) is what actually confines the data. Never
    // use the service-role key here.
    callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData?.user) return reply({ error: 'Not authenticated' }, 401);

    const body = await req.json();
    ({ history } = body);

    // ONE request, ONE id, minted by the browser. The client's crash-recovery
    // path (a gateway 504 on a long draft, a backgrounded mobile tab) reads
    // silo_chat_audit_log for the answer to THIS request. It used to match on
    // question TEXT, which is not an identity: a conversation is full of
    // "yes", "keep going", "now by month", and the select policy on that table
    // is `created_by = auth.uid() OR is_exec_or_owner()`, so for an exec the
    // match was not even scoped to their own rows. Validated as a uuid because
    // it goes straight into a uuid column -- a malformed one would fail the
    // insert and lose the row we are logging precisely so it can be recovered.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const rawRequestId = String(body?.request_id || '');
    requestId = UUID_RE.test(rawRequestId) ? rawRequestId : null;

    // Which company this question was asked FROM. RLS scopes every read in
    // this function through profiles.active_company_id -- a single mutable
    // per-user field, not a property of this request -- and one request makes
    // many separate database calls over a minute or more. A company switch in
    // another tab (or, before 20260916120000, a `select set_active_company(...)`
    // reaching the query tool) therefore lands BETWEEN two of them, and the
    // answer silently mixes two tenants' rows with nothing to show it happened.
    //
    // This cannot be fixed by trusting the client's value -- that would let a
    // caller name a company instead of being scoped to one. So the server
    // reads the authoritative field itself, and the client's value is only
    // ever used to REFUSE: if the browser thinks it is asking from a different
    // company than the server has recorded, that disagreement is the bug, and
    // answering either way would be answering a question nobody asked.
    // Re-checked once more before the answer goes out (see finishWithAnswer).
    const declaredCompanyRaw = String(body?.company_entity_id || '');
    const declaredCompany = UUID_RE.test(declaredCompanyRaw) ? declaredCompanyRaw : null;
    // DISCRIMINATED, because "this user has no active company" and "the lookup
    // failed" are different facts and conflating them fails OPEN. The first
    // version of this returned a bare `string | null` and every comparison was
    // then written as "only act when both sides are known" -- which means a
    // transient PostgREST/RLS error on either read silently skips the check
    // entirely. The dangerous shape of that: the request starts in A, the user
    // switches to B while tools run, the final lookup errors, and a B-scoped
    // answer is delivered into the A conversation with nothing having gone
    // wrong anywhere it can be seen. Verification failing is now a refusal,
    // not a shrug.
    //
    // Retried once before giving up, because the alternative to a retry is
    // discarding a minute of finished work over one blip. This is the caller's
    // own single-row profile read -- the same PostgREST the request has
    // already used many times -- so two consecutive failures mean something is
    // genuinely wrong with the session, and refusing then is correct.
    type CompanyLookup = { ok: boolean; companyId: string | null };
    const readActiveCompanyOnce = async (): Promise<CompanyLookup> => {
      try {
        const { data, error } = await callerClient!
          .from('profiles')
          .select('active_company_id')
          .eq('id', userData.user.id)
          .maybeSingle();
        if (error) {
          console.warn('[silo-chat] could not read active company', error.message);
          return { ok: false, companyId: null };
        }
        return { ok: true, companyId: (data?.active_company_id as string | null) ?? null };
      } catch (err) {
        console.warn('[silo-chat] active company read threw', err);
        return { ok: false, companyId: null };
      }
    };
    const readActiveCompany = async (): Promise<CompanyLookup> => {
      const first = await readActiveCompanyOnce();
      return first.ok ? first : await readActiveCompanyOnce();
    };
    const UNVERIFIED = {
      error: "Couldn't confirm which company this question belongs to, so it wasn't run -- answering without that confirmed is how one company's numbers end up in another company's chat. Try again; if it keeps happening, reload the page.",
      company_unverified: true,
      retryable: true,
    };

    const companyAtStart = await readActiveCompany();
    if (!companyAtStart.ok) return reply(UNVERIFIED, 503);
    if (declaredCompany && companyAtStart.companyId && declaredCompany !== companyAtStart.companyId) {
      return reply({
        error: "This tab is set to a different company than your account is currently active in -- so this question wasn't run, rather than being answered against the wrong company's numbers. Reload the page and ask again.",
        company_changed: true,
      }, 409);
    }
    // Named workflow rather than a boolean: Product Concept is the first
    // structured workflow behind this boundary, not the only one intended.
    // `conceptMode` is still accepted because the UI is statically hosted
    // and a browser holding a cached page would otherwise silently lose
    // concept access until it refreshed.
    const activeWorkflow: string | null =
      typeof body?.workflow === 'string' ? body.workflow
      : body?.conceptMode === true ? 'product_concept'
      : null;
    if (!Array.isArray(history) || !history.length) {
      return reply({ error: 'history (array of {role, content}) is required' }, 400);
    }
    question = history[history.length - 1]?.content || '';

    // Product Concepts: in testing -- a history entry may carry imageUrls
    // (public URLs already uploaded by the client to product-concept-images)
    // alongside its plain-text content. Only those entries get a real
    // content-block array; everything else stays a plain string exactly as
    // before. `content` itself is never anything but a string -- question/
    // logAudit/etc. below all keep assuming that.
    const messages = history.map((m: { role: string; content: string; imageUrls?: string[]; conceptId?: string }) => {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      // Product Concept card actions (Revise / Pressure test / Build full
      // plan / Approve) send the concept's id alongside the text, the same
      // sibling-field shape as imageUrls. This is what makes an action
      // unambiguous: the id travels with the request instead of the model
      // having to remember it. It cannot remember it -- the client persists
      // only {role, content} into history, so a concept id created on an
      // earlier turn is simply not in context. That gap is what produced a
      // duplicate concept live on 2026-08-25: asked to change a quantity,
      // the model had no id to update and created a second row.
      const text = m.conceptId
        ? `[Acting on existing product concept id ${m.conceptId} -- revise THIS concept with update_product_concept, do not create a new one.]\n${m.content}`
        : m.content;
      if (Array.isArray(m.imageUrls) && m.imageUrls.length) {
        const blocks: Array<Record<string, unknown>> = m.imageUrls.map((url) => ({
          type: 'image',
          source: { type: 'url', url },
        }));
        if (text) blocks.push({ type: 'text', text });
        return { role, content: blocks };
      }
      return { role, content: text };
    });

    // Fetched once per request (not per tool-round) so the system prompt
    // stays byte-identical across every round of this request -- required
    // for the cache_control breakpoint below to actually hit on rounds 2+.
    const { data: notes } = await callerClient
      .from('silo_chat_notes_v')
      .select('note, category, created_by_name, effective_until, is_expired')
      .order('created_at', { ascending: true })
      .limit(200);
    // Same once-per-request rule as notes: the schema slice must be
    // byte-identical across every tool-round of this request for the
    // cache_control breakpoint to hit on rounds 2+.
    const { data: catalogRows } = await callerClient
      .from('silo_chat_schema_catalog')
      .select('relname, relkind, columns, description, keywords')
      .eq('is_hidden', false)
      .order('relname');
    // Concept capability is now an EXPLICIT mode, not inferred intent.
    // Previously the allowlist alone enabled it, so every question a tester
    // asked carried the concept tools and prompt block -- and a text
    // heuristic then tried to work out whether they were drafting. It got
    // it wrong in both directions, and on 2026-08-25 an analytical
    // demand-planning question was force-written into a junk concept row.
    //
    // The user knows which they are doing, so they say so once (the "New
    // concept" toggle, or the concept suggestion chip) instead of the model
    // guessing every turn. When the mode is off the tools are not sent AT
    // ALL, so a concept cannot be created from an analytical question
    // regardless of wording -- the failure mode is removed rather than
    // mitigated. Acting on an existing concept from its card counts as
    // intent too: those messages carry a conceptId.
    //
    // Also materially cheaper: an ordinary question no longer pays for
    // ~4KB of concept prompt and three unused tool schemas.
    const actingOnConcept = history.some((m) => typeof m?.conceptId === 'string' && !!m.conceptId);
    const conceptsEnabled = PRODUCT_CONCEPT_TESTERS.includes(
      (userData.user.email || '').toLowerCase(),
    ) && (activeWorkflow === 'product_concept' || actingOnConcept);
    // The phase-1 draft circuit breaker below used to arm on conceptsEnabled
    // alone -- i.e. on EVERY question a tester asked. Any analytical question
    // that legitimately ran 5+ tool rounds (overstock analysis, sales
    // performance) got hijacked mid-investigation by a forced
    // create_product_concept call, stamping junk "TBD Concept - Needs
    // Direction" placeholder rows into product_concepts (two created live on
    // 2026-08-21, both deleted). Arm it only when the conversation actually
    // reads like product drafting: some user message carries concept/drafting
    // language, AND the latest message isn't shaped like an analytical
    // question. A missed arm just means a slow draft goes unhurried -- far
    // cheaper than hijacking a data question. Note for the Product Concepts
    // owner: a phase-2 "build out the full plan" request can still arm this
    // and be told to call create (not update) -- pre-existing, unaddressed
    // here.
    // 'design' and 'mock up' were removed after a live hijack: "generate
    // mock up demand planning by product type for 2027..." matched
    // 'mock ?up', armed the breaker, and forced a junk concept row named
    // after the analysis. Both words are at least as common in analytical
    // requests ("mock up a plan", "design a report") as in product
    // drafting, so they are false-positive generators, not signal.
    const CONCEPT_LANGUAGE = /\b(concepts?|drafts?|product idea|new product|product for|collection|collab)\b/i;
    const ANALYTICAL_QUESTION = /\?|^\s*(which|what|how|why|when|where|who|show|list|compare|summarize|do we|are we|is|should|can|give me|tell me)\b/i;
    // The disarm above only catches interrogatives and question marks, so
    // an imperative analytical request ("generate ... define ... suggest
    // strategy") slipped straight past it. These name an ANALYSIS
    // deliverable rather than a product, and no product concept is called
    // a demand plan or a forecast.
    const ANALYTICAL_DELIVERABLE = /\b(demand plan\w*|forecast\w*|projection\w*|analysis|analyze|analyse|report|breakdown|gap|variance|budget|scenario|model out|planning)\b/i;
    const conceptBreakerArmed = conceptsEnabled
      && history.some((m) => m.role === 'user' && CONCEPT_LANGUAGE.test(String(m.content || '')))
      && !ANALYTICAL_QUESTION.test(question.trim())
      && !ANALYTICAL_DELIVERABLE.test(question);
    // When a tester has the capability but has NOT started the workflow,
    // say so in one line. Without this the model has no idea Product
    // Concepts exists -- it simply lacks the tools -- so "draft me a youth
    // hoodie concept" with the mode off gets a friendly prose answer,
    // nothing is saved, and nothing explains why. That is a worse failure
    // than the one the mode fixed, because it is silent.
    const isConceptTester = PRODUCT_CONCEPT_TESTERS.includes(
      (userData.user.email || '').toLowerCase(),
    );
    // Same text heuristic that used to arm the circuit breaker -- but here
    // its consequence is offering a dismissible button, not forcing a
    // write. A false positive costs one ignorable line; the version that
    // could misfire into a junk concept row is gone. Worth being explicit
    // that this is why the same imperfect regex is acceptable in one place
    // and was not in the other.
    const suggestConceptWorkflow = !conceptsEnabled && isConceptTester
      && /\b(concepts?|draft|design|new product|product idea|collection|collab)\b/i.test(question);
    const schemaSlice = buildSchemaSection(question, (catalogRows ?? []) as CatalogRow[]);
    // Which specialised guidance (marketing/launch, SEO) this request carries.
    // Chosen once, from the conversation, before the tool loop -- so the system
    // prompt is byte-identical across rounds. It selects TEXT only: the tool
    // list on the next line is decided by conceptsEnabled (authorization) and
    // nothing else, so no wording of a question can make a write available.
    const guidance = selectGuidance({ history, conceptsEnabled });
    const systemPrompt = buildSystemBlocks({
      notes: (notes ?? []) as Note[],
      schemaSection: schemaSlice.text,
      guidance,
      conceptsEnabled,
      // A tester who has the capability but has not started the workflow is
      // told it exists (without tools), so a request to draft one is not
      // silently answered in prose as though it were saved.
      showConceptHint: !conceptsEnabled && isConceptTester,
    });
    const tools = conceptsEnabled ? [...TOOLS, ...PRODUCT_CONCEPT_TOOLS] : TOOLS;

    queriesRun = [];
    let sawTimeout = false;
    // One index over the catalog rows already fetched above -- no extra round
    // trip. It is what lets a result say which of its dimensions are narrowed
    // and which are pooled, using the column lists pg_catalog generated rather
    // than anything hand-maintained.
    const catalogIndex = buildCatalogIndex((catalogRows ?? []) as CatalogRow[]);
    // Per-query outcomes, for the audit row. Never result rows -- see
    // buildDiagnostics.
    const queryLog: Array<Record<string, unknown>> = [];
    // Which relations the model was given full cards for up front (keyword
    // ranking on the opening question) versus which it had to ask for
    // mid-investigation. A mismatch between the two IS the diagnosis when an
    // answer misreads a relation: it tells you whether the guidance was in
    // front of it at all.
    const describedRelations: string[] = [];
    let describeCallsUsed = 0;
    // WHERE A DATE IN A STATEMENT CAME FROM. Seeded with what the person wrote
    // and with today, then grown from the values queries actually return, so a
    // period boundary can be told apart from one the model picked. See
    // boundaryProvenance in evidence-scope.mjs for the failure this answers.
    const ISO_DATE = /\d{4}-\d{2}-\d{2}/g;
    const MAX_KNOWN_DATES = 2000;
    const knownDates = {
      results: new Set<string>(),
      question: new Set<string>([
        ...String(history.map((m) => m?.content || '').join(' ')).match(ISO_DATE) || [],
        new Date().toISOString().slice(0, 10),
      ]),
    };
    const harvestDates = (rows: unknown) => {
      if (knownDates.results.size >= MAX_KNOWN_DATES) return;
      try {
        for (const d of JSON.stringify(rows ?? null).match(ISO_DATE) || []) {
          if (knownDates.results.size >= MAX_KNOWN_DATES) break;
          knownDates.results.add(d);
        }
      } catch { /* a result that will not serialise tells us nothing; not worth failing over */ }
    };
    // Concepts created/updated/approved during THIS request, keyed by id so
    // a concept revised twice in one turn is returned once, in its final
    // state. Returned alongside the answer so the client can render the
    // structured card instead of relying on the model to re-narrate every
    // field as prose. Purely additive to the response shape -- a general
    // (non-concept) question leaves this empty and the field is omitted,
    // so nothing about an ordinary Ask SILO response changes.
    const conceptsTouched = new Map<string, Record<string, unknown>>();
    const conceptsPayload = () => ({
      ...(conceptsTouched.size ? { concepts: [...conceptsTouched.values()] } : {}),
      ...(suggestConceptWorkflow ? { suggest_workflow: 'product_concept' } : {}),
    });
    // Every url the hosted web_search tool actually surfaced, in the order it
    // surfaced them. Returned alongside the answer so a web-sourced claim is
    // checkable; the prompt already forbids blending one into an internal
    // number, but "say plainly it came from the web" is worth little if the
    // user cannot see WHICH page said it.
    const sources = new Map<string, { url: string; title: string | null }>();
    const sourcesPayload = () => (sources.size ? { sources: [...sources.values()] } : {});

    // Everything about HOW this answer was put together that is worth keeping:
    // which relations were in front of the model from the start, which it had
    // to fetch, and how much of the budget it spent. Assembled at logging time
    // so it always reflects the finished request.
    let investigationCheckpointSent = false;
    const contextLog = () => ({
      schema_detail_relations: schemaSlice.detailRelations,
      relations_described_mid_request: describedRelations,
      describe_calls_used: describeCallsUsed,
      describe_calls_allowed: MAX_DESCRIBE_CALLS_PER_REQUEST,
      correction_round_granted: correctionRoundGranted,
      // The inputs to that decision, so a refusal is diagnosable from the record
      // rather than being indistinguishable from "no correctable error".
      model_call_ms: modelCallMs,
      // The deadline each of those calls actually carried (0 = unbounded). The
      // pair is what makes the enforcement boundary auditable: model_call_ms
      // alone cannot show whether a fast request was fast or merely lucky.
      model_call_deadline_ms: modelCallDeadlineMs,
      workflow: activeWorkflow,
      // Which prompt guidance modules this request carried (see prompt-lib.mjs),
      // so an answer can be traced to the instructions it was written under.
      guidance_modules: guidance,
      model_usage: modelUsage,
      model_usage_total: sumUsage(modelUsage),
      provider_retries: providerRetries,
      elapsed_ms: elapsedMs(),
      investigation_checkpoint_sent: investigationCheckpointSent,
    });

    // THE ONLY WAY AN ANSWER LEAVES THIS FUNCTION. Both success paths (the
    // model finishing normally, and the forced final answer at the round or
    // wall-clock budget) go through here, so the mid-flight company re-check
    // cannot be present on one path and forgotten on the other -- which is
    // exactly how a guard like this usually rots.
    const finishWithAnswer = async (
      text: string,
      opts: { toolRounds: number; errorMessage?: string | null; partial?: string | null },
    ) => {
      const companyNow = await readActiveCompany();
      // Cannot establish it => cannot deliver. See readActiveCompany: letting an
      // unverifiable company through is the same outcome as not checking at all,
      // and it fails in the direction that shows one company's rows to another.
      if (!companyNow.ok) {
        console.error('[silo-chat] could not re-verify active company; answer discarded', { request_id: requestId });
        return reply(UNVERIFIED, 503);
      }
      if (companyNow.companyId !== companyAtStart.companyId) {
        // Deliberately NOT logged to silo_chat_audit_log: company_entity_id on
        // that row is stamped from active_company_id(), which now resolves to
        // the OTHER company, so logging would file this question's text under
        // a tenant it was never asked in. The edge-function log is the right
        // place for it.
        console.error('[silo-chat] active company changed mid-request; answer discarded', {
          request_id: requestId,
          from: companyAtStart.companyId,
          to: companyNow.companyId,
        });
        return reply({
          error: "Your active company changed while this answer was being put together, so it was discarded instead of being shown against the wrong company. Switch back and ask again.",
          company_changed: true,
        }, 409);
      }
      // THE ANSWER, CHECKED AGAINST THE ENVELOPES IT WAS WRITTEN FROM. See
      // auditAnswerClaims: on 2026-09-16 a sales result whose envelope said
      // `pooled_across: location_tag` was published as "online" sales, with the
      // prompt rule against exactly that already in place. The note is appended
      // rather than substituted, and the answer text is never altered -- a word
      // search must not be allowed to rewrite a correct answer.
      const claimFlags = auditAnswerClaims(text, queryLog.map((q) => q.scope));
      // Carry the status IN the persisted answer. Existing clients save and
      // recover answer text but do not retain the response's partial fields --
      // and the scope note has to survive that same round trip, since an answer
      // recovered without it reads as verified.
      const answer = (opts.partial
        ? `**Partial answer:** ${opts.partial}.\n\n${text}`
        : text) + formatClaimNote(claimFlags);
      const audited = await logAudit(callerClient!, {
        requestId,
        question,
        historySnapshot: history,
        answer,
        queriesRun,
        toolRounds: opts.toolRounds,
        status: 'ok',
        errorMessage: opts.errorMessage ?? null,
        diagnostics: buildDiagnostics(queryLog, {
          ...contextLog(),
          claim_flags: claimFlags,
          // false means no forced stop, NOT proof the analysis is complete.
          partial: Boolean(opts.partial),
          partial_reason: opts.partial ?? null,
        }),
      });
      return reply({
        answer,
        queries_run: queriesRun,
        // Only when something was flagged. A consumer that wants to render the
        // scope check as its own element rather than as answer text can; the
        // note is in the answer either way so nothing has to.
        ...(claimFlags.length ? { claim_flags: claimFlags } : {}),
        // Only present when the investigation was cut short. The client and
        // anyone auditing can then tell a finished answer from one written
        // against an unfinished check -- which the answer text is also
        // required to say, but a flag is not something prose compression can
        // drop.
        ...(opts.partial ? { partial: true, partial_reason: opts.partial } : {}),
        // Only ever sent when it is FALSE. The client uses it to avoid
        // promising a recovery it cannot perform -- an answer whose audit row
        // was rejected is not findable after a dropped connection.
        ...(audited ? {} : { audit_logged: false }),
        ...conceptsPayload(),
        ...sourcesPayload(),
      });
    };

    // Circuit breaker for Product Concepts phase 1: a live draft ran 14
    // rounds before calling create_product_concept at all -- 2 of them were
    // outright redundant re-runs of a query it already had the answer to,
    // the rest were open-ended follow-up investigation past what a "fast
    // core draft" needs. Prompt wording alone didn't hold (it broke its own
    // "combine into one query" instruction in the very next round), so this
    // is enforced in code: past PRE_DRAFT_NUDGE_ROUND rounds with no
    // create_product_concept/update_product_concept call yet, inject a hard
    // stop telling it to draft now with whatever it has.
    const PRE_DRAFT_NUDGE_ROUND = 4;
    let hasDraftedConcept = false;
    // Set right after the nudge below is pushed, so the VERY NEXT round is
    // forced to actually call create_product_concept instead of being asked
    // nicely -- live, the model answered a nudge with a prose apology
    // instead of the tool call the nudge asked for. Consumed (reset) after
    // one use whether or not the model complied, so it never traps an
    // unrelated later round.
    let forceNudgeTool = false;

    // Rounds actually consumed, so the audit row reports the real number
    // when a deadline stop cuts the loop short of MAX_TOOL_ROUNDS.
    let roundsUsed = 0;

    // The part of the answer already written before an output-length cutoff.
    //
    // The max_tokens handling below was half a fix: it correctly refused to
    // ship a truncated fragment as finished, and asked the model to continue
    // -- then RETURNED ONLY THE CONTINUATION. The user got an answer starting
    // mid-thought, missing its opening figures, and the audit row recorded
    // that same headless text as the answer given. The longer the answer, the
    // more of it was lost, so it bit hardest on exactly the questions that
    // needed the evidence up front. Reproduced end to end through the handler
    // with mocked model responses before this was written.
    //
    // Concatenated with NO separator on purpose: the continuation prompt says
    // "continue directly from where it left off", and a cutoff lands mid-word
    // as often as not. Reset whenever the model goes back to running tools,
    // because at that point the prose it had started is abandoned, not paused.
    let answerSoFar = '';

    // See CORRECTION_ROUND_CUTOFF_MS. `lastRoundHadCorrectableError` is reset
    // at the top of every round, so it always describes the round just
    // finished, never an older one.
    let correctionRoundGranted = false;
    let lastRoundHadCorrectableError = false;
    // What a model round has actually cost THIS request. The wall clock is
    // spent here, not in the database, so this is the only number that makes a
    // time reservation meaningful.
    const modelCallMs: number[] = [];
    // Every deadline actually imposed on a call, in call order; 0 means the
    // call ran unbounded. Recorded because a deadline that is never applied and
    // one that is generous look identical from the outside once the request
    // succeeds, and the whole point of this is the case that does not succeed.
    const modelCallDeadlineMs: number[] = [];
    // Per-call token usage, straight from the API's own usage block, and every
    // provider retry. At 10-15 users the questions to answer are "what does a
    // question cost", "is the shared core actually being read from cache" and
    // "is the provider pushing back" -- none of which the audit row could say.
    const modelUsage: Array<ReturnType<typeof pickUsage>> = [];
    const providerRetries: Array<{ status: number; wait_ms: number }> = [];
    auditSoFar = () => ({ toolRounds: roundsUsed, diagnostics: buildDiagnostics(queryLog, contextLog()) });
    const timedCallAnthropic = async (...args: Parameters<typeof callAnthropic>) => {
      const startedCallAt = Date.now();
      const opts = args[3] || {};
      modelCallDeadlineMs.push(opts.timeoutMs || 0);
      try {
        const data = await callAnthropic(args[0], args[1], args[2], {
          ...opts,
          // A call with no deadline of its own may retry only while the
          // request is still inside the budget that starts new work.
          retryUntil: opts.retryUntil ?? startedAt + WALL_CLOCK_BUDGET_MS,
          onRetry: (status, waitMs) => providerRetries.push({ status, wait_ms: waitMs }),
        });
        modelUsage.push(pickUsage(data?.usage));
        return data;
      } finally {
        modelCallMs.push(Date.now() - startedCallAt);
      }
    };
    const correctionFits = () => correctionRoundFits({ elapsedMs: elapsedMs(), modelCallMs });
    // A granted correction round is the one place a call is started AFTER the
    // budget is spent, so it is the one place a slow call has nothing left to
    // absorb it. It gets an absolute deadline that reserves the query it is
    // about to run plus the forced final that reports the result; set for that
    // round only, then cleared.
    let correctionCallTimeoutMs = 0;
    /** The deadline for a forced final answer: everything left, since nothing
     *  is reserved past it. A remaining budget of 0 is NOT "unbounded" -- an
     *  unbounded call at 140s is precisely the one the gateway kills -- so it
     *  raises instead, which still reaches the audit row. */
    const finalCallDeadline = () => {
      const ms = modelCallTimeoutMs({ elapsedMs: elapsedMs() });
      if (!ms) throw new ModelCallDeadlineError(0);
      return ms;
    };

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (elapsedMs() >= WALL_CLOCK_BUDGET_MS) {
        const canCorrect = !correctionRoundGranted
          && lastRoundHadCorrectableError
          && correctionFits();
        if (!canCorrect) break;
        correctionRoundGranted = true;
        // Always positive where a grant is possible at all: correctionRoundFits
        // cannot admit a round past ~100s elapsed, and this reserves 22s of the
        // 140s line. Guarding for 0 here would be a branch nothing can reach --
        // budget-lib's own suite asserts the two constants keep that invariant
        // instead, where a change to either one is what actually fails.
        correctionCallTimeoutMs = modelCallTimeoutMs({
          elapsedMs: elapsedMs(),
          reserveMs: QUERY_CEILING_MS + MIN_FINAL_CALL_MS,
        });
        // Consume the investigation checkpoint if it has not fired yet. The two
        // say opposite things -- the checkpoint asks for breadth across
        // unmeasured areas, this asks for one specific failed query -- and the
        // handler test caught them landing in the same round, in that order, so
        // the correction was the instruction NOT read last. Two contradictory
        // instructions in one round are worse than either alone.
        investigationCheckpointSent = true;
        messages.push({
          role: 'user',
          content: 'One extra round, granted because your last round hit a correctable error and the budget is otherwise spent. Spend it on the SINGLE most valuable query that failed, using the exact column names the error hint gave you. Do not start a new line of investigation, do not re-run discovery, and do not repeat a query that timed out. If the correction succeeds you will write the answer immediately afterwards, so make this the measure the question most depends on.',
        });
      }
      lastRoundHadCorrectableError = false;
      roundsUsed = round + 1;
      // Do not interrupt a cut-off prose continuation or the separate concept
      // workflow. Tool results have already been appended before this point.
      if (!investigationCheckpointSent && !answerSoFar
          && activeWorkflow !== 'product_concept' && !actingOnConcept
          && elapsedMs() >= INVESTIGATION_CHECKPOINT_MS) {
        investigationCheckpointSent = true;
        messages.push({
          role: 'user',
          content: 'Investigation checkpoint: the remaining query time is limited. Tools are still available. Revisit every part of the original question and prioritize the smallest useful aggregate for requested areas you have not measured yet before drilling further into areas already covered. Reuse existing results and exact columns already described; do not repeat discovery. Keep the comparison dates and units compatible. If a missing linkage or coverage gap blocks the decision, say what is missing rather than substituting a different metric. This is not an instruction to stop early or to write anything to the database.',
        });
      }
      // Untyped, matching the `const data = await ...` it replaces: callAnthropic
      // returns res.json(). An annotation here would be narrower than the block
      // callbacks below already assume.
      let data;
      try {
        data = await timedCallAnthropic(
          messages,
          systemPrompt,
          tools,
          {
            ...(forceNudgeTool ? { forceTool: 'create_product_concept' as const } : {}),
            ...(correctionCallTimeoutMs ? { timeoutMs: correctionCallTimeoutMs } : {}),
          },
        );
      } catch (err) {
        // A correction round that runs past its deadline is not a failed
        // request: everything gathered before it is still good, and the time
        // it was holding back was reserved precisely so the forced final below
        // can still write that up. Anything else propagates as before.
        if (!(err instanceof ModelCallDeadlineError)) throw err;
        correctionCallTimeoutMs = 0;
        break;
      }
      correctionCallTimeoutMs = 0;
      forceNudgeTool = false;
      const blocks = data.content || [];
      collectSources(blocks, sources);
      const toolUses = blocks.filter((b: { type: string }) => b.type === 'tool_use');

      if (!toolUses.length) {
        // RAW, then trimmed separately. The seam between a cut-off segment and
        // its continuation is exactly one space wide, and it lives in the
        // whitespace at the edges: trimming each half before joining turns
        // "...before. The" + " biggest mover..." into "Thebiggest". Only the
        // finished answer is trimmed.
        const rawText = blocks.map((b: { text?: string }) => b.text || '').join('');
        const text = rawText.trim();
        // A max_tokens cutoff can still leave non-empty (but truncated,
        // often mid-word) text -- observed live on a holiday-collection
        // draft that hit the old 4096 cap while narrating a long answer.
        // Treating any non-empty text as "done" shipped that fragment to
        // the user as if it were complete. Never accept a cut-off response
        // as final, even a long one; ask it to finish instead.
        if (text && data.stop_reason !== 'max_tokens') {
          return await finishWithAnswer((answerSoFar + rawText).trim(), { toolRounds: round + 1 });
        }
        if (text) {
          // max_tokens cutoff with partial text -- keep what was written and
          // continue the SAME answer rather than restarting it from scratch.
          // Keeping it is the half that was missing: without this line the
          // opening of every long answer was thrown away.
          answerSoFar += rawText;
          messages.push({ role: 'assistant', content: blocks });
          messages.push({
            role: 'user',
            content: "That last response got cut off by the output length limit before it finished. Continue directly from where it left off -- do not restart or repeat what you already wrote. If you were narrating a long answer, cut it down and lead with the key numbers/decisions instead of restating everything.",
          });
          continue;
        }
        // A natural (non-round-cap) stop with literally no text in it --
        // observed live after a confused multi-round date-coverage
        // investigation. Logging and returning an empty answer here would
        // silently show the user nothing at all. Nudge for a real answer
        // instead of treating blank as done; naturally bounded by
        // MAX_TOOL_ROUNDS same as any other round.
        messages.push({ role: 'assistant', content: blocks });
        messages.push({
          role: 'user',
          // Branches on whether an answer was already part-written: telling a
          // model that had been cut off mid-answer to "answer the question
          // now" invites it to start over, and the restart would be appended
          // to the half already kept.
          content: answerSoFar
            ? "That last response came back empty. You had already started an answer above and it was cut off -- continue it from exactly where it stopped, in plain language, using whatever you've already gathered. Do not restart it and do not repeat what you already wrote."
            : "That last response had no text in it. Answer the question now in plain language, using whatever you've already gathered -- don't just stop silently.",
        });
        continue;
      }

      messages.push({ role: 'assistant', content: blocks });
      // Back to running tools: whatever prose it had begun is abandoned, not
      // paused, so it must not be glued to the front of the eventual answer.
      answerSoFar = '';

      const toolResults = [];
      for (const use of toolUses) {
        let resultContent: string | Array<Record<string, unknown>>;
        if (use.name === 'create_product_concept' || use.name === 'update_product_concept') hasDraftedConcept = true;

        // Pre-check, NOT the boundary -- see WRITE_COMPANY_NOTE above. It
        // turns the common case into a sentence a person can act on rather
        // than a raw RLS rejection. The row itself is kept in the right
        // company by the explicit company_entity_id on each write, because
        // this read and that write are different round trips and anything
        // between them can race.
        //
        // Centralized here rather than repeated per branch: the failure mode
        // of the repeated version is that the NEXT write tool added quietly
        // has no check, and nothing would show that.
        //
        // Stricter than the delivery check on purpose: a write requires the
        // company KNOWN, non-null and equal. Delivering an answer under an
        // unverifiable company is bad; committing a row under one is worse.
        if (WRITE_TOOLS.has(use.name)) {
          const companyNow = await readActiveCompany();
          const sameCompany = companyNow.ok
            && !!companyNow.companyId
            && companyNow.companyId === companyAtStart.companyId;
          if (!sameCompany) {
            console.error('[silo-chat] refused a write: active company not confirmed unchanged', {
              request_id: requestId,
              tool: use.name,
              from: companyAtStart.companyId,
              to: companyNow.ok ? companyNow.companyId : 'unverified',
            });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: use.id,
              content: 'Error: nothing was saved. The company this chat is working in changed (or could not be confirmed) since the question was asked, and a write is not allowed to land in a different company than the one being discussed. Tell the user plainly that it was NOT saved and that they should reload the page and ask again -- do not retry this tool.',
            });
            continue;
          }
        }

        if (use.name === 'save_note') {
          const note = String(use.input?.note || '').trim();
          const category = ['brand', 'strategy'].includes(String(use.input?.category))
            ? String(use.input?.category)
            : 'general';
          // Only honoured for strategy notes -- the column exists for
          // direction that goes stale, and a horizon on a fact would just
          // expire something that is still true.
          const effectiveUntil = category === 'strategy' && use.input?.effective_until
            ? String(use.input.effective_until)
            : null;
          try {
            if (!note) throw new Error('Empty note');
            const { error } = await callerClient.from('silo_chat_notes')
              // EXPLICIT company, not left to the stamping trigger. See
              // WRITE_COMPANY_NOTE above the tool loop: the gate and this
              // insert are two round trips, and the trigger fills an OMITTED
              // company from active_company_id() AT WRITE TIME -- so a switch
              // landing between them stamps the new company and passes its
              // RLS. Sending the starting company makes the check atomic:
              // the trigger leaves a non-null value alone, and the insert
              // policy's `company_entity_id = active_company_id()` then
              // REFUSES the row if the active company has moved.
              .insert({
                note,
                category,
                effective_until: effectiveUntil,
                company_entity_id: companyAtStart.companyId,
              });
            if (error) throw new Error(error.message);
            resultContent = 'Saved.';
          } catch (err) {
            // RLS silently returns zero rows rather than a permission error
            // on insert denial, but PostgREST still surfaces a policy
            // violation as an error here -- either way, tell the model so
            // it can relay a clear message instead of claiming success.
            resultContent = `Error: could not save note -- ${String((err as Error)?.message || err)}. This is likely a permissions issue (save_note needs Ask SILO management access -- exec/owner-tier, or a specific grant).`;
          }
        } else if (use.name === 'view_ad_creative_image') {
          const adId = String(use.input?.ad_id || '').trim();
          try {
            if (!adId) throw new Error('ad_id is required');
            // RLS-scoped like everything else here -- a user can only view
            // creatives from their own active company's ad data.
            const { data: creative, error } = await callerClient
              .from('meta_ad_creatives')
              .select('thumbnail_url, title, object_type')
              .eq('ad_id', adId)
              .maybeSingle();
            if (error) throw new Error(error.message);
            if (!creative?.thumbnail_url) throw new Error(`No thumbnail_url found for ad_id ${adId}`);
            const imgRes = await fetch(creative.thumbnail_url);
            if (!imgRes.ok) throw new Error(`Could not fetch image (HTTP ${imgRes.status})`);
            const mediaType = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
            if (!mediaType.startsWith('image/')) throw new Error(`URL did not return an image (got ${mediaType})`);
            const bytes = new Uint8Array(await imgRes.arrayBuffer());
            if (bytes.byteLength > 5 * 1024 * 1024) throw new Error('Image is too large to view (over 5MB)');
            resultContent = [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: encodeBase64(bytes) } },
              { type: 'text', text: `Creative for ad ${adId}${creative.title ? ` -- "${creative.title}"` : ''} (${creative.object_type || 'unknown format'}).` },
            ];
          } catch (err) {
            resultContent = `Error: could not load creative image -- ${String((err as Error)?.message || err)}`;
          }
        } else if (use.name === 'inspect_storefront_page') {
          // Up to five pages per request, one per call, always sequential.
          // STILL NOT A CRAWLER: it never follows links out of a page and
          // never enumerates URLs from the page itself. A URL either came
          // from the user or from a trusted company-scoped SILO query result
          // (seo_collection_candidates.inspect_url). Crawling is a separate
          // decision with its own robots and rate-limit questions, and
          // raising the cap is not how it gets made.
          const target = String(use.input?.url || '').trim();
          const shape = looksInspectable(target);
          const spend = shape.ok ? inspectionBudget.take(target) : { ok: false, reason: shape.reason };
          if (!spend.ok) {
            resultContent = `Error: ${spend.reason}`;
          } else {
            try {
              // The CALLER'S JWT is forwarded, not a service-role key and not
              // an assertion by this function about who is asking. page-inspect
              // reads its host allowlist through that token, so RLS decides
              // which company's storefront may be fetched -- the tenant check
              // and the allowlist stay the same query, and Ask SILO cannot
              // widen either by calling on someone's behalf.
              const insRes = await fetch(`${SUPABASE_URL}/functions/v1/page-inspect`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${jwt}`,
                  apikey: SUPABASE_ANON_KEY,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url: target }),
              });
              const ins = await insRes.json().catch(() => ({}));
              if (!insRes.ok || ins?.ok === false) {
                // Surface the real reason. no_allowlisted_hosts and
                // host_not_allowed are both legitimate refusals the model
                // should relay rather than retry or work around.
                resultContent = `Error: page inspection failed (HTTP ${insRes.status}) -- ${ins?.error || 'unknown error'}`
                  + (ins?.detail ? ` (${ins.detail})` : '')
                  + (Array.isArray(ins?.allowed_hosts) ? ` Allowed hosts: ${ins.allowed_hosts.join(', ')}.` : '');
              } else {
                // Only the on-page facts. Deliberately no invitation to infer
                // anything about search: meta_robots is what the page SAYS,
                // and SILO holds no indexing, ranking or query data at all.
                resultContent = JSON.stringify({
                  inspection_id: ins.inspection_id,
                  requested_url: ins.requested_url,
                  final_url: ins.final_url,
                  http_status: ins.http_status,
                  redirect_chain: ins.redirect_chain,
                  title: ins.title,
                  title_length: ins.title_length,
                  meta_description: ins.meta_description,
                  meta_description_length: ins.meta_description_length,
                  canonical_url: ins.canonical_url,
                  meta_robots: ins.meta_robots,
                  og_title: ins.og_title,
                  og_description: ins.og_description,
                  h1: ins.h1,
                  h1_count: ins.h1_count,
                  h2_count: ins.h2_count,
                  word_count: ins.word_count,
                  image_count: ins.image_count,
                  images_missing_alt: ins.images_missing_alt,
                  jsonld_types: ins.jsonld_types,
                  is_truncated: ins.is_truncated,
                  fetch_error: ins.fetch_error,
                  fetched_at: ins.fetched_at,
                  note: 'These are facts the PAGE states about itself, captured just now. '
                    + 'meta_robots is a directive the page gives, NOT evidence about whether anything '
                    + 'has indexed, crawled or ranked it -- SILO holds no search-engine data. '
                    + 'word_count measures server-rendered HTML, so JavaScript-injected content is not counted. '
                    + 'If is_truncated or fetch_error is set, this capture is partial: say so.',
                });
              }
            } catch (err) {
              resultContent = `Error: could not reach the page inspector -- ${String((err as Error)?.message || err)}`;
            }
          }
        } else if (use.name === 'create_product_concept') {
          const input = use.input || {};
          try {
            const title = String(input.title || '').trim();
            if (!title) throw new Error('title is required');
            // Duplicate guard. The prompt already says refinement is a
            // revision, never a second concept -- but that instruction
            // depends on an id the model often cannot see (see the history
            // mapping above), so it cannot hold on its own. Live on
            // 2026-08-25 a request to change a quantity produced a second
            // "Timeless Ballplayers Tee" row five minutes after the first.
            //
            // Checked server-side because that is the only place it works
            // from a cold thread: a client-side failure means the assistant
            // turn is never recorded at all, and the recovery path reads
            // silo_chat_audit_log, which stores answers and SQL but not
            // concepts. Exact (case-insensitive) title match only --
            // fuzzy matching would block legitimate collection siblings,
            // which differ precisely by title. RLS scopes this to the
            // caller's own company automatically.
            const { data: dupe } = await callerClient
              .from('product_concepts')
              .select('id, title, status, phase, current_revision_number')
              .eq('status', 'draft')
              .ilike('title', title)
              .limit(1)
              .maybeSingle();
            if (dupe) {
              resultContent = `Error: a draft concept titled "${dupe.title}" already exists (id ${dupe.id}, phase ${dupe.phase}, revision ${dupe.current_revision_number}). Do NOT create a duplicate -- call update_product_concept with id ${dupe.id} to revise that concept instead. Only create a new concept if this is genuinely a DIFFERENT product (for a collection sibling, give it its own distinct title and set parent_concept_id).`;
              toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: resultContent });
              continue;
            }
            // Typed as an open record because the structured-brief loop
            // below adds keys dynamically; an inferred literal type makes
            // that a compile error.
            const payload: Record<string, unknown> = {
              // See WRITE_COMPANY_NOTE. This insert is especially exposed: a
              // duplicate-title lookup runs between the gate and the write,
              // widening the window the gate cannot cover.
              company_entity_id: companyAtStart.companyId,
              title,
              concept_summary: input.concept_summary ?? null,
              marketing_angle: input.marketing_angle ?? null,
              audience: input.audience ?? null,
              audience_tags: Array.isArray(input.audience_tags) ? input.audience_tags : [],
              suggested_qty: input.suggested_qty != null ? Number(input.suggested_qty) : null,
              suggested_factory_id: input.suggested_factory_id || null,
              suggested_channels: Array.isArray(input.suggested_channels) ? input.suggested_channels : [],
              suggested_retail_dtc_notes: input.suggested_retail_dtc_notes ?? null,
              suggested_launch_date: input.suggested_launch_date || null,
              suggested_launch_notes: input.suggested_launch_notes ?? null,
              suggested_launch_time: input.suggested_launch_time ?? null,
              suggested_size_breakdown: input.suggested_size_breakdown ?? null,
              suggested_channel_split: input.suggested_channel_split ?? null,
              suggested_marketing_spend: input.suggested_marketing_spend ?? null,
              suggested_weekly_revenue_projection: input.suggested_weekly_revenue_projection ?? null,
              suggested_email_sms_plan: input.suggested_email_sms_plan ?? null,
              suggested_marketing_copy: input.suggested_marketing_copy ?? null,
              reasoning: input.reasoning ?? null,
              reference_image_urls: Array.isArray(input.reference_image_urls) ? input.reference_image_urls : [],
              parent_concept_id: input.parent_concept_id || null,
            };
            // Structured-brief fields (20260825120000). Only keys the model
            // actually supplied are sent -- an omitted field must stay NULL
            // ("not recorded") rather than being written as an empty value,
            // since telling those two apart is the whole point of the
            // evidence/unknowns design.
            for (const key of Object.keys(STRUCTURED_CONCEPT_FIELDS)) {
              if (input[key] !== undefined) payload[key] = input[key];
            }
            const { data: row, error } = await callerClient
              .from('product_concepts')
              .insert(payload)
              .select('*')
              .single();
            if (error) throw new Error(error.message);
            if (row) conceptsTouched.set(row.id, row);
            resultContent = JSON.stringify(row);
          } catch (err) {
            resultContent = `Error: could not create product concept -- ${String((err as Error)?.message || err)}`;
          }
        } else if (use.name === 'update_product_concept') {
          const input = use.input || {};
          try {
            const id = String(input.id || '').trim();
            if (!id) throw new Error('id is required');
            const patch: Record<string, unknown> = {};
            for (const key of CONCEPT_UPDATABLE_FIELDS) {
              if (input[key] !== undefined) patch[key] = input[key];
            }
            // revision_note alone is not a change worth recording -- the
            // DB trigger ignores it when diffing, so an update carrying
            // only a note would bump nothing and mint no revision.
            if (!Object.keys(patch).some((k) => k !== 'revision_note')) {
              throw new Error('no fields to update');
            }
            // Phase is derived from what was actually written, not from the
            // model asserting it: filling any launch-plan field IS what
            // "full brief" means. Keeping it inferred here means the row's
            // phase can never disagree with its own contents, and the card
            // can offer "Build full plan" purely from state.
            if (PHASE_2_FIELDS.some((k) => patch[k] != null)) patch.phase = 'full_brief';
            const { data: row, error } = await callerClient
              .from('product_concepts')
              .update(patch)
              .eq('id', id)
              // Scoped to the STARTING company for the same reason the inserts
              // stamp it: an update cannot be refused by a WITH CHECK it still
              // satisfies, so the row is addressed by company instead. If the
              // active company moved, this matches nothing rather than editing
              // a row in the company that is now active.
              .eq('company_entity_id', companyAtStart.companyId)
              .select('*')
              .maybeSingle();
            if (error) throw new Error(error.message);
            if (!row) throw new Error(WRONG_COMPANY_ROW);
            if (row) conceptsTouched.set(row.id, row);
            resultContent = JSON.stringify(row);
          } catch (err) {
            resultContent = `Error: could not update product concept -- ${String((err as Error)?.message || err)}`;
          }
        } else if (use.name === 'approve_product_concept') {
          const input = use.input || {};
          try {
            const id = String(input.id || '').trim();
            if (!id) throw new Error('id is required');
            const { data: row, error } = await callerClient
              .from('product_concepts')
              .update({
                status: 'approved',
                approved_by: userData.user.id,
                approved_at: new Date().toISOString(),
                revision_note: 'Approved.',
              })
              .eq('id', id)
              // Same company scoping as update_product_concept above.
              .eq('company_entity_id', companyAtStart.companyId)
              .select('*')
              .maybeSingle();
            if (error) throw new Error(error.message);
            if (!row) throw new Error(WRONG_COMPANY_ROW);
            if (row) conceptsTouched.set(row.id, row);
            resultContent = JSON.stringify(row);
          } catch (err) {
            resultContent = `Error: could not approve product concept -- ${String((err as Error)?.message || err)}. This likely means the caller doesn't have purchasing write access yet (the same access PO Builder requires) -- tell the user plainly rather than retrying.`;
          }
        } else if (use.name === 'describe_relations') {
          // Fixes the half of the context problem that ranking cannot: the
          // detail slice is chosen from the OPENING question's words, once,
          // and frozen for the request (it has to be -- the system prompt is
          // one cached block and must stay byte-identical across rounds). An
          // investigation moves. This is the way to widen the guidance
          // WITHOUT touching the cached prefix: the card arrives as a tool
          // result instead.
          const asked = Array.isArray(use.input?.relations)
            ? use.input.relations.map((r: unknown) => String(r || '').trim()).filter(Boolean)
            : [];
          if (!asked.length) {
            resultContent = 'Error: relations must be a non-empty array of table/view names.';
          } else if (describeCallsUsed >= MAX_DESCRIBE_CALLS_PER_REQUEST) {
            resultContent = `Error: the describe_relations budget for this question (${MAX_DESCRIBE_CALLS_PER_REQUEST} calls) is spent. Work with the cards you already have; if a relation you need is still only a one-liner, say in your answer that you could not confirm its meaning rather than assuming it.`;
          } else {
            describeCallsUsed++;
            const wanted = asked.slice(0, MAX_DESCRIBE_RELATIONS_PER_CALL);
            const byName = new Map(
              ((catalogRows ?? []) as CatalogRow[]).map((r) => [r.relname, r]),
            );
            const cards = wanted.map((name) => {
              const row = byName.get(name);
              if (!row) {
                return {
                  relation: name,
                  found: false,
                  note: 'not in the schema map. It may be hidden (credential/internal tables are excluded), misspelled, or not exist. Check information_schema before concluding anything about it.',
                };
              }
              const desc = row.description || '';
              return {
                relation: row.relname,
                kind: row.relkind,
                columns: (row.columns || []).map((c) => `${c.name} (${c.type})`),
                business_meaning: desc.length > MAX_CARD_DESCRIPTION_CHARS
                  ? `${desc.slice(0, MAX_CARD_DESCRIPTION_CHARS)}…[card truncated]`
                  : desc,
              };
            });
            for (const name of wanted) if (!describedRelations.includes(name)) describedRelations.push(name);
            // COVERAGE IS MEASURED, NOT REMEMBERED. A card that states its own
            // history depth in words goes stale silently and then misdirects:
            // meta_ad_performance_daily's said "only about 7 weeks of history
            // (from 2026-07-08) ... do not use it for launch comps" while the
            // table actually held 415 days back to 2025-07-28. Replacing that
            // sentence with a fresher sentence just restarts the clock, so the
            // range is read off the data at request time instead. Day-grain
            // date columns only: created_at/synced_at describe when a row was
            // written, not what period it covers, and reporting one as
            // "coverage" is its own wrong answer.
            const measurable = wanted
              .map((n) => byName.get(n))
              .filter((r): r is CatalogRow => !!r)
              .map((r) => ({
                rel: r.relname,
                col: (r.columns || []).find((c) => c.name === 'day_date' && /^date$/i.test(c.type))
                  || (r.columns || []).find((c) => /^date$/i.test(c.type)),
              }))
              .filter((x) => !!x.col);
            let coverage: unknown = null;
            // Every identifier here comes from the catalog row we just read,
            // never from the model's input -- byName.get() IS the allowlist,
            // and the shape check below is belt to its braces: an identifier
            // that is not a plain lowercase name is skipped rather than
            // interpolated. The statement also runs through
            // chat_run_readonly_query, which is SECURITY INVOKER, read-only
            // and SELECT/WITH-only, so this is the caller's own access either
            // way.
            const plainIdent = /^[a-z_][a-z0-9_]*$/;
            const safe = measurable.filter((x) => plainIdent.test(x.rel) && plainIdent.test(x.col!.name));
            if (safe.length) {
              const sql = safe
                .map((x) => `select '${x.rel}' as relation, '${x.col!.name}' as date_column, min(${x.col!.name})::text as earliest, max(${x.col!.name})::text as latest from ${x.rel}`)
                .join(' union all ');
              const startedCoverageAt = Date.now();
              try {
                const { data, error } = await callerClient.rpc('chat_run_readonly_query', { query: sql });
                if (error) throw new Error(error.message);
                coverage = data;
                // Logged as its own kind. It is deliberately NOT pushed into
                // queriesRun -- that array is what the user's query panel shows
                // and what "Save report" re-runs, and a coverage probe is
                // neither of those. But it is a query that can fail or be slow,
                // so leaving it out of the diagnostics would put a blind spot
                // in the very record added to remove blind spots.
                queryLog.push({
                  kind: 'coverage',
                  relations: safe.map((x) => x.rel),
                  ok: true,
                  ms: Date.now() - startedCoverageAt,
                });
              } catch (err) {
                const why = String((err as Error)?.message || err);
                coverage = { measured: false, why };
                queryLog.push({
                  kind: 'coverage',
                  relations: safe.map((x) => x.rel),
                  ok: false,
                  ms: Date.now() - startedCoverageAt,
                  error: why,
                });
              }
            }
            resultContent = JSON.stringify({
              cards,
              measured_coverage: coverage,
              coverage_note: coverage
                ? 'earliest/latest are the real min and max of that day-grain column, read just now under your own access. A relation with no day-grain date column is absent from this list -- that is "not measured here", never "no history". Where measured_coverage says measured:false the range is UNKNOWN; do not fall back to any range written in a card.'
                : 'none of these relations carries a day-grain date column, so no coverage was measured. That is not a statement that they lack history.',
              budget: `${MAX_DESCRIBE_CALLS_PER_REQUEST - describeCallsUsed} describe_relations call(s) left on this question`,
            });
          }
        } else {
          // `query` is what the model wrote and is what its evidence scope is
          // derived from; `executed` is the value-identical fast shape (see
          // query-shape-lib.mjs) and is what runs AND what is stored, so a
          // saved report or dashboard re-running it gets the fast shape too.
          const query = String(use.input?.query || '');
          const { sql: executed, rewrites } = rewriteSlowShapes(query);
          queriesRun.push(executed);
          const resultId = `R${queriesRun.length}`;
          const startedQueryAt = Date.now();
          try {
            const { data: rows, error } = await callerClient.rpc('chat_run_readonly_query', { query: executed });
            if (error) throw new Error(error.message);
            // The rows no longer travel alone. What they are -- and are not --
            // restricted to is derived here and returned WITH them, because by
            // the time the answer is written the model is looking at a dozen
            // anonymous arrays and cannot tell which was all-platform and
            // which was per-platform. That is not a hypothetical: it is the
            // confirmed cause of the 2026-09-16 mislabelling.
            // Provenance is read BEFORE the harvest, or a statement would
            // source its own literals from its own result and nothing would
            // ever be unsourced.
            resultContent = renderQueryResult(query, rows, catalogIndex, { resultId, knownDates });
            harvestDates(rows);
            queryLog.push({
              result_id: resultId,
              round: roundsUsed,
              sql: query,
              ...(rewrites.length ? { executed_sql: executed, rewrites } : {}),
              ok: true,
              row_count: Array.isArray(rows) ? rows.length : (rows == null ? 0 : 1),
              ms: Date.now() - startedQueryAt,
              ...(relationsInStatement(query).length
                ? {
                    scope: describeEvidenceScope(query, catalogIndex, {
                      resultId,
                      knownDates,
                      rowCount: Array.isArray(rows) ? rows.length : (rows == null ? 0 : 1),
                    }),
                  }
                : {}),
            });
          } catch (err) {
            const rawMessage = String((err as Error)?.message || err);
            resultContent = `Error: ${annotateColumnError(rawMessage, query, catalogIndex)}`;
            if (/statement timeout/i.test(resultContent)) sawTimeout = true;
            if (CORRECTABLE_QUERY_ERROR.test(rawMessage)) lastRoundHadCorrectableError = true;
            queryLog.push({
              result_id: resultId,
              // Which round a statement ran in. Absent until now, and its
              // absence is what made the Sonic trace ambiguous about whether
              // the failed spend query shared a round with a successful one.
              round: roundsUsed,
              sql: query,
              ...(rewrites.length ? { executed_sql: executed, rewrites } : {}),
              ok: false,
              ms: Date.now() - startedQueryAt,
              error: rawMessage,
            });
          }
        }
        toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: resultContent });
      }
      messages.push({ role: 'user', content: toolResults });

      if (conceptBreakerArmed && !hasDraftedConcept && round === PRE_DRAFT_NUDGE_ROUND) {
        messages.push({
          role: 'user',
          content: "You've used several tool rounds without creating a draft concept yet. If this conversation is drafting a PRODUCT, stop investigating and call create_product_concept now using your best assessment from what you've already gathered -- leave any field you're not confident about blank rather than continuing to research it. If it is NOT a product-drafting request (an analytical question, a plan, a forecast, a report), ignore this entirely and simply answer the question -- do NOT create a concept.",
        });
        // Deliberately NOT forcing tool_choice here any more. Forcing it
        // guaranteed a write on a misread: live on 2026-08-25 an analytical
        // demand-planning question armed the breaker, and because the tool
        // was forced the model could not decline -- it wrote a concept row
        // titled after the analysis, with no quantity. The arming
        // heuristics are text-matching and will keep misfiring in both
        // directions (a trailing "?" disarms a genuine draft; "mock up"
        // armed an analysis), so the escape hatch has to survive a wrong
        // arm. A slow draft that goes unhurried costs a few rounds; a
        // forced spurious write costs a junk row in a table people are
        // meant to trust.
        forceNudgeTool = false;
      }
    }

    // Round budget OR wall-clock budget exhausted while the model still
    // wanted tools. Never turn
    // that into a user-facing error while sitting on real query results --
    // the 2026-08-20 uncrustables incident ran 18 clean queries (the whole
    // analysis) and then showed the user "couldn't land on an answer"
    // because no round was left to write it. Force one final tool-less turn
    // that answers from the data already gathered; the error path below
    // survives only as a fallback for when even that fails.
    const hitWallClock = elapsedMs() >= WALL_CLOCK_BUDGET_MS;
    try {
      messages.push({
        role: 'user',
        // Three cases, not two. If an answer was already part-written and cut
        // off by the output limit, asking for "your best final answer now"
        // gets a RESTART -- which then gets concatenated onto the half already
        // kept, producing an answer that says everything twice. Ask it to
        // finish instead.
        // WHAT THIS USED TO SAY, and why it changed. Both budget prompts ended
        // "state the assumption or caveat in one short line INSTEAD OF
        // REFUSING TO ANSWER". That sentence was written against a real
        // failure (18 clean queries thrown away because no round was left to
        // write them up) and it overshot: it reads as a demand for a complete
        // answer, and a complete answer to "give me three actions" is three
        // actions -- whether or not the evidence reached them. The traced
        // 2026-09-16 answer stopped at round 19 of 20 and recommended cutting
        // subscriber-acquisition spend on immediate purchase ROAS alone, with
        // no subscriber-to-order linkage anywhere in what it had.
        //
        // Returning the gathered work is still right. Manufacturing the part
        // that was never gathered is not. So the instruction now asks for the
        // same thing in two named parts -- what is supported, and what is
        // unfinished -- and says plainly that an observation may not be
        // promoted to a recommendation to fill the shape of the question.
        content: answerSoFar
          ? 'You are out of budget on this request -- no more queries or tools. The answer you had started above was cut off by the output length limit. Finish that same answer from exactly where it stopped, in a few lines, using ONLY the results already gathered. Do not restart it and do not repeat what you already wrote. If a check you had planned never ran, name it as unfinished rather than writing round it.'
          : `You are out of ${hitWallClock ? 'TIME' : 'tool budget'} on this request -- no more queries or tools, and what you write now is what the user gets. Do NOT refuse: a partial answer built from real results is the goal. Write it in two parts, in this order:

1. WHAT THE EVIDENCE SUPPORTS. Only findings the results above actually carry, each one carrying its own scope inside the sentence (which platform or campaign, which dates, which source). A figure whose result was pooled across platforms or campaigns is named as a combined figure or left out.
2. WHAT IS STILL UNCHECKED. Name the specific checks you had not run and what each would have settled. Say it plainly; this is the useful half for deciding whether to act.

Then stop. Do not fill the shape of the question with the piece you did not get to: if the question asked for actions or a recommendation and the evidence only reaches an observation, give the observation and say what would have to be true for it to become a recommendation. An unfinished investigation reported as unfinished is a good answer. An invented conclusion is not, and neither is a confident one caveated in a trailing note.`,
      });
      // Nothing is reserved past this call -- it IS the last thing that has to
      // happen before the audit row is written -- so it may use the whole
      // remaining margin. Bounded all the same: the gateway's 504 writes no
      // audit row at all, where an abort here still reaches the error path and
      // records that the request ran out of time.
      let finalData = await timedCallAnthropic(messages, systemPrompt, tools, {
        forceAnswer: true,
        timeoutMs: finalCallDeadline(),
      });
      collectSources(finalData.content || [], sources);
      // Raw, then trimmed separately -- same seam problem as the main loop.
      let finalRaw = (finalData.content || []).map((b: { text?: string }) => b.text || '').join('');
      if (finalRaw.trim() && finalData.stop_reason === 'max_tokens' && elapsedMs() < FINAL_CONTINUATION_CUTOFF_MS) {
        // Same truncation bug as the main loop, hitting this last-resort
        // forced-answer path instead -- give it exactly one bounded
        // continuation rather than shipping a cut-off answer with no
        // chance to finish (there's no tool-round budget left to retry
        // more than once here).
        messages.push({ role: 'assistant', content: finalData.content || [] });
        messages.push({
          role: 'user',
          content: "That got cut off by the output length limit. Finish it concisely -- lead with the key numbers/decision, don't restate what you already said.",
        });
        finalData = await timedCallAnthropic(messages, systemPrompt, tools, {
          forceAnswer: true,
          timeoutMs: finalCallDeadline(),
        });
        collectSources(finalData.content || [], sources);
        const continuedRaw = (finalData.content || []).map((b: { text?: string }) => b.text || '').join('');
        // APPEND, never replace. Replacing was the same bug as the main
        // loop's: the continuation prompt asks it to finish without restating,
        // so the continuation alone is a fragment with its own opening
        // missing, and that fragment was what got returned AND audited.
        if (continuedRaw.trim()) finalRaw = finalRaw + continuedRaw;
      }
      if (finalRaw.trim()) {
        return await finishWithAnswer((answerSoFar + finalRaw).trim(), {
          toolRounds: roundsUsed,
          partial: hitWallClock
            ? 'the time budget ran out before the investigation finished; this answer covers what had been gathered'
            : 'the investigation limit was reached before all checks finished; this answer covers what had been gathered',
          // Not an error, but flagged so saturation stays visible when
          // auditing. A cluster of round-cap rows means the cap needs
          // raising; a cluster of wall-clock rows means the queries got
          // slower (or the budget is now too tight) -- different fixes, so
          // the two are recorded distinctly.
          errorMessage: hitWallClock
            ? `forced final answer at wall-clock budget (${Math.round(elapsedMs() / 1000)}s, ${roundsUsed} rounds)`
            : 'forced final answer at round cap',
        });
      }
    } catch (err) {
      // A busy provider is not "couldn't land on an answer": the question is
      // fine and asking again shortly will work. Let the outer handler say so.
      if (err instanceof ProviderBusyError || err instanceof ProviderSpendLimitError) throw err;
      console.error('[silo-chat] forced final answer failed', err);
      // A deadline closing on the forced final is a NEW way to reach here, and
      // it must not throw away prose the model had already written. answerSoFar
      // holds a turn that was cut off by the output limit -- real, already-paid-
      // for text. Shipping it beats the generic out-of-time message below;
      // anything else still falls through to that message as before.
      if (err instanceof ModelCallDeadlineError && answerSoFar.trim()) {
        return await finishWithAnswer(answerSoFar.trim(), {
          toolRounds: roundsUsed,
          partial: 'the time budget ran out while this answer was being written; it stops where it stops',
          errorMessage: `forced final answer cut off by its own deadline (${Math.round(elapsedMs() / 1000)}s, ${roundsUsed} rounds)`,
        });
      }
    }

    // Distinguish "the SQL was too heavy to finish" from "the model got
    // stuck" (a genuinely hard/ambiguous question) so the UI can give a
    // useful next step instead of a raw internal error string. Timeouts here
    // are deterministic, not transient -- the audit log showed identical
    // questions failing identically on immediate retry -- so the message
    // must steer the user toward narrowing the question, never toward
    // "wait and retry".
    const message = hitWallClock
      ? "This one ran out of time before it could finish -- it was still working when the request had to be cut off. Ask for it in smaller pieces (one section at a time, or a shorter date range) rather than retrying the same wording."
      : sawTimeout
      ? "This question needed to read more data than it could get through in time, even after a few attempts at it. Narrowing it usually works -- a shorter date range, one product or one product type rather than all of them. Retrying the same wording will hit the same wall; if a narrower version still fails, flag it to an admin."
      : "Couldn't land on an answer after several attempts. Try rephrasing it, or narrowing it to a shorter date range or a single product or product type.";
    await logAudit(callerClient!, {
      requestId,
      question,
      historySnapshot: history,
      answer: null,
      queriesRun,
      toolRounds: roundsUsed,
      status: 'error',
      errorMessage: message,
      diagnostics: buildDiagnostics(queryLog, contextLog()),
    });
    return reply({ error: message, queries_run: queriesRun, retryable: true }, 500);
  } catch (err) {
    console.error('[silo-chat]', err);
    // Never let a failure to summarise the work mask the refusal being reported.
    const soFar = (() => {
      try { return auditSoFar?.() ?? { toolRounds: 0, diagnostics: null }; } catch { return { toolRounds: 0, diagnostics: null }; }
    })();
    if (err instanceof ProviderSpendLimitError) {
      // Not busy and not the question's fault: the AI account's spend cap is
      // reached. Retrying will fail the same way until an admin raises it, so
      // the page is told not to offer Try again.
      const spendMessage = "Ask SILO has reached its AI usage limit, so it can't answer questions right now. This is an account setting, not a problem with your question -- an admin needs to raise the limit (or wait for it to reset). Trying again before then will not work.";
      if (callerClient && question) {
        await logAudit(callerClient, {
          requestId,
          question,
          historySnapshot: history,
          answer: null,
          queriesRun,
          toolRounds: soFar.toolRounds,
          status: 'error',
          errorMessage: `provider_spend_limit: ${err.status}`,
          diagnostics: soFar.diagnostics,
        });
      }
      return reply({ error: spendMessage, retryable: false, provider_spend_limit: true }, 503);
    }
    if (err instanceof ProviderBusyError) {
      // Retried inside the budget and still refused. The person sees a plain
      // "busy, ask again shortly" -- never the raw API body -- and the audit
      // row keeps the status, so a cluster of these is visible in the log and
      // distinguishable from a broken question.
      const waitS = err.retryAfterMs != null ? Math.max(1, Math.ceil(err.retryAfterMs / 1000)) : 60;
      const busyMessage = "Ask SILO is handling a lot of questions right now and the AI service asked it to slow down. Nothing is wrong with your question -- try it again in about a minute.";
      if (callerClient && question) {
        await logAudit(callerClient, {
          requestId,
          question,
          historySnapshot: history,
          answer: null,
          queriesRun,
          toolRounds: soFar.toolRounds,
          status: 'error',
          errorMessage: `provider_busy: ${err.status}`,
          diagnostics: soFar.diagnostics,
        });
      }
      return reply({ error: busyMessage, retryable: true, provider_busy: true, retry_after_s: waitS }, 503);
    }
    const errorMessage = String((err as Error)?.message || err);
    // Only attributable if we got far enough to have a real caller client
    // and a parsed question -- an early auth/validation failure has neither.
    if (callerClient && question) {
      await logAudit(callerClient, {
        requestId,
        question,
        historySnapshot: history,
        answer: null,
        queriesRun,
        toolRounds: 0,
        status: 'error',
        errorMessage,
      });
    }
    return reply({ error: errorMessage, retryable: true }, 500);
  }
});
