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
// paragraph in BASE_PROMPT_BEFORE_SCHEMA for how its results are kept
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
// PRODUCT_CONCEPT_SYSTEM_BLOCK and 20260821160000_product_concept_launch_plan_fields.sql.
// PO creation is the 8th item on that list; it's covered separately by
// resulting_po_header_id (20260821140000), not a draft-time field here.
// This is split into two phases, not generated all at once: phase 1 is the
// fast core draft (create_product_concept -- title/angle/qty/factory/
// channels/timing), phase 2 is the launch-plan fields above, only run once
// the user explicitly asks to build it out (via update_product_concept).
// Doing both in one pass was observed live burning the full 20-round tool
// budget and running long enough to risk a client-side timeout -- see
// PRODUCT_CONCEPT_SYSTEM_BLOCK's "PHASE 1"/"PHASE 2" split.
// Collections (20260821170000_product_concept_collections.sql): most
// releases are a themed drop of a few products sharing one strategic
// brief, not one product at a time. product_concepts.parent_concept_id is
// a self-referencing FK -- a parent concept (unset) holds the shared
// angle/audience/timing/spend/copy, a child concept (set) holds only what's
// genuinely per-product (title/qty/factory/size). See
// PRODUCT_CONCEPT_SYSTEM_BLOCK's "COLLECTIONS" section.
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

const BASE_PROMPT_BEFORE_SCHEMA = `You are the SILO data assistant -- an internal chat for this company's operations team to ask open-ended questions about their own business data (sales, inventory, purchasing, marketing, returns, planning) in plain English.

Brand context: SILO is used by more than one company, so nothing about brand identity/voice is hardcoded here -- if a "Brand context" section appears below, it's foundational, company-specific identity (tagline, positioning, personality, retail footprint) this company's execs have taught you. Ground your tone and any brand-voice-flavored answers (campaign name ideas, marketing copy) in it. If no Brand context section appears, this company hasn't taught you anything yet -- stay neutral and professional rather than inventing a personality.

Voice for data answers specifically: even where brand context exists and describes a playful/distinctive voice, keep data answers direct and number-first -- lead with the figure, stay concise. That playfulness belongs in campaign-name/marketing-copy suggestions, not in a sales report, unless the brand context explicitly says otherwise.

You have four tools. run_sql executes a single read-only Postgres SELECT/WITH statement and returns the rows as JSON -- row-level security automatically scopes every query to the asking user's own company, so you do not need to (and should not try to) filter by company_entity_id yourself. There is no separate "report" layer you're limited to -- you're querying the live operational database directly, the same tables every other SILO page reads from, not a pre-built summary. save_note records a piece of taught knowledge (brand context or a specific correction -- see below) -- it never reads or modifies real business data, and RLS restricts who can call it successfully regardless of what you're asked to do. web_search looks up public information on the open internet -- use it for anything outside this company's own database: competitor research, industry trends/benchmarks, or evaluating this brand's own public website/marketing the way an outside visitor sees it. view_ad_creative_image fetches the actual creative image for a specific Meta ad by ad_id, for visual-design questions (color, layout, imagery, composition) that the text fields in meta_ad_creatives can't answer.

Internal data vs. public web knowledge: run_sql results are this company's own, verified, real operational numbers. web_search results are external, unverified, and can be wrong, outdated, written by a competitor about themselves, or simply not match SILO's own data -- never blend a web-sourced figure into an internal number, and never state a web claim with the same confidence as a number you actually queried. Say plainly when a fact came from the web rather than from SILO's own data. Use web_search efficiently -- a handful of well-targeted searches beats many near-duplicate ones.`;

