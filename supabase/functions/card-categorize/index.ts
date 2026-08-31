// Suggests a QuickBooks account and location for card transactions that no
// learned rule could answer.
//
// The caller has already applied its rules and sends only the leftovers, keyed
// by NORMALISED merchant -- so a file with 400 Amazon charges asks about
// "amzn mktp us" once, not 400 times. That is the whole reason this stays cheap
// enough to run on every import.
//
// READ ONLY with respect to QuickBooks. Nothing here posts.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const MODEL = Deno.env.get('CARD_CODING_MODEL') || 'claude-sonnet-5';

// One merchant is one question. Beyond this the request is split into several
// model calls rather than truncated -- a silently dropped merchant comes back
// as an uncoded row with no explanation, which is worse than a slower import.
const BATCH_SIZE = 60;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

type Merchant = {
  merchant: string;        // normalised key
  sample: string;          // one raw descriptor, for context
  count: number;
  total: number;
};

type Suggestion = {
  merchant: string;
  account_name: string | null;
  location_name: string | null;
  vendor_name: string | null;
  confidence: number;
  reasoning: string;
};

function systemPrompt(
  accounts: { name: string; type: string; sub: string | null }[],
  locations: string[],
  examples: { merchant: string; account: string; location: string | null }[],
  sourceName: string,
) {
  const acctList = accounts
    .map((a) => `- ${a.name} [${a.type}${a.sub ? ` / ${a.sub}` : ''}]`)
    .join('\n');

  // Past human decisions are the strongest signal available -- stronger than
  // the model's priors about what "OFFICE DEPOT" usually is, because they
  // encode how THIS company codes things.
  const exampleList = examples.length
    ? examples
      .map((e) => `- "${e.merchant}" -> ${e.account}${e.location ? ` @ ${e.location}` : ''}`)
      .join('\n')
    : '(none yet -- this is the first import)';

  return `You are coding credit-card transactions for a US retail company (Baseballism, a baseball-themed apparel brand) into their QuickBooks Online chart of accounts. The card feed is "${sourceName}".

Return, for each merchant, the account it should be expensed to.

# The ONLY accounts you may use
${acctList}

# The ONLY locations you may use
${locations.map((l) => `- ${l}`).join('\n')}

# How this company has coded merchants before
${exampleList}

# Rules
- account_name MUST be copied EXACTLY from the account list above. Never invent one, never abbreviate, never fix a typo in it.
- location_name MUST be copied exactly from the location list, or be null. Null means "use the card's default location" -- prefer null over a guess. Only name a location when the merchant clearly belongs to one store (a utility for that address, a landlord, a local service).
- vendor_name is the real company behind the descriptor in plain form ("AMZN Mktp US" -> "Amazon"). Null if you cannot tell.
- confidence is 0.0-1.0 and must reflect real uncertainty. Use below 0.6 whenever the merchant is ambiguous, generic, or could reasonably be two different accounts. A wrong code at high confidence is worse than an honest low one, because low confidence is what gets a human to look.
- reasoning is one short sentence a bookkeeper would accept. Say what the merchant is, not what you did.
- If a merchant looks like a card payment, transfer, or the card issuer itself rather than a purchase, set account_name to null and say so in reasoning -- those do not belong in an expense entry.

Respond with JSON only, no prose, no code fence:
{"suggestions":[{"merchant":"...","account_name":"...","location_name":null,"vendor_name":"...","confidence":0.0,"reasoning":"..."}]}
Every merchant you were given must appear exactly once.`;
}

