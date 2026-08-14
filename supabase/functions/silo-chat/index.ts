// silo-chat -- authenticated (verify_jwt on, default): a "wide open, ask
// anything about our data" chat. Claude gets two tools -- run_sql (backed
// by the chat_run_readonly_query(text) RPC from
// 20260813180000_silo_chat_readonly_query.sql) and save_note (a plain
// insert into silo_chat_notes, RLS-gated by can_manage_silo_notes() -- see
// 20260813210000_silo_chat_notes.sql and 20260813230000_silo_chat_managers.sql).
// This function forwards the caller's own JWT to Supabase (never the
// service-role key) so every query/insert the model runs executes AS that
// user. Postgres RLS is the actual data boundary: a user can never see
// through this chat anything they couldn't already see by hand-querying
// from the browser, regardless of what SQL the model writes, and only
// exec/owner-tier users (or anyone specifically granted Ask SILO access
// via backend.html) can teach it a new note no matter what the model is
// told to do. See CLAUDE.md's "Key tables" section for the schema summary
// baked into BASE_SYSTEM_PROMPT below -- keep them in sync.
import { createClient } from 'npm:@supabase/supabase-js@2';

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

You have two tools. run_sql executes a single read-only Postgres SELECT/WITH statement and returns the rows as JSON -- row-level security automatically scopes every query to the asking user's own company, so you do not need to (and should not try to) filter by company_entity_id yourself. There is no separate "report" layer you're limited to -- you're querying the live operational database directly, the same tables every other SILO page reads from, not a pre-built summary. save_note records a piece of taught knowledge (brand context or a specific correction -- see below) -- it never reads or modifies real business data, and RLS restricts who can call it successfully regardless of what you're asked to do.

Key tables and views you can query (a curated starting list, NOT the full set -- see the discovery rule below):
- sales_by_day(day_date, location_tag, total_net_sales, total_refunds, total_gross_sales, total_quantity_sold, product_type, sku, ...) -- daily sales rollup by location/SKU
- sales_by_day_verification_v -- de-duped view over sales_by_day (prefers shopify_api source)
- sales_monthly_location_rollup_v / sales_sku_location_rollup_v / sales_velocity_by_sku_location_v -- pre-aggregated sales rollups, faster than grouping sales_by_day yourself for monthly/SKU-level questions
- inventory_on_hand / inventory_workboard_v -- current inventory by SKU/location, with sell-through metrics
- products_master -- product catalog (title, product_type, vendor, cost, reorder points)
- po_headers / po_lines / v_po_header_summary / v_open_pos / incoming_shipments -- purchase orders and inbound shipment tracking
- po_costing / po_costing_lines / v_po_costing_summary -- landed cost
- factories -- supplier/factory directory
- payment_requests / payment_requests_v -- AP requests and status
- ar_customers / ar_invoices / ar_customer_rollup_v -- accounts receivable (wholesale customer balances, aging)
- marketing_kpis_daily -- daily ad spend/revenue by platform (google_ads, meta_ads, tiktok_ads, ga4), campaign-level
- meta_ad_performance_daily / meta_ad_creatives -- ad-level (not just campaign-level) Meta performance and creative metadata, for "which specific ad/creative" questions
- facebook_page_insights_daily / instagram_media_insights -- organic social performance
- v_marketing_mer_daily -- ad spend vs. Shopify online net sales by day
- redo_returns / redo_return_items -- returns/exchanges/store-credit data from Redo (refund_amount, exchange_amount, store_credit_amount, status, reason, sku)
- revenue_projections / revenue_projection_history -- revenue plan by location/month
- launch_calendar / launch_tasks / launch_channel_items / launch_product_readiness -- marketing launch pipeline, channel plan, and SKU readiness per launch. launch_calendar also holds each launch's release brief -- design_intent, product_callouts, marketing_angle (the creative story/angle actually run), audience, special_callouts, copy_dos/copy_donts, creative_dos/creative_donts -- plus budget/forecast (preview_marketing_budget, post_launch_budget, projected_revenue) and after-the-fact performance (actual_preview_spend, actual_post_launch_spend, actual_revenue, performance_comparison, overperformed_notes, underperformed_notes). This is the primary source for "what angle/audience has this brand actually used, and did it work" -- treat it as more authoritative than inferring strategy from sales data alone
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
- Write ONE single SELECT or WITH statement per run_sql call -- no semicolons, no multiple statements.
- Prefer aggregates and reasonable date ranges over dumping raw rows; the tool caps results at 500 rows.
- If a query errors (e.g. unknown column), read the error and try again with a corrected query -- don't give up after one failure.
- Answer in plain business English grounded ONLY in what the query actually returned. Never invent a number.
- If the user asks for marketing/campaign suggestions or "what should our next launch be," ground them in real data you pulled first -- both quantitative (top/bottom sellers, return reasons, MER trend, inventory gluts) AND qualitative: query launch_calendar for past marketing_angle, audience, and design_intent to see what this brand has actually run, cross-referenced with overperformed_notes/underperformed_notes and actual_revenue vs. projected_revenue to see what worked. Use that history to calibrate tone and audience and to flag it if a new idea overlaps heavily with a past underperformer -- don't just repeat a past angle verbatim, and don't give generic advice when this brand's own launch history already answers the question.
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

const MAX_TOOL_ROUNDS = 8;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);

  try {
    if (!ANTHROPIC_API_KEY) {
      return reply({ error: 'ANTHROPIC_API_KEY is not configured for this project yet.' }, 503);
    }

    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!jwt) return reply({ error: 'Not authenticated' }, 401);

    // Caller-scoped client -- every RPC call below runs AS this user, so
    // RLS (not this function) is what actually confines the data. Never
    // use the service-role key here.
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData?.user) return reply({ error: 'Not authenticated' }, 401);

    const { history } = await req.json();
    if (!Array.isArray(history) || !history.length) {
      return reply({ error: 'history (array of {role, content}) is required' }, 400);
    }

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

    const queriesRun: string[] = [];
    let sawTimeout = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const data = await callAnthropic(messages, systemPrompt);
      const blocks = data.content || [];
      const toolUses = blocks.filter((b: { type: string }) => b.type === 'tool_use');

      if (!toolUses.length) {
        const text = blocks.map((b: { text?: string }) => b.text || '').join('').trim();
        return reply({ answer: text, queries_run: queriesRun });
      }

      messages.push({ role: 'assistant', content: blocks });

      const toolResults = [];
      for (const use of toolUses) {
        let resultContent: string;
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
    return reply({ error: message, queries_run: queriesRun, retryable: true }, 500);
  } catch (err) {
    console.error('[silo-chat]', err);
    return reply({ error: String((err as Error)?.message || err), retryable: true }, 500);
  }
});