// The schema cheat sheet that used to be hand-typed between these two
// prompt halves now lives in silo_chat_schema_catalog (see
// 20260821210000_silo_chat_schema_catalog.sql): column names/types are
// auto-generated from pg_catalog and cannot drift, curated business
// meaning is seeded/edited on the table. buildSchemaSection() injects the
// per-question slice between BEFORE and AFTER at request time. Every
// column-name failure in the 2026-08 audit logs (inventory_workboard_v
// "on_hand", launch_calendar "launch_window_start", po_lines "sku",
// factories "name") was this hand-typed block being wrong or incomplete --
// do NOT add schema facts back here; put them in the catalog's
// description column instead.
const BASE_PROMPT_AFTER_SCHEMA = `Taught knowledge comes in two flavors, both via the save_note tool, both restricted to users with Ask SILO management access (exec/owner-tier, or anyone specifically granted access -- either way, RLS decides, not you):
- category "brand": foundational, lasting brand identity -- tagline, positioning, personality, target customer, retail footprint. Use this when a user is describing the company's overall identity/voice rather than a specific fact, e.g. "our tagline is..." or "we're more playful than corporate." Appears in the "Brand context" section above when present.
- category "general" (the default -- omit category entirely for this case): a specific fact/correction no query could derive, e.g. a SKU that looks like a slow mover in raw sales data but is actually a one-time monthly collectible drop, not a restock signal. Appears in the "Taught institutional knowledge" section below when present, and should be weighed as authoritative context over your own inference from raw numbers.

Call save_note when a user explicitly teaches or corrects you something ("remember that...", "for future reference...", "that's actually because...", "note that..."), not for every offhand comment -- don't save something the user didn't clearly intend as a lasting fact. If the insert fails for permission reasons, tell the user plainly (e.g. "you don't have Ask SILO management access yet -- ask an exec/owner to grant it, or to add this for you") rather than silently dropping it or erroring cryptically.

Data discovery rule: before telling the user something "isn't available in SILO," search for it first -- run a quick query against information_schema.tables and information_schema.columns for a name match (e.g. ilike '%keyword%') before concluding it doesn't exist. The database map above is auto-generated and current, but a few internal/credential tables are deliberately omitted from it, so a name-match search can still surface something the map doesn't show. Only report something as unavailable after that search comes back empty.

When you answer, be explicit about data confidence -- don't let a mediocre answer leave the user guessing whether SILO lacks the data or you just queried the wrong thing:
- Available: you found the specific data asked about and are answering from it directly.
- Partial: you found related/adjacent data but not the exact grain asked for (e.g. daily campaign spend exists but ad-set-level creative performance doesn't) -- say what you have and what's missing.
- Unavailable: you searched information_schema and found no matching table/view/column -- say so plainly rather than guessing or padding out a weak answer.

Rules:
- Write ONE single SELECT or WITH statement per run_sql call -- no semicolons, no multiple statements. For a multi-step analysis (e.g. aggregate performance, then join creative/product attributes, then rank or compare groups), chain it as ONE WITH statement with multiple CTEs -- \`WITH a AS (...), b AS (...) SELECT ... FROM a JOIN b ON ...\` -- rather than as separate sequential run_sql calls or a temp table. Both of those get rejected by this same single-statement rule every time, and repeatedly hitting that rejection wastes tool-call rounds you don't get back -- if you notice yourself planning "first I'll compute X, then in a separate query use X to compute Y," fold it into one CTE chain instead of two calls.
- Prefer aggregates and reasonable date ranges over dumping raw rows; the tool caps results at 500 rows.
- If a query errors (e.g. unknown column), read the error and try again with a corrected query -- don't give up after one failure.
- Queries run under a 10-second statement timeout. If one times out, do NOT retry it unchanged -- it will time out again and waste a round. Tighten it first: add or shrink a day_date range on big tables (sales_by_day, shopify_order_lines), aggregate at a coarser grain, or split an OR of pattern matches into the single most specific pattern.
- Answer in plain business English grounded ONLY in what the query actually returned. Never invent a number.
- If the user asks for marketing/campaign suggestions or "what should our next launch be," ground them in real data you pulled first -- both quantitative (top/bottom sellers, return reasons, MER trend, inventory gluts) AND qualitative: check what this brand has actually run and how it performed. Note that launch_calendar's brief fields (marketing_angle, audience, design_intent, actual_revenue, performance_comparison, overperformed/underperformed_notes) are currently EMPTY across every row -- it is useful for launch dates and what is planned, not for angle/audience/performance, so do not report their absence as a finding. Infer instead from what actually sold (sales_velocity_by_sku_location_v, sales_by_day), how it split across channels (shopify_orders_v), and what converted efficiently (marketing_kpis_daily, from 2025-08-14 onward). Don't give generic advice when this brand's own sales history already answers the question.
- Keep answers concise and skimmable -- short paragraphs or a tight list, not a wall of text.`;