async function askModel(
  merchants: Merchant[],
  accounts: { name: string; type: string; sub: string | null }[],
  locations: string[],
  examples: { merchant: string; account: string; location: string | null }[],
  sourceName: string,
): Promise<Suggestion[]> {
  const userMsg = merchants
    .map((m) =>
      `- "${m.merchant}" | example descriptor: "${m.sample}" | ${m.count} charge(s) | $${m.total.toFixed(2)} total`
    )
    .join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system: systemPrompt(accounts, locations, examples, sourceName),
      messages: [{ role: 'user', content: `Code these merchants:\n${userMsg}` }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`anthropic_${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('');

  // The model was asked for bare JSON, but a stray fence or preamble must not
  // lose an entire batch of suggestions.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model_returned_no_json');

  const parsed = JSON.parse(text.slice(start, end + 1));
  return Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (!ANTHROPIC_API_KEY) {
    return json({ error: 'ANTHROPIC_API_KEY is not configured for this project.' }, 503);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const authHeader = req.headers.get('Authorization') ?? '';
  const { data: { user }, error: authErr } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', ''),
  );
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

  const body = await req.json().catch(() => ({}));
  const merchants: Merchant[] = Array.isArray(body.merchants) ? body.merchants : [];
  const sourceName: string = body.source_name || 'card';
  if (!merchants.length) return json({ ok: true, suggestions: [] });

  // Resolve the caller's company first, then read that company's chart --
  // service-role bypasses RLS, so scoping is this function's job.
  const { data: profile } = await supabase
    .from('profiles')
    .select('active_company_id, is_active, department, role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.is_active === false) return json({ error: 'No active profile' }, 403);
  const companyId = profile.active_company_id;
  if (!companyId) return json({ error: 'No active company set' }, 403);

  // Same population the RLS write policy allows. Categorising is not posting,
  // but it spends money on tokens and reads the whole chart, so it is not open
  // to every member either.
  const { data: membership } = await supabase
    .from('entity_memberships')
    .select('role')
    .eq('entity_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle();

  const allowed = membership
    ? membership.role === 'owner_admin' || ['finance', 'exec'].includes(String(profile.department))
    : ['owner', 'executive'].includes(String(profile.role))
      || ['finance', 'exec'].includes(String(profile.department));
  if (!allowed) return json({ error: 'Finance access required' }, 403);

  // Only accounts a card charge could legitimately land in. Offering the model
  // all 450 accounts invites it to expense a purchase to a revenue account.
  const { data: accountRows } = await supabase
    .from('quickbooks_accounts')
    .select('name, fully_qualified_name, account_type, account_sub_type')
    .eq('company_entity_id', companyId)
    .eq('is_active', true)
    .in('account_type', [
      'Expense', 'Other Expense', 'Cost of Goods Sold',
      'Fixed Asset', 'Other Current Asset',
    ]);

  const accounts = (accountRows || []).map((a: any) => ({
    name: a.fully_qualified_name || a.name,
    type: a.account_type,
    sub: a.account_sub_type,
  }));
  if (!accounts.length) {
    return json({ error: 'No QuickBooks accounts pulled yet — run Pull accounts in Integrations.' }, 400);
  }

  const { data: locationRows } = await supabase
    .from('quickbooks_locations')
    .select('name, fully_qualified_name')
    .eq('company_entity_id', companyId)
    .eq('is_active', true);
  const locations = (locationRows || []).map((l: any) => l.fully_qualified_name || l.name);

  // A sample of what humans have already confirmed, most-used first.
  const { data: ruleRows } = await supabase
    .from('card_coding_rules')
    .select('pattern, qbo_account_name, qbo_location_name, hit_count')
    .eq('company_entity_id', companyId)
    .eq('is_active', true)
    .not('qbo_account_name', 'is', null)
    .order('hit_count', { ascending: false })
    .limit(120);

  const examples = (ruleRows || []).map((r: any) => ({
    merchant: r.pattern,
    account: r.qbo_account_name,
    location: r.qbo_location_name,
  }));

  const validAccounts = new Set(accounts.map((a) => a.name));
  const validLocations = new Set(locations);

  const out: Suggestion[] = [];
  const errors: string[] = [];

  for (let i = 0; i < merchants.length; i += BATCH_SIZE) {
    const slice = merchants.slice(i, i + BATCH_SIZE);
    try {
      const suggestions = await askModel(slice, accounts, locations, examples, sourceName);
      const byMerchant = new Map(suggestions.map((s) => [String(s.merchant), s]));

      for (const m of slice) {
        const s = byMerchant.get(m.merchant);
        if (!s) {
          // Asked about but not answered. Recorded as unanswered rather than
          // dropped, so it surfaces for a human instead of vanishing.
          out.push({
            merchant: m.merchant,
            account_name: null,
            location_name: null,
            vendor_name: null,
            confidence: 0,
            reasoning: 'The model did not return a suggestion for this merchant.',
          });
          continue;
        }

        // A hallucinated account name would post real money to an account that
        // does not exist, or fail at post time with an opaque QuickBooks error.
        // Either way it is not a suggestion, so it is dropped to "no account"
        // and says why.
        const acct = s.account_name && validAccounts.has(s.account_name) ? s.account_name : null;
        const invented = !!s.account_name && !acct;
        const loc = s.location_name && validLocations.has(s.location_name) ? s.location_name : null;

        out.push({
          merchant: m.merchant,
          account_name: acct,
          location_name: loc,
          vendor_name: s.vendor_name || null,
          confidence: invented ? 0 : Math.max(0, Math.min(1, Number(s.confidence) || 0)),
          reasoning: invented
            ? `Suggested "${s.account_name}", which is not in the chart of accounts — needs coding by hand.`
            : String(s.reasoning || '').slice(0, 400),
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(msg);
      for (const m of slice) {
        out.push({
          merchant: m.merchant,
          account_name: null,
          location_name: null,
          vendor_name: null,
          confidence: 0,
          reasoning: `Categorisation failed: ${msg.slice(0, 160)}`,
        });
      }
    }
  }

  return json({
    ok: true,
    suggestions: out,
    merchants_asked: merchants.length,
    model: MODEL,
    errors: errors.length ? errors : undefined,
  });
});
