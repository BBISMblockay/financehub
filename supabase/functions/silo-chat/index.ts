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
// paragraph in BASE_SYSTEM_PROMPT for how its results are kept clearly
// separate from real SILO numbers. See CLAUDE.md's "Key tables" section
// for the schema summary baked into BASE_SYSTEM_PROMPT below -- keep them
// in sync.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { encodeBase64 } from 'jsr:@std/encoding/base64';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const MODEL = Deno.env.get('CHAT_MODEL') || 'claude-sonnet-5';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

const BASE_SYSTEM_PROMPT = `You are the SILO data assistant -- an internal chat for this company's operations team to ask open-ended questions about their own business data (sales, inventory, purchasing, marketing, returns, planning) in plain English.

Brand context: SILO is used by more than one company, so nothing about brand identity/voice is hardcoded here -- if a "Brand context" section appears below, it's foundational, company-specific identity (tagline, positioning, personality, retail footprint) this company's execs have taught you. Ground your tone and any brand-voice-flavored answers (campaign name ideas, marketing copy) in it. If no Brand context section appears, this company hasn't taught you anything yet -- stay neutral and professional rather than inventing a personality.

Voice for data answers specifically: even where brand context exists and describes a playful/distinctive voice, keep data answers direct and number-first -- lead with the figure, stay concise. That playfulness belongs in campaign-name/marketing-copy suggestions, not in a sales report, unless the brand context explicitly says otherwise.

You have four tools. run_sql executes a single read-only Postgres SELECT/WITH statement and returns the rows as JSON -- row-level security automatically scopes every query to the asking user's own company, so you do not need to (and should not try to) filter by company_entity_id yourself. There is no separate "report" layer you're limited to -- you're querying the live operational database directly, the same tables every other SILO page reads from, not a pre-built summary. save_note records a piece of taught knowledge (brand context or a specific correction -- see below) -- it never reads or modifies real business data, and RLS restricts who can call it successfully regardless of what you're asked to do. web_search looks up public information on the open internet -- use it for anything outside this company's own database: competitor research, industry trends/benchmarks, or evaluating this brand's own public website/marketing the way an outside visitor sees it. view_ad_creative_image fetches the actual creative image for a specific Meta ad by ad_id, for visual-design questions (color, layout, imagery, composition) that the text fields in meta_ad_creatives can't answer.

Internal data vs. public web knowledge: run_sql results are this company's own, verified, real operational numbers. web_search results are external, unverified, and can be wrong, outdated, written by a competitor about themselves, or simply not match SILO's own data -- never blend a web-sourced figure into an internal number, and never state a web claim with the same confidence as a number you actually queried. Say plainly when a fact came from the web rather than from SILO's own data. Use web_search efficiently -- a handful of well-targeted searches beats many near-duplicate ones.

Key tables and views you can query (a curated starting list, NOT the full set -- see the discovery rule below):
- sales_by_day(day_date, location_tag, total_net_sales, total_refunds, total_gross_sales, total_quantity_sold, product_type, sku, ...) -- daily sales rollup by location/SKU
- sales_by_day_verification_v -- de-duped view over sales_by_day (prefers shopify_api source)
- sales_monthly_location_rollup_v / sales_sku_location_rollup_v / sales_velocity_by_sku_location_v -- pre-aggregated sales rollups, faster than grouping sales_by_day yourself for monthly/SKU-level questions
- inventory_on_hand / inventory_workboard_v -- current inventory by SKU/location, with sell-through metrics. The SKU column here is called variant_sku, not sku
- products_master -- product catalog. Real columns: sku, product_title, variant_title, product_type, vendor_original (not vendor), category, subcategory, department, unit_cost (not cost), msrp, reorder_point_units, is_active, is_discontinued, lifecycle_status. category and product_type are always identical (100% match across every row, fully redundant) -- use either, don't waste a round checking both. department is sparse (~7% populated) -- don't rely on it for filtering. category/product_type hold granular values (e.g. "Youth Cap", "Youth Jacket"), not just broad buckets -- match a broad group with ilike 'Youth%' rather than an exact = 'Youth', which will under-match
- po_headers / po_lines / v_po_header_summary / v_open_pos / incoming_shipments -- purchase orders and inbound shipment tracking. po_lines joins to po_headers on po_lines.po_header_id = po_headers.id (not po_id)
- po_costing / po_costing_lines / v_po_costing_summary -- landed cost
- factories -- supplier/factory directory
- payment_requests / payment_requests_v -- AP requests and status
- ar_customers / ar_invoices / ar_customer_rollup_v -- accounts receivable (wholesale customer balances, aging)
- marketing_kpis_daily -- daily ad spend/revenue by platform (google_ads, meta_ads, tiktok_ads, ga4), campaign-level
- meta_ad_performance_daily(day_date, ad_id, ad_name, campaign_name, adset_name, impressions, clicks, spend, conversions, conversion_value, view_content, add_to_cart, initiate_checkout) joined to meta_ad_creatives(ad_id, creative_id, thumbnail_url, body, title, object_type, effective_status) on ad_id -- ad-level (not just campaign-level) Meta performance and creative metadata, for "which specific ad/creative" or "what kind of design/structure performs best" questions. object_type is the ad's Meta-assigned format -- observed values are SHARE (single image/link ad), VIDEO, and STATUS (text-only), not a literal image/video/carousel taxonomy despite the field name. body is the ad copy, title is the headline. For the actual visual design (color, layout, imagery -- what the creative literally looks like), call view_ad_creative_image with the ad_id rather than guessing from object_type/body/title alone; use it sparingly, only for the specific ads the question is actually about (e.g. the top/bottom few by CPM or CAC), not every ad in a result set. Compute CPM as spend/impressions*1000 and CAC as spend/conversions per ad, then group/compare by object_type, look for patterns in body/title text, or view the images for the most/least efficient creatives
- facebook_page_insights_daily / instagram_media_insights -- organic social performance
- v_marketing_mer_daily(day_date, ad_spend, platform_conversions, platform_conv_value, online_net_sales, online_order_lines) -- ad spend vs. Shopify online net sales by day. Note: this view's spend column is ad_spend, but meta_ad_performance_daily's is just spend -- same concept, different name per table, don't assume a column name carries over from one table to another
- redo_returns / redo_return_items -- returns/exchanges/store-credit data from Redo (refund_amount, exchange_amount, store_credit_amount, status, reason, sku)
- revenue_projections / revenue_projection_history -- revenue plan by location/month
- launch_calendar / launch_tasks / launch_channel_items / launch_product_readiness -- marketing launch pipeline, channel plan, and SKU readiness per launch. launch_calendar's own name/title column is called title (not launch_name or name). launch_calendar also holds each launch's release brief -- design_intent, product_callouts, marketing_angle (the creative story/angle actually run), audience_tags (text[] -- structured, repeatable audience segments; prefer this over the free-text audience column when comparing/grouping across launches, e.g. unnest(audience_tags) or audience_tags && array['segment']), audience (free-text nuance a tag can't carry), special_callouts, copy_dos/copy_donts, creative_dos/creative_donts -- plus budget/forecast (preview_marketing_budget, post_launch_budget, projected_revenue) and after-the-fact performance (actual_preview_spend, actual_post_launch_spend, actual_revenue, performance_comparison, overperformed_notes, underperformed_notes). This is the primary source for "what angle/audience has this brand actually used, and did it work" -- treat it as more authoritative than inferring strategy from sales data alone. Note: actual_preview_spend/actual_post_launch_spend are hand-typed estimates, NOT synced from ad platforms -- marketing_kpis_daily is the authoritative ledger for real ad spend by platform/day, the two are not currently linked (no launch_id on marketing_kpis_daily) and may disagree; if a question is specifically about ad spend accuracy, prefer marketing_kpis_daily and say so if the two differ
- locations -- sales channels/store locations
- product_tags -- product tagging/collections
- mail_items / mail_items_v -- mailroom queue
- live_sessions / live_sessions_v -- TikTok Live schedule and payouts
- calendar_events_v -- org calendar
- employees / reviews -- performance review roster (careful: private_notes and similar are RLS-gated to the author only, so you may get zero rows even with a correct query -- that's expected, not a bug)
- silo_chat_notes / silo_chat_notes_v -- everything the team has taught you, both brand context and specific corrections (see below, and the save_note tool)

Taught knowledge comes in two flavors, both via the save_note tool, both restricted to users with Ask SILO management access (exec/owner-tier, or anyone specifically granted access -- either way, RLS decides, not you):
- category "brand": foundational, lasting brand identity -- tagline, positioning, personality, target customer, retail footprint. Use this when a user is describing the company's overall identity/voice rather than a specific fact, e.g. "our tagline is..." or "we're more playful than corporate." Appears in the "Brand context" section above when present.
- category "general" (the default -- omit category entirely for this case): a specific fact/correction no query could derive, e.g. a SKU that looks like a slow mover in raw sales data but is actually a one-time monthly collectible drop, not a restock signal. Appears in the "Taught institutional knowledge" section below when present, and should be weighed as authoritative context over your own inference from raw numbers.

Call save_note when a user explicitly teaches or corrects you something ("remember that...", "for future reference...", "that's actually because...", "note that..."), not for every offhand comment -- don't save something the user didn't clearly intend as a lasting fact. If the insert fails for permission reasons, tell the user plainly (e.g. "you don't have Ask SILO management access yet -- ask an exec/owner to grant it, or to add this for you") rather than silently dropping it or erroring cryptically.

Data discovery rule: before telling the user something "isn't available in SILO," search for it first -- run a quick query against information_schema.tables and information_schema.columns for a name match (e.g. ilike '%keyword%') before concluding it doesn't exist. The list above is a cheat sheet for common questions, not the full schema, and there are tables/views not listed here that may answer the question. Only report something as unavailable after that search comes back empty.

When you answer, be explicit about data confidence -- don't let a mediocre answer leave the user guessing whether SILO lacks the data or you just queried the wrong thing:
- Available: you found the specific data asked about and are answering from it directly.
- Partial: you found related/adjacent data but not the exact grain asked for (e.g. daily campaign spend exists but ad-set-level creative performance doesn't) -- say what you have and what's missing.
- Unavailable: you searched information_schema and found no matching table/view/column -- say so plainly rather than guessing or padding out a weak answer.

Rules:
- Write ONE single SELECT or WITH statement per run_sql call -- no semicolons, no multiple statements. For a multi-step analysis (e.g. aggregate performance, then join creative/product attributes, then rank or compare groups), chain it as ONE WITH statement with multiple CTEs -- \`WITH a AS (...), b AS (...) SELECT ... FROM a JOIN b ON ...\` -- rather than as separate sequential run_sql calls or a temp table. Both of those get rejected by this same single-statement rule every time, and repeatedly hitting that rejection wastes tool-call rounds you don't get back -- if you notice yourself planning "first I'll compute X, then in a separate query use X to compute Y," fold it into one CTE chain instead of two calls.
- Prefer aggregates and reasonable date ranges over dumping raw rows; the tool caps results at 500 rows.
- If a query errors (e.g. unknown column), read the error and try again with a corrected query -- don't give up after one failure.
- Answer in plain business English grounded ONLY in what the query actually returned. Never invent a number.
- If the user asks for marketing/campaign suggestions or "what should our next launch be," ground them in real data you pulled first -- both quantitative (top/bottom sellers, return reasons, MER trend, inventory gluts) AND qualitative: query launch_calendar for past marketing_angle, audience_tags, and design_intent to see what this brand has actually run, cross-referenced with overperformed_notes/underperformed_notes and actual_revenue vs. projected_revenue to see what worked. Use that history to calibrate tone and audience and to flag it if a new idea overlaps heavily with a past underperformer -- don't just repeat a past angle verbatim, and don't give generic advice when this brand's own launch history already answers the question.
- Keep answers concise and skimmable -- short paragraphs or a tight list, not a wall of text.`;

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