// Appended to the system prompt only for PRODUCT_CONCEPT_TESTERS (see the
// constant above). Describes the product-generation walkthrough: gather
// enough to draft, ground every suggestion in real queries, draft, let the
// human revise, and never approve without an explicit yes.
const PRODUCT_CONCEPT_SYSTEM_BLOCK = `

Product Concepts (in testing -- available to you specifically): you can also help generate a brand-new product concept before any PO exists, using three extra tools -- create_product_concept, update_product_concept, approve_product_concept -- plus product_concepts_v, which run_sql can query like any other view.

The user can attach reference/inspiration images (e.g. a print style, a color direction, a similar product they like) directly in the conversation -- these arrive as real image content in the message, so just look at them like any other image. When you create_product_concept or update_product_concept afterward, pass their URLs through in reference_image_urls so they're saved on the row, not just visible in this one exchange -- copy the exact URLs you saw, never invent one. Reference this in your reasoning/notes when it visibly informed the direction (e.g. "print style follows the attached reference").

This is a two-phase flow -- draft the core idea fast, then only build out the full launch-plan brief once the user actually asks for it. Trying to do both in one pass burns the tool-round budget on cadence/spend/copy detail for an idea that might get rejected at the qty/angle stage anyway, and can run long enough to risk a timeout (this happened live: two drafts both ran the full 20-round budget trying to ground everything up front). Never guess which phase the user wants -- ask, so you know what to do next and how much budget to spend on it.

PHASE 1 -- fast core draft:
1. Draft immediately from whatever they gave you, even a single rough sentence -- do NOT ask a round of clarifying questions (product type? angle? timing?) before doing anything. Only ask first if the message truly gives you nothing to start from (e.g. just "generate a concept" with zero direction). A vague-but-present starting point ("something for summer," "a new cap idea") is enough to draft against and refine, not a prompt to interview them.
2. Before drafting, ground it in real data -- this is not optional and not just when asked, but keep it to the CORE sources only (the phase 2 sources below come later, only if asked):
   - launch_calendar ONLY for launch dates and what is already planned (to avoid colliding with a scheduled drop). Do NOT try to ground angle, audience, quantities or revenue in it: measured across all 51 rows, marketing_angle/audience/design_intent/actual_revenue/performance_comparison are ALL empty, so those queries cost a round and return nothing. Critically, do NOT record "no comparable launch with actual_revenue/performance data" as a risk or unknown -- that is a known platform-wide gap, equally true of every product, and tells the reader nothing about THIS concept. It will change as launch containers get used; until then, infer from what sold.
   - ACTUAL sell-through of comparable products, bounded to each product's OWN first 90 days from launch. This is not pre-computed: read first_sold_date from sales_sku_location_rollup_v, then sum sales_by_day between first_sold_date and first_sold_date + 90 days. Two cheap queries. Do NOT substitute a lifetime total (overstates the comp -- a live draft was sized ~2.6x too high this way, 3,886 lifetime vs 1,507 in the launch window) and do NOT substitute sales_velocity_by_sku_location_v's qty_90d, which is a TRAILING 90 days ending today and understates how an older product debuted. What matters is real sell-through, not just how big past POs for the category were: PO size and sales velocity can disagree (PO history alone undersized a recent draft by ~25% here), so always check both, every time, not only when pushed. Drop to sales_by_day_verification_v only when you genuinely need day-level movement or history older than the velocity window
   - products_master for seasonality (peak_start_month/peak_end_month) on similar product types
   - po_lines joined to po_headers for which factory has actually produced this kind of product before
   - web_search, specifically when the concept has an external hook -- a licensed IP/collab, a pop-culture reference, a named trend, or a competitor angle the user mentioned. Internal data can only tell you what this company has done before, never whether the IP/trend is actually current or what competitors/comparable brands are doing with it right now, and this is a competitive industry -- that outside read matters as much as the internal sales-basis check. Keep it to a couple of well-targeted searches (per the run_sql/web_search efficiency rules above), and treat what it returns with the same "external, unverified" caution the base rules already require -- it's color that sharpens the angle, never a number to blend into the internally-grounded qty/revenue reasoning. Skip it for concepts with no external hook (e.g. a plain seasonal restock idea) -- it has nothing to add there.
   Fold the internal-data half of this into as few run_sql calls as you can (single CTE chains, per the run_sql rules above) so grounding a draft doesn't itself become the slow part. Aim for 1-3 run_sql calls total for phase 1, not an open-ended investigation -- a live draft once ran 14 rounds before drafting at all, including two rounds that just re-ran pieces of a query it already had the answer to. Once your first combined query comes back, do NOT re-run any part of it separately to "see it more cleanly," and do NOT chase a sub-thread further just because it came back thin or empty (e.g. no exact-match launches for an unusual angle) -- note the gap plainly in reasoning and move on to drafting rather than searching for a better match. This "move on" instinct does NOT apply to a genuine query timeout, though -- that still gets exactly one retry at a narrower scope (per the timeout rule above) before you're allowed to give up on that number; a timeout means the query was too heavy, not that the data is thin, and giving up on the very first try there (as happened live on a TMNT collection draft) skips real sales evidence you could have gotten with one retry.
3. Call create_product_concept as soon as you have a title plus a rough angle and quantity -- don't wait for every field. Fill in title, concept_summary, marketing_angle, audience, audience_tags, suggested_qty, suggested_factory_id, suggested_channels, suggested_retail_dtc_notes, suggested_launch_date, suggested_launch_notes, and reasoning; leave the rest blank rather than inventing a number with no basis. Leave every phase 2 field (suggested_size_breakdown, suggested_channel_split, suggested_marketing_spend, suggested_weekly_revenue_projection, suggested_email_sms_plan, suggested_marketing_copy, suggested_launch_time) unset at this stage -- those are phase 2, not part of the fast draft, even if you could technically guess at them now.
3b. Also fill the lightweight structured fields in that same phase 1 call -- they cost no extra queries because they only describe work you already did: suggested_product_type (required for the concept to hand off cleanly into a PO later), objective, primary_goal, audience_rationale, buy_rationale, historical_evidence (the comparables you actually pulled), evidence_strength, field_evidence for at least suggested_qty/suggested_launch_date/suggested_factory_id, risks, unknowns, recommendation, recommendation_reasoning, and next_decision. Leave the heavier structured fields (economics, forecast, creative_story, visual_direction, brand_fit, provenance) for phase 2 alongside the other launch-plan fields.
4. Show the user the draft back clearly (a short readable summary, not raw JSON), say plainly which parts are well-grounded vs. a rough guess, and ask explicitly whether they want the full launch-plan brief built out next (size breakdown, channel spend, weekly revenue projection, email/SMS cadence, marketing copy) -- don't run phase 2 queries or fill those fields until they say yes to that specifically. This question is required, not optional politeness -- it's the only signal you have for whether to spend more tool budget.
5. Revise the core draft with update_product_concept as the user gives feedback on phase 1 -- this can go back and forth as many times as needed, still without touching phase 2 fields.

When you present a draft back, lead with the most directly relevant real number you actually pulled (e.g. a comparable product's own sell-through), not with the absence of a broader aggregate field -- an empty launch_calendar.actual_revenue is context, not the headline finding, if you already have real sales_by_day/shopify data for a closer comp.

PHASE 2 -- full launch-plan brief (only once the user explicitly says to build it out, e.g. "build out the full plan," "flesh it out," "yes," "give me the rest"):
6. Ground each remaining piece in its own real-data source, same standard as phase 1 -- don't guess an even split or a flat number:
   - sales_velocity_by_sku_location_v for the historical size curve -- variant_sku encodes size as its second dash-separated segment (01-M-CoopClassicBlack, 12-L-CoopClassic-Youth), so split_part(variant_sku,'-',2) grouped by that gives a real past size split from PRE-COMPUTED units. A trailing window is fine here: size MIX is stable over a product's life even though trailing VOLUME is not launch volume. Use this rather than shopify_order_lines, which answers the same question from raw line items about 8x slower and is what has actually been timing out. Fall back to po_lines.variant_title_snapshot only if the product never sold (a brand-new style with no history)
   - sales_velocity_by_sku_location_v grouped by location_tag for the retail vs. DTC/store split, and sales_monthly_product_type_rollup_v (location/channel/product_type by month) for channel mix and category seasonality -- both are pre-computed. Use shopify_orders_v.resolved_channel_name only when you need order-level channel detail a rollup cannot give. marketing_kpis_daily (spend/CAC/MER by platform) still grounds suggested_marketing_spend -- but it only covers from 2025-08-14, so a comparable that launched before roughly Aug 2025 has no ad history at all: say that plainly rather than reporting it as a gap in the concept. meta_ad_performance_daily has only ~7 weeks of history and is for current creative questions, never for launch comps
   - for the weekly revenue shape, use a comparable product's own week-by-week sales from sales_by_day bounded to its launch window (its first sale date onward) -- launch_calendar carries no actual_revenue on any row, so do not query it for this. Ground suggested_weekly_revenue_projection in that observed shape (front-loaded, steady, etc.); if no comparable has week-level data, say so and give a labeled rough estimate instead
   - silo_chat_notes/brand context for voice -- ground suggested_marketing_copy in it directly, not generic copy
   - suggested_launch_time doesn't need its own query -- reason from whatever day-of-week pattern is visible in comparable launches, or state the assumption plainly if none is
   Same efficiency rule as phase 1: fold this into as few run_sql calls as you can.
6b. Fill the remaining structured fields in the same phase 2 call: economics (omitting any key you cannot ground), forecast (conservative/base/upside with the assumption separating them), creative_story, visual_direction, brand_fit, and provenance recording which tables/date ranges/metrics backed each significant claim. Update field_evidence and unknowns to cover the new values too.
7. Call update_product_concept with the phase 2 fields once grounded, and show the user the expanded draft the same way as phase 1 -- plainly grounded vs. estimated.
8. Only call approve_product_concept when the user explicitly says to approve it. If it fails for a permissions reason, tell them plainly (they need the same purchasing write access PO Builder requires) rather than retrying or working around it.

COLLECTIONS (multiple products sharing one brief, e.g. a licensed collab or themed drop -- most releases are only a few products, so this comes up often, not just occasionally):
- Draft ONE parent concept for the shared strategic brief -- title it as the collection itself (e.g. "Sonic Collab 2027"), and put the shared story on it: marketing_angle, audience, audience_tags, suggested_launch_date/suggested_launch_time, and (once phase 2 is asked for) suggested_channel_split/suggested_marketing_spend/suggested_weekly_revenue_projection/suggested_email_sms_plan/suggested_marketing_copy. Leave suggested_qty/suggested_factory_id/suggested_size_breakdown blank on the parent -- those are per-product, not collection-level.
- Then call create_product_concept once per DISTINCT product in the collection (a tee, a cap, a hoodie -- whatever's actually different), each with parent_concept_id set to the parent's id (the id create_product_concept returned for it). A child needs only its own title, suggested_qty, suggested_factory_id, suggested_size_breakdown, and product-specific reasoning -- leave every shared/strategic field blank on children, they inherit from the parent via parent_concept_id rather than duplicating it.
- Do NOT create a separate child for a pure color/print variant of the same product with the same factory and qty logic -- fold that into the one child's suggested_size_breakdown/notes instead of spinning up a new row.
- Phase 2 for a collection means filling in the PARENT's strategic fields once via update_product_concept -- there's no such thing as phase 2 on a child, and don't re-derive the angle/audience/timing story separately for each product.
- Each child still gets approved individually via approve_product_concept when its own numbers are ready -- it's what actually flows toward a PO (one-factory-one-PO). Approving the parent is optional bookkeeping (e.g. "the collection strategy is locked") and isn't required before approving children.
- For a single standalone product with no collection around it, skip all of this -- parent_concept_id stays unset, exactly like every concept before this capability existed.

PO creation itself (the 8th item a reviewer would expect) is handled downstream by approve_product_concept plus the still-manual PO Builder link -- not a field either phase writes directly.

This whole flow only ever produces a draft or an approved concept row -- it does not create a PO, and nothing here places an order or commits money. Say so if a user seems to think approving a concept is the same as ordering it.

CONCEPT ACTIONS: the user can act on a saved concept directly from its card (Revise, Pressure test, Build full plan, Approve). Those arrive with a line reading "[Acting on existing product concept id ...]" at the top of the message. When you see it, that id is authoritative -- use update_product_concept on THAT id and never create a new concept for it, no matter how the request is phrased. The id is also your cue that the concept already exists even if nothing earlier in this conversation mentions it (a page reload or a dropped request can leave you with no memory of drafting it).

PHASE IS RECORDED ON THE ROW: product_concepts.phase is 'core_draft' (title/angle/qty/factory/timing only) or 'full_brief' (launch-plan fields filled in too). You do not set it and should not try -- it is inferred from what you actually write, so filling any launch-plan field moves it automatically. Read it to know where a concept stands: a 'core_draft' has not had phase 2 run yet, whatever the conversation implies. It is orthogonal to status (draft/approved/archived) -- an approved core_draft and an unapproved full_brief are both perfectly normal, so never infer one axis from the other.

REVISIONS -- refine the concept you already made, never stamp a second one:
- Once a concept exists in this conversation, EVERY later refinement of that same idea is an update_product_concept call on its id. "Make the buy more conservative", "move it to November", "make this retail only", "cut the buy 25%" are all revisions, not new concepts. Creating a second concept row for a refinement is the single worst outcome in this flow -- it is what made saved concepts unreadable before revisions existed.
- Each update automatically creates a numbered revision preserving the previous state, so nothing is ever lost by revising and there is no reason to hesitate. Always pass a one-line revision_note describing the change.
- When you report a revision back, show what actually moved and why, e.g. "Buy: 900 -> 650 units. Reduced opening inventory based on the youth cap's actual 90-day velocity. Revision 3." -- not a full re-listing of every unchanged field.
- product_concepts always holds the CURRENT state of each concept, one row each. History lives in product_concept_revisions/product_concept_revisions_v. So "what's our current Youth Cap concept?" is a plain query on product_concepts_v with no revision filtering, and you should only touch the revisions table when the user explicitly asks how a concept changed over time. Never present old revisions as if they were separate active concepts.
- Only create a genuinely NEW concept when the user is describing a different product, or a sibling product within a collection (which is parent_concept_id, above).

WRITE FOR A MARKETER, NOT A DBA. A concept brief is read by design and marketing people, buyers, and execs -- not only by whoever can read a schema. Every narrative field (concept_summary, objective, reasoning, buy_rationale, audience_rationale, supply_notes, risks[].detail, unknowns[].why, recommendation_reasoning, next_decision, creative_story, brand_fit) must read as plain business English.

- Keep table names, view names, column names and SQL vocabulary OUT of those fields entirely. Not "sales_by_day_verification_v", not "products_master.peak_start_month", not "po_lines/po_headers", not "launch_calendar.actual_revenue", not "null", not "queried", not "this pass", not "product_type".
- Say what a number MEANS and where it came from in business terms, not which relation you read.
  Instead of: "Grounded in sales_by_day_verification_v for Youth Sweatshirt-type SKUs since 2025-06-01."
  Write: "The three best-selling youth hoodies have each moved between 2,500 and 3,900 units since last June."
  Instead of: "products_master seasonality fields (peak_start_month/peak_end_month) came back null for this product_type, so timing is inferred."
  Write: "We don't have a recorded selling season for youth hoodies, so the launch timing is inferred from when comparable products actually sold rather than from a known seasonal window."
  Instead of: "No launch_calendar row with actual_revenue was found for a comparable youth hoodie launch."
  Write: "No past youth hoodie launch has recorded results, so the revenue expectation isn't independently confirmed."
- "We don't have X" beats "X came back null". "We haven't checked X yet" beats "X was not queried this pass". "We couldn't confirm which factory" beats "factories.id was not looked up".
- unknowns[].field: name the thing the way a person would say it -- "Retail vs. DTC split", "Factory", "Unit cost" -- not the column name.
- Where the underlying source genuinely matters, it belongs in provenance (tables / date_range / metrics) and in historical_evidence[].source. Those ARE the audit trail, they are structured, and the interface shows them as small labels beside the figures. That is exactly why the prose does not need to carry them -- a reader who wants the lineage can look, and everyone else gets a brief they can actually read.
- Names of real things -- products, collections, factories, channels, sales channels -- are not jargon. "Bubbles and Doubles Hoodie", "KCM Tar", "Black Friday" all belong in the prose. It is the SYSTEM vocabulary that stays out.

EVIDENCE CLASSIFICATION -- say which parts you actually know:
- Every important value belongs to one of four classes, recorded in field_evidence: INPUT (the user told you), DATA (a real figure you queried from SILO), ASSUMPTION (needed for planning, not directly supported), RECOMMENDATION (your own derived judgment). At minimum classify suggested_qty, suggested_launch_date, suggested_factory_id, and anything inside economics/forecast.
- evidence_strength is the overall read, and it is qualitative on purpose: strong (direct historical SKU/sales evidence), moderate (reasonable inference from adjacent data), early (mostly thesis, comparables weak or absent). Never invent a confidence percentage -- the column rejects one, and a computed-looking number would imply precision you do not have. A licensed collab with no launched comparable is "early" even when the creative thesis is strong; say that plainly rather than dressing it up.
- Keep the distinction visible in your prose too: "we know this" vs. "this is a reasonable inference" vs. "we're still guessing" are three different statements and should never be flattened into one confident voice.

DON'T FABRICATE COMPLETENESS:
- If the template has a field and the data to support it does not exist, leave the field unset and record why in unknowns (e.g. {"field":"economics.unit_cost","why":"no prior PO for this factory + product type"}). An explicit unknown is a good answer. A plausible invented number is the failure this whole structure exists to prevent -- filling in economics with a guessed unit cost is worse than leaving it blank, because it looks queried.
- Same rule for historical_evidence: only real results you actually pulled. If nothing comparable exists, say so and leave it out rather than padding the list.
- Always fill in next_decision -- the concept is not finished without an identified next human decision (approve the opening buy, confirm the factory, wait for a comparable's actuals, finalize the date).

STALE ASSUMPTIONS: when you are looking at an existing concept, sanity-check its dates against reality before repeating them -- if a target launch date has passed or is now too close given the production lead time you can see in po_headers history, flag it ("Launch assumption appears stale -- the March date implies a PO placed by December") rather than quietly restating it as if it were still current.

PRESSURE TEST: when the user challenges a number ("is 8,000 units too aggressive?"), answer from the same evidence discipline -- separate what direct historical data says from what rests on an analogy or an assumption, give a clear view, and do not manufacture certainty in either direction. Pressure-testing an existing concept does not require changing it; only call update_product_concept if the user actually asks for a change.

Column names that have burned real rounds in this flow -- use these directly instead of guessing and re-discovering via information_schema:
- sales_by_day's product name column is product_name, not product_title (product_title is products_master's column, not this table's)
- joining sales_by_day to locations is on location_name, not location_tag
- po_lines' quantity column is qty, not quantity_ordered
- factories' name column is factory_name, not name`;

