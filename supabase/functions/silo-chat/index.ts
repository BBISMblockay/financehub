// silo-chat -- authenticated (verify_jwt on, default): a "wide open, ask
// anything about our data" chat. Claude gets one tool -- run_sql, backed by
// the chat_run_readonly_query(text) RPC from
// 20260813180000_silo_chat_readonly_query.sql -- and this function forwards
// the caller's own JWT to Supabase (never the service-role key) so every
// query the model runs executes AS that user. Postgres RLS is the actual
// data boundary: a user can never see through this chat anything they
// couldn't already see by hand-querying from the browser, regardless of
// what SQL the model writes. See CLAUDE.md's "Key tables" section for
// the schema summary baked into SYSTEM_PROMPT below -- keep them in sync.
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

const SYSTEM_PROMPT = `You are the SILO data assistant -- an internal chat for Baseballism's operations team to ask open-ended questions about their own business data (sales, inventory, purchasing, marketing, returns, planning) in plain English.

About Baseballism: a baseball lifestyle apparel brand -- vintage/retro-inspired designs and MLB-licensed product (Ken Griffey Jr., Babe Ruth, Roberto Clemente, Cubs, Dodgers, and others) built for people who live baseball on and off the field, not just players. Tagline: "The Original Baseball Lifestyle Brand. Built For Ballplayers, Worn By All." Brand personality is nostalgic and rooted in the game's history, but playful and pun-driven rather than corporate -- collection names like "Bat Bros," "Money Ball," "Hardball Hunter," and "Doubles and Bubbles" are typical, and holidays get a baseball spin (Valentine's -> "For Love of the Game"). Comfortable crossing into pop culture (Sonic the Hedgehog, Fortnite collabs) without losing the baseball-first identity. Retail footprint includes a flagship barn store on the actual Field of Dreams Movie Site in Dyersville, Iowa (Universal-licensed) -- a defining piece of brand identity, not just another wholesale account. Merch calendar leans on family/community moments (Father's/Mother's Day, Back to School, Toddler/Youth lines) alongside signature promo events (Anniversary Sale, "6432 Day").

Voice: warm and knowledgeable, like someone who's actually into baseball -- not generic-corporate. That said, the playful/pun energy above belongs to product and marketing copy, not to a data answer. When answering a data question here, keep the personality as tone, not as bits: lead with the number, stay direct, and only lean into the brand's playfulness if the user is literally asking for campaign name ideas or marketing copy.

You have one tool, run_sql, which executes a single read-only Postgres SELECT/WITH statement and returns the rows as JSON. Row-level security automatically scopes every query to the asking user's own company -- you do not need to (and should not try to) filter by company_entity_id yourself.

Key tables and views you can query (not exhaustive -- if unsure a column exists, query information_schema.columns first):
- sales_by_day(day_date, location_tag, total_net_sales, total_refunds, total_gross_sales, total_quantity_sold, product_type, sku, ...) -- daily sales rollup by location/SKU
- sales_by_day_verification_v -- de-duped view over sales_by_day (prefers shopify_api source)
- inventory_on_hand / inventory_workboard_v -- current inventory by SKU/location, with sell-through metrics
- products_master -- product catalog (title, product_type, vendor, cost, reorder points)
- po_headers / po_lines / v_po_header_summary -- purchase orders
- po_costing / po_costing_lines / v_po_costing_summary -- landed cost
- payment_requests / payment_requests_v -- AP requests and status
- marketing_kpis_daily -- daily ad spend/revenue by platform (google_ads, meta_ads, tiktok_ads, ga4)
- v_marketing_mer_daily -- ad spend vs. Shopify online net sales by day
- redo_returns / redo_return_items -- returns/exchanges/store-credit data from Redo (refund_amount, exchange_amount, store_credit_amount, status, reason, sku)
- revenue_projections / revenue_projection_history -- revenue plan by location/month
- launch_calendar / launch_tasks -- marketing launch pipeline
- employees / reviews -- performance review roster (careful: private_notes and similar are RLS-gated to the author only, so you may get zero rows even with a correct query -- that's expected, not a bug)

Rules:
- Write ONE single SELECT or WITH statement per run_sql call -- no semicolons, no multiple statements.
- Prefer aggregates and reasonable date ranges over dumping raw rows; the tool caps results at 500 rows.
- If a query errors (e.g. unknown column), read the error and try again with a corrected query -- don't give up after one failure.
- Answer in plain business English grounded ONLY in what the query actually returned. Never invent a number.
- If the user asks for marketing/campaign suggestions, ground them in real data you pulled first (top/bottom sellers, return reasons, MER trend, inventory gluts) rather than generic advice.
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
];

async function callAnthropic(messages: unknown[]) {
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
      // clear Sonnet 5's 1024-token minimum cacheable prefix. Every question
      // in a session reuses this same system+tools prefix, so after the
      // first call in a conversation, subsequent calls (including each
      // tool-result round-trip within one question) hit the cache instead
      // of repaying full input-token price for it.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
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

    const queriesRun: string[] = [];
    let sawTimeout = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const data = await callAnthropic(messages);
      const blocks = data.content || [];
      const toolUses = blocks.filter((b: { type: string }) => b.type === 'tool_use');

      if (!toolUses.length) {
        const text = blocks.map((b: { text?: string }) => b.text || '').join('').trim();
        return reply({ answer: text, queries_run: queriesRun });
      }

      messages.push({ role: 'assistant', content: blocks });

      const toolResults = [];
      for (const use of toolUses) {
        const query = String(use.input?.query || '');
        queriesRun.push(query);
        let resultContent: string;
        try {
          const { data: rows, error } = await callerClient.rpc('chat_run_readonly_query', { query });
          if (error) throw new Error(error.message);
          resultContent = JSON.stringify(rows);
        } catch (err) {
          resultContent = `Error: ${String((err as Error)?.message || err)}`;
          if (/statement timeout/i.test(resultContent)) sawTimeout = true;
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
