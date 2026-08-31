// Suggests a QuickBooks account and location for card transactions that no
// learned rule could answer.
//
// The caller applies its rules first and sends only the leftovers, keyed by
// normalised merchant AND card name, so a file with 400 Amazon charges asks
// about "amazon" once.
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
  card_name?: string | null; // the issuer's card / cost centre, where there is one
  sample: string;          // one raw descriptor, for context
  count: number;
  total: number;
};

type Suggestion = {
  merchant: string;
  card_name?: string | null;
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
  relatedEntities: string[],
  companyName: string,
  cardNames: string[],
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

  // Everything company-specific here is DATA. Naming one company and its trade
  // in the prompt would make this function wrong for the next company that
  // connects QuickBooks -- and telling a model that a credit union is an
  // apparel brand is not a harmless inaccuracy, it steers every borderline
  // account choice.
  return `You are coding credit-card transactions for ${companyName} into their QuickBooks Online chart of accounts. The card feed is "${sourceName}".

You are not told what trade this company is in. Infer it from the accounts, locations and merchants below rather than assuming one.

Return, for each line you are given, the account it should be expensed to.

# Related entities -- the ONLY names that mean "not this company's expense"
${relatedEntities.length ? relatedEntities.map((e) => `- ${e}`).join('\n') : '(none on file)'}

These are separate businesses this company carries an intercompany balance with. If a CARD NAME clearly refers to one of them, the charge is NOT this company's expense -- it is money that entity owes, and it belongs on an intercompany account that is deliberately NOT in the account list below. For those lines return account_name: null and name the entity in reasoning. A utility bill on a related entity's card is not this company's utilities; coding it that way is plausible, silent, and wrong.

# The card names actually in this file
${cardNames.length ? cardNames.map((c) => `- ${c}`).join('\n') : '(this file has no card names)'}

Every card name NOT in the related-entity list above is this company's own -- a spend category, one of its own stores or locations, or an employee whose card it is. An employee name is NOT a related entity: code those lines normally from the merchant, and use the card name as the hint it is. Only names matching the related-entity list mean decline.

The card name is the internal card the charge was made on, and companies commonly use it as a cost centre. Where one is present it is strong evidence, and for some merchants it is BETTER evidence than the merchant: a payment processor like Bill.com, Melio or PayPal tells you nothing on its own, but the same charge on a card named for rent is rent. The same merchant may appear twice with different card names and should then get different accounts.

# The ONLY accounts you may use
${acctList}

# The ONLY locations you may use
${locations.map((l) => `- ${l}`).join('\n')}

# How this company has coded merchants before
${exampleList}

# Rules
- Echo back BOTH the merchant and the card_name you were given, unchanged, so the answer can be matched to the right line. Use null for card_name when the line had none.
- account_name MUST be copied EXACTLY from the account list above. Never invent one, never abbreviate, never fix a typo in it.
- location_name MUST be copied exactly from the location list, or be null. Null means "use the card's default location" -- prefer null over a guess. Only name a location when the merchant or card name clearly belongs to one store.
- vendor_name is the real company behind the descriptor in plain form ("AMZN Mktp US" -> "Amazon"). Null if you cannot tell.
- confidence is 0.0-1.0 and must reflect real uncertainty. Use below 0.6 whenever the merchant is ambiguous, generic, or could reasonably be two different accounts. A wrong code at high confidence is worse than an honest low one, because low confidence is what gets a human to look.
- reasoning is one short sentence a bookkeeper would accept. Say what the merchant is, not what you did. Where the card name is what decided it, say so.
- If a line looks like a card payment, transfer, or the card issuer itself rather than a purchase, set account_name to null and say so in reasoning -- those do not belong in an expense entry.
- A payment processor is not a merchant. "MELIO*AIR TIGER EXPRESS", "BILL.COM* WASHINGTON P", "SQ *BLUE BOTTLE" -- read past the processor to the actual payee, and code THAT. Where the descriptor names no payee at all, the card name is your only evidence; if that does not settle it either, return null rather than guessing.

Respond with JSON only, no prose, no code fence:
{"suggestions":[{"merchant":"...","card_name":null,"account_name":"...","location_name":null,"vendor_name":"...","confidence":0.0,"reasoning":"..."}]}
Every line you were given must appear exactly once.`;
}