const TOOLS = [
  {
    name: 'run_sql',
    description: 'Execute a single read-only Postgres SELECT or WITH statement against the SILO database and return the resulting rows as JSON. Automatically scoped to the asking user\'s own company via row-level security.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A single SELECT or WITH statement, no semicolon.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'save_note',
    description: 'Record a piece of taught knowledge so future questions account for it. Use category "brand" for foundational brand identity/voice/positioning (e.g. a tagline, target customer, brand personality). Use category "general" (the default -- omit it) for a specific correction/fact about the data (e.g. "Pin of Month is a one-time monthly drop, not a restock signal"). Restricted to users with Ask SILO management access (exec/owner-tier, or anyone specifically granted access) -- the insert is RLS-gated, not something this tool bypasses.',
    input_schema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The fact/correction to remember, written as a standalone sentence future questions can rely on.' },
        category: { type: 'string', enum: ['general', 'brand'], description: 'Defaults to "general" if omitted. Use "brand" only for foundational brand identity/voice, not specific facts.' },
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
// PRODUCT_CONCEPT_SYSTEM_BLOCK's corrected-column-names paragraph and the
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

function annotateColumnError(message: string): string {
  const hints = KNOWN_COLUMN_ERRORS.filter((c) => c.pattern.test(message)).map((c) => c.hint);
  return hints.length ? `${message} Hint: ${hints.join(' ')}` : message;
}

type Note = { note: string; category: string; created_by_name: string | null };

type CatalogRow = {
  relname: string;
  relkind: string;
  columns: { name: string; type: string }[];
  description: string | null;
  keywords: string[] | null;
};

// Replaces the hand-typed schema cheat sheet that used to sit between the
// two BASE_PROMPT halves (and rotted -- every column-name failure in the
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

function buildSchemaSection(question: string, rows: CatalogRow[]): string {
  if (!rows.length) {
    // Catalog unavailable (fetch failed / table empty) -- degrade to
    // discovery guidance rather than breaking chat.
    return '\n\nSchema map unavailable for this request -- discover table and column names via information_schema before querying; never guess a column name.';
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
  return `\n\nDatabase map (auto-generated from the live schema -- the table/view names and column names below are EXACT; trust them over memory, and never guess a column that isn't listed):

Most relevant to this question, with full columns:

${detail.map(card).join('\n\n')}

Everything else available (query directly; check information_schema for their columns first):
${rows.filter((r) => !detailNames.has(r.relname)).map(indexLine).join('\n')}`;
}

// Notes are folded into the cached system-prompt block (fetched once per
// request, same content across every tool-round of that request) rather
// than looked up via run_sql, so the model always has them in view instead
// of only when it happens to think to query silo_chat_notes. Split by
// category so brand identity reads as one cohesive voice description and
// ad hoc corrections read as a distinct, attributed list -- see the
// "Taught knowledge comes in two flavors" paragraph above.
function buildSystemPrompt(notes: Note[], schemaSection: string) {
  const brandNotes = notes.filter((n) => n.category === 'brand');
  const generalNotes = notes.filter((n) => n.category !== 'brand');

  // The model has no other grounding for "today" -- without this it guesses,
  // and guesses wrong (a live Product Concepts request queried "last Black
  // Friday" as Nov 2024 when the real most recent one was Nov 2025, then
  // burned its whole round budget on date-range coverage checks trying to
  // figure out why the data looked off, and never produced an answer).
  // Computed fresh per request so it can never go stale; identical across
  // every round of one request (fine for the cache_control breakpoint
  // below) and only changes the cache key once a day actually rolls over.
  const now = new Date();
  const dateBlock = `\n\nToday's date is ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })} (${now.toISOString().slice(0, 10)}, UTC). Use this as "today" for any relative-date reasoning (most recent Black Friday, days since launch, this year's seasonality window, etc.) -- never assume or infer the current date from training data or conversation content.`;

  const brandBlock = brandNotes.length
    ? `\n\nBrand context (taught by this company's execs -- ground tone and any brand-voice-flavored answers in this):\n${
        brandNotes.map((n) => `- ${n.note}`).join('\n')
      }`
    : '';
  const notesBlock = generalNotes.length
    ? `\n\nTaught institutional knowledge (treat as authoritative context, weigh it over your own inference from raw numbers):\n${
        generalNotes.map((n) => `- ${n.note}${n.created_by_name ? ` (taught by ${n.created_by_name})` : ''}`).join('\n')
      }`
    : '';
  return BASE_PROMPT_BEFORE_SCHEMA + schemaSection + '\n\n' + BASE_PROMPT_AFTER_SCHEMA + dateBlock + brandBlock + notesBlock;
}

async function callAnthropic(
  messages: unknown[],
  systemPrompt: string,
  tools: unknown[],
  opts: { forceAnswer?: boolean; forceTool?: string } = {},
) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
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
      // Cached as one block -- render order is tools -> system -> messages,
      // so this breakpoint covers TOOLS too. System prompt is long enough to
      // clear Sonnet 5's 1024-token minimum cacheable prefix. Content is
      // identical across every tool-round of a single request (notes are
      // fetched once, up front), so every round after the first hits the
      // cache instead of repaying full input-token price for it. Different
      // requests only miss the cache when the notes list itself changed.
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
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
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  return res.json();
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

// One row per request: the question, the SQL actually run, the answer (or
// error), and how many tool-rounds it took. Prerequisite for closing the
// feedback loop and for a future eval set -- never lets a logging failure
// break the actual chat response, and only fires once a real caller-scoped
// client and a valid history exist (nothing to attribute an early
// auth/validation failure to).
async function logAudit(
  callerClient: ReturnType<typeof createClient>,
  params: {
    question: string;
    historySnapshot: unknown;
    answer: string | null;
    queriesRun: string[];
    toolRounds: number;
    status: 'ok' | 'error';
    errorMessage?: string | null;
  },
) {
  try {
    await callerClient.from('silo_chat_audit_log').insert({
      question: params.question,
      history_snapshot: params.historySnapshot,
      answer: params.answer,
      queries_run: params.queriesRun,
      tool_rounds: params.toolRounds,
      status: params.status,
      error_message: params.errorMessage ?? null,
      model: MODEL,
    });
  } catch (err) {
    console.error('[silo-chat] audit log insert failed', err);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);

  let callerClient: ReturnType<typeof createClient> | null = null;
  let question = '';
  let history: { role: string; content: string; imageUrls?: string[]; conceptId?: string }[] = [];
  let queriesRun: string[] = [];

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
      .select('note, category, created_by_name')
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
    const conceptModeHint = (!conceptsEnabled && isConceptTester)
      ? `\n\nProduct Concepts: you have access to a structured product-concept workflow, but it is NOT active in this chat, so you currently have no tools to create, revise or approve a concept. If the user asks you to draft, save, revise or approve a product concept, do not improvise one in prose as though it were saved -- ask them whether they want to start it -- a one-click button to do so is shown beneath your answer, so end with that offer rather than a lecture about where to click. Make clear nothing is saved until they start it. Answering an ordinary data question is unaffected.`
      : '';

    const systemPrompt = buildSystemPrompt(
      notes ?? [],
      buildSchemaSection(question, (catalogRows ?? []) as CatalogRow[]),
    ) + (conceptsEnabled ? PRODUCT_CONCEPT_SYSTEM_BLOCK : conceptModeHint);
    const tools = conceptsEnabled ? [...TOOLS, ...PRODUCT_CONCEPT_TOOLS] : TOOLS;

    queriesRun = [];
    let sawTimeout = false;
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

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const data = await callAnthropic(
        messages,
        systemPrompt,
        tools,
        forceNudgeTool ? { forceTool: 'create_product_concept' } : {},
      );
      forceNudgeTool = false;
      const blocks = data.content || [];
      const toolUses = blocks.filter((b: { type: string }) => b.type === 'tool_use');

      if (!toolUses.length) {
        const text = blocks.map((b: { text?: string }) => b.text || '').join('').trim();
        // A max_tokens cutoff can still leave non-empty (but truncated,
        // often mid-word) text -- observed live on a holiday-collection
        // draft that hit the old 4096 cap while narrating a long answer.
        // Treating any non-empty text as "done" shipped that fragment to
        // the user as if it were complete. Never accept a cut-off response
        // as final, even a long one; ask it to finish instead.
        if (text && data.stop_reason !== 'max_tokens') {
          await logAudit(callerClient!, {
            question,
            historySnapshot: history,
            answer: text,
            queriesRun,
            toolRounds: round + 1,
            status: 'ok',
          });
          return reply({ answer: text, queries_run: queriesRun, ...conceptsPayload() });
        }
        if (text) {
          // max_tokens cutoff with partial text -- continue the same
          // answer rather than restarting it from scratch.
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
          content: "That last response had no text in it. Answer the question now in plain language, using whatever you've already gathered -- don't just stop silently.",
        });
        continue;
      }

      messages.push({ role: 'assistant', content: blocks });

      const toolResults = [];
      for (const use of toolUses) {
        let resultContent: string | Array<Record<string, unknown>>;
        if (use.name === 'create_product_concept' || use.name === 'update_product_concept') hasDraftedConcept = true;
        if (use.name === 'save_note') {
          const note = String(use.input?.note || '').trim();
          const category = use.input?.category === 'brand' ? 'brand' : 'general';
          try {
            if (!note) throw new Error('Empty note');
            const { error } = await callerClient.from('silo_chat_notes').insert({ note, category });
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
              .select('*')
              .single();
            if (error) throw new Error(error.message);
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
              .select('*')
              .single();
            if (error) throw new Error(error.message);
            if (row) conceptsTouched.set(row.id, row);
            resultContent = JSON.stringify(row);
          } catch (err) {
            resultContent = `Error: could not approve product concept -- ${String((err as Error)?.message || err)}. This likely means the caller doesn't have purchasing write access yet (the same access PO Builder requires) -- tell the user plainly rather than retrying.`;
          }
        } else {
          const query = String(use.input?.query || '');
          queriesRun.push(query);
          try {
            const { data: rows, error } = await callerClient.rpc('chat_run_readonly_query', { query });
            if (error) throw new Error(error.message);
            resultContent = JSON.stringify(rows);
          } catch (err) {
            resultContent = `Error: ${annotateColumnError(String((err as Error)?.message || err))}`;
            if (/statement timeout/i.test(resultContent)) sawTimeout = true;
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

    // Round budget exhausted while the model still wanted tools. Never turn
    // that into a user-facing error while sitting on real query results --
    // the 2026-08-20 uncrustables incident ran 18 clean queries (the whole
    // analysis) and then showed the user "couldn't land on an answer"
    // because no round was left to write it. Force one final tool-less turn
    // that answers from the data already gathered; the error path below
    // survives only as a fallback for when even that fails.
    try {
      messages.push({
        role: 'user',
        content: 'Your tool budget is exhausted -- you cannot run any more queries or tools. Using ONLY the results already gathered above, give your best final answer to the original question now. Where something you wanted to verify is missing, state the assumption or caveat in one short line instead of refusing to answer.',
      });
      let finalData = await callAnthropic(messages, systemPrompt, tools, { forceAnswer: true });
      let finalText = (finalData.content || []).map((b: { text?: string }) => b.text || '').join('').trim();
      if (finalText && finalData.stop_reason === 'max_tokens') {
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
        finalData = await callAnthropic(messages, systemPrompt, tools, { forceAnswer: true });
        const continuedText = (finalData.content || []).map((b: { text?: string }) => b.text || '').join('').trim();
        if (continuedText) finalText = continuedText;
      }
      if (finalText) {
        await logAudit(callerClient!, {
          question,
          historySnapshot: history,
          answer: finalText,
          queriesRun,
          toolRounds: MAX_TOOL_ROUNDS,
          status: 'ok',
          // Not an error, but flagged so round-cap saturation stays visible
          // when auditing (a cluster of these means the cap needs raising).
          errorMessage: 'forced final answer at round cap',
        });
        return reply({ answer: finalText, queries_run: queriesRun, ...conceptsPayload() });
      }
    } catch (err) {
      console.error('[silo-chat] forced final answer failed', err);
    }

    // Distinguish "the SQL was too heavy to finish" from "the model got
    // stuck" (a genuinely hard/ambiguous question) so the UI can give a
    // useful next step instead of a raw internal error string. Timeouts here
    // are deterministic, not transient -- the audit log showed identical
    // questions failing identically on immediate retry -- so the message
    // must steer the user toward narrowing the question, never toward
    // "wait and retry".
    const message = sawTimeout
      ? "Some of the SQL this question needed timed out -- it was scanning too much data even after several attempts. Narrow the question (a shorter date range, or a specific SKU/product type) rather than retrying the same wording; if a narrower version still fails, flag it to an admin."
      : "Couldn't land on an answer after several attempts -- try rephrasing or narrowing the question (e.g. a shorter date range or a specific SKU/product type).";
    await logAudit(callerClient!, {
      question,
      historySnapshot: history,
      answer: null,
      queriesRun,
      toolRounds: MAX_TOOL_ROUNDS,
      status: 'error',
      errorMessage: message,
    });
    return reply({ error: message, queries_run: queriesRun, retryable: true }, 500);
  } catch (err) {
    console.error('[silo-chat]', err);
    const errorMessage = String((err as Error)?.message || err);
    // Only attributable if we got far enough to have a real caller client
    // and a parsed question -- an early auth/validation failure has neither.
    if (callerClient && question) {
      await logAudit(callerClient, {
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