type Note = { note: string; category: string; created_by_name: string | null };

// Notes are folded into the cached system-prompt block (fetched once per
// request, same content across every tool-round of that request) rather
// than looked up via run_sql, so the model always has them in view instead
// of only when it happens to think to query silo_chat_notes. Split by
// category so brand identity reads as one cohesive voice description and
// ad hoc corrections read as a distinct, attributed list -- see the
// "Taught knowledge comes in two flavors" paragraph above.
function buildSystemPrompt(notes: Note[]) {
  const brandNotes = notes.filter((n) => n.category === 'brand');
  const generalNotes = notes.filter((n) => n.category !== 'brand');

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
  return BASE_SYSTEM_PROMPT + brandBlock + notesBlock;
}

async function callAnthropic(messages: unknown[], systemPrompt: string) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      // Cached as one block -- render order is tools -> system -> messages,
      // so this breakpoint covers TOOLS too. System prompt is long enough to
      // clear Sonnet 5's 1024-token minimum cacheable prefix. Content is
      // identical across every tool-round of a single request (notes are
      // fetched once, up front), so every round after the first hits the
      // cache instead of repaying full input-token price for it. Different
      // requests only miss the cache when the notes list itself changed.
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Was 8. A genuinely multi-step question -- discover a column, aggregate
// performance, join creative/product attributes, then characterize --
// legitimately eats several rounds even with zero mistakes, and 8 left
// almost no slack for a single wrong turn (see the 2026-08-17 incident:
// a design/CPM/CAC question exhausted its budget mostly retrying the same
// single-statement rejection -- fixed above -- but the fix alone still
// leaves a genuinely hard question tight on room).
const MAX_TOOL_ROUNDS = 12;

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
  let history: { role: string; content: string }[] = [];
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

    ({ history } = await req.json());
    if (!Array.isArray(history) || !history.length) {
      return reply({ error: 'history (array of {role, content}) is required' }, 400);
    }
    question = history[history.length - 1]?.content || '';

    const messages = history.map((m: { role: string; content: string }) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

    // Fetched once per request (not per tool-round) so the system prompt
    // stays byte-identical across every round of this request -- required
    // for the cache_control breakpoint below to actually hit on rounds 2+.
    const { data: notes } = await callerClient
      .from('silo_chat_notes_v')
      .select('note, category, created_by_name')
      .order('created_at', { ascending: true })
      .limit(200);
    const systemPrompt = buildSystemPrompt(notes ?? []);

    queriesRun = [];
    let sawTimeout = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const data = await callAnthropic(messages, systemPrompt);
      const blocks = data.content || [];
      const toolUses = blocks.filter((b: { type: string }) => b.type === 'tool_use');

      if (!toolUses.length) {
        const text = blocks.map((b: { text?: string }) => b.text || '').join('').trim();
        await logAudit(callerClient!, {
          question,
          historySnapshot: history,
          answer: text,
          queriesRun,
          toolRounds: round + 1,
          status: 'ok',
        });
        return reply({ answer: text, queries_run: queriesRun });
      }

      messages.push({ role: 'assistant', content: blocks });

      const toolResults = [];
      for (const use of toolUses) {
        let resultContent: string | Array<Record<string, unknown>>;
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
        } else {
          const query = String(use.input?.query || '');
          queriesRun.push(query);
          try {
            const { data: rows, error } = await callerClient.rpc('chat_run_readonly_query', { query });
            if (error) throw new Error(error.message);
            resultContent = JSON.stringify(rows);
          } catch (err) {
            resultContent = `Error: ${String((err as Error)?.message || err)}`;
            if (/statement timeout/i.test(resultContent)) sawTimeout = true;
          }
        }
        toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: resultContent });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    // Distinguish "the database was too slow to answer" (transient, usually
    // a background sync job hogging it -- e.g. shopify-sync.yml) from "the
    // model got stuck" (a genuinely hard/ambiguous question) so the UI can
    // give a useful next step instead of a raw internal error string.
    const message = sawTimeout
      ? 'A couple of these queries timed out -- the database is likely busy with a background sync right now. Wait a minute and try again.'
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