async function askModel(
  merchants: Merchant[],
  accounts: { name: string; type: string; sub: string | null }[],
  locations: string[],
  examples: { merchant: string; account: string; location: string | null }[],
  sourceName: string,
  relatedEntities: string[],
  companyName: string,
  cardNames: string[],
): Promise<Suggestion[]> {
  const userMsg = merchants
    .map((m) =>
      `- merchant: "${m.merchant}" | card: ${m.card_name ? `"${m.card_name}"` : 'none'}`
      + ` | example descriptor: "${m.sample}" | ${m.count} charge(s) | $${m.total.toFixed(2)} total`
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
      system: systemPrompt(
        accounts, locations, examples, sourceName, relatedEntities, companyName, cardNames),
      messages: [{ role: 'user', content: `Code these lines:\n${userMsg}` }],
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

  // The intercompany accounts ARE the list of related entities -- there is no
  // separate register of them, and asking the model to recognise "a name that
  // looks like a business rather than an employee" was exactly the guess that
  // made it decline 76 rows on a card belonging to a member of staff.
  const { data: intercoRows } = await supabase
    .from('quickbooks_accounts')
    .select('name, account_type')
    .eq('company_entity_id', companyId)
    .eq('is_active', true)
    .in('account_type', ['Accounts Receivable', 'Accounts Payable']);

  // The card feeds themselves settle to AP accounts ('Brex Account', 'Divvy
  // Account', 'Parker'), which are emphatically NOT related entities -- listing
  // them would invite the model to decline a card's own rows.
  const { data: cardAccts } = await supabase
    .from('card_sources')
    .select('credit_qbo_account_name')
    .eq('company_entity_id', companyId);
  const cardAccountNames = new Set((cardAccts || [])
    .map((c: any) => String(c.credit_qbo_account_name || '').toLowerCase().trim())
    .filter(Boolean));

  // Only accounts that actually follow the intercompany naming convention --
  // "<entity> Receivable" or "Due From/To <entity>". Taking every AR/AP account
  // sweeps up 'Accrued', 'Accounts Payable (A/P)', 'American Express - LOC' and
  // 'Amazon Unavailable Balance'; that last one is the dangerous one, since a
  // list containing the word Amazon invites the model to decline Amazon rows.
  const INTERCO_NAME = /\sreceivable\s*$|^due\s+(from|to)\s+/i;

  const relatedEntities = [...new Set((intercoRows || [])
    .filter((a: any) => !cardAccountNames.has(String(a.name || '').toLowerCase().trim()))
    .filter((a: any) => INTERCO_NAME.test(String(a.name || '')))
    .map((a: any) => String(a.name || '')
      .replace(/\s*receivable\s*$/i, '')
      .replace(/^due\s+(from|to)\s+/i, '')
      .trim())
    .filter((n: string) => n && !/^accounts?$/i.test(n) && n.length > 2))]
    .sort();

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

  // The company's own name, not a name baked into this function.
  const { data: entityRow } = await supabase
    .from('entities').select('title').eq('id', companyId).maybeSingle();
  const companyName = entityRow?.title || 'this company';

  // The card names in THIS file, rather than one company's examples. A card
  // named "VIRTUAL ACCT SHIPPING" means nothing to a company that names its
  // cards after branches or people.
  const cardNames = [...new Set(merchants
    .map((m) => String(m.card_name || '').trim())
    .filter(Boolean))].sort().slice(0, 40);

  const validAccounts = new Set(accounts.map((a) => a.name));
  const validLocations = new Set(locations);

  const out: Suggestion[] = [];
  const errors: string[] = [];

  const slices: Merchant[][] = [];
  for (let i = 0; i < merchants.length; i += BATCH_SIZE) {
    slices.push(merchants.slice(i, i + BATCH_SIZE));
  }

  // CONCURRENT, not sequential. Each call takes ~65s, and Supabase's gateway
  // kills the request at 150s -- so two batches ran to 144s and a third would
  // have been killed outright, returning nothing and looking like the model
  // simply had no answers. Capped at 4 in flight to stay clear of the API's
  // own rate limits.
  const LIMIT = 4;
  const results: (Suggestion[] | Error)[] = new Array(slices.length);
  let next = 0;

  await Promise.all(Array.from({ length: Math.min(LIMIT, slices.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= slices.length) return;
      try {
        results[i] = await askModel(
          slices[i], accounts, locations, examples, sourceName, relatedEntities,
          companyName, cardNames);
      } catch (e) {
        results[i] = e instanceof Error ? e : new Error(String(e));
      }
    }
  }));

  slices.forEach((slice, i) => {
    const result = results[i];

    if (result instanceof Error) {
      errors.push(result.message);
      for (const m of slice) {
        out.push({
          merchant: m.merchant,
          card_name: m.card_name ?? null,
          account_name: null,
          location_name: null,
          vendor_name: null,
          confidence: 0,
          reasoning: `Categorisation failed: ${result.message.slice(0, 160)}`,
        });
      }
      return;
    }

    // Answers are matched back on the merchant AND card pair, since the same
    // merchant can legitimately appear twice with different cards.
    const key = (merchant: unknown, card: unknown) =>
      `${String(merchant ?? '')}||${card == null ? '' : String(card)}`;
    const byMerchant = new Map((result || []).map((s) => [key(s.merchant, s.card_name), s]));

    for (const m of slice) {
      const s = byMerchant.get(key(m.merchant, m.card_name));
      if (!s) {
        out.push({
          merchant: m.merchant,
          card_name: m.card_name ?? null,
          account_name: null,
          location_name: null,
          vendor_name: null,
          confidence: 0,
          reasoning: 'The model did not return a suggestion for this line.',
        });
        continue;
      }

      const acct = s.account_name && validAccounts.has(s.account_name) ? s.account_name : null;
      const invented = !!s.account_name && !acct;
      const loc = s.location_name && validLocations.has(s.location_name) ? s.location_name : null;

      out.push({
        merchant: m.merchant,
        card_name: m.card_name ?? null,
        account_name: acct,
        location_name: loc,
        vendor_name: s.vendor_name || null,
        confidence: invented ? 0 : Math.max(0, Math.min(1, Number(s.confidence) || 0)),
        reasoning: invented
          ? `Suggested "${s.account_name}", which is not in the chart of accounts — needs coding by hand.`
          : String(s.reasoning || '').slice(0, 400),
      });
    }
  });

  return json({
    ok: true,
    suggestions: out,
    merchants_asked: merchants.length,
    batches: slices.length,
    related_entities: relatedEntities.length,
    company: companyName,
    model: MODEL,
    errors: errors.length ? errors : undefined,
  });
});
